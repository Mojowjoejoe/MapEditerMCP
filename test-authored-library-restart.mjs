import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.authoredLibraryGui.panelRemount,true);
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
const report={passed:false,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2])};
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
 assert.deepEqual(library.entries.map(e=>e.name).sort(),['GUI Renamed','Native Renamed']);
 const pack=JSON.parse(await fs.readFile(path.join(prior.out,'wulfram-authored-base.json'),'utf8'));
 for(const entry of library.entries)assert.deepEqual(entry.base,pack);
 // Import the existing acceptance fixture so the inspector is available after restart.
 await probe(()=>evaluate(`document.readyState==="complete"&&!!document.querySelector('input[type="file"][multiple]')`));
 // React may replace the import input during startup. Re-resolve only on a
 // definite stale-node rejection; never replay an import after a timeout.
 for(let attempt=0;attempt<3;attempt++){
  try{
   const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});
   if(!nodeId)throw new Error('Could not find node with given id');
   await send('DOM.setFileInputFiles',{nodeId,files:[path.resolve(process.env.WULFRAM_AUTHORED_TEST_MAP)]});break;
  }catch(error){if(attempt===2||!/Could not find node with given id|No node with given id/.test(String(error)))throw error;}
 }
 await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Base builder')`));
 await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Base builder').click()`);
 await probe(()=>evaluate(`document.querySelector('[aria-label="Saved authored base"]')?.options.length===3`));
 await evaluate(`(()=>{const panel=document.querySelector('.authored-library-panel');for(let p=panel;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;panel.scrollIntoView({block:'center'});})()`);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
 const shot=await send('Page.captureScreenshot',{format:'png'});const screenshot=path.join(prior.out,'authored-library-restart.png');await fs.writeFile(screenshot,Buffer.from(shot.data,'base64'));
 report.persistedCompletePackages=true;report.guiEntriesAfterRestart=true;report.screenshot=screenshot;report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(prior.out,'library-restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
