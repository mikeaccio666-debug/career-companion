import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import { fstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { HeadObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalBlobStorage, S3BlobStorage } from '../src/storage.ts';

const config={bucket:'synthetic-bucket',region:'us-east-1',accessKeyId:'synthetic-access',secretAccessKey:'synthetic-secret'};
function client(send:(command:any,options?:{abortSignal?:AbortSignal})=>unknown):Pick<S3Client,'send'>{return {send:async(command:any,options:any)=>send(command,options)} as unknown as Pick<S3Client,'send'>;}
async function collect(stream:Readable){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
async function fixture(run:(storage:LocalBlobStorage,directory:string)=>Promise<void>){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'private-stream-fixture-'));try{await run(new LocalBlobStorage(directory),directory);}finally{await fs.rm(directory,{recursive:true,force:true});}}
const closed=(stream:Readable)=>stream.closed?Promise.resolve():new Promise<void>(resolve=>stream.once('close',resolve));
const next=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('local reads use bounded FD streams for full and inclusive ranges without readFile',async()=>fixture(async(storage)=>{
  const bytes=Buffer.from('Only invented private fixture bytes.');await storage.put('synthetic',bytes);
  const readFile=fs.readFile;fs.readFile=async()=>{throw new Error('Streaming must not buffer the blob through readFile');};
  try{
    const stat=await storage.stat('synthetic');assert.equal(stat.size,bytes.length);assert.match(stat.etag!,/^"local-[a-f0-9]{64}"$/);
    const full=await storage.openRead('synthetic',{expected:stat});assert.equal(full.length,bytes.length);assert.deepEqual(await collect(full.stream),bytes);await closed(full.stream);
    const partial=await storage.openRead('synthetic',{range:{start:5,end:12},expected:stat});assert.equal(partial.length,8);assert.deepEqual(await collect(partial.stream),bytes.subarray(5,13));await closed(partial.stream);
    assert.deepEqual(await storage.stat('synthetic'),stat,'reading does not change the immutable version validator');
  }finally{fs.readFile=readFile;}
  assert.deepEqual(await storage.get('synthetic'),new Uint8Array(bytes),'model byte reads retain their existing API');
}));

test('local version mismatch, missing files, symlinks and invalid ranges fail before streaming',async()=>fixture(async(storage,directory)=>{
  await storage.put('synthetic',Buffer.from('one'));const expected=await storage.stat('synthetic');
  await storage.delete('synthetic');await storage.put('synthetic',Buffer.from('two'));
  await assert.rejects(storage.openRead('synthetic',{expected}),{code:'STORAGE_CHANGED'});
  await assert.rejects(storage.stat('missing'),{code:'STORAGE_NOT_FOUND'});
  await fs.symlink(path.join(directory,'synthetic'),path.join(directory,'symlink'));
  await assert.rejects(storage.stat('symlink'),{code:'STORAGE_CHANGED'});
  const fresh=await storage.stat('synthetic');
  for(const range of [{start:-1,end:0},{start:0,end:3},{start:2,end:1},{start:0.5,end:1}])await assert.rejects(storage.openRead('synthetic',{expected:fresh,range}),{code:'STORAGE_INVALID_RANGE'});
  await assert.rejects(storage.openRead('synthetic',{expected:{...fresh,etag:'W/"weak"'}}),{code:'STORAGE_INVALID_RESPONSE'});
}));

test('empty local blobs have zero-length full streams and no satisfiable byte range',async()=>fixture(async(storage)=>{
  await storage.put('empty',new Uint8Array());const stat=await storage.stat('empty');assert.equal(stat.size,0);
  const result=await storage.openRead('empty',{expected:stat});assert.equal(result.length,0);assert.equal((await collect(result.stream)).length,0);await closed(result.stream);
  await assert.rejects(storage.openRead('empty',{expected:stat,range:{start:0,end:0}}),{code:'STORAGE_INVALID_RANGE'});
}));

test('local abort and client destruction close the actual FD promptly and stop bounded reads',async()=>fixture(async(storage)=>{
  await storage.put('large',new Uint8Array(8*1024*1024));const expected=await storage.stat('large');
  for(const abort of [true,false]){
    const controller=new AbortController(),open=fs.open;let fd=-1,actual:FileHandle|undefined,sourceClosed=false,handleCloseEvent=false;
    fs.open=async(...args:any[])=>{const handle:FileHandle&EventEmitter=await (open as any)(...args);actual=handle;fd=handle.fd;handle.once('close',()=>{handleCloseEvent=true;});const create=handle.createReadStream.bind(handle);handle.createReadStream=options=>{const source=create(options);source.once('close',()=>{sourceClosed=true;});return source;};return handle;};
    let result;
    try{result=await storage.openRead('large',{expected,signal:controller.signal});}finally{fs.open=open;}
    const errors:any[]=[];result.stream.on('error',error=>errors.push(error));await next();
    assert(result.stream.readableLength<=64*1024,'unconsumed output stays backpressured');
    const done=closed(result.stream),started=Date.now();if(abort)controller.abort();else result.stream.destroy();await done;
    assert(Date.now()-started<2000);assert(sourceClosed,'output close confirms the actual source close event');assert(handleCloseEvent);assert.equal(actual?.fd,-1);assert.throws(()=>fstatSync(fd),(error:any)=>error.code==='EBADF','actual descriptor is closed');
    if(abort){assert.equal(errors[0]?.code,'STORAGE_ABORTED');assert(!errors[0].message.includes('private-stream-fixture'));}
    assert(result.stream.destroyed);
  }
}));

