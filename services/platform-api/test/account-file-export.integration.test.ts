import {HeadObjectCommand,GetObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountFileArchive} from '../src/account-file-archive.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {LocalBlobStorage,S3BlobStorage,type BlobStorage} from '../src/storage.ts';
import {UploadWrites} from '../src/upload-writes.ts';
import {UploadRemovals} from '../src/upload-removals.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>,directory:string,root:string,blobs:LocalBlobStorage,writes:UploadWrites,encoded:string;
const password='Fictional-private-file-export-password';
before(async()=>{f=await createPrebirthFixture();directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-account-files-'));root=path.join(directory,'archives');blobs=new LocalBlobStorage(path.join(directory,'blobs'));writes=new UploadWrites(f.db,f.crypto,blobs);encoded=await hashPassword(password);});
after(async()=>{await f?.close();await fs.rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function proof(who:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;}
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const archive=(storage:BlobStorage=blobs,db:Database=f.db,limits={})=>new AccountFileArchive(db,f.config,storage,root,limits);
const capture=async(who:FixedSessionContext)=>archive().capture(who,await proof(who));
const emptyRoot=async()=>assert.deepEqual(await fs.readdir(root),[]);
async function upload(who:FixedSessionContext,filename='Fictional.txt',bytes=Buffer.from('Fictional IBM course evidence.')){
 const saved=await writes.upload(who,{filename,mime:'text/plain',bytes});
 const row=(await f.db.query('SELECT storage_key FROM platform_uploads WHERE id=$1',[saved.id])).rows[0];return {...saved,bytes,key:row.storage_key as string};
}
async function artifact(who:FixedSessionContext,uploadId:string|null,metadata:unknown={},jobOwner=who){
 const jobId=randomUUID(),id=randomUUID();await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'image','fictional','Fictional material fixture','succeeded')",[jobId,jobOwner.userId]);
 await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id,metadata) VALUES($1,$2,$3,'file','text/plain','Fictional material.txt',$4,$5)",[id,who.userId,jobId,uploadId,JSON.stringify(metadata)]);return {id,jobId};
}
function instrument(transform:(sql:string,rows:Record<string,any>[],c:PoolClient)=>void|Promise<void>,timeoutMs?:number):Database{
 return {withBoundedTransaction:<T>(run:(c:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(c=>run(new Proxy(c,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }})),{...options,...(timeoutMs?{timeoutMs}:{})})} as Database;
}
function storageWith(changes:Partial<BlobStorage>):BlobStorage{return {scope:blobs.scope,put:blobs.put.bind(blobs),get:blobs.get.bind(blobs),delete:blobs.delete.bind(blobs),stat:blobs.stat.bind(blobs),openRead:blobs.openRead.bind(blobs),...changes};}

test('actual published uploads and generated material produce a private JSON plus exact files with safe names and no foreign bytes or storage coordinates',async context=>{
 const who=await actor(),other=await actor(),a=await upload(who,'../虚构 项目.txt'),b=await upload(who,'../虚构 项目.txt',Buffer.from('Another fictional version.')),foreign=await upload(other);
 const art=await artifact(who,a.id);context.mock.method(globalThis,'fetch',async()=>{throw Error('No external requests');});
 const result=await capture(who);
 try{
  const snapshot=result.snapshot,files=snapshot.sections.privateFiles as any[],uploads=snapshot.sections.uploads as any[];
  assert.equal(snapshot.complete,false);assert.equal(snapshot.filesIncluded,true);assert.equal(snapshot.includedTables.length,81);assert.equal(snapshot.remainingTables.length,78);
  assert.equal(files.length,2);assert.deepEqual(uploads.map(x=>x.id).sort(),[a.id,b.id].sort());
  for(const expected of [a,b]){const file=files.find(x=>x.sourceId===expected.id);assert.equal(file.path,'uploads/'+expected.id);assert.deepEqual(await fs.readFile(path.join(result.directory,file.path)),expected.bytes);assert.equal(file.sha256,createHash('sha256').update(expected.bytes).digest('hex'));assert.equal(file.size,expected.bytes.length);assert.equal((await fs.stat(path.join(result.directory,file.path))).mode&0o777,0o600);}
  assert.equal((await fs.stat(result.directory)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(result.directory,'account.json'))).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.directory,'account.json'),'utf8')),snapshot);
  const material=snapshot.sections.artifacts[0] as any;assert.equal(material.id,art.id);assert.equal(material.file.path,'uploads/'+a.id);assert.equal(material.jobId,art.jobId);
  assert.equal(uploads[0].filename,'../虚构 项目.txt');assert(Object.isFrozen(snapshot.sections.privateFiles[0]));
  for(const secret of [foreign.id,foreign.key,other.userId,a.key,b.key,who.tokenHash,password,encoded,directory,'storage_key'])assert(!JSON.stringify(snapshot).includes(secret));
 }finally{await result.dispose();await result.dispose();}
 await emptyRoot();await blobs.stat(a.key);assert.equal((await f.db.query('SELECT 1 FROM platform_uploads WHERE id=$1',[a.id])).rowCount,1);
});

