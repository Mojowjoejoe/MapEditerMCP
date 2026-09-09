import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolveEditorRoot} from './editor-root.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=resolveEditorRoot();
const exe=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Pass the private editor executable.');
const {createBlankProject}=await import(pathToFileURL(path.join(root,'lib/wulfram.ts')));
const {BUILD_AREAS_KEY}=await import(pathToFileURL(path.join(root,'lib/build-areas.ts')));
await fs.mkdir(path.join(here,'outputs'),{recursive:true});
const out=await fs.mkdtemp(path.join(here,'outputs','game-test-native-'));
const fixture=JSON.parse(await fs.readFile(path.join(root,'examples/distributed-depot/small.json'),'utf8'));
const fixturePath=path.join(out,'depot-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const report={passed:false,executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),out};
const sessions=path.join(out,'sessions'),profile=path.join(out,'profile');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const probe=async(fn,label)=>{const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error(`Timeout: ${label}`);};
let app,client,socket;let sequence=0;const pending=new Map();
try{
 app=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_PORTABLE_ROOT:'D:/WulframForgeBuilds/portable-runtime-v1/Wulf-Portable',WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:sessions,WULFRAM_FORGE_USER_DATA_DIR:profile,WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
 app.on('error',e=>{report.spawnError=e.message;});
 const target=await probe(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.url==='https://wulfram-forge.local/index.html');}catch{return undefined;}},'editor target');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp && !!document.querySelector(\'input[type="file"][multiple]\')'),'editor ready');
 const doc=await send('DOM.getDocument'),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type="file"][multiple]'});
 await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[fixturePath]});
 client=new Client({name:'depot-generation-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported hill');const sessionId=session.sessionId;
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 const before=await snapshot(),state=await call('get_editor_state',{sessionId});assert.deepEqual(before.project,fixture);

 const malformed=await evaluate(`new Promise(resolve=>{const id=crypto.randomUUID();const handler=e=>{if(e.data.id===id){window.chrome.webview.removeEventListener('message',handler);resolve(e.data);}};window.chrome.webview.addEventListener('message',handler);window.chrome.webview.postMessage({id,action:'game-test-start'});})`);assert.equal(malformed.ok,false);
 report.preflight=await call('game_test_status',{sessionId});assert.equal(report.preflight.busy,false);if(process.env.FORGE_TEST_POWER_RULES){assert.equal(report.preflight.powerRules.powerRadius,500);assert.equal(report.preflight.powerRules.backupRadius,50);assert.equal(report.preflight.powerRules.source,'selected-runtime');assert.equal(report.preflight.comparisonRevision,state.revision);assert.deepEqual(report.preflight.powerComparison.rows.map(r=>r.editorThreshold),[Math.max(0,fixture.validation.serviceRadius-10),fixture.validation.backupRadius-10]);}
 const stale=await client.callTool({name:'start_game_test',arguments:{sessionId,expectedRevision:'stale'}});assert.equal(stale.isError,true);
 report.started=await call('start_game_test',{sessionId,expectedRevision:state.revision});
 const ready=await probe(async()=>{const s=await call('game_test_status',{sessionId});return !s.busy?s:null;},'native game launch');report.status=ready;
 if(ready.sessionDirectory)report.serverLog=await fs.readFile(path.join(ready.sessionDirectory,'server-startup.log'),'utf8').catch(()=>null);
 assert.equal(ready.error,null);assert.equal(ready.serverRunning,true);assert.equal(ready.clientRunning,true);
 const settings=JSON.parse(await fs.readFile(path.join(ready.sessionDirectory,'server/WulframServerSettings.json'),'utf8'));report.mapName=settings.server.map_name;
 const {createMapArchiveFiles}=await import(pathToFileURL(path.join(root,'lib/map-package.ts')));
 for(const [name,contents] of Object.entries(createMapArchiveFiles(before.project)))assert.equal(await fs.readFile(path.join(ready.sessionDirectory,'client/mod/data/maps',report.mapName,name),'utf8'),contents);
 assert.match(ready.serverAddress,/^127\.0\.0\.(?:[1-9]|[12][0-9]|3[0-2])$/);
 assert.equal(settings.network.host,ready.serverAddress);assert.equal(settings.network.server_ip,ready.serverAddress);
 assert.equal(settings.network.tcp_port,2627);assert.equal(settings.network.udp_port,2627);
 assert.ok(Number.isInteger(ready.serverProcessId)&&Number.isInteger(ready.clientProcessId));
 report.endpoint={address:ready.serverAddress,port:2627,serverProcessId:ready.serverProcessId,clientProcessId:ready.clientProcessId};assert.deepEqual(await snapshot(),before);
 if(process.env.FORGE_TEST_POWER_RULES){
  const settingsPath=path.join(ready.sessionDirectory,'server/WulframServerSettings.json'),original=await fs.readFile(settingsPath,'utf8');
  try{settings.gameplay.base_units.power_radius=999;await fs.writeFile(settingsPath,JSON.stringify(settings));const bound=await call('game_test_status',{sessionId});assert.equal(bound.powerRules.powerRadius,500);assert.equal(bound.powerRules.source,'launched-session');report.launchRulesSnapshotBound=true;}
  finally{await fs.writeFile(settingsPath,original);}
 }

 await evaluate(`(()=>{const menus=[...document.querySelectorAll('.editor-menu-bar details')];const menu=menus.find(d=>d.querySelector('summary').textContent==='Tools');menu.open=true;[...menu.querySelectorAll('button')].find(b=>b.textContent==='Test in game…').click();})()`);
 await probe(()=>evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('Server running')`),'game test dialog running');
 if(process.env.FORGE_TEST_POWER_RULES){assert.ok(await evaluate(`document.querySelector('.game-power-comparison')?.textContent.includes('500 u')`));assert.ok(await evaluate(`document.querySelector('.game-power-comparison')?.textContent.includes('Power settings differ')`));}
 const shotPath=path.join(out,'game-test-dialog.png');await fs.writeFile(shotPath,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 if(process.env.FORGE_GAME_TEST_HOLD_MS){console.log('Game inspection session: '+ready.sessionDirectory);await new Promise(r=>setTimeout(r,Math.min(240000,Number(process.env.FORGE_GAME_TEST_HOLD_MS))));report.serverLog=await fs.readFile(path.join(ready.sessionDirectory,'server-startup.log'),'utf8');}
 await new Promise(r=>setTimeout(r,8000));report.sustainedStatus=await call('game_test_status',{sessionId});assert.equal(report.sustainedStatus.clientRunning,true,'Client must remain running after startup');assert.equal(report.sustainedStatus.serverRunning,true,'Server must remain running after startup');
 report.stopped=await call('stop_game_test',{sessionId});await probe(async()=>{const s=await call('game_test_status',{sessionId});return !s.serverRunning&&!s.clientRunning;},'owned processes stopped');assert.deepEqual(await snapshot(),before);
 report.checks={malformedRecovery:true,staleRejected:true,exportExact:true,sourceUnchanged:true,serverClientStarted:true,guiStatus:true,stop:true};report.passed=true;

}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client){try{const sessionsNow=await client.callTool({name:'list_editor_sessions',arguments:{}});const sid=JSON.parse(sessionsNow.content[0].text).sessions[0]?.sessionId;if(sid)await client.callTool({name:'stop_game_test',arguments:{sessionId:sid}});}catch{}}if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
