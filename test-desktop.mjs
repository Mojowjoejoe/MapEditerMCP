import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readMapArchive} from './lib/map-package.ts';
import {CATALOG} from './lib/wulfram.ts';
import {resolveEditorRoot} from './editor-root.mjs';
import {requestEditor} from './editor-client.mjs';
const packageRoot=path.dirname(fileURLToPath(import.meta.url));
const root=resolveEditorRoot();
await fs.mkdir(path.join(packageRoot,'outputs'),{recursive:true});
const out=await fs.mkdtemp(path.join(packageRoot,'outputs','mcp-native-test-'));
const sessionDir=path.join(out,'sessions'),profile=path.join(out,'profile');
const exe=process.env.WULFRAM_MCP_TEST_EXE?path.resolve(process.env.WULFRAM_MCP_TEST_EXE):path.join(root,'dist/desktop/mcp-v0.1.0/WulframForge.exe');
const fixture=path.join(packageRoot,'fixtures/three-lane-citadel/Three-Lane-Citadel-v1.zip');
const original=JSON.parse(await fs.readFile(path.join(packageRoot,'fixtures/three-lane-citadel/project.json'),'utf8'));
const report={passed:false,steps:[],out,executable:exe,executableSha256:createHash('sha256').update(await fs.readFile(exe)).digest('hex')};
if(process.env.WULFRAM_ALLOW_FOREGROUND_TEST!=='1'){
 const capability=JSON.parse(await fs.readFile(path.join(path.dirname(exe),'background-test-capability.json'),'utf8'));
 assert.equal(capability.version,1,'Unsupported background host capability');
 assert.equal(capability.executableSha256.toLowerCase(),report.executableSha256,'Background capability does not match executable; refusing to launch an unverified foreground host');
 report.backgroundTest=true;
}
const probe=async(fn,label)=>{const until=Date.now()+45000;while(Date.now()<until){try{const r=await fn();if(r)return r;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error(`Timeout: ${label}`);};
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
let app,socket,client;const pending=new Map();let sequence=0;
try{
  app=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_BACKGROUND_TEST:process.env.WULFRAM_ALLOW_FOREGROUND_TEST==='1'?'0':'1',WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:sessionDir,WULFRAM_FORGE_USER_DATA_DIR:profile,WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
  app.on('error',e=>console.error(e));
  const target=await probe(async()=>{const targets=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());return targets.find(t=>t.url==='https://wulfram-forge.local/index.html');},'native editor');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {resolve,reject,timer}=pending.get(m.id);clearTimeout(timer);pending.delete(m.id);if(m.error)reject(new Error(m.error.message));else resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  await probe(()=>evaluate('!!window.wulframMcp && !!document.querySelector(\'input[type="file"][multiple]\')'),'MCP editor bridge');
  if(report.backgroundTest){
   for(const action of ['configure','publish','game-test-configure','game-test-start']){
    const reply=await evaluate(`new Promise((resolve,reject)=>{const id='background-check-'+${JSON.stringify(action)};const timer=setTimeout(()=>{chrome.webview.removeEventListener('message',receive);reject(new Error('Native background rejection timed out'));},5000);function receive(event){if(event.data?.id!==id)return;clearTimeout(timer);chrome.webview.removeEventListener('message',receive);resolve(event.data);}chrome.webview.addEventListener('message',receive);chrome.webview.postMessage({id,action:${JSON.stringify(action)}});})`);
    assert.equal(reply.ok,false);assert.match(reply.error,/background test mode/);
   }
   report.steps.push('Background native host rejects repository dialogs/publication and game configuration/launch');
  }
  // CDP imports the fixture and deliberately stalls the renderer for deadline tests.
  // Map operations use MCP stdio + native pipe, except the explicit short-budget
  // regression which exercises the same native pipe client directly.
  const {root:document}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:document.nodeId,selector:'input[type="file"][multiple]'});
  await send('DOM.setFileInputFiles',{nodeId,files:[fixture]});
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(packageRoot,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessionDir},stderr:'pipe'});
  client=new Client({name:'forge-native-acceptance',version:'1'});await client.connect(transport);
  const callRaw=(name,args={})=>client.callTool({name,arguments:args});
  const call=async(name,args={})=>{const r=await callRaw(name,args);if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
  const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name==='Three Lane Citadel');},'imported fixture via MCP');
  const sessionId=session.sessionId;
  let state=await call('inspect_map',{sessionId});assert.deepEqual(state.entities,original.entities);report.steps.push('Real MCP discovery and native imported-map inspection');
  const parallel=await Promise.all([call('get_editor_state',{sessionId}),call('inspect_map',{sessionId}),call('validate_map',{sessionId})]);
  assert.ok(parallel.every(result=>result.revision===state.revision));report.steps.push('Concurrent same-session MCP reads succeed');
  let elevationBefore,elevationHistory;
  if(process.env.WULFRAM_ROUTE_ELEVATION_TEST==='1'){
    elevationHistory=await call('get_editor_state',{sessionId});
    const copy=await call('save_copy',{sessionId,expectedRevision:elevationHistory.revision,name:`elevation-before-${Date.now()}`});elevationBefore=JSON.parse(await fs.readFile(copy.path,'utf8'));
  }
  const routeRead=await call('inspect_routes',{sessionId,vehicleWidth:80});
  assert.equal(routeRead.revision,state.revision);assert.equal(routeRead.undoCount,state.undoCount);assert.equal(routeRead.vehicleWidth,80);assert.ok(routeRead.routes.length>0);assert.ok(routeRead.routes.every(r=>['service','authored'].includes(r.kind)&&r.length>0&&Array.isArray(r.markers)));
  if(process.env.WULFRAM_ROUTE_ELEVATION_TEST==='1'){
    const {routeElevation}=await import(pathToFileURL(path.join(root,'lib/route-elevation.ts')));
    let budget=20000;for(const route of routeRead.routes){const expected=routeElevation(elevationBefore.terrain,route.points,Math.min(10001,budget));assert.deepEqual(route.elevation,expected);budget-=expected.samples.length;}
    assert.ok(routeRead.routes.some(r=>r.elevation.samples.length>1));
    assert.deepEqual(await call('get_editor_state',{sessionId}),elevationHistory);
    const copy=await call('save_copy',{sessionId,expectedRevision:elevationHistory.revision,name:`elevation-after-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(copy.path,'utf8')),elevationBefore);
    report.routeElevation={sharedSamples:true,withinBudget:budget>=0,readonly:true};
  }
  assert.equal((await callRaw('inspect_routes',{sessionId,vehicleWidth:0})).isError,true);
  assert.equal((await call('get_editor_state',{sessionId})).revision,state.revision);
  report.steps.push('Read-only route inspection returns geometry and width-specific clearance without a revision or Undo change');
  const protectionBefore=state,activeLayoutId=state.activeBaseLayoutId;
  const protectionEdit={operation:'add',name:'MCP protected ridge',x:6200,y:1000,width:400,height:400};
  const added=await call('edit_terrain_protection',{sessionId,expectedRevision:state.revision,activeLayoutId,edit:protectionEdit});
  assert.notEqual(added.revision,state.revision);assert.equal(added.undoCount,state.undoCount+1);
  state=await call('inspect_map',{sessionId});
  assert.ok(state.terrainProtection.find(l=>l.layoutId===activeLayoutId).areas.some(a=>a.id===added.affectedAreaId));
  const protectionCopy=await call('save_copy',{sessionId,expectedRevision:state.revision,name:`protection-${Date.now()}`});
  const protectedProject=JSON.parse(await fs.readFile(protectionCopy.path,'utf8'));
  assert.deepEqual(protectedProject.terrain,original.terrain);assert.deepEqual(protectedProject.entities,original.entities);
  assert.ok(JSON.parse(protectedProject.baseLayouts.find(l=>l.id===activeLayoutId).metadata['forge.build-areas.v1']).some(a=>a.id===added.affectedAreaId));
  for(const args of [{expectedRevision:protectionBefore.revision,activeLayoutId,edit:protectionEdit},{expectedRevision:state.revision,activeLayoutId:'wrong',edit:protectionEdit},{expectedRevision:state.revision,activeLayoutId,edit:{operation:'remove',id:'missing'}},{expectedRevision:state.revision,activeLayoutId,edit:{...protectionEdit,allowAreaChanges:true}}]){
    assert.equal((await callRaw('edit_terrain_protection',{sessionId,...args})).isError,true);
    const unchanged=await call('inspect_map',{sessionId});assert.equal(unchanged.revision,state.revision);assert.equal(unchanged.undoCount,state.undoCount);
  }
  const blocked=await callRaw('edit_terrain',{sessionId,expectedRevision:state.revision,brush:{operation:'raise',x:6400,y:1200,radius:120,value:5}});
  assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/heights are protected/);assert.equal((await call('get_editor_state',{sessionId})).revision,state.revision);
  const naturalStamp={preset:'mesa',x:6400,y:1200,radius:400,aspect:1,length:800,width:600,rotation:0,amplitude:80,edgePower:2,mirror:false,shapeVersion:'natural-v2'};
  const blockedStamp=await callRaw('apply_landform',{sessionId,expectedRevision:state.revision,placementMode:'manual',stamp:naturalStamp});
  assert.equal(blockedStamp.isError,true);assert.match(blockedStamp.content[0].text,/heights are protected/);assert.equal((await call('get_editor_state',{sessionId})).revision,state.revision);
  const lane={...(process.env.WULFRAM_CURVED_LANE_TEST==='1'?{bend:.5}:{}),points:[[6000,1200],[6800,1200]],width:200,shoulder:100,floorHeight:40,operation:'cut-fill',mirror:false,placementMode:'manual'};
  const blockedLane=await callRaw('apply_lane',{sessionId,expectedRevision:state.revision,lane});
  assert.equal(blockedLane.isError,true);assert.match(blockedLane.content[0].text,/heights are protected/);assert.equal((await call('get_editor_state',{sessionId})).revision,state.revision);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'public/assets/manifest.json'),'utf8'));
  const texture=Object.keys(manifest.terrainTextures).find(t=>!original.terrain.tagmap.includes(t));assert.ok(texture);
  const painted=await call('edit_terrain',{sessionId,expectedRevision:state.revision,brush:{operation:'texture',x:6400,y:1200,radius:120,texture}});
  const paintCopy=await call('save_copy',{sessionId,expectedRevision:painted.revision,name:`protected-paint-${Date.now()}`});
  const paintedProject=JSON.parse(await fs.readFile(paintCopy.path,'utf8'));
  assert.deepEqual(paintedProject.terrain.heights,original.terrain.heights);assert.notDeepEqual(paintedProject.terrain,original.terrain);
  await call('undo',{sessionId,expectedRevision:painted.revision});state=await call('inspect_map',{sessionId});
  const second=await call('edit_terrain_protection',{sessionId,expectedRevision:state.revision,activeLayoutId,edit:{...protectionEdit,name:'Second ridge',y:2000}});
  assert.equal(second.undoCount,state.undoCount+1);await call('undo',{sessionId,expectedRevision:second.revision});state=await call('inspect_map',{sessionId});
  const removed=await call('edit_terrain_protection',{sessionId,expectedRevision:state.revision,activeLayoutId,edit:{operation:'remove',id:added.affectedAreaId}});
  assert.notEqual(removed.revision,state.revision);assert.equal(removed.undoCount,state.undoCount+1);
  state=await call('inspect_map',{sessionId});assert.ok(!state.terrainProtection.find(l=>l.layoutId===activeLayoutId).areas.some(a=>a.id===added.affectedAreaId));
  const removedCopy=await call('save_copy',{sessionId,expectedRevision:state.revision,name:`removed-protection-${Date.now()}`});
  const removedProject=JSON.parse(await fs.readFile(removedCopy.path,'utf8'));
  assert.ok(!JSON.parse(removedProject.baseLayouts.find(l=>l.id===activeLayoutId).metadata['forge.build-areas.v1']).some(a=>a.id===added.affectedAreaId));
  assert.deepEqual(removedProject.terrain,original.terrain);assert.deepEqual(removedProject.entities,original.entities);
  await call('undo',{sessionId,expectedRevision:state.revision});state=await call('inspect_map',{sessionId});
  assert.ok(state.terrainProtection.find(l=>l.layoutId===activeLayoutId).areas.some(a=>a.id===added.affectedAreaId));
  await call('undo',{sessionId,expectedRevision:state.revision});state=await call('inspect_map',{sessionId});assert.deepEqual(state.terrainProtection,protectionBefore.terrainProtection);
  report.steps.push('Protection MCP: add to empty/existing rules, strict schema, stale/wrong layout rejection, height guard, saved metadata, remove and Undo');
  for(const preset of ['mesa','basin']){
    const stamped=await call('apply_landform',{sessionId,expectedRevision:state.revision,placementMode:'manual',stamp:{...naturalStamp,preset}});
    assert.ok(stamped.vertices>0);assert.notEqual(stamped.revision,state.revision);assert.equal(stamped.undoCount,state.undoCount+1);
    const copy=await call('save_copy',{sessionId,expectedRevision:stamped.revision,name:`${preset}-${Date.now()}`});
    const stampedProject=JSON.parse(await fs.readFile(copy.path,'utf8'));
    assert.notDeepEqual(stampedProject.terrain.heights,original.terrain.heights);assert.deepEqual(stampedProject.entities,original.entities);
    assert.equal(JSON.parse(stampedProject.metadata['terrainStamp.last']).preset,preset);
    assert.equal((await callRaw('apply_landform',{sessionId,expectedRevision:state.revision,placementMode:'manual',stamp:naturalStamp})).isError,true);
    await call('undo',{sessionId,expectedRevision:stamped.revision});state=await call('inspect_map',{sessionId});
    const undoCopy=await call('save_copy',{sessionId,expectedRevision:state.revision,name:`undo-${preset}-${Date.now()}`});
    const undone=JSON.parse(await fs.readFile(undoCopy.path,'utf8'));assert.deepEqual(undone.terrain,original.terrain);
  }
  report.steps.push('Mesa/basin MCP placement and saved metadata, stale rejection, protected-rule rejection and one-step Undo');
  const laneResult=await call('apply_lane',{sessionId,expectedRevision:state.revision,lane});
  assert.ok(laneResult.vertices>0);assert.equal(laneResult.undoCount,state.undoCount+1);
  const laneCopy=await call('save_copy',{sessionId,expectedRevision:laneResult.revision,name:`lane-${Date.now()}`});
  const laneProject=JSON.parse(await fs.readFile(laneCopy.path,'utf8'));
  assert.notDeepEqual(laneProject.terrain.heights,original.terrain.heights);assert.deepEqual(laneProject.entities,original.entities);assert.deepEqual(laneProject.terrain.textureIds,original.terrain.textureIds);
  assert.deepEqual(JSON.parse(laneProject.metadata['terrainLane.last']).points,lane.points);
  if(process.env.WULFRAM_CURVED_LANE_TEST==='1'){assert.equal(JSON.parse(laneProject.metadata['terrainLane.last']).bend,.5);assert.equal(JSON.parse(laneProject.metadata['terrainLane.last']).version,2);report.curvedLane=true;}
  assert.equal((await callRaw('apply_lane',{sessionId,expectedRevision:state.revision,lane})).isError,true);
  await call('undo',{sessionId,expectedRevision:laneResult.revision});state=await call('inspect_map',{sessionId});
  const laneUndo=await call('save_copy',{sessionId,expectedRevision:state.revision,name:`lane-undo-${Date.now()}`});
  assert.deepEqual(JSON.parse(await fs.readFile(laneUndo.path,'utf8')).terrain,original.terrain);
  report.steps.push('Lane MCP placement, protected rejection, metadata, stale revision rejection and one-step Undo');
  if(process.env.WULFRAM_EDITOR_BRUSH_TEST==='1'){
    const {testManualBrushNative}=await import(pathToFileURL(path.join(root,'tools/test-manual-brush-native.mjs')).href);
    report.editorBrush=await testManualBrushNative({call,callRaw,sessionId,root});state=await call('inspect_map',{sessionId});
  }
  const e=state.entities.find(e=>e.id==='team-1-base-tower-upper'),oldRevision=state.revision;
  const moved=await call('edit_entities',{sessionId,expectedRevision:state.revision,edits:[{operation:'move',id:e.id,x:e.position[0]+10,mirror:true}]});
  assert.notEqual(moved.revision,oldRevision);assert.equal(moved.undoCount,state.undoCount+1);assert.equal(moved.dirty,true);
  state=await call('inspect_map',{sessionId});assert.equal(state.entities.find(e=>e.id==='team-1-base-tower-upper').position[0],1560);assert.equal(state.entities.find(e=>e.id==='team-2-base-tower-upper').position[0],11240);report.steps.push('Mirrored tower move acknowledged after React commit, one undo step');
  const stale=await callRaw('undo',{sessionId,expectedRevision:oldRevision});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/Stale/);report.steps.push('Stale revision rejected without change');
  const shot=await callRaw('capture_view',{sessionId});assert.equal(shot.content[0].type,'image');await fs.writeFile(path.join(out,'moved-editor.png'),Buffer.from(shot.content[0].data,'base64'));report.steps.push('Native PNG screenshot through MCP');
  await call('undo',{sessionId,expectedRevision:state.revision});state=await call('inspect_map',{sessionId});assert.deepEqual(state.entities,original.entities);assert.notEqual(state.revision,oldRevision);report.steps.push('One-step undo restored both towers; old revision remains stale');
  const invalid=await callRaw('edit_entities',{sessionId,expectedRevision:state.revision,edits:[{operation:'move',id:e.id,x:6400}]});assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/validation/);assert.equal((await call('get_editor_state',{sessionId})).revision,state.revision);report.steps.push('Invalid power placement rejected atomically');
  const terrain=await call('edit_terrain',{sessionId,expectedRevision:state.revision,brush:{operation:'raise',x:6400,y:1200,radius:120,value:5,mirror:true}});assert.ok(terrain.vertices>0);
  await call('undo',{sessionId,expectedRevision:terrain.revision});state=await call('get_editor_state',{sessionId});report.steps.push('Mirrored terrain brush and undo');
  const name=`native-test-${Date.now()}`;
  const saved=await call('save_copy',{sessionId,expectedRevision:state.revision,name});const snapshot=JSON.parse(await fs.readFile(saved.path,'utf8'));assert.deepEqual(snapshot.terrain,original.terrain);assert.deepEqual(snapshot.entities,original.entities);
  const archive=await call('export_map',{sessionId,expectedRevision:state.revision,name});const entries=await readMapArchive(await fs.readFile(archive.path));const reopened=JSON.parse(entries.find(e=>e.name.endsWith('/wulfram-project.json')).text);assert.deepEqual(reopened.terrain,original.terrain);assert.deepEqual(reopened.entities,original.entities);report.steps.push('Snapshot and ZIP roundtrip match restored live map');
  const collision=await callRaw('save_copy',{sessionId,expectedRevision:state.revision,name});assert.equal(collision.isError,true);assert.match(collision.content[0].text,/EEXIST/);report.steps.push('Existing export cannot be overwritten');
  const validation=await call('validate_map',{sessionId});assert.equal(validation.issues.filter(i=>i.severity==='error').length,0);
  // Occupy the renderer beyond both transport deadlines. A queued edit must
  // expire before dispatch even after the renderer becomes responsive again.
  const beforeTimeout=await call('inspect_map',{sessionId});
  await evaluate('setTimeout(()=>{const deadline=Date.now()+32000;while(Date.now()<deadline){}},100);true');
  await new Promise(resolve=>setTimeout(resolve,250));
  const expired=await callRaw('edit_entities',{sessionId,expectedRevision:beforeTimeout.revision,edits:[{operation:'move',id:e.id,x:e.position[0]+10,mirror:true}]});
  assert.equal(expired.isError,true);
  await probe(()=>evaluate('true'),'renderer after delayed dispatch');
  const afterTimeout=await call('inspect_map',{sessionId});
  assert.equal(afterTimeout.revision,beforeTimeout.revision);
  assert.deepEqual(afterTimeout.entities,beforeTimeout.entities);
  report.steps.push('Timed-out queued edit never applies after renderer recovery');
  const previousSessions=process.env.WULFRAM_MCP_SESSION_DIR;
  process.env.WULFRAM_MCP_SESSION_DIR=sessionDir;
  try {
    await evaluate('setTimeout(()=>{const deadline=Date.now()+2000;while(Date.now()<deadline){}},100);true');
    await new Promise(resolve=>setTimeout(resolve,250));
    await assert.rejects(requestEditor(sessionId,{action:'edit_entities',expectedRevision:afterTimeout.revision,edits:[{operation:'move',id:e.id,x:e.position[0]+10,mirror:true}]},500),/timed out|expired|closed|disconnected/i);
    await probe(()=>evaluate('true'),'renderer after short client deadline');
    const afterShortDeadline=await call('inspect_map',{sessionId});
    assert.equal(afterShortDeadline.revision,afterTimeout.revision);
    assert.deepEqual(afterShortDeadline.entities,afterTimeout.entities);
    report.steps.push('Short client deadline is enforced by native and renderer dispatch');
  } finally {
    if(previousSessions===undefined)delete process.env.WULFRAM_MCP_SESSION_DIR;
    else process.env.WULFRAM_MCP_SESSION_DIR=previousSessions;
  }
  const finalShot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'restored-editor.png'),Buffer.from(finalShot.content[0].data,'base64'));
  report.steps.push('Restored map validates with zero errors');
  if(process.env.WULFRAM_AUTHORED_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_AUTHORED_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const {root:doc}=await send('DOM.getDocument'),{nodeId:input}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});
    await send('DOM.setFileInputFiles',{nodeId:input,files:[file]});
    await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===source.name;},'authored source map');
    const snapshot=async(label)=>{const state=await call('get_editor_state',{sessionId});const copy=await call('save_copy',{sessionId,expectedRevision:state.revision,name:`authored-${label}-${Date.now()}`});return JSON.parse(await fs.readFile(copy.path,'utf8'));};
    const initial=await snapshot('initial');assert.deepEqual(initial,source);
    const before=await call('get_editor_state',{sessionId}),map=await call('inspect_map',{sessionId});
    const sourceFrame={origin:[source.terrain.worldWidth/2,source.terrain.worldHeight/2,0],yaw:0};
    const captured=await call('capture_authored_base',{sessionId,expectedRevision:before.revision,activeLayoutId:map.activeBaseLayoutId,sourceFrame});
    assert.equal(captured.revision,before.revision);assert.deepEqual(await snapshot('captured'),initial);
    const pack=JSON.parse(captured.packageJson);assert.equal(pack.geometry.units.length,source.entities.length);
    assert.ok(pack.geometry.authoring.districts.some(d=>d.locked));assert.ok(pack.areas.length);
    if(process.env.WULFRAM_AUTHORED_LIBRARY_TEST==='1'){
      const a={sessionId,expectedRevision:before.revision};
      const inspected=await call('inspect_authored_library',a);assert.equal(inspected.raw,null);
      const savedLibrary=await call('edit_authored_library',{...a,expectedLibraryRaw:null,libraryEditJson:JSON.stringify({operation:'save',entry:{id:'native-base',name:'Native Harbor',base:pack}})});
      assert.deepEqual(savedLibrary.after.entries[0].base,pack);
      assert.equal((await callRaw('edit_authored_library',{...a,expectedLibraryRaw:null,libraryEditJson:JSON.stringify({operation:'remove',id:'native-base'})})).isError,true);
      assert.equal((await callRaw('recover_authored_library',{...a,expectedLibraryRaw:savedLibrary.raw})).isError,true);
      const renamed=await call('edit_authored_library',{...a,expectedLibraryRaw:savedLibrary.raw,libraryEditJson:JSON.stringify({operation:'rename',id:'native-base',name:'Native Renamed'})});
      assert.deepEqual(renamed.after.entries[0].base,pack);
      const removed=await call('edit_authored_library',{...a,expectedLibraryRaw:renamed.raw,libraryEditJson:JSON.stringify({operation:'remove',id:'native-base'})});assert.equal(removed.after.entries.length,0);
      const restored=await call('edit_authored_library',{...a,expectedLibraryRaw:removed.raw,libraryEditJson:JSON.stringify({operation:'restore',entries:renamed.after.entries})});assert.equal(restored.after.entries[0].name,'Native Renamed');
      assert.deepEqual(await snapshot('library-mcp'),initial);
      const unchanged=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(unchanged[key],before[key]);assert.deepEqual(await snapshot('mcp-preview'),initial);
      report.authoredLibraryMcp={save:true,rename:true,deleteRestore:true,staleRejected:true,healthyRecoveryRejected:true,mapUnchanged:true};
    }
    const originalLayout=source.baseLayouts.find(l=>l.id===source.activeBaseLayoutId);
    assert.deepEqual(pack.areas,JSON.parse(originalLayout.metadata['forge.build-areas.v1']));
    assert.deepEqual(pack.geometry.authoring.budgets,JSON.parse(originalLayout.metadata['forge.composition-budgets.v1']));
    assert.deepEqual(pack.geometry.authoring.districts.map(({members,...d})=>({...d,entityIds:members.map(i=>source.entities[i].id)})),JSON.parse(originalLayout.metadata['forge.districts.v1']));
    const authoredRequest={activeLayoutId:map.activeBaseLayoutId,layoutId:'mcp-authored-reuse',frame:sourceFrame,terrainMode:'preserve'};
    const args={sessionId,expectedRevision:before.revision,packageJson:captured.packageJson,authoredRequest};
    const preview=await call('place_authored_base',{...args,previewOnly:true});
    const afterPreview=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(afterPreview[key],before[key]);
    assert.deepEqual((await call('inspect_map',{sessionId})).entities,map.entities);assert.deepEqual(await snapshot('preview'),initial);
    const invalid=await callRaw('place_authored_base',{...args,previewOnly:false,packageJson:'{}'});assert.equal(invalid.isError,true);
    assert.equal((await call('get_editor_state',{sessionId})).revision,before.revision);assert.deepEqual(await snapshot('invalid'),initial);
    const applied=await call('place_authored_base',{...args,previewOnly:false});assert.notEqual(applied.revision,before.revision);assert.equal(applied.undoCount,before.undoCount+1);
    assert.equal((await callRaw('place_authored_base',{...args,previewOnly:false})).isError,true);
    const copy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`authored-reuse-${Date.now()}`});
    const saved=JSON.parse(await fs.readFile(copy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===authoredRequest.layoutId);
    assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);assert.deepEqual(saved.terrain,source.terrain);
    assert.equal(saved.baseLayouts.length,source.baseLayouts.length+1);
    assert.deepEqual(JSON.parse(layout.metadata['forge.build-areas.v1']),pack.areas);assert.deepEqual(JSON.parse(layout.metadata['forge.composition-budgets.v1']),pack.geometry.authoring.budgets);
    assert.deepEqual(JSON.parse(layout.metadata['forge.districts.v1']),pack.geometry.authoring.districts.map(({members,...d})=>({...d,entityIds:members.map(i=>layout.entities[i].id)})));
    for(const old of source.baseLayouts){const kept=saved.baseLayouts.find(l=>l.id===old.id);assert.deepEqual(kept.entities,old.entities);assert.deepEqual(kept.metadata,old.metadata);}
    assert.equal((await callRaw('capture_authored_base',{sessionId,expectedRevision:before.revision,activeLayoutId:map.activeBaseLayoutId,sourceFrame})).isError,true);
    await call('undo',{sessionId,expectedRevision:applied.revision});const undone=await call('inspect_map',{sessionId});assert.deepEqual(undone.entities,map.entities);assert.equal(undone.activeBaseLayoutId,map.activeBaseLayoutId);
    assert.deepEqual(await snapshot('undone'),initial);
    if(process.env.WULFRAM_AUTHORED_GUI_TEST==='1'){
      const click=async(label)=>{await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw new Error('Button unavailable: '+${JSON.stringify(label)});for(let e=b.parentElement;e;e=e.parentElement)if(e.tagName==='DETAILS')e.open=true;b.click();})()`);};
      if(process.env.WULFRAM_AUTHORED_CAMERA_TEST==='1'){
        await click('Terrain');
        await evaluate(`(()=>{document.querySelector('.tool-finder').open=true;const input=document.querySelector('[aria-label="Find editor tools"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'authored bases');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('Capture and reuse authored bases');
        await probe(()=>evaluate(`document.querySelector('.authored-base-panel')?.open===true&&!document.querySelector('.authored-base-panel').closest('[hidden]')`),'authored tool finder destination');
        assert.deepEqual(await snapshot('finder'),initial);
      }
      await click('Base builder');await click('Capture active authored base');
      await probe(()=>evaluate(`!!document.querySelector('[aria-label="Authored origin X"]')`),'authored controls');
      if(process.env.WULFRAM_AUTHORED_LIBRARY_TEST==='1'){
        const setInput=async(label,value)=>evaluate(`(()=>{const input=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await setInput('Authored library name','GUI Harbor');await click('Save loaded base');
        const state=await call('get_editor_state',{sessionId}),a={sessionId,expectedRevision:state.revision};
        const stored=await call('inspect_authored_library',a);assert.equal(stored.library.entries.length,2);assert.deepEqual(stored.library.entries.find(e=>e.name==='GUI Harbor').base,pack);
        await setInput('Search authored library','GUI Harbor');assert.equal(await evaluate(`document.querySelector('[aria-label="Saved authored base"]').options.length`),2);
        await evaluate(`(()=>{const select=document.querySelector('[aria-label="Saved authored base"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,select.options[1].value);select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await setInput('Search authored library','no matching base');assert.equal(await evaluate(`document.querySelector('[aria-label="Saved authored base"]').value`),'');assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Delete saved base').disabled`),true);await setInput('Search authored library','GUI Harbor');
        await setInput('Authored library name','GUI Renamed');await click('Rename saved base');await setInput('Search authored library','');await click('Delete saved base');await click('Undo library change');await click('Load saved base');
        if(process.env.WULFRAM_AUTHORED_PORTABLE_TEST==='1'){
          await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out});await click('Export authored library');
          const exportFile=path.join(out,'wulfram-authored-library.json');const exportedLibrary=await probe(async()=>{try{return JSON.parse(await fs.readFile(exportFile,'utf8'));}catch{return false;}},'library export');
          const current=await call('inspect_authored_library',a);assert.deepEqual(exportedLibrary,current.library);
          const reduced=await call('edit_authored_library',{...a,expectedLibraryRaw:current.raw,libraryEditJson:JSON.stringify({operation:'remove',id:current.library.entries.find(e=>e.name==='GUI Renamed').id})});
          const previewImport=await call('edit_authored_library',{...a,expectedLibraryRaw:reduced.raw,previewOnly:true,libraryEditJson:JSON.stringify({operation:'import',library:exportedLibrary})});assert.deepEqual(previewImport.library.entries,exportedLibrary.entries);
          assert.equal((await call('inspect_authored_library',a)).raw,reduced.raw);
          const importFile=async()=>{const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[aria-label="Import authored library file"]'});await send('DOM.setFileInputFiles',{nodeId,files:[exportFile]});await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply library import'&&!b.disabled)`),'library import preview');};
          await importFile();assert.equal((await call('inspect_authored_library',a)).raw,reduced.raw);await click('Cancel library import');assert.equal((await call('inspect_authored_library',a)).raw,reduced.raw);
          await importFile();await click('Apply library import');assert.deepEqual((await call('inspect_authored_library',a)).library.entries,exportedLibrary.entries);
          await click('Undo library change');assert.deepEqual((await call('inspect_authored_library',a)).library.entries,reduced.after.entries);
          await importFile();await click('Apply library import');
          report.authoredLibraryPortable={exportExact:true,mcpPreviewUnchanged:true,guiPreviewCancelUnchanged:true,merge:true,undo:true};
        }
        assert.deepEqual(await snapshot('library-gui'),initial);
        await click('Terrain');await click('Base builder');
        await probe(()=>evaluate(`document.querySelector('[aria-label="Saved authored base"]')?.options.length===3`),'saved library after panel remount');
        await click('Capture active authored base');
        report.authoredLibraryGui={save:true,search:true,rename:true,deleteUndo:true,load:true,panelRemount:true,mapUnchanged:true};
      }
      await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out});await click('Export authored base');
      const exported=path.join(out,'wulfram-authored-base.json');await probe(async()=>{try{return JSON.parse(await fs.readFile(exported,'utf8'));}catch{return false;}},'authored GUI export');
      assert.deepEqual(JSON.parse(await fs.readFile(exported,'utf8')),pack);
      await click('Terrain');await click('Base builder');assert.equal(await evaluate(`!!document.querySelector('[aria-label="Authored origin X"]')`),false);
      const {root:guiDoc}=await send('DOM.getDocument'),{nodeId:guiInput}=await send('DOM.querySelector',{nodeId:guiDoc.nodeId,selector:'input[aria-label="Import authored base file"]'});
      await send('DOM.setFileInputFiles',{nodeId:guiInput,files:[exported]});
      await probe(()=>evaluate(`document.querySelector('.authored-base-panel output')?.textContent.includes('loaded')`),'authored GUI import');
      await evaluate(`(()=>{const input=document.querySelector('[aria-label="Authored origin X"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'4040');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('Preview authored base');await probe(()=>evaluate(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Apply authored base')?.disabled`),'authored GUI preview');
      assert.deepEqual(await snapshot('gui-preview'),initial);
      await evaluate(`document.querySelector('button[aria-label="Toggle terrain grid"]').click();document.querySelector('.authored-base-panel').scrollIntoView({block:'center'})`);
      await probe(()=>evaluate(`![...document.querySelectorAll('label')].find(l=>l.textContent.trim()==='Terrain grid')?.querySelector('input')?.checked`),'grid hidden for preview image');
      if(process.env.WULFRAM_AUTHORED_CAMERA_TEST==='1'){
        const screenshots=[];
        for(const team of [1,2])for(const view of ['overview','ground view']){
          await click(`Team ${team} ${view}`);
          await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
          const shot=await callRaw('capture_view',{sessionId}),file=path.join(out,`authored-team-${team}-${view.replace(' ','-')}.png`);
          await fs.writeFile(file,Buffer.from(shot.content[0].data,'base64'));screenshots.push(file);
          assert.deepEqual(await snapshot(`camera-${team}-${view.replace(' ','-')}`),initial);
        }
        if(process.env.WULFRAM_AUTHORED_DETAIL_TEST==='1'){
          const details=[];
          for(const team of [1,2]){
            await evaluate(`(()=>{const select=document.querySelector('[aria-label="Authored preview building"]');const option=[...select.options].find(o=>o.textContent.includes('Team ${team} · Repair'));if(!option)throw new Error('No repair preview option');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);if(select.value!==option.value)throw new Error('Anchor selection failed');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            await click('Close preview building');await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
            const shot=await callRaw('capture_view',{sessionId}),file=path.join(out,`authored-repair-${team}-detail.png`);await fs.writeFile(file,Buffer.from(shot.content[0].data,'base64'));details.push(file);
            assert.deepEqual(await snapshot(`repair-detail-${team}`),initial);
          }
          report.authoredDetails={mapUnchanged:true,screenshots:details};
        }
        report.authoredCameras={finderUnchanged:true,camerasUnchanged:true,screenshots};
      }
      const guiShot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'authored-gui-preview.png'),Buffer.from(guiShot.content[0].data,'base64'));
      const guiBefore=await call('get_editor_state',{sessionId});await click('Apply authored base');
      const guiAfter=await probe(async()=>{const state=await call('get_editor_state',{sessionId});return state.revision!==guiBefore.revision?state:false;},'authored GUI apply');
      assert.equal(guiAfter.undoCount,guiBefore.undoCount+1);
      const guiSaved=await snapshot('gui-applied');assert.equal(guiSaved.baseLayouts.length,initial.baseLayouts.length+1);
      guiSaved.entities.forEach((e,i)=>assert.ok(Math.abs(e.position[0]-source.entities[i].position[0]-40)<1e-7));
      await call('undo',{sessionId,expectedRevision:guiAfter.revision});assert.deepEqual(await snapshot('gui-undone'),initial);
      report.authoredGui={capture:true,exportImport:true,reposition40:true,previewUnchanged:true,applyUndo:true,screenshot:path.join(out,'authored-gui-preview.png')};
      if(process.env.WULFRAM_AUTHORED_BROWSER_TEST==='1'){
        await click('Browse base library');
        await evaluate(`(()=>{const select=document.querySelector('[aria-label="Base library collection"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'Authored bases');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await evaluate(`document.querySelector('button[aria-label="Details: Native Renamed"]').click()`);
        await probe(()=>evaluate(`document.querySelector('.base-library-detail')?.textContent.includes('across all saved teams')`),'authored card count scope');
        const shot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'authored-browser.png'),Buffer.from(shot.content[0].data,'base64'));
        assert.deepEqual(await snapshot('browser-browse'),initial);
        await click('Preview on current map');await probe(()=>evaluate(`!!document.querySelector('[aria-label="Authored origin X"]')`),'authored card handoff');
        assert.deepEqual(await snapshot('browser-handoff'),initial);
        await click('Preview authored base');const state=await call('get_editor_state',{sessionId});await click('Apply authored base');
        const after=await probe(async()=>{const v=await call('get_editor_state',{sessionId});return v.revision!==state.revision?v:false;},'authored card apply');
        assert.equal(after.undoCount,state.undoCount+1);await call('undo',{sessionId,expectedRevision:after.revision});assert.deepEqual(await snapshot('browser-undo'),initial);
        await click('Preview authored base');await click('Browse base library');
        await evaluate(`(()=>{const select=document.querySelector('[aria-label="Base library collection"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'Original');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await evaluate(`document.querySelector('.base-library-card').click()`);await click('Preview on current map');
        await probe(()=>evaluate(`![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply authored base')`),'authored candidate cleared for manual template');
        assert.deepEqual(await snapshot('browser-manual'),initial);
        report.authoredBrowser={cardScope:true,browseHandoffUnchanged:true,applyUndo:true,manualHandoffClearsCandidate:true,screenshot:path.join(out,'authored-browser.png')};
      }

    }
    report.authoredBase={completeSnapshots:true,sourceRulesCompared:true,captured:true,previewUnchanged:true,invalidAtomic:true,appliedOnce:true,staleRejected:true,savedRules:true,undo:true,sourceSha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),copy:copy.path};
  }
  if(process.env.WULFRAM_CREATIVE_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_CREATIVE_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const {root:doc}=await send('DOM.getDocument'),{nodeId:input}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});
    await send('DOM.setFileInputFiles',{nodeId:input,files:[file]});
    await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===source.name&&r.dimensions.worldWidth===source.terrain.worldWidth;},'creative source map');
    const initialCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`creative-before-${Date.now()}`});
    const initial=JSON.parse(await fs.readFile(initialCopy.path,'utf8'));
    assert.deepEqual(initial.baseLayouts,source.baseLayouts);assert.deepEqual(initial.entities,source.entities);assert.deepEqual(initial.terrain,source.terrain);
    report.creativeSourceSha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    report.creativeLayouts=[];
    for(const arrangement of process.env.WULFRAM_MAINTENANCE_TEST==='1'?['small','standard','large','massive']:process.env.WULFRAM_ROLE_EXPANSION_TEST==='1'?['role-expansion']:['wide-front','deep-court','split-wings']){
      let before=await call('inspect_map',{sessionId}),retentionFavorite;
      const request={activeLayoutId:before.activeBaseLayoutId,layoutId:`mcp-${arrangement}`,style:'offset-bastion',seed:'native-arrangement',placement:{size:'small',x:2800,y:4000,rotation:0,radius:2400,checkAccess:true,offsetArrangement:arrangement}};
      if(process.env.WULFRAM_ROLE_EXPANSION_TEST==='1'){request.style=process.env.WULFRAM_ROLE_POWER_TEST==='1'?'crescent':'workshop';delete request.placement.offsetArrangement;request.placement.expandRoles=true;request.placement.checkAccess=false;}
      if(process.env.WULFRAM_ROLE_COMBINED_TEST==='1'){request.seed='role-matrix';Object.assign(request.placement,{x:4000,y:6000,radius:3500});}
      if(process.env.WULFRAM_MAINTENANCE_TEST==='1'){request.style='maintenance-pocket';request.seed='0';request.placement={size:arrangement,x:4000,y:6000,rotation:0,radius:3500,terrainAware:false};}
      if(process.env.WULFRAM_RETENTION_TEST==='1'){
        const captureRequest={...request,layoutId:`capture-${arrangement}`,compositionPolicy:'compare-only'};
        const built=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request:captureRequest});
        retentionFavorite=await call('capture_formation_favorite',{sessionId,expectedRevision:built.revision,activeLayoutId:captureRequest.layoutId,favoriteId:'retention-favorite'});
        await call('undo',{sessionId,expectedRevision:built.revision});
        before=await call('inspect_map',{sessionId});
        request.compositionPolicy='retain';
      }
      const preview=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:true,request});
      assert.equal(preview.revision,before.revision);assert.deepEqual((await call('inspect_map',{sessionId})).entities,before.entities);
      const afterPreview=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(afterPreview[key],before[key]);
      const previewCopy=await call('save_copy',{sessionId,expectedRevision:afterPreview.revision,name:`creative-preview-${arrangement}-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(previewCopy.path,'utf8')),initial);
      const applied=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request});
      assert.notEqual(applied.revision,before.revision);assert.equal(applied.undoCount,before.undoCount+1);
      assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request})).isError,true);
      const copy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`creative-${arrangement}-${Date.now()}`});
      const saved=JSON.parse(await fs.readFile(copy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===request.layoutId);
      if(process.env.WULFRAM_MAINTENANCE_TEST==='1'){
        for(const team of [1,2])assert.equal(layout.entities.filter(e=>e.team===team).length,({small:6,standard:10,large:15,massive:20})[arrangement]);
        const routes=JSON.parse(layout.metadata['forge.serviceRoutes.v1']).routes;
        assert.equal(routes.length,['small','standard'].includes(arrangement)?4:8);
        for(const route of routes){const pad=layout.entities.find(e=>e.id===route.padId);assert.ok(pad);assert.deepEqual(route.points.at(-1),pad.position.slice(0,2));}
        assert.ok(JSON.parse(layout.metadata['forge.build-areas.v1']).length>=6);
        report.maintenancePocket??=[];report.maintenancePocket.push({size:arrangement,counts:true,serviceEndpoints:true,roads:true});
        const shot=await callRaw('capture_view',{sessionId});assert.equal(shot.content[0].type,'image');await fs.writeFile(path.join(out,`maintenance-${arrangement}.png`),Buffer.from(shot.content[0].data,'base64'));
      }
      if(process.env.WULFRAM_ROLE_COMBINED_TEST==='1'){
        const key='forge.composition-budgets.v1',rules=JSON.parse(initial.baseLayouts.find(l=>l.id===initial.activeBaseLayoutId).metadata[key]);
        assert.equal(rules.length,10);
        const counts=[];
        for(const rule of rules){
          assert.equal(rule.min,rule.max);
          const count=layout.entities.filter(e=>e.team===rule.team&&e.token!=='*'&&(rule.role==='all'||e.token===({power:'e',repair:'r',refuel:'f'})[rule.role]||rule.role==='defense'&&CATALOG.some(c=>c.token===e.token&&c.category==='defense'))).length;
          assert.equal(count,rule.min,`Team ${rule.team} ${rule.role}`);counts.push({team:rule.team,role:rule.role,count});
        }
        assert.deepEqual(JSON.parse(layout.metadata[key]),rules);
        assert.ok(JSON.parse(layout.metadata['formation.access']).routes.length);
        report.combinedRoleExpansion={counts,retainedLimits:true,mandatorySampledAccess:true};
      }else if(process.env.WULFRAM_ROLE_EXPANSION_TEST==='1'){
        const power=process.env.WULFRAM_ROLE_POWER_TEST==='1';
        for(const team of [1,2]){
          const members=layout.entities.filter(e=>e.team===team&&e.token===(power?'e':'r'));assert.equal(members.length,power?5:2);
          if(power)for(const cell of members){const nearest=Math.min(...members.filter(e=>e.id!==cell.id).map(e=>Math.hypot(e.position[0]-cell.position[0],e.position[1]-cell.position[1])));assert.ok(nearest<=layout.validation.backupRadius-10);}
        }
        assert.deepEqual(JSON.parse(layout.metadata['forge.composition-budgets.v1']),JSON.parse(initial.baseLayouts.find(l=>l.id===initial.activeBaseLayoutId).metadata['forge.composition-budgets.v1']));
        assert.ok(JSON.parse(layout.metadata['formation.access']).routes.length);
        report.roleExpansion={...(power?{bothTeamsPowerCount:5,backupSpacing:true}:{bothTeamsRepairCount:2}),retainedLimits:true,mandatorySampledAccess:true};
      }
      if(process.env.WULFRAM_RETENTION_TEST==='1'){
        const key='forge.composition-budgets.v1',rules=initial.baseLayouts.find(l=>l.id===initial.activeBaseLayoutId).metadata[key];
        assert.ok(rules);assert.deepEqual(JSON.parse(layout.metadata[key]),JSON.parse(rules));
        assert.equal((await callRaw('capture_formation_favorite',{sessionId,expectedRevision:applied.revision,activeLayoutId:layout.id,favoriteId:'must-not-drop-rules'})).isError,true);
      }
      assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);assert.equal(saved.baseLayouts.length,initial.baseLayouts.length+1);assert.deepEqual(saved.terrain,initial.terrain);
      for(const old of initial.baseLayouts){const kept=saved.baseLayouts.find(l=>l.id===old.id);assert.deepEqual(kept.entities,old.entities);assert.deepEqual(kept.metadata,old.metadata);}
      const duplicate=await callRaw('generate_base_layout',{sessionId,expectedRevision:applied.revision,previewOnly:false,request:{...request,activeLayoutId:request.layoutId}});assert.equal(duplicate.isError,true);assert.equal((await call('get_editor_state',{sessionId})).revision,applied.revision);
      const restored=await call('undo',{sessionId,expectedRevision:applied.revision});
      const undoCopy=await call('save_copy',{sessionId,expectedRevision:restored.revision,name:`creative-undo-${arrangement}-${Date.now()}`});
      const undone=JSON.parse(await fs.readFile(undoCopy.path,'utf8'));assert.deepEqual(undone.baseLayouts,initial.baseLayouts);assert.deepEqual(undone.entities,initial.entities);assert.deepEqual(undone.terrain,initial.terrain);
      if(retentionFavorite){
        const key='forge.composition-budgets.v1',current=await call('get_editor_state',{sessionId});
        const {offsetArrangement,...placement}=request.placement;
        const favoriteRequestJson=JSON.stringify({activeLayoutId:initial.activeBaseLayoutId,layoutId:`favorite-${arrangement}`,favoriteId:'retention-favorite',placement,compositionPolicy:'retain'});
        const args={sessionId,expectedRevision:current.revision,packageJson:retentionFavorite.packageJson,favoriteRequestJson};
        const preview=await call('place_formation_favorite',{...args,previewOnly:true});
        const unchanged=await call('get_editor_state',{sessionId});for(const k of ['revision','undoCount','redoCount','dirty'])assert.equal(unchanged[k],current[k]);
        const appliedFavorite=await call('place_formation_favorite',{...args,previewOnly:false});assert.equal(appliedFavorite.undoCount,current.undoCount+1);
        assert.equal((await callRaw('place_formation_favorite',{...args,previewOnly:false})).isError,true);
        const copy=await call('save_copy',{sessionId,expectedRevision:appliedFavorite.revision,name:`retained-favorite-${arrangement}-${Date.now()}`}),favoriteMap=JSON.parse(await fs.readFile(copy.path,'utf8'));
        const favoriteLayout=favoriteMap.baseLayouts.at(-1);
        const {updatedAt:appliedAt,...appliedFields}=favoriteLayout,{updatedAt:previewAt,...previewFields}=preview.layout;
        assert.ok(Number.isFinite(Date.parse(appliedAt)));assert.ok(Number.isFinite(Date.parse(previewAt)));
        assert.deepEqual(appliedFields,previewFields);
        assert.deepEqual(JSON.parse(favoriteLayout.metadata[key]),JSON.parse(initial.baseLayouts.find(l=>l.id===initial.activeBaseLayoutId).metadata[key]));
        assert.deepEqual(favoriteMap.baseLayouts.slice(0,-1),initial.baseLayouts);assert.deepEqual(favoriteMap.terrain,initial.terrain);
        const restored=await call('undo',{sessionId,expectedRevision:appliedFavorite.revision}),undoCopy=await call('save_copy',{sessionId,expectedRevision:restored.revision,name:`retained-favorite-undo-${arrangement}-${Date.now()}`});
        assert.deepEqual(JSON.parse(await fs.readFile(undoCopy.path,'utf8')),initial);
        report.compositionRetention??=[];report.compositionRetention.push({arrangement,generationRules:true,favoriteRules:true,favoritePreviewUnchanged:true,favoritePreviewApplyEqual:true,favoriteStaleRejected:true,favoriteOneStepUndo:true});
      }
      report.creativeLayouts.push({arrangement,previewUnchanged:true,previewApplyGeometry:true,preservedLayouts:true,duplicateRejected:true,staleRejected:true,undo:true});
    }
  }
  if(process.env.WULFRAM_COURTYARD_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_COURTYARD_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const importMap=async file=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});};
    await importMap(file);
    await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===source.name&&r.dimensions.worldWidth===source.terrain.worldWidth;},'creative source map');
    const initialCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`creative-before-${Date.now()}`});
    const initial=JSON.parse(await fs.readFile(initialCopy.path,'utf8'));
    assert.deepEqual(initial.baseLayouts,source.baseLayouts);assert.deepEqual(initial.entities,source.entities);assert.deepEqual(initial.terrain,source.terrain);
    report.courtyardSourceSha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    report.courtyardLayouts=[];
    if(process.env.WULFRAM_COURTYARD_GUI_TEST==='1'){
      const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`),'enabled '+label);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
      const browseBefore=await call('get_editor_state',{sessionId});
      await click('Base builder');await click('Browse base library');
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="Base library collection"]');s.value='Creative';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="Search base library"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'Service Courtyard');s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await probe(()=>evaluate(`!!document.querySelector('button[aria-label="Details: Service Courtyard"]')`),'Courtyard card');
      await evaluate(`document.querySelector('button[aria-label="Details: Service Courtyard"]').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.base-library-detail svg polyline').length`),3);
      const shot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'courtyard-library.png'),Buffer.from(shot.content[0].data,'base64'));
      await click('Preview on current map');await click('Preview formation');
      await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`),'Courtyard GUI preview');
      const before=await call('get_editor_state',{sessionId});
      for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(before[key],browseBefore[key]);
      const previewCopy=await call('save_copy',{sessionId,expectedRevision:before.revision,name:`courtyard-gui-preview-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(previewCopy.path,'utf8')),initial);
      await click('Apply formation');
      const applied=await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.revision!==before.revision?r:false;},'Courtyard GUI apply');assert.equal(applied.undoCount,before.undoCount+1);
      for(const team of [1,2])assert.equal(applied.entities.filter(e=>e.team===team).length,21);
      const appliedCopy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`courtyard-gui-applied-${Date.now()}`});
      const saved=JSON.parse(await fs.readFile(appliedCopy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===saved.activeBaseLayoutId);
      assert.equal(layout.metadata['formation.style'],'service-courtyard');assert.equal(layout.metadata['formation.version'],'service-courtyard-v1');assert.equal(JSON.parse(layout.metadata['forge.build-areas.v1']).length,6);assert.equal(JSON.parse(layout.metadata['formation.courtyardAccess']).routes.length,2);

      if(process.env.WULFRAM_COURTYARD_PORTABLE_TEST==='1'){
        await click('Save active formation as favorite');
        const favorites=await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`);assert.equal(favorites.length,1);assert.equal(favorites[0].reservations.version,4);assert.equal(favorites[0].reservations.areas.length,6);
        await click('Browse base library');await evaluate(`document.querySelector('.personal-base-library').open=true`);
        const downloads=path.join(out,'courtyard-downloads');await fs.mkdir(downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await click('Export My bases');
        const exportPath=path.join(downloads,'wulfram-base-library.json');
        const exported=await probe(async()=>{try{return JSON.parse(await fs.readFile(exportPath,'utf8'));}catch{return false;}},'Courtyard export');assert.equal(exported.version,5);assert.deepEqual(exported.bases,favorites);
        await evaluate(`(()=>{const s=document.querySelector('[aria-label="Manage saved base"]');s.value=${JSON.stringify(favorites[0].id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Remove saved base');
        assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),[]);
        const importFile=async()=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[aria-label="Import personal base library file"]'});await send('DOM.setFileInputFiles',{nodeId,files:[exportPath]});await probe(()=>evaluate(`document.querySelector('.personal-base-import')?.textContent.includes('1 new')`),'Courtyard import preview');};
        await importFile();assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),[]);await click('Cancel library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),[]);
        await importFile();await click('Apply library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
        await click('Close library');
        const after=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(after[key],applied[key]);
        const copy=await call('save_copy',{sessionId,expectedRevision:after.revision,name:`courtyard-library-unchanged-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(copy.path,'utf8')),saved);
        report.courtyardPortable={saved:true,exportPath,version:5,exactLibrary:true,previewCancel:true,import:true,mapHistoryUnchanged:true};
      }
      await call('undo',{sessionId,expectedRevision:applied.revision});
      const undoneCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`courtyard-gui-undo-${Date.now()}`});const undone=JSON.parse(await fs.readFile(undoneCopy.path,'utf8'));assert.deepEqual(undone.baseLayouts,initial.baseLayouts);assert.deepEqual(undone.terrain,initial.terrain);assert.deepEqual(undone.entities,initial.entities);
      if(process.env.WULFRAM_COURTYARD_PORTABLE_TEST==='1'){
        await evaluate(`(()=>{const s=document.querySelector('[aria-label="Formation favorites"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Preview formation');
        await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`),'imported Courtyard preview');
        const before=await call('get_editor_state',{sessionId});await click('Apply formation');
        const after=await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==before.revision?r:false;},'imported Courtyard apply');assert.equal(after.undoCount,before.undoCount+1);
        const copy=await call('save_copy',{sessionId,expectedRevision:after.revision,name:`courtyard-favorite-reused-${Date.now()}`});const reused=JSON.parse(await fs.readFile(copy.path,'utf8')),active=reused.baseLayouts.find(l=>l.id===reused.activeBaseLayoutId);
        assert.equal(active.metadata['formation.reservationPolicy'],'service-courtyard-v1');const actual=JSON.parse(active.metadata['forge.build-areas.v1']),expected=JSON.parse(layout.metadata['forge.build-areas.v1']);assert.equal(actual.length,6);
        actual.forEach((a,i)=>{assert.equal(a.id,expected[i].id);assert.equal(a.width,expected[i].width);a.points.forEach((p,j)=>p.forEach((n,k)=>assert.ok(Math.abs(n-expected[i].points[j][k])<1e-6)));});
        for(const team of [1,2])assert.equal(active.entities.filter(e=>e.team===team).length,21);
        const projection=entities=>entities.map(e=>({team:e.team,token:e.token,subtype:e.subtype,active:e.active,position:e.position.map(n=>Math.round(n*1e5)/1e5),rotation:e.rotation.map(n=>Math.round(n*1e5)/1e5)}));assert.deepEqual(projection(active.entities),projection(layout.entities));
        const access=JSON.parse(active.metadata['formation.courtyardAccess']);assert.equal(access.vehicleWidth,80);assert.deepEqual(access.routes.map(r=>r.team),[1,2]);
        for(const [index,route] of access.routes.entries()){const [court,west,east]=actual.slice(index*3,index*3+3);assert.deepEqual(route.points,[west.points[0],west.points[1],court.points[1],east.points[1]]);assert.ok(!route.markers.some(m=>m.severity==='blocked'));}

        await call('undo',{sessionId,expectedRevision:after.revision});const restored=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`courtyard-favorite-undo-${Date.now()}`});const back=JSON.parse(await fs.readFile(restored.path,'utf8'));assert.deepEqual(back.baseLayouts,initial.baseLayouts);assert.deepEqual(back.entities,initial.entities);assert.deepEqual(back.terrain,initial.terrain);
        report.courtyardPortable.reuseApplyUndo=true;report.courtyardPortable.reusedCopy=copy.path;
      }
      report.courtyardGui={creativeCard:true,threeBands:true,previewUnchanged:true,applyUndo:true,screenshot:path.join(out,'courtyard-library.png')};
    }

    for(const arrangement of ['small','standard','large','massive']){
      const before=await call('inspect_map',{sessionId});
      const request={activeLayoutId:before.activeBaseLayoutId,layoutId:`mcp-${arrangement}`,style:'service-courtyard',seed:'native-courtyard',placement:{size:arrangement,x:3200,y:5000,rotation:35,radius:2600,checkAccess:true}};
      const preview=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:true,request});
      assert.equal(preview.revision,before.revision);assert.deepEqual((await call('inspect_map',{sessionId})).entities,before.entities);
      const afterPreview=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(afterPreview[key],before[key]);
      const previewCopy=await call('save_copy',{sessionId,expectedRevision:afterPreview.revision,name:`creative-preview-${arrangement}-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(previewCopy.path,'utf8')),initial);
      const applied=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request});
      assert.notEqual(applied.revision,before.revision);assert.equal(applied.undoCount,before.undoCount+1);
      assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request})).isError,true);
      const copy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`creative-${arrangement}-${Date.now()}`});
      const saved=JSON.parse(await fs.readFile(copy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===request.layoutId);
      assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);assert.equal(saved.baseLayouts.length,initial.baseLayouts.length+1);assert.deepEqual(saved.terrain,initial.terrain);
      for(const old of initial.baseLayouts){const kept=saved.baseLayouts.find(l=>l.id===old.id);assert.deepEqual(kept.entities,old.entities);assert.deepEqual(kept.metadata,old.metadata);}
      const duplicate=await callRaw('generate_base_layout',{sessionId,expectedRevision:applied.revision,previewOnly:false,request:{...request,activeLayoutId:request.layoutId}});assert.equal(duplicate.isError,true);assert.equal((await call('get_editor_state',{sessionId})).revision,applied.revision);
      const restored=await call('undo',{sessionId,expectedRevision:applied.revision});
      const undoCopy=await call('save_copy',{sessionId,expectedRevision:restored.revision,name:`creative-undo-${arrangement}-${Date.now()}`});
      const undone=JSON.parse(await fs.readFile(undoCopy.path,'utf8'));assert.deepEqual(undone.baseLayouts,initial.baseLayouts);assert.deepEqual(undone.entities,initial.entities);assert.deepEqual(undone.terrain,initial.terrain);
      assert.equal(layout.metadata['formation.version'],'service-courtyard-v1');assert.equal(layout.metadata['formation.style'],'service-courtyard');
      for(const team of [1,2])assert.equal(layout.entities.filter(e=>e.team===team).length,{small:10,standard:15,large:21,massive:33}[arrangement]);
      const areas=JSON.parse(layout.metadata['forge.build-areas.v1']),access=JSON.parse(layout.metadata['formation.courtyardAccess']);
      assert.equal(areas.length,6);assert.equal(access.vehicleWidth,80);assert.deepEqual(access.routes.map(r=>r.team),[1,2]);
      for(const [index,route] of access.routes.entries()){
        const [court,west,east]=areas.slice(index*3,index*3+3);
        assert.deepEqual(route.points,[west.points[0],west.points[1],court.points[1],east.points[1]]);
        assert.ok(!route.markers.some(marker=>marker.severity==='blocked'));
      }
      // Export the generated saved copy after reopening it, then reimport its ZIP.
      await importMap(copy.path);
      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===request.layoutId;},'Courtyard generated JSON opened for ZIP');
      const zip=await call('export_map',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`courtyard-generated-${arrangement}-${Date.now()}`});
      const entries=await readMapArchive(await fs.readFile(zip.path)),embedded=JSON.parse(entries.find(e=>e.name.endsWith('/wulfram-project.json')).text);
      assert.deepEqual(embedded.baseLayouts,saved.baseLayouts);assert.deepEqual(embedded.entities,saved.entities);assert.deepEqual(embedded.terrain,saved.terrain);
      const zipBefore=await call('get_editor_state',{sessionId});
      await importMap(zip.path);
      await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==zipBefore.revision;},'Courtyard ZIP import committed');

      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===request.layoutId;},'courtyard saved copy reopen');
      const reopenedCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`court-reopened-${arrangement}-${Date.now()}`});
      const reopened=JSON.parse(await fs.readFile(reopenedCopy.path,'utf8'));
      assert.deepEqual(reopened.baseLayouts,saved.baseLayouts);assert.deepEqual(reopened.entities,saved.entities);assert.deepEqual(reopened.terrain,saved.terrain);
      await importMap(file);
      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===initial.activeBaseLayoutId&&r.entities.length===initial.entities.length;},'courtyard source restored');
      report.courtyardLayouts.push({arrangement,previewUnchanged:true,previewApplyGeometry:true,preservedLayouts:true,duplicateRejected:true,staleRejected:true,undo:true,reopened:true,zipReopened:true,zip:zip.path,copy:copy.path});
    }
  }
  if(process.env.WULFRAM_VALLEY_POCKETS_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_VALLEY_POCKETS_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const importMap=async file=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});};
    const snapshot=async name=>{const copy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`valley-${name}-${Date.now()}`});return {path:copy.path,project:JSON.parse(await fs.readFile(copy.path,'utf8'))};};
    await importMap(file);await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===source.name;},'Valley source');
    const initial=(await snapshot('initial')).project;assert.deepEqual(initial.entities,source.entities);assert.deepEqual(initial.terrain,source.terrain);assert.deepEqual(initial.baseLayouts,source.baseLayouts);assert.equal(initial.activeBaseLayoutId,source.activeBaseLayoutId);assert.deepEqual(initial.validation,source.validation);
    report.valleyPockets={sourceSha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),layouts:[]};
    const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`),'enabled '+label);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
    const guiBefore=await call('get_editor_state',{sessionId});
    await click('Base builder');await click('Browse base library');
    await evaluate(`(()=>{const s=document.querySelector('[aria-label="Base library collection"]');s.value='Creative';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate(`(()=>{const input=document.querySelector('input[aria-label="Search base library"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Valley Pockets');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await probe(()=>evaluate(`!!document.querySelector('button[aria-label="Details: Valley Pockets"]')`),'Valley card');
    await evaluate(`document.querySelector('button[aria-label="Details: Valley Pockets"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.base-library-detail svg polyline').length`),5);
    const shot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'valley-pockets-library.png'),Buffer.from(shot.content[0].data,'base64'));
    await click('Preview on current map');
    await evaluate(`(()=>{const input=document.querySelector('input[aria-label="Target structures per team"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'24');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await probe(()=>evaluate(`document.querySelector('input[aria-label="Target structures per team"]').value==='24'`),'Valley GUI count');
    await click('Preview formation');
    try{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`),'Valley GUI preview');}catch(error){report.valleyPockets.previewFailureText=await evaluate('document.body.innerText');const failed=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'valley-preview-failure.png'),Buffer.from(failed.content[0].data,'base64'));throw error;}
    const guiPreview=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(guiPreview[key],guiBefore[key]);assert.deepEqual((await snapshot('gui-preview')).project,initial);
    await click('Apply formation');
    const guiApplied=await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==guiBefore.revision?r:false;},'Valley GUI Apply');assert.equal(guiApplied.undoCount,guiBefore.undoCount+1);
    const guiSaved=await snapshot('gui-applied'),guiLayout=guiSaved.project.baseLayouts.find(l=>l.id===guiSaved.project.activeBaseLayoutId);assert.equal(guiLayout.metadata['formation.style'],'valley-pockets');
    for(const team of [1,2])assert.equal(guiLayout.entities.filter(e=>e.team===team).length,24);
    for(const entity of initial.entities)assert.deepEqual(guiSaved.project.entities.find(e=>e.id===entity.id),entity);
    const favorites=await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1')??'[]')`);await click('Save active formation as favorite');
    const savedFavorites=await probe(()=>evaluate(`(()=>{const f=JSON.parse(localStorage.getItem('forge-formation-favorites-v1')??'[]');return f.length===${favorites.length+1}?f:false;})()`),'Valley favorite save');
    const valleyFavorite=savedFavorites.find(f=>!favorites.some(old=>old.id===f.id));assert.equal(valleyFavorite.valleyRecipe.targetCount,24);assert.equal(valleyFavorite.template.units.length,24);
    const libraryBefore=await call('get_editor_state',{sessionId}),libraryMapBefore=(await snapshot('library-before')).project;
    await click('Browse base library');await evaluate(`document.querySelector('.personal-base-library').open=true`);
    const libraryDownloads=path.join(out,'valley-downloads');await fs.mkdir(libraryDownloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:libraryDownloads});await click('Export My bases');
    const libraryExportPath=path.join(libraryDownloads,'wulfram-base-library.json');
    const libraryExport=await probe(async()=>{try{return JSON.parse(await fs.readFile(libraryExportPath,'utf8'));}catch{return false;}},'Valley library export');assert.equal(libraryExport.version,7);assert.deepEqual(libraryExport.bases,savedFavorites);
    await evaluate(`(()=>{const s=document.querySelector('[aria-label="Manage saved base"]');s.value=${JSON.stringify(valleyFavorite.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Remove saved base');
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
    const importFavoriteLibrary=async()=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[aria-label="Import personal base library file"]'});await send('DOM.setFileInputFiles',{nodeId,files:[libraryExportPath]});await probe(()=>evaluate(`document.querySelector('.personal-base-import')?.textContent.includes('1 new')`),'Valley library import preview');};
    await importFavoriteLibrary();assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);await click('Cancel library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
    await importFavoriteLibrary();await click('Apply library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),savedFavorites);await click('Close library');
    assert.deepEqual((await snapshot('library-after')).project,libraryMapBefore);const libraryAfter=await call('get_editor_state',{sessionId});for(const k of ['revision','undoCount','redoCount','dirty'])assert.equal(libraryAfter[k],libraryBefore[k]);
    report.valleyPockets.library={exportPath:libraryExportPath,favoriteId:valleyFavorite.id,version:7,exactLibrary:true,cancelUnchanged:true,mapUnchanged:true};
    const captureBefore=await call('get_editor_state',{sessionId}),captureMapBefore=(await snapshot('capture-before')).project;
    const portable=await call('capture_formation_favorite',{sessionId,expectedRevision:captureBefore.revision,activeLayoutId:guiLayout.id,favoriteId:'native-valley-favorite'});
    const captured=JSON.parse(portable.packageJson);assert.equal(captured.version,7);assert.deepEqual(captured.bases[0].valleyRecipe,valleyFavorite.valleyRecipe);assert.deepEqual(captured.bases[0].template.units,valleyFavorite.template.units);
    assert.deepEqual((await snapshot('capture-after')).project,captureMapBefore);
    const captureAfter=await call('get_editor_state',{sessionId});for(const k of ['revision','undoCount','redoCount','dirty'])assert.equal(captureAfter[k],captureBefore[k]);
    const portablePath=path.join(out,'valley-favorite-library.json');await fs.writeFile(portablePath,portable.packageJson);
    await call('undo',{sessionId,expectedRevision:guiApplied.revision});const guiUndo=(await snapshot('gui-undo')).project;assert.deepEqual(guiUndo.baseLayouts,initial.baseLayouts);assert.deepEqual(guiUndo.entities,initial.entities);assert.deepEqual(guiUndo.terrain,initial.terrain);
    report.valleyPockets.gui={creativeCard:true,fiveBands:true,previewUnchanged:true,applyUndo:true,favoriteSaved:true,portablePath,copy:guiSaved.path};
    for(const expanded of [false,true])for(const size of ['small','standard','large','massive']){
      const targetCount=({small:10,standard:15,large:20,massive:30}[size])+(expanded?4:0);
      const before=await call('inspect_map',{sessionId});const request={activeLayoutId:before.activeBaseLayoutId,layoutId:`valley-${size}-${expanded?'expanded':'default'}`,style:'valley-pockets',seed:'native-valley',placement:{size,x:4000,y:6000,rotation:35,radius:3300,terrainAware:true,targetCount}};
      if(size==='small'&&expanded){
        for(const previewOnly of [true,false])assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly,request:{...request,placement:{...request.placement,targetCount:120}}})).isError,true);
        const rejected=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(rejected[key],before[key]);assert.deepEqual((await snapshot('count-rejected')).project,initial);
        report.valleyPockets.impossibleCountUnchanged=true;
      }
      const preview=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:true,request});
      const unchanged=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(unchanged[key],before[key]);assert.deepEqual((await snapshot('mcp-preview')).project,initial);
      const applied=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request});assert.equal(applied.undoCount,before.undoCount+1);
      assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request})).isError,true);
      const saved=await snapshot(size),layout=saved.project.baseLayouts.find(l=>l.id===request.layoutId);assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);
      assert.equal(layout.metadata['formation.version'],expanded?'valley-pockets-v2':'valley-pockets-v1');for(const team of [1,2])assert.equal(layout.entities.filter(e=>e.team===team).length,targetCount);
      for(const entity of initial.entities)assert.deepEqual(saved.project.entities.find(e=>e.id===entity.id),entity);for(const old of initial.baseLayouts)assert.deepEqual(saved.project.baseLayouts.find(l=>l.id===old.id),old);
      const record=JSON.parse(layout.metadata[`formation.valleyPockets.${request.layoutId}`]);assert.equal(record.serviceRoutes.length,2);assert.equal(record.shifts.length,{small:2,standard:3,large:4,massive:6}[size]);
      const paths=[record.plan.passage,...record.plan.sites.map(s=>s.frontage)],areas=JSON.parse(layout.metadata['forge.build-areas.v1']);
      assert.equal(areas.length,paths.length*2);assert.deepEqual(areas.map(a=>a.id).sort(),[1,2].flatMap(team=>paths.map((_,i)=>`${request.layoutId}-route-${team}-${i}`)).sort());
      const angle=request.placement.rotation*Math.PI/180,transform=([x,y],team)=>{const wx=4000+x*Math.cos(angle)-y*Math.sin(angle),wy=6000+x*Math.sin(angle)+y*Math.cos(angle);return team===1?[wx,wy]:[16000-wx,12000-wy];};
      for(const team of [1,2]){
        for(const [i,path] of paths.entries()){const area=areas.find(a=>a.id===`${request.layoutId}-route-${team}-${i}`);assert.equal(area.width,path.width);assert.equal(area.points.length,path.points.length);for(const [j,p] of path.points.entries()){const target=transform(p,team);assert.ok(Math.hypot(area.points[j][0]-target[0],area.points[j][1]-target[1])<1e-6);}}
        for(const route of record.serviceRoutes){const pad=layout.entities.find(e=>e.id===`${request.layoutId}-${team}-${route.unitIndex}`),endpoint=transform(route.points[1],team);assert.ok(pad&&['r','f'].includes(pad.token));assert.ok(Math.hypot(pad.position[0]-endpoint[0],pad.position[1]-endpoint[1])<1e-6);assert.deepEqual(route.points[0],record.plan.sites.find(s=>s.id===route.siteId).frontage.points[1]);}
      }

      assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:applied.revision,previewOnly:false,request:{...request,activeLayoutId:request.layoutId}})).isError,true);
      await call('undo',{sessionId,expectedRevision:applied.revision});const undone=(await snapshot('undo')).project;assert.deepEqual(undone.entities,initial.entities);assert.deepEqual(undone.baseLayouts,initial.baseLayouts);assert.deepEqual(undone.terrain,initial.terrain);
      await importMap(saved.path);await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===request.layoutId;},'Valley JSON reopen');
      const zip=await call('export_map',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`valley-${size}-${Date.now()}`});
      const zipBefore=await call('get_editor_state',{sessionId});await importMap(zip.path);await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==zipBefore.revision;},'Valley ZIP reopen');
      const reopened=(await snapshot('reopened')).project;assert.deepEqual(reopened.entities,saved.project.entities);assert.deepEqual(reopened.baseLayouts,saved.project.baseLayouts);assert.deepEqual(reopened.terrain,initial.terrain);
      report.valleyPockets.layouts.push({size,targetCount,expanded,previewApplyGeometry:true,staleRejected:true,duplicateRejected:true,undo:true,jsonZipReopened:true,preservedSource:true,copy:saved.path,zip:zip.path});
      await importMap(file);await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===initial.activeBaseLayoutId;},'Valley source restored');
    }
    const destination=structuredClone(initial);destination.name='Valley portable destination';destination.terrain.worldWidth=20000;destination.terrain.worldHeight=16000;
    const destinationPath=path.join(out,'valley-favorite-destination.json');await fs.writeFile(destinationPath,JSON.stringify(destination));await importMap(destinationPath);
    await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===destination.name&&r.dimensions.worldWidth===20000;},'Valley favorite destination');
    const destinationBefore=(await snapshot('favorite-before')).project;for(const key of ['terrain','entities','baseLayouts','activeBaseLayoutId'])assert.deepEqual(destinationBefore[key],destination[key]);const beforeReuse=await call('get_editor_state',{sessionId});
    const favoriteRequestJson=JSON.stringify({activeLayoutId:destinationBefore.activeBaseLayoutId,layoutId:'valley-favorite-reuse',favoriteId:'native-valley-favorite',placement:{size:'large',x:5000,y:8000,rotation:90,radius:3300}});
    const favoritePreview=await call('place_formation_favorite',{sessionId,expectedRevision:beforeReuse.revision,packageJson:portable.packageJson,favoriteRequestJson,previewOnly:true});
    assert.deepEqual((await snapshot('favorite-preview')).project,destinationBefore);const afterPreview=await call('get_editor_state',{sessionId});for(const k of ['revision','undoCount','redoCount','dirty'])assert.equal(afterPreview[k],beforeReuse[k]);
    const reused=await call('place_formation_favorite',{sessionId,expectedRevision:beforeReuse.revision,packageJson:portable.packageJson,favoriteRequestJson,previewOnly:false});assert.equal(reused.undoCount,beforeReuse.undoCount+1);
    const favoriteCopy=await snapshot('favorite-applied'),favoriteLayout=favoriteCopy.project.baseLayouts.find(l=>l.id==='valley-favorite-reuse');assert.deepEqual(favoriteLayout.entities,favoritePreview.layout.entities);assert.deepEqual(favoriteLayout.metadata,favoritePreview.layout.metadata);
    for(const team of [1,2])assert.equal(favoriteLayout.entities.filter(e=>e.team===team).length,24);
    for(const e of destinationBefore.entities)assert.deepEqual(favoriteLayout.entities.find(x=>x.id===e.id),e);
    const sourceRecord=JSON.parse(guiLayout.metadata[`formation.valleyPockets.${guiLayout.id}`]),reusedAreas=JSON.parse(favoriteLayout.metadata['forge.build-areas.v1']);
    const sourcePaths=[sourceRecord.plan.passage,...sourceRecord.plan.sites.map(s=>s.frontage)];assert.equal(reusedAreas.length,sourcePaths.length*2);
    // Independent 90-degree rotation and translation; do not call the placement helper.
    const expectedPoint=([x,y],team)=>team===1?[5000-y,8000+x]:[15000+y,8000-x];
    for(const team of [1,2]){
      for(const [i,u] of captured.bases[0].template.units.entries()){
        const e=favoriteLayout.entities.find(e=>e.id===`${favoriteLayout.id}-${team}-${i}`),point=expectedPoint(u.offset,team);assert.ok(e);assert.equal(e.token,u.token);assert.equal(e.active,u.active);assert.equal(e.team,team);assert.ok(Math.hypot(e.position[0]-point[0],e.position[1]-point[1])<1e-6);
      }
      for(const [i,route] of sourcePaths.entries()){
        const area=reusedAreas.find(a=>a.id===`${favoriteLayout.id}-route-${team}-${i}`);assert.ok(area);assert.equal(area.width,route.width);assert.equal(area.points.length,route.points.length);
        for(const [j,p] of route.points.entries()){const point=expectedPoint(p,team);assert.ok(Math.hypot(area.points[j][0]-point[0],area.points[j][1]-point[1])<1e-6);}
      }
    }
    const recaptured=await call('capture_formation_favorite',{sessionId,expectedRevision:reused.revision,activeLayoutId:favoriteLayout.id,favoriteId:'recaptured'});assert.deepEqual(JSON.parse(recaptured.packageJson).bases[0].valleyRecipe,captured.bases[0].valleyRecipe);
    assert.equal((await callRaw('place_formation_favorite',{sessionId,expectedRevision:beforeReuse.revision,packageJson:portable.packageJson,favoriteRequestJson,previewOnly:false})).isError,true);
    await call('undo',{sessionId,expectedRevision:reused.revision});const undoneFavorite=(await snapshot('favorite-undo')).project;assert.deepEqual(undoneFavorite.entities,destinationBefore.entities);assert.deepEqual(undoneFavorite.baseLayouts,destinationBefore.baseLayouts);assert.deepEqual(undoneFavorite.terrain,destinationBefore.terrain);
    report.valleyPockets.portable={captureReadOnly:true,destinationFixtureExact:true,independentTransformedCoordinates:true,guiMcpRecipeMatch:true,previewReadOnly:true,applyUndo:true,staleRejected:true,recapture:true,copy:favoriteCopy.path,package:portablePath};
  }
  if(process.env.WULFRAM_BROKEN_RING_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_BROKEN_RING_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const importMap=async file=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});};
    await importMap(file);
    await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.name===source.name&&r.dimensions.worldWidth===source.terrain.worldWidth;},'creative source map');
    const initialCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`creative-before-${Date.now()}`});
    const initial=JSON.parse(await fs.readFile(initialCopy.path,'utf8'));
    assert.deepEqual(initial.baseLayouts,source.baseLayouts);assert.deepEqual(initial.entities,source.entities);assert.deepEqual(initial.terrain,source.terrain);
    report.brokenRingSourceSha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    report.brokenRingLayouts=[];
    if(process.env.WULFRAM_BROKEN_RING_GUI_TEST==='1'){
      const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`),'enabled '+label);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
      const browseBefore=await call('get_editor_state',{sessionId});
      await click('Base builder');await click('Browse base library');
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="Base library collection"]');s.value='Creative';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await evaluate(`(()=>{const s=document.querySelector('[aria-label="Search base library"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'Broken Ring');s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await probe(()=>evaluate(`!!document.querySelector('button[aria-label="Details: Broken Ring"]')`),'Broken Ring card');
      await evaluate(`document.querySelector('button[aria-label="Details: Broken Ring"]').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.base-library-detail svg polyline').length`),5);
      const shot=await callRaw('capture_view',{sessionId});await fs.writeFile(path.join(out,'broken-ring-library.png'),Buffer.from(shot.content[0].data,'base64'));
      await click('Preview on current map');await click('Preview formation');
      await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`),'Broken Ring GUI preview');
      const before=await call('get_editor_state',{sessionId});
      for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(before[key],browseBefore[key]);
      const previewCopy=await call('save_copy',{sessionId,expectedRevision:before.revision,name:`brokenRing-gui-preview-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(previewCopy.path,'utf8')),initial);
      await click('Apply formation');
      const applied=await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.revision!==before.revision?r:false;},'Broken Ring GUI apply');assert.equal(applied.undoCount,before.undoCount+1);
      for(const team of [1,2])assert.equal(applied.entities.filter(e=>e.team===team).length,28);
      const appliedCopy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`brokenRing-gui-applied-${Date.now()}`});
      const saved=JSON.parse(await fs.readFile(appliedCopy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===saved.activeBaseLayoutId);
      assert.equal(layout.metadata['formation.style'],'broken-ring');assert.equal(layout.metadata['formation.version'],'broken-ring-v3');assert.equal(JSON.parse(layout.metadata['forge.build-areas.v1']).length,10);assert.equal(JSON.parse(layout.metadata['formation.brokenRingAccess']).routes.length,8);

      if(process.env.WULFRAM_BROKEN_RING_PORTABLE_TEST==='1'){
        const existingFavorites=await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1')??'[]')`);
        if(process.env.WULFRAM_COURTYARD_PORTABLE_TEST==='1'){assert.ok(report.courtyardPortable?.exportPath);const priorLibrary=JSON.parse(await fs.readFile(report.courtyardPortable.exportPath,'utf8'));assert.deepEqual(existingFavorites,priorLibrary.bases);}
        await click('Save active formation as favorite');
        const favorites=await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`);assert.equal(favorites.length,existingFavorites.length+1);const ringFavorite=favorites.find(f=>!existingFavorites.some(old=>old.id===f.id));assert.ok(ringFavorite);assert.equal(ringFavorite.reservations.version,5);assert.equal(ringFavorite.reservations.areas.length,10);assert.deepEqual(favorites.filter(f=>f.id!==ringFavorite.id),existingFavorites);
        await click('Browse base library');await evaluate(`document.querySelector('.personal-base-library').open=true`);
        const downloads=path.join(out,'brokenRing-downloads');await fs.mkdir(downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await click('Export My bases');
        const exportPath=path.join(downloads,'wulfram-base-library.json');
        const exported=await probe(async()=>{try{return JSON.parse(await fs.readFile(exportPath,'utf8'));}catch{return false;}},'Broken Ring export');assert.equal(exported.version,6);assert.deepEqual(exported.bases,favorites);
        await evaluate(`(()=>{const s=document.querySelector('[aria-label="Manage saved base"]');s.value=${JSON.stringify(ringFavorite.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Remove saved base');
        assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),existingFavorites);
        const importFile=async()=>{const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[aria-label="Import personal base library file"]'});await send('DOM.setFileInputFiles',{nodeId,files:[exportPath]});await probe(()=>evaluate(`document.querySelector('.personal-base-import')?.textContent.includes('1 new')`),'Broken Ring import preview');};
        await importFile();assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),existingFavorites);await click('Cancel library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),existingFavorites);
        await importFile();await click('Apply library import');assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('forge-formation-favorites-v1'))`),favorites);
        await click('Close library');
        const after=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(after[key],applied[key]);
        const copy=await call('save_copy',{sessionId,expectedRevision:after.revision,name:`brokenRing-library-unchanged-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(copy.path,'utf8')),saved);
        report.brokenRingPortable={saved:true,exportPath,favoriteId:ringFavorite.id,preservedExistingFavorites:existingFavorites.length,version:6,exactLibrary:true,previewCancel:true,import:true,mapHistoryUnchanged:true};
      }
      await call('undo',{sessionId,expectedRevision:applied.revision});
      const back=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`ring-gui-undo-${Date.now()}`});
      const restored=JSON.parse(await fs.readFile(back.path,'utf8'));assert.deepEqual(restored.baseLayouts,initial.baseLayouts);assert.deepEqual(restored.entities,initial.entities);assert.deepEqual(restored.terrain,initial.terrain);
      if(process.env.WULFRAM_BROKEN_RING_PORTABLE_TEST==='1'){
        await evaluate(`(()=>{const s=document.querySelector('[aria-label="Formation favorites"]');s.value=${JSON.stringify(report.brokenRingPortable.favoriteId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Preview formation');
        await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply formation'&&!b.disabled)`),'imported Broken Ring preview');
        const before=await call('get_editor_state',{sessionId});await click('Apply formation');
        const after=await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==before.revision?r:false;},'imported Broken Ring apply');assert.equal(after.undoCount,before.undoCount+1);
        const copy=await call('save_copy',{sessionId,expectedRevision:after.revision,name:`brokenRing-favorite-reused-${Date.now()}`});const reused=JSON.parse(await fs.readFile(copy.path,'utf8')),active=reused.baseLayouts.find(l=>l.id===reused.activeBaseLayoutId);
        assert.equal(active.metadata['formation.reservationPolicy'],'broken-ring-v3');const actual=JSON.parse(active.metadata['forge.build-areas.v1']),expected=JSON.parse(layout.metadata['forge.build-areas.v1']);assert.equal(actual.length,10);
        actual.forEach((a,i)=>{assert.equal(a.id,expected[i].id);assert.equal(a.width,expected[i].width);a.points.forEach((p,j)=>p.forEach((n,k)=>assert.ok(Math.abs(n-expected[i].points[j][k])<1e-6)));});
        for(const team of [1,2])assert.equal(active.entities.filter(e=>e.team===team).length,28);
        const projection=entities=>entities.map(e=>({team:e.team,token:e.token,subtype:e.subtype,active:e.active,position:e.position.map(n=>Math.round(n*1e5)/1e5),rotation:e.rotation.map(n=>Math.round(n*1e5)/1e5)}));assert.deepEqual(projection(active.entities),projection(layout.entities));
        const access=JSON.parse(active.metadata['formation.brokenRingAccess']);assert.equal(access.vehicleWidth,80);
        assert.deepEqual(access.routes.map(r=>r.id).sort(),[1,2].flatMap(t=>[0,1,2,3].map(i=>`broken-ring-${t}-${i}`)).sort());
        for(const route of access.routes){assert.deepEqual(route.points,actual.find(a=>a.id===route.id).points);assert.ok(!route.markers.some(m=>m.severity==='blocked'));}
        assert.deepEqual(JSON.parse(active.metadata['formation.brokenRingPlan']),JSON.parse(layout.metadata['formation.brokenRingPlan']));

        await call('undo',{sessionId,expectedRevision:after.revision});const restored=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`brokenRing-favorite-undo-${Date.now()}`});const back=JSON.parse(await fs.readFile(restored.path,'utf8'));assert.deepEqual(back.baseLayouts,initial.baseLayouts);assert.deepEqual(back.entities,initial.entities);assert.deepEqual(back.terrain,initial.terrain);
        report.brokenRingPortable.reuseApplyUndo=true;report.brokenRingPortable.reusedCopy=copy.path;
      }
      report.brokenRingGui={creativeCard:true,fiveBands:true,previewUnchanged:true,applyUndo:true,screenshot:path.join(out,'broken-ring-library.png')};
    }

    for(const arrangement of ['small','standard','large','massive']){
      const before=await call('inspect_map',{sessionId});
      const request={activeLayoutId:before.activeBaseLayoutId,layoutId:`mcp-${arrangement}`,style:'broken-ring',seed:'native-brokenRing',placement:{size:arrangement,x:4000,y:6000,rotation:35,radius:3300,checkAccess:true}};
      const preview=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:true,request});
      assert.equal(preview.revision,before.revision);assert.deepEqual((await call('inspect_map',{sessionId})).entities,before.entities);
      const afterPreview=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(afterPreview[key],before[key]);
      const previewCopy=await call('save_copy',{sessionId,expectedRevision:afterPreview.revision,name:`creative-preview-${arrangement}-${Date.now()}`});assert.deepEqual(JSON.parse(await fs.readFile(previewCopy.path,'utf8')),initial);
      const applied=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request});
      assert.notEqual(applied.revision,before.revision);assert.equal(applied.undoCount,before.undoCount+1);
      assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request})).isError,true);
      const copy=await call('save_copy',{sessionId,expectedRevision:applied.revision,name:`creative-${arrangement}-${Date.now()}`});
      const saved=JSON.parse(await fs.readFile(copy.path,'utf8')),layout=saved.baseLayouts.find(l=>l.id===request.layoutId);
      assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);assert.equal(saved.baseLayouts.length,initial.baseLayouts.length+1);assert.deepEqual(saved.terrain,initial.terrain);
      for(const old of initial.baseLayouts){const kept=saved.baseLayouts.find(l=>l.id===old.id);assert.deepEqual(kept.entities,old.entities);assert.deepEqual(kept.metadata,old.metadata);}
      const duplicate=await callRaw('generate_base_layout',{sessionId,expectedRevision:applied.revision,previewOnly:false,request:{...request,activeLayoutId:request.layoutId}});assert.equal(duplicate.isError,true);assert.equal((await call('get_editor_state',{sessionId})).revision,applied.revision);
      const restored=await call('undo',{sessionId,expectedRevision:applied.revision});
      const undoCopy=await call('save_copy',{sessionId,expectedRevision:restored.revision,name:`creative-undo-${arrangement}-${Date.now()}`});
      const undone=JSON.parse(await fs.readFile(undoCopy.path,'utf8'));assert.deepEqual(undone.baseLayouts,initial.baseLayouts);assert.deepEqual(undone.entities,initial.entities);assert.deepEqual(undone.terrain,initial.terrain);
      assert.equal(layout.metadata['formation.version'],'broken-ring-v3');assert.equal(layout.metadata['formation.style'],'broken-ring');
      for(const team of [1,2])assert.equal(layout.entities.filter(e=>e.team===team).length,{small:18,standard:23,large:28,massive:38}[arrangement]);
      const areas=JSON.parse(layout.metadata['forge.build-areas.v1']),access=JSON.parse(layout.metadata['formation.brokenRingAccess']);
      assert.equal(areas.length,10);assert.equal(access.vehicleWidth,80);assert.equal(access.routes.length,8);
      assert.deepEqual(areas.map(a=>a.id).sort(),[1,2].flatMap(t=>[0,1,2,3,4].map(i=>`broken-ring-${t}-${i}`)).sort());
      assert.deepEqual(access.routes.map(r=>r.id).sort(),[1,2].flatMap(t=>[0,1,2,3].map(i=>`broken-ring-${t}-${i}`)).sort());
      for(const route of access.routes){
        const area=areas.find(a=>a.id===route.id);assert.ok(area);assert.deepEqual(route.points,area.points);
        assert.ok(!route.markers.some(marker=>marker.severity==='blocked'));
      }
      assert.equal(JSON.parse(layout.metadata['formation.brokenRingPlan']).version,'broken-ring-v3');
      const padAccess=JSON.parse(layout.metadata['formation.brokenRingAccess']).serviceAccess;assert.equal(padAccess.clearance,96);assert.equal(padAccess.routes.length,4);assert.ok(padAccess.routes.every(r=>r.markers.length===0));
      // Export the generated saved copy after reopening it, then reimport its ZIP.
      await importMap(copy.path);
      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===request.layoutId;},'Broken Ring generated JSON opened for ZIP');
      const zip=await call('export_map',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`brokenRing-generated-${arrangement}-${Date.now()}`});
      const entries=await readMapArchive(await fs.readFile(zip.path)),embedded=JSON.parse(entries.find(e=>e.name.endsWith('/wulfram-project.json')).text);
      assert.deepEqual(embedded.baseLayouts,saved.baseLayouts);assert.deepEqual(embedded.entities,saved.entities);assert.deepEqual(embedded.terrain,saved.terrain);
      const zipBefore=await call('get_editor_state',{sessionId});
      await importMap(zip.path);
      await probe(async()=>{const r=await call('get_editor_state',{sessionId});return r.revision!==zipBefore.revision;},'Broken Ring ZIP import committed');

      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===request.layoutId;},'brokenRing saved copy reopen');
      const reopenedCopy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`court-reopened-${arrangement}-${Date.now()}`});
      const reopened=JSON.parse(await fs.readFile(reopenedCopy.path,'utf8'));
      assert.deepEqual(reopened.baseLayouts,saved.baseLayouts);assert.deepEqual(reopened.entities,saved.entities);assert.deepEqual(reopened.terrain,saved.terrain);
      await importMap(file);
      await probe(async()=>{const r=await call('inspect_map',{sessionId});return r.activeBaseLayoutId===initial.activeBaseLayoutId&&r.entities.length===initial.entities.length;},'brokenRing source restored');
      report.brokenRingLayouts.push({arrangement,previewUnchanged:true,previewApplyGeometry:true,preservedLayouts:true,duplicateRejected:true,staleRejected:true,undo:true,reopened:true,zipReopened:true,zip:zip.path,copy:copy.path});
    }
  }
  if(process.env.WULFRAM_ENTRANCE_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_ENTRANCE_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const {root:doc}=await send('DOM.getDocument'),{nodeId:input}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});
    await send('DOM.setFileInputFiles',{nodeId:input,files:[file]});
    await probe(async()=>{const r=await call('inspect_entrances',{sessionId});return r.corridors.length===2&&r.corridors.some(c=>c.id==='offset-bastion-approach-1');},'Offset entrance map');
    const before=await call('inspect_entrances',{sessionId});assert.equal(before.policy,null);
    const policy={version:1,bindings:[1,2].map(team=>({team,corridorId:`offset-bastion-approach-${team}`,direction:'forward'}))};
    const changed=await call('set_entrance_routing',{sessionId,expectedRevision:before.revision,activeLayoutId:before.activeLayoutId,policy});
    assert.notEqual(changed.revision,before.revision);assert.equal(changed.undoCount,before.undoCount+1);
    assert.deepEqual((await call('inspect_entrances',{sessionId})).policy,policy);
    const routes=await call('inspect_routes',{sessionId,vehicleWidth:80});assert.equal(routes.error,'');assert.ok(routes.routes.filter(r=>r.kind==='service').every(r=>r.entranceCorridorId));
    assert.equal((await callRaw('set_entrance_routing',{sessionId,expectedRevision:before.revision,activeLayoutId:before.activeLayoutId,policy:null})).isError,true);
    const bad={version:1,bindings:[{team:1,corridorId:'missing',direction:'forward'}]};
    assert.equal((await callRaw('set_entrance_routing',{sessionId,expectedRevision:changed.revision,activeLayoutId:before.activeLayoutId,policy:bad})).isError,true);
    assert.equal((await call('get_editor_state',{sessionId})).revision,changed.revision);
    await call('undo',{sessionId,expectedRevision:changed.revision});
    const restored=await call('inspect_entrances',{sessionId});assert.equal(restored.policy,null);
    const snapshotCopy=await call('save_copy',{sessionId,expectedRevision:restored.revision,name:`entrance-restored-${Date.now()}`});
    const snapshot=JSON.parse(await fs.readFile(snapshotCopy.path,'utf8'));
    assert.deepEqual(snapshot.entities,source.entities);assert.deepEqual(snapshot.terrain,source.terrain);
    report.entrancePolicy={passed:true,sourceSha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),routeCount:routes.routes.length,staleRejected:true,invalidRejected:true,undo:true};
  }
  if(process.env.WULFRAM_ANCHOR_TEST_MAP){
    const file=path.resolve(process.env.WULFRAM_ANCHOR_TEST_MAP),source=JSON.parse(await fs.readFile(file,'utf8'));
    const {root:doc}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});
    await probe(async()=> (await call('inspect_map',{sessionId})).name===source.name,'Anchor source');
    const snapshot=async label=>{const copy=await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`anchor-${label}-${Date.now()}`});return JSON.parse(await fs.readFile(copy.path,'utf8'));};
    const initial=await snapshot('initial');assert.deepEqual(initial,source);
    const history=async previous=>{const current=await call('get_editor_state',{sessionId});for(const key of ['revision','undoCount','redoCount','dirty'])assert.equal(current[key],previous[key]);};
    const before=await call('get_editor_state',{sessionId}),request={activeLayoutId:initial.activeBaseLayoutId,layoutId:'anchor-native',style:'three-lane-anchor',seed:'anchor-native',placement:{size:'small',x:4000,y:6000,rotation:0,radius:3300,targetCount:0}};
    const preview=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:true,request});assert.equal(preview.previewOnly,true);assert.equal(preview.layout.entities.length,30);assert.equal((await call('get_editor_state',{sessionId})).revision,before.revision);assert.deepEqual(await snapshot('preview'),initial);
    await history(before);
    const applied=await call('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request});assert.equal(applied.undoCount,before.undoCount+1);
    const built=await snapshot('applied'),layout=built.baseLayouts.find(l=>l.id===request.layoutId);assert.deepEqual(layout.entities,preview.layout.entities);assert.deepEqual(layout.metadata,preview.layout.metadata);assert.deepEqual(built.baseLayouts[0],initial.baseLayouts[0]);assert.deepEqual(built.terrain,initial.terrain);
    const entrances=JSON.parse(layout.metadata['forge.entrance-routing.v1']);assert.equal(entrances.sockets.length,6);assert.ok(entrances.sockets.every(s=>!s.approach));
    assert.equal((await callRaw('generate_base_layout',{sessionId,expectedRevision:before.revision,previewOnly:false,request})).isError,true);assert.deepEqual(await snapshot('stale'),built);
    const captured=await call('capture_authored_base',{sessionId,expectedRevision:applied.revision,activeLayoutId:built.activeBaseLayoutId,sourceFrame:{origin:[4000,6000,0],yaw:0}});const pack=JSON.parse(captured.packageJson);assert.equal(pack.version,2);assert.deepEqual(pack.entranceRouting,entrances);assert.deepEqual(await snapshot('capture'),built);
    await history(applied);
    const packagePath=path.join(out,'three-lane-anchor-authored-v2.json');await fs.writeFile(packagePath,captured.packageJson);
    await call('undo',{sessionId,expectedRevision:applied.revision});assert.deepEqual(await snapshot('undo'),initial);
    const reuseBefore=await call('get_editor_state',{sessionId}),authoredRequest={activeLayoutId:initial.activeBaseLayoutId,layoutId:'anchor-reused',frame:{origin:[4500,6500,0],yaw:0},terrainMode:'preserve'};
    await call('place_authored_base',{sessionId,expectedRevision:reuseBefore.revision,previewOnly:true,packageJson:captured.packageJson,authoredRequest});await history(reuseBefore);assert.deepEqual(await snapshot('reuse-preview'),initial);
    const reuseApplied=await call('place_authored_base',{sessionId,expectedRevision:reuseBefore.revision,previewOnly:false,packageJson:captured.packageJson,authoredRequest}),reused=await snapshot('reused'),reusedLayout=reused.baseLayouts.at(-1);assert.equal(reuseApplied.undoCount,reuseBefore.undoCount+1);
    assert.deepEqual(JSON.parse(reusedLayout.metadata['forge.entrance-routing.v1']),entrances);assert.deepEqual(JSON.parse(reusedLayout.metadata['forge.build-areas.v1']),JSON.parse(layout.metadata['forge.build-areas.v1']).map(a=>({...a,points:a.points.map(([x,y])=>[x+500,y+500])})));
    assert.equal(reusedLayout.entities.length,layout.entities.length);for(const [i,e] of reusedLayout.entities.entries()){const old=layout.entities[i];for(let axis=0;axis<3;axis++)assert.ok(Math.abs(e.position[axis]-old.position[axis]-(axis<2?500:0))<1e-8);assert.deepEqual(e.rotation,old.rotation);assert.equal(e.token,old.token);assert.equal(e.team,old.team);}
    await call('undo',{sessionId,expectedRevision:reuseApplied.revision});assert.deepEqual(await snapshot('reuse-undo'),initial);
    const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`),label);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
    await click('Base builder');const guiBefore=await call('get_editor_state',{sessionId});
    await evaluate(`(()=>{const option=document.querySelector('option[value="creative:three-lane-anchor"]');if(!option)throw new Error('Anchor option absent');const select=option.closest('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);if(select.value!==option.value)throw new Error('Anchor selection failed');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await probe(()=>evaluate(`document.body.textContent.includes('Pad access and exit checks required')`),'Anchor controls');
    // The controlled selector returns to the unchanged active layout after opening a draft.
    assert.equal(await evaluate(`document.querySelector('option[value="creative:three-lane-anchor"]').closest('select').value`),initial.activeBaseLayoutId);
    assert.equal(await evaluate(`([...document.querySelectorAll('label')].find(l=>l.textContent.includes('Pad access and exit checks required'))?.querySelector('input'))?.disabled`),true);
    await click('Preview formation');await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Apply formation'&&!b.disabled)`),'Anchor candidate');await history(guiBefore);assert.deepEqual(await snapshot('gui-preview'),initial);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});const screenshotPath=path.join(out,'anchor-gui-preview.png');await fs.writeFile(screenshotPath,Buffer.from(screenshot.data,'base64'));
    await click('Apply formation');const guiApplied=await call('get_editor_state',{sessionId});assert.equal(guiApplied.undoCount,guiBefore.undoCount+1);const guiBuilt=await snapshot('gui-built');assert.equal(guiBuilt.entities.length,60);assert.equal(guiBuilt.baseLayouts.at(-1).metadata['formation.style'],'three-lane-anchor');assert.equal(JSON.parse(guiBuilt.baseLayouts.at(-1).metadata['forge.entrance-routing.v1']).sockets.length,6);assert.deepEqual(guiBuilt.terrain,initial.terrain);assert.deepEqual(guiBuilt.baseLayouts[0],initial.baseLayouts[0]);
    await call('undo',{sessionId,expectedRevision:guiApplied.revision});assert.deepEqual(await snapshot('gui-undo'),initial);
    report.threeLaneAnchor={passed:true,sourceSha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),packagePath,screenshotPath,previewApplyUndo:true,staleRejected:true,captureReadonly:true,authoredTranslatePreviewApplyUndo:true,guiPreviewApplyUndo:true};
  }
  if(process.env.WULFRAM_GRAPH_EDIT_TEST==='1'){
   const graphFixture=structuredClone(original);graphFixture.name='Connected road native fixture';
   const gun={id:'graph-gun',token:'g',team:1,position:[1700,500,30],rotation:[0,0,0],active:1};
   const road={id:'graph-road',name:'Graph road',kind:'corridor',team:'1',width:160,points:[[500,500],[1000,500]]};
   graphFixture.entities=[gun];graphFixture.baseLayouts=[{...graphFixture.baseLayouts[0],entities:[gun],metadata:{'forge.build-areas.v1':JSON.stringify([road]),'forge.districts.v1':JSON.stringify([{id:'graph-yard',name:'Gun yard',entityIds:[gun.id]}])}}];graphFixture.activeBaseLayoutId=graphFixture.baseLayouts[0].id;
   const graphFixturePath=path.join(out,'graph-fixture.json');await fs.writeFile(graphFixturePath,JSON.stringify(graphFixture));
   const {root:graphDocument}=await send('DOM.getDocument');const {nodeId:graphInput}=await send('DOM.querySelector',{nodeId:graphDocument.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId:graphInput,files:[graphFixturePath]});
   await probe(async()=>{const current=await call('inspect_map',{sessionId});return current.entities.length===1&&current.entities[0].id==='graph-gun';},'graph fixture import');
   const graphSnapshot=async label=>JSON.parse(await fs.readFile((await call('save_copy',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision,name:`graph-${label}-${Date.now()}`})).path,'utf8'));
   const before=await call('get_editor_state',{sessionId}),initial=await graphSnapshot('initial');
   const graph={version:1,team:1,root:'hub',nodes:[{id:'hub',role:'junction',point:[500,500]},{id:'gun',role:'gun',point:[1000,500],districtId:'graph-yard'}],edges:[{id:'spoke',from:'hub',to:'gun',corridorId:'graph-road',direction:'forward'}]};
   const command={sessionId,expectedRevision:before.revision,activeLayoutId:graphFixture.activeBaseLayoutId,graphEdit:{operation:'upsert',graph}};
   const preview=await call('edit_base_route_graphs',{...command,previewOnly:true});assert.deepEqual(preview.routeGraphs,[graph]);assert.deepEqual(await graphSnapshot('preview'),initial);assert.equal((await call('get_editor_state',{sessionId})).undoCount,before.undoCount);
   const applied=await call('edit_base_route_graphs',{...command,previewOnly:false});assert.equal(applied.undoCount,before.undoCount+1);assert.deepEqual((await call('inspect_map',{sessionId})).routeGraphs,[graph]);
   const built=await graphSnapshot('applied');assert.deepEqual(built.entities,initial.entities);assert.deepEqual(built.terrain,initial.terrain);
   const packageResult=await call('capture_authored_base',{sessionId,expectedRevision:applied.revision,activeLayoutId:graphFixture.activeBaseLayoutId,sourceFrame:{origin:[500,500,0],yaw:0}});const captured=JSON.parse(packageResult.packageJson);assert.equal(captured.version,4);assert.deepEqual(captured.routeGraphs,[graph]);await fs.writeFile(path.join(out,'graph-authored-base.json'),packageResult.packageJson);
   assert.equal((await callRaw('edit_base_route_graphs',{...command,previewOnly:false})).isError,true);assert.deepEqual(await graphSnapshot('stale'),built);
   const removal=await call('edit_base_route_graphs',{sessionId,expectedRevision:applied.revision,activeLayoutId:graphFixture.activeBaseLayoutId,previewOnly:false,graphEdit:{operation:'remove',team:1}});assert.equal(removal.undoCount,applied.undoCount+1);assert.deepEqual((await call('inspect_map',{sessionId})).routeGraphs,[]);
   await call('undo',{sessionId,expectedRevision:removal.revision});assert.deepEqual(await graphSnapshot('undo-remove'),built);
   await call('undo',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision});assert.deepEqual(await graphSnapshot('undo-add'),initial);
   // Exercise the packaged React controls without activating the native window.
   const panel='details[aria-label="Connected roads"]';
   const clickGraph=async text=>{assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(panel+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`),true,`Enabled graph control: ${text}`);};
   assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('.mode-switch button')].find(b=>b.textContent.trim()==='Base builder');if(!b)return false;b.click();return true;})()`),true);
   await probe(()=>evaluate(`!!document.querySelector(${JSON.stringify(panel)})`),'packaged Connected roads panel');
   assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Rules');if(!b)return false;b.click();return true;})()`),true);
   await evaluate(`(()=>{let e=document.querySelector(${JSON.stringify(panel)});while(e){if(e.tagName==='DETAILS')e.open=true;e=e.parentElement;}})()`);
   await probe(()=>evaluate(`document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect().height>0`),'visible Connected roads panel');
   await evaluate(`document.querySelector(${JSON.stringify(panel+' input[type="checkbox"]')}).click()`);
   await clickGraph('Build connection draft');
   const selectGraph=async(label,value)=>evaluate(`(()=>{const s=document.querySelector('select[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!s)throw new Error('Missing selector');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await selectGraph('Role for node-2','gun');await selectGraph('Yard for node-2','graph-yard');
   const guiBefore=await call('get_editor_state',{sessionId});
   await clickGraph('Preview connections');assert.deepEqual(await graphSnapshot('gui-preview'),initial);assert.equal((await call('get_editor_state',{sessionId})).undoCount,guiBefore.undoCount);
   await evaluate(`document.querySelector(${JSON.stringify(panel)}).scrollIntoView({block:'start'})`);
   const guiScreenshot=path.join(out,'connected-roads-gui-preview.png');await fs.writeFile(guiScreenshot,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
   await clickGraph('Apply connections');
   await probe(()=>evaluate(`document.querySelector(${JSON.stringify(panel+' output')})?.textContent.includes('Applied.')`),'GUI persisted success');
   const guiApplied=await call('get_editor_state',{sessionId});assert.equal(guiApplied.undoCount,guiBefore.undoCount+1);
   const guiBuilt=await graphSnapshot('gui-applied'),guiGraphs=(await call('inspect_map',{sessionId})).routeGraphs;
   assert.equal(guiGraphs.length,1);assert.equal(guiGraphs[0].nodes[1].districtId,'graph-yard');assert.deepEqual(guiBuilt.entities,initial.entities);assert.deepEqual(guiBuilt.terrain,initial.terrain);
   await clickGraph('Preview removal');assert.deepEqual(await graphSnapshot('gui-remove-preview'),guiBuilt);
   await clickGraph('Apply connections');await probe(async()=>!(await call('inspect_map',{sessionId})).routeGraphs.length,'GUI removal');
   const guiRemoved=await call('get_editor_state',{sessionId});assert.equal(guiRemoved.undoCount,guiApplied.undoCount+1);
   await call('undo',{sessionId,expectedRevision:guiRemoved.revision});assert.deepEqual(await graphSnapshot('gui-undo-remove'),guiBuilt);
   await call('undo',{sessionId,expectedRevision:(await call('get_editor_state',{sessionId})).revision});assert.deepEqual(await graphSnapshot('gui-undo-add'),initial);
   report.graphEdit={passed:true,previewReadonly:true,applyUndo:true,staleRejected:true,removeUndo:true,version4Capture:true,guiPreviewApplyRemoveUndo:true,guiInteraction:'CDP DOM events in off-screen packaged WebView; not physical pointer or keyboard acceptance',guiScreenshot,fixture:graphFixturePath,fixtureSha256:createHash('sha256').update(await fs.readFile(graphFixturePath)).digest('hex')};
  }
  report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
