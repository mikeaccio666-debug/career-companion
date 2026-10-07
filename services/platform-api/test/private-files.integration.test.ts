import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ClientRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { LocalBlobStorage, type BlobReadOptions, type BlobReadResult, type BlobStat } from '../src/storage.ts';

const prefix='/api/platform',origin='http://localhost:4321',schema=`private_files_${randomUUID().replaceAll('-','')}`,base=readConfig({...process.env,PLATFORM_REQUIRE_INVITE:'1'}),admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
const db=new Database(url.toString());let directory:string,system:Awaited<ReturnType<typeof buildApp>>,port:number,alice:Actor,bob:Actor,video:Saved,audio:Saved,large:Saved;
type Actor={id:string;cookie:string};type Saved={uploadId:string;artifactId:string;jobId:string;key:string;bytes:Buffer};
type Opened={stream:Readable;signal?:AbortSignal;closed:boolean};
class TrackingStorage extends LocalBlobStorage {
  getCalls=0;statCalls=0;openCalls=0;opened:Opened[]=[];
  beforeStat?: (key:string,signal?:AbortSignal)=>Promise<void>;
  beforeOpen?: (key:string,options:BlobReadOptions)=>Promise<BlobReadResult|undefined>;
  withoutTag=false;
  override async get(_key:string):Promise<never>{this.getCalls++;throw new Error('HTTP downloads must never buffer a complete private file.');}
  override async stat(key:string,signal?:AbortSignal):Promise<BlobStat>{this.statCalls++;await this.beforeStat?.(key,signal);const value=await super.stat(key,signal);return this.withoutTag?{size:value.size}:value;}
  override async openRead(key:string,options:BlobReadOptions):Promise<BlobReadResult>{
    this.openCalls++;const result=await this.beforeOpen?.(key,options)??await super.openRead(key,options);
    const tracked:Opened={stream:result.stream,signal:options.signal,closed:false};this.opened.push(tracked);result.stream.once('close',()=>{tracked.closed=true;});return result;
  }
}
let storage:TrackingStorage;
const forbidden=async()=>{throw new Error('Commercial calls are forbidden in private-file transport fixtures.');};
const runtime:PlatformProviderRuntime={capabilities:()=>[],streamChat:async function*(){throw new Error('Unused fixture runtime');},executeJob:forbidden,createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden};
const lifecycle:{request:IncomingMessage;response:http.ServerResponse}[]=[];
function exchange(route:string,actor?:Actor,options:{method?:string;headers?:Record<string,string>;body?:Buffer|string;slow?:boolean}={}):Promise<{status:number;headers:http.IncomingHttpHeaders;bytes:Buffer}>{
  return new Promise((resolve,reject)=>{
    const body=options.body;const req=http.request({host:'127.0.0.1',port,path:prefix+route,method:options.method??'GET',agent:false,headers:{...(actor?{cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id}:{}),...(body?{'content-length':Buffer.byteLength(body)}:{}),...options.headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>{chunks.push(chunk);if(options.slow){res.pause();setTimeout(()=>res.resume(),2);}});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.setTimeout(10_000,()=>req.destroy(new Error('Private HTTP fixture timed out.')));if(body)req.write(body);req.end();
  });
}
async function register(name:string):Promise<Actor>{const result=await exchange('/auth/register',undefined,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(await fictionalRegistration(db,{name,email:`${randomUUID()}@example.invalid`,password:'Fictional-password-123'}))});assert.equal(result.status,201,result.bytes.toString());return {id:JSON.parse(result.bytes.toString()).user.id,cookie:result.headers['set-cookie']![0]!.split(';')[0]!};}
async function saved(user:Actor,bytes:Buffer,mime='video/mp4',empty=false):Promise<Saved>{
  let uploadId:string,key:string;
  if(empty){uploadId=randomUUID();key=randomUUID();await storage.put(key,bytes);await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,\'fictional-empty.bin\',$3,$4,$5)',[uploadId,user.id,mime,bytes.length,key]);}
  else{
    const boundary=`fixture-${randomUUID()}`,filename=mime==='audio/wav'?'fictional-audio.wav':'fictional-video.mp4';
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded=await exchange('/uploads',user,{method:'POST',headers:{origin,'content-type':`multipart/form-data; boundary=${boundary}`},body});assert.equal(uploaded.status,201,uploaded.bytes.toString());uploadId=JSON.parse(uploaded.bytes.toString()).attachment.id;key=(await db.query('SELECT storage_key FROM platform_uploads WHERE id=$1',[uploadId])).rows[0].storage_key;
  }
  const artifactId=randomUUID(),jobId=randomUUID();await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'video','fictional-fixture','Fictional transport bytes; not generated by a model','succeeded')",[jobId,user.id]);
  await db.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,\'video\',$4,\'fictional-saved-media\',$5)',[artifactId,user.id,jobId,mime,uploadId]);return {uploadId,artifactId,jobId,key,bytes};
}
async function until(condition:()=>boolean){const end=Date.now()+3000;while(!condition()){if(Date.now()>end)assert.fail('Expected private stream cleanup did not finish.');await new Promise(resolve=>setTimeout(resolve,5));}}
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate(); await seedFictionalActiveLegal(db);directory=await fs.mkdtemp(path.join(os.tmpdir(),'private-file-http-'));storage=new TrackingStorage(directory);
  system=await buildApp({legalBundle:FICTIONAL_LEGAL,db,storage,config:{...base,databaseUrl:url.toString(),storageDir:directory},runtime,enableQueue:false});
  system.app.server.on('request',(request,response)=>{if(request.url?.startsWith(prefix+'/uploads/')||request.url?.startsWith(prefix+'/artifacts/'))lifecycle.push({request,response});});
  await system.app.listen({host:'127.0.0.1',port:0});port=(system.app.server.address() as import('node:net').AddressInfo).port;
  alice=await register('Fictional media owner');bob=await register('Fictional second account');
  const videoBytes=Buffer.alloc(1024);for(let i=0;i<videoBytes.length;i++)videoBytes[i]=i%251;videoBytes.write('ftyp',4);video=await saved(alice,videoBytes);
  const audioBytes=Buffer.alloc(128*1024,17);audioBytes.write('RIFF',0);audioBytes.write('WAVE',8);audio=await saved(alice,audioBytes,'audio/wav');
  const largeBytes=Buffer.alloc(8*1024*1024,29);largeBytes.write('ftyp',4);large=await saved(alice,largeBytes);
});
after(async()=>{await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});

