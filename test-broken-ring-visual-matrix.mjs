import {requestEditor,listSessions} from './editor-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prior=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
assert.equal(prior.passed,true);assert.equal(prior.brokenRingPortable.reuseApplyUndo,true);
assert.equal(createHash('sha256').update(await fs.readFile(prior.executable)).digest('hex'),prior.executableSha256);
const resultOut=await fs.mkdtemp(path.join(prior.out,'brokenRing-visual-matrix-'));
const report={out:resultOut,passed:false,executable:prior.executable,executableSha256:prior.executableSha256,priorReport:path.resolve(process.argv[2])};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
process.env.WULFRAM_MCP_SESSION_DIR=path.join(resultOut,'sessions');
const app=spawn(prior.executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WULFRAM_FORGE_MCP:'1',WULFRAM_MCP_SESSION_DIR:process.env.WULFRAM_MCP_SESSION_DIR,WULFRAM_FORGE_USER_DATA_DIR:path.join(resultOut,'profile'),WULFRAM_FORGE_REMOTE_DEBUGGING_PORT:String(port)}});
let socket;const pending=new Map();let id=0;
const probe=async(fn)=>{const until=Date.now()+45000;while(Date.now()<until){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Restart readiness timed out');};
try{
 const target=await probe(async()=>{const list=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());return list.find(t=>t.url==='https://wulfram-forge.local/index.html');});
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(new Error('CDP timeout'));},15000);pending.set(seq,{resolve,reject,timer});socket.send(JSON.stringify({id:seq,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await probe(()=>evaluate('!!window.wulframMcp'));
 const matrix=JSON.parse(await fs.readFile(path.resolve(process.argv[3]),'utf8'));assert.equal(matrix.cases.length,12);report.cases=[];
 const click=async label=>{await probe(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`));await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);};
 for(const [index,c] of matrix.cases.entries()){
  const bytes=await fs.readFile(path.resolve(c.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),c.sha256);
  const source=JSON.parse(bytes);source.name=`Broken Ring visual ${index} ${c.size}`;source.terrain.tagmap=['0:1snow001'];source.terrain.tagmap2=['1snow001'];
  const file=path.join(resultOut,`sample-${index}.json`);await fs.writeFile(file,JSON.stringify(source));
  const {root}=await send('DOM.getDocument'),{nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"][multiple]'});await send('DOM.setFileInputFiles',{nodeId,files:[file]});
  const session=await probe(async()=>{const sessions=await listSessions();return sessions.length===1&&sessions[0].name===source.name?sessions[0]:false;});
  const call=command=>requestEditor(session.sessionId,command),snapshot=async()=>{const state=await call({action:'get_editor_state'});return (await call({action:'get_snapshot',expectedRevision:state.revision})).project;};
  const initial=await snapshot();assert.deepEqual(initial.entities,source.entities);assert.deepEqual(initial.terrain,source.terrain);assert.deepEqual(initial.baseLayouts,source.baseLayouts);
  await click('Base builder');await click('Inspect');const screenshots=[];
  // Inspect original building silhouettes without the screen-space power badges hiding them.
  await evaluate(`(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()==='Power status icons');const box=label?.querySelector('input[type="checkbox"]');if(!box)throw new Error('Power icon display control missing');if(box.checked)box.click();})()`);
  await click('Team 1 · Overhead');await new Promise(r=>setTimeout(r,350));
  let shot=await send('Page.captureScreenshot',{format:'png'}),image=path.join(resultOut,`${index}-${c.size}-overhead.png`);await fs.writeFile(image,Buffer.from(shot.data,'base64'));screenshots.push(image);
  const repair=initial.entities.find(e=>e.team===1&&e.token==='r');assert.ok(repair);
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Inspect building"]');s.value=${JSON.stringify(repair.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('Close building view');await new Promise(r=>setTimeout(r,350));
  shot=await send('Page.captureScreenshot',{format:'png'});image=path.join(resultOut,`${index}-${c.size}-repair.png`);await fs.writeFile(image,Buffer.from(shot.data,'base64'));screenshots.push(image);
  const center=await evaluate(`(()=>{const r=document.querySelector('canvas[aria-label^="Interactive 3D map viewport"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  for(let step=0;step<10;step++)await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:center.x,y:center.y,deltaX:0,deltaY:100});
  await new Promise(r=>setTimeout(r,500));shot=await send('Page.captureScreenshot',{format:'png'});image=path.join(resultOut,`${index}-${c.size}-service-bank.png`);await fs.writeFile(image,Buffer.from(shot.data,'base64'));screenshots.push(image);
  assert.deepEqual(await snapshot(),initial);
  report.cases.push({size:c.size,seed:c.seed,count:c.count,sourceSha256:c.sha256,screenshots,mapUnchanged:true});
  console.log(`${c.size} ${c.seed} captured`);
 }
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{if(socket)socket.close();app.kill();await fs.writeFile(path.join(resultOut,'brokenRing-visual-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
