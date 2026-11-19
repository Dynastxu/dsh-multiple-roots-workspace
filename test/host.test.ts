import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_ENTRIES,
  expandAttachedWorkspace,
  expandEntries,
  findReadOnlyViolation,
  makeEntry,
  mergeEntries,
  normalizeStoredEntry,
  parseToolTargets,
  renderContext,
  setEntryOverride,
} from "../src/entries";
import type { DirectoryView, Entry, RowsOf } from "../src/entries";
import { isSubPath } from "../src/paths";
import { MultipleRootsError, MultipleRootsStore } from "../src/store";

let root: string;
let workspace: string;
let folderA: string;
let folderB: string;
let file: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "multiple-roots-"));
  workspace = path.join(root, "workspace");
  folderA = path.join(root, "alpha");
  folderB = path.join(root, "beta");
  mkdirSync(workspace);
  mkdirSync(folderA);
  mkdirSync(folderB);
  file = path.join(root, "file.txt");
  writeFileSync(file, "x");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const storage = (): string =>
  path.join(root, `storage-${Math.random().toString(36).slice(2)}.json`);

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function expectStoreError(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MultipleRootsError);
  if (!(caught instanceof MultipleRootsError)) return;
  expect(caught.code).toBe(code);
}

/** A resolved directory for rendering tests. */
function view(
  target: string,
  options: { readOnly?: boolean; existing?: boolean } = {},
): DirectoryView {
  return {
    path: target,
    readOnly: options.readOnly === true,
    existing: options.existing !== false,
    overridden: false,
    explicit: false,
    workspaceRoot: false,
  };
}

/** A row source over a plain map. */
function rowsOfMap(map: Readonly<Record<string, Entry[]>>): RowsOf {
  return (workspacePath) => map[workspacePath] ?? [];
}

describe("renderContext", () => {
  it("contributes nothing without rows", () => {
    expect(renderContext([])).toBe("");
  });

  it("lists paths and marks read-only directories", () => {
    const text = renderContext([
      view(folderA, { readOnly: true }),
      view(folderB),
      view(path.join(root, "gone"), { existing: false }),
    ]);
    expect(text).toMatch(new RegExp(escape(folderA)));
    expect(text).toMatch(/\(read-only\)/u);
    expect(text).not.toMatch(new RegExp(`${escape(folderB)} \\(read-only\\)`));
    expect(text).not.toContain(path.join(root, "gone"));
  });
});

describe("parseToolTargets", () => {
  it("reads write and edit file paths", () => {
    expect(parseToolTargets("write", { file_path: "a.txt" })).toEqual(["a.txt"]);
    expect(parseToolTargets("edit", { file_path: "b.txt" })).toEqual(["b.txt"]);
  });

  it("ignores read-only commands and unrelated tools", () => {
    expect(parseToolTargets("str_replace_editor", { command: "view", path: "a" })).toEqual([]);
    expect(parseToolTargets("read", { file_path: "a" })).toEqual([]);
    expect(parseToolTargets("write", null)).toEqual([]);
  });

  it("reads patch headers, including moves", () => {
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(folderA, "new.txt")}`,
      "+x",
      `*** Update File: ${path.join(folderB, "old.txt")}`,
      "*** Move to: moved.txt",
      "@@",
      "-a",
      "+b",
      `*** Delete File: ${path.join(folderA, "gone.txt")}`,
      "*** End Patch",
    ].join("\n");
    expect(parseToolTargets("apply_patch", { input: patch })).toEqual([
      path.join(folderA, "new.txt"),
      path.join(folderB, "old.txt"),
      "moved.txt",
      path.join(folderA, "gone.txt"),
    ]);
  });
});

describe("isSubPath", () => {
  it("treats the root itself and descendants as contained", () => {
    expect(isSubPath(folderA, folderA)).toBe(true);
    expect(isSubPath(path.join(folderA, "child"), folderA)).toBe(true);
  });

  it("does not confuse a sibling prefix with a descendant", () => {
    expect(isSubPath(`${folderA}-copy`, folderA)).toBe(false);
  });
});

describe("findReadOnlyViolation", () => {
  // Built per test: Vitest collects suite bodies before `beforeAll` runs.
  const rows = (): { path: string; readOnly: boolean }[] => [
    { path: folderA, readOnly: true },
    { path: folderB, readOnly: false },
  ];

  it("denies a write inside the read-only row", () => {
    const result = findReadOnlyViolation(
      "write",
      { file_path: path.join(folderA, "x.txt") },
      workspace,
      rows(),
    );
    expect(result?.root).toBe(folderA);
  });

  it("allows writable rows and paths outside every attached row", () => {
    expect(
      findReadOnlyViolation("write", { file_path: path.join(folderB, "x.txt") }, workspace, rows()),
    ).toBeUndefined();
    expect(
      findReadOnlyViolation(
        "write",
        { file_path: path.join(root, "elsewhere.txt") },
        workspace,
        rows(),
      ),
    ).toBeUndefined();
  });

  it("resolves relative targets against the Session cwd", () => {
    expect(
      findReadOnlyViolation("edit", { file_path: "../alpha/x.txt" }, workspace, rows())?.root,
    ).toBe(folderA);
  });

  it("checks every path named by a patch", () => {
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(folderB, "ok")}`,
      "+x",
      `*** Update File: ${path.join(folderA, "no")}`,
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    expect(findReadOnlyViolation("apply_patch", { input: patch }, workspace, rows())?.root).toBe(
      folderA,
    );
  });

  it("does nothing without read-only rows", () => {
    expect(
      findReadOnlyViolation("write", { file_path: path.join(folderA, "x") }, workspace, [
        { path: folderA, readOnly: false },
      ]),
    ).toBeUndefined();
  });
});

