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
const out=await fs.mkdtemp(path.join(here,'outputs','service-overlay-native-'));
const fixture=JSON.parse(await fs.readFile(path.join(root,'examples/distributed-depot/small.json'),'utf8'));
if(process.argv[3]==='generic'){const metadata=fixture.baseLayouts.find(l=>l.id===fixture.activeBaseLayoutId).metadata;const routes=[];for(const [key,raw] of Object.entries(metadata))if(key.startsWith('formation.distributedDepot.')){routes.push(...JSON.parse(raw).serviceRoutes.map(r=>({...r,width:80})));delete metadata[key];}metadata['forge.serviceRoutes.v1']=JSON.stringify({version:1,routes,custom:'retain me'});}
const movedPad=fixture.entities.find(e=>e.token==='r');movedPad.position[0]+=10;fixture.baseLayouts.find(l=>l.id===fixture.activeBaseLayoutId).entities=structuredClone(fixture.entities);
const fixturePath=path.join(out,'depot-lab.json');await fs.writeFile(fixturePath,JSON.stringify(fixture));
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
 client=new Client({name:'depot-generation-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',path.join(here,'server.mjs')],env:{...process.env,WULFRAM_MCP_SESSION_DIR:sessions},stderr:'pipe'}));
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 const session=await probe(async()=>{const r=await call('list_editor_sessions');return r.sessions.find(s=>s.ready&&s.name===fixture.name);},'imported hill');const sessionId=session.sessionId;
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 const before=await snapshot(),state=await call('get_editor_state',{sessionId});


 assert.deepEqual(before.project,fixture);
 const inspection=await call('inspect_service_routes',{sessionId});assert.equal(inspection.routes.filter(r=>!r.endpointConnected).length,1);assert.deepEqual(await snapshot(),before);
 assert.ok((await call('inspect_map',{sessionId})).authoringProblems.some(p=>p.section==='service'));assert.deepEqual(await snapshot(),before);
 const stale=await client.callTool({name:'reconnect_service_route',arguments:{sessionId,expectedRevision:'stale',activeLayoutId:fixture.activeBaseLayoutId,padId:movedPad.id}});assert.equal(stale.isError,true);assert.deepEqual(await snapshot(),before);
 await call('reconnect_service_route',{sessionId,expectedRevision:state.revision,activeLayoutId:fixture.activeBaseLayoutId,padId:movedPad.id});
 const applied=await snapshot();assert.equal(applied.undoCount,before.undoCount+1);
 const expected=structuredClone(fixture),metadata=expected.baseLayouts.find(l=>l.id===expected.activeBaseLayoutId).metadata;
 for(const [key,raw] of Object.entries(metadata))if(key.startsWith('formation.distributedDepot.')||key==='forge.serviceRoutes.v1'){const data=JSON.parse(raw),route=(data.serviceRoutes??data.routes).find(r=>r.padId===movedPad.id);if(route){route.points[route.points.length-1]=movedPad.position.slice(0,2);metadata[key]=JSON.stringify(data);}}
 const content=p=>{const c=structuredClone(p);delete c.updatedAt;for(const l of c.baseLayouts)delete l.updatedAt;return c;};assert.deepEqual(content(applied.project),content(expected));assert.deepEqual((await call('inspect_service_routes',{sessionId})).problems,[]);
 await call('undo',{sessionId,expectedRevision:applied.revision});assert.deepEqual((await snapshot()).project,fixture);
 const click=async(label,selector='body')=>evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(selector)})||document;const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.title===${JSON.stringify(label)});if(!b)throw new Error('Missing button '+${JSON.stringify(label)});b.click();})()`);
 await evaluate(`(()=>{document.querySelector('.tool-finder').open=true;const input=document.querySelector('[aria-label="Find editor tools"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'detached pad');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await click('Inspect and reconnect service paths','.tool-finder');
 await probe(()=>evaluate(`document.querySelector('.service-route-panel')?.open && !document.querySelector('[data-inspector-page="rules"]').hidden`),'search destination');
 assert.deepEqual((await snapshot()).project,fixture);
 await evaluate(`document.querySelector('.service-route-panel').open=false;document.querySelector('.authoring-problems-panel').open=true`);
 await click('Open Service paths','.authoring-problems-panel');
 await probe(()=>evaluate(`document.querySelector('.service-route-panel').open`),'problem destination');
 assert.ok(await evaluate(`document.querySelector('.service-route-panel').textContent.includes('Endpoint detached')`));
 const guiBefore=await snapshot();await click('Reconnect endpoint to pad','.service-route-panel');
 const guiAfter=await snapshot();assert.equal((await call('inspect_map',{sessionId})).authoringProblems.filter(p=>p.section==='service').length,0);assert.ok(await evaluate(`document.querySelector('.authoring-problems-panel summary').textContent.includes('· 0')`));assert.equal(guiAfter.undoCount,guiBefore.undoCount+1);assert.deepEqual(content(guiAfter.project),content(expected));
 await fs.writeFile(path.join(out,'service-path-repair.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await click('Undo','.history-controls');assert.deepEqual((await snapshot()).project,fixture);

 const r0=(await call('inspect_service_routes',{sessionId})).routes.find(r=>r.padId===movedPad.id),end=movedPad.position.slice(0,2),points=[r0.points[0],r0.points[0].map((n,i)=>(n+end[i])/2),end];
 const editBefore=await snapshot(),request={sessionId,expectedRevision:editBefore.revision,activeLayoutId:fixture.activeBaseLayoutId,padId:movedPad.id,points};
 const preview=await call('edit_service_route',{...request,previewOnly:true});assert.equal(preview.previewOnly,true);assert.deepEqual(await snapshot(),editBefore);
 const rejected=await client.callTool({name:'edit_service_route',arguments:{...request,expectedRevision:'stale',previewOnly:false}});assert.equal(rejected.isError,true);assert.deepEqual(await snapshot(),editBefore);
 await call('edit_service_route',{...request,previewOnly:false});const editAfter=await snapshot();assert.equal(editAfter.undoCount,editBefore.undoCount+1);
 assert.deepEqual((await call('inspect_service_routes',{sessionId})).routes.find(r=>r.padId===movedPad.id).points,points);
 await call('undo',{sessionId,expectedRevision:editAfter.revision});assert.deepEqual((await snapshot()).project,fixture);
 await click('Reconnect endpoint to pad','.service-route-panel');
 await evaluate(`document.querySelector('.service-route-panel details').open=true`);
 await click('Load current path','.service-route-panel');await click('Insert after point 1','.service-route-panel');
 const draftBefore=await snapshot();await click('Preview path changes','.service-route-panel');assert.deepEqual(await snapshot(),draftBefore);
 assert.equal(await evaluate(`document.querySelector('.service-route-panel').textContent.includes('Access checks passed')`),true);
 await click('Apply path changes','.service-route-panel');const draftAfter=await snapshot();assert.equal(draftAfter.undoCount,draftBefore.undoCount+1);
 assert.deepEqual((await call('inspect_service_routes',{sessionId})).routes.find(r=>r.padId===movedPad.id).points,points);
 await click('Undo','.history-controls');assert.deepEqual((await snapshot()).project,draftBefore.project);
 await fs.writeFile(path.join(out,'path-point-editor.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 report.fullPathEditing={mcpPreviewUnchanged:true,mcpStaleRejected:true,mcpApplyUndo:true,guiInsertPreviewApplyUndo:true};

 await click('Load current path','.service-route-panel');
 const overlayBefore=await snapshot();
 await evaluate(`(()=>{const checkbox=[...document.querySelectorAll('.service-route-panel input[type="checkbox"]')][0];checkbox.click();})()`);
 await new Promise(r=>setTimeout(r,400));
 await fs.writeFile(path.join(out,'draft-visible.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 assert.deepEqual(await snapshot(),overlayBefore);
 await evaluate(`document.querySelector('.service-route-panel details').open=false`);await new Promise(r=>setTimeout(r,200));
 await fs.writeFile(path.join(out,'draft-closed.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));assert.deepEqual(await snapshot(),overlayBefore);
 await evaluate(`document.querySelector('.service-route-panel details').open=true`);await click('Terrain');await new Promise(r=>setTimeout(r,200));assert.deepEqual(await snapshot(),overlayBefore);
 await fs.writeFile(path.join(out,'terrain-no-draft.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 report.draftOverlay={showAndCloseCaptured:true,modeSwitchCaptured:true,mapHistoryUnchanged:true};
 report.recordKind=process.argv[3]??'depot';report.checks={toolSearch:true,problemNavigation:true,problemRefresh:true,exactImport:true,readOnlyInspection:true,staleRejected:true,mcpRepairExact:true,guiRepairExact:true,oneUndo:true,metadataPreserved:true};report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
