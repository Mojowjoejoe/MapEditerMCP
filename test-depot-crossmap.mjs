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
const terrainKind=process.argv[3]??'flat';
assert.ok(['flat','valley','irregular'].includes(terrainKind),'Choose flat, valley or irregular destination terrain.');
if(!process.argv[2])throw new Error('Pass the private editor executable.');
const {createBlankProject}=await import(pathToFileURL(path.join(root,'lib/wulfram.ts')));
const {BUILD_AREAS_KEY}=await import(pathToFileURL(path.join(root,'lib/build-areas.ts')));
await fs.mkdir(path.join(here,'outputs'),{recursive:true});
const out=await fs.mkdtemp(path.join(here,'outputs','depot-crossmap-native-'));
const fixture=JSON.parse(await fs.readFile(path.join(root,'examples/distributed-depot/small.json'),'utf8'));
const fixturePath=path.join(out,'depot-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const report={passed:false,terrainKind,harnessSha256:await hash(fileURLToPath(import.meta.url)),executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),out};
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
 client=new Client({name:'depot-generation-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported hill');const sessionId=session.sessionId;
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);

 const importProject=async(project,name)=>{
  const file=path.join(out,name+'.json');await fs.writeFile(file,JSON.stringify(project));
  const doc=await send('DOM.getDocument'),node=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type="file"][multiple]'});
  await send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});
  await probe(async()=>{const state=await snapshot();return state.project.name===project.name;},'import '+name);
  assert.deepEqual((await snapshot()).project,project);return {path:file,sha256:await hash(file)};
 };
 report.cases=[];
 for(const size of ['small','standard','large','massive']){
  const sourcePath=path.join(root,'examples/distributed-depot',size+'.json'),source=JSON.parse(await fs.readFile(sourcePath,'utf8'));source.name='Depot crossmap source '+size;
  const sourceArtifact=await importProject(source,'source-'+size),sourceState=await snapshot();
  const captured=await call('capture_authored_base',{sessionId,expectedRevision:sourceState.revision,activeLayoutId:source.activeBaseLayoutId,sourceFrame:{origin:[8000,6000,0],yaw:0}});
  assert.deepEqual(await snapshot(),sourceState);const pack=JSON.parse(captured.packageJson);assert.equal(pack.version,3);
  const destination=createBlankProject('Crossmap destination '+size,129);destination.terrain.worldWidth=24000;destination.terrain.worldHeight=20000;destination.terrain.heights.fill(0);destination.baseLayouts[0].metadata.custom='retain destination metadata';
  const terrain=destination.terrain;
  for(let y=0;y<terrain.height;y++)for(let x=0;x<terrain.width;x++){
   const nx=x/(terrain.width-1),ny=y/(terrain.height-1);
   terrain.heights[y*terrain.width+x]=terrainKind==='flat'?0:terrainKind==='valley'?90*(2*ny-1)**2:80+35*Math.cos(4*Math.PI*nx)*Math.cos(6*Math.PI*ny)+20*Math.cos(8*Math.PI*nx);
  }
  const destinationArtifact=await importProject(destination,'destination-'+size),before=await snapshot();
  const yaw=Math.PI/6,frame={origin:[12000,10000,0],yaw},request={activeLayoutId:destination.activeBaseLayoutId,layoutId:'placed-'+size,frame,terrainMode:'conform'};
  const preview=await call('place_authored_base',{sessionId,expectedRevision:before.revision,previewOnly:true,packageJson:captured.packageJson,authoredRequest:request});assert.deepEqual(await snapshot(),before);
  await call('place_authored_base',{sessionId,expectedRevision:before.revision,previewOnly:false,packageJson:captured.packageJson,authoredRequest:request});const after=await snapshot(),layout=after.project.baseLayouts.at(-1);
  assert.equal(after.undoCount,before.undoCount+1);assert.deepEqual(after.project.terrain,destination.terrain);assert.deepEqual(after.project.baseLayouts.slice(0,-1),destination.baseLayouts);assert.deepEqual(layout.entities,preview.layout.entities);
  assert.ok(layout.entities.every(e=>[...e.position,...e.rotation].every(Number.isFinite)));
  const placedHeights=layout.entities.map(e=>e.position[2]);
  if(terrainKind!=='flat')assert.ok(Math.max(...placedHeights)-Math.min(...placedHeights)>1,'Non-flat fixture must produce meaningful placed-height variation.');
  const expectedXY=([x,y])=>[(x-8000)*Math.cos(yaw)-(y-6000)*Math.sin(yaw)+12000,(x-8000)*Math.sin(yaw)+(y-6000)*Math.cos(yaw)+10000];
  assert.equal(layout.entities.length,source.entities.length);source.entities.forEach((entity,i)=>{for(const key of ['token','team','active','subtype'])assert.deepEqual(layout.entities[i][key],entity[key]);assert.ok(Math.abs(layout.entities[i].rotation[2]-entity.rotation[2]-yaw)<1e-5);const xy=expectedXY(entity.position);assert.ok(Math.hypot(layout.entities[i].position[0]-xy[0],layout.entities[i].position[1]-xy[1])<1e-5);});
  const sourceRoutes=Object.entries(source.baseLayouts[0].metadata).filter(([k])=>k.startsWith('formation.distributedDepot.')).flatMap(([,raw])=>JSON.parse(raw).serviceRoutes);
  const routes=JSON.parse(layout.metadata['forge.serviceRoutes.v1']).routes;assert.equal(routes.length,sourceRoutes.length);
  sourceRoutes.forEach((r,i)=>{assert.equal(routes[i].width,80);assert.equal(routes[i].points.length,r.points.length);assert.equal(routes[i].padId,layout.entities[source.entities.findIndex(e=>e.id===r.padId)].id);r.points.forEach((p,j)=>{const expected=expectedXY(p);assert.ok(Math.hypot(routes[i].points[j][0]-expected[0],routes[i].points[j][1]-expected[1])<1e-5);});const pad=layout.entities.find(e=>e.id===routes[i].padId);assert.ok(pad&&['r','f'].includes(pad.token));assert.deepEqual(routes[i].points.at(-1),pad.position.slice(0,2));});
  const recaptured=JSON.parse((await call('capture_authored_base',{sessionId,expectedRevision:after.revision,activeLayoutId:request.layoutId,sourceFrame:frame})).packageJson);
  const recapturePath=path.join(out,'recaptured-'+size+'.json');await fs.writeFile(recapturePath,JSON.stringify(recaptured));
  pack.serviceRoutes.forEach((r,i)=>r.points.forEach((p,j)=>assert.ok(Math.hypot(p[0]-recaptured.serviceRoutes[i].points[j][0],p[1]-recaptured.serviceRoutes[i].points[j][1])<1e-5)));
  const placedPath=path.join(out,'placed-'+size+'.json');await fs.writeFile(placedPath,JSON.stringify(after.project));
  await call('undo',{sessionId,expectedRevision:after.revision});assert.deepEqual((await snapshot()).project,destination);
  report.cases.push({size,recaptured:{path:recapturePath,sha256:await hash(recapturePath)},source:sourceArtifact,destination:destinationArtifact,placed:{path:placedPath,sha256:await hash(placedPath)},units:layout.entities.length,routes:routes.length,independentCoordinates:true,previewUnchanged:true,priorLayoutTerrainPreserved:true,recapture:true,undo:true});
 }
 assert.equal(await hash(exe),report.executableSha256);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
