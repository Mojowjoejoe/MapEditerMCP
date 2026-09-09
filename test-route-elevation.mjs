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
const out=await fs.mkdtemp(path.join(here,'outputs','hill-elevation-native-'));
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
 const inspection=await call('inspect_routes',{sessionId,vehicleWidth:80});assert.equal(inspection.routes.length,2);
 assert.deepEqual(inspection.routes.map(r=>r.id),['hill-forward','hill-reverse']);
 assert.deepEqual(inspection.routes.map(r=>r.points),[forward,[...forward].reverse()]);
 const forwardSamples=inspection.routes[0].elevation.samples,reverseSamples=inspection.routes[1].elevation.samples;
 assert.equal(forwardSamples.length,reverseSamples.length);
 for(let i=0;i<forwardSamples.length;i++){const a=forwardSamples[i],b=reverseSamples[reverseSamples.length-1-i];assert.equal(a.x,b.x);assert.equal(a.y,b.y);assert.equal(a.height,b.height);assert.ok(Math.abs(a.distance+b.distance-3072)<1e-8);}
 assert.deepEqual([forwardSamples[0].x,forwardSamples.at(-1).x],[512,3584]);
 assert.deepEqual([reverseSamples[0].x,reverseSamples.at(-1).x],[3584,512]);

 for(const route of inspection.routes){
  const e=route.elevation;assert.equal(e.error,undefined);assert.equal(e.length,3072);assert.ok(Math.abs(e.ascent-400)<1e-6);assert.ok(Math.abs(e.descent-400)<1e-6);
  assert.ok(Math.abs(e.maxUphillDegrees-Math.atan(400/1536)*180/Math.PI)<1e-6);assert.ok(Math.abs(e.maxDownhillDegrees-e.maxUphillDegrees)<1e-6);
  assert.ok(e.samples.some(s=>s.x===2048&&s.height===400));assert.ok(e.samples[1].gradeDegrees>0);assert.ok(e.samples.at(-1).gradeDegrees<0);
 }
 await evaluate(`(()=>{const menu=[...document.querySelectorAll('.editor-menu-bar details')].find(d=>d.querySelector('summary')?.textContent==='Bases');menu.open=true;[...menu.querySelectorAll('button')].find(b=>b.textContent==='Inspect').click();})()`);
 await probe(()=>evaluate('!!document.querySelector(\'figure[aria-label="Sampled route elevation"]\')'),'elevation graph');
 const screenshots=[];
 for(let index=0;index<2;index++){
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect route"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'${index}');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await probe(()=>evaluate(`document.querySelector('[aria-label="Inspect route"]').value==='${index}'`),'route selection');
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Route progress"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'50');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await probe(()=>evaluate(`Number(document.querySelector('figure[aria-label="Sampled route elevation"] line').getAttribute('x1'))===150`),'crest marker');
  const actual=await evaluate(`(()=>{const f=document.querySelector('figure[aria-label="Sampled route elevation"]');return {points:f.querySelector('polyline').getAttribute('points'),text:f.textContent,label:f.querySelector('svg').getAttribute('aria-label')};})()`);
  assert.equal(actual.points,inspection.routes[index].elevation.samples.map(s=>`${10+s.distance/3072*280},${90-s.height/400*70}`).join(' '));assert.match(actual.label,/Current elevation 400/);assert.match(actual.text,/craft motion is not simulated/);
  await send('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('figure[aria-label="Sampled route elevation"]').scrollIntoView({block:'center'})`);
  const screen=await send('Page.captureScreenshot',{format:'png'}),file=path.join(out,`hill-${index}-960.png`);await fs.writeFile(file,Buffer.from(screen.data,'base64'));screenshots.push({path:file,sha256:await hash(file)});
  assert.ok(await evaluate(`(()=>{const f=document.querySelector('figure[aria-label="Sampled route elevation"]');return f.scrollWidth<=f.clientWidth;})()`));
 }
 if(process.env.WULFRAM_TEMPORARY_PATH_TEST==='1'){
  const temporary=await call('inspect_routes',{sessionId,vehicleWidth:80,points:forward});assert.equal(temporary.routes.length,1);assert.equal(temporary.routes[0].kind,'temporary');assert.deepEqual(temporary.routes[0].points,forward);assert.equal(temporary.routes[0].elevation.ascent,400);
  const rejected=await client.callTool({name:'inspect_routes',arguments:{sessionId,vehicleWidth:80,points:[[0,0],[-1,0]]}});assert.equal(rejected.isError,true);
  const click=async text=>{await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Missing enabled button');b.click();})()`);};
  const count=async n=>probe(()=>evaluate(`document.querySelector('.temporary-route-controls')?.textContent.includes('(${n}/32)')`),`path has ${n} points`);
  const groundClick=async fraction=>{const rect=await evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`),position={x:rect.x+rect.width*fraction,y:rect.y+rect.height*.9};await send('Input.dispatchMouseEvent',{type:'mouseMoved',...position});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...position});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...position});};
  await click('Draw inspection path');await count(0);await groundClick(.35);await count(1);
  assert.match(await evaluate(`document.querySelector('[data-route-clearance]').textContent`),/at least two points/);
  await groundClick(.65);await count(2);await click('Finish inspection path');
  await probe(()=>evaluate(`document.querySelector('.temporary-route-controls').textContent.includes('not saved to the map')`),'finished temporary path');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Inspect route"]').selectedOptions[0].textContent`),'Temporary inspection path');
  assert.ok(await evaluate(`!!document.querySelector('figure[aria-label="Sampled route elevation"] polyline')`));
  await evaluate(`document.querySelector('.temporary-route-controls').scrollIntoView({block:'center'})`);
  const drawnScreen=await send('Page.captureScreenshot',{format:'png'}),drawnPath=path.join(out,'temporary-path-960.png');await fs.writeFile(drawnPath,Buffer.from(drawnScreen.data,'base64'));

  await click('Remove last point');assert.match(await evaluate(`document.querySelector('[data-route-clearance]').textContent`),/at least two points/);
  await click('Clear inspection path');assert.equal(await evaluate(`document.querySelector('[aria-label="Inspect route"]').disabled`),false);
  await click('Draw inspection path');await groundClick(.4);await count(1);
  for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await probe(()=>evaluate(`!document.querySelector('.temporary-route-controls').textContent.includes('/32')`),'Escape cancels sketch');
  await click('Draw inspection path');await groundClick(.4);await count(1);
  await evaluate(`(()=>{const m=[...document.querySelectorAll('.editor-menu-bar details')].find(d=>d.querySelector('summary')?.textContent==='Terrain');m.open=true;[...m.querySelectorAll('button')].find(b=>b.textContent==='Raise').click();})()`);
  await probe(()=>evaluate(`!document.querySelector('.temporary-route-controls')`),'terrain mode clears inspection');
  await evaluate(`(()=>{const m=[...document.querySelectorAll('.editor-menu-bar details')].find(d=>d.querySelector('summary')?.textContent==='Bases');m.open=true;[...m.querySelectorAll('button')].find(b=>b.textContent==='Inspect').click();})()`);
  await probe(()=>evaluate(`!!document.querySelector('.temporary-route-controls')&&!document.querySelector('.temporary-route-controls').textContent.includes('/32')`),'mode return does not revive sketch');
  report.temporaryPath={screenshot:{path:drawnPath,sha256:await hash(drawnPath)},modeInvalidation:true,explicitMcp:true,invalidRejected:true,terrainClicks:true,incompleteLabel:true,finish:true,remove:true,clear:true,escape:true};
 }
 const after=await snapshot('hill-after');assert.deepEqual(after.project,initial.project);assert.deepEqual(await call('get_editor_state',{sessionId}),before);
 if(process.env.WULFRAM_TEMPORARY_PATH_TEST==='1'){
  await evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Draw inspection path')).click()`);
  const fresh=structuredClone(fixture);fresh.name+=' reopened';const changedPath=path.join(out,'hill-reopened.json');await fs.writeFile(changedPath,JSON.stringify(fresh));
  const freshDoc=await send('DOM.getDocument'),freshInput=await send('DOM.querySelector',{nodeId:freshDoc.root.nodeId,selector:'input[type="file"][multiple]'});
  await send('DOM.setFileInputFiles',{nodeId:freshInput.nodeId,files:[changedPath]});
  await probe(async()=>{const s=await call('get_editor_state',{sessionId});return s.name===fresh.name;},'new source loaded');
  assert.equal(await evaluate(`document.querySelector('.temporary-route-controls')?.textContent.includes('/32')??false`),false);
  report.temporaryPath.sourceInvalidation=true;report.temporaryPath.newSource={path:changedPath,sha256:await hash(changedPath)};
 }

 report.screenshots=screenshots;report.routes=inspection.routes;report.before={path:initial.path,sha256:await hash(initial.path)};report.after={path:after.path,sha256:await hash(after.path)};
 report.analyticHill=true;report.bothDirections=true;report.crestScrub=true;report.readonly=true;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
