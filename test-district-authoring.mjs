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
const out=await fs.mkdtemp(path.join(here,'outputs','district-authoring-native-'));
const fixture=createBlankProject('District handle lab');
const cx=fixture.terrain.worldWidth/2,cy=fixture.terrain.worldHeight/2;
fixture.entities=[['yard-a',cx-100,cy,1],['yard-b',cx+100,cy,1],['other',cx+1000,cy+1000,2]].map(([id,x,y,team])=>({id,token:'e',team,position:[x,y,0],rotation:[0,0,0],active:1}));
fixture.baseLayouts.find(l=>l.id===fixture.activeBaseLayoutId).entities=structuredClone(fixture.entities);
const fixturePath=path.join(out,'depot-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const report={passed:false,harnessSha256:await hash(fileURLToPath(import.meta.url)),executable:exe,executableSha256:await hash(exe),fixture:fixturePath,fixtureSha256:await hash(fixturePath),out};
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
 const before=await snapshot(),state=await call('get_editor_state',{sessionId});


 assert.deepEqual(before.project,fixture);
 const read=p=>JSON.parse(p.baseLayouts.find(l=>l.id===p.activeBaseLayoutId).metadata['forge.districts.v1']??'[]');
 const tick=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const edit=async districtEdit=>{const prior=await snapshot(),args={sessionId,expectedRevision:prior.revision,activeLayoutId:fixture.activeBaseLayoutId,districtEdit};const preview=await call('edit_district',{...args,previewOnly:true});assert.deepEqual(await snapshot(),prior);await call('edit_district',{...args,previewOnly:false});const after=await snapshot();assert.equal(after.undoCount,prior.undoCount+1);assert.deepEqual(read(after.project),preview.districts);assert.deepEqual(after.project.entities,prior.project.entities);assert.deepEqual(after.project.terrain,prior.project.terrain);return after;};
 const created=await edit({operation:'create',district:{id:'yard',name:'Yard',entityIds:['yard-a','yard-b']}});assert.deepEqual(read(created.project),[{id:'yard',name:'Yard',entityIds:['yard-a','yard-b']}]);assert.deepEqual((await call('inspect_map',{sessionId})).districts,read(created.project));
 const invalidBefore=await snapshot();for(const districtEdit of [{operation:'create',district:{id:'yard',name:'Duplicate',entityIds:['yard-a']}},{operation:'update',id:'yard',changes:{entityIds:['absent']}},{operation:'update',id:'yard',changes:{locked:false}},{operation:'remove',id:'gone'}]){const result=await client.callTool({name:'edit_district',arguments:{sessionId,expectedRevision:invalidBefore.revision,activeLayoutId:fixture.activeBaseLayoutId,previewOnly:false,districtEdit}});assert.equal(result.isError,true);assert.deepEqual(await snapshot(),invalidBefore);}
 const stale=await client.callTool({name:'edit_district',arguments:{sessionId,expectedRevision:'stale',activeLayoutId:fixture.activeBaseLayoutId,previewOnly:false,districtEdit:{operation:'remove',id:'yard'}}});assert.equal(stale.isError,true);assert.deepEqual(await snapshot(),invalidBefore);
 await edit({operation:'update',id:'yard',changes:{name:'Power yard',role:'power',variation:'reposition',entityIds:['yard-a']}});
 const locked=await edit({operation:'lock',id:'yard',locked:true});for(const districtEdit of [{operation:'remove',id:'yard'},{operation:'update',id:'yard',changes:{entityIds:['yard-b']}}]){const result=await client.callTool({name:'edit_district',arguments:{sessionId,expectedRevision:locked.revision,activeLayoutId:fixture.activeBaseLayoutId,previewOnly:false,districtEdit}});assert.equal(result.isError,true);assert.deepEqual(await snapshot(),locked);}
 const moved=await client.callTool({name:'transform_district',arguments:{sessionId,expectedRevision:locked.revision,previewOnly:false,districtTransform:{activeLayoutId:fixture.activeBaseLayoutId,entityIds:['yard-a'],dx:10,dy:0,degrees:0,clearance:.25}}});assert.equal(moved.isError,true);assert.deepEqual(await snapshot(),locked);
 const unlocked=await edit({operation:'lock',id:'yard',locked:false});assert.equal(read(unlocked.project)[0].locked,false);const removed=await edit({operation:'remove',id:'yard'});assert.deepEqual(read(removed.project),[]);await call('undo',{sessionId,expectedRevision:removed.revision});assert.deepEqual((await snapshot()).project,unlocked.project);
 const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw new Error('Missing '+${JSON.stringify(label)});b.click();})()`);
 const field=async(label,value,select=false)=>{await evaluate(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']')||[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)})?.querySelector('input');if(!e)throw new Error('Missing field');Object.getOwnPropertyDescriptor(${select?'HTMLSelectElement':'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('${select?'change':'input'}',{bubbles:true}));})()`);await tick();};
 await click('Base builder');await evaluate(`document.querySelector('.district-panel').open=true`);await tick();await field('District to update','yard',true);await field('District name','GUI renamed');const guiBefore=await snapshot();await click('Rename district');await tick();const renamed=await snapshot();assert.equal(renamed.undoCount,guiBefore.undoCount+1);assert.equal(read(renamed.project)[0].name,'GUI renamed');assert.equal(read(renamed.project)[0].role,'power');await click('Lock GUI renamed');await tick();assert.equal(read((await snapshot()).project)[0].locked,true);await click('Unlock district GUI renamed');await tick();assert.equal(read((await snapshot()).project)[0].locked,false);
 await evaluate(`document.querySelector('[aria-label="Select district building yard-b"]').click()`);await tick();await field('District name','GUI new group');const createBefore=await snapshot();await click('Save named district');await tick();const guiCreated=await snapshot();assert.equal(guiCreated.undoCount,createBefore.undoCount+1);assert.equal(read(guiCreated.project).length,2);assert.deepEqual(guiCreated.project.entities,fixture.entities);
 const shot=path.join(out,'district-records.png');await fs.writeFile(shot,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));report.screenshots=[{path:shot,sha256:await hash(shot)}];
 const saved=await call('save_copy',{sessionId,expectedRevision:guiCreated.revision,name:'district-authoring-'+Date.now()});assert.deepEqual(JSON.parse(await fs.readFile(saved.path,'utf8')),guiCreated.project);assert.deepEqual(await snapshot(),guiCreated);const savedDom=await send('DOM.getDocument'),savedInput=await send('DOM.querySelector',{nodeId:savedDom.root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId:savedInput.nodeId,files:[saved.path]});try{await probe(async()=>{const loaded=await snapshot();if(loaded.revision===guiCreated.revision)return false;try{assert.deepEqual(loaded.project,guiCreated.project);return true;}catch{return false;}},'saved district map reload');}catch(error){report.reloadObserved=await snapshot();report.reloadExpected=guiCreated;report.reloadFile=saved;throw error;}report.savedCopy={path:saved.path,sha256:await hash(saved.path),exactReimport:true};
 const malformed=structuredClone(fixture);malformed.name='Malformed district inspection';malformed.baseLayouts.find(l=>l.id===malformed.activeBaseLayoutId).metadata['forge.districts.v1']='{broken';const corruptPath=path.join(out,'malformed.json');await fs.writeFile(corruptPath,JSON.stringify(malformed));const doc2=await send('DOM.getDocument'),fileInput=await send('DOM.querySelector',{nodeId:doc2.root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:[corruptPath]});await probe(async()=>JSON.stringify((await snapshot()).project)===JSON.stringify(malformed),'malformed import');const corruptBefore=await snapshot(),inspection=await call('inspect_map',{sessionId});assert.equal(inspection.districts,null);assert.ok(inspection.districtError);assert.deepEqual(inspection.entities,malformed.entities);assert.ok(inspection.authoringProblems.some(p=>p.section==='districts'&&p.message.includes('Cannot read saved districts')));assert.deepEqual(await snapshot(),corruptBefore);const reject=await client.callTool({name:'edit_district',arguments:{sessionId,expectedRevision:corruptBefore.revision,activeLayoutId:malformed.activeBaseLayoutId,previewOnly:false,districtEdit:{operation:'remove',id:'yard'}}});assert.equal(reject.isError,true);assert.deepEqual(await snapshot(),corruptBefore);
 report.checks={previewReadOnly:true,applyMatchesPreview:true,allRecordOperations:true,staleInvalidRejected:true,lockedMembershipRemovalRejected:true,lockedTransformRejected:true,explicitUnlockCommitted:true,removeUndo:true,guiRenameLockUnlockCreate:true,entitiesTerrainPreserved:true,malformedInspectionRetained:true};report.malformedFixture={path:corruptPath,sha256:await hash(corruptPath)};report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
