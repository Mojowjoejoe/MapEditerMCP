import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
export const sessionDirectory=()=>process.env.WULFRAM_MCP_SESSION_DIR??path.join(process.env.LOCALAPPDATA??'', 'BlackwaterGaming','WulframForge','mcp-sessions');
export async function readSession(id) {
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid editor session ID.');
  const s=JSON.parse(await fs.readFile(path.join(sessionDirectory(),`${id}.json`),'utf8'));
  if(s.protocolVersion!==1||s.sessionId!==id||s.pipeName!==`WulframForge-${id}`||!/^[A-F0-9]{64}$/.test(s.token))throw new Error('Invalid editor session descriptor.');
  return s;
}
const sessions = new Map();
export async function requestEditor(id,command,timeout=30000) {
  const deadline = Date.now()+timeout;
  // The native host accepts one connection at a time. A rejected request must not
  // poison the queue, and different editor sessions remain independent.
  const previous = sessions.get(id) ?? Promise.resolve();
  const pending = previous.catch(()=>{}).then(()=>{
    if(Date.now()>=deadline)throw new Error('Editor request expired in queue; no command was sent.');
    return sendEditor(id,command,deadline);
  });
  sessions.set(id,pending);
  try { return await pending; }
  finally { if(sessions.get(id)===pending)sessions.delete(id); }
}
async function sendEditor(id,command,deadline) {
  const s=await readSession(id);
  const timeout=deadline-Date.now();
  if(timeout<=0)throw new Error('Editor request expired before connection; no command was sent.');
  return new Promise((resolve,reject)=>{
    let socket, retry, data='', done=false, sent=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(retry);socket?.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Editor request timed out. Re-inspect state before retrying a write.')),timeout);
    const connect=()=>{
      if(done)return;
      socket=net.connect(`\\\\.\\pipe\\${s.pipeName}`);
      socket.setEncoding('utf8');
      socket.on('error',error=>{
        // Pipe recreation and startup have a brief gap. Only retry BEFORE a
        // command was submitted: a disconnected write may already be applied.
        if(!sent && ['ENOENT','EBUSY','ECONNREFUSED'].includes(error.code)) {
          socket.destroy(); retry=setTimeout(connect,25);
        } else finish(error);
      });
      socket.on('connect',()=>{
        if(done){socket.destroy();return;}
        if(Date.now()>=deadline){finish(new Error('Editor request expired before submission; no command was sent.'));return;}
        sent=true;
        socket.write(JSON.stringify({token:s.token,deadline,command})+'\n');
      });
      socket.on('data',chunk=>{
        data+=chunk;
        if(Buffer.byteLength(data,'utf8')>64*1024*1024){finish(new Error('Editor response exceeds limit.'));return;}
        if(data.includes('\n'))try {
          const response=JSON.parse(data.slice(0,data.indexOf('\n')));
          if(response?.ok===true)finish(null,response.result);
          else if(response?.ok===false)finish(new Error(String(response.error??'Editor request failed.')));
          else finish(new Error('Invalid editor response.'));
        } catch(error){finish(error);}
      });
      socket.on('end',()=>{if(!done)finish(new Error('Editor disconnected before acknowledging the request. Re-inspect state before retrying a write.'));});
      socket.on('close',()=>{if(sent&&!done)finish(new Error('Editor connection closed before acknowledgement. Re-inspect state before retrying a write.'));});
    };
    connect();
  });
}
export async function listSessions() {
  const files=await fs.readdir(sessionDirectory()).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const sessions=[];
  for(const file of files.filter(f=>/^[a-f0-9]{32}\.json$/.test(f))) {
    const id=file.slice(0,-5);
    try {const state=await requestEditor(id,{action:'get_editor_state'},2000);sessions.push({sessionId:id,...state});}catch{/* Closed or loading editor: never guess a substitute. */}
  }
  return sessions;
}
