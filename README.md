# PatchManager Lua

VSCode extension that sets up a workspace for writing [KSP2 PatchManager](https://github.com/KSP2Community/PatchManager) Lua patches.

Run **PatchManager Lua: Configure Workspace** and the extension will:

- Drop bundled `.d.lua` stubs into `.pmlua/stubs/` and add `.pmlua/` to `.gitignore`.
- Configure LuaLS (`runtime.version`, the `|lambda|` nonstandard symbol, `workspace.library`, `lowercase-global` suppression).

**Update Stubs from Remote** pulls the latest stubs from `KSP2Community/PatchManager` (branch configurable via `pmLua.branch`).

## Settings

| Setting | Default |
| --- | --- |
| `pmLua.repo` | `KSP2Community/PatchManager` |
| `pmLua.branch` | `unity` (will become `main`) |
| `pmLua.stubsPath` | `Stubs` |
| `pmLua.autoPrompt` | `true` |

## Dev

```powershell
npm install && npm run compile  # F5 to launch Extension Development Host
npm run sync-stubs              # refresh ./stubs/ from local ksp2redux checkout
```

## Releasing

CI handles publishing to the VSCode Marketplace + Open VSX on tag push:

```powershell
# bump version in package.json, commit, then:
git tag v0.1.1
git push origin v0.1.1
```

Requires repo secrets `VSCE_PAT` (Azure DevOps) and `OVSX_PAT` (open-vsx.org).
