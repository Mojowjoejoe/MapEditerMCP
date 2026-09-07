# Shared editor serialization modules

These four TypeScript files are copied without source changes from the companion
Wulfram Forge editor's `lib/` directory: `map-package.ts`, `map-source.ts`,
`wulfram.ts`, and `sky-settings.ts`. They provide the complete local import chain
for map ZIP export. JSZip is declared in this package's dependencies.

When updating serialization, refresh all four files together from the compatible
editor and run `npm test`. Retain the source project's applicable notices;
this packaging change does not grant additional redistribution rights.