test('local truncation after stat is a stream error and closes the actual FD',async()=>fixture(async(storage,directory)=>{
  await storage.put('large',new Uint8Array(8*1024*1024));const expected=await storage.stat('large');
  const open=fs.open;let fd=-1,actual:FileHandle|undefined,sourceClosed=false,handleCloseEvent=false;
  fs.open=async(...args:any[])=>{const handle:FileHandle&EventEmitter=await (open as any)(...args);actual=handle;fd=handle.fd;handle.once('close',()=>{handleCloseEvent=true;});const create=handle.createReadStream.bind(handle);handle.createReadStream=options=>{const source=create(options);source.once('close',()=>{sourceClosed=true;});return source;};return handle;};
  let result;try{result=await storage.openRead('large',{expected});}finally{fs.open=open;}
  await fs.truncate(path.join(directory,'large'),0);
  await assert.rejects(collect(result.stream),{code:'STORAGE_TRUNCATED'});await closed(result.stream);
  assert(sourceClosed,'output close confirms the actual source close event');assert(handleCloseEvent);assert.equal(actual?.fd,-1);
  assert.throws(()=>fstatSync(fd),(error:any)=>error.code==='EBADF');
}));

test('local cleanup failure is a safe stream error and still waits for the physical source close',{timeout:5000},async()=>fixture(async(storage)=>{
  await storage.put('synthetic',Buffer.from('Synthetic fixture bytes'));const expected=await storage.stat('synthetic'),open=fs.open;
  let sourceClosed=false,fd=-1;
  fs.open=async(...args:any[])=>{
    const handle:FileHandle=await (open as any)(...args);fd=handle.fd;
    const close=handle.close.bind(handle),create=handle.createReadStream.bind(handle);
    handle.close=async()=>{await close();throw new Error('private synthetic path and credential details');};
    handle.createReadStream=options=>{const source=create(options);source.once('close',()=>{sourceClosed=true;});return source;};
    return handle;
  };
  let result;try{result=await storage.openRead('synthetic',{expected});}finally{fs.open=open;}
  const failed=new Promise<Error>(resolve=>result.stream.once('error',resolve)),done=closed(result.stream);
  result.stream.resume();const error=await failed;await done;
  assert.equal((error as any).code,'STORAGE_READ_FAILED');assert(!error.message.includes('credential'));assert(sourceClosed);assert.throws(()=>fstatSync(fd),(value:any)=>value.code==='EBADF');
}));

test('S3 streams preserve strong ETag and send exact inclusive Range/IfMatch with SDK abort signals',async()=>{
  const bytes=Buffer.from('0123456789'),etag='"synthetic-etag"',commands:any[]=[];
  const storage=new S3BlobStorage(config,client((command,options)=>{
    commands.push(command);assert(options?.abortSignal instanceof AbortSignal);
    if(command instanceof HeadObjectCommand)return {ContentLength:bytes.length,ETag:etag};
    assert(command instanceof GetObjectCommand);assert.equal(command.input.IfMatch,etag);
    const partial=command.input.Range==='bytes=2-5';
    const Body=Readable.from([partial?bytes.subarray(2,6):bytes]);(Body as any).transformToByteArray=()=>{throw new Error('No buffering fallback');};
    return {Body,ContentLength:partial?4:bytes.length,ETag:etag,...(partial?{ContentRange:'bytes 2-5/10'}:{}),$metadata:{httpStatusCode:partial?206:200}};
  }));
  const signal=new AbortController().signal,expected=await storage.stat('synthetic',signal);assert.deepEqual(expected,{size:10,etag});
  const full=await storage.openRead('synthetic',{expected,signal});assert.deepEqual(await collect(full.stream),bytes);await closed(full.stream);
  const partial=await storage.openRead('synthetic',{expected,range:{start:2,end:5},signal});assert.equal(partial.length,4);assert.deepEqual(await collect(partial.stream),bytes.subarray(2,6));await closed(partial.stream);
  assert.equal(commands.length,3);
});

