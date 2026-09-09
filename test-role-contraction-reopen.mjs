import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const priorPath=path.resolve(process.argv[2]),prior=JSON.parse(await fs.readFile(priorPath,'utf8'));
assert.equal(prior.passed,true);assert.deepEqual(prior.cases.map(c=>c.size),['small','standard','large','massive']);
assert.equal(await hash(prior.executable),prior.executableSha256);
assert.equal(await hash(prior.harness),prior.harnessSha256);
const out=await fs.mkdtemp('outputs/role-contraction-reopen-');
const harnessCopy=path.resolve(out,'test-role-contraction-reopen.mjs');await fs.copyFile(fileURLToPath(import.meta.url),harnessCopy);
const harness=path.resolve('tools/mcp/MapEditerMCP/test-role-contraction.mjs');
const report={passed:false,harness:harnessCopy,harnessSha256:await hash(harnessCopy),priorReport:priorPath,priorReportSha256:await hash(priorPath),executable:prior.executable,executableSha256:prior.executableSha256,cases:[]};
const save=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
console.log(path.join(out,'report.json'));await save();
try{
 for(const c of prior.cases){
  assert.equal(await hash(c.appliedProject),c.appliedProjectSha256);
  const stdout=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--experimental-strip-types',harness,prior.executable,c.appliedProject],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='';
   child.stdout.on('data',d=>{output+=d;});child.stderr.on('data',d=>{errors+=d;});child.on('error',reject);
   child.on('close',code=>{if(code!==0)reject(new Error(`${c.size} reopen failed: ${output}\n${errors}`));else resolve(output);});
  });
  const childPath=JSON.parse(stdout).report,child=JSON.parse(await fs.readFile(childPath,'utf8'));
  assert.equal(child.passed,true);assert.equal(child.reopen.exactProject,true);assert.equal(child.reopen.invalidServiceRemovalRejected,true);
  assert.equal(child.reopenSource.path,c.appliedProject);assert.equal(child.reopenSource.sha256,c.appliedProjectSha256);
  assert.equal(await hash(child.harness),child.harnessSha256);
  assert.equal(child.executableSha256,prior.executableSha256);
  report.cases.push({size:c.size,report:childPath,reportSha256:await hash(childPath),sourceSha256:c.appliedProjectSha256,checks:child.reopen});await save();
 }
 assert.equal(await hash(priorPath),report.priorReportSha256);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{await save();console.log(JSON.stringify({passed:report.passed,report:path.join(out,'report.json'),error:report.error}));}
