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
const out=await fs.mkdtemp(path.join(here,'outputs','depot-portable-native-'));
const fixture=JSON.parse(await fs.readFile(path.join(root,'examples/distributed-depot/small.json'),'utf8'));
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
 const capture=await call('capture_authored_base',{sessionId,expectedRevision:state.revision,activeLayoutId:fixture.activeBaseLayoutId,sourceFrame:{origin:[8000,6000,0],yaw:0}});
 const pack=JSON.parse(capture.packageJson);assert.equal(pack.version,3);assert.equal(pack.serviceRoutes.length,8);assert.deepEqual(await snapshot(),before);
 const request={activeLayoutId:fixture.activeBaseLayoutId,layoutId:'portable-depot',frame:{origin:[8000,6000,0],yaw:Math.PI/12},terrainMode:'conform'};
 const preview=await call('place_authored_base',{sessionId,expectedRevision:state.revision,previewOnly:true,packageJson:capture.packageJson,authoredRequest:request});assert.deepEqual(await snapshot(),before);
 const stale=await client.callTool({name:'place_authored_base',arguments:{sessionId,expectedRevision:'stale',previewOnly:false,packageJson:capture.packageJson,authoredRequest:request}});assert.equal(stale.isError,true);assert.deepEqual(await snapshot(),before);
 await call('place_authored_base',{sessionId,expectedRevision:state.revision,previewOnly:false,packageJson:capture.packageJson,authoredRequest:request});
 const applied=await snapshot();assert.equal(applied.undoCount,before.undoCount+1);assert.deepEqual(applied.project.terrain,before.project.terrain);assert.deepEqual(applied.project.baseLayouts[0],before.project.baseLayouts[0]);
 const active=applied.project.baseLayouts.find(l=>l.id===applied.project.activeBaseLayoutId);assert.deepEqual(active.entities,preview.layout.entities);assert.deepEqual(active.metadata,preview.layout.metadata);
 const routes=JSON.parse(active.metadata['forge.serviceRoutes.v1']).routes;assert.equal(routes.length,8);for(const r of routes){const pad=active.entities.find(e=>e.id===r.padId);assert.ok(pad);assert.ok(Math.hypot(r.points.at(-1)[0]-pad.position[0],r.points.at(-1)[1]-pad.position[1])<1e-5);}
 const c=Math.cos(request.frame.yaw),s=Math.sin(request.frame.yaw);
 for(let i=0;i<fixture.entities.length;i++){const original=fixture.entities[i],actual=active.entities[i],dx=original.position[0]-8000,dy=original.position[1]-6000;assert.ok(Math.hypot(actual.position[0]-(8000+dx*c-dy*s),actual.position[1]-(6000+dx*s+dy*c))<1e-5);assert.ok(Math.abs(actual.rotation[2]-(original.rotation[2]+request.frame.yaw))<1e-5);}
 const sourceRoutes=Object.entries(fixture.baseLayouts.find(l=>l.id===fixture.activeBaseLayoutId).metadata).filter(([k])=>k.startsWith('formation.distributedDepot.')).flatMap(([,v])=>JSON.parse(v).serviceRoutes);
 for(let i=0;i<sourceRoutes.length;i++)for(let j=0;j<sourceRoutes[i].points.length;j++){const [x,y]=sourceRoutes[i].points[j],dx=x-8000,dy=y-6000;assert.ok(Math.hypot(routes[i].points[j][0]-(8000+dx*c-dy*s),routes[i].points[j][1]-(6000+dx*s+dy*c))<1e-5);assert.ok(Math.hypot(pack.serviceRoutes[i].points[j][0]-dx,pack.serviceRoutes[i].points[j][1]-dy)<1e-5);}
 const recaptured=await call('capture_authored_base',{sessionId,expectedRevision:applied.revision,activeLayoutId:active.id,sourceFrame:request.frame});const recapturedRoutes=JSON.parse(recaptured.packageJson).serviceRoutes;assert.equal(recapturedRoutes.length,8);for(let i=0;i<pack.serviceRoutes.length;i++)for(let j=0;j<pack.serviceRoutes[i].points.length;j++)assert.ok(Math.hypot(...pack.serviceRoutes[i].points[j].map((n,k)=>n-recapturedRoutes[i].points[j][k]))<1e-5);
 await call('undo',{sessionId,expectedRevision:applied.revision});assert.deepEqual((await snapshot()).project,before.project);
 const click=async(label,scope='.authored-base-panel')=>{await probe(()=>evaluate(`(()=>{const matches=[...document.querySelectorAll(${JSON.stringify(scope)})].flatMap(s=>[...s.querySelectorAll('button')]).filter(b=>(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.getAttribute('title')===${JSON.stringify(label)})&&!b.disabled);if(matches.length!==1)return false;matches[0].click();return true;})()`),'button '+label);};
 await evaluate(`(()=>{const panel=document.querySelector('.authored-base-panel');for(let el=panel;el;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true;panel.scrollIntoView();})()`);
 await click('Capture active authored base');assert.ok(await evaluate(`document.querySelector('.authored-base-panel').textContent.includes('8 service routes')`));
 await evaluate(`(()=>{document.querySelector('.authored-library-panel').open=true;const input=document.querySelector('[aria-label="Authored library name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Depot service paths');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await click('Save loaded base');
 const library=await evaluate(`JSON.parse(localStorage.getItem('forge-authored-bases-v1'))`);assert.equal(library.entries.length,1);assert.equal(library.entries[0].base.version,3);assert.equal(library.entries[0].base.serviceRoutes.length,8);
 await click('Reload authored library');
 await evaluate(`(()=>{const input=document.querySelector('[aria-label="Saved authored base"]');input.value=${JSON.stringify(library.entries[0].id)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Load saved base');
 await evaluate(`(()=>{const input=document.querySelector('[aria-label="Authored terrain placement"]');input.value='conform';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const guiBefore=await snapshot();await click('Preview authored base');assert.deepEqual(await snapshot(),guiBefore);await click('Apply authored base');const guiApplied=await snapshot();assert.equal(guiApplied.undoCount,guiBefore.undoCount+1);assert.equal(JSON.parse(guiApplied.project.baseLayouts.find(l=>l.id===guiApplied.project.activeBaseLayoutId).metadata['forge.serviceRoutes.v1']).routes.length,8);
 await click('Undo','.history-controls');assert.deepEqual((await snapshot()).project,before.project);
 const shotPath=path.join(out,'depot-authored-library.png');await fs.writeFile(shotPath,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await fs.writeFile(path.join(out,'authored-depot.json'),capture.packageJson);await fs.writeFile(path.join(out,'authored-library.json'),JSON.stringify(library,null,2));
 report.checks={exactImport:true,mcpCaptureV3:true,previewUnchanged:true,staleRejected:true,rotatedPlacement:true,padIdsRemapped:true,recapture:true,guiCapture:true,guiLibrarySaveReload:true,guiPreviewApplyUndo:true,priorLayoutTerrainPreserved:true};report.passed=true;

}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
