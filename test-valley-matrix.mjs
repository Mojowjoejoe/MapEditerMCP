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
const resultOut=await fs.mkdtemp(path.join(prior.out,'valley-matrix-'));
const report={out:resultOut,passed:false,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2])};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
process.env.WULFRAM_MCP_SESSION_DIR=path.join(prior.out,'valley-matrix-sessions');
const app=spawn(prior.executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:process.env.WULFRAM_MCP_SESSION_DIR,WULFRAM_FORGE_USER_DATA_DIR:path.join(resultOut,'profile'),WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
let socket;const pending=new Map();let id=0;
const probe=async(fn)=>{const until=Date.now()+45000;while(Date.now()<until){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Restart readiness timed out');};
try{
 const target=await probe(async()=>{const list=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());return list.find(t=>t.url==='https://wulfram-forge.local/index.html');});
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(new Error('CDP timeout'));},15000);pending.set(seq,{resolve,reject,timer});socket.send(JSON.stringify({id:seq,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp'));
 const session=await probe(async()=>{const sessions=await listSessions();return sessions.length===1?sessions[0]:false;});
 const call=command=>requestEditor(session.sessionId,command),state=()=>call({action:'get_editor_state'}),snapshot=async()=>{const r=await state();return (await call({action:'get_snapshot',expectedRevision:r.revision})).project;};
 const source=JSON.parse(await fs.readFile(path.join(prior.out,'valley-favorite-destination.json'),'utf8'));
 report.cases=[];
 for(const [index,size] of ['small','standard','large','massive'].entries())for(const terrain of ['flat','valley','irregular'])for(const expanded of [false,true]){
  const fixture=structuredClone(source);fixture.name=`Valley ${size} ${terrain} ${expanded?'expanded':'default'}`;fixture.terrain.tagmap=['0:1snow001'];fixture.terrain.tagmap2=['1snow001'];
  fixture.terrain.heights=fixture.terrain.heights.map((_,i)=>terrain==='flat'?0:terrain==='valley'?Math.abs(Math.floor(i/129)-64)*4:40*Math.cos((i%129-64)/10)*Math.cos((Math.floor(i/129)-64)/10));
  const fixturePath=path.join(resultOut,`${size}-${terrain}-${expanded}-source.json`);await fs.writeFile(fixturePath,JSON.stringify(fixture));
  const {root}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[fixturePath]});
  await probe(async()=>{const p=await snapshot();return p.name===fixture.name;});const initial=await snapshot();for(const key of ['terrain','entities','baseLayouts','activeBaseLayoutId'])assert.deepEqual(initial[key],fixture[key]);
  const targetCount=[10,15,20,30][index]+(expanded?4:0),placement={size,x:5000,y:8000,rotation:35,radius:3300,targetCount},layoutId=`matrix-${size}-${terrain}-${expanded}`,request={activeLayoutId:initial.activeBaseLayoutId,layoutId,style:'valley-pockets',seed:'count-0',placement};
  const before=await state(),preview=await call({action:'generate_base_layout',expectedRevision:before.revision,request,previewOnly:true});assert.deepEqual(await snapshot(),initial);
  const appliedState=await call({action:'generate_base_layout',expectedRevision:before.revision,request,previewOnly:false});assert.equal(appliedState.undoCount,before.undoCount+1);
  const applied=await snapshot(),layout=applied.baseLayouts.find(l=>l.id===layoutId);assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(applied.terrain,initial.terrain);for(const team of [1,2])assert.equal(layout.entities.filter(e=>e.team===team).length,targetCount);
  const captured=await call({action:'capture_formation_favorite',expectedRevision:appliedState.revision,activeLayoutId:layoutId,favoriteId:'matrix-favorite'});assert.deepEqual(await snapshot(),applied);
  await call({action:'undo',expectedRevision:appliedState.revision});const undone=await snapshot();for(const key of ['terrain','entities','baseLayouts'])assert.deepEqual(undone[key],initial[key]);
  const reuseBefore=await state(),favoriteRequestJson=JSON.stringify({activeLayoutId:initial.activeBaseLayoutId,layoutId:`${layoutId}-reuse`,favoriteId:'matrix-favorite',placement});
  const reusePreview=await call({action:'place_formation_favorite',expectedRevision:reuseBefore.revision,packageJson:captured.packageJson,favoriteRequestJson,previewOnly:true});assert.deepEqual(await snapshot(),undone);
  const reuseState=await call({action:'place_formation_favorite',expectedRevision:reuseBefore.revision,packageJson:captured.packageJson,favoriteRequestJson,previewOnly:false});assert.equal(reuseState.undoCount,reuseBefore.undoCount+1);
  const reused=await snapshot(),active=reused.baseLayouts.find(l=>l.id===reused.activeBaseLayoutId);assert.deepEqual(active.entities,reusePreview.layout.entities);assert.deepEqual(reused.terrain,initial.terrain);
  const units=JSON.parse(captured.packageJson).bases[0].template.units,yaw=35*Math.PI/180;
  for(const team of [1,2])for(const [i,u] of units.entries()){const e=active.entities.find(e=>e.id===`${active.id}-${team}-${i}`),x=5000+u.offset[0]*Math.cos(yaw)-u.offset[1]*Math.sin(yaw),y=8000+u.offset[0]*Math.sin(yaw)+u.offset[1]*Math.cos(yaw);assert.ok(e);assert.ok(Math.hypot(e.position[0]-(team===1?x:20000-x),e.position[1]-(team===1?y:16000-y))<1e-6);}
  for(const e of initial.entities)assert.deepEqual(active.entities.find(x=>x.id===e.id),e);
  const record=JSON.parse(active.metadata[`formation.valleyPockets.${active.id}`]);assert.equal(record.serviceRoutes.length,2);assert.equal(new Set(record.serviceRoutes.map(r=>r.unitIndex)).size,2);assert.equal(active.entities.filter(e=>record.entityIds.includes(e.id)&&['r','f'].includes(e.token)).length,4);assert.deepEqual(JSON.parse(active.metadata['formation.access']).blocked,[]);
  assert.equal(JSON.parse(active.metadata['formation.access']).clearance,96);
  const padIds=[1,2].flatMap(team=>record.serviceRoutes.map(r=>`${active.id}-${team}-${r.unitIndex}`)).sort((a,b)=>a.localeCompare(b));assert.deepEqual(padIds,active.entities.filter(e=>record.entityIds.includes(e.id)&&['r','f'].includes(e.token)).map(e=>e.id).sort((a,b)=>a.localeCompare(b)));
  for(const team of [1,2])for(const r of record.serviceRoutes){const pad=active.entities.find(e=>e.id===`${active.id}-${team}-${r.unitIndex}`),[x,y]=r.points[1],wx=5000+x*Math.cos(yaw)-y*Math.sin(yaw),wy=8000+x*Math.sin(yaw)+y*Math.cos(yaw);assert.ok(pad);assert.ok(Math.hypot(pad.position[0]-(team===1?wx:20000-wx),pad.position[1]-(team===1?wy:16000-wy))<1e-6);}
  const generatedRecord=JSON.parse(layout.metadata[`formation.valleyPockets.${layout.id}`]);for(const key of ['plan','originalPlan','shifts','siteUnitIndices','serviceRoutes'])assert.deepEqual(record[key],generatedRecord[key]);
  const originalAreas=JSON.parse(layout.metadata['forge.build-areas.v1']),reusedAreas=JSON.parse(active.metadata['forge.build-areas.v1']);assert.deepEqual(reusedAreas.map(a=>({...a,id:a.id.replace(active.id,'instance')})),originalAreas.map(a=>({...a,id:a.id.replace(layout.id,'instance')})));

  const copy=path.join(resultOut,`${size}-${terrain}-${expanded}-reused.json`);await fs.writeFile(copy,JSON.stringify(reused));
  await call({action:'undo',expectedRevision:reuseState.revision});const restored=await snapshot();for(const key of ['terrain','entities','baseLayouts'])assert.deepEqual(restored[key],initial[key]);
  report.cases.push({size,terrain,expanded,targetCount,fixture:fixturePath,copy,sha256:createHash('sha256').update(await fs.readFile(copy)).digest('hex'),passed:true});
 }
 assert.equal(report.cases.length,24);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(resultOut,'valley-matrix-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
