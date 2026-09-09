import {requestEditor,listSessions} from './editor-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.valleyPockets.library.exactLibrary,true);assert.equal(prior.valleyPockets.portable.applyUndo,true);
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
const resultOut=await fs.mkdtemp(path.join(prior.out,'valley-restart-'));
const report={out:resultOut,passed:false,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2])};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
process.env.WULFRAM_MCP_SESSION_DIR=path.join(prior.out,'valley-restart-sessions');
const app=spawn(prior.executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:process.env.WULFRAM_MCP_SESSION_DIR,WULFRAM_FORGE_USER_DATA_DIR:path.join(prior.out,'profile'),WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
let socket;const pending=new Map();let id=0;
const probe=async(fn)=>{const until=Date.now()+45000;while(Date.now()<until){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Restart readiness timed out');};
try{
 const target=await probe(async()=>{const list=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());return list.find(t=>t.url==='https://wulfram-forge.local/index.html');});
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(new Error('CDP timeout'));},15000);pending.set(seq,{resolve,reject,timer});socket.send(JSON.stringify({id:seq,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp'));
 const favorites=await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`);
 const exported=JSON.parse(await fs.readFile(prior.valleyPockets.library.exportPath,'utf8'));assert.deepEqual(favorites,exported.bases);const matching=favorites.filter(f=>f.id===prior.valleyPockets.library.favoriteId);assert.equal(matching.length,1);const favorite=matching[0];
 const fixture=JSON.parse(await fs.readFile(path.join(prior.out,'valley-favorite-destination.json'),'utf8'));fixture.name='Valley restart destination';fixture.terrain.tagmap=['0:1snow001'];fixture.terrain.tagmap2=['1snow001'];
 const file=path.join(resultOut,'valley-restart-destination.json');await fs.writeFile(file,JSON.stringify(fixture));
 const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});
 const session=await probe(async()=>{const sessions=await listSessions();return sessions.length===1&&sessions[0].name===fixture.name?sessions[0]:false;});
 const call=command=>requestEditor(session.sessionId,command),snapshot=async()=>{const state=await call({action:'get_editor_state'});return (await call({action:'get_snapshot',expectedRevision:state.revision})).project;};
 const initial=await snapshot();for(const key of ['terrain','entities','baseLayouts','activeBaseLayoutId'])assert.deepEqual(initial[key],fixture[key]);
 const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`));await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
 await click('Base builder');
 await probe(()=>evaluate(`document.querySelector('[aria-label="Formation favorites"]')?.options.length===${favorites.length+1}`));
 const before=await call({action:'get_editor_state'});
 await evaluate(`(()=>{const s=document.querySelector('[aria-label="Formation favorites"]');s.value=${JSON.stringify(favorite.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Preview formation');
 await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`));
 assert.deepEqual(await snapshot(),initial);const preview=await call({action:'get_editor_state'});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(preview[key],before[key]);
 await click('Apply formation');const after=await probe(async()=>{const r=await call({action:'get_editor_state'});return r.revision!==before.revision?r:false;});assert.equal(after.undoCount,before.undoCount+1);
 const applied=await snapshot(),layout=applied.baseLayouts.find(l=>l.id===applied.activeBaseLayoutId);assert.deepEqual(applied.terrain,initial.terrain);assert.equal(applied.baseLayouts.length,initial.baseLayouts.length+1);
 const areas=JSON.parse(layout.metadata['forge.build-areas.v1']);
 const sourceProject=JSON.parse(await fs.readFile(prior.valleyPockets.gui.copy,'utf8')),sourceLayout=sourceProject.baseLayouts.find(l=>l.id===sourceProject.activeBaseLayoutId),sourceRecord=JSON.parse(sourceLayout.metadata[`formation.valleyPockets.${sourceLayout.id}`]);
 const paths=[sourceRecord.plan.passage,...sourceRecord.plan.sites.map(s=>s.frontage)];assert.equal(areas.length,paths.length*2);
 for(const team of [1,2]){
  const sign=team===1?1:-1,cx=team===1?5000:15000;
  for(const [i,u] of favorite.template.units.entries()){
   const e=layout.entities.find(e=>e.id===`${layout.id}-${team}-${i}`);assert.ok(e);assert.equal(e.token,u.token);assert.equal(e.active,u.active);assert.ok(Math.hypot(e.position[0]-(cx+sign*u.offset[0]),e.position[1]-(8000+sign*u.offset[1]))<1e-6);
   assert.ok(Math.abs(Math.atan2(Math.sin(e.rotation[2]-(u.rotation[2]+(team===2?Math.PI:0))),Math.cos(e.rotation[2]-(u.rotation[2]+(team===2?Math.PI:0)))))<1e-5);
  }
  for(const [i,r] of paths.entries()){const a=areas.find(a=>a.id===`${layout.id}-route-${team}-${i}`);assert.ok(a);assert.equal(a.width,r.width);assert.equal(a.points.length,r.points.length);for(const [j,p] of r.points.entries())assert.ok(Math.hypot(a.points[j][0]-(cx+sign*p[0]),a.points[j][1]-(8000+sign*p[1]))<1e-6);}
 }
 for(const e of initial.entities)assert.deepEqual(applied.entities.find(a=>a.id===e.id),e);
 const access=JSON.parse(layout.metadata['formation.access']);assert.deepEqual(access.blocked,[]);assert.equal(access.clearance,96);
 const record=JSON.parse(layout.metadata[`formation.valleyPockets.${layout.id}`]);assert.deepEqual(record.shifts,favorite.valleyRecipe.shifts);assert.equal(record.serviceRoutes.length,2);assert.equal(new Set(record.serviceRoutes.map(r=>r.unitIndex)).size,2);assert.deepEqual([1,2].flatMap(team=>record.serviceRoutes.map(r=>`${layout.id}-${team}-${r.unitIndex}`)).sort((a,b)=>a.localeCompare(b)),layout.entities.filter(e=>record.entityIds.includes(e.id)&&['r','f'].includes(e.token)).map(e=>e.id).sort((a,b)=>a.localeCompare(b)));
 for(const team of [1,2])for(const route of record.serviceRoutes){const pad=layout.entities.find(e=>e.id===`${layout.id}-${team}-${route.unitIndex}`),sign=team===1?1:-1,cx=team===1?5000:15000;assert.ok(pad&&['r','f'].includes(pad.token));assert.ok(Math.hypot(pad.position[0]-(cx+sign*route.points[1][0]),pad.position[1]-(8000+sign*route.points[1][1]))<1e-6);}
 const saved=path.join(resultOut,'valley-restart-applied.json');await fs.writeFile(saved,JSON.stringify(applied));
 await click('Inspect');
 const screenshots=[];
 for(const label of ['Team 1 · Overhead','Team 2 · Overhead','Team 1 · Ground level','Team 2 · Ground level']){
  await click(label);await new Promise(r=>setTimeout(r,500));const shot=await send('Page.captureScreenshot',{format:'png'}),file=path.join(resultOut,label.replaceAll(' · ','-').replaceAll(' ','-')+'.png');await fs.writeFile(file,Buffer.from(shot.data,'base64'));screenshots.push(file);
 }
 for(const team of [1,2]){
  const entity=layout.entities.find(e=>e.team===team&&e.token==='r');assert.ok(entity);
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect building"]');s.value=${JSON.stringify(entity.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Close building view');await new Promise(r=>setTimeout(r,500));const shot=await send('Page.captureScreenshot',{format:'png'}),file=path.join(resultOut,`Team-${team}-Repair.png`);await fs.writeFile(file,Buffer.from(shot.data,'base64'));screenshots.push(file);
  const center=await evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for(let step=0;step<12;step++){await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:center.x,y:center.y,deltaX:0,deltaY:250});await new Promise(r=>setTimeout(r,80));}await new Promise(r=>setTimeout(r,700));
  const yardShot=await send('Page.captureScreenshot',{format:'png'}),yardFile=path.join(resultOut,`Team-${team}-Service-yard.png`);await fs.writeFile(yardFile,Buffer.from(yardShot.data,'base64'));screenshots.push(yardFile);
 }
 assert.deepEqual(await snapshot(),applied);report.cameraMapUnchanged=true;report.screenshots=screenshots;
 await call({action:'undo',expectedRevision:after.revision});const restored=await snapshot();assert.deepEqual(restored.baseLayouts,initial.baseLayouts);assert.deepEqual(restored.entities,initial.entities);assert.deepEqual(restored.terrain,initial.terrain);
 assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
 report.persistedExactLibrary=true;report.crossMapDimensions=[20000,16000];report.previewMapHistoryUnchanged=true;report.transformedGeometry=true;report.destinationAccess=true;report.applyUndo=true;report.appliedCopy=saved;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(resultOut,'valley-restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
