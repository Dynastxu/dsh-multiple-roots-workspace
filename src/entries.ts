/**
 * Pure entry operations, live workspace expansion, and the model-facing text.
 * The store owns persistence; this module owns what a row means and which
 * directories a workspace actually contributes right now.
 *
 * A row is one of two kinds:
 *  - `folder`: one attached directory with its own read-only switch;
 *  - `workspace`: one reference to another workspace. It contributes that
 *    workspace's root plus everything its list currently contributes, expanded
 *    at read time (with cycle detection), so later changes in the referenced
 *    workspace are visible without re-attaching. Per-directory read-only
 *    overrides may be stored on the reference row.
 *
 * @module dsh-multiple-roots-workspace/entries
 */

import path from "node:path";

import { canonicalizePath, isSubPath, pathKey } from "./paths";

/** Upper bound for one workspace's rows (prompt and grant fan-out). */
export const MAX_ENTRIES = 64;

/** Upper bound for one workspace row's per-directory overrides. */
export const MAX_OVERRIDES = 256;

/** Upper bound for workspace-reference nesting, as a guard on malformed data. */
export const MAX_WORKSPACE_DEPTH = 16;

/** How a row arrived in the list. */
export type EntryKind = "folder" | "workspace";

/** One attached directory or workspace reference. */
export interface Entry {
  readonly kind: EntryKind;
  readonly path: string;
  /** `folder`: the row's own switch. `workspace`: a blanket switch for the subtree. */
  readonly readOnly: boolean;
  /** Per-directory read-only overrides, keyed by canonical directory path. */
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly addedAt: number;
}

/** Optional facts for a new entry. */
export interface EntryOptions {
  readonly kind?: EntryKind;
  readonly readOnly?: boolean;
  readonly overrides?: Readonly<Record<string, boolean>>;
  readonly addedAt?: number;
}

/** One directory a workspace currently contributes. */
export interface DirectoryView {
  /** Canonical directory path. */
  readonly path: string;
  /** Effective read-only state after overrides, explicit folder rows, and inheritance. */
  readonly readOnly: boolean;
  /** Whether the directory exists on this host right now. */
  readonly existing: boolean;
  /** Whether a stored override decided the read-only state. */
  readonly overridden: boolean;
  /** Whether an explicit folder row of the owner names this directory. */
  readonly explicit: boolean;
  /** Whether the directory is an attached workspace's root. */
  readonly workspaceRoot: boolean;
}

/** Optional inputs for expansion. */
export interface ExpandOptions {
  /** Existence probe; omitting it treats every directory as present. */
  readonly exists?: (directory: string) => boolean;
  /** Workspace nesting limit; defaults to {@link MAX_WORKSPACE_DEPTH}. */
  readonly maxDepth?: number;
}

/** Reads the stored rows of one workspace. */
export type RowsOf = (workspacePath: string) => readonly Entry[];

/** Normalize an overrides object read from a row or from disk. */
function sanitizeOverrides(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: Record<string, boolean> = {};
  let count = 0;
  for (const [rawPath, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean" || count >= MAX_OVERRIDES) continue;
    const canonical = canonicalizePath(rawPath);
    if (canonical === undefined) continue;
    overrides[canonical] = value;
    count += 1;
  }
  return overrides;
}

/**
 * Build one normalized entry from a canonical directory path.
 * @param canonical - canonical existing directory.
 * @param options - row options.
 * @returns the entry.
 */
export function makeEntry(canonical: string, options: EntryOptions = {}): Entry {
  return {
    kind: options.kind === "workspace" ? "workspace" : "folder",
    path: canonical,
    readOnly: options.readOnly === true,
    overrides: sanitizeOverrides(options.overrides),
    addedAt:
      options.addedAt !== undefined && Number.isFinite(options.addedAt)
        ? options.addedAt
        : Date.now(),
  };
}

/**
 * Validate and normalize a row read from disk. A stored directory that has
 * since disappeared stays listed: the user must see it to remove it, while
 * expansion marks it missing and injection skips it.
 * @param raw - stored row.
 * @returns the entry, or `undefined` when the row is malformed.
 */
export function normalizeStoredEntry(raw: unknown): Entry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as {
    readonly kind?: unknown;
    readonly path?: unknown;
    readonly readOnly?: unknown;
    readonly overrides?: unknown;
    readonly addedAt?: unknown;
  };
  if (typeof candidate.path !== "string") return undefined;
  const canonical = canonicalizePath(candidate.path);
  if (canonical === undefined) return undefined;
  return makeEntry(canonical, {
    kind: candidate.kind === "workspace" ? "workspace" : "folder",
    readOnly: candidate.readOnly === true,
    overrides:
      candidate.overrides !== null && typeof candidate.overrides === "object"
        ? (candidate.overrides as Record<string, boolean>)
        : undefined,
    addedAt: typeof candidate.addedAt === "number" ? candidate.addedAt : undefined,
  });
}

