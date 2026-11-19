/**
 * Durable per-workspace attached-folder lists.
 *
 * All mutations are synchronous, so two HTTP requests cannot interleave a
 * read-modify-write inside one process. The file is replaced atomically through
 * a temporary sibling, so a failed write never publishes partial state.
 *
 * Schema version 2 stores two row kinds: `folder` rows name one directory,
 * `workspace` rows reference another workspace (one row, expanded live). Version
 * 1 rows — the old snapshot rows — load as `folder` rows, which preserves every
 * path and loses only the provenance that version 1 never recorded reliably.
 *
 * @module dsh-multiple-roots-workspace/store
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EntryOverrideLimitError,
  MAX_ENTRIES,
  makeEntry,
  mergeEntries,
  normalizeStoredEntry,
  removeEntry,
  setEntryOverride,
  setEntryReadOnly,
} from "./entries";
import type { Entry, EntryKind } from "./entries";
import { canonicalizePath, pathKey } from "./paths";

/** Storage schema version written to disk. */
const STORAGE_VERSION = 2;

/** Versions this build can read. */
const READABLE_VERSIONS = new Set([1, 2]);

/** A row merged in from a route body. */
export interface IncomingEntry {
  readonly kind?: EntryKind;
  readonly path: string;
  readonly readOnly?: boolean;
  readonly overrides?: Readonly<Record<string, boolean>>;
  readonly addedAt?: number;
}

/** One workspace's stored rows. */
interface StoredWorkspace {
  readonly entries: Entry[];
}

/** The complete storage document. */
interface StoredData {
  readonly version: number;
  readonly workspaces: Record<string, StoredWorkspace>;
}

/** A rejected store operation carrying a stable code for the route layer. */
export class MultipleRootsError extends Error {
  readonly code: string;

  /**
   * @param code - stable machine code (`invalid-path`, `missing`, ...).
   * @param message - operator-facing explanation.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "MultipleRootsError";
    this.code = code;
  }
}

/** Options accepted by {@link MultipleRootsStore}. */
export interface StoreOptions {
  /** Storage file; defaults to `$DSH_HOME/storages/multiple-roots-workspace.json`. */
  readonly filePath?: string;
  /** Sink for recoverable load warnings. */
  readonly warn?: (message: string) => void;
}

/**
 * The default storage file under `$DSH_HOME/storages`.
 * @returns absolute file path.
 */
export function defaultStoragePath(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.join(home, "storages", "multiple-roots-workspace.json");
}

/** Empty domain state. */
function emptyData(): StoredData {
  return { version: STORAGE_VERSION, workspaces: {} };
}

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Serialize one row, omitting empty overrides and the folder kind default. */
function serializeEntry(entry: Entry): Record<string, unknown> {
  return {
    kind: entry.kind,
    path: entry.path,
    readOnly: entry.readOnly,
    ...(Object.keys(entry.overrides).length === 0 ? {} : { overrides: entry.overrides }),
    addedAt: entry.addedAt,
  };
}

export class MultipleRootsStore {
  readonly filePath: string;
  private readonly warn: (message: string) => void;
  private readonly data: StoredData;

  /**
   * @param options - storage file and warning sink.
   */
  constructor(options: StoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStoragePath();
    this.warn = options.warn ?? (() => {});
    this.data = this.load();
  }

  /**
   * Attached rows for one workspace, in insertion order.
   * @param workspacePath - workspace directory (any spelling).
   * @returns a detached array; never throws.
   */
  entriesFor(workspacePath: unknown): Entry[] {
    const found = this.lookup(workspacePath);
    if (found === undefined || found.key === undefined) return [];
    return this.data.workspaces[found.key]?.entries.map((entry) => ({ ...entry })) ?? [];
  }

  /**
   * Attach one existing directory as a folder row.
   * @param workspacePath - owning workspace directory.
   * @param folderPath - directory to attach; any spelling of an existing directory.
   * @returns the complete row list.
   * @throws {MultipleRootsError} on invalid, missing, non-directory, primary, or over-limit input.
   */
  addFolder(workspacePath: unknown, folderPath: unknown): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const folder = this.requireDirectory(folderPath);
    if (pathKey(folder) === pathKey(workspace)) {
      throw new MultipleRootsError(
        "primary",
        "The workspace directory itself cannot be an attached folder.",
      );
    }
    const current = this.entriesFor(workspace);
    if (
      current.some((entry) => entry.kind === "folder" && pathKey(entry.path) === pathKey(folder))
    ) {
      return current;
    }
    return this.commit(workspace, mergeEntries(current, [makeEntry(folder, { kind: "folder" })]));
  }