test('real HTTP owned video/audio GET streams and HEAD metadata preserve private headers without buffered storage.get',async()=>{
  for(const [item,mime] of [[video,'video/mp4'],[audio,'audio/wav']] as const){
    for(const route of [`/uploads/${item.uploadId}`,`/artifacts/${item.artifactId}`]){
      const full=await exchange(route,alice);assert.equal(full.status,200);assert.deepEqual(full.bytes,item.bytes);assert.equal(full.headers['content-length'],String(item.bytes.length));assert.equal(full.headers['accept-ranges'],'bytes');assert.equal(full.headers['cache-control'],'private, no-store');assert.equal(full.headers['x-content-type-options'],'nosniff');assert.equal(full.headers['content-security-policy'],"default-src 'none'; sandbox");assert.equal(full.headers['content-type'],mime);assert.match(String(full.headers['content-disposition']),/^inline;/);assert.match(String(full.headers.etag),/^"local-[a-f0-9]+"$/);
      const opens=storage.openCalls,head=await exchange(route,alice,{method:'HEAD',headers:{range:'bytes=2-7'}});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],String(item.bytes.length));assert.equal(head.headers['content-range'],undefined);assert.equal(storage.openCalls,opens);
    }
  }assert.equal(storage.getCalls,0);
});

test('single closed, open and suffix byte ranges return exact 206 offsets including large decimal numerals',async()=>{
  const cases:[string,number,number][]=[['bytes=0-0',0,0],['bytes=10-19',10,19],['bytes=1000-',1000,1023],['bytes=-20',1004,1023],['BYTES= 9-12',9,12],['bytes=10-99999999999999999999999999999999999999',10,1023],['bytes=-99999999999999999999999999999999999999',0,1023]];
  for(const [range,start,end] of cases){const response=await exchange(`/artifacts/${video.artifactId}`,alice,{headers:{range}});assert.equal(response.status,206,range);assert.equal(response.headers['content-range'],`bytes ${start}-${end}/1024`);assert.equal(response.headers['content-length'],String(end-start+1));assert.deepEqual(response.bytes,video.bytes.subarray(start,end+1));}assert.equal(storage.getCalls,0);
});

