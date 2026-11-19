/**
 * Pure entry operations and the model-facing text for attached folders.
 * The store owns persistence; this module owns what a row means.
 *
 * @module dsh-multiple-roots-workspace/entries
 */

import path from "node:path";

import { canonicalizePath, isSubPath, pathKey } from "./paths";

/** Upper bound for one workspace's attached rows (prompt and grant fan-out). */
export const MAX_ENTRIES = 64;

/** How a row arrived in the list. */
export type EntrySource = "folder" | "workspace";

/** One attached directory. */
export interface Entry {
  readonly path: string;
  readonly readOnly: boolean;
  readonly source: EntrySource;
  readonly addedAt: number;
}

/** Optional facts for a new entry. */
export interface EntryOptions {
  readonly readOnly?: boolean;
  readonly source?: EntrySource;
  readonly addedAt?: number;
}

/**
 * Build one normalized entry from a canonical directory path.
 * @param canonical - canonical existing directory.
 * @param options - row options.
 * @returns the entry.
 */
export function makeEntry(canonical: string, options: EntryOptions = {}): Entry {
  return {
    path: canonical,
    readOnly: options.readOnly === true,
    source: options.source === "workspace" ? "workspace" : "folder",
    addedAt:
      options.addedAt !== undefined && Number.isFinite(options.addedAt)
        ? options.addedAt
        : Date.now(),
  };
}

/**
 * Validate and normalize a row read from disk. A stored directory that has
 * since disappeared stays listed: the user must see it to remove it, and the
 * grant attempt reports the failure on its own.
 * @param raw - stored row.
 * @returns the entry, or `undefined` when the row is malformed.
 */
export function normalizeStoredEntry(raw: unknown): Entry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as {
    readonly path?: unknown;
    readonly readOnly?: unknown;
    readonly source?: unknown;
    readonly addedAt?: unknown;
  };
  if (typeof candidate.path !== "string") return undefined;
  const canonical = canonicalizePath(candidate.path);
  if (canonical === undefined) return undefined;
  return makeEntry(canonical, {
    readOnly: candidate.readOnly === true,
    source: candidate.source === "workspace" ? "workspace" : "folder",
    addedAt: typeof candidate.addedAt === "number" ? candidate.addedAt : undefined,
  });
}

/**
 * Append rows that are not already present, keeping the first occurrence.
 * @param existing - current rows.
 * @param incoming - rows to add.
 * @returns a new array.
 */
export function mergeEntries(existing: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const merged = [...existing];
  const seen = new Set(merged.map((entry) => pathKey(entry.path)));
  for (const entry of incoming) {
    const key = pathKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * Drop one row by canonical path (case-insensitive on Windows).
 * @param entries - current rows.
 * @param target - canonical path to remove.
 * @returns a new array.
 */
export function removeEntry(entries: readonly Entry[], target: string): Entry[] {
  const key = pathKey(target);
  return entries.filter((entry) => pathKey(entry.path) !== key);
}

/**
 * Turn one row's read-only flag on or off.
 * @param entries - current rows.
 * @param target - canonical path to update.
 * @param readOnly - requested state.
 * @returns the rows and whether anything changed.
 */
export function setEntryReadOnly(
  entries: readonly Entry[],
  target: string,
  readOnly: boolean,
): { readonly entries: Entry[]; readonly changed: boolean } {
  const key = pathKey(target);
  let changed = false;
  const next = entries.map((entry) => {
    if (pathKey(entry.path) !== key) return entry;
    if (entry.readOnly === readOnly) return entry;
    changed = true;
    return { ...entry, readOnly };
  });
  return { entries: next, changed };
}

/**
 * Rows that receive a writable-root grant: everything the agent may modify.
 * @param entries - attached rows.
 * @returns canonical writable directories.
 */
export function writablePaths(entries: readonly Entry[]): string[] {
  return entries.filter((entry) => !entry.readOnly).map((entry) => entry.path);
}

/**
 * Render the runtime-context contribution. The agent loop projects this text
 * into one durable snapshot per change; returning `''` contributes nothing, so
 * a workspace without attached rows never injects the section.
 * @param entries - attached rows.
 * @returns the model-facing text, or an empty string.
 */
export function renderContext(entries: readonly Entry[]): string {
  if (entries.length === 0) return "";
  const rows = entries.map((entry) => {
    const flags = entry.readOnly ? " (read-only)" : "";
    return `- ${entry.path}${flags}`;
  });
  return [
    "Attached workspace folders — additional directories attached to this workspace:",
    ...rows,
    'Read files anywhere with absolute paths. Write only inside folders without "(read-only)": ' +
      "file tools reject writes inside a read-only folder.",
  ].join("\n");
}

/**
 * Model-requested write targets for one tool call. Unknown tools and read-only
 * operations (`view`, reads) return no targets.
 * @param toolName - executed tool name.
 * @param args - parsed tool arguments.
 * @returns the path arguments as the model spelled them.
 */
export function parseToolTargets(toolName: string, args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  const input = args as Record<string, unknown>;
  if (toolName === "write" || toolName === "edit") {
    return typeof input.file_path === "string" ? [input.file_path] : [];
  }
  if (toolName === "str_replace_editor") {
    if (input.command === "view") return [];
    return typeof input.path === "string" ? [input.path] : [];
  }
  if (toolName === "apply_patch") {
    return typeof input.input === "string" ? patchPaths(input.input) : [];
  }
  return [];
}

const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/u;

/**
 * Paths named by patch headers (`*** Add File:`, `*** Update File:`,
 * `*** Delete File:`, `*** Move to:`), matching the `apply_patch` parser's
 * trimmed-line spelling.
 * @param text - patch input.
 * @returns named paths.
 */
function patchPaths(text: string): string[] {
  const paths: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = PATCH_HEADER.exec(line) ?? PATCH_MOVE.exec(line);
    const candidate = match?.[1]?.trim();
    if (candidate !== undefined && candidate !== "") paths.push(candidate);
  }
  return paths;
}

/**
 * Deny a file mutation that lands inside a read-only attached folder.
 *
 * The check runs in the trusted tool pipeline over model-controlled paths, so
 * canonicalize-then-contain is the complete answer for this surface (the same
 * reasoning as the filesystem backend's own fence).
 * @param toolName - executed tool name.
 * @param args - parsed tool arguments.
 * @param cwd - the Session working directory, for relative targets.
 * @param entries - attached rows.
 * @returns the violation, when any.
 */
export function findReadOnlyViolation(
  toolName: string,
  args: unknown,
  cwd: string,
  entries: readonly Entry[],
): { readonly target: string; readonly root: string } | undefined {
  const readOnly = entries.filter((entry) => entry.readOnly);
  if (readOnly.length === 0) return undefined;
  for (const raw of parseToolTargets(toolName, args)) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    const canonical = canonicalizePath(resolved);
    if (canonical === undefined) continue;
    const root = readOnly.find((entry) => isSubPath(canonical, entry.path));
    if (root !== undefined) return { target: raw, root: root.path };
  }
  return undefined;
}