  /**
   * Attach another workspace as one reference row. Its own rows are expanded
   * live at read time; they are never copied.
   * @param workspacePath - owning workspace directory.
   * @param sourceWorkspacePath - workspace whose root becomes the referenced directory.
   * @returns the complete row list.
   * @throws {MultipleRootsError} on invalid, missing, non-directory, primary, or over-limit input.
   */
  addWorkspace(workspacePath: unknown, sourceWorkspacePath: unknown): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const source = this.requireDirectory(sourceWorkspacePath);
    if (pathKey(source) === pathKey(workspace)) {
      throw new MultipleRootsError("primary", "A workspace cannot be attached to itself.");
    }
    const current = this.entriesFor(workspace);
    if (
      current.some((entry) => entry.kind === "workspace" && pathKey(entry.path) === pathKey(source))
    ) {
      return current;
    }
    return this.commit(
      workspace,
      mergeEntries(current, [makeEntry(source, { kind: "workspace" })]),
    );
  }

  /**
   * Merge rows merged from a route body (kept for the tests' convenience and
   * for forwarding a client-built list).
   * @param workspacePath - owning workspace directory.
   * @param incoming - rows to merge.
   * @returns the complete row list.
   * @throws {MultipleRootsError} on invalid or over-limit input.
   */
  addEntries(workspacePath: unknown, incoming: readonly IncomingEntry[]): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const key = pathKey(workspace);
    const rows: Entry[] = [];
    for (const raw of incoming) {
      const canonical = canonicalizePath(raw.path);
      if (canonical === undefined || pathKey(canonical) === key) continue;
      rows.push(makeEntry(canonical, raw));
    }
    const current = this.entriesFor(workspace);
    const merged = mergeEntries(current, rows);
    if (merged.length === current.length) return current;
    return this.commit(workspace, merged);
  }

  /**
   * Set one row's read-only switch.
   * @param workspacePath - owning workspace directory.
   * @param kind - row kind.
   * @param entryPath - canonical path named by the row.
   * @param readOnly - requested state.
   * @returns the complete row list.
   * @throws {MultipleRootsError} when the workspace or row is unknown.
   */
  setReadOnly(
    workspacePath: unknown,
    kind: unknown,
    entryPath: unknown,
    readOnly: boolean,
  ): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const rowKind = this.requireKind(kind);
    const current = this.entriesFor(workspace);
    const target = this.matchEntry(current, rowKind, entryPath);
    if (target === undefined)
      throw new MultipleRootsError(
        "unknown-entry",
        `No attached folder "${String(entryPath)}" in this workspace.`,
      );
    const result = setEntryReadOnly(current, rowKind, target, readOnly === true);
    if (!result.changed) return current;
    return this.commit(workspace, result.entries);
  }

  /**
   * Set or clear one per-directory override on a workspace row.
   * @param workspacePath - owning workspace directory.
   * @param rowPath - canonical path of the workspace row.
   * @param directory - directory the override names.
   * @param readOnly - requested state, or `null` to follow inheritance again.
   * @returns the complete row list.
   * @throws {MultipleRootsError} when the workspace or row is unknown.
   */
  setOverride(
    workspacePath: unknown,
    rowPath: unknown,
    directory: unknown,
    readOnly: boolean | null,
  ): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const current = this.entriesFor(workspace);
    const target = this.matchEntry(current, "workspace", rowPath);
    if (target === undefined)
      throw new MultipleRootsError(
        "unknown-entry",
        `No attached workspace "${String(rowPath)}" in this workspace.`,
      );
    const canonical = canonicalizePath(directory);
    if (canonical === undefined)
      throw new MultipleRootsError(
        "invalid-path",
        "An overridden directory must be an absolute path.",
      );
    let result: { readonly entries: Entry[]; readonly changed: boolean };
    try {
      result = setEntryOverride(current, target, canonical, readOnly === true ? true : readOnly);
    } catch (error) {
      if (error instanceof EntryOverrideLimitError) {
        throw new MultipleRootsError("limit", error.message);
      }
      throw error;
    }
    if (!result.changed) return current;
    return this.commit(workspace, result.entries);
  }

  /**
   * Detach one row. Missing rows are idempotent no-ops.
   * @param workspacePath - owning workspace directory.
   * @param kind - row kind.
   * @param entryPath - canonical path named by the row.
   * @returns the complete row list.
   * @throws {MultipleRootsError} when the workspace is unknown.
   */
  remove(workspacePath: unknown, kind: unknown, entryPath: unknown): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const rowKind = this.requireKind(kind);
    const current = this.entriesFor(workspace);
    const target = this.matchEntry(current, rowKind, entryPath);
    if (target === undefined) return current;
    return this.commit(workspace, removeEntry(current, rowKind, target));
  }

  /** The workspace's canonical spelling, creating neither. */
  private requireWorkspace(workspacePath: unknown): string {
    const found = this.lookup(workspacePath);
    if (found !== undefined) return found.canonical;
    throw new MultipleRootsError(
      "invalid-workspace",
      "A workspace path must be an absolute directory path.",
    );
  }

  /** Validate a row-kind argument; an absent kind means a folder row. */
  private requireKind(kind: unknown): EntryKind {
    if (kind === undefined || kind === null || kind === "folder") return "folder";
    if (kind === "workspace") return "workspace";
    throw new MultipleRootsError("invalid-kind", `Unknown attached row kind: "${String(kind)}".`);
  }

  /** Canonical spelling plus the existing storage key, when one is stored. */
  private lookup(
    workspacePath: unknown,
  ): { readonly canonical: string; readonly key: string | undefined } | undefined {
    const canonical = canonicalizePath(workspacePath);
    if (canonical === undefined) return undefined;
    const key = Object.keys(this.data.workspaces).find(
      (candidate) => pathKey(candidate) === pathKey(canonical),
    );
    return { canonical, key };
  }

  /** Resolve and validate one attachable directory. */
  private requireDirectory(folderPath: unknown): string {
    const canonical = canonicalizePath(folderPath);
    if (canonical === undefined) {
      throw new MultipleRootsError(
        "invalid-path",
        "An attached folder must be an absolute directory path.",
      );
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(canonical);
    } catch {
      throw new MultipleRootsError("missing", `Directory does not exist: "${String(folderPath)}".`);
    }
    if (!stat.isDirectory())
      throw new MultipleRootsError("not-directory", `Not a directory: "${String(folderPath)}".`);
    return canonical;
  }

  /** Match a row by kind and canonical path, accepting either spelling. */
  private matchEntry(
    entries: readonly Entry[],
    kind: EntryKind,
    entryPath: unknown,
  ): string | undefined {
    const canonical = canonicalizePath(entryPath);
    if (canonical === undefined) return undefined;
    return entries.find(
      (entry) => entry.kind === kind && pathKey(entry.path) === pathKey(canonical),
    )?.path;
  }

  /** Persist a complete list and return it. */
  private commit(workspace: string, entries: Entry[]): Entry[] {
    if (entries.length > MAX_ENTRIES) {
      throw new MultipleRootsError(
        "limit",
        `At most ${MAX_ENTRIES} attached folders are supported per workspace.`,
      );
    }
    const found = this.lookup(workspace);
    /* v8 ignore next -- requireWorkspace already proved the path canonicalizes. */
    if (found === undefined)
      throw new MultipleRootsError("invalid-workspace", "Invalid workspace path.");
    const previous = this.data.workspaces[found.canonical];
    const staleKey =
      found.key !== undefined && found.key !== found.canonical ? found.key : undefined;
    const stale = staleKey === undefined ? undefined : this.data.workspaces[staleKey];
    if (staleKey !== undefined) delete this.data.workspaces[staleKey];
    this.data.workspaces[found.canonical] = { entries };
    try {
      this.save();
    } catch (error) {
      // A failed write must not publish in-memory state that disk does not hold.
      if (staleKey !== undefined && stale !== undefined) this.data.workspaces[staleKey] = stale;
      if (previous === undefined) delete this.data.workspaces[found.canonical];
      else this.data.workspaces[found.canonical] = previous;
      throw error;
    }
    return entries.map((entry) => ({ ...entry }));
  }

  /** Read the storage file, tolerating a missing file and reporting other damage. */
  private load(): StoredData {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        this.warn(`multiple-roots: cannot read ${this.filePath}: ${String(error)}`);
      }
      return emptyData();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.warn(`multiple-roots: ignoring malformed ${this.filePath}: ${String(error)}`);
      return emptyData();
    }
    if (!isRecord(parsed)) return emptyData();
    const version = typeof parsed.version === "number" ? parsed.version : STORAGE_VERSION;
    if (!READABLE_VERSIONS.has(version)) {
      this.warn(
        `multiple-roots: ignoring ${this.filePath} with unsupported schema version ${String(version)}`,
      );
      return emptyData();
    }
    const stored = parsed.workspaces;
    if (!isRecord(stored)) return emptyData();
    const workspaces: Record<string, StoredWorkspace> = {};
    for (const [root, value] of Object.entries(stored)) {
      const canonicalRoot = canonicalizePath(root);
      if (canonicalRoot === undefined) continue;
      const rawRows = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
      const entries = rawRows
        .map(normalizeStoredEntry)
        .filter((entry): entry is Entry => entry !== undefined);
      workspaces[canonicalRoot] = { entries };
    }
    return { version: STORAGE_VERSION, workspaces };
  }

  /** Atomically replace the storage file. */
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const document = {
      version: STORAGE_VERSION,
      workspaces: Object.fromEntries(
        Object.entries(this.data.workspaces).map(([root, value]) => [
          root,
          { entries: value.entries.map(serializeEntry) },
        ]),
      ),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
}
