/**
 * Durable per-workspace attached-folder lists.
 *
 * All mutations are synchronous, so two HTTP requests cannot interleave a
 * read-modify-write inside one process. The file is replaced atomically through
 * a temporary sibling, so a failed write never publishes partial state.
 *
 * @module dsh-multiple-roots-workspace/store
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_ENTRIES,
  makeEntry,
  mergeEntries,
  normalizeStoredEntry,
  removeEntry,
  setEntryReadOnly,
} from "./entries";
import type { Entry, EntrySource } from "./entries";
import { canonicalizePath, pathKey } from "./paths";

/** Storage schema version written to disk. */
const STORAGE_VERSION = 1;

/** A row merged in from another workspace or from a route body. */
export interface IncomingEntry {
  readonly path: string;
  readonly readOnly?: boolean;
  readonly source?: EntrySource;
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
  return value !== null && typeof value === "object";
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
   * Attach one existing directory.
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
    if (current.some((entry) => pathKey(entry.path) === pathKey(folder))) return current;
    return this.commit(workspace, mergeEntries(current, [makeEntry(folder)]));
  }

  /**
   * Merge rows (for example another workspace's root plus its attached
   * folders) into one workspace.
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
   * Set one row's read-only flag.
   * @param workspacePath - owning workspace directory.
   * @param entryPath - canonical path named by the row.
   * @param readOnly - requested state.
   * @returns the complete row list.
   * @throws {MultipleRootsError} when the workspace or row is unknown.
   */
  setReadOnly(workspacePath: unknown, entryPath: unknown, readOnly: boolean): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const current = this.entriesFor(workspace);
    const target = this.matchEntry(current, entryPath);
    if (target === undefined)
      throw new MultipleRootsError(
        "unknown-entry",
        `No attached folder "${String(entryPath)}" in this workspace.`,
      );
    const result = setEntryReadOnly(current, target, readOnly === true);
    if (!result.changed) return current;
    return this.commit(workspace, result.entries);
  }

  /**
   * Detach one row. Missing rows are idempotent no-ops.
   * @param workspacePath - owning workspace directory.
   * @param entryPath - canonical path named by the row.
   * @returns the complete row list.
   * @throws {MultipleRootsError} when the workspace is unknown.
   */
  remove(workspacePath: unknown, entryPath: unknown): Entry[] {
    const workspace = this.requireWorkspace(workspacePath);
    const current = this.entriesFor(workspace);
    const target = this.matchEntry(current, entryPath);
    if (target === undefined) return current;
    return this.commit(workspace, removeEntry(current, target));
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

  /** Match a row by canonical path, accepting either spelling. */
  private matchEntry(entries: readonly Entry[], entryPath: unknown): string | undefined {
    const canonical = canonicalizePath(entryPath);
    if (canonical === undefined) return undefined;
    return entries.find((entry) => pathKey(entry.path) === pathKey(canonical))?.path;
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
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
}
