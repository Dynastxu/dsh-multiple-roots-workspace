/**
 * dsh-multiple-roots-workspace — browser half.
 *
 * One entry in the Workspace "..." menu opens a dialog listing the workspace
 * root plus every attached folder. Each attached row carries a read-only
 * switch and a remove button; the footer offers "Add folder" and
 * "Add workspace" (the latter attaches that workspace's root together with all
 * of its attached folders).
 *
 * Compiled by Vite into the single-file dynamic module the Web shell loads.
 * React and react-dom arrive through the loader's `require`, never as ESM
 * imports, so the emitted file has no module-table requests of its own.
 */

import type * as ReactNamespace from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

declare global {
  interface Window {
    __ModuleLoader__: {
      load(spec: {
        readonly id: string;
        readonly factory: (require: (id: string) => unknown) => unknown;
      }): void;
    };
  }
}

type ReactAPI = typeof ReactNamespace;
type ReactDOMAPI = typeof import("react-dom");
type Translate = (key: string) => string;
type LocaleDict = Record<string, string>;

const PACKAGE_ID = "@dynastxu/dsh-multiple-roots-workspace";
const NS = "multiple-roots";

/** One expanded directory inside an attached workspace. */
interface EntryDir {
  readonly path: string;
  readonly readOnly: boolean;
  readonly exists: boolean;
  readonly overridden: boolean;
}

/** One attached row as the Host projects it. */
interface Entry {
  readonly kind: "folder" | "workspace";
  readonly path: string;
  readonly readOnly: boolean;
  readonly exists: boolean;
  readonly missing: number;
  readonly dirs?: readonly EntryDir[];
}

/** One registered Workspace offered by the picker. */
interface WorkspaceOption {
  readonly path: string;
  readonly title: string;
}

/** The dialog's open request. */
interface RequestState {
  readonly path: string;
  readonly displayTitle: string;
}

/** The minimal observable source the overlay hook binds. */
interface RequestStore {
  getSnapshot(): RequestState | null;
  subscribe(listener: () => void): () => void;
  set(next: RequestState | null): void;
}

/** One menu action. */
interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

/** Props the overlay slot hands the dialog entry. */
interface DialogProps {
  readonly useRequest: <T>(selector: (value: RequestState | null) => T) => T;
  readonly close: () => void;
  readonly pick: () => Promise<string | null>;
  readonly t: Translate;
}

/** Props of the mounted dialog body. */
interface DialogBodyProps extends Omit<DialogProps, "useRequest"> {
  readonly request: RequestState;
}

/** The Cordis surface the Client half receives. */
interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): unknown;
  locale: {
    register(namespace: string, dictionaries: Record<string, LocaleDict>): () => void;
    bind(namespace: string): Translate;
  };
  contextMenus: {
    register(contribution: {
      readonly id: string;
      readonly target: "workspace";
      readonly order: number;
      readonly resolve: (
        target: {
          readonly workspaceId: string;
          readonly path: string;
          readonly displayTitle: string;
        },
        signal: AbortSignal,
      ) => readonly MenuAction[];
    }): () => void;
  };
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(
      options: {
        readonly name: string;
        readonly id: string;
        readonly locale?: string;
        readonly inject?: () => unknown;
      },
      component: ComponentType<DialogProps>,
    ): unknown;
  };
  uiWorkspace: {
    pickDirectory(): Promise<string | null>;
  };
}

/** The shape every JSON route answers with. */
interface ApiResponse {
  readonly ok: true;
  readonly entries?: unknown;
  readonly workspaces?: unknown;
}

