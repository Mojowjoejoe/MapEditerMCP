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
const out=await fs.mkdtemp(path.join(here,'outputs','craft-trial-native-'));
const fixture=createBlankProject('Hill traversal measurement lab',129);
fixture.terrain.worldWidth=4096;fixture.terrain.worldHeight=4096;
fixture.terrain.heights=fixture.terrain.heights.map((_,i)=>Math.max(0,400*(1-Math.abs(i%129*32-2048)/1536)));
const forward=[[512,2048],[3584,2048]];
fixture.baseLayouts[0].metadata[BUILD_AREAS_KEY]=JSON.stringify([
 {id:'hill-forward',name:'Hill eastbound',kind:'corridor',team:'all',width:120,points:forward},
 {id:'hill-reverse',name:'Hill westbound',kind:'corridor',team:'all',width:120,points:[...forward].reverse()},
]);
const fixturePath=path.join(out,'hill-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const report={passed:false,executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),out};
const sessions=path.join(out,'sessions'),profile=path.join(out,'profile');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const probe=async(fn,label)=>{const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error(`Timeout: ${label}`);};
let app,client,socket;let sequence=0;const pending=new Map();
try{
 app=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:sessions,WULFRAM_FORGE_USER_DATA_DIR:profile,WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
 app.on('error',e=>{report.spawnError=e.message;});
 const target=await probe(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.url==='https://wulfram-forge.local/index.html');}catch{return undefined;}},'editor target');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp && !!document.querySelector(\'input[type="file"][multiple]\')'),'editor ready');
 const doc=await send('DOM.getDocument'),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type="file"][multiple]'});
 await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[fixturePath]});
 client=new Client({name:'hill-elevation-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported hill');const sessionId=session.sessionId;
 const before=await call('get_editor_state',{sessionId});
 const snapshot=async name=>{const copy=await call('save_copy',{sessionId,expectedRevision:before.revision,name:`${path.basename(out)}-${name}`});return {path:copy.path,project:JSON.parse(await fs.readFile(copy.path,'utf8'))};};
 const initial=await snapshot('hill-before');assert.deepEqual(initial.project,fixture);

 const results=[];
 for(const craft of ['tank','scout'])for(const initialSpeed of [0,40]){
  const value=await call('run_craft_trial',{sessionId,expectedRevision:before.revision,points:forward,craft,initialSpeed});
  if(process.env.WULFRAM_CRAFT_GHOST_TEST==='1'){assert.ok(value.trial.collisionMesh.vertices.length>=3);assert.ok(value.trial.collisionMesh.triangles.length>0);}
  assert.equal(value.revision,before.revision);assert.equal(value.trial.fidelity,'unverified-reconstruction');
  assert.equal(value.trial.status,craft==='tank'?'time-limit':'target-reached');
  assert.equal(value.trial.samples[0].position[0],512);
  assert.ok(value.trial.samples.length>400);results.push(value.trial);
 }
 for(const args of [{expectedRevision:'stale',points:forward},{expectedRevision:before.revision,points:[...forward].reverse()}]){
  const bad=await client.callTool({name:'run_craft_trial',arguments:{sessionId,craft:'tank',initialSpeed:0,...args}});assert.equal(bad.isError,true);
 }
 await evaluate(`(()=>{const menu=[...document.querySelectorAll('.editor-menu-bar details')].find(d=>d.querySelector('summary')?.textContent==='Bases');menu.open=true;[...menu.querySelectorAll('button')].find(b=>b.textContent==='Inspect').click();})()`);
 await probe(()=>evaluate(`!!document.querySelector('[aria-label="Trial craft"]')`),'craft panel');
 await evaluate(`(()=>{const d=[...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Experimental craft trial');d.open=true;[...d.querySelectorAll('button')].find(b=>b.textContent==='Run craft trial').click();})()`);
 await probe(()=>evaluate(`!!document.querySelector('[aria-label="Craft trial time"]')`),'GUI trial');
 const gui=await evaluate(`(()=>{const s=document.querySelector('[aria-label="Craft trial time"]');return {max:Number(s.max),text:s.closest('details').textContent,points:s.closest('details').querySelectorAll('polyline')[1].getAttribute('points')}})()`);
 assert.equal(gui.max,results[0].samples.length-1);assert.match(gui.text,/60-second time limit/);
 const samples=results[0].samples,high=Math.max(400,...samples.map(s=>s.position[2]));
 assert.equal(gui.points,samples.map(s=>`${10+(s.position[0]-512)/3072*280},${90-s.position[2]/high*80}`).join(' '));
 await evaluate(`(()=>{const s=document.querySelector('[aria-label="Craft trial time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'300');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await probe(()=>evaluate(`document.querySelector('[aria-label="Craft trial time"]').closest('details').textContent.includes('Trial time 30.00 s')`),'trial scrubber');

 const marker=await evaluate(`(()=>{const c=document.querySelector('[aria-label="Trial craft origin and terrain cross-section"] circle');return {x:Number(c.getAttribute('cx')),y:Number(c.getAttribute('cy'))}})()`);
 assert.equal(marker.x,10+(samples[300].position[0]-512)/3072*280);assert.equal(marker.y,90-samples[300].position[2]/high*80);

 if(process.env.WULFRAM_CRAFT_PLAYBACK_TEST==='1'){
  const click=label=>evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})).click()`);
  const at=()=>evaluate(`Number(document.querySelector('[aria-label="Craft trial time"]').value)`);
  await click('Play trial');await probe(async()=>await at()>300,'play advances');await click('Pause trial');
  const paused=await at();await new Promise(r=>setTimeout(r,250));assert.equal(await at(),paused);
  await click('Play trial');
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Craft trial time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'150');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Play trial')`),'seek pauses');
  await new Promise(r=>setTimeout(r,250));assert.equal(await at(),150);

  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Craft trial time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,String(Number(s.max)-1));s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('Play trial');await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Replay trial')`),'automatic end pause');
  assert.equal(await at(),samples.length-1);await click('Replay trial');await probe(async()=>{const n=await at();return n>0&&n<30;},'replay restarts');
  await evaluate(`document.querySelector('[aria-label="Craft trial time"]').closest('details').open=false`);
  await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Play trial')`),'closing pauses');
  const closedAt=await at();await new Promise(r=>setTimeout(r,250));assert.equal(await at(),closedAt);
  await evaluate(`document.querySelector('[aria-label="Craft trial time"]').closest('details').open=true`);
  report.playback={advances:true,pause:true,end:true,replay:true,closePauses:true,seekPauses:true};
 }

 if(process.env.WULFRAM_CRAFT_GHOST_TEST==='1'){
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Craft trial time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'300');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await probe(()=>evaluate(`document.querySelector('[aria-label="Craft trial time"]').value==='300'`),'hull pose at crest');
  await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent==='Focus craft hull')).click()`);
  await new Promise(r=>setTimeout(r,500));
  report.collisionHull={provided:true,focused:true,poseIndex:300,craft:'tank'};
 }
 for(const malformed of ['[]','null','{"action":1}'])await evaluate(`window.chrome.webview.postMessage(${malformed})`);
 assert.equal((await call('get_editor_state',{sessionId})).revision,before.revision);
 await send('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false});
 await evaluate(`document.querySelector('[aria-label="Craft trial time"]').scrollIntoView({block:'center'})`);
 const shot=await send('Page.captureScreenshot',{format:'png'}),shotPath=path.join(out,'craft-trial-960.png');await fs.writeFile(shotPath,Buffer.from(shot.data,'base64'));

 if(process.env.WULFRAM_CRAFT_GHOST_TEST==='1'){
  await evaluate(`document.querySelector('[aria-label="Craft trial time"]').closest('details').open=false`);
  await new Promise(r=>setTimeout(r,300));
  const hidden=await send('Page.captureScreenshot',{format:'png'}),hiddenPath=path.join(out,'craft-hull-hidden.png');await fs.writeFile(hiddenPath,Buffer.from(hidden.data,'base64'));
  await evaluate(`document.querySelector('[aria-label="Craft trial time"]').closest('details').open=true`);
  await new Promise(r=>setTimeout(r,300));
  const restored=await send('Page.captureScreenshot',{format:'png'}),restoredPath=path.join(out,'craft-hull-restored.png');await fs.writeFile(restoredPath,Buffer.from(restored.data,'base64'));
  report.collisionHull.hidden={path:hiddenPath,sha256:await hash(hiddenPath)};report.collisionHull.restored={path:restoredPath,sha256:await hash(restoredPath)};
 }
 const after=await snapshot('craft-after');assert.deepEqual(after.project,initial.project);assert.deepEqual(await call('get_editor_state',{sessionId}),before);

 await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect route"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'1');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await probe(()=>evaluate(`!document.querySelector('[aria-label="Craft trial time"]')`),'route change clears trial');

 await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect route"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'0');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await probe(()=>evaluate(`document.querySelector('[aria-label="Inspect route"]').value==='0'`),'restore east route');
 if(process.env.WULFRAM_CRAFT_PLAYBACK_TEST==='1')assert.equal(await evaluate(`!!document.querySelector('[aria-label="Craft trial time"]')`),false);
 await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent==='Run craft trial')).click()`);
 await probe(()=>evaluate(`!!document.querySelector('[aria-label="Craft trial time"]')`),'trial exists before source change');
 const changed=structuredClone(fixture);changed.name+=' changed';const changedPath=path.join(out,'changed.json');await fs.writeFile(changedPath,JSON.stringify(changed));
 const changedDoc=await send('DOM.getDocument'),changedInput=await send('DOM.querySelector',{nodeId:changedDoc.root.nodeId,selector:'input[type="file"][multiple]'});
 await send('DOM.setFileInputFiles',{nodeId:changedInput.nodeId,files:[changedPath]});
 await probe(async()=>{const s=await call('get_editor_state',{sessionId});return s.name===changed.name;},'new project');
 assert.equal(await evaluate(`!!document.querySelector('[aria-label="Craft trial time"]')`),false);
 report.sourceInvalidation=true;
 report.trials=results;report.gui={...gui,screenshot:shotPath,sha256:await hash(shotPath),scrubbed:true};report.malformedMessages=true;report.readonly=true;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