test('actual birth SVG and PNG are copied from authenticated saved bytes, not rerendered; plain capture stays metadata-only',async()=>{
 const who=await actor();let assetId='';
 await withPrebirthLoopback(async(runtime,calls)=>{const ready=await readyBirth(f,runtime,{who}),born=await ready.service.birth(who,ready.body,ready.key);assetId=born.receipt.identity.sealAssetId;assert.equal(calls.length,2);});
 const original=await f.db.transaction(c=>new CompanionBirthOriginStore(f.crypto).readSealAsset(c,who.userId,assetId));assert(original);
 const normal=await new AccountCoreExport(f.db,f.config).capture(who,await proof(who));assert.equal(normal.filesIncluded,false);assert(normal.remainingTables.includes('platform_companion_birth_assets'));
 const result=await capture(who);try{
  const meta=result.snapshot.sections.companionBirthAssetMetadata[0] as any;assert.equal(meta.bytesIncluded,true);assert.equal(result.snapshot.sections.privateFiles.length,2);
  for(const format of ['svg','png'] as const){const file=(result.snapshot.sections.privateFiles as any[]).find(x=>x.source==='companion_birth_'+format);assert.equal(file.sourceId,assetId);assert.deepEqual(await fs.readFile(path.join(result.directory,file.path)),original[format]);}
 }finally{await result.dispose();}await emptyRoot();
});

test('workflow, browser and MCP saved provenance is retained; revoked uploads are not resurrected from deletion journals',async()=>{
 const who=await actor(),u=await upload(who),mcp={connectionId:randomUUID(),connectionName:'Fictional jobs',catalogId:'fictional',grantVersion:2,toolName:'lookup',schemaHash:'a'.repeat(64)};
 const variants=[{}, {workflowStep:2,definitionHash:'b'.repeat(64),partialCompleted:true}, {browserGeneration:2,definitionHash:'c'.repeat(64),browserObservation:true,browserAction:3,partialCompleted:true}, {mcpGeneration:2,mcpDefinitionHash:'d'.repeat(64),mcp}];
 const ids=[];for(const variant of variants)ids.push((await artifact(who,u.id,variant)).id);
 await new UploadRemovals(f.db,f.crypto,blobs).request(who,u.id,{operationId:randomUUID()});await blobs.stat(u.key);
 const result=await capture(who);try{
  assert.deepEqual(result.snapshot.sections.uploads,[]);assert.deepEqual(result.snapshot.sections.privateFiles,[]);
  const materials=result.snapshot.sections.artifacts as any[];for(const [i,artifactId] of ids.entries()){const r=materials.find(x=>x.id===artifactId);assert.deepEqual(r.metadata,variants[i]);assert.equal(r.uploadId,null);assert.deepEqual(r.file,{status:'not_attached'});}
 }finally{await result.dispose();}await emptyRoot();await blobs.stat(u.key);
});

test('actual cross-owner artifact upload and job links fail the whole archive and preserve the password proof',async()=>{
 const who=await actor(),other=await actor(),own=await upload(who),foreign=await upload(other),a=await artifact(who,foreign.id),token=await proof(who);
 await assert.rejects(archive().capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});await emptyRoot();assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_artifacts SET upload_id=$2 WHERE id=$1',[a.id,own.id]);await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[a.jobId,other.userId]);
 await assert.rejects(archive().capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});await emptyRoot();assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[a.jobId,who.userId]);const result=await archive().capture(who,token);await result.dispose();await emptyRoot();
});

test('unknown artifact metadata and unsupported external URLs block capture without fetching or silently dropping fields',async context=>{
 const who=await actor(),u=await upload(who),a=await artifact(who,u.id,{privateToken:'Fictional secret field'}),token=await proof(who);let fetched=0;
 context.mock.method(globalThis,'fetch',async()=>{fetched++;throw Error('No external fetch');});
 await assert.rejects(archive().capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});await emptyRoot();assert.equal(await consumed(who),null);
 await f.db.query("UPDATE platform_artifacts SET metadata='{}',external_url='https://example.invalid/file?token=fictional' WHERE id=$1",[a.id]);
 await assert.rejects(archive().capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});await emptyRoot();assert.equal(fetched,0);assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_artifacts SET external_url=NULL WHERE id=$1',[a.id]);const result=await archive().capture(who,token);await result.dispose();
});