test('invalid, multiple and unknown ranges are ignored while valid unsatisfiable single ranges get empty 416',async()=>{
  for(const range of ['bytes=20-10','bytes=word','bytes=-','bytes=1-2,5-6','items=1-2','bytes=1 -2']){const response=await exchange(`/uploads/${video.uploadId}`,alice,{headers:{range}});assert.equal(response.status,200,range);assert.equal(response.headers['content-range'],undefined);assert.deepEqual(response.bytes,video.bytes);}
  for(const range of ['bytes=1024-','bytes=9999999999999999999999999999999999-','bytes=-0']){const opens=storage.openCalls,response=await exchange(`/uploads/${video.uploadId}`,alice,{headers:{range}});assert.equal(response.status,416,range);assert.equal(response.headers['content-range'],'bytes */1024');assert.equal(response.headers['content-length'],'0');assert.equal(response.bytes.length,0);assert.equal(storage.openCalls,opens);}
  const empty=await saved(alice,Buffer.alloc(0),'application/octet-stream',true);
  for(const range of ['bytes=-2','bytes=0-0','bytes=0-']){const response=await exchange(`/uploads/${empty.uploadId}`,alice,{headers:{range}});assert.equal(response.status,416);assert.equal(response.headers['content-range'],'bytes */0');assert.equal(response.bytes.length,0);assert.equal(response.headers['content-length'],'0');}
  for(const method of ['GET','HEAD']){const response=await exchange(`/uploads/${empty.uploadId}`,alice,{method});assert.equal(response.status,200);assert.equal(response.bytes.length,0);assert.equal(response.headers['content-length'],'0');}
});

test('If-Range uses only an exact strong ETag and HEAD ignores Range and If-Range without opening a body',async()=>{
  const route=`/artifacts/${video.artifactId}`,etag=String((await exchange(route,alice,{method:'HEAD'})).headers.etag);
  const matched=await exchange(route,alice,{headers:{range:'bytes=3-7','if-range':etag}});assert.equal(matched.status,206);assert.deepEqual(matched.bytes,video.bytes.subarray(3,8));
  for(const tag of ['"different-version"',`W/${etag}`,'Mon, 01 Jan 2024 00:00:00 GMT']){const response=await exchange(route,alice,{headers:{range:'bytes=3-7','if-range':tag}});assert.equal(response.status,200);assert.deepEqual(response.bytes,video.bytes);}
  const opens=storage.openCalls,head=await exchange(route,alice,{method:'HEAD',headers:{range:'bytes=1024-','if-range':etag}});assert.equal(head.status,200);assert.equal(head.headers['content-length'],'1024');assert.equal(head.headers['content-range'],undefined);assert.equal(storage.openCalls,opens);
  storage.withoutTag=true;try{const response=await exchange(route,alice,{headers:{range:'bytes=3-7','if-range':etag}});assert.equal(response.status,200);assert.equal(response.headers.etag,undefined);assert.deepEqual(response.bytes,video.bytes);}finally{storage.withoutTag=false;}
});