describe("rows and overrides", () => {
  it("keeps a folder row and a workspace row for the same path apart", () => {
    const merged = mergeEntries(
      [makeEntry(folderA, { kind: "folder", readOnly: true })],
      [makeEntry(folderA, { kind: "workspace" }), makeEntry(folderA, { kind: "folder" })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.kind)).toEqual(["folder", "workspace"]);
  });

  it("sets, replaces, and clears overrides", () => {
    const rows = [makeEntry(folderA, { kind: "workspace" })];
    const set = setEntryOverride(rows, folderA, folderB, true);
    expect(set.changed).toBe(true);
    expect(set.entries[0]?.overrides[folderB]).toBe(true);
    const cleared = setEntryOverride(set.entries, folderA, folderB, null);
    expect(cleared.entries[0]?.overrides).toEqual({});
  });

  it("normalizes stored rows with an unknown kind as a folder", () => {
    const entry = normalizeStoredEntry({ path: folderA, readOnly: true, source: "workspace" });
    expect(entry?.kind).toBe("folder");
  });
});

describe("expandEntries", () => {
  it("marks missing directories without dropping them", () => {
    const rows = rowsOfMap({ [workspace]: [makeEntry(folderA, { kind: "folder" })] });
    const dirs = expandEntries(rows, workspace, { exists: (target) => target === folderB });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({ path: folderA, existing: false });
  });

  it("expands an attached workspace live, root first", () => {
    const rows = rowsOfMap({
      [workspace]: [makeEntry(folderB, { kind: "workspace" })],
      [folderB]: [makeEntry(folderA, { kind: "folder", readOnly: true })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.map((directory) => directory.path)).toEqual([folderB, folderA]);
    expect(dirs[0]).toMatchObject({ workspaceRoot: true, readOnly: false });
    expect(dirs[1]).toMatchObject({ readOnly: true, workspaceRoot: false });
  });

  it("follows nested workspace references and stops at cycles", () => {
    const rows = rowsOfMap({
      [workspace]: [makeEntry(folderB, { kind: "workspace" })],
      [folderB]: [makeEntry(workspace, { kind: "workspace" })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.map((directory) => directory.path)).toEqual([folderB]);
  });

  it("resolves each directory once, keeping the first position", () => {
    const rows = rowsOfMap({
      [workspace]: [
        makeEntry(folderA, { kind: "folder", readOnly: true }),
        makeEntry(folderB, { kind: "workspace" }),
      ],
      [folderB]: [makeEntry(folderA, { kind: "folder" })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.map((directory) => directory.path)).toEqual([folderA, folderB]);
    expect(dirs[0]?.readOnly).toBe(true);
  });

  it("lets an explicit writable folder row override inherited read-only", () => {
    const rows = rowsOfMap({
      [workspace]: [
        makeEntry(folderA, { kind: "folder" }),
        makeEntry(folderB, { kind: "workspace" }),
      ],
      [folderB]: [makeEntry(folderA, { kind: "folder", readOnly: true })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.find((directory) => directory.path === folderA)).toMatchObject({
      readOnly: false,
      explicit: true,
    });
  });

  it("inherits the workspace row's blanket read-only switch", () => {
    const rows = rowsOfMap({
      [workspace]: [makeEntry(folderB, { kind: "workspace", readOnly: true })],
      [folderB]: [makeEntry(folderA, { kind: "folder" })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.every((directory) => directory.readOnly)).toBe(true);
  });

  it("lets a per-directory override outrank inheritance and folder rows", () => {
    const rows = rowsOfMap({
      [workspace]: [
        makeEntry(folderA, { kind: "workspace", overrides: { [folderB]: true } }),
        makeEntry(folderB, { kind: "folder" }),
      ],
      [folderA]: [makeEntry(folderB, { kind: "folder" })],
    });
    const dirs = expandEntries(rows, workspace);
    expect(dirs.find((directory) => directory.path === folderB)).toMatchObject({
      readOnly: true,
      overridden: true,
    });
  });

  it("reads the referenced workspace again on every expansion", () => {
    const live: Record<string, Entry[]> = {
      [workspace]: [makeEntry(folderB, { kind: "workspace" })],
    };
    const liveRows: RowsOf = (target) => live[target] ?? [];
    expect(expandEntries(liveRows, workspace)).toHaveLength(1);
    live[folderB] = [makeEntry(folderA, { kind: "folder" })];
    expect(expandEntries(liveRows, workspace).map((directory) => directory.path)).toEqual([
      folderB,
      folderA,
    ]);
  });

  it("expands one attached workspace's subtree for the detail view", () => {
    const rows = rowsOfMap({
      [workspace]: [
        makeEntry(folderA, { kind: "folder" }),
        makeEntry(folderB, { kind: "workspace" }),
      ],
      [folderB]: [makeEntry(path.join(root, "deep"), { kind: "folder" })],
    });
    const detail = expandAttachedWorkspace(rows, workspace, folderB);
    expect(detail.map((directory) => directory.path)).toEqual([folderB, path.join(root, "deep")]);
    expect(expandAttachedWorkspace(rows, workspace, folderA)).toEqual([]);
  });
});

describe("MultipleRootsStore", () => {
  it("persists folder and workspace rows across reloads", () => {
    const filePath = storage();
    const store = new MultipleRootsStore({ filePath });
    store.addFolder(workspace, folderA);
    store.addWorkspace(workspace, folderB);
    const again = new MultipleRootsStore({ filePath });
    expect(again.entriesFor(workspace).map((entry) => [entry.kind, entry.path])).toEqual([
      ["folder", folderA],
      ["workspace", folderB],
    ]);
  });

  it("stores one row per attached workspace instead of copying its list", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    store.addFolder(folderB, folderA);
    const entries = store.addWorkspace(workspace, folderB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "workspace", path: folderB });
    expect(store.addWorkspace(workspace, folderB)).toHaveLength(1);
  });

  it("keeps a folder row next to a workspace row for the same directory", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    store.addWorkspace(workspace, folderB);
    store.addFolder(workspace, folderB);
    expect(store.entriesFor(workspace).map((entry) => entry.kind)).toEqual(["workspace", "folder"]);
  });

  it("distinguishes rows by kind when toggling and removing", () => {
    const filePath = storage();
    const store = new MultipleRootsStore({ filePath });
    store.addWorkspace(workspace, folderB);
    store.addFolder(workspace, folderB);
    store.setReadOnly(workspace, "workspace", folderB, true);
    expect(store.entriesFor(workspace).map((entry) => [entry.kind, entry.readOnly])).toEqual([
      ["workspace", true],
      ["folder", false],
    ]);
    expect(store.remove(workspace, "workspace", folderB)).toHaveLength(1);
    expect(store.entriesFor(workspace)[0]?.kind).toBe("folder");
    expectStoreError(
      () => store.setReadOnly(workspace, "workspace", folderB, true),
      "unknown-entry",
    );
  });

  it("persists and clears per-directory overrides", () => {
    const filePath = storage();
    const store = new MultipleRootsStore({ filePath });
    store.addWorkspace(workspace, folderB);
    store.setOverride(workspace, folderB, folderA, true);
    expect(new MultipleRootsStore({ filePath }).entriesFor(workspace)[0]?.overrides[folderA]).toBe(
      true,
    );
    store.setOverride(workspace, folderB, folderA, null);
    expect(new MultipleRootsStore({ filePath }).entriesFor(workspace)[0]?.overrides).toEqual({});
  });

  it("is idempotent for an already attached folder", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    store.addFolder(workspace, folderA);
    expect(store.addFolder(workspace, folderA)).toHaveLength(1);
  });

  it("rejects invalid, missing, non-directory, and primary paths with stable codes", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    const cases: [unknown, string][] = [
      ["relative/folder", "invalid-path"],
      [path.join(root, "ghost"), "missing"],
      [file, "not-directory"],
      [workspace, "primary"],
    ];
    for (const [candidate, code] of cases) {
      expectStoreError(() => store.addFolder(workspace, candidate), code);
      expectStoreError(() => store.addWorkspace(workspace, candidate), code);
    }
  });

  it("loads version 1 snapshot rows as folder rows and rewrites version 2", () => {
    const filePath = storage();
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          [workspace]: {
            entries: [
              { path: folderA, readOnly: false, source: "folder", addedAt: 1 },
              { path: folderB, readOnly: true, source: "workspace", addedAt: 2 },
            ],
          },
        },
      }),
    );
    const store = new MultipleRootsStore({ filePath });
    expect(store.entriesFor(workspace).map((entry) => [entry.kind, entry.readOnly])).toEqual([
      ["folder", false],
      ["folder", true],
    ]);
    store.setReadOnly(workspace, "folder", folderA, true);
    const saved = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      workspaces: Record<string, { entries: { kind: string }[] }>;
    };
    expect(saved.version).toBe(2);
    expect(saved.workspaces[workspace]?.entries.every((entry) => entry.kind === "folder")).toBe(
      true,
    );
  });

  it("ignores an unsupported schema version with a warning", () => {
    const filePath = storage();
    writeFileSync(filePath, JSON.stringify({ version: 99, workspaces: {} }));
    const warnings: string[] = [];
    const store = new MultipleRootsStore({ filePath, warn: (message) => warnings.push(message) });
    expect(store.entriesFor(workspace)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("enforces the row limit", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    const rows = Array.from({ length: MAX_ENTRIES }, (_, index) => ({
      path: path.join(root, `bulk-${String(index)}`),
      readOnly: false,
    }));
    for (const row of rows) mkdirSync(row.path, { recursive: true });
    try {
      store.addEntries(workspace, rows);
      expect(store.entriesFor(workspace)).toHaveLength(MAX_ENTRIES);
      const extra = path.join(root, "bulk-extra");
      mkdirSync(extra);
      expectStoreError(() => store.addFolder(workspace, extra), "limit");
    } finally {
      for (const row of rows) rmSync(row.path, { recursive: true, force: true });
    }
  });

  it("reports a malformed file and starts empty", () => {
    const filePath = storage();
    writeFileSync(filePath, "{not json");
    const warnings: string[] = [];
    const store = new MultipleRootsStore({
      filePath,
      warn: (message) => warnings.push(message),
    });
    expect(store.entriesFor(workspace)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("skips malformed stored rows but keeps valid ones", () => {
    const filePath = storage();
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        workspaces: {
          [workspace]: {
            entries: [{ path: 7 }, { path: folderA, kind: "folder" }],
          },
        },
      }),
    );
    const store = new MultipleRootsStore({ filePath });
    expect(store.entriesFor(workspace).map((entry) => entry.path)).toEqual([folderA]);
  });
});