/** Identity of one row: kind plus path, case-folded on Windows. */
function rowKey(kind: EntryKind, path: string): string {
  return `${kind}\u0000${pathKey(path)}`;
}

/**
 * Append rows that are not already present, keeping the first occurrence.
 * A folder row and a workspace row for the same directory are distinct rows.
 * @param existing - current rows.
 * @param incoming - rows to add.
 * @returns a new array.
 */
export function mergeEntries(existing: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const merged = [...existing];
  const seen = new Set(merged.map((entry) => rowKey(entry.kind, entry.path)));
  for (const entry of incoming) {
    const key = rowKey(entry.kind, entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * Drop one row by kind and canonical path (case-insensitive on Windows).
 * @param entries - current rows.
 * @param kind - row kind.
 * @param target - canonical path to remove.
 * @returns a new array.
 */
export function removeEntry(entries: readonly Entry[], kind: EntryKind, target: string): Entry[] {
  const key = rowKey(kind, target);
  return entries.filter((entry) => rowKey(entry.kind, entry.path) !== key);
}

/**
 * Turn one row's read-only switch on or off.
 * @param entries - current rows.
 * @param kind - row kind.
 * @param target - canonical path to update.
 * @param readOnly - requested state.
 * @returns the rows and whether anything changed.
 */
export function setEntryReadOnly(
  entries: readonly Entry[],
  kind: EntryKind,
  target: string,
  readOnly: boolean,
): { readonly entries: Entry[]; readonly changed: boolean } {
  const key = rowKey(kind, target);
  let changed = false;
  const next = entries.map((entry) => {
    if (rowKey(entry.kind, entry.path) !== key) return entry;
    if (entry.readOnly === readOnly) return entry;
    changed = true;
    return { ...entry, readOnly };
  });
  return { entries: next, changed };
}

/**
 * Set or clear one per-directory override on a workspace row.
 * @param entries - current rows.
 * @param rowPath - canonical path of the workspace row.
 * @param directory - canonical directory the override names.
 * @param readOnly - requested state, or `null` to follow inheritance again.
 * @returns the rows and whether anything changed.
 * @throws {EntryOverrideLimitError} when the row already holds the maximum.
 */
export function setEntryOverride(
  entries: readonly Entry[],
  rowPath: string,
  directory: string,
  readOnly: boolean | null,
): { readonly entries: Entry[]; readonly changed: boolean } {
  const key = pathKey(rowPath);
  const directoryKey = pathKey(directory);
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== "workspace" || pathKey(entry.path) !== key) return entry;
    const overrides: Record<string, boolean> = { ...entry.overrides };
    const storedKey = Object.keys(overrides).find(
      (candidate) => pathKey(candidate) === directoryKey,
    );
    if (readOnly === null) {
      if (storedKey === undefined) return entry;
      delete overrides[storedKey];
      changed = true;
      return { ...entry, overrides };
    }
    if (storedKey !== undefined && overrides[storedKey] === readOnly) return entry;
    if (storedKey === undefined && Object.keys(overrides).length >= MAX_OVERRIDES) {
      throw new EntryOverrideLimitError();
    }
    if (storedKey !== undefined) delete overrides[storedKey];
    overrides[directory] = readOnly;
    changed = true;
    return { ...entry, overrides };
  });
  return { entries: next, changed };
}

