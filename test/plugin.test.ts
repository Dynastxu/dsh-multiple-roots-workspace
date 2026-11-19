import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apply } from "../src/index";
import type {
  AgentLike,
  AgentsService,
  ConnectionService,
  PluginContext,
  PromptContextLike,
  SandboxPolicyService,
  SessionLike,
  SystemPromptService,
  ToolExecutionLike,
  ToolsService,
  WebRouteLike,
  WebServerService,
  WorkspaceRegistryService,
  WorkspaceRow,
} from "../src/types";

let root: string;
let workspace: string;
let otherWorkspace: string;
let folderA: string;
let folderB: string;
let originalHome: string | undefined;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "multiple-roots-plugin-"));
  workspace = path.join(root, "workspace");
  otherWorkspace = path.join(root, "other-workspace");
  folderA = path.join(root, "alpha");
  folderB = path.join(root, "beta");
  for (const directory of [workspace, otherWorkspace, folderA, folderB]) mkdirSync(directory);
  originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, "home");
  // The other workspace already owns a read-only attachment, which a live
  // workspace reference must keep honoring.
  const storage = path.join(process.env.DSH_HOME, "storages", "multiple-roots-workspace.json");
  mkdirSync(path.dirname(storage), { recursive: true });
  writeFileSync(
    storage,
    JSON.stringify({
      version: 2,
      workspaces: {
        [otherWorkspace]: {
          entries: [{ kind: "folder", path: folderB, readOnly: true, addedAt: 1 }],
        },
      },
    }),
  );
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

type PreStepListener = (
  payload: { readonly agent: AgentLike },
  next: () => Promise<unknown>,
) => Promise<unknown>;
type DisposedListener = (session: SessionLike) => void;

interface RouteEntry {
  readonly kind: "folder" | "workspace";
  readonly path: string;
  readonly readOnly: boolean;
  readonly exists: boolean;
  readonly missing: number;
  readonly dirs?: { readonly path: string; readonly readOnly: boolean; readonly exists: boolean }[];
}

interface RouteResult {
  readonly ok?: boolean;
  readonly error?: string;
  readonly entries?: RouteEntry[];
  readonly workspaces?: WorkspaceRow[];
}

interface FakeApp {
  readonly ctx: PluginContext;
  readonly warnings: string[];
  readonly effects: (() => void)[];
  readonly listeners: {
    preStep?: PreStepListener;
    disposed?: DisposedListener;
  };
  readonly services: Map<string, unknown>;
}

function createFakeContext(services: Map<string, unknown>): FakeApp {
  const warnings: string[] = [];
  const effects: (() => void)[] = [];
  const listeners: FakeApp["listeners"] = {};
  const ctx = {
    logger: {
      warn: (message: string) => {
        warnings.push(String(message));
      },
    },
    get: (name: string) => services.get(name),
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (typeof dispose === "function") effects.push(dispose);
      return dispose;
    },
    on(event: string, listener: unknown) {
      if (event === "agent/pre-step") listeners.preStep = listener as PreStepListener;
      else if (event === "session/disposed") listeners.disposed = listener as DisposedListener;
      return () => {};
    },
    inject(_dependencies: readonly string[], callback: (scope: PluginContext) => void) {
      callback(ctx as unknown as PluginContext);
    },
  } as unknown as PluginContext;
  return { ctx, warnings, effects, listeners, services };
}

const jsonHeaders = { host: "127.0.0.1:9999", "sec-fetch-site": "same-origin" };

async function callRoute(
  handler: WebRouteLike["handler"],
  options: {
    method?: string;
    url?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; json: RouteResult }> {
  const request = new EventEmitter() as unknown as IncomingMessage;
  const mutable = request as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  mutable.method = options.method ?? "GET";
  mutable.url = options.url ?? "/";
  mutable.headers = { ...jsonHeaders, ...options.headers };
  let status = 0;
  let payload = "";
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const response = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string | Buffer) {
      payload = chunk === undefined ? "" : String(chunk);
      settle();
    },
  } as unknown as ServerResponse;
  const promise = handler(request, response);
  if (options.body !== undefined) request.emit("data", Buffer.from(JSON.stringify(options.body)));
  request.emit("end");
  await promise;
  await settled;
  return {
    status,
    json: payload === "" ? {} : (JSON.parse(payload) as RouteResult),
  };
}

