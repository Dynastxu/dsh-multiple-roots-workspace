/**
 * dsh-multiple-roots-workspace — host half.
 *
 * A workspace owns an ordered list of rows. Each row is one of:
 *  - a `folder` row: one attached directory with its own read-only switch;
 *  - a `workspace` row: one reference to another workspace, expanded live into
 *    that workspace's root plus everything its own list contributes (with cycle
 *    detection). It is never a snapshot: later changes in the referenced
 *    workspace show up without re-attaching.
 *
 * The effective directory list is recomputed from storage on every read:
 *  - writable, existing directories enter every live Session's `workspace-write`
 *    set through `ctx.sandboxPolicy.registerWritableRoot(session, directory)`;
 *  - read-only directories are never granted, and `ctx.tools.guard()` denies
 *    file mutations that land inside them;
 *  - missing directories are skipped by the model-facing contribution (and by
 *    grants), while the dialog reports them as missing;
 *  - the model sees the list as a runtime-context contribution that renders
 *    `''` when nothing is left, so a workspace without attached directories
 *    never injects the section. The agent loop commits one snapshot per change.
 *
 * The Client half talks to the routes below; both call the same store.
 *
 * @module @dynastxu/dsh-multiple-roots-workspace
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import {
  expandAttachedWorkspace,
  expandEntries,
  findReadOnlyViolation,
  renderContext,
} from "./entries";
import type { DirectoryView, Entry, EntryKind } from "./entries";
import { canonicalizePath, isExistingDirectory, pathKey } from "./paths";
import { MultipleRootsError, MultipleRootsStore } from "./store";
import { service } from "./types";
import type {
  AgentsService,
  AssembleContextLike,
  ConnectionService,
  PluginContext,
  SandboxPolicyService,
  SessionLike,
  SystemPromptService,
  ToolExecutionLike,
  ToolsService,
  WebServerService,
  WorkspaceRegistryService,
  WorkspaceRow,
  WorkingDirectoryService,
} from "./types";

/** Route prefix owned by this plugin. */
const PREFIX = "/dsh-multiple-roots-workspace";
const ROUTES = {
  state: `${PREFIX}/state`,
  workspaces: `${PREFIX}/workspaces`,
  addFolder: `${PREFIX}/add-folder`,
  addWorkspace: `${PREFIX}/add-workspace`,
  readOnly: `${PREFIX}/read-only`,
  overrides: `${PREFIX}/overrides`,
  remove: `${PREFIX}/remove`,
} as const;

const CONTEXT_NAME = "multiple-roots:folders";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WORKSPACE_LIST = 500;

/** One directory inside an attached workspace, as the Client sees it. */
interface WireDir {
  readonly path: string;
  readonly readOnly: boolean;
  readonly exists: boolean;
  readonly overridden: boolean;
}

/** One row on the wire to the Client. */
interface WireEntry {
  readonly kind: EntryKind;
  readonly path: string;
  /** The row's own switch (a folder row's flag, or a workspace row's blanket). */
  readonly readOnly: boolean;
  /** Whether the row's own directory (folder or attached workspace root) exists. */
  readonly exists: boolean;
  /** How many directories this row currently contributes are missing. */
  readonly missing: number;
  /** Expanded directories; present for workspace rows only. */
  readonly dirs?: readonly WireDir[];
}

/** One live grant owned by this plugin for a Session. */
interface Grant {
  readonly path: string;
  readonly dispose: () => void;
}

/** Describe one thrown value for logs and route bodies. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only a loopback Host may reach these routes; a rebinding page carries its own name. */
function isLoopbackHost(header: unknown): boolean {
  if (typeof header !== "string" || header.length === 0) return false;
  const hostname = header
    .replace(/:\d+$/u, "")
    .replace(/^\[|\]$/gu, "")
    .toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "127.0.0.1" ||
    /^127\.\d+\.\d+\.\d+$/u.test(hostname)
  );
}

/** Write one JSON response. */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** Read a bounded JSON object body. */
function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch (error) {
        reject(new Error(`invalid JSON body: ${describeError(error)}`));
      }
    });
    request.on("error", reject);
  });
}

