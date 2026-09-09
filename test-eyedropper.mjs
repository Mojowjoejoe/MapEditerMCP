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
const out=await fs.mkdtemp(path.join(here,'outputs','eyedropper-native-'));
const fixture=createBlankProject('Eyedropper lab',129);fixture.terrain.worldWidth=16000;fixture.terrain.worldHeight=12000;
const assets=JSON.parse(await fs.readFile(path.join(root,'public/assets/manifest.json'),'utf8'));const texture=Object.keys(assets.terrainTextures).find(name=>name.startsWith('snow'))??Object.keys(assets.terrainTextures).find(name=>name!=='canyon003');assert.ok(texture);fixture.terrain.heights.fill(137.25);fixture.terrain.tagmap2=[texture];fixture.terrain.textureIds.fill(0);
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
 const before=await snapshot(),state=await call('get_editor_state',{sessionId});assert.deepEqual(before.project,fixture);
 const sampled=await call('sample_terrain',{sessionId,expectedRevision:state.revision,x:8000,y:6000});assert.equal(sampled.sample.z,137.25);assert.equal(sampled.sample.texture,texture);assert.deepEqual(await snapshot(),before);
 for(const args of [{expectedRevision:'stale',x:0,y:0},{expectedRevision:state.revision,x:-1,y:0}]){const bad=await client.callTool({name:'sample_terrain',arguments:{sessionId,...args}});assert.equal(bad.isError,true);assert.deepEqual(await snapshot(),before);}
 await evaluate(`document.querySelector('.mode-switch button').click()`);
 const key=async shift=>{for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:shift?'I':'i',code:'KeyI',windowsVirtualKeyCode:73,modifiers:shift?8:0});};
 const rect=await evaluate(`(()=>{const r=document.querySelector('.terrain-viewport canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
 let point;
 for(const [fx,fy] of [[.5,.6],[.5,.7],[.4,.6],[.6,.6],[.5,.5]]){const p={x:rect.x+rect.width*fx,y:rect.y+rect.height*fy};await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await key(false);if(await evaluate(`document.body.textContent.includes(${JSON.stringify('Sampled '+texture)})`)){point=p;break;}}
 assert.ok(point,'A real terrain hover must sample texture');
 assert.ok(await evaluate(`document.querySelector('.workflow-guide').textContent.includes('Paint')`));assert.equal(await evaluate(`document.querySelector('[aria-label="Choose paint material"]').textContent`),'Material: '+texture);
 await key(true);
 await probe(()=>evaluate(`document.querySelector('[aria-label="Toolbar target height"]')?.value==='137.25'`),'sampled Z tool value');
 assert.deepEqual(await snapshot(),before);
 const shotPath=path.join(out,'eyedropper-height.png');await fs.writeFile(shotPath,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await evaluate(`(()=>{const input=document.querySelector('[aria-label="Toolbar target height"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await key(true);assert.equal(await evaluate(`document.querySelector('[aria-label="Toolbar target height"]').value`),'0');
 await evaluate(`document.querySelector('.terrain-viewport canvas').focus()`);await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:15,y:20});await key(true);assert.equal(await evaluate(`document.querySelector('[aria-label="Toolbar target height"]').value`),'0');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await key(true);await probe(()=>evaluate(`document.querySelector('[aria-label="Toolbar target height"]')?.value==='137.25'`),'resampled cursor after leaving');
 assert.deepEqual(await snapshot(),before);
 report.checks={mcpSample:true,staleRejected:true,boundsRejected:true,textureHotkey:true,heightHotkey:true,typingIgnored:true,outsideIgnored:true,resample:true,fullSnapshotUnchanged:true};report.texture=texture;report.height=137.25;report.screenshot={path:shotPath,sha256:await hash(shotPath)};report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(client)await client.close();if(socket)socket.close();if(app)app.kill();for(const p of pending.values())clearTimeout(p.timer);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error},null,2));}