const zh: LocaleDict = {
  "menu.open": "附加文件夹…",
  title: "附加文件夹",
  close: "关闭",
  description:
    "附加到当前工作区的其他目录。可写目录会授予本工作区的会话写权限；只读目录只允许读取。附加的工作区按它当前列表实时展开。",
  primary: "主工作区",
  readOnly: "只读",
  remove: "移除",
  add: "添加",
  addFolder: "添加文件夹",
  addWorkspace: "添加工作区",
  empty: "还没有附加文件夹。",
  loading: "加载中…",
  back: "返回",
  workspacesTitle: "选择工作区",
  workspacesHint: "添加后记录该工作区，注入与授权按它当前的附加列表实时展开。",
  workspacesEmpty: "没有其他工作区。",
  sourceWorkspace: "工作区",
  sourceFolder: "文件夹",
  missing: "不存在",
  partialMissing: "部分不存在",
  detail: "明细",
  detailHide: "收起",
  dirsTitle: "展开的目录",
  follow: "跟随",
  workspaceRoot: "工作区根目录",
};

const en: LocaleDict = {
  "menu.open": "Attached folders…",
  title: "Attached folders",
  close: "Close",
  description:
    "Extra directories attached to this workspace. Writable folders let its sessions write there; read-only folders stay readable only. An attached workspace is expanded live from its own list.",
  primary: "Primary",
  readOnly: "Read-only",
  remove: "Remove",
  add: "Add",
  addFolder: "Add folder",
  addWorkspace: "Add workspace",
  empty: "No attached folders yet.",
  loading: "Loading…",
  back: "Back",
  workspacesTitle: "Choose a workspace",
  workspacesHint:
    "Records that workspace and expands its current attached list live for injection and grants.",
  workspacesEmpty: "No other workspaces.",
  sourceWorkspace: "Workspace",
  sourceFolder: "Folder",
  missing: "Missing",
  partialMissing: "Partly missing",
  detail: "Details",
  detailHide: "Hide",
  dirsTitle: "Expanded directories",
  follow: "Follow",
  workspaceRoot: "Workspace root",
};

const STYLES = `
  .mr-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; pointer-events: auto; }
  .mr-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
  .mr-dialog { position: relative; z-index: 1; display: flex; flex-direction: column; box-sizing: border-box; width: min(520px, 100%); max-height: 100%; overflow: hidden; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); }
  .mr-dialog:focus { outline: none; }
  .mr-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 20px 14px 10px 24px; }
  .mr-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
  .mr-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
  .mr-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .mr-body { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 0 24px 16px; overflow: auto; }
  .mr-description { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
  .mr-list { display: flex; flex-direction: column; gap: 6px; }
  .mr-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
  .mr-row-primary { background: transparent; border: 0.5px solid var(--dsw-alias-border-l3); }
  .mr-icon { flex: none; color: var(--dsw-alias-label-secondary); }
  .mr-info { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 1px; }
  .mr-name { font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mr-path { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mr-badge { flex: none; font-size: 12px; line-height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
  .mr-toggle { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
  .mr-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
  .mr-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
  .mr-switch:disabled { cursor: default; opacity: 0.5; }
  .mr-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
  .mr-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
  .mr-switch[aria-checked='false'] .mr-thumb { background: var(--dsw-alias-switch-thumb); }
  .mr-switch[aria-checked='true'] .mr-thumb { transform: translateX(16px); }
  .mr-delete { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
  .mr-delete:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-danger-primary); }
  .mr-empty { padding: 18px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
  .mr-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 24px 20px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
  .mr-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md); font-size: 14px; line-height: 22px; cursor: pointer; color: var(--dsw-alias-label-primary); background: transparent; }
  .mr-button:disabled { cursor: not-allowed; opacity: 0.4; }
  .mr-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .mr-button-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
  .mr-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .mr-error { margin: 0 24px 8px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-danger-primary); font-size: 12px; line-height: 18px; }
  .mr-workspace-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
  .mr-status { flex: none; font-size: 12px; line-height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-state-danger-primary); background: var(--dsw-alias-bg-layer-1); }
  .mr-status-warn { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
  .mr-link { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: pointer; }
  .mr-link:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .mr-detail { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px 26px; padding: 6px 8px; border-left: 2px solid var(--dsw-alias-border-l3); }
  .mr-detail-title { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
  .mr-dir { display: flex; align-items: center; gap: 8px; min-height: 30px; }
  .mr-dir-info { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .mr-dir-path { font-size: 12px; line-height: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 560px) {
    .mr-root { padding: 12px; }
    .mr-header { padding: 16px 12px 8px 16px; }
    .mr-body { padding: 0 16px 12px; }
    .mr-footer { padding: 10px 16px 16px; }
    .mr-error { margin: 0 16px 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mr-thumb { transition: none; }
  }
`;

