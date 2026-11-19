import path from "node:path";
import fs from "node:fs";
import os from "node:os";
// src/paths.ts
/**
* Path identity shared by the store, the writable-root grants, and the
* read-only guard. Everything compares canonical (real-path) spellings so a
* symlinked spelling can never bypass containment.
*
* @module dsh-multiple-roots-workspace/paths
*/
/**
* Canonicalize an absolute path with symlinks resolved.
*
* A path whose tail does not exist yet resolves through its deepest existing
* ancestor, which is the identity a not-yet-created write target will have
* once it exists.
* @param value - candidate path; relative values are rejected.
* @returns the canonical path, or `undefined` when the input is not an absolute path string.
*/
function canonicalizePath(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed === "" || !path.isAbsolute(trimmed) || trimmed.includes("\0")) return void 0;
	const resolved = path.resolve(trimmed);
	try {
		return fs.realpathSync.native(resolved);
	} catch {}
	let current = resolved;
	const trailing = [];
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		trailing.unshift(path.basename(current));
		current = parent;
		try {
			return path.join(fs.realpathSync.native(current), ...trailing);
		} catch {}
	}
}
/**
* The comparison key for one path: case-folded on Windows, exact elsewhere.
* Both inputs must already be canonical.
* @param value - canonical path.
* @returns the comparison key.
*/
function pathKey(value) {
	return process.platform === "win32" ? value.toLowerCase() : value;
}
/**
* Whether `target` is `root` itself or below it.
* @param target - canonical path.
* @param root - canonical directory.
* @returns true when `target` is contained by `root`.
*/
function isSubPath(target, root) {
	const left = pathKey(target);
	const right = pathKey(root);
	if (left === right) return true;
	const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
	return left.startsWith(prefix);
}
// src/entries.ts
/**
* Pure entry operations and the model-facing text for attached folders.
* The store owns persistence; this module owns what a row means.
*
* @module dsh-multiple-roots-workspace/entries
*/
/**
* Build one normalized entry from a canonical directory path.
* @param canonical - canonical existing directory.
* @param options - row options.
* @returns the entry.
*/
function makeEntry(canonical, options = {}) {
	return {
		path: canonical,
		readOnly: options.readOnly === true,
		source: options.source === "workspace" ? "workspace" : "folder",
		addedAt: options.addedAt !== void 0 && Number.isFinite(options.addedAt) ? options.addedAt : Date.now()
	};
}
/**
* Validate and normalize a row read from disk. A stored directory that has
* since disappeared stays listed: the user must see it to remove it, and the
* grant attempt reports the failure on its own.
* @param raw - stored row.
* @returns the entry, or `undefined` when the row is malformed.
*/
function normalizeStoredEntry(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.path !== "string") return void 0;
	const canonical = canonicalizePath(candidate.path);
	if (canonical === void 0) return void 0;
	return makeEntry(canonical, {
		readOnly: candidate.readOnly === true,
		source: candidate.source === "workspace" ? "workspace" : "folder",
		addedAt: typeof candidate.addedAt === "number" ? candidate.addedAt : void 0
	});
}
/**
* Append rows that are not already present, keeping the first occurrence.
* @param existing - current rows.
* @param incoming - rows to add.
* @returns a new array.
*/
function mergeEntries(existing, incoming) {
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
function removeEntry(entries, target) {
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
function setEntryReadOnly(entries, target, readOnly) {
	const key = pathKey(target);
	let changed = false;
	return {
		entries: entries.map((entry) => {
			if (pathKey(entry.path) !== key) return entry;
			if (entry.readOnly === readOnly) return entry;
			changed = true;
			return {
				...entry,
				readOnly
			};
		}),
		changed
	};
}
/**
* Rows that receive a writable-root grant: everything the agent may modify.
* @param entries - attached rows.
* @returns canonical writable directories.
*/
function writablePaths(entries) {
	return entries.filter((entry) => !entry.readOnly).map((entry) => entry.path);
}
/**
* Render the runtime-context contribution. The agent loop projects this text
* into one durable snapshot per change; returning `''` contributes nothing, so
* a workspace without attached rows never injects the section.
* @param entries - attached rows.
* @returns the model-facing text, or an empty string.
*/
function renderContext(entries) {
	if (entries.length === 0) return "";
	return [
		"Attached workspace folders — additional directories attached to this workspace:",
		...entries.map((entry) => {
			const flags = entry.readOnly ? " (read-only)" : "";
			return `- ${entry.path}${flags}`;
		}),
		"Read files anywhere with absolute paths. Write only inside folders without \"(read-only)\": file tools reject writes inside a read-only folder."
	].join("\n");
}
/**
* Model-requested write targets for one tool call. Unknown tools and read-only
* operations (`view`, reads) return no targets.
* @param toolName - executed tool name.
* @param args - parsed tool arguments.
* @returns the path arguments as the model spelled them.
*/
function parseToolTargets(toolName, args) {
	if (args === null || typeof args !== "object") return [];
	const input = args;
	if (toolName === "write" || toolName === "edit") return typeof input.file_path === "string" ? [input.file_path] : [];
	if (toolName === "str_replace_editor") {
		if (input.command === "view") return [];
		return typeof input.path === "string" ? [input.path] : [];
	}
	if (toolName === "apply_patch") return typeof input.input === "string" ? patchPaths(input.input) : [];
	return [];
}
var PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u;
var PATCH_MOVE = /^\*\*\* Move to: (.+)$/u;
/**
* Paths named by patch headers (`*** Add File:`, `*** Update File:`,
* `*** Delete File:`, `*** Move to:`), matching the `apply_patch` parser's
* trimmed-line spelling.
* @param text - patch input.
* @returns named paths.
*/
function patchPaths(text) {
	const paths = [];
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		const candidate = (PATCH_HEADER.exec(line) ?? PATCH_MOVE.exec(line))?.[1]?.trim();
		if (candidate !== void 0 && candidate !== "") paths.push(candidate);
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
function findReadOnlyViolation(toolName, args, cwd, entries) {
	const readOnly = entries.filter((entry) => entry.readOnly);
	if (readOnly.length === 0) return void 0;
	for (const raw of parseToolTargets(toolName, args)) {
		const canonical = canonicalizePath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
		if (canonical === void 0) continue;
		const root = readOnly.find((entry) => isSubPath(canonical, entry.path));
		if (root !== void 0) return {
			target: raw,
			root: root.path
		};
	}
}
// src/store.ts
/**
* Durable per-workspace attached-folder lists.
*
* All mutations are synchronous, so two HTTP requests cannot interleave a
* read-modify-write inside one process. The file is replaced atomically through
* a temporary sibling, so a failed write never publishes partial state.
*
* @module dsh-multiple-roots-workspace/store
*/
/** Storage schema version written to disk. */
var STORAGE_VERSION = 1;
/** A rejected store operation carrying a stable code for the route layer. */
var MultipleRootsError = class extends Error {
	code;
	/**
	* @param code - stable machine code (`invalid-path`, `missing`, ...).
	* @param message - operator-facing explanation.
	*/
	constructor(code, message) {
		super(message);
		this.name = "MultipleRootsError";
		this.code = code;
	}
};
/**
* The default storage file under `$DSH_HOME/storages`.
* @returns absolute file path.
*/
function defaultStoragePath() {
	const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
	return path.join(home, "storages", "multiple-roots-workspace.json");
}
/** Empty domain state. */
function emptyData() {
	return {
		version: STORAGE_VERSION,
		workspaces: {}
	};
}
/** Whether a value is a non-array object. */
function isRecord(value) {
	return value !== null && typeof value === "object";
}
var MultipleRootsStore = class {
	filePath;
	warn;
	data;
	/**
	* @param options - storage file and warning sink.
	*/
	constructor(options = {}) {
		this.filePath = options.filePath ?? defaultStoragePath();
		this.warn = options.warn ?? (() => {});
		this.data = this.load();
	}
	/**
	* Attached rows for one workspace, in insertion order.
	* @param workspacePath - workspace directory (any spelling).
	* @returns a detached array; never throws.
	*/
	entriesFor(workspacePath) {
		const found = this.lookup(workspacePath);
		if (found === void 0 || found.key === void 0) return [];
		return this.data.workspaces[found.key]?.entries.map((entry) => ({ ...entry })) ?? [];
	}
	/**
	* Attach one existing directory.
	* @param workspacePath - owning workspace directory.
	* @param folderPath - directory to attach; any spelling of an existing directory.
	* @returns the complete row list.
	* @throws {MultipleRootsError} on invalid, missing, non-directory, primary, or over-limit input.
	*/
	addFolder(workspacePath, folderPath) {
		const workspace = this.requireWorkspace(workspacePath);
		const folder = this.requireDirectory(folderPath);
		if (pathKey(folder) === pathKey(workspace)) throw new MultipleRootsError("primary", "The workspace directory itself cannot be an attached folder.");
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
	addEntries(workspacePath, incoming) {
		const workspace = this.requireWorkspace(workspacePath);
		const key = pathKey(workspace);
		const rows = [];
		for (const raw of incoming) {
			const canonical = canonicalizePath(raw.path);
			if (canonical === void 0 || pathKey(canonical) === key) continue;
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
	setReadOnly(workspacePath, entryPath, readOnly) {
		const workspace = this.requireWorkspace(workspacePath);
		const current = this.entriesFor(workspace);
		const target = this.matchEntry(current, entryPath);
		if (target === void 0) throw new MultipleRootsError("unknown-entry", `No attached folder "${String(entryPath)}" in this workspace.`);
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
	remove(workspacePath, entryPath) {
		const workspace = this.requireWorkspace(workspacePath);
		const current = this.entriesFor(workspace);
		const target = this.matchEntry(current, entryPath);
		if (target === void 0) return current;
		return this.commit(workspace, removeEntry(current, target));
	}
	/** The workspace's canonical spelling, creating neither. */
	requireWorkspace(workspacePath) {
		const found = this.lookup(workspacePath);
		if (found !== void 0) return found.canonical;
		throw new MultipleRootsError("invalid-workspace", "A workspace path must be an absolute directory path.");
	}
	/** Canonical spelling plus the existing storage key, when one is stored. */
	lookup(workspacePath) {
		const canonical = canonicalizePath(workspacePath);
		if (canonical === void 0) return void 0;
		return {
			canonical,
			key: Object.keys(this.data.workspaces).find((candidate) => pathKey(candidate) === pathKey(canonical))
		};
	}
	/** Resolve and validate one attachable directory. */
	requireDirectory(folderPath) {
		const canonical = canonicalizePath(folderPath);
		if (canonical === void 0) throw new MultipleRootsError("invalid-path", "An attached folder must be an absolute directory path.");
		let stat;
		try {
			stat = fs.statSync(canonical);
		} catch {
			throw new MultipleRootsError("missing", `Directory does not exist: "${String(folderPath)}".`);
		}
		if (!stat.isDirectory()) throw new MultipleRootsError("not-directory", `Not a directory: "${String(folderPath)}".`);
		return canonical;
	}
	/** Match a row by canonical path, accepting either spelling. */
	matchEntry(entries, entryPath) {
		const canonical = canonicalizePath(entryPath);
		if (canonical === void 0) return void 0;
		return entries.find((entry) => pathKey(entry.path) === pathKey(canonical))?.path;
	}
	/** Persist a complete list and return it. */
	commit(workspace, entries) {
		if (entries.length > 64) throw new MultipleRootsError("limit", `At most 64 attached folders are supported per workspace.`);
		const found = this.lookup(workspace);
		/* v8 ignore next -- requireWorkspace already proved the path canonicalizes. */
		if (found === void 0) throw new MultipleRootsError("invalid-workspace", "Invalid workspace path.");
		const previous = this.data.workspaces[found.canonical];
		const staleKey = found.key !== void 0 && found.key !== found.canonical ? found.key : void 0;
		const stale = staleKey === void 0 ? void 0 : this.data.workspaces[staleKey];
		if (staleKey !== void 0) delete this.data.workspaces[staleKey];
		this.data.workspaces[found.canonical] = { entries };
		try {
			this.save();
		} catch (error) {
			if (staleKey !== void 0 && stale !== void 0) this.data.workspaces[staleKey] = stale;
			if (previous === void 0) delete this.data.workspaces[found.canonical];
			else this.data.workspaces[found.canonical] = previous;
			throw error;
		}
		return entries.map((entry) => ({ ...entry }));
	}
	/** Read the storage file, tolerating a missing file and reporting other damage. */
	load() {
		let text;
		try {
			text = fs.readFileSync(this.filePath, "utf8");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") this.warn(`multiple-roots: cannot read ${this.filePath}: ${String(error)}`);
			return emptyData();
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			this.warn(`multiple-roots: ignoring malformed ${this.filePath}: ${String(error)}`);
			return emptyData();
		}
		if (!isRecord(parsed)) return emptyData();
		const stored = parsed.workspaces;
		if (!isRecord(stored)) return emptyData();
		const workspaces = {};
		for (const [root, value] of Object.entries(stored)) {
			const canonicalRoot = canonicalizePath(root);
			if (canonicalRoot === void 0) continue;
			workspaces[canonicalRoot] = { entries: (isRecord(value) && Array.isArray(value.entries) ? value.entries : []).map(normalizeStoredEntry).filter((entry) => entry !== void 0) };
		}
		return {
			version: STORAGE_VERSION,
			workspaces
		};
	}
	/** Atomically replace the storage file. */
	save() {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
		fs.renameSync(temporary, this.filePath);
	}
};
// src/types.ts
/**
* Look a service up without tripping over an unloaded fiber.
* @param ctx - the current plugin or injected context.
* @param name - Cordis service name.
* @returns the service, or `undefined` when it is not mounted.
*/
function service(ctx, name) {
	const value = ctx.get(name);
	return value === void 0 || value === null ? void 0 : value;
}
// src/index.ts
/** Route prefix owned by this plugin. */
var PREFIX = "/dsh-multiple-roots-workspace";
var ROUTES = {
	state: `${PREFIX}/state`,
	workspaces: `${PREFIX}/workspaces`,
	addFolder: `${PREFIX}/add-folder`,
	addWorkspace: `${PREFIX}/add-workspace`,
	readOnly: `${PREFIX}/read-only`,
	remove: `${PREFIX}/remove`
};
var CONTEXT_NAME = "multiple-roots:folders";
var MAX_BODY_BYTES = 65536;
var MAX_WORKSPACE_LIST = 500;
/** Describe one thrown value for logs and route bodies. */
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Only a loopback Host may reach these routes; a rebinding page carries its own name. */
function isLoopbackHost(header) {
	if (typeof header !== "string" || header.length === 0) return false;
	const hostname = header.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "").toLowerCase();
	return hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/u.test(hostname);
}
/** Write one JSON response. */
function sendJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	response.end(body);
}
/** Read a bounded JSON object body. */
function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(/* @__PURE__ */ new Error("request body is too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
			} catch (error) {
				reject(/* @__PURE__ */ new Error(`invalid JSON body: ${describeError(error)}`));
			}
		});
		request.on("error", reject);
	});
}
/** Project rows to the small wire form the Client renders. */
function wireEntries(entries) {
	return entries.map((entry) => ({
		path: entry.path,
		readOnly: entry.readOnly,
		source: entry.source
	}));
}
/** The plugin entry point. */
function apply(ctx) {
	const warn = (message) => {
		try {
			ctx.logger.warn(message);
		} catch {}
	};
	const store = new MultipleRootsStore({ warn });
	/** sessionId -> pathKey -> grant */
	const grants = /* @__PURE__ */ new Map();
	/** sessionId -> canonical workspace directory */
	const sessionRoots = /* @__PURE__ */ new Map();
	/** Canonical workspace directory of one Session, cached for its lifetime. */
	const workspaceOf = (session) => {
		if (session === void 0) return void 0;
		const id = session.id;
		const cached = sessionRoots.get(id);
		if (cached !== void 0) return cached;
		const cwd = session.header.cwd;
		if (typeof cwd !== "string") return void 0;
		const canonical = canonicalizePath(cwd);
		if (canonical === void 0) return void 0;
		sessionRoots.set(id, canonical);
		return canonical;
	};
	/** Dispose every grant owned by one Session. */
	const dropSessionGrants = (id) => {
		const owned = grants.get(id);
		if (owned === void 0) return;
		for (const grant of owned.values()) try {
			grant.dispose();
		} catch {}
		grants.delete(id);
	};
	/**
	* Bring one Session's grants in line with its workspace's rows. Runs on each
	* pre-step, so resume, fork, and a plugin reload all converge without a
	* separate lifecycle registry.
	*/
	const syncSession = (session) => {
		const id = session.id;
		const workspace = workspaceOf(session);
		const desired = workspace === void 0 ? [] : writablePaths(store.entriesFor(workspace));
		if (desired.length === 0) {
			dropSessionGrants(id);
			return;
		}
		const policy = service(ctx, "sandboxPolicy");
		let owned = grants.get(id);
		if (owned === void 0) {
			owned = /* @__PURE__ */ new Map();
			grants.set(id, owned);
		}
		const wanted = new Set(desired.map((directory) => pathKey(directory)));
		for (const [key, grant] of owned) {
			if (wanted.has(key)) continue;
			try {
				grant.dispose();
			} catch {}
			owned.delete(key);
		}
		if (policy === void 0 || typeof policy.registerWritableRoot !== "function") return;
		for (const directory of desired) {
			const key = pathKey(directory);
			if (owned.has(key)) continue;
			try {
				owned.set(key, {
					path: directory,
					dispose: policy.registerWritableRoot(session, directory)
				});
			} catch (error) {
				warn(`multiple-roots: cannot grant "${directory}" to session "${id}": ${describeError(error)}`);
			}
		}
	};
	/** Apply a changed workspace to every live Session running in it. */
	const syncWorkspace = (workspace) => {
		const agents = service(ctx, "agents");
		if (agents === void 0 || typeof agents.list !== "function") return;
		const target = pathKey(workspace);
		for (const agent of agents.list()) {
			const root = workspaceOf(agent.session);
			if (root === void 0 || pathKey(root) !== target) continue;
			try {
				syncSession(agent.session);
			} catch (error) {
				warn(`multiple-roots: cannot sync session "${agent.session.id}": ${describeError(error)}`);
			}
		}
	};
	ctx.effect(() => () => {
		for (const id of grants.keys()) dropSessionGrants(id);
		sessionRoots.clear();
	}, "multiple-roots: grant teardown");
	ctx.effect(() => ctx.on("agent/pre-step", async ({ agent }, next) => {
		try {
			if (agent.session !== void 0) syncSession(agent.session);
		} catch (error) {
			warn(`multiple-roots: pre-step sync failed: ${describeError(error)}`);
		}
		return next();
	}), "multiple-roots: session grant admission");
	ctx.effect(() => ctx.on("session/disposed", (session) => {
		const id = session.id;
		dropSessionGrants(id);
		sessionRoots.delete(id);
	}, { global: true }), "multiple-roots: session teardown");
	ctx.inject(["agents"], (scope) => {
		const agents = service(scope, "agents");
		if (agents === void 0) return;
		for (const agent of agents.list()) try {
			syncSession(agent.session);
		} catch (error) {
			warn(`multiple-roots: initial sync failed: ${describeError(error)}`);
		}
	});
	ctx.inject(["tools"], (scope) => {
		const tools = service(scope, "tools");
		if (tools === void 0) return;
		scope.effect(() => tools.guard((execution) => {
			const session = execution.agent?.session;
			if (session === void 0) return void 0;
			const workspace = workspaceOf(session);
			if (workspace === void 0) return void 0;
			const entries = store.entriesFor(workspace);
			if (!entries.some((entry) => entry.readOnly)) return void 0;
			const workingDirectory = service(ctx, "workingDirectory");
			const cwd = (workingDirectory !== void 0 && typeof workingDirectory.get === "function" ? workingDirectory.get(session) : void 0) ?? (typeof session.header.cwd === "string" ? session.header.cwd : process.cwd());
			let violation;
			try {
				violation = findReadOnlyViolation(execution.name, execution.arguments, cwd, entries);
			} catch (error) {
				return `Blocked by multiple-roots: cannot verify "${execution.name}" against the read-only attached folders (${describeError(error)}).`;
			}
			if (violation === void 0) return void 0;
			return `Blocked by multiple-roots: "${violation.target}" is inside the read-only attached folder "${violation.root}". Write inside a writable folder instead, or turn off read-only for that folder in the workspace menu.`;
		}), "multiple-roots: read-only guard");
	});
	ctx.inject(["systemPrompt"], (scope) => {
		const systemPrompt = service(scope, "systemPrompt");
		if (systemPrompt === void 0) return;
		let order;
		try {
			order = systemPrompt.getContextOrder("SANDBOX_POLICY") + 1;
		} catch {
			order = 111;
		}
		scope.effect(() => systemPrompt.context({
			name: CONTEXT_NAME,
			order,
			interpolate: false,
			text: (assembly) => {
				try {
					const session = assembly.agent?.session;
					if (session === void 0) return "";
					const workspace = workspaceOf(session);
					if (workspace === void 0) return "";
					return renderContext(store.entriesFor(workspace));
				} catch {
					return "";
				}
			}
		}), "multiple-roots: runtime context");
	});
	/** Workspace rows as the registry sees them, or undefined when unavailable. */
	const registeredWorkspaces = () => {
		const registry = service(ctx, "workspaceRegistry");
		if (registry === void 0 || typeof registry.list !== "function") return void 0;
		try {
			return registry.list().slice(0, MAX_WORKSPACE_LIST).map((workspace) => ({
				path: workspace.path,
				title: workspace.title
			}));
		} catch (error) {
			warn(`multiple-roots: cannot list workspaces: ${describeError(error)}`);
			return;
		}
	};
	/** Whether the path names a registered workspace; permissive without a registry. */
	const isRegisteredWorkspace = (canonical) => {
		const rows = registeredWorkspaces();
		if (rows === void 0) return true;
		return rows.some((row) => pathKey(row.path) === pathKey(canonical));
	};
	/** The admission fence shared by every route. */
	const admit = (request, response) => {
		const connection = service(ctx, "connection");
		if (connection !== void 0 && typeof connection.requestRejection === "function") {
			let rejection;
			try {
				rejection = connection.requestRejection(request);
			} catch {
				rejection = 403;
			}
			if (rejection !== void 0) {
				sendJson(response, rejection, {
					ok: false,
					error: "Request was not admitted by this DSH client."
				});
				return false;
			}
		}
		if (!isLoopbackHost(request.headers.host)) {
			sendJson(response, 403, {
				ok: false,
				error: "These routes are available on loopback hosts only."
			});
			return false;
		}
		const site = request.headers["sec-fetch-site"];
		if (typeof site === "string" && site !== "same-origin" && site !== "none") {
			sendJson(response, 403, {
				ok: false,
				error: "Cross-site requests are not allowed."
			});
			return false;
		}
		return true;
	};
	/** Canonicalize and admit the workspace named by a route. */
	const requireTarget = (raw) => {
		const canonical = canonicalizePath(raw);
		if (canonical === void 0) throw new MultipleRootsError("invalid-workspace", "A workspace path must be absolute.");
		if (!isRegisteredWorkspace(canonical)) throw new MultipleRootsError("unknown-workspace", `Not a registered workspace: "${canonical}".`);
		return canonical;
	};
	/** Common mutation response: persist already happened, then grant fan-out. */
	const respondEntries = (response, workspace, entries) => {
		try {
			syncWorkspace(workspace);
		} catch (error) {
			warn(`multiple-roots: cannot sync live sessions: ${describeError(error)}`);
		}
		sendJson(response, 200, {
			ok: true,
			workspacePath: workspace,
			entries: wireEntries(entries)
		});
	};
	/** Map an operation error to its HTTP answer. */
	const fail = (response, error) => {
		if (error instanceof MultipleRootsError) {
			sendJson(response, 400, {
				ok: false,
				code: error.code,
				error: error.message
			});
			return;
		}
		sendJson(response, 500, {
			ok: false,
			error: describeError(error)
		});
	};
	ctx.inject(["webServer"], (scope) => {
		const webServer = service(scope, "webServer");
		if (webServer === void 0) return;
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.state,
			handler: (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "GET") {
					sendJson(response, 405, {
						ok: false,
						error: "GET only."
					});
					return;
				}
				try {
					const url = new URL(request.url ?? "/", "http://127.0.0.1");
					const workspace = requireTarget(url.searchParams.get("workspacePath"));
					sendJson(response, 200, {
						ok: true,
						workspacePath: workspace,
						entries: wireEntries(store.entriesFor(workspace))
					});
				} catch (error) {
					fail(response, error);
				}
			}
		}), "multiple-roots: state route");
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.workspaces,
			handler: (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "GET") {
					sendJson(response, 405, {
						ok: false,
						error: "GET only."
					});
					return;
				}
				const rows = registeredWorkspaces();
				if (rows === void 0) {
					sendJson(response, 503, {
						ok: false,
						error: "The workspace registry is unavailable in this profile."
					});
					return;
				}
				sendJson(response, 200, {
					ok: true,
					workspaces: rows
				});
			}
		}), "multiple-roots: workspaces route");
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.addFolder,
			handler: async (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "POST") {
					sendJson(response, 405, {
						ok: false,
						error: "POST only."
					});
					return;
				}
				try {
					const body = await readJsonBody(request);
					const workspace = requireTarget(body.workspacePath);
					const entries = store.addFolder(workspace, body.path);
					respondEntries(response, workspace, entries);
				} catch (error) {
					fail(response, error);
				}
			}
		}), "multiple-roots: add-folder route");
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.addWorkspace,
			handler: async (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "POST") {
					sendJson(response, 405, {
						ok: false,
						error: "POST only."
					});
					return;
				}
				try {
					const body = await readJsonBody(request);
					const workspace = requireTarget(body.workspacePath);
					const source = requireTarget(body.sourceWorkspacePath);
					if (pathKey(source) === pathKey(workspace)) throw new MultipleRootsError("primary", "A workspace cannot be attached to itself.");
					const inherited = store.entriesFor(source).map((entry) => ({
						...entry,
						source: "workspace"
					}));
					const entries = store.addEntries(workspace, [{
						path: source,
						readOnly: false,
						source: "workspace"
					}, ...inherited]);
					respondEntries(response, workspace, entries);
				} catch (error) {
					fail(response, error);
				}
			}
		}), "multiple-roots: add-workspace route");
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.readOnly,
			handler: async (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "POST") {
					sendJson(response, 405, {
						ok: false,
						error: "POST only."
					});
					return;
				}
				try {
					const body = await readJsonBody(request);
					if (typeof body.readOnly !== "boolean") throw new MultipleRootsError("invalid-body", "readOnly must be a boolean.");
					const workspace = requireTarget(body.workspacePath);
					const entries = store.setReadOnly(workspace, body.path, body.readOnly);
					respondEntries(response, workspace, entries);
				} catch (error) {
					fail(response, error);
				}
			}
		}), "multiple-roots: read-only route");
		scope.effect(() => webServer.register({
			kind: "exact",
			path: ROUTES.remove,
			handler: async (request, response) => {
				if (!admit(request, response)) return;
				if (request.method !== "POST") {
					sendJson(response, 405, {
						ok: false,
						error: "POST only."
					});
					return;
				}
				try {
					const body = await readJsonBody(request);
					const workspace = requireTarget(body.workspacePath);
					const entries = store.remove(workspace, body.path);
					respondEntries(response, workspace, entries);
				} catch (error) {
					fail(response, error);
				}
			}
		}), "multiple-roots: remove route");
	});
}
export { apply };