test('missing bytes, changed sizes, weak versions and truncated or overflowing streams reject all files with clean retries',async()=>{
 const who=await actor(),u=await upload(who),token=await proof(who),cases:Partial<BlobStorage>[]=[
  {stat:async()=>({size:u.bytes.length+1,etag:'"fictional"'})}, {stat:async()=>({size:u.bytes.length,etag:'W/"fictional"'})},
  {openRead:async()=>({length:u.bytes.length,stream:Readable.from([u.bytes.subarray(1)])})},
  {openRead:async()=>({length:u.bytes.length,stream:Readable.from([Buffer.concat([u.bytes,Buffer.from('x')])])})},
  {openRead:async()=>({length:u.bytes.length+1,stream:Readable.from([u.bytes])})},
 ];
 for(const change of cases){await assert.rejects(archive(storageWith(change)).capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);await emptyRoot();}
 await fs.rename(path.join(directory,'blobs',u.key),path.join(directory,'saved-file'));
 try{await assert.rejects(archive().capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);await emptyRoot();}
 finally{await fs.rename(path.join(directory,'saved-file'),path.join(directory,'blobs',u.key));}
 const result=await archive().capture(who,token);await result.dispose();await emptyRoot();
});

test('changing the same-length local file after its copy is detected by the final version check',async()=>{
 const who=await actor(),u=await upload(who),token=await proof(who);let changed=false;
 const db=instrument(async(sql)=>{if(!changed&&sql.startsWith('SELECT id,user_id,job_id,kind,mime,filename')){changed=true;await fs.writeFile(path.join(directory,'blobs',u.key),Buffer.alloc(u.bytes.length,65));}});
 await assert.rejects(archive(blobs,db).capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});assert(changed);assert.equal(await consumed(who),null);await emptyRoot();
 await fs.writeFile(path.join(directory,'blobs',u.key),u.bytes);const result=await archive().capture(who,token);await result.dispose();
});

test('cancellation destroys an open source stream, removes staged bytes and rolls back password consumption',async()=>{
 const who=await actor(),u=await upload(who),token=await proof(who),abort=new AbortController();let source:Readable|undefined;
 const storage=storageWith({openRead:async()=>{source=new Readable({read(){this.push(u.bytes);this.push(null);}});queueMicrotask(()=>abort.abort());return {length:u.bytes.length,stream:source};}});
 await assert.rejects(archive(storage).capture(who,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert(source?.destroyed);assert.equal(await consumed(who),null);await emptyRoot();
 const result=await archive().capture(who,token);await result.dispose();
});

test('database deadline aborts pending file I/O and waits for it before removing the staging directory',async()=>{
 const who=await actor();await upload(who);const token=await proof(who);let entered=false,stopped=false;
 const storage=storageWith({stat:async(_key,signal)=>{entered=true;return new Promise((_,reject)=>{const stop=()=>{stopped=true;reject(Error('Fictional aborted storage'));};if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});});}});
 await assert.rejects(archive(storage,instrument(()=>{},500)).capture(who,token));assert(entered);assert(stopped);assert.equal(await consumed(who),null);await emptyRoot();
 const result=await archive().capture(who,token);await result.dispose();
});

test('file count, byte budget and JSON budget failures leave no staged archive and no consumed proof',async()=>{
 const who=await actor(),u=await upload(who);await upload(who);const token=await proof(who);
 for(const limits of [{maxFileBytes:u.bytes.length-1},{maxFiles:1},{maxJsonBytes:1024}]){
  await assert.rejects(archive(blobs,f.db,limits).capture(who,token));assert.equal(await consumed(who),null);await emptyRoot();
 }
 const result=await archive().capture(who,token);await result.dispose();
});

test('105 actual published files cross inventory pages; empty files and duplicate original names are preserved once each',async()=>{
 const who=await actor(),ids:string[]=[];for(let i=0;i<105;i++){const u=await upload(who,'duplicate.txt',i?Buffer.from('Fictional '+i):Buffer.alloc(0));ids.push(u.id);await artifact(who,u.id);}
 let pages=0,artifactPages=0;const result=await archive(blobs,instrument(sql=>{if(sql.startsWith('SELECT id,user_id,filename,mime,byte_size'))pages++;if(sql.startsWith('SELECT id,user_id,job_id,kind,mime,filename'))artifactPages++;})).capture(who,await proof(who));
 try{assert.equal(pages,2);assert.equal(artifactPages,2);assert.equal(result.snapshot.sections.artifacts.length,105);assert.deepEqual((result.snapshot.sections.uploads as any[]).map(x=>x.id),ids.sort());assert.equal(result.snapshot.sections.privateFiles.length,105);assert.equal((await fs.readdir(path.join(result.directory,'uploads'))).length,105);}
 finally{await result.dispose();}await emptyRoot();
});

