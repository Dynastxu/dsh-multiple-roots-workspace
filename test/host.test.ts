import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_ENTRIES,
  findReadOnlyViolation,
  makeEntry,
  mergeEntries,
  parseToolTargets,
  renderContext,
} from "../src/entries";
import type { Entry } from "../src/entries";
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

describe("renderContext", () => {
  it("contributes nothing without rows", () => {
    expect(renderContext([])).toBe("");
  });

  it("lists paths and marks read-only rows", () => {
    const text = renderContext([makeEntry(folderA, { readOnly: true }), makeEntry(folderB)]);
    expect(text).toMatch(new RegExp(escape(folderA)));
    expect(text).toMatch(/\(read-only\)/u);
    expect(text).not.toMatch(new RegExp(`${escape(folderB)} \\(read-only\\)`));
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
  const entries = (): Entry[] => [makeEntry(folderA, { readOnly: true }), makeEntry(folderB)];

  it("denies a write inside the read-only row", () => {
    const result = findReadOnlyViolation(
      "write",
      { file_path: path.join(folderA, "x.txt") },
      workspace,
      entries(),
    );
    expect(result?.root).toBe(folderA);
  });

  it("allows writable rows and paths outside every attached row", () => {
    expect(
      findReadOnlyViolation(
        "write",
        { file_path: path.join(folderB, "x.txt") },
        workspace,
        entries(),
      ),
    ).toBeUndefined();
    expect(
      findReadOnlyViolation(
        "write",
        { file_path: path.join(root, "elsewhere.txt") },
        workspace,
        entries(),
      ),
    ).toBeUndefined();
  });

  it("resolves relative targets against the Session cwd", () => {
    expect(
      findReadOnlyViolation("edit", { file_path: "../alpha/x.txt" }, workspace, entries())?.root,
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
    expect(findReadOnlyViolation("apply_patch", { input: patch }, workspace, entries())?.root).toBe(
      folderA,
    );
  });

  it("does nothing without read-only rows", () => {
    expect(
      findReadOnlyViolation("write", { file_path: path.join(folderA, "x") }, workspace, [
        makeEntry(folderA),
      ]),
    ).toBeUndefined();
  });
});

describe("mergeEntries", () => {
  it("keeps the first occurrence and ignores duplicates", () => {
    const merged = mergeEntries(
      [makeEntry(folderA, { readOnly: true })],
      [makeEntry(folderA), makeEntry(folderB)],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.readOnly).toBe(true);
  });
});

describe("MultipleRootsStore", () => {
  it("persists attached folders across reloads", () => {
    const filePath = storage();
    const store = new MultipleRootsStore({ filePath });
    const entries = store.addFolder(workspace, folderA);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(folderA);
    const again = new MultipleRootsStore({ filePath });
    expect(again.entriesFor(workspace).map((entry) => entry.path)).toEqual([folderA]);
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
    }
  });

  it("toggles read-only, persists it, and removes rows", () => {
    const filePath = storage();
    const store = new MultipleRootsStore({ filePath });
    store.addFolder(workspace, folderA);
    const updated = store.setReadOnly(workspace, folderA, true);
    expect(updated[0]?.readOnly).toBe(true);
    expect(new MultipleRootsStore({ filePath }).entriesFor(workspace)[0]?.readOnly).toBe(true);
    expectStoreError(() => store.setReadOnly(workspace, folderB, true), "unknown-entry");
    expect(store.remove(workspace, folderA)).toHaveLength(0);
    expect(store.remove(workspace, folderA)).toHaveLength(0);
  });

  it("merges another workspace's rows without duplicating or attaching the target itself", () => {
    const store = new MultipleRootsStore({ filePath: storage() });
    store.addFolder(workspace, folderA);
    const entries = store.addEntries(workspace, [
      { path: workspace },
      { path: folderA },
      { path: folderB, readOnly: true, source: "workspace" },
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([folderA, folderB]);
    expect(entries[1]?.readOnly).toBe(true);
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
        version: 1,
        workspaces: {
          [workspace]: {
            entries: [{ path: folderA }, { path: "relative" }, null],
          },
        },
      }),
    );
    const store = new MultipleRootsStore({ filePath });
    expect(store.entriesFor(workspace).map((entry) => entry.path)).toEqual([folderA]);
  });

  it("writes a readable file with one trailing newline", () => {
    const filePath = storage();
    new MultipleRootsStore({ filePath }).addFolder(workspace, folderA);
    const text = readFileSync(filePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).version).toBe(1);
  });
});
