# MCP critic review — 2026-09-07

## Result

Three independent critics reviewed protocol/transport, native/editor integration,
and packaging/tests. Follow-up rounds reviewed the fixes and uncovered additional
deadline edge cases, which were also corrected. No remaining actionable blocker
was identified within these reviewed areas. All 29 final checks passed.

This is local source and native-editor evidence, not proof of game mechanics or
every possible failure mode. Changes from this critic loop have not been committed
or pushed. Existing unrelated editor work remains in place.

## Findings and fixes

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Queued native requests could execute after timeout. | Check cancellation on UI dispatch and the absolute deadline in native and renderer dispatch. | Stall renderer over 32 seconds; verify expired edit does not change revision or entities after recovery. |
| Concurrent calls collided with the single-instance native pipe. | Serialize requests per session; retry connection gaps only before a command is submitted. | Concurrent reads, pipe recreation, startup gap, rejected-request recovery, and no replay after a submitted write disconnects. |
| Waiting in the new client queue could exhaust the caller budget before a write was submitted. | Capture the absolute deadline on entry and reject expired requests before submission. | Short-budget write behind slow read never reaches the test pipe. |
| Native host could grant a fresh 30 seconds after the client budget was partly consumed. | Include client deadline in the envelope and clamp the host deadline and cancellation budget to it. | A 500 ms client budget with a 2-second renderer stall rejects without later edits. |
| Terrain brushes resnapped unrelated authored structures. | Compare old/new terrain support before changing a structure's altitude or tilt. | Zero-value brush preserves authored transforms; nonzero brush preserves distant structures while conforming affected interpolation support. |
| ZIP regression checked only embedded terrain/entities. | Compare all eight exported archive entry names and contents with the fixture. | Full fixture comparison passes. |
| Native tests could run against an older executable. | Rebuild current editor source and record the tested executable hash. | Fresh native build and 13-step acceptance below. |

Both integrated and standalone `editor-client.mjs` copies have identical SHA-256:
`97D622E57B8818679EF397C330F044DC4CD90F1647009A95743B5BC2FE882D57`.

## Final validation

- 8 MCP source tests passed, including atomic rollback, mirrored operations,
  schema checks, and the two terrain regressions.
- 8 standalone package/transport tests passed: handshake, full ZIP fixture parity,
  and six real isolated Windows pipe tests.
- 13 native acceptance steps passed against the freshly rebuilt editor.
- TypeScript `tsc --noEmit` passed after the terrain fix.
- A copied standalone package with only declared dependencies passed `npm ci`
  and all 8 package tests during the loop. Later deadline-envelope changes added
  no dependency and passed the final package and native checks.
- Relevant diffs passed whitespace checks.

Native executable SHA-256:
`5FB2689EF6F78678C81E9597F203D7F192A24C451A2878BBCFCDAF9EAD715745`

Local evidence:

- [Final native acceptance report](outputs/mcp-native-test-bpsOOC/report.json)
- [Final source hashes](outputs/critic-source-hashes.json)
- [Native build log](outputs/critic-native-build.log)

Build commands: `build-editor.ps1` rebuilt the current web assets and native
editor, followed by another native `dotnet publish` after the final host deadline
change, using Release/win-x64/self-contained and version `0.7.0-mcp.1`.
Builds succeeded with bundle-size advisories and an MSB3277 WindowsBase reference
conflict warning. Native acceptance passed despite that warning.

## Limits and deployment

The test runner uses isolated editor profiles and fixture maps. CDP imports the
fixture and deliberately stalls the renderer; ordinary map operations go through
MCP STDIO and the native pipe. The short-budget regression uses the same pipe
client directly to supply its 500 ms budget.

The deadline protection requires the corrected native host as well as the updated
client. Updating only the Node server does not retrofit old editor binaries.
Commands already executing before their deadline can still complete after a
disconnect: inspect the current map before retrying a write. The native report
certifies this local build, including existing local editor changes, rather than
the older GitHub snapshot.