test('authentication failure and expiry after real file copying prevent a delivered bundle and roll back its proof',async()=>{
 const who=await actor();await upload(who);const token=await proof(who);let copies=false;
 const db=instrument(async(sql,_rows,c)=>{if(sql.startsWith('SELECT id,user_id,job_id,kind,mime,filename')){copies=true;await c.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[who.tokenHash]);}});
 await assert.rejects(archive(blobs,db).capture(who,token));assert(copies);assert.equal(await consumed(who),null);await emptyRoot();
 await assert.rejects(archive().capture({...who,tokenHash:'0'.repeat(64)},token),{code:'AUTH_REQUIRED'});await emptyRoot();
 const result=await archive().capture(who,token);await result.dispose();
});

test('caller identity is captured before asynchronous staging and unsafe workspace paths are rejected',async()=>{
 const who=await actor(),other=await actor(),u=await upload(who),token=await proof(who),mutable={...who};
 const pending=archive().capture(mutable,token);mutable.userId=other.userId;mutable.tokenHash=other.tokenHash;const result=await pending;
 try{assert.equal(result.snapshot.ownerId,who.userId);assert.equal((result.snapshot.sections.uploads[0] as any).id,u.id);}finally{await result.dispose();}
 const shared=path.join(directory,'shared');await fs.mkdir(shared,{mode:0o755});await fs.chmod(shared,0o755);
 await assert.rejects(new AccountFileArchive(f.db,f.config,blobs,shared).capture(who,await proof(who)),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});assert.deepEqual(await fs.readdir(shared),[]);
 const link=path.join(directory,'archive-link');await fs.symlink(root,link);
 await assert.rejects(new AccountFileArchive(f.db,f.config,blobs,link).capture(who,await proof(who)),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});await emptyRoot();
});

test('transaction failure after JSON materialization removes the complete staged bundle and rolls back reauthentication',async()=>{
 const who=await actor();await upload(who);const token=await proof(who);let materialized=false;
 const db={withBoundedTransaction:<T>(run:(c:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number}):Promise<T>=>f.db.withBoundedTransaction(async c=>{
  await run(c);const names=await fs.readdir(root);assert.equal(names.length,1);const snapshot=JSON.parse(await fs.readFile(path.join(root,names[0],'account.json'),'utf8'));
  assert.equal(snapshot.ownerId,who.userId);assert.equal(snapshot.filesIncluded,true);materialized=true;throw Error('Fictional failure before commit');
 },options)} as Database;
 await assert.rejects(archive(blobs,db).capture(who,token));assert(materialized);assert.equal(await consumed(who),null);await emptyRoot();
 const result=await archive().capture(who,token);await result.dispose();
});

test('actual S3 adapter uses conditional private object reads; changed ETag rejects the bundle without disclosing bucket or credentials',async()=>{
 const who=await actor(),u=await upload(who),token=await proof(who),version='fictional-object-version-'+randomUUID(),etag=JSON.stringify(version);let changed=true,gets=0,heads=0;
 const client={send:async(command:any,options:{abortSignal?:AbortSignal})=>{
  assert(options.abortSignal);assert.equal(command.input.Key,u.key);assert.equal(command.input.Bucket,'fictional-private-bucket');
  if(command instanceof HeadObjectCommand){heads++;return {ContentLength:u.bytes.length,ETag:etag};}
  assert(command instanceof GetObjectCommand);gets++;assert.equal(command.input.IfMatch,etag);assert.equal(command.input.Range,undefined);
  return {ContentLength:u.bytes.length,ETag:changed?'"fictional-changed-object"':etag,Body:Readable.from([u.bytes]),$metadata:{httpStatusCode:200}};
 }} as unknown as Pick<S3Client,'send'>;
 const storage=new S3BlobStorage({bucket:'fictional-private-bucket',region:'us-east-1',accessKeyId:'fictional-access',secretAccessKey:'fictional-secret'},client);
 await assert.rejects(archive(storage).capture(who,token),{code:'ACCOUNT_FILE_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);await emptyRoot();changed=false;
 const result=await archive(storage).capture(who,token);try{
  assert.equal(gets,2);assert.equal(heads,3);const file=result.snapshot.sections.privateFiles[0] as any;assert.deepEqual(await fs.readFile(path.join(result.directory,file.path)),u.bytes);
  for(const secret of [u.key,'fictional-private-bucket',version,'fictional-access','fictional-secret'])assert(!JSON.stringify(result.snapshot).includes(secret));
 }finally{await result.dispose();}await emptyRoot();
});
