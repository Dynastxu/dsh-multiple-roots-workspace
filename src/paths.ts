/**
 * Path identity shared by the store, the writable-root grants, and the
 * read-only guard. Everything compares canonical (real-path) spellings so a
 * symlinked spelling can never bypass containment.
 *
 * @module dsh-multiple-roots-workspace/paths
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Canonicalize an absolute path with symlinks resolved.
 *
 * A path whose tail does not exist yet resolves through its deepest existing
 * ancestor, which is the identity a not-yet-created write target will have
 * once it exists.
 * @param value - candidate path; relative values are rejected.
 * @returns the canonical path, or `undefined` when the input is not an absolute path string.
 */
export function canonicalizePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !path.isAbsolute(trimmed) || trimmed.includes("\0")) return undefined;
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Fall through: resolve the deepest existing ancestor, then re-append.
  }
  let current = resolved;
  const trailing: string[] = [];
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    trailing.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(fs.realpathSync.native(current), ...trailing);
    } catch {
      // Keep walking up; a fully missing chain stays at the lexical spelling.
    }
  }
}

/**
 * Whether a canonical path names a directory that exists right now.
 * @param value - canonical path.
 * @returns true when the path is an existing directory.
 */
export function isExistingDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The comparison key for one path: case-folded on Windows, exact elsewhere.
 * Both inputs must already be canonical.
 * @param value - canonical path.
 * @returns the comparison key.
 */
export function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Whether `target` is `root` itself or below it.
 * @param target - canonical path.
 * @param root - canonical directory.
 * @returns true when `target` is contained by `root`.
 */
export function isSubPath(target: string, root: string): boolean {
  const left = pathKey(target);
  const right = pathKey(root);
  if (left === right) return true;
  const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
  return left.startsWith(prefix);
}

/**
 * The final path segment, used as a row label.
 * @param value - path.
 * @returns the last segment, or the path itself at a filesystem root.
 */
export function folderName(value: string): string {
  return path.basename(value) || value;
}
