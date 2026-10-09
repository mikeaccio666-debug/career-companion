import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {AccountArchiveDelivery} from '../src/account-archive-delivery.ts';
import {AccountFileArchive} from '../src/account-file-archive.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {LocalBlobStorage} from '../src/storage.ts';
import {UploadWrites} from '../src/upload-writes.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {readZip} from './fixtures/account-zip.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,root:string,storage:LocalBlobStorage,archives:AccountFileArchive,delivery:AccountArchiveDelivery,encoded:string;
const password='Fictional-archive-delivery-password';
before(async()=>{
 f=await createCompanionNameSafetyFixture();directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-archive-delivery-'));
 root=path.join(directory,'archives');storage=new LocalBlobStorage(path.join(directory,'blobs'));
 archives=new AccountFileArchive(f.db,f.config,storage,root);delivery=new AccountArchiveDelivery(f.db,archives);encoded=await hashPassword(password);
});
after(async()=>{await f?.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function proof(who:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;}
async function prepare(who:FixedSessionContext,signal?:AbortSignal){return delivery.prepare(who,await proof(who),signal);}
async function upload(who:FixedSessionContext,bytes=Buffer.from('Fictional IBM course evidence.')){
 return new UploadWrites(f.db,f.crypto,storage).upload(who,{filename:'虚构 项目.txt',mime:'text/plain',bytes});
}
const empty=async()=>assert.deepEqual(await fs.readdir(root),[]);
async function zipPath(){const directories=await fs.readdir(root);assert.equal(directories.length,1);return path.join(root,directories[0],'account.zip');}
async function collect(result:Awaited<ReturnType<typeof prepare>>){const chunks:Buffer[]=[];for await(const chunk of result.stream)chunks.push(chunk);await result.closed;return Buffer.concat(chunks);}

test('real authenticated ZIP streams through bounded buffers, decodes independently and cleans itself after EOF',async()=>{
 const who=await actor(),other=await actor(),bytes=Buffer.alloc(1024*1024,65),own=await upload(who,bytes),foreign=await upload(other);
 const result=await prepare(who);try{
  assert.equal(result.metadata.ownerId,who.userId);assert.equal(result.metadata.complete,false);
  assert.equal(result.metadata.remainingTables.length,20);assert.equal(result.metadata.mime,'application/zip');
  assert.equal(result.stream.readableHighWaterMark,64*1024);
  for(const secret of [directory,who.tokenHash,password,encoded,foreign.id,other.userId])assert(!JSON.stringify(result.metadata).includes(secret));
  const received=await collect(result);assert.equal(received.length,result.metadata.byteSize);
  assert.equal(createHash('sha256').update(received).digest('hex'),result.metadata.sha256);
  await empty();const file=path.join(directory,'downloaded.zip');await fs.writeFile(file,received,{mode:0o600});
  try{
   const content=await readZip(file);assert.equal(content.size,2);assert.deepEqual(content.get('uploads/'+own.id),bytes);
   assert.equal(JSON.parse(content.get('account.json')!.toString()).ownerId,who.userId);
  }finally{await fs.rm(file);}
 }finally{await result.dispose();}
 await empty();
});
test('logout, expiry, password-version change and student-to-staff change after packaging release no bytes',async()=>{
 for(const change of ['logout','expired','password','staff']){
  const who=await actor();await upload(who);const result=await prepare(who);let observed=0;
  if(change==='logout')await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[who.tokenHash]);
  if(change==='expired')await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[who.tokenHash]);
  if(change==='password')await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);
  if(change==='staff')await f.db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1",[who.userId]);
  try{
   await assert.rejects(async()=>{for await(const chunk of result.stream)observed+=chunk.length;},{code:change==='staff'?'STUDENT_ACCOUNT_REQUIRED':'AUTH_REQUIRED'});
   await result.closed;assert.equal(observed,0);await empty();
  }finally{await result.dispose();}
 }
});
test('a changed or linked ZIP is rejected before any bytes reach the consumer',async()=>{
 for(const change of ['contents','symlink','permissions','truncated']){
  const who=await actor();await upload(who);const result=await prepare(who);let observed=0;
  try{
   const file=await zipPath();
   if(change==='contents'){
    const handle=await fs.open(file,'r+');try{await handle.write(Buffer.from('X'),0,1,0);}finally{await handle.close();}
   }else if(change==='symlink'){
    const moved=file+'.saved';await fs.rename(file,moved);await fs.symlink(moved,file);
   }else if(change==='permissions')await fs.chmod(file,0o644);
   else await fs.truncate(file,1);
   await assert.rejects(async()=>{for await(const chunk of result.stream)observed+=chunk.length;},{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
   await result.closed;assert.equal(observed,0);await empty();
  }finally{await result.dispose();}
 }
});
test('reauthorization after full checksum verification catches a session revoked during disk reading',async context=>{
 const who=await actor();await upload(who);const result=await prepare(who),original=fs.open;let revoked=false,observed=0;
 context.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await original(...args);
  if(String(args[0]).endsWith('/account.zip')){
   const read=handle.read.bind(handle);
   context.mock.method(handle,'read',async(...values:any[])=>{
    const readResult=await (read as any)(...values);
    if(!revoked){revoked=true;await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[who.tokenHash]);}
    return readResult;
   });
  }
  return handle;
 });
 try{
  await assert.rejects(async()=>{for await(const chunk of result.stream)observed+=chunk.length;},{code:'AUTH_REQUIRED'});
  await result.closed;assert(revoked);assert.equal(observed,0);await empty();
 }finally{await result.dispose();}
});
test('request abort and disposing an unread result clean the ZIP without starting delivery',async()=>{
 const who=await actor();await upload(who);
 const controller=new AbortController(),result=await prepare(who,controller.signal);controller.abort();
 await result.closed;await empty();assert.equal(result.stream.destroyed,true);await result.dispose();
 const unread=await prepare(who);await unread.dispose();await unread.dispose();await empty();
});
test('consumer disconnect after a first chunk cleans the active descriptor and all staging files',async context=>{
 const who=await actor();await upload(who,Buffer.alloc(2*1024*1024,65));const result=await prepare(who),original=fs.open;
 let input:Awaited<ReturnType<typeof fs.open>>|undefined;
 context.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await original(...args);if(String(args[0]).endsWith('/account.zip'))input=handle;return handle;});
 for await(const chunk of result.stream){assert(chunk.length>0);break;}
 await result.closed;assert(input);assert.equal(input.fd,-1);assert(result.stream.destroyed);await empty();await result.dispose();
});
test('cleanup failure is observable even when the stream was never consumed',async context=>{
 const who=await actor(),result=await prepare(who),original=fs.rm;
 const mock=context.mock.method(fs,'rm',async(...args:Parameters<typeof fs.rm>)=>{
  if(String(args[0]).startsWith(root+'/account-archive-'))throw Error('Fictional private cleanup error');
  return original(...args);
 });
 try{
  await assert.rejects(result.dispose(),{code:'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED'});
  await assert.rejects(result.closed,{code:'ACCOUNT_ARCHIVE_CLEANUP_REQUIRED'});
  assert.equal((await fs.readdir(root)).length,1);
 }finally{mock.mock.restore();for(const name of await fs.readdir(root))await fs.rm(path.join(root,name),{recursive:true,force:true});}
});
test('request identity is fixed before capture and unverified email does not block privacy access',async()=>{
 const who=await actor(),other=await actor();await upload(who);
 await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const token=await proof(who),mutable={...who},pending=delivery.prepare(mutable,token);
 mutable.userId=other.userId;mutable.tokenHash=other.tokenHash;
 const result=await pending;try{assert.equal(result.metadata.ownerId,who.userId);await collect(result);await empty();}finally{await result.dispose();}
});

test('a ZIP changed after delivery begins never releases the final chunk as a complete download',async()=>{
 const who=await actor();await upload(who,Buffer.alloc(2*1024*1024,65));const result=await prepare(who);
 try{
  const iterator=result.stream[Symbol.asyncIterator](),first=await iterator.next();assert.equal(first.done,false);
  let observed=(first.value as Buffer).length;
  const file=await zipPath(),handle=await fs.open(file,'r+');
  try{await handle.write(Buffer.from('changed'),0,7,result.metadata.byteSize-7);}finally{await handle.close();}
  await assert.rejects(async()=>{for(;;){const next=await iterator.next();if(next.done)break;observed+=(next.value as Buffer).length;}},{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});
  assert(observed>0);assert(observed<result.metadata.byteSize);await result.closed;await empty();
 }finally{await result.dispose();}
});