/** Thrown when one workspace row carries more overrides than the cap allows. */
export class EntryOverrideLimitError extends Error {
  constructor() {
    super(`At most ${MAX_OVERRIDES} per-directory overrides are supported per attached workspace.`);
    this.name = "EntryOverrideLimitError";
  }
}

/** Accumulated contribution of one directory. */
interface Contributed {
  readonly path: string;
  readonly readOnlyFlags: boolean[];
  readonly overrides: boolean[];
  workspaceRoot: boolean;
  explicit?: boolean;
}

/** Expansion state threaded through the recursion. */
interface Expansion {
  readonly rowsOf: RowsOf;
  readonly visited: Set<string>;
  readonly order: string[];
  readonly slots: Map<string, Contributed>;
  readonly exists: ((directory: string) => boolean) | undefined;
  readonly maxDepth: number;
}

/** The last override that names `directory`, inner-to-outer specificity resolved. */
function overrideOf(
  chains: readonly Readonly<Record<string, boolean>>[],
  directory: string,
): boolean | undefined {
  const key = pathKey(directory);
  for (let index = chains.length - 1; index >= 0; index -= 1) {
    const map = chains[index];
    if (map === undefined) continue;
    const stored = Object.keys(map).find((candidate) => pathKey(candidate) === key);
    if (stored !== undefined) return map[stored];
  }
  return undefined;
}

/** Add one directory contribution to the expansion. */
function contribute(
  expansion: Expansion,
  directory: string,
  contribution: {
    readonly readOnly: boolean;
    readonly override?: boolean | undefined;
    readonly explicit?: boolean | undefined;
    readonly workspaceRoot?: boolean;
  },
): void {
  const key = pathKey(directory);
  let slot = expansion.slots.get(key);
  if (slot === undefined) {
    slot = {
      path: directory,
      readOnlyFlags: [],
      overrides: [],
      workspaceRoot: contribution.workspaceRoot === true,
    };
    expansion.slots.set(key, slot);
    expansion.order.push(key);
  } else if (contribution.workspaceRoot === true) {
    slot.workspaceRoot = true;
  }
  slot.readOnlyFlags.push(contribution.readOnly);
  if (contribution.override !== undefined) slot.overrides.push(contribution.override);
  if (contribution.explicit !== undefined) slot.explicit = contribution.explicit;
}

/** Resolve one stored row into the expansion. */
function collectRow(
  expansion: Expansion,
  row: Entry,
  depth: number,
  chains: readonly Readonly<Record<string, boolean>>[],
  forced: boolean,
): void {
  if (row.kind === "folder") {
    contribute(expansion, row.path, {
      readOnly: row.readOnly || forced,
      override: overrideOf(chains, row.path),
      ...(depth === 0 ? { explicit: row.readOnly } : {}),
    });
    return;
  }
  const key = pathKey(row.path);
  if (expansion.visited.has(key) || depth > expansion.maxDepth) return;
  expansion.visited.add(key);
  contribute(expansion, row.path, {
    readOnly: row.readOnly || forced,
    override: overrideOf(chains, row.path),
    workspaceRoot: true,
  });
  const next = [...chains, row.overrides];
  const nextForced = forced || row.readOnly;
  for (const child of expansion.rowsOf(row.path)) {
    collectRow(expansion, child, depth + 1, next, nextForced);
  }
}

/** Materialize the accumulated slots into stable views. */
function finalize(expansion: Expansion): DirectoryView[] {
  return expansion.order.map((key) => {
    const slot = expansion.slots.get(key);
    /* v8 ignore next -- every key in order has a slot. */
    if (slot === undefined) throw new Error(`unreachable expansion slot: ${key}`);
    const override = slot.overrides.length === 0 ? undefined : slot.overrides.some(Boolean);
    const readOnly =
      override !== undefined
        ? override
        : slot.explicit !== undefined
          ? slot.explicit
          : slot.readOnlyFlags.some(Boolean);
    return {
      path: slot.path,
      readOnly,
      existing: expansion.exists?.(slot.path) ?? true,
      overridden: override !== undefined,
      explicit: slot.explicit !== undefined,
      workspaceRoot: slot.workspaceRoot,
    };
  });
}

