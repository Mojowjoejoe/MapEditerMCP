import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.checks.guiLibrarySaveReload,true);
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
const out=await fs.mkdtemp(path.resolve('outputs/depot-library-restart-'));
const report={passed:false,out,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2]),priorReportSha256:await hash(process.argv[2]),harnessSha256:await hash(process.argv[1]),librarySourceSha256:await hash(path.join(prior.out,'authored-library.json'))};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const app=spawn(prior.executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:path.join(prior.out,'restart-sessions'),WULFRAM_FORGE_USER_DATA_DIR:path.join(prior.out,'profile'),WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
let socket;const pending=new Map();let id=0;
const probe=async(fn)=>{const until=Date.now()+45000;while(Date.now()<until){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Restart readiness timed out');};
try{
 const target=await probe(async()=>{const list=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());return list.find(t=>t.url==='https://wulfram-forge.local/index.html');});
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(new Error('CDP timeout'));},15000);pending.set(seq,{resolve,reject,timer});socket.send(JSON.stringify({id:seq,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp'));
 const library=await evaluate(`JSON.parse(localStorage.getItem('forge-authored-bases-v1'))`);
 const expectedLibrary=JSON.parse(await fs.readFile(path.join(prior.out,'authored-library.json'),'utf8'));assert.deepEqual(library,expectedLibrary);assert.equal(library.entries[0].base.version,3);
 const {createBlankProject}=await import('../../../lib/wulfram.ts');const destination=createBlankProject('Restart Depot destination',129);destination.terrain.worldWidth=24000;destination.terrain.worldHeight=20000;destination.terrain.heights.fill(0);const destinationFile=path.join(out,'destination.json');await fs.writeFile(destinationFile,JSON.stringify(destination));
 // Import the existing acceptance fixture so the inspector is available after restart.
 await probe(()=>evaluate(`document.readyState==="complete"&&!!document.querySelector('input[type="file"][multiple]')`));
 // React may replace the import input during startup. Re-resolve only on a
 // definite stale-node rejection; never replay an import after a timeout.
 for(let attempt=0;attempt<3;attempt++){
  try{
   const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});
   if(!nodeId)throw new Error('Could not find node with given id');
   await send('DOM.setFileInputFiles',{nodeId,files:[destinationFile]});break;
  }catch(error){if(attempt===2||!/Could not find node with given id|No node with given id/.test(String(error)))throw error;}
 }
 await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Base builder')`));
 await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Base builder').click()`);
 await probe(()=>evaluate(`document.querySelector('[aria-label="Saved authored base"]')?.options.length===2`));
 await evaluate(`(()=>{const panel=document.querySelector('.authored-library-panel');for(let p=panel;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;panel.scrollIntoView({block:'center'});})()`);

 const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.title===${JSON.stringify(label)});if(!b)throw new Error('Missing button');b.click();})()`);
 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 await probe(async()=>{try{return (await snapshot()).project.name===destination.name;}catch{return false;}});
 const before=await snapshot();assert.deepEqual(before.project,destination);
 await evaluate(`(()=>{const select=document.querySelector('[aria-label="Saved authored base"]');select.value=${JSON.stringify(library.entries[0].id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Load saved base');
 for(const [label,value] of [['Authored origin X',12000],['Authored origin Y',10000],['Authored rotation degrees',30]])await evaluate(`(()=>{const input=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(${value}));input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await evaluate(`(()=>{const input=document.querySelector('[aria-label="Authored terrain placement"]');input.value='conform';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await click('Preview authored base');assert.deepEqual(await snapshot(),before);await click('Apply authored base');const after=await snapshot();assert.equal(after.undoCount,before.undoCount+1);assert.deepEqual(after.project.terrain,destination.terrain);assert.deepEqual(after.project.baseLayouts.slice(0,-1),destination.baseLayouts);
 const pack=library.entries[0].base,layout=after.project.baseLayouts.at(-1),yaw=Math.PI/6;
 assert.equal(layout.entities.length,pack.geometry.units.length);
 pack.geometry.units.forEach((u,i)=>{const [x,y]=u.position;assert.ok(Math.hypot(layout.entities[i].position[0]-(12000+x*Math.cos(yaw)-y*Math.sin(yaw)),layout.entities[i].position[1]-(10000+x*Math.sin(yaw)+y*Math.cos(yaw)))<1e-5);});
 const routes=JSON.parse(layout.metadata['forge.serviceRoutes.v1']).routes;assert.equal(routes.length,8);for(const [i,r] of pack.serviceRoutes.entries()){assert.equal(routes[i].padId,layout.entities[r.padIndex].id);r.points.forEach(([x,y],j)=>assert.ok(Math.hypot(routes[i].points[j][0]-(12000+x*Math.cos(yaw)-y*Math.sin(yaw)),routes[i].points[j][1]-(10000+x*Math.sin(yaw)+y*Math.cos(yaw)))<1e-5));}
 await fs.writeFile(path.join(out,'placed.json'),JSON.stringify(after.project));await fs.writeFile(path.join(out,'persisted-library.json'),JSON.stringify(library));
 await click('Undo');assert.deepEqual((await snapshot()).project,destination);
 const shot=await send('Page.captureScreenshot',{format:'png'});const screenshot=path.join(out,'depot-library-restart.png');await fs.writeFile(screenshot,Buffer.from(shot.data,'base64'));
 report.artifacts=await Promise.all(['destination.json','placed.json','persisted-library.json','depot-library-restart.png'].map(async name=>({path:path.join(out,name),sha256:await hash(path.join(out,name))})));
 assert.equal(await hash(prior.executable),report.executableSha256);
 assert.equal(await hash(process.argv[2]),report.priorReportSha256);
 assert.equal(await hash(path.join(prior.out,'authored-library.json')),report.librarySourceSha256);
 report.persistedCompletePackages=true;report.guiLoadPreviewApplyUndo=true;report.independentCoordinates=true;report.screenshot=screenshot;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