/** A minimal observable source for the overlay's request hook. */
function createRequestStore(initial: RequestState | null): RequestStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: RequestState | null) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate one expanded directory from the Host. */
function isEntryDir(value: unknown): value is EntryDir {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.readOnly === "boolean" &&
    typeof value.exists === "boolean" &&
    typeof value.overridden === "boolean"
  );
}

/** Validate one projected row from the Host. */
function isEntry(value: unknown): value is Entry {
  if (!isRecord(value)) return false;
  if (
    typeof value.path !== "string" ||
    typeof value.readOnly !== "boolean" ||
    typeof value.exists !== "boolean" ||
    typeof value.missing !== "number" ||
    (value.kind !== "folder" && value.kind !== "workspace")
  ) {
    return false;
  }
  if (value.kind === "workspace" && value.dirs !== undefined) {
    if (!Array.isArray(value.dirs) || !value.dirs.every(isEntryDir)) return false;
  }
  return true;
}

/** Validate one workspace option from the Host. */
function isWorkspaceOption(value: unknown): value is WorkspaceOption {
  if (!isRecord(value)) return false;
  return typeof value.path === "string" && typeof value.title === "string";
}

/** Describe one thrown value for the dialog. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether two workspace paths name the same row. */
function samePath(left: string, right: string): boolean {
  return left === right;
}

/** The final path segment, used as a row label. */
function folderName(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? value;
}

/** Resolve a route relative to the page, so a mount prefix keeps working. */
function apiPath(relative: string): string {
  try {
    if (typeof document === "undefined" || !document.baseURI) return `/${relative}`;
    const url = new URL(relative, document.baseURI);
    return `${url.pathname}${url.search}`;
  } catch {
    return `/${relative}`;
  }
}

