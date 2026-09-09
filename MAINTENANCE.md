# Maintaining MCP with the editor

User requirement: keep MCP updated as new functions are built and the project improves.

## Same-change integration

For every editor feature or bug fix, check whether it changes map data, authoring
operations, validation, selection, inspection, import/export, undo, or useful
automation. Update the MCP interface in the same work when applicable. Record
the MCP impact in the implementation summary; do not silently defer it.

Reuse the editor's operation and validation code. Do not reimplement editor
behavior in the MCP server. An existing tool may already expose a capability;
extend its validated schema when appropriate instead of adding duplicate tools.
For capabilities that cannot safely be exposed yet, document the specific gap
and reason in the feature handoff. Pure visual changes need only an impact check.

Trace affected changes through:

- `lib/mcp-commands.ts` and the underlying editor operations/constraints.
- `lib/use-mcp-bridge.ts` for live state, revisions, commits, and undo.
- `desktop/WulframForge/McpEditorHost.cs` for the native allowlist and dispatch.
- Integrated `tools/mcp/MCPserver.mjs` and standalone `MCPserver.mjs` for schemas,
  tool descriptions, registration, and validation.
- Both `editor-client.mjs` copies when changing transport behavior.
- README tool documentation, tests, fixtures, and package dependencies.

Preserve explicit session identity, revision checks, atomic edits, undo behavior,
constraints, current-user transport, and end-to-end deadlines. Never automatically
replay a submitted write after a disconnect. Keep test profiles isolated from the
user's regular editor and map.

## Synchronization

The standalone `lib/` serialization modules are copies of the editor sources.
Refresh `map-package.ts`, `map-source.ts`, `wulfram.ts`, and `sky-settings.ts`
together when relevant code changes; include any new transitive imports and
dependencies. Keep export behavior identical. Update the synchronization checker
if the shared module set or intentional packaging differences change.

From the editor root, run `node tools/check-mcp-sync.mjs`. It checks both clients,
server registration code after normalizing intentional import/output-root
differences, all four serializer copies, and both fixture copies.

Build and launcher paths deliberately differ between integrated and standalone
layouts. Keep both usable without copying editor-specific paths blindly into the
standalone package. Standalone changes must also work outside this workspace.

## Verification proportional to the change

- For affected commands, add meaningful regressions for the behavior and failure
  cases, then run `node --experimental-strip-types --test tests/mcp.test.mjs`
  from the editor root.
- Run `npm test` in the standalone package for transport, packaging, or export
  changes. Extend tool-list assertions when intentionally adding tools.
- Run the editor's TypeScript check when TypeScript changes.
- For native host or live bridge changes, rebuild the editor before running
  `npm run test:desktop` in the standalone package. Retain the report and tested
  executable SHA-256; an old executable cannot verify new source.
- For dependencies or layout changes, verify `npm ci` and tests in an isolated
  package copy containing only deliverable files.
- For substantive changes to mutation, deadlines, concurrency, or validation,
  run independent critics, fix confirmed findings, and review/test the fixes
  until no actionable finding remains. Keep the critic tasks bounded.

Do not rerun unrelated expensive native tests for documentation-only edits.

## Completion and publication

Report new or changed capabilities, checks passed, known unsupported operations,
and whether fixes are local, rebuilt, committed, or pushed. Keep versions and
compatibility requirements accurate. A Node-only update does not update the
native editor; identify when users need a rebuilt host.

Preserve unrelated dirty work and nested repository histories. When publishing
under the user's authorization, include all required source dependencies and
verify each intended repository's remote commit. Do not claim the GitHub snapshot
matches current local editor work unless it has actually been synchronized.