test('session and artifact/upload/source-job ownership are checked before touching storage, with no raw key route',async()=>{
  const reads=storage.statCalls,opens=storage.openCalls;
  assert.equal((await exchange(`/uploads/${video.uploadId}`)).status,401);
  for(const route of [`/uploads/${video.uploadId}`,`/artifacts/${video.artifactId}`,`/uploads/${video.key}`,`/blobs/${video.key}`])for(const method of ['GET','HEAD'])assert.equal((await exchange(route,bob,{method,headers:{range:'bytes=0-1'}})).status,404);
  await db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[video.jobId,bob.id]);try{assert.equal((await exchange(`/artifacts/${video.artifactId}`,alice)).status,404);}finally{await db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1',[video.jobId,alice.id]);}
  await db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[video.uploadId,bob.id]);try{assert.equal((await exchange(`/artifacts/${video.artifactId}`,alice)).status,404);}finally{await db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[video.uploadId,alice.id]);}
  assert.equal(storage.statCalls,reads);assert.equal(storage.openCalls,opens);assert.equal(storage.getCalls,0);
});

test('size/version conflicts and storage failures return safe errors without paths or provider messages',async()=>{
  await db.query('UPDATE platform_uploads SET byte_size=byte_size+1 WHERE id=$1',[video.uploadId]);try{const response=await exchange(`/uploads/${video.uploadId}`,alice);assert.equal(response.status,409);assert.match(response.bytes.toString(),/PRIVATE_FILE_SIZE_MISMATCH/);}finally{await db.query('UPDATE platform_uploads SET byte_size=byte_size-1 WHERE id=$1',[video.uploadId]);}
  storage.beforeStat=async()=>{throw new Error(`/secret/storage/${video.key} provider credentials detail`);};try{const response=await exchange(`/uploads/${video.uploadId}`,alice);assert.equal(response.status,503);assert(!response.bytes.toString().includes(video.key));assert(!response.bytes.toString().includes('credentials'));}finally{storage.beforeStat=undefined;}
  storage.beforeOpen=async()=>{throw new Error('raw S3 request secret details');};try{const response=await exchange(`/uploads/${video.uploadId}`,alice,{headers:{range:'bytes=1-3'}});assert.equal(response.status,503);assert.equal(response.headers['content-range'],undefined);assert.match(String(response.headers['content-type']),/application\/json/);assert(!response.bytes.toString().includes('secret'));}finally{storage.beforeOpen=undefined;}
  storage.beforeOpen=async()=>({length:3,stream:Readable.from((async function*(){throw new Error('raw late storage credential details');})())});try{const response=await exchange(`/uploads/${video.uploadId}`,alice,{headers:{range:'bytes=1-3'}});assert.equal(response.status,503);assert.equal(response.headers['content-range'],undefined);assert.match(String(response.headers['content-type']),/application\/json/);assert(!response.bytes.toString().includes('credential'));}finally{storage.beforeOpen=undefined;}
  const changed=await saved(alice,Buffer.from(video.bytes));storage.beforeOpen=async(key)=>{if(key===changed.key)await fs.writeFile(path.join(directory,key),Buffer.alloc(changed.bytes.length,71));return undefined;};try{const response=await exchange(`/uploads/${changed.uploadId}`,alice,{headers:{range:'bytes=1-3'}});assert.equal(response.status,409);assert.match(response.bytes.toString(),/STORAGE_CHANGED/);assert(!response.bytes.toString().includes(changed.key));}finally{storage.beforeOpen=undefined;}
});