/** Read one successful JSON response, translating failures to thrown errors. */
async function readResponse(response: Response): Promise<ApiResponse> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Request failed with HTTP ${String(response.status)}.`);
  }
  if (!isRecord(data) || data.ok !== true) {
    const message =
      isRecord(data) && typeof data.error === "string"
        ? data.error
        : `Request failed with HTTP ${String(response.status)}.`;
    throw new Error(message);
  }
  return {
    ok: true,
    ...(Array.isArray(data.entries) ? { entries: data.entries } : {}),
    ...(Array.isArray(data.workspaces) ? { workspaces: data.workspaces } : {}),
  };
}

/** One GET against a plugin route. */
async function getJson(relative: string, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetch(apiPath(relative), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  return readResponse(response);
}

/** One POST against a plugin route. */
async function postJson(relative: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const response = await fetch(apiPath(relative), {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    const React = require("react") as ReactAPI;
    const { createPortal } = require("react-dom") as ReactDOMAPI;
    const createElement = React.createElement;

    /** The host's closed-folder glyph, copied so the dialog matches workspace rows. */
    function IconFolder(): ReactElement {
      return createElement(
        "svg",
        {
          className: "mr-icon",
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "none",
          strokeWidth: 1,
          "aria-hidden": true,
        },
        createElement("path", {
          d: "M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z",
          stroke: "currentColor",
        }),
        createElement("path", {
          d: "M3.63501 7.66614H12.3647",
          stroke: "currentColor",
        }),
      );
    }

    function IconClose(): ReactElement {
      return createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          "aria-hidden": true,
        },
        createElement("path", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          d: "M3.5 3.5l9 9M12.5 3.5l-9 9",
        }),
      );
    }

    function IconTrash(): ReactElement {
      return createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 15,
          height: 15,
          "aria-hidden": true,
        },
        createElement("path", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          d: "M2.5 4.5h11M6 4.5V3.2c0-.39.32-.7.7-.7h2.6c.39 0 .7.31.7.7v1.3M4 4.5l.6 8.1c.03.45.4.8.85.8h5.1c.45 0 .82-.35.85-.8L12 4.5M6.6 7v4M9.4 7v4",
        }),
      );
    }

    function IconPlus(): ReactElement {
      return createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          "aria-hidden": true,
        },
        createElement("path", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          d: "M8 3.5v9M3.5 8h9",
        }),
      );
    }

    function IconArrowLeft(): ReactElement {
      return createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          "aria-hidden": true,
        },
        createElement("path", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          d: "M9.5 3.5L5 8l4.5 4.5",
        }),
      );
    }

    /** One row's read-only switch. */
    function Switch(props: {
      readonly checked: boolean;
      readonly disabled: boolean;
      readonly label: string;
      readonly onChange: (next: boolean) => void;
    }): ReactElement {
      return createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": props.checked,
          "aria-label": props.label,
          className: "mr-switch",
          disabled: props.disabled,
          onClick: () => {
            props.onChange(!props.checked);
          },
        },
        createElement("span", { className: "mr-thumb" }),
      );
    }

    /** One directory inside an attached workspace, with its own switch. */
    function DirRow(props: {
      readonly dir: EntryDir;
      readonly disabled: boolean;
      readonly t: Translate;
      readonly onOverride: (dir: EntryDir, readOnly: boolean | null) => void;
    }): ReactElement {
      const { dir, disabled, t } = props;
      const name = folderName(dir.path);
      return createElement(
        "div",
        { className: "mr-dir" },
        createElement(
          "div",
          { className: "mr-dir-info" },
          createElement("span", { className: "mr-dir-path", title: dir.path }, name),
        ),
        !dir.exists && createElement("span", { className: "mr-status" }, t("missing")),
        dir.overridden &&
          createElement(
            "button",
            {
              type: "button",
              className: "mr-link",
              title: t("follow"),
              disabled,
              onClick: () => {
                props.onOverride(dir, null);
              },
            },
            t("follow"),
          ),
        createElement(
          "span",
          { className: "mr-toggle", title: t("readOnly") },
          createElement(Switch, {
            checked: dir.readOnly,
            disabled,
            label: `${t("readOnly")}: ${dir.path}`,
            onChange: (next) => {
              props.onOverride(dir, next);
            },
          }),
        ),
      );
    }

    /** One attached row: a folder, or a workspace that expands live. */
    function EntryRow(props: {
      readonly entry: Entry;
      readonly disabled: boolean;
      readonly expanded: boolean;
      readonly t: Translate;
      readonly onToggle: (entry: Entry, readOnly: boolean) => void;
      readonly onToggleDetail: (entry: Entry) => void;
      readonly onOverride: (entry: Entry, dir: EntryDir, readOnly: boolean | null) => void;
      readonly onRemove: (entry: Entry) => void;
    }): ReactElement {
      const { entry, disabled, expanded, t } = props;
      const name = folderName(entry.path);
      const status = !entry.exists
        ? t("missing")
        : entry.kind === "workspace" && entry.missing > 0
          ? `${t("partialMissing")} (${String(entry.missing)})`
          : null;
      return createElement(
        React.Fragment,
        null,
        createElement(
          "div",
          { className: "mr-row" },
          IconFolder(),
          createElement(
            "div",
            { className: "mr-info" },
            createElement("span", { className: "mr-name", title: entry.path }, name),
            createElement("span", { className: "mr-path", title: entry.path }, entry.path),
          ),
          createElement(
            "span",
            { className: "mr-badge" },
            entry.kind === "workspace" ? t("sourceWorkspace") : t("sourceFolder"),
          ),
          status !== null &&
            createElement(
              "span",
              {
                className: entry.exists ? "mr-status mr-status-warn" : "mr-status",
                title: status,
              },
              status,
            ),
          entry.kind === "workspace" &&
            createElement(
              "button",
              {
                type: "button",
                className: "mr-link",
                "aria-expanded": expanded,
                disabled,
                onClick: () => {
                  props.onToggleDetail(entry);
                },
              },
              expanded ? t("detailHide") : t("detail"),
            ),
          createElement(
            "span",
            { className: "mr-toggle", title: t("readOnly") },
            createElement("span", null, t("readOnly")),
            createElement(Switch, {
              checked: entry.readOnly,
              disabled,
              label: `${t("readOnly")}: ${entry.path}`,
              onChange: (next) => {
                props.onToggle(entry, next);
              },
            }),
          ),
          createElement(
            "button",
            {
              type: "button",
              className: "mr-delete",
              "aria-label": `${t("remove")}: ${entry.path}`,
              title: t("remove"),
              disabled,
              onClick: () => {
                props.onRemove(entry);
              },
            },
            IconTrash(),
          ),
        ),
        entry.kind === "workspace" &&
          expanded &&
          createElement(
            "div",
            { className: "mr-detail" },
            createElement("span", { className: "mr-detail-title" }, t("dirsTitle")),
            ...(entry.dirs ?? []).map((dir) =>
              createElement(DirRow, {
                key: dir.path,
                dir,
                disabled,
                t,
                onOverride: (row: EntryDir, readOnly: boolean | null) => {
                  props.onOverride(entry, row, readOnly);
                },
              }),
            ),
            (entry.dirs ?? []).length === 0 &&
              createElement("span", { className: "mr-dir-path" }, t("empty")),
          ),
      );
    }

    /** One workspace option in the "add workspace" view. */
    function WorkspaceOptionRow(props: {
      readonly workspace: WorkspaceOption;
      readonly disabled: boolean;
      readonly t: Translate;
      readonly onAdd: (workspace: WorkspaceOption) => void;
    }): ReactElement {
      const { workspace, disabled, t } = props;
      return createElement(
        "div",
        { className: "mr-workspace-row" },
        IconFolder(),
        createElement(
          "div",
          { className: "mr-info" },
          createElement(
            "span",
            { className: "mr-name", title: workspace.path },
            workspace.title || folderName(workspace.path),
          ),
          createElement("span", { className: "mr-path", title: workspace.path }, workspace.path),
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "mr-button",
            disabled,
            onClick: () => {
              props.onAdd(workspace);
            },
          },
          IconPlus(),
          t("add"),
        ),
      );
    }

    /** The dialog body; mounted per open request. */
    function DialogBody(props: DialogBodyProps): ReactElement {
      const { request, close, pick, t } = props;
      const [entries, setEntries] = React.useState<Entry[]>([]);
      const [loading, setLoading] = React.useState<boolean>(true);
      const [error, setError] = React.useState<string | null>(null);
      const [busy, setBusy] = React.useState<boolean>(false);
      const [view, setView] = React.useState<"list" | "workspaces">("list");
      const [expanded, setExpanded] = React.useState<string | null>(null);
      const [workspaces, setWorkspaces] = React.useState<WorkspaceOption[]>([]);
      const [workspacesLoading, setWorkspacesLoading] = React.useState<boolean>(false);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      const dialogRef = React.useRef<HTMLDivElement | null>(null);
      const restoreRef = React.useRef<Element | null>(null);
      const workspacePath = request.path;

      React.useEffect(() => {
        restoreRef.current = document.activeElement;
        closeRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent): void => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const root = dialogRef.current;
          if (root === null) return;
          const focusable = Array.from(
            root.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (first === undefined || last === undefined) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("keydown", onKeyDown);
          const previous = restoreRef.current;
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
      }, [close]);

      React.useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        getJson(
          `dsh-multiple-roots-workspace/state?workspacePath=${encodeURIComponent(workspacePath)}`,
          controller.signal,
        )
          .then((data) => {
            if (controller.signal.aborted) return;
            setEntries(Array.isArray(data.entries) ? data.entries.filter(isEntry) : []);
          })
          .catch((reason: unknown) => {
            if (!controller.signal.aborted) setError(messageOf(reason));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
        return () => {
          controller.abort();
        };
      }, [workspacePath]);

      const run = async (action: () => Promise<ApiResponse>): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
          const data = await action();
          if (Array.isArray(data.entries)) setEntries(data.entries.filter(isEntry));
          return true;
        } catch (reason) {
          setError(messageOf(reason));
          return false;
        } finally {
          setBusy(false);
        }
      };

      const addFolder = async (): Promise<void> => {
        if (busy) return;
        let picked: string | null;
        setBusy(true);
        setError(null);
        try {
          picked = await pick();
        } catch (reason) {
          setError(messageOf(reason));
          return;
        } finally {
          setBusy(false);
        }
        if (picked === null) return;
        await run(() =>
          postJson("dsh-multiple-roots-workspace/add-folder", {
            workspacePath,
            path: picked,
          }),
        );
      };

      const openWorkspaces = async (): Promise<void> => {
        setView("workspaces");
        setError(null);
        setWorkspacesLoading(true);
        try {
          const data = await getJson("dsh-multiple-roots-workspace/workspaces");
          const rows = Array.isArray(data.workspaces)
            ? data.workspaces.filter(isWorkspaceOption)
            : [];
          setWorkspaces(rows.filter((row) => !samePath(row.path, workspacePath)));
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setWorkspacesLoading(false);
        }
      };

      const addWorkspace = async (workspace: WorkspaceOption): Promise<void> => {
        const ok = await run(() =>
          postJson("dsh-multiple-roots-workspace/add-workspace", {
            workspacePath,
            sourceWorkspacePath: workspace.path,
          }),
        );
        if (ok) setView("list");
      };

      const toggleReadOnly = (entry: Entry, readOnly: boolean): void => {
        void run(() =>
          postJson("dsh-multiple-roots-workspace/read-only", {
            workspacePath,
            kind: entry.kind,
            path: entry.path,
            readOnly,
          }),
        );
      };

      const overrideDir = (entry: Entry, dir: EntryDir, readOnly: boolean | null): void => {
        void run(() =>
          postJson("dsh-multiple-roots-workspace/overrides", {
            workspacePath,
            path: entry.path,
            dirPath: dir.path,
            readOnly,
          }),
        );
      };

      const removeEntry = (entry: Entry): void => {
        void run(() =>
          postJson("dsh-multiple-roots-workspace/remove", {
            workspacePath,
            kind: entry.kind,
            path: entry.path,
          }),
        );
      };

      const primaryName = request.displayTitle || folderName(workspacePath);
      const body: ReactNode =
        view === "workspaces"
          ? createElement(
              React.Fragment,
              null,
              createElement("p", { className: "mr-description" }, t("workspacesHint")),
              workspacesLoading
                ? createElement("div", { className: "mr-empty" }, t("loading"))
                : workspaces.length === 0
                  ? createElement("div", { className: "mr-empty" }, t("workspacesEmpty"))
                  : createElement(
                      "div",
                      { className: "mr-list" },
                      workspaces.map((workspace) =>
                        createElement(WorkspaceOptionRow, {
                          key: workspace.path,
                          workspace,
                          disabled: busy,
                          t,
                          onAdd: (row: WorkspaceOption) => {
                            void addWorkspace(row);
                          },
                        }),
                      ),
                    ),
            )
          : createElement(
              React.Fragment,
              null,
              createElement("p", { className: "mr-description" }, t("description")),
              loading
                ? createElement("div", { className: "mr-empty" }, t("loading"))
                : createElement(
                    React.Fragment,
                    null,
                    createElement(
                      "div",
                      { className: "mr-list" },
                      createElement(
                        "div",
                        { className: "mr-row mr-row-primary" },
                        IconFolder(),
                        createElement(
                          "div",
                          { className: "mr-info" },
                          createElement("span", { className: "mr-name" }, primaryName),
                          createElement(
                            "span",
                            { className: "mr-path", title: workspacePath },
                            workspacePath,
                          ),
                        ),
                        createElement("span", { className: "mr-badge" }, t("primary")),
                      ),
                      entries.map((entry) =>
                        createElement(EntryRow, {
                          key: `${entry.kind}:${entry.path}`,
                          entry,
                          expanded: expanded === `${entry.kind}:${entry.path}`,
                          disabled: busy,
                          t,
                          onToggle: toggleReadOnly,
                          onToggleDetail: (row: Entry) => {
                            const key = `${row.kind}:${row.path}`;
                            setExpanded((current) => (current === key ? null : key));
                          },
                          onOverride: overrideDir,
                          onRemove: removeEntry,
                        }),
                      ),
                    ),
                    entries.length === 0 &&
                      createElement("div", { className: "mr-empty" }, t("empty")),
                  ),
            );

      return createPortal(
        createElement(
          "div",
          { className: "mr-root", role: "presentation" },
          createElement("div", {
            className: "mr-mask",
            "aria-hidden": true,
            onMouseDown: close,
          }),
          createElement(
            "div",
            {
              ref: dialogRef,
              className: "mr-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": view === "workspaces" ? t("workspacesTitle") : t("title"),
              tabIndex: -1,
            },
            createElement(
              "div",
              { className: "mr-header" },
              createElement(
                "h2",
                { className: "mr-title" },
                view === "workspaces" ? t("workspacesTitle") : t("title"),
              ),
              createElement(
                "button",
                {
                  ref: closeRef,
                  type: "button",
                  className: "mr-close",
                  "aria-label": t("close"),
                  title: t("close"),
                  onClick: close,
                },
                IconClose(),
              ),
            ),
            createElement("div", { className: "mr-body" }, body),
            error !== null && createElement("div", { className: "mr-error", role: "alert" }, error),
            createElement(
              "div",
              { className: "mr-footer" },
              view === "workspaces"
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className: "mr-button",
                      onClick: () => {
                        setView("list");
                        setError(null);
                      },
                    },
                    IconArrowLeft(),
                    t("back"),
                  )
                : createElement(
                    React.Fragment,
                    null,
                    createElement(
                      "button",
                      {
                        type: "button",
                        className: "mr-button",
                        disabled: busy || loading,
                        onClick: () => {
                          void openWorkspaces();
                        },
                      },
                      IconPlus(),
                      t("addWorkspace"),
                    ),
                    createElement(
                      "button",
                      {
                        type: "button",
                        className: "mr-button mr-button-primary",
                        disabled: busy || loading,
                        onClick: () => {
                          void addFolder();
                        },
                      },
                      IconPlus(),
                      t("addFolder"),
                    ),
                  ),
            ),
          ),
        ),
        document.body,
      );
    }

    /** The overlay entry: holds the open request and mounts the body per request. */
    function Dialog(props: DialogProps): ReactElement | null {
      const request = props.useRequest((value) => value);
      if (request === null) return null;
      return createElement(DialogBody, {
        key: request.path,
        request,
        close: props.close,
        pick: props.pick,
        t: props.t,
      });
    }

    return {
      inject: ["contextMenus", "slots", "locale", "uiWorkspace"],
      apply(ctx: ClientContext): void {
        const request = createRequestStore(null);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "multiple-roots: copy");
        const t = ctx.locale.bind(NS);
        ctx.effect(() => {
          const tag = document.createElement("style");
          tag.dataset.plugin = "dsh-multiple-roots-workspace";
          tag.textContent = STYLES;
          document.head.append(tag);
          return () => {
            tag.remove();
          };
        }, "multiple-roots: styles");
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: "multiple-roots.open",
              target: "workspace",
              order: 150,
              resolve: (workspace, _signal) => [
                {
                  id: "open",
                  label: t("menu.open"),
                  run: () => {
                    request.set({
                      path: workspace.path,
                      displayTitle: workspace.displayTitle,
                    });
                  },
                },
              ],
            }),
          "multiple-roots: workspace menu entry",
        );
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "multiple-roots.dialog",
              locale: NS,
              inject: () => ({
                hooks: { request },
                close: () => {
                  request.set(null);
                },
                pick: () => ctx.uiWorkspace.pickDirectory(),
              }),
            },
            Dialog,
          ),
        );
      },
    };
  },
});
