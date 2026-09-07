# Wulfram Forge MCP

A local MCP server for the Wulfram Forge Windows desktop editor. The server package includes its map serialization modules, dependency lockfile, and native test fixtures. It can start from its own checkout, including the nested `tools/mcp/MapEditerMCP` layout.

Requirements: Node.js 22.13 or newer, npm, and a compatible MCP-enabled Wulfram Forge Windows editor for live map operations. Building the editor also requires the .NET 9 SDK and WebView2 runtime.

## Install and verify

Run from this repository's root:

```powershell
npm ci
npm test
npm start
```

`npm start` runs the STDIO server and waits for an MCP client. Configure your client's command as the absolute path to Node, with arguments `--experimental-strip-types` and the absolute path to this repository's `server.mjs`. Both `server.mjs` and `MCPserver.mjs` are required; preserve capitalization.

`npm test` verifies the MCP handshake and ten tool definitions without connecting to an editor, and checks a ZIP serialization round trip against the included native fixture. It does not establish live editing or gameplay behavior.

## Editor integration

The server is self-contained; the native editor is a separate application. Keep the editor's `McpEditorHost.cs`, `MainForm.cs`, `lib/mcp-commands.ts`, `lib/use-mcp-bridge.ts`, and editor UI integration together in a compatible editor checkout.

For the build, launcher, and native acceptance scripts, set the editor location when it is not an ancestor of this package:

```powershell
$env:WULFRAM_FORGE_ROOT = 'C:\path\to\wulfram-mapeditor'
```

When this repository is under `tools/mcp/MapEditerMCP`, the scripts find the ancestor editor automatically. An explicitly supplied invalid path fails with an actionable error.

Install the editor's npm dependencies in its checkout first. Then run these scripts from this repository, checking each succeeds before continuing:

```powershell
.\build-editor.ps1
.\launch-editor.ps1
npm run test:desktop
```

The builder uses the editor's local `.dotnet-sdk/dotnet.exe` when present, otherwise `dotnet` on PATH. It creates `dist/desktop/mcp-v0.1.0/WulframForge.exe` in the editor checkout. The launcher enables the native bridge using a separate persistent profile. Native acceptance uses an isolated profile and the two files in `fixtures/three-lane-citadel/`.

## Tools and operation

The server exposes `list_editor_sessions`, `get_editor_state`, `inspect_map`, `validate_map`, `edit_entities`, `edit_terrain`, `capture_view`, `undo`, `save_copy`, and `export_map`.

Discover and select the intended session, inspect its map, then use its current revision for edits. Entity IDs are map-specific. Successful edit batches use the editor's undo history; invalid or stale requests reject. After a timeout or disconnect, inspect again before retrying a write.

The server uses STDIO and a current-user Windows named pipe. The editor bridge must be explicitly enabled. Session credentials are local and are not returned by discovery. Exports are new files under this package's `outputs/mcp-exports/`; existing files are never overwritten. Exporting a copy does not mark the editor saved.

## Included files and exclusions

`lib/` contains the shared serialization source required for ZIP exports; see its README for provenance and update guidance. `fixtures/` contains the JSON project and matching ZIP required by native acceptance. `tests/` contains standalone package checks.

Dependencies, generated builds, exports, session descriptors, profiles, and credentials remain excluded from Git. Run `npm ci` after cloning. Do not add session credentials to this repository.

## Troubleshooting

- Startup import error: restore the complete repository, including `lib/`, and run `npm ci`.
- No editor sessions: launch a compatible MCP-enabled editor and open a map.
- Missing editor checkout: set `WULFRAM_FORGE_ROOT` to its directory.
- Missing native executable: run the editor build script after installing its dependencies and .NET SDK.
- Stale revision or uncertain write outcome: inspect the current map before retrying.

This is a Windows desktop integration; starting the server does not launch the editor. Included source and game fixtures retain their existing rights; inclusion does not grant additional redistribution permission.