/** Create expansion state for one owner workspace. */
function expansionFor(rowsOf: RowsOf, ownerWorkspace: string, options: ExpandOptions): Expansion {
  return {
    rowsOf,
    visited: new Set([pathKey(ownerWorkspace)]),
    order: [],
    slots: new Map(),
    exists: options.exists,
    maxDepth: options.maxDepth ?? MAX_WORKSPACE_DEPTH,
  };
}

/**
 * Expand one workspace's rows into the directories it currently contributes.
 * Workspace rows are followed live, nested references are expanded with cycle
 * detection, and each directory is resolved once even when several rows reach
 * it. Results keep first-contribution order.
 * @param rowsOf - stored-row reader for any workspace.
 * @param workspacePath - owning workspace.
 * @param options - existence probe and depth limit.
 * @returns resolved directories, including ones that are missing on disk.
 */
export function expandEntries(
  rowsOf: RowsOf,
  workspacePath: string,
  options: ExpandOptions = {},
): DirectoryView[] {
  const expansion = expansionFor(rowsOf, workspacePath, options);
  for (const row of rowsOf(workspacePath)) collectRow(expansion, row, 0, [], false);
  return finalize(expansion);
}

/**
 * Expand the subtree one attached-workspace row contributes, in the same
 * resolution terms as {@link expandEntries}. Used by the dialog's detail view.
 * @param rowsOf - stored-row reader for any workspace.
 * @param ownerWorkspace - owning workspace (its cycle guard applies).
 * @param workspaceRowPath - canonical path of the attached workspace row.
 * @param options - existence probe and depth limit.
 * @returns resolved directories for that row, without merging other rows.
 */
export function expandAttachedWorkspace(
  rowsOf: RowsOf,
  ownerWorkspace: string,
  workspaceRowPath: string,
  options: ExpandOptions = {},
): DirectoryView[] {
  const expansion = expansionFor(rowsOf, ownerWorkspace, options);
  const key = pathKey(workspaceRowPath);
  const row = rowsOf(ownerWorkspace).find(
    (candidate) => candidate.kind === "workspace" && pathKey(candidate.path) === key,
  );
  if (row === undefined) return [];
  collectRow(expansion, row, 0, [], false);
  return finalize(expansion);
}

/**
 * Render the runtime-context contribution. Missing directories are skipped so
 * the model is never told about a path that is not there; returning `''`
 * contributes nothing, so an empty effective list never injects the section.
 * @param directories - resolved directories.
 * @returns the model-facing text, or an empty string.
 */
export function renderContext(directories: readonly DirectoryView[]): string {
  const rows = directories.filter((directory) => directory.existing);
  if (rows.length === 0) return "";
  return [
    "Attached workspace folders — additional directories attached to this workspace:",
    ...rows.map((directory) => `- ${directory.path}${directory.readOnly ? " (read-only)" : ""}`),
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
 * @param rows - resolved read-only rows, or full rows with their own flags.
 * @returns the violation, when any.
 */
export function findReadOnlyViolation(
  toolName: string,
  args: unknown,
  cwd: string,
  rows: readonly { readonly path: string; readonly readOnly: boolean }[],
): { readonly target: string; readonly root: string } | undefined {
  const readOnly = rows.filter((row) => row.readOnly);
  if (readOnly.length === 0) return undefined;
  for (const raw of parseToolTargets(toolName, args)) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    const canonical = canonicalizePath(resolved);
    if (canonical === undefined) continue;
    const root = readOnly.find((row) => isSubPath(canonical, row.path));
    if (root !== undefined) return { target: raw, root: root.path };
  }
  return undefined;
}
