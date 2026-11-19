/**
 * Structural types for the Cordis surfaces this plugin consumes.
 *
 * The bundle is installed into a profile, not built inside the Harness
 * workspace, so it declares the small slice it uses instead of importing
 * pre-stable `@deepseek-ai/dsh-*` packages. Every service lookup happens at a
 * runtime boundary; {@link service} is the one assertion from `unknown`.
 *
 * @module dsh-multiple-roots-workspace/types
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

/** One live Session, as much of it as this plugin reads. */
export interface SessionLike {
  readonly id: string;
  readonly header: { readonly cwd?: string | undefined };
}

/** One live Agent, owning one Session. */
export interface AgentLike {
  readonly session: SessionLike;
}

/** The tool call handed to a guard. */
export interface ToolExecutionLike {
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: AgentLike | undefined;
}

/** `ctx.sandboxPolicy` — the session-scoped writable-root registration surface. */
export interface SandboxPolicyService {
  registerWritableRoot(session: SessionLike, directory: string): () => void;
}

/** `ctx.tools` — monotonic execution guards. */
export interface ToolsService {
  guard(guard: (execution: ToolExecutionLike) => string | undefined): () => void;
}

/** The assembly context a runtime-context provider receives. */
export interface AssembleContextLike {
  readonly agent?: AgentLike | undefined;
}

/** One dynamic runtime-context contribution. */
export interface PromptContextLike {
  readonly name: string;
  readonly order: number;
  readonly interpolate?: boolean;
  readonly text: (context: AssembleContextLike) => string;
}

/** `ctx.systemPrompt` — ordered runtime-context registration. */
export interface SystemPromptService {
  getContextOrder(name: string): number;
  context(context: PromptContextLike): () => void;
}

/** One exact HTTP route registration. */
export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

/** `ctx.webServer` — exact route ownership. */
export interface WebServerService {
  register(route: WebRouteLike): () => void;
}

/** `ctx.connection` — the Host/Origin and live-peer admission fence. */
export interface ConnectionService {
  requestRejection(request: { readonly headers: IncomingHttpHeaders }): number | undefined;
}

/** One registered Workspace row. */
export interface WorkspaceRow {
  readonly path: string;
  readonly title: string;
}

/** `ctx.workspaceRegistry` — durable Workspace records. */
export interface WorkspaceRegistryService {
  list(): readonly WorkspaceRow[];
}

/** `ctx.agents` — live Agents. */
export interface AgentsService {
  list(): readonly AgentLike[];
}

/** `ctx.workingDirectory` — the committed effective directory. */
export interface WorkingDirectoryService {
  get(session: SessionLike): string;
}

/** The Cordis surface this plugin's `apply` receives. */
export interface PluginContext {
  readonly logger: { warn(message: string): void };
  get(name: string): unknown;
  effect(callback: () => (() => void) | void, label?: string): unknown;
  inject(dependencies: readonly string[], callback: (scope: PluginContext) => void): unknown;
  on(
    event: "agent/pre-step",
    listener: (
      payload: { readonly agent: AgentLike },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
    options?: { readonly global?: boolean },
  ): () => void;
  on(
    event: "session/disposed",
    listener: (session: SessionLike) => void,
    options?: { readonly global?: boolean },
  ): () => void;
}

/**
 * Look a service up without tripping over an unloaded fiber.
 * @param ctx - the current plugin or injected context.
 * @param name - Cordis service name.
 * @returns the service, or `undefined` when it is not mounted.
 */
export function service<T>(ctx: PluginContext, name: string): T | undefined {
  const value = ctx.get(name);
  return value === undefined || value === null ? undefined : (value as T);
}