test('S3 inconsistent range, length, ETag and nonstream bodies fail without leaking storage errors',async()=>{
  const expected={size:10,etag:'"synthetic-etag"'},range={start:2,end:5};
  for(const override of [{ContentLength:10},{ContentRange:'bytes 2-5/11'},{ContentRange:'bytes 3-6/10'},{ETag:'"other-version"'},{ETag:'W/"weak"'},{$metadata:{httpStatusCode:200}},{Body:undefined}]){
    const source=Readable.from([Buffer.from('2345')]);let signal:AbortSignal|undefined;
    const storage=new S3BlobStorage(config,client((_command,options)=>{signal=options?.abortSignal;return {Body:source,ContentLength:4,ETag:expected.etag,ContentRange:'bytes 2-5/10',$metadata:{httpStatusCode:206},...override};}));
    await assert.rejects(storage.openRead('synthetic',{expected,range}),(error:any)=>['STORAGE_CHANGED','STORAGE_INVALID_RESPONSE'].includes(error.code));
    if(!Object.hasOwn(override,'Body'))assert(source.destroyed);assert(signal?.aborted);
  }
  for(const error of [{name:'NoSuchKey',message:'synthetic-secret /private/path'},{name:'PreconditionFailed',message:'synthetic-secret /private/path'},{name:'InternalFailure',message:'synthetic-secret /private/path'}]){
    const storage=new S3BlobStorage(config,client(()=>{throw error;}));
    await assert.rejects(storage.stat('synthetic'),(value:any)=>['STORAGE_NOT_FOUND','STORAGE_CHANGED','STORAGE_READ_FAILED'].includes(value.code)&&!value.message.includes('synthetic-secret')&&!value.message.includes('/private/path'));
  }
});

test('S3 truncated/oversized streams fail and client cancellation aborts the request and destroys Body',async()=>{
  const expected={size:4,etag:'"synthetic-etag"'};
  for(const body of [Buffer.from('12'),Buffer.from('12345')]){
    const source=Readable.from([body]);const storage=new S3BlobStorage(config,client(()=>({Body:source,ContentLength:4,ETag:expected.etag,$metadata:{httpStatusCode:200}})));
    const result=await storage.openRead('synthetic',{expected});await assert.rejects(collect(result.stream),{code:'STORAGE_TRUNCATED'});await closed(result.stream);assert(source.destroyed);
  }
  for(const abort of [true,false]){
    const source=new Readable({read(){this.push(Buffer.alloc(64*1024));}});let requestSignal:AbortSignal|undefined;
    const controller=new AbortController(),storage=new S3BlobStorage(config,client((_command,options)=>{requestSignal=options?.abortSignal;return {Body:source,ContentLength:8*1024*1024,ETag:expected.etag,$metadata:{httpStatusCode:200}};}));
    const result=await storage.openRead('synthetic',{expected:{...expected,size:8*1024*1024},signal:controller.signal});const errors:any[]=[];result.stream.on('error',error=>errors.push(error));await next();
    const done=closed(result.stream);if(abort)controller.abort();else result.stream.destroy();await done;
    assert(source.destroyed);assert(requestSignal?.aborted);if(abort)assert.equal(errors[0]?.code,'STORAGE_ABORTED');
  }
  const controller=new AbortController();controller.abort();let sends=0;
  const storage=new S3BlobStorage(config,client(()=>{sends++;return {};}));
  await assert.rejects(storage.stat('synthetic',controller.signal),{code:'STORAGE_ABORTED'});
  await assert.rejects(storage.openRead('synthetic',{expected,signal:controller.signal}),{code:'STORAGE_ABORTED'});assert.equal(sends,0);
});

test('official S3 SDK uses real local HTTP streams, conditional ranges and socket cancellation',async()=>{
  const bytes=Buffer.from('Only synthetic wire fixture bytes.'),etag='"synthetic-wire-version"';let head=0,get=0,closeSlow!:()=>void;
  const slowClosed=new Promise<void>(resolve=>{closeSlow=resolve;});
  const server=http.createServer((req,res)=>{
    const slow=new URL(req.url!,'http://localhost').pathname.endsWith('/slow');
    const total=slow?8*1024*1024:bytes.length;res.setHeader('ETag',etag);
    if(req.method==='HEAD'){head++;res.setHeader('Content-Length',total);res.end();return;}
    assert.equal(req.method,'GET');assert.equal(req.headers['if-match'],etag);get++;
    if(slow){res.once('close',closeSlow);res.writeHead(200,{'Content-Length':total});res.write(Buffer.alloc(64*1024));return;}
    const range=req.headers.range;assert.equal(range,'bytes=2-5');
    res.writeHead(206,{'Content-Length':4,'Content-Range':`bytes 2-5/${total}`});res.end(bytes.subarray(2,6));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const sdk=new S3Client({region:config.region,endpoint:`http://127.0.0.1:${address.port}`,forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},maxAttempts:1});
  const storage=new S3BlobStorage(config,sdk);
  try{
    const expected=await storage.stat('synthetic');assert.deepEqual(expected,{size:bytes.length,etag});assert.equal(get,0);
    const partial=await storage.openRead('synthetic',{expected,range:{start:2,end:5}});assert.deepEqual(await collect(partial.stream),bytes.subarray(2,6));await closed(partial.stream);
    const slowExpected=await storage.stat('slow'),controller=new AbortController();
    const slow=await storage.openRead('slow',{expected:slowExpected,signal:controller.signal});slow.stream.on('error',()=>{});
    const done=closed(slow.stream);controller.abort();await done;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([slowClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Local S3 response socket did not close after cancellation')),2000);})]);}finally{clearTimeout(timer);}
    assert.equal(head,2);assert.equal(get,2);
  }finally{sdk.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
