import {requestEditor,listSessions} from './editor-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.brokenRingPortable.reuseApplyUndo,true);
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
const executable=path.resolve(process.argv[3]??prior.executable),executableSha256=createHash('sha256').update(await fs.readFile(executable)).digest('hex');
const resultOut=await fs.mkdtemp(path.join(prior.out,'brokenRing-restart-'));
const report={out:resultOut,passed:false,executable,executableSha256,sourceExecutable:prior.executable,sourceExecutableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2])};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
process.env.WULFRAM_MCP_SESSION_DIR=path.join(prior.out,'brokenRing-restart-sessions');
const app=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:process.env.WULFRAM_MCP_SESSION_DIR,WULFRAM_FORGE_USER_DATA_DIR:path.join(prior.out,'profile'),WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
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
 const exported=JSON.parse(await fs.readFile((prior.brokenRingPortable??prior.courtyardPortable).exportPath,'utf8'));assert.deepEqual(favorites,exported.bases);const matching=favorites.filter(f=>f.reservations?.family==='broken-ring');assert.equal(matching.length,1);const favorite=matching[0];
 const fixture=JSON.parse(await fs.readFile(path.resolve(process.env.WULFRAM_BROKEN_RING_TEST_MAP),'utf8'));fixture.name='Broken Ring restart destination';fixture.terrain.worldWidth=18000;fixture.terrain.worldHeight=14000;fixture.terrain.tagmap=['0:1snow001'];fixture.terrain.tagmap2=['1snow001'];
 const file=path.join(resultOut,'brokenRing-restart-destination.json');await fs.writeFile(file,JSON.stringify(fixture));
 const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});
 const session=await probe(async()=>{const sessions=await listSessions();return sessions.length===1&&sessions[0].name===fixture.name?sessions[0]:false;});
 const call=command=>requestEditor(session.sessionId,command),snapshot=async()=>{const state=await call({action:'get_editor_state'});return (await call({action:'get_snapshot',expectedRevision:state.revision})).project;};
 const initial=await snapshot();assert.deepEqual(initial.terrain,fixture.terrain);
 const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`));await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
 await click('Base builder');
 await probe(()=>evaluate(`document.querySelector('[aria-label="Formation favorites"]')?.options.length===${favorites.length+1}`));
 const before=await call({action:'get_editor_state'});
 await evaluate(`(()=>{const s=document.querySelector('[aria-label="Formation favorites"]');s.value=${JSON.stringify(favorite.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Preview formation');
 await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`));
 assert.deepEqual(await snapshot(),initial);const preview=await call({action:'get_editor_state'});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(preview[key],before[key]);
 await click('Apply formation');const after=await probe(async()=>{const r=await call({action:'get_editor_state'});return r.revision!==before.revision?r:false;});assert.equal(after.undoCount,before.undoCount+1);
 const applied=await snapshot(),layout=applied.baseLayouts.find(l=>l.id===applied.activeBaseLayoutId);assert.deepEqual(applied.terrain,initial.terrain);assert.equal(applied.baseLayouts.length,initial.baseLayouts.length+1);
 const areas=JSON.parse(layout.metadata['forge.build-areas.v1']);assert.equal(areas.length,10);
 favorite.reservations.areas.forEach((a,i)=>{const actual=areas[i],x=a.side===1?4500:13500,y=7000,sign=a.side===1?1:-1;assert.equal(actual.id,a.id);assert.equal(actual.width,a.width);a.points.forEach((p,j)=>p.forEach((n,k)=>assert.ok(Math.abs(actual.points[j][k]-((k===0?x:y)+sign*n))<1e-6)));});
 for(const team of [1,2]){const entities=layout.entities.filter(e=>e.team===team);assert.equal(entities.length,favorite.template.units.length);entities.forEach((e,i)=>{const u=favorite.template.units[i],sign=team===1?1:-1;assert.equal(e.token,u.token);assert.equal(e.active,u.active);assert.ok(Math.abs(e.position[0]-((team===1?4500:13500)+sign*u.offset[0]))<1e-5);assert.ok(Math.abs(e.position[1]-(7000+sign*u.offset[1]))<1e-5);assert.ok(Math.abs(Math.atan2(Math.sin(e.rotation[2]-(u.rotation[2]+(team===2?Math.PI:0))),Math.cos(e.rotation[2]-(u.rotation[2]+(team===2?Math.PI:0)))))<1e-5);});}
 assert.deepEqual(areas.map(a=>a.id).sort(),[1,2].flatMap(t=>[0,1,2,3,4].map(i=>`broken-ring-${t}-${i}`)).sort());
 const access=JSON.parse(layout.metadata['formation.brokenRingAccess']);assert.equal(access.vehicleWidth,80);
 assert.deepEqual(access.routes.map(r=>r.id).sort(),[1,2].flatMap(t=>[0,1,2,3].map(i=>`broken-ring-${t}-${i}`)).sort());
 for(const route of access.routes){const points=areas.find(a=>a.id===route.id).points;assert.equal(route.points.length,points.length);route.points.forEach((p,i)=>{assert.equal(p.length,2);p.forEach((n,j)=>assert.ok(Number.isFinite(n)&&Math.abs(n-points[i][j])<1e-6));});assert.ok(!route.markers.some(m=>m.severity==='blocked'));}
 assert.deepEqual(JSON.parse(layout.metadata['formation.brokenRingPlan']),favorite.reservations.brokenRingPlan);
 if(favorite.reservations.brokenRingPlan.version==='broken-ring-v3'){const service=access.serviceAccess,pads=layout.entities.filter(e=>['r','f'].includes(e.token));assert.equal(service.clearance,96);assert.equal(service.routes.length,pads.length);for(const pad of pads)assert.equal(service.routes.filter(r=>Math.hypot(r.points[0][0]-pad.position[0],r.points[0][1]-pad.position[1])<1e-6).length,1);assert.ok(service.routes.every(r=>r.markers.length===0));}
 const saved=path.join(resultOut,'brokenRing-restart-applied.json');await fs.writeFile(saved,JSON.stringify(applied));
 await click('Inspect');
 const screenshots=[];
 for(const label of ['Team 1 · Overhead','Team 2 · Overhead','Team 1 · Ground level','Team 2 · Ground level']){
  await click(label);await new Promise(r=>setTimeout(r,500));const shot=await send('Page.captureScreenshot',{format:'png'}),file=path.join(resultOut,label.replaceAll(' · ','-').replaceAll(' ','-')+'.png');await fs.writeFile(file,Buffer.from(shot.data,'base64'));screenshots.push(file);
 }
 for(const team of [1,2]){
  const entity=layout.entities.find(e=>e.team===team&&e.token==='r');assert.ok(entity);
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect building"]');s.value=${JSON.stringify(entity.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Close building view');await new Promise(r=>setTimeout(r,500));const shot=await send('Page.captureScreenshot',{format:'png'}),file=path.join(resultOut,`Team-${team}-Repair.png`);await fs.writeFile(file,Buffer.from(shot.data,'base64'));screenshots.push(file);
 }
 assert.deepEqual(await snapshot(),applied);report.cameraMapUnchanged=true;report.screenshots=screenshots;
 await call({action:'undo',expectedRevision:after.revision});const restored=await snapshot();assert.deepEqual(restored.baseLayouts,initial.baseLayouts);assert.deepEqual(restored.entities,initial.entities);assert.deepEqual(restored.terrain,initial.terrain);
 assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
 report.persistedExactLibrary=true;report.crossMapDimensions=[18000,14000];report.previewMapHistoryUnchanged=true;report.transformedGeometry=true;report.destinationAccess=true;report.applyUndo=true;report.appliedCopy=saved;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(resultOut,'brokenRing-restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
