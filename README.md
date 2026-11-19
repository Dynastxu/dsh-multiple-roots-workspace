# Multiple-root workspace

A DeepSeek Harness bundle that attaches extra folders — or entire workspaces — to one workspace, with per-folder read-only control.

- **No new tools.** The agent keeps using the native `read` / `write` / `edit` / `apply_patch` / `bash` tools; the attached folders simply join the writable scope.
- **One workspace menu entry.** Open a workspace's `…` menu → **Attached folders…**.
- **Add folder or add workspace.** _Add folder_ picks any directory and stores one folder row. _Add workspace_ stores **one workspace row**: a live reference that contributes that workspace's root plus everything its own list contributes at that moment. Later changes in the referenced workspace are picked up without re-attaching.
- **Live expansion.** Every read (model context, grants, the read-only guard, the dialog) expands workspace rows again, with cycle detection, so `A → B → A` stays finite.
- **Missing directories are harmless.** A row whose directory disappeared stays listed and is marked **missing** in the dialog; injection and writable-root grants skip it, so the model is never told about a path that is not there and a stale grant can never fail the workspace's other writes. The row works again as soon as the directory comes back.
- **Read-only resolution.** A directory is read-only when a per-directory override says so; otherwise an explicit writable folder row for the same path wins; otherwise any read-only contribution wins (a folder row in an attached workspace, or a workspace row's blanket switch). The dialog's **Details** view exposes the expanded directories with their own switches (stored as overrides, with **Follow** to clear one).
- **Prompt only when needed.** The attached list reaches the model as runtime context that renders empty without existing directories. The agent loop commits one snapshot when the conversation first needs it and another only when the rendered list changes — no per-step duplicate.

## Install

From the DSH Plugins page: **Add plugin** → @dynastxu/dsh-multiple-roots-workspace.

Or from the bundled `dsh` CLI:

```sh
dsh plugin --profile desktop add @dynastxu/dsh-multiple-roots-workspace
```

A local-directory install links the checkout; restart DSH or reload the page after changing the Host or Client files.

## Requirements

- **DSH `>=0.2.2-rc.2`.** That is the first release containing `SandboxPolicyService.registerWritableRoot` (commit `f5dea38671`, 2026-10-26; first tagged in `dsh-v0.2.2-rc.2`). Earlier releases do not expose the session-scoped writable-root API the grants rely on. The other DSH APIs used here pre-date it: the context-menu service first shipped in `0.2.2-alpha.3`, and the shell overlay, directory picker, web-server routes, and workspace registry in `0.2.1-rc.2`. The declaration lives in `engines.dsh`, which the plugin manager evaluates before installing or starting the bundle.
- **Node `>=22.19`** for building and testing the sources; the installed bundle itself runs inside DSH's Node runtime.

## Usage

1. Hover a workspace row in the sidebar and open its `…` menu.
2. Choose **Attached folders…**.
3. Add folders or workspaces, toggle **Read-only** per row, open **Details** on a workspace row for per-directory switches, remove rows with the trash button.

Changes apply to the workspace's live Sessions immediately for grants; the model sees the updated list at its next request.

## Development

The bundle is authored in TypeScript and built with Vite into `lib/`: `lib/index.js` is the Host entry and `lib/client.js` the Client export the installed loader resolves.

```sh
pnpm run build        # Vite: lib/index.js (Host) + lib/client.js (Client)
pnpm run typecheck    # tsc --noEmit
pnpm run test         # Vitest (worker threads; the default fork pool is blocked by the DSH sandbox)
pnpm run lint         # oxlint
pnpm run format       # oxfmt for code/config, Prettier for README, locale JSON, and the patch
pnpm run format:check
pnpm run check        # typecheck + lint + format check + test + build
```

After changing `src/`, rerun `pnpm run build`, then restart the Host (or reload the page for Client-only changes).

## Storage

`$DSH_HOME/storages/multiple-roots-workspace.json`

```json
{
  "version": 2,
  "workspaces": {
    "<canonical workspace path>": {
      "entries": [
        {
          "kind": "folder",
          "path": "<canonical folder>",
          "readOnly": false,
          "addedAt": 0
        },
        {
          "kind": "workspace",
          "path": "<canonical workspace path>",
          "readOnly": false,
          "addedAt": 0,
          "overrides": {
            "<canonical directory>": true
          }
        }
      ]
    }
  }
}
```

Version 1 files (folder snapshots, `source: "folder" | "workspace"`) load as `folder` rows and are rewritten as version 2 on the next change: every path is preserved, and only the provenance that version 1 never recorded reliably is dropped. Writes are atomic (temporary sibling plus rename).

## Behaviour and limits

- **Grants are runtime-only and per Session.** `registerWritableRoot` is effect-scoped; the plugin re-registers the current effective list on every `agent/pre-step`, so resumed, forked, and newly created Sessions converge without a separate registry. Grants cover existing writable directories only; a directory that disappears is dropped from the Session at the next step, and one that reappears is granted again.
- **Workspace references are expanded live.** Nested references are followed (depth-capped at 16, cycles skipped) and the same directory reached through several rows appears once.
- **Read-only is resolved per directory.** Precedence: per-directory override → explicit folder row of the owning workspace → any read-only contribution along the expansion (a referenced folder row, or a workspace row's blanket switch). Missing directories are skipped by the guard, since no mutation can land there.
- **Windows process confinement ignores extra writable roots.** Under `workspace-write`, the harness file tools honor attached folders on every platform, but a sandboxed `bash` / PowerShell process can still be denied outside the workspace root. This is an upstream limitation of the sandbox backend, not of this plugin.
- **Read-only is enforced for the file tools** (`write`, `edit`, `str_replace_editor`, `apply_patch`). A shell command that writes into a read-only folder which is also inside the primary workspace is not parsed or blocked.
- **Up to 64 rows per workspace.**
- **Routes are loopback-only.** The dialog's state routes are served to the local DSH page and reject a remote authority.
- Removing the plugin releases its own grants on unload; profile-installed grants from other plugins are unaffected.
