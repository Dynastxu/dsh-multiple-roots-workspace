# Multiple-root workspace

A DeepSeek Harness bundle that attaches extra folders — or another workspace's folders — to one workspace, with a per-folder read-only switch and a remove button.

- **No new tools.** The agent keeps using the native `read` / `write` / `edit` / `apply_patch` / `bash` tools; the attached folders simply join the writable scope.
- **One workspace menu entry.** Open a workspace's `…` menu → **Attached folders…**.
- **Add folder or add workspace.** _Add folder_ picks any directory. _Add workspace_ picks another DSH workspace and attaches its root directory together with every folder already attached to it.
- **Read-only per row.** A writable row gets a `registerWritableRoot` grant for every live Session of that workspace. A read-only row gets no grant and a tool guard rejects file mutations that still land inside it (for example when the folder is inside the primary workspace).
- **Prompt only when needed.** The attached list reaches the model as runtime context that renders empty without rows. The agent loop commits one snapshot when the conversation first needs it and another only when the rendered list changes — no per-step duplicate.

## Install

From the DSH Plugins page: **Add plugin** → choose this directory.

Or from the bundled `dsh` CLI:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-multiple-roots-workspace
```

A local-directory install links the checkout; restart DSH or reload the page after changing the Host or Client files.

## Requirements

- **DSH `>=0.2.2-rc.2`.** That is the first release containing `SandboxPolicyService.registerWritableRoot` (commit `f5dea38671`, 2026-10-26; first tagged in `dsh-v0.2.2-rc.2`). Earlier releases do not expose the session-scoped writable-root API the grants rely on. The other DSH APIs used here pre-date it: the context-menu service first shipped in `0.2.2-alpha.3`, and the shell overlay, directory picker, web-server routes, and workspace registry in `0.2.1-rc.2`. The declaration lives in `engines.dsh`, which the plugin manager evaluates before installing or starting the bundle.
- **Node `>=22.19`** for building and testing the sources; the installed bundle itself runs inside DSH's Node runtime.

## Usage

1. Hover a workspace row in the sidebar and open its `…` menu.
2. Choose **Attached folders…**.
3. Add folders or workspaces, toggle **Read-only** per row, remove rows with the trash button.

Changes apply to the workspace's live Sessions immediately for grants; the model sees the updated list at its next request.

## Development

The bundle is authored in TypeScript and built with Vite. Vite emits into `.build/`; the build script copies the two entries to the package root, where the installed loader and Client export resolve them (`index.js`, `client.js`).

```sh
pnpm run build        # Vite: index.js (Host) + client.js (Client)
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
  "version": 1,
  "workspaces": {
    "<canonical workspace path>": {
      "entries": [
        {
          "path": "<canonical folder>",
          "readOnly": false,
          "source": "folder",
          "addedAt": 0
        }
      ]
    }
  }
}
```

Writes are atomic (temporary sibling plus rename).

## Behaviour and limits

- **Grants are runtime-only and per Session.** `registerWritableRoot` is effect-scoped; the plugin re-registers the current list on every `agent/pre-step`, so resumed, forked, and newly created Sessions converge without a separate registry.
- **Windows process confinement ignores extra writable roots.** Under `workspace-write`, the harness file tools honor attached folders on every platform, but a sandboxed `bash` / PowerShell process can still be denied outside the workspace root. This is an upstream limitation of the sandbox backend, not of this plugin.
- **Read-only is enforced for the file tools** (`write`, `edit`, `str_replace_editor`, `apply_patch`). A shell command that writes into a read-only folder which is also inside the primary workspace is not parsed or blocked.
- **Attached folders stay listed when they disappear.** Grants and containment checks report the failure (or simply stop matching); remove the row to clean it up.
- **Up to 64 attached folders per workspace.**
- **Routes are loopback-only.** The dialog's state routes are served to the local DSH page and reject a remote authority.
- Attaching a workspace is one level: its root plus the folders it currently has on its own list; nested workspace lists are not followed recursively.
- Removing the plugin releases its own grants on unload; profile-installed grants from other plugins are unaffected.
