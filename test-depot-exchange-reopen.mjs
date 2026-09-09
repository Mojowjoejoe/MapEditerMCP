import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.cases.length,4);assert.ok(prior.cases.every(c=>c.libraryExchange));
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
assert.equal(await hash(prior.libraryArtifact.path),prior.libraryArtifact.sha256);
const out=await fs.mkdtemp(path.resolve('outputs/depot-exchange-reopen-'));
const report={passed:false,out,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2]),priorReportSha256:await hash(process.argv[2]),harnessSha256:await hash(process.argv[1]),librarySourceSha256:await hash(prior.libraryArtifact.path)};
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
 const expectedLibrary=JSON.parse(await fs.readFile(prior.libraryArtifact.path,'utf8'));assert.deepEqual(library,expectedLibrary);assert.equal(library.entries[0].base.version,3);
 const saved=prior.cases.at(-1).placed;assert.equal(await hash(saved.path),saved.sha256);const destination=JSON.parse(await fs.readFile(saved.path,'utf8')),destinationFile=saved.path;report.savedMap={path:saved.path,sha256:saved.sha256};
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

 const snapshot=()=>evaluate(`(()=>{const s=window.wulframMcp.dispatch({action:'get_editor_state'});return window.wulframMcp.dispatch({action:'get_snapshot',expectedRevision:s.revision});})()`);
 await probe(async()=>{try{return (await snapshot()).project.name===destination.name;}catch{return false;}});
 assert.deepEqual((await snapshot()).project,destination);
 const loaded=await evaluate(`JSON.parse(localStorage.getItem('forge-authored-bases-v1'))`);assert.deepEqual(loaded,expectedLibrary);
 assert.equal(loaded.entries.length,4);assert.ok(loaded.entries.every(e=>e.base.version===3));
 const shot=await send('Page.captureScreenshot',{format:'png'});const screenshot=path.join(out,'reopened-map.png');await fs.writeFile(screenshot,Buffer.from(shot.data,'base64'));
 report.screenshot={path:screenshot,sha256:await hash(screenshot)};report.pid=app.pid;
 assert.equal(await hash(prior.executable),report.executableSha256);assert.equal(await hash(saved.path),saved.sha256);
 report.completeLibraryPreserved=true;report.exactSavedMapReopened=true;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