describe("plugin composition", () => {
  it("grants, expands, guards, prompts, and routes through one live workspace state", async () => {
    const active = new Set<string>();
    const agent: AgentLike = {
      session: { id: "session-1", header: { cwd: workspace } },
    };
    const routes = new Map<string, WebRouteLike["handler"]>();
    const registrations: {
      guard?: (execution: ToolExecutionLike) => string | undefined;
      context?: PromptContextLike;
    } = {};
    const connection: ConnectionService = { requestRejection: () => undefined };
    const workspaceRows: WorkspaceRow[] = [
      { path: workspace, title: "Workspace" },
      { path: otherWorkspace, title: "Other" },
    ];
    const services = new Map<string, unknown>([
      ["agents", { list: () => [agent] } satisfies AgentsService],
      [
        "sandboxPolicy",
        {
          registerWritableRoot(_session, directory) {
            active.add(directory);
            return () => {
              active.delete(directory);
            };
          },
        } satisfies SandboxPolicyService,
      ],
      [
        "tools",
        {
          guard(guard) {
            registrations.guard = guard;
            return () => {};
          },
        } satisfies ToolsService,
      ],
      [
        "systemPrompt",
        {
          getContextOrder() {
            return 10;
          },
          context(context) {
            registrations.context = context;
            return () => {};
          },
        } satisfies SystemPromptService,
      ],
      [
        "webServer",
        {
          register(route) {
            routes.set(route.path, route.handler);
            return () => {};
          },
        } satisfies WebServerService,
      ],
      ["connection", connection],
      [
        "workspaceRegistry",
        {
          list: () => workspaceRows,
        } satisfies WorkspaceRegistryService,
      ],
    ]);
    const fake = createFakeContext(services);
    apply(fake.ctx);

    const preStep = fake.listeners.preStep;
    const step = async (): Promise<void> => {
      await preStep?.({ agent }, async () => ({ kind: "enter", messages: [] }));
    };
    const state = async (): Promise<RouteResult> =>
      (
        await callRoute(
          routes.get("/dsh-multiple-roots-workspace/state") as WebRouteLike["handler"],
          {
            url: `/dsh-multiple-roots-workspace/state?workspacePath=${encodeURIComponent(workspace)}`,
          },
        )
      ).json;

    // No rows: no prompt contribution, no grants.
    expect(registrations.context?.text({ agent })).toBe("");
    expect(active.size).toBe(0);

    // Add a folder through the same route the Client uses.
    const added = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-folder") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, path: folderA },
      },
    );
    expect(added.status).toBe(200);
    expect(added.json.entries?.map((entry) => [entry.kind, entry.path])).toEqual([
      ["folder", folderA],
    ]);
    expect(active.has(folderA)).toBe(true);
    expect(registrations.context?.text({ agent })).toContain(folderA);

    // Toggle read-only: the grant is released and the prompt marks the row.
    await callRoute(
      routes.get("/dsh-multiple-roots-workspace/read-only") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, kind: "folder", path: folderA, readOnly: true },
      },
    );
    expect(active.has(folderA)).toBe(false);
    expect(registrations.context?.text({ agent })).toContain("(read-only)");
    expect(
      registrations.guard?.({
        name: "write",
        arguments: { file_path: path.join(folderA, "new.txt") },
        agent,
      }),
    ).toContain("read-only");

    // Attaching a workspace stores ONE reference row and expands it live.
    const attached = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-workspace") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, sourceWorkspacePath: otherWorkspace },
      },
    );
    expect(attached.status).toBe(200);
    expect(attached.json.entries?.map((entry) => [entry.kind, entry.path])).toEqual([
      ["folder", folderA],
      ["workspace", otherWorkspace],
    ]);
    expect(active.has(otherWorkspace)).toBe(true);
    // The referenced workspace's own read-only row is honored.
    expect(active.has(folderB)).toBe(false);
    expect(registrations.context?.text({ agent })).toContain(folderB);
    expect(
      registrations.guard?.({
        name: "edit",
        arguments: { file_path: path.join(folderB, "x") },
        agent,
      }),
    ).toContain("read-only");

    // The dialog reports live existence per row and per expanded directory.
    const beforeDelete = await state();
    const attachedRow = beforeDelete.entries?.find((entry) => entry.kind === "workspace");
    expect(attachedRow?.exists).toBe(true);
    expect(attachedRow?.missing).toBe(0);
    expect(attachedRow?.dirs?.map((dir) => dir.path)).toEqual([otherWorkspace, folderB]);

    // Deleting a source folder: injection skips it, the grant set is unchanged
    // (it was read-only), and the dialog marks the workspace blob as partial.
    rmSync(folderB, { recursive: true, force: true });
    await step();
    expect(registrations.context?.text({ agent })).not.toContain(folderB);
    expect(active.has(otherWorkspace)).toBe(true);
    const afterDelete = await state();
    expect(afterDelete.entries?.find((entry) => entry.kind === "workspace")?.missing).toBe(1);
    expect(
      afterDelete.entries
        ?.find((entry) => entry.kind === "workspace")
        ?.dirs?.find((dir) => dir.path === folderB)?.exists,
    ).toBe(false);

    // The directory coming back is picked up again without re-attaching.
    mkdirSync(folderB);
    await step();
    expect(registrations.context?.text({ agent })).toContain(folderB);

    // A per-directory override can make the inherited read-only folder writable.
    await callRoute(
      routes.get("/dsh-multiple-roots-workspace/overrides") as WebRouteLike["handler"],
      {
        method: "POST",
        body: {
          workspacePath: workspace,
          path: otherWorkspace,
          dirPath: folderB,
          readOnly: false,
        },
      },
    );
    expect(active.has(folderB)).toBe(true);
    const overrideState = await state();
    expect(
      overrideState.entries
        ?.find((entry) => entry.kind === "workspace")
        ?.dirs?.find((dir) => dir.path === folderB),
    ).toMatchObject({ readOnly: false });

    // The workspace row's blanket switch turns the rest of the subtree
    // read-only; the per-directory override keeps its own answer.
    await callRoute(
      routes.get("/dsh-multiple-roots-workspace/read-only") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, kind: "workspace", path: otherWorkspace, readOnly: true },
      },
    );
    expect(active.has(otherWorkspace)).toBe(false);
    expect(active.has(folderB)).toBe(true);
    expect(
      registrations.guard?.({
        name: "write",
        arguments: { file_path: path.join(otherWorkspace, "x") },
        agent,
      }),
    ).toContain("read-only");

    // An explicit writable folder row for the same directory wins.
    await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-folder") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, path: otherWorkspace },
      },
    );
    expect(active.has(otherWorkspace)).toBe(true);
    expect(active.has(folderB)).toBe(true);

    // Removing the workspace row leaves the explicit folder row behind.
    await callRoute(routes.get("/dsh-multiple-roots-workspace/remove") as WebRouteLike["handler"], {
      method: "POST",
      body: { workspacePath: workspace, kind: "workspace", path: otherWorkspace },
    });
    const remaining = await state();
    expect(remaining.entries?.map((entry) => [entry.kind, entry.path])).toEqual([
      ["folder", folderA],
      ["folder", otherWorkspace],
    ]);
    expect(registrations.context?.text({ agent })).not.toContain(folderB);
    expect(active.has(folderB)).toBe(false);

    // A missing folder row stays listed with exists=false.
    rmSync(folderA, { recursive: true, force: true });
    const missingState = await state();
    expect(missingState.entries?.find((entry) => entry.path === folderA)).toMatchObject({
      exists: false,
      missing: 1,
    });
    mkdirSync(folderA);

    // Unknown workspaces and wrong row kinds are rejected, not silently stored.
    const unknown = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-workspace") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, sourceWorkspacePath: path.join(root, "ghost") },
      },
    );
    expect(unknown.status).toBe(400);
    const wrongKind = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/overrides") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, path: folderA, dirPath: folderA, readOnly: true },
      },
    );
    expect(wrongKind.status).toBe(400);

    // An unadmitted request never reaches the store.
    connection.requestRejection = () => 401;
    const rejected = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/state") as WebRouteLike["handler"],
      {
        url: `/dsh-multiple-roots-workspace/state?workspacePath=${encodeURIComponent(workspace)}`,
      },
    );
    expect(rejected.status).toBe(401);
    expect(rejected.json.ok).toBe(false);

    // Session disposal releases that Session's registrations.
    fake.listeners.disposed?.(agent.session);
    expect(active.size).toBe(0);

    // Plugin teardown releases whatever remains.
    for (const dispose of [...fake.effects].reverse()) dispose();
    expect(fake.warnings).toEqual([]);
  });
});
