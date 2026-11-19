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
  // The other workspace already owns a read-only attachment, which an
  // "add workspace" action must inherit.
  const storage = path.join(process.env.DSH_HOME, "storages", "multiple-roots-workspace.json");
  mkdirSync(path.dirname(storage), { recursive: true });
  writeFileSync(
    storage,
    JSON.stringify({
      version: 1,
      workspaces: {
        [otherWorkspace]: {
          entries: [{ path: folderB, readOnly: true, source: "folder", addedAt: 1 }],
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

interface RouteResult {
  readonly ok?: boolean;
  readonly error?: string;
  readonly entries?: { path: string; readOnly: boolean; source: string }[];
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
  it("grants, guards, prompts, and routes through one workspace state", async () => {
    const granted: string[] = [];
    const disposed: string[] = [];
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
            granted.push(directory);
            return () => {
              disposed.push(directory);
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

    // No rows: no prompt contribution, no grants.
    expect(registrations.context?.text({ agent })).toBe("");
    expect(granted).toEqual([]);

    // Add a folder through the same route the Client uses.
    const added = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-folder") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, path: folderA },
      },
    );
    expect(added.status).toBe(200);
    expect(added.json.ok).toBe(true);
    expect(added.json.entries?.map((entry) => entry.path)).toEqual([folderA]);
    expect(granted).toEqual([folderA]);
    expect(registrations.context?.text({ agent })).toContain(folderA);

    // Toggle read-only: the grant is released and the prompt marks the row.
    const toggled = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/read-only") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, path: folderA, readOnly: true },
      },
    );
    expect(toggled.json.entries?.[0]?.readOnly).toBe(true);
    expect(disposed).toEqual([folderA]);
    expect(registrations.context?.text({ agent })).toContain("(read-only)");
    const denial = registrations.guard?.({
      name: "write",
      arguments: { file_path: path.join(folderA, "new.txt") },
      agent,
    });
    expect(typeof denial).toBe("string");
    expect(denial).toContain("read-only");

    // Adding a workspace inherits its root and its attached rows (with levels).
    const inherited = await callRoute(
      routes.get("/dsh-multiple-roots-workspace/add-workspace") as WebRouteLike["handler"],
      {
        method: "POST",
        body: { workspacePath: workspace, sourceWorkspacePath: otherWorkspace },
      },
    );
    expect(inherited.status).toBe(200);
    expect(inherited.json.entries?.map((entry) => [entry.path, entry.readOnly])).toEqual([
      [folderA, true],
      [otherWorkspace, false],
      [folderB, true],
    ]);
    expect(granted).toEqual([folderA, otherWorkspace]);
    expect(
      registrations.guard?.({
        name: "edit",
        arguments: { file_path: path.join(folderB, "x") },
        agent,
      }),
    ).toContain("read-only");

    // The pre-step sync is idempotent and revives grants after a disposal.
    const preStep = fake.listeners.preStep;
    expect(preStep).toBeDefined();
    await preStep?.({ agent }, async () => ({ kind: "enter", messages: [] }));
    expect(granted).toEqual([folderA, otherWorkspace]);

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
    const before = disposed.length;
    fake.listeners.disposed?.(agent.session);
    expect(disposed.length).toBeGreaterThanOrEqual(before + 1);

    // Plugin teardown releases whatever remains.
    for (const dispose of [...fake.effects].reverse()) dispose();
    expect(disposed).toContain(otherWorkspace);
  });
});
