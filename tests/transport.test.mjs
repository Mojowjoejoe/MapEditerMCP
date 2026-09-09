import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {requestEditor} from '../editor-client.mjs';

const windows = process.platform === 'win32';

// A real single-instance Windows pipe, including the native host's dispose /
// recreate gap. Every test uses a random identity and temporary descriptors.
async function fixture(t, {count = 1, startupDelay = 0, responseDelay = 0, mode = 'ok'} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-transport-'));
  const previousDirectory = process.env.WULFRAM_MCP_SESSION_DIR;
  process.env.WULFRAM_MCP_SESSION_DIR = directory;
  const id = randomBytes(16).toString('hex');
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
    protocolVersion: 1, sessionId: id, pipeName: `WulframForge-${id}`, token: 'A'.repeat(64),
  }));
  const script = `
$ErrorActionPreference = 'Stop'
Write-Output 'READY'
Start-Sleep -Milliseconds ${startupDelay}
for ($i = 0; $i -lt ${count}; $i++) {
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new('WulframForge-${id}', [System.IO.Pipes.PipeDirection]::InOut, 1)
  try {
    $pipe.WaitForConnection()
    $reader = [System.IO.StreamReader]::new($pipe)
    $line = $reader.ReadLine()
    $request = $line | ConvertFrom-Json
    Write-Output ('REQUEST:' + $request.command.action)
    Start-Sleep -Milliseconds ${responseDelay}
    if ('${mode}' -ne 'disconnect') {
      $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
      $response = @{ok=$true;result=@{action=$request.command.action}} | ConvertTo-Json -Compress
      if ('${mode}' -eq 'reject-first' -and $i -eq 0) { $response = '{"ok":false,"error":"Deliberate rejection"}' }
      if ('${mode}' -eq 'malformed') { $response = '{"ok":"true","result":{}}' }
      $writer.WriteLine($response)
      $writer.Flush()
    }
  } finally { $pipe.Dispose() }
  Start-Sleep -Milliseconds 100
}
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true});
  let output = '', errors = '';
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    if (previousDirectory === undefined) delete process.env.WULFRAM_MCP_SESSION_DIR;
    else process.env.WULFRAM_MCP_SESSION_DIR = previousDirectory;
    await fs.rm(directory, {recursive: true, force: true});
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('READY')) {
    assert.equal(child.exitCode, null, `Pipe helper exited: ${errors}`);
    assert.ok(Date.now() < deadline, `Pipe helper startup timed out: ${errors}`);
    await delay(20);
  }
  return {id, requests: () => output.split(/\r?\n/).filter(line => line.startsWith('REQUEST:')), errors: () => errors};
}

test('same-session parallel calls queue across single-instance pipe recreation', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {count: 3, responseDelay: 100});
  const actions = ['get_editor_state', 'inspect_map', 'validate_map'];
  const results = await Promise.all(actions.map(action => requestEditor(f.id, {action}, 3000)));
  assert.deepEqual(results, actions.map(action => ({action})));
  assert.deepEqual(f.requests(), actions.map(action => `REQUEST:${action}`));
  assert.equal(f.errors(), '');
});

test('descriptor published before pipe startup is recovered before sending', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {startupDelay: 300});
  assert.deepEqual(await requestEditor(f.id, {action: 'get_editor_state'}, 3000), {action: 'get_editor_state'});
  assert.deepEqual(f.requests(), ['REQUEST:get_editor_state']);
});

test('a submitted write disconnected without acknowledgement is never replayed', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {count: 2, mode: 'disconnect'});
  await assert.rejects(requestEditor(f.id, {action: 'edit_entities'}, 3000), /before acknowledge?ment|before acknowledging|ECONNRESET/);
  await delay(350);
  assert.deepEqual(f.requests(), ['REQUEST:edit_entities']);
});

test('an editor rejection does not poison subsequent queued requests', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {count: 2, mode: 'reject-first'});
  const results = await Promise.allSettled([
    requestEditor(f.id, {action: 'edit_entities'}, 3000),
    requestEditor(f.id, {action: 'get_editor_state'}, 3000),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /Deliberate rejection/);
  assert.deepEqual(results[1], {status: 'fulfilled', value: {action: 'get_editor_state'}});
  assert.deepEqual(f.requests(), ['REQUEST:edit_entities', 'REQUEST:get_editor_state']);
});

test('a write whose budget expires behind a slow read is never submitted', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {count: 2, responseDelay: 300});
  const results = await Promise.allSettled([
    requestEditor(f.id, {action: 'get_editor_state'}, 3000),
    requestEditor(f.id, {action: 'edit_entities'}, 50),
  ]);
  assert.deepEqual(results[0], {status: 'fulfilled', value: {action: 'get_editor_state'}});
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /expired in queue; no command was sent/);
  await delay(200);
  assert.deepEqual(f.requests(), ['REQUEST:get_editor_state']);
});

test('malformed response envelopes reject rather than reporting success', {skip: !windows, timeout: 15000}, async t => {
  const f = await fixture(t, {mode: 'malformed'});
  await assert.rejects(requestEditor(f.id, {action: 'get_editor_state'}, 3000), /Invalid editor response/);
});
