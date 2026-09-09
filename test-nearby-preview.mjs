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
const out=await fs.mkdtemp(path.join(here,'outputs','nearby-preview-native-'));
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
 const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw new Error('Missing enabled '+${JSON.stringify(label)});b.click();})()`);
 for(const size of ['small','standard','large','massive']){
  const source=JSON.parse(await fs.readFile(path.join(root,'examples/distributed-depot',size+'.json'),'utf8'));source.name='Depot visual '+size;source.terrain.tagmap=['0:4sand001'];source.terrain.tagmap2=['4sand001'];
  const sourceArtifact=await importProject(source,'source-'+size),before=await snapshot();
  await click('Base builder');
  await evaluate(`(()=>{const panel=document.querySelector('.authored-base-panel');for(let p=panel;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;})()`);
  await click('Capture active authored base');await click('Preview authored base');
  await probe(()=>evaluate(`!!document.querySelector('[aria-label="Authored preview cameras"]')`),'authored preview');

  const setCheck=async(label,wanted)=>{
   await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)});const c=l?.querySelector('input[type="checkbox"]');if(!c)throw new Error('Missing display control');if(c.checked!==${wanted})c.click();})()`);
   assert.equal(await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)});return l.querySelector('input').checked;})()`),wanted);
  };
  for(const label of ['Power status icons','Power tint','Terrain grid','Power circles','Building area circles','Show access routes'])await setCheck(label,false);
  await setCheck('Show display overlays',true);await setCheck('Reserved areas and corridors',true);
  const screenshots=[];

  const setRadius=value=>evaluate(`(()=>{const i=document.querySelector('[aria-label="Nearby preview radius"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,String(${value}));i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  for(const team of [1,2]){
   await evaluate(`(()=>{const s=document.querySelector('[aria-label="Authored preview building"]');const o=[...s.options].find(o=>o.textContent.includes('Team '+${team}+' · Power Cell'));if(!o)throw new Error('Missing power cell');s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   for(const radius of [49,2001]){
    await setRadius(radius);assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Overview nearby buildings');return b.disabled;})()`),true);
   }
   for(const radius of [500,200]){
    await setRadius(radius);const cameraBefore=await snapshot();await click('Overview nearby buildings');await new Promise(r=>setTimeout(r,800));assert.deepEqual(await snapshot(),cameraBefore);
    const file=path.join(out,size+'-team'+team+'-radius'+radius+'.png');await fs.writeFile(file,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));screenshots.push({team,radius,path:file,sha256:await hash(file)});
   }
  }
  assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).undoCount,before.undoCount);await click('Cancel authored preview');
  assert.deepEqual((await snapshot()).project,before.project);
  report.cases.push({size,source:sourceArtifact,screenshots,projectAndUndoCountPreserved:true,displayControlsVerified:true});
 }
 assert.equal(await hash(exe),report.executableSha256);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