/** The plugin entry point. */
export function apply(ctx: PluginContext): void {
  const warn = (message: string): void => {
    try {
      ctx.logger.warn(message);
    } catch {
      // Logging must never fail a tool or route.
    }
  };
  const store = new MultipleRootsStore({ warn });

  /** sessionId -> pathKey -> grant */
  const grants = new Map<string, Map<string, Grant>>();
  /** sessionId -> canonical workspace directory */
  const sessionRoots = new Map<string, string>();

  /** Stored rows of any workspace, for expansion. */
  const rowsOf = (workspace: string): readonly Entry[] => store.entriesFor(workspace);

  /** The directories one workspace currently contributes, missing ones included. */
  const resolveDirs = (workspace: string): DirectoryView[] =>
    expandEntries(rowsOf, workspace, { exists: isExistingDirectory });

  /** Canonical workspace directory of one Session, cached for its lifetime. */
  const workspaceOf = (session: SessionLike | undefined): string | undefined => {
    if (session === undefined) return undefined;
    const id = session.id;
    const cached = sessionRoots.get(id);
    if (cached !== undefined) return cached;
    const cwd = session.header.cwd;
    if (typeof cwd !== "string") return undefined;
    const canonical = canonicalizePath(cwd);
    if (canonical === undefined) return undefined;
    sessionRoots.set(id, canonical);
    return canonical;
  };

  /** Dispose every grant owned by one Session. */
  const dropSessionGrants = (id: string): void => {
    const owned = grants.get(id);
    if (owned === undefined) return;
    for (const grant of owned.values()) {
      try {
        grant.dispose();
      } catch {
        // Already disposed with the sandbox service; nothing left to release.
      }
    }
    grants.delete(id);
  };

  /**
   * Bring one Session's grants in line with its workspace's effective rows.
   * Runs on each pre-step, so resume, fork, and a plugin reload all converge
   * without a separate lifecycle registry.
   */
  const syncSession = (session: SessionLike): void => {
    const id = session.id;
    const workspace = workspaceOf(session);
    const desired =
      workspace === undefined
        ? []
        : resolveDirs(workspace)
            .filter((directory) => directory.existing && !directory.readOnly)
            .map((directory) => directory.path);
    if (desired.length === 0) {
      dropSessionGrants(id);
      return;
    }
    const policy = service<SandboxPolicyService>(ctx, "sandboxPolicy");
    let owned = grants.get(id);
    if (owned === undefined) {
      owned = new Map<string, Grant>();
      grants.set(id, owned);
    }
    const wanted = new Set(desired.map((directory) => pathKey(directory)));
    for (const [key, grant] of owned) {
      if (wanted.has(key)) continue;
      try {
        grant.dispose();
      } catch {
        // Already disposed; the service owns the effect lifetime.
      }
      owned.delete(key);
    }
    if (policy === undefined || typeof policy.registerWritableRoot !== "function") return;
    for (const directory of desired) {
      const key = pathKey(directory);
      if (owned.has(key)) continue;
      try {
        owned.set(key, {
          path: directory,
          dispose: policy.registerWritableRoot(session, directory),
        });
      } catch (error) {
        warn(
          `multiple-roots: cannot grant "${directory}" to session "${id}": ${describeError(error)}`,
        );
      }
    }
  };

  /** Apply a changed workspace to every live Session running in it. */
  const syncWorkspace = (workspace: string): void => {
    const agents = service<AgentsService>(ctx, "agents");
    if (agents === undefined || typeof agents.list !== "function") return;
    const target = pathKey(workspace);
    for (const agent of agents.list()) {
      const root = workspaceOf(agent.session);
      if (root === undefined || pathKey(root) !== target) continue;
      try {
        syncSession(agent.session);
      } catch (error) {
        warn(`multiple-roots: cannot sync session "${agent.session.id}": ${describeError(error)}`);
      }
    }
  };

  // Plugin unload must release the registrations it added to the sandbox
  // service; those effects belong to that service, not to this plugin.
  ctx.effect(
    () => () => {
      for (const id of grants.keys()) dropSessionGrants(id);
      sessionRoots.clear();
    },
    "multiple-roots: grant teardown",
  );

  // Every admitted step re-reads the workspace rows, so a change made from the
  // UI reaches the running conversation at its next request.
  ctx.effect(
    () =>
      ctx.on("agent/pre-step", async ({ agent }, next) => {
        try {
          if (agent.session !== undefined) syncSession(agent.session);
        } catch (error) {
          warn(`multiple-roots: pre-step sync failed: ${describeError(error)}`);
        }
        return next();
      }),
    "multiple-roots: session grant admission",
  );

  // A disposed Session must release its registrations and cached cwd.
  ctx.effect(
    () =>
      ctx.on(
        "session/disposed",
        (session) => {
          const id = session.id;
          dropSessionGrants(id);
          sessionRoots.delete(id);
        },
        { global: true },
      ),
    "multiple-roots: session teardown",
  );

  // Live Sessions that already exist when this plugin loads.
  ctx.inject(["agents"], (scope) => {
    const agents = service<AgentsService>(scope, "agents");
    if (agents === undefined) return;
    for (const agent of agents.list()) {
      try {
        syncSession(agent.session);
      } catch (error) {
        warn(`multiple-roots: initial sync failed: ${describeError(error)}`);
      }
    }
  });

  // Read-only rows deny file mutations even when a broader grant would allow
  // them. A guard is monotonic: no later listener can turn the denial back into
  // permission. Missing directories are skipped: a mutation cannot land there,
  // and a stale read-only root must not block writes elsewhere.
  ctx.inject(["tools"], (scope) => {
    const tools = service<ToolsService>(scope, "tools");
    if (tools === undefined) return;
    scope.effect(
      () =>
        tools.guard((execution: ToolExecutionLike) => {
          const session = execution.agent?.session;
          if (session === undefined) return undefined;
          const workspace = workspaceOf(session);
          if (workspace === undefined) return undefined;
          let readOnly: DirectoryView[];
          try {
            readOnly = resolveDirs(workspace).filter(
              (directory) => directory.existing && directory.readOnly,
            );
          } catch (error) {
            return `Blocked by multiple-roots: cannot resolve the attached folders (${describeError(error)}).`;
          }
          if (readOnly.length === 0) return undefined;
          // Match how the file tools resolve relative targets: the committed
          // working directory, not necessarily the immutable Session cwd.
          const workingDirectory = service<WorkingDirectoryService>(ctx, "workingDirectory");
          const cwd =
            (workingDirectory !== undefined && typeof workingDirectory.get === "function"
              ? workingDirectory.get(session)
              : undefined) ??
            (typeof session.header.cwd === "string" ? session.header.cwd : process.cwd());
          let violation;
          try {
            violation = findReadOnlyViolation(execution.name, execution.arguments, cwd, readOnly);
          } catch (error) {
            // A check that cannot establish the target may not silently allow the
            // mutation: the row's read-only intent is the stronger promise here.
            return `Blocked by multiple-roots: cannot verify "${execution.name}" against the read-only attached folders (${describeError(error)}).`;
          }
          if (violation === undefined) return undefined;
          return (
            `Blocked by multiple-roots: "${violation.target}" is inside the read-only attached folder "${violation.root}". ` +
            "Write inside a writable folder instead, or turn off read-only for that folder in the workspace menu."
          );
        }),
      "multiple-roots: read-only guard",
    );
  });

  // The model-facing surface. Only existing directories are rendered; an empty
  // effective list renders `''`, which the prompt registry drops.
  ctx.inject(["systemPrompt"], (scope) => {
    const systemPrompt = service<SystemPromptService>(scope, "systemPrompt");
    if (systemPrompt === undefined) return;
    let order: number;
    try {
      order = systemPrompt.getContextOrder("SANDBOX_POLICY") + 1;
    } catch {
      order = 111;
    }
    scope.effect(
      () =>
        systemPrompt.context({
          name: CONTEXT_NAME,
          order,
          interpolate: false,
          text: (assembly: AssembleContextLike) => {
            try {
              const session = assembly.agent?.session;
              if (session === undefined) return "";
              const workspace = workspaceOf(session);
              if (workspace === undefined) return "";
              return renderContext(resolveDirs(workspace));
            } catch {
              return "";
            }
          },
        }),
      "multiple-roots: runtime context",
    );
  });

  /** Workspace rows as the registry sees them, or undefined when unavailable. */
  const registeredWorkspaces = (): WorkspaceRow[] | undefined => {
    const registry = service<WorkspaceRegistryService>(ctx, "workspaceRegistry");
    if (registry === undefined || typeof registry.list !== "function") return undefined;
    try {
      return registry
        .list()
        .slice(0, MAX_WORKSPACE_LIST)
        .map((workspace) => ({
          path: workspace.path,
          title: workspace.title,
        }));
    } catch (error) {
      warn(`multiple-roots: cannot list workspaces: ${describeError(error)}`);
      return undefined;
    }
  };

  /** Whether the path names a registered workspace; permissive without a registry. */
  const isRegisteredWorkspace = (canonical: string): boolean => {
    const rows = registeredWorkspaces();
    if (rows === undefined) return true;
    return rows.some((row) => pathKey(row.path) === pathKey(canonical));
  };

  /** The admission fence shared by every route. */
  const admit = (request: IncomingMessage, response: ServerResponse): boolean => {
    const connection = service<ConnectionService>(ctx, "connection");
    if (connection !== undefined && typeof connection.requestRejection === "function") {
      let rejection: number | undefined;
      try {
        rejection = connection.requestRejection(request as { headers: IncomingHttpHeaders });
      } catch {
        rejection = 403;
      }
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          error: "Request was not admitted by this DSH client.",
        });
        return false;
      }
    }
    if (!isLoopbackHost(request.headers.host)) {
      sendJson(response, 403, {
        ok: false,
        error: "These routes are available on loopback hosts only.",
      });
      return false;
    }
    const site = request.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      sendJson(response, 403, {
        ok: false,
        error: "Cross-site requests are not allowed.",
      });
      return false;
    }
    return true;
  };

  /** Canonicalize and admit the workspace named by a route. */
  const requireTarget = (raw: unknown): string => {
    const canonical = canonicalizePath(raw);
    if (canonical === undefined)
      throw new MultipleRootsError("invalid-workspace", "A workspace path must be absolute.");
    if (!isRegisteredWorkspace(canonical)) {
      throw new MultipleRootsError(
        "unknown-workspace",
        `Not a registered workspace: "${canonical}".`,
      );
    }
    return canonical;
  };

  /** One stored row projected for the Client, with live existence and detail. */
  const wireRow = (
    workspace: string,
    row: Entry,
    effective: ReadonlyMap<string, DirectoryView>,
  ): WireEntry => {
    const existsNow = isExistingDirectory(row.path);
    if (row.kind === "folder") {
      return {
        kind: "folder",
        path: row.path,
        readOnly: row.readOnly,
        exists: existsNow,
        missing: existsNow ? 0 : 1,
      };
    }
    let detail: DirectoryView[];
    try {
      detail = expandAttachedWorkspace(rowsOf, workspace, row.path, {
        exists: isExistingDirectory,
      });
    } catch {
      detail = [];
    }
    const dirs = detail.map((view) => {
      const resolved = effective.get(pathKey(view.path)) ?? view;
      return {
        path: resolved.path,
        readOnly: resolved.readOnly,
        exists: resolved.existing,
        overridden: resolved.overridden,
      };
    });
    return {
      kind: "workspace",
      path: row.path,
      readOnly: row.readOnly,
      exists: existsNow,
      missing: dirs.filter((directory) => !directory.exists).length,
      dirs,
    };
  };

  /** The dialog's complete state for one workspace. */
  const statePayload = (
    workspace: string,
  ): { readonly workspacePath: string; readonly entries: WireEntry[] } => {
    const effective = new Map(
      resolveDirs(workspace).map((directory) => [pathKey(directory.path), directory]),
    );
    return {
      workspacePath: workspace,
      entries: store.entriesFor(workspace).map((row) => wireRow(workspace, row, effective)),
    };
  };

  /** Common mutation response: persist already happened, then grant fan-out. */
  const respondEntries = (response: ServerResponse, workspace: string): void => {
    try {
      syncWorkspace(workspace);
    } catch (error) {
      warn(`multiple-roots: cannot sync live sessions: ${describeError(error)}`);
    }
    sendJson(response, 200, { ok: true, ...statePayload(workspace) });
  };

  /** Map an operation error to its HTTP answer. */
  const fail = (response: ServerResponse, error: unknown): void => {
    if (error instanceof MultipleRootsError) {
      sendJson(response, 400, {
        ok: false,
        code: error.code,
        error: error.message,
      });
      return;
    }
    sendJson(response, 500, { ok: false, error: describeError(error) });
  };

  ctx.inject(["webServer"], (scope) => {
    const webServer = service<WebServerService>(scope, "webServer");
    if (webServer === undefined) return;

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.state,
          handler: (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "GET") {
              sendJson(response, 405, { ok: false, error: "GET only." });
              return;
            }
            try {
              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const workspace = requireTarget(url.searchParams.get("workspacePath"));
              sendJson(response, 200, { ok: true, ...statePayload(workspace) });
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: state route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.workspaces,
          handler: (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "GET") {
              sendJson(response, 405, { ok: false, error: "GET only." });
              return;
            }
            const rows = registeredWorkspaces();
            if (rows === undefined) {
              sendJson(response, 503, {
                ok: false,
                error: "The workspace registry is unavailable in this profile.",
              });
              return;
            }
            sendJson(response, 200, { ok: true, workspaces: rows });
          },
        }),
      "multiple-roots: workspaces route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.addFolder,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "POST") {
              sendJson(response, 405, { ok: false, error: "POST only." });
              return;
            }
            try {
              const body = await readJsonBody(request);
              const workspace = requireTarget(body.workspacePath);
              store.addFolder(workspace, body.path);
              respondEntries(response, workspace);
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: add-folder route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.addWorkspace,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "POST") {
              sendJson(response, 405, { ok: false, error: "POST only." });
              return;
            }
            try {
              const body = await readJsonBody(request);
              const workspace = requireTarget(body.workspacePath);
              const source = requireTarget(body.sourceWorkspacePath);
              store.addWorkspace(workspace, source);
              respondEntries(response, workspace);
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: add-workspace route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.readOnly,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "POST") {
              sendJson(response, 405, { ok: false, error: "POST only." });
              return;
            }
            try {
              const body = await readJsonBody(request);
              if (typeof body.readOnly !== "boolean") {
                throw new MultipleRootsError("invalid-body", "readOnly must be a boolean.");
              }
              const workspace = requireTarget(body.workspacePath);
              store.setReadOnly(workspace, body.kind, body.path, body.readOnly);
              respondEntries(response, workspace);
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: read-only route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.overrides,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "POST") {
              sendJson(response, 405, { ok: false, error: "POST only." });
              return;
            }
            try {
              const body = await readJsonBody(request);
              const readOnly = body.readOnly;
              if (readOnly !== null && typeof readOnly !== "boolean") {
                throw new MultipleRootsError("invalid-body", "readOnly must be a boolean or null.");
              }
              const workspace = requireTarget(body.workspacePath);
              store.setOverride(workspace, body.path, body.dirPath, readOnly);
              respondEntries(response, workspace);
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: override route",
    );

    scope.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: ROUTES.remove,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            if (request.method !== "POST") {
              sendJson(response, 405, { ok: false, error: "POST only." });
              return;
            }
            try {
              const body = await readJsonBody(request);
              const workspace = requireTarget(body.workspacePath);
              store.remove(workspace, body.kind, body.path);
              respondEntries(response, workspace);
            } catch (error) {
              fail(response, error);
            }
          },
        }),
      "multiple-roots: remove route",
    );
  });
}
