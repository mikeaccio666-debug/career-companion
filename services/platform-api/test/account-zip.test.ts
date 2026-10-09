import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {readZip} from './fixtures/account-zip.ts';
import {packageAccountCapture} from '../src/account-zip.ts';
type Capture=Parameters<typeof packageAccountCapture>[0];
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-account-zip-'));
 await fs.chmod(directory,0o700);await fs.mkdir(path.join(directory,'uploads'),{mode:0o700});await fs.mkdir(path.join(directory,'birth'),{mode:0o700});
 const id=randomUUID(),asset=randomUUID(),values=new Map([
  ['uploads/'+id,Buffer.from('Fictional IBM 项目 evidence.')],
  ['birth/'+asset+'.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['birth/'+asset+'.png',Buffer.alloc(0)],
 ]);
 const privateFiles=[...values].map(([name,bytes])=>({path:name,source:name.startsWith('uploads/')?'upload':'companion_birth_'+name.split('.').at(-1),sourceId:name.startsWith('uploads/')?id:asset,size:bytes.length,sha256:sha(bytes)}));
 const snapshot={ownerId:randomUUID(),capturedAt:'2026-10-09T12:00:00.000Z',filesIncluded:true,complete:false,includedTables:['fictional'],remainingTables:['unresolved'],sections:{privateFiles,uploads:[{filename:'../虚构 项目.txt'}]}};
 for(const [name,bytes] of values)await fs.writeFile(path.join(directory,name),bytes,{mode:0o600});
 await fs.writeFile(path.join(directory,'account.json'),JSON.stringify(snapshot),{mode:0o600});
 const capture={directory,snapshot,dispose:()=>fs.rm(directory,{recursive:true,force:true})} as unknown as Capture;
 return {capture,values,privateFiles,snapshot,id};
}
test('independent ZIP reader recovers exact JSON and manifest files; extra files and original names are not paths',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.capture.directory,'never-include.env'),'fictional-secret',{mode:0o600});
  const result=await packageAccountCapture(f.capture),files=await readZip(result.filePath);
  assert.deepEqual([...files.keys()],['account.json',...f.values.keys()]);
  assert.deepEqual(JSON.parse(files.get('account.json')!.toString()),f.snapshot);
  for(const [name,bytes] of f.values)assert.deepEqual(files.get(name),bytes);
  assert.equal(result.byteSize,(await fs.stat(result.filePath)).size);
  assert.equal(result.sha256,sha(await fs.readFile(result.filePath)));
  assert.equal((await fs.stat(result.filePath)).mode&0o777,0o600);
  assert.equal(f.snapshot.complete,false);assert.deepEqual(f.snapshot.remainingTables,['unresolved']);
  assert(!(await fs.readFile(result.filePath)).includes(Buffer.from('fictional-secret')));
 }finally{await f.capture.dispose();}
});
test('same-size file corruption, missing files, JSON tampering and changed lengths fail without leaving a ZIP',async()=>{
 for(const change of ['digest','missing','json','length']){
  const f=await fixture();try{
   const file=path.join(f.capture.directory,'uploads/'+f.id);
   if(change==='missing')await fs.rm(file);
   else if(change==='json')await fs.writeFile(path.join(f.capture.directory,'account.json'),JSON.stringify({...f.snapshot,complete:true}));
   else await fs.writeFile(file,Buffer.alloc(change==='length'?1:f.values.get('uploads/'+f.id)!.length,65));
   await assert.rejects(packageAccountCapture(f.capture),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
   await assert.rejects(fs.stat(path.join(f.capture.directory,'account.zip')),{code:'ENOENT'});
  }finally{await f.capture.dispose();}
 }
});
test('untrusted manifest paths, source mismatches, duplicates and limits cannot escape the capture',async()=>{
 for(const change of ['traversal','absolute','source','duplicate','size','negative','count']){
  const f=await fixture();try{
   const row=f.privateFiles[0];
   if(change==='traversal')row.path='../outside';
   if(change==='absolute')row.path='/tmp/outside';
   if(change==='source')row.sourceId=randomUUID();
   if(change==='duplicate')f.privateFiles.push({...row});
   if(change==='size')row.size=256*1024*1024+1;
   if(change==='negative')row.size=-1;
   if(change==='count')while(f.privateFiles.length<=10000)f.privateFiles.push({...row});
   await assert.rejects(packageAccountCapture(f.capture),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
   await assert.rejects(fs.stat(path.join(f.capture.directory,'account.zip')),{code:'ENOENT'});
  }finally{await f.capture.dispose();}
 }
});
test('symbolic links, hard links, shared files and linked directories are rejected',async()=>{
 for(const change of ['symlink','hardlink','shared','directory']){
  const f=await fixture();try{
   const file=path.join(f.capture.directory,'uploads/'+f.id),other=path.join(f.capture.directory,'other');
   if(change==='directory'){
    await fs.rename(path.join(f.capture.directory,'uploads'),other);await fs.symlink(other,path.join(f.capture.directory,'uploads'));
   }else if(change==='shared')await fs.chmod(file,0o644);
   else{
    await fs.rename(file,other);
    if(change==='symlink')await fs.symlink(other,file);else await fs.link(other,file);
   }
   await assert.rejects(packageAccountCapture(f.capture),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
   await assert.rejects(fs.stat(path.join(f.capture.directory,'account.zip')),{code:'ENOENT'});
  }finally{await f.capture.dispose();}
 }
});
test('pre-cancel and cancellation while opening an input close the handle and remove partial ZIP',async context=>{
 const f=await fixture();try{
  const cancelled=AbortSignal.abort();
  await assert.rejects(packageAccountCapture(f.capture,cancelled),{code:'ACCOUNT_EXPORT_CANCELLED'});
  const controller=new AbortController(),original=fs.open;let input:Awaited<ReturnType<typeof fs.open>>|undefined;
  context.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
   const handle=await original(...args);
   if(args[0]===path.join(f.capture.directory,'uploads/'+f.id)){input=handle;controller.abort();}
   return handle;
  });
  await assert.rejects(packageAccountCapture(f.capture,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});
  assert(input);assert.equal(input.fd,-1);
  await assert.rejects(fs.stat(path.join(f.capture.directory,'account.zip')),{code:'ENOENT'});
 }finally{await f.capture.dispose();}
});
test('exclusive creation never overwrites or removes a pre-existing ZIP',async()=>{
 const f=await fixture();try{
  const file=path.join(f.capture.directory,'account.zip'),prior=Buffer.from('Fictional prior output');
  await fs.writeFile(file,prior,{mode:0o600});
  await assert.rejects(packageAccountCapture(f.capture),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
  assert.deepEqual(await fs.readFile(file),prior);
 }finally{await f.capture.dispose();}
});

test('cancellation during a multi-chunk read closes the active input and removes streamed output',async context=>{
 const f=await fixture();try{
  const file=path.join(f.capture.directory,'uploads/'+f.id),bytes=Buffer.alloc(4*1024*1024,65);
  await fs.writeFile(file,bytes);f.privateFiles[0].size=bytes.length;f.privateFiles[0].sha256=sha(bytes);
  await fs.writeFile(path.join(f.capture.directory,'account.json'),JSON.stringify(f.snapshot));
  const controller=new AbortController(),original=fs.open;let input:Awaited<ReturnType<typeof fs.open>>|undefined,read=false;
  context.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
   const handle=await original(...args);
   if(args[0]===file){
    input=handle;const create=handle.createReadStream.bind(handle);
    context.mock.method(handle,'createReadStream',(...options:Parameters<typeof handle.createReadStream>)=>{
     const stream=create(...options);stream.once('data',()=>{read=true;controller.abort();});return stream;
    });
   }
   return handle;
  });
  await assert.rejects(packageAccountCapture(f.capture,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});
  assert(read);assert(input);assert.equal(input.fd,-1);
  await assert.rejects(fs.stat(path.join(f.capture.directory,'account.zip')),{code:'ENOENT'});
 }finally{await f.capture.dispose();}
});
test('cleanup failure reports a retained partial archive instead of claiming success',async context=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.capture.directory,'uploads/'+f.id),'tampered');
  const original=fs.rm;
  const mock=context.mock.method(fs,'rm',async(...args:Parameters<typeof fs.rm>)=>{
   if(args[0]===path.join(f.capture.directory,'account.zip'))throw Error('Fictional cleanup failure');
   return original(...args);
  });
  await assert.rejects(packageAccountCapture(f.capture),{code:'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED'});
  assert((await fs.stat(path.join(f.capture.directory,'account.zip'))).isFile());
  mock.mock.restore();
 }finally{await f.capture.dispose();}
});