test('a slow real HTTP reader receives streamed bytes with backpressure and all request listeners are removed',async()=>{
  const opened=storage.opened.length,response=await exchange(`/artifacts/${large.artifactId}`,alice,{slow:true});assert.equal(response.status,200);assert.deepEqual(response.bytes,large.bytes);assert.equal(storage.getCalls,0);
  await until(()=>storage.opened.slice(opened).every(item=>item.closed));
  for(const item of storage.opened.slice(opened))assert.equal(getEventListeners(item.signal!,'abort').length,0);
  for(const item of lifecycle){assert(!item.request.listeners('aborted').some(listener=>listener.name==='interrupted'));assert(!item.response.listeners('close').some(listener=>listener.name==='closed'));assert(!item.response.listeners('finish').some(listener=>listener.name==='cleanup'));}
});

test('repeated client disconnects abort and destroy real local streams without retained listeners or buffered get',async()=>{
  for(let index=0;index<3;index++){
    const opened=storage.opened.length;
    await new Promise<void>((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:prefix+`/artifacts/${large.artifactId}`,agent:false,headers:{cookie:alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id}},res=>{res.once('data',()=>{res.pause();req.destroy();res.destroy();resolve();});res.on('error',()=>{});});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Disconnect fixture timed out.')));});
    await until(()=>storage.opened.length>opened&&storage.opened.slice(opened).every(item=>item.closed));for(const item of storage.opened.slice(opened)){assert.equal(item.signal?.aborted,true);assert.equal(item.stream.destroyed,true);assert.equal(getEventListeners(item.signal!,'abort').length,0);}
  }assert.equal(storage.getCalls,0);
  for(const item of lifecycle){assert(!item.request.listeners('aborted').some(listener=>listener.name==='interrupted'));assert(!item.response.listeners('close').some(listener=>listener.name==='closed'));assert(!item.response.listeners('finish').some(listener=>listener.name==='cleanup'));}
});

test('disconnect during metadata lookup cancels before opening any storage stream',async()=>{
  let began!:()=>void,signal:AbortSignal|undefined;const started=new Promise<void>(resolve=>{began=resolve;});const opens=storage.openCalls;
  storage.beforeStat=async(_key,value)=>{signal=value;began();await new Promise<void>(resolve=>value!.addEventListener('abort',()=>resolve(),{once:true}));throw new ApiError(499,'STORAGE_ABORTED','Fictional cancelled metadata read');};
  let req:ClientRequest;try{req=http.get({host:'127.0.0.1',port,path:prefix+`/uploads/${video.uploadId}`,agent:false,headers:{cookie:alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id}});req.on('error',()=>{});await started;req.destroy();await until(()=>signal?.aborted===true);assert.equal(storage.openCalls,opens);}finally{storage.beforeStat=undefined;}
});

test('a storage error or short EOF after first bytes aborts the HTTP response instead of reporting a complete partial file',async()=>{
  for(const mode of ['error','short-eof']){
    const opened=storage.opened.length;
    storage.beforeOpen=async()=>({length:8,stream:Readable.from((async function*(){yield Buffer.from([41,42]);await new Promise(resolve=>setTimeout(resolve,10));if(mode==='error')throw new Error('private provider-secret-path');})())});
    try{
      const response=await new Promise<{status:number;complete:boolean;bytes:Buffer}>((resolve,reject)=>{
        const req=http.get({host:'127.0.0.1',port,path:prefix+`/uploads/${video.uploadId}`,agent:false,headers:{cookie:alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id,range:'bytes=0-7'}},res=>{
          const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',()=>{});res.once('close',()=>resolve({status:res.statusCode!,complete:res.complete,bytes:Buffer.concat(chunks)}));
        });req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Short HTTP fixture timed out.')));
      });
      assert.equal(response.status,206);assert.equal(response.complete,false);assert.deepEqual(response.bytes,Buffer.from([41,42]));assert(!response.bytes.toString().includes('secret'));
      await until(()=>storage.opened.slice(opened).every(item=>item.closed));assert.equal(storage.opened.at(-1)!.stream.destroyed,true);
    }finally{storage.beforeOpen=undefined;}
  }assert.equal(storage.getCalls,0);
});
