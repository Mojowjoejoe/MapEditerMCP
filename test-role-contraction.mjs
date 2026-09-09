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
const out=await fs.mkdtemp(path.join(here,'outputs','role-contraction-native-'));
let fixture=createBlankProject('Role contraction native',129);
fixture.terrain.worldWidth=12000;fixture.terrain.worldHeight=8000;fixture.terrain.heights.fill(0);
fixture.entities=[1,2].flatMap(team=>['r','f'].map((token,i)=>({id:`source-${team}-${token}`,token,team,position:[2000*team,2000+i*400,0],rotation:[0,0,0],active:1})));
const {COMPOSITION_KEY}=await import(pathToFileURL(path.join(root,'lib/composition-budgets.ts')));
const rules=[{team:1,role:'repair',min:1,max:1},{team:2,role:'refuel',min:1,max:1}];
fixture.baseLayouts[0].entities=structuredClone(fixture.entities);
fixture.baseLayouts[0].metadata[COMPOSITION_KEY]=JSON.stringify(rules);
if(process.argv[3])fixture=JSON.parse(await fs.readFile(path.resolve(process.argv[3]),'utf8'));
const fixturePath=path.join(out,'role-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const harnessCopy=path.join(out,'test-role-contraction.mjs');await fs.copyFile(fileURLToPath(import.meta.url),harnessCopy);
const report={passed:false,executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),harness:harnessCopy,harnessSha256:await hash(harnessCopy),out};
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
 client=new Client({name:'role-contraction-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported hill');const sessionId=session.sessionId;
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 const before=await snapshot();
 assert.deepEqual(before.project,fixture);
 report.cases=[];
 if(process.argv[3]){
  const sourcePath=path.resolve(process.argv[3]);
  report.reopenSource={path:sourcePath,sha256:await hash(sourcePath)};
  const active=before.project.baseLayouts.find(l=>l.id===before.project.activeBaseLayoutId);
  const retained=JSON.parse(active.metadata[COMPOSITION_KEY]);assert.deepEqual(retained,rules);
  const repair=active.entities.find(e=>e.token==='r'&&e.team===1);assert.ok(repair);
  const rejected=await client.callTool({name:'edit_entities',arguments:{sessionId,expectedRevision:before.revision,edits:[{operation:'remove',id:repair.id}]}});
  assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/Repair pads.*short/);
  assert.deepEqual(await snapshot(),before);
  assert.equal(await hash(sourcePath),report.reopenSource.sha256);
  report.reopen={exactProject:true,retainedRules:true,invalidServiceRemovalRejected:true,revisionAndUndoUnchanged:true,activeLayoutId:active.id};
 }else{
 for(const size of ['small','standard','large','massive']){
  const state=await call('get_editor_state',{sessionId}),start=await snapshot();
  const request={activeLayoutId:start.project.activeBaseLayoutId,layoutId:`contract-${size}`,style:'workshop',seed:'role-shrink',placement:{size,x:2800,y:4000,rotation:0,radius:2400,contractRoles:true,checkAccess:false}};
  const preview=await call('generate_base_layout',{sessionId,expectedRevision:state.revision,previewOnly:true,request});
  assert.deepEqual(await snapshot(),start);
  const stale=await client.callTool({name:'generate_base_layout',arguments:{sessionId,expectedRevision:'stale',previewOnly:false,request}});
  assert.equal(stale.isError,true);assert.deepEqual(await snapshot(),start);
  await call('generate_base_layout',{sessionId,expectedRevision:state.revision,previewOnly:false,request});
  const applied=await snapshot(),layout=applied.project.baseLayouts.find(l=>l.id===request.layoutId);
  assert.equal(applied.undoCount,start.undoCount+1);
  assert.deepEqual(applied.project.terrain,start.project.terrain);
  assert.deepEqual(applied.project.baseLayouts[0],start.project.baseLayouts[0]);
  assert.deepEqual(layout.entities,preview.layout.entities);
  assert.deepEqual(JSON.parse(layout.metadata[COMPOSITION_KEY]),rules);
  for(const team of [1,2])for(const token of ['r','f'])assert.equal(layout.entities.filter(e=>e.team===team&&e.token===token).length,1);
  assert.ok(JSON.parse(layout.metadata['formation.access']).routes.length);
  await fs.writeFile(path.join(out,`${size}-applied.json`),JSON.stringify(applied.project));
  await call('undo',{sessionId,expectedRevision:applied.revision});
  const undone=await snapshot();assert.deepEqual(undone.project,start.project);assert.equal(undone.undoCount,start.undoCount);
  report.cases.push({size,previewUnchanged:true,staleRejected:true,counts:true,retainedRules:true,mandatoryAccess:true,oneUndo:true,exactRestoration:true,entities:layout.entities.length,appliedProject:path.join(out,`${size}-applied.json`),appliedProjectSha256:await hash(path.join(out,`${size}-applied.json`))});
 }
 }
 assert.equal(await hash(exe),report.executableSha256);assert.equal(await hash(fixturePath),report.fixtureSha256);
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
