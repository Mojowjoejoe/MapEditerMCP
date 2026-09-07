import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMapArchive, readMapArchive} from '../lib/map-package.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('standalone server starts from another working directory and lists its tools', {timeout: 20000}, async () => {
  const client = new Client({name: 'package-test', version: '1'});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', path.join(root, 'server.mjs')],
    cwd: os.tmpdir(), stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const {tools} = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'list_editor_sessions', 'get_editor_state', 'inspect_map', 'validate_map',
      'edit_entities', 'edit_terrain', 'capture_view', 'undo', 'save_copy', 'export_map',
    ].sort());
  } finally { await client.close(); }
});

test('bundled serialization preserves the native fixture through ZIP export', async () => {
  const project = JSON.parse(await fs.readFile(path.join(root, 'fixtures/three-lane-citadel/project.json'), 'utf8'));
  const archive = await readMapArchive(Buffer.from(await createMapArchive(project)));
  const restored = JSON.parse(archive.find(entry => entry.name.endsWith('/wulfram-project.json')).text);
  assert.deepEqual(restored.terrain, project.terrain);
  assert.deepEqual(restored.entities, project.entities);
  const original = await readMapArchive(await fs.readFile(path.join(root, 'fixtures/three-lane-citadel/Three-Lane-Citadel-v1.zip')));
  const fixture = JSON.parse(original.find(entry => entry.name.endsWith('/wulfram-project.json')).text);
  assert.deepEqual(fixture.terrain, project.terrain);
  assert.deepEqual(fixture.entities, project.entities);
});
