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
const {createBlankProject,synchronizeActiveBaseLayout}=await import(pathToFileURL(path.join(root,'lib/wulfram.ts')));
const {createCreativeBaseLayout}=await import(pathToFileURL(path.join(root,'lib/builtin-base-layouts.ts')));
const manifest=JSON.parse(await fs.readFile(path.join(root,'public/assets/manifest.json'),'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
await fs.mkdir(path.join(here,'outputs'),{recursive:true});
const out=await fs.mkdtemp(path.join(here,'outputs','district-arrangement-mcp-native-'));
const fixture=createBlankProject('District arrangement MCP lab',65);
fixture.terrain.heights.fill(0);fixture.terrain.worldWidth=8000;fixture.terrain.worldHeight=6000;
const layout=createCreativeBaseLayout(fixture,manifest,'workshop','arrangement-native','test',{size:'small',x:1800,y:2800,rotation:0,radius:1800,targetCount:12,checkAccess:true});
fixture.entities=layout.entities;fixture.baseLayouts=[layout];fixture.activeBaseLayoutId=layout.id;
const moving=fixture.entities.find(e=>e.token==='g'&&e.team===1);assert.ok(moving);
fixture.baseLayouts[0].metadata['forge.districts.v1']=JSON.stringify([
 {id:'movable',name:'Movable defense',role:'defense',variation:'reposition',entityIds:[moving.id]},
 {id:'fixed',name:'Fixed yard',role:'services',variation:'fixed',entityIds:fixture.entities.filter(e=>e.id!==moving.id).map(e=>e.id)},
]);
synchronizeActiveBaseLayout(fixture);
const expected=JSON.parse(JSON.stringify(fixture));
const fixturePath=path.join(out,'arrangement-lab.json');await fs.writeFile(fixturePath,JSON.stringify(expected));
const report={passed:false,harnessSha256:await hash(fileURLToPath(import.meta.url)),executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),out};
const sessions=path.join(out,'sessions'),profile=path.join(out,'profile');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const probe=async(fn,label)=>{const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error(`Timeout: ${label}`);};
let app,client,socket;let sequence=0;const pending=new Map();
try{
 app=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:sessions,WULFRAM_FORGE_USER_DATA_DIR:profile,WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
 const target=await probe(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json())).find(t=>t.url==='https://wulfram-forge.local/index.html');}catch{return undefined;}},'editor target');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp && !!document.querySelector(\'input[type="file"][multiple]\')'),'editor ready');
 const doc=await send('DOM.getDocument'),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type="file"][multiple]'});
 await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[fixturePath]});
 client=new Client({name:'district-arrangement-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported session');const sessionId=session.sessionId;
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 const before=await snapshot();assert.deepEqual(before.project,expected);
 const args={sessionId,expectedRevision:before.revision,activeLayoutId:fixture.activeBaseLayoutId,previewOnly:true,arrangementSeed:'native-filter',arrangementDistance:80,teamPolicy:'preserve-unpaired',arrangementFilter:{roles:['defense']}};
 const preview=await call('preview_district_arrangement',args);assert.equal(preview.previewOnly,true);assert.equal(preview.candidates.length,3);assert.deepEqual(preview.movedIds,[moving.id]);assert.deepEqual(await snapshot(),before);
 const fixedBefore=before.project.entities.find(e=>e.id!==moving.id),moveBefore=before.project.entities.find(e=>e.id===moving.id);
 const bad=await client.callTool({name:'preview_district_arrangement',arguments:{...args,expectedRevision:'stale',previewOnly:false,optionIndex:0}});assert.equal(bad.isError,true);assert.deepEqual(await snapshot(),before);
 await call('preview_district_arrangement',{...args,previewOnly:false,optionIndex:1});
 const after=await snapshot();assert.equal(after.undoCount,before.undoCount+1);assert.deepEqual(after.project.entities.find(e=>e.id===fixedBefore.id),fixedBefore);assert.notDeepEqual(after.project.entities.find(e=>e.id===moving.id).position,moveBefore.position);assert.deepEqual(after.project.entities.find(e=>e.id===moving.id),preview.candidates[1].moved[0]);
 await call('undo',{sessionId,expectedRevision:after.revision});assert.deepEqual((await snapshot()).project,expected);
 const fixedReject=await client.callTool({name:'preview_district_arrangement',arguments:{...args,expectedRevision:(await snapshot()).revision,arrangementFilter:{districtIds:['fixed']},previewOnly:true}});assert.equal(fixedReject.isError,true);assert.deepEqual((await snapshot()).project,expected);
 report.checks={previewReadOnly:true,roleFilter:true,applyOptionMatchesPreview:true,fixedDistrictPreserved:true,staleRejected:true,fixedSelectionRejected:true,undo:true};report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}


