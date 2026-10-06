import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { S3BlobStorage, type BlobReadOptions } from '../src/storage.ts';

const enabled=process.env.PLATFORM_TEST_OBJECT_STORAGE==='1';
const origin='http://localhost:4321',prefix='/api/platform';
// Local fixture credentials published in the development compose file; no cloud credentials.
const credentials={accessKeyId:'local-companion-s3-access',secretAccessKey:'local-companion-s3-secret-only'};
function localUrl(value:string,protocols:string[]){
  const result=new URL(value);
  assert(protocols.includes(result.protocol)&&['127.0.0.1','localhost','[::1]'].includes(result.hostname),'Object-storage integration fixtures require an explicit loopback endpoint.');
  return result;
}
type Actor={id:string;cookie:string};
type Exchange={status:number;headers:http.IncomingHttpHeaders;bytes:Buffer};
function request(url:URL,options:{method?:string;headers?:Record<string,string>;body?:string}={}):Promise<Exchange>{
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:options.method??'GET',agent:false,headers:{...(options.body?{'content-length':Buffer.byteLength(options.body)}:{}),...options.headers}},res=>{
      const chunks:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>3*1024*1024){res.destroy(new Error('Synthetic HTTP fixture exceeded its response bound.'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.setTimeout(10_000,()=>req.destroy(new Error('Local object-storage HTTP fixture timed out.')));req.end(options.body);
  });
}
async function bytes(stream:import('node:stream').Readable){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
class StreamingOnlyS3 extends S3BlobStorage {
  getCalls=0;statCalls=0;openCalls=0;beforeOpen?: (key:string)=>Promise<void>;
  override async get(_key:string):Promise<never>{this.getCalls++;throw new Error('Private HTTP delivery must not buffer the complete S3 object.');}
  override async stat(key:string,signal?:AbortSignal){this.statCalls++;return super.stat(key,signal);}
  override async openRead(key:string,options:BlobReadOptions){this.openCalls++;await this.beforeOpen?.(key);return super.openRead(key,options);}
}

test('real local S3 storage and private HTTP Range delivery', {skip:!enabled,timeout:45_000},async t=>{
  const endpoint=localUrl(process.env.PLATFORM_TEST_OBJECT_STORAGE_ENDPOINT??'http://127.0.0.1:19000',['http:']);
  assert(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&(endpoint.pathname==='/'||endpoint.pathname===''),'Use a bare local fixture endpoint.');
  const base=readConfig({PLATFORM_DATABASE_URL:process.env.PLATFORM_DATABASE_URL,PLATFORM_ALLOWED_ORIGINS:origin});
  localUrl(base.databaseUrl,['postgres:','postgresql:']);
  const bucket=`companion-fixture-${randomUUID()}`,schema=`object_stream_${randomUUID().replaceAll('-','')}`;
  const connection=new URL(base.databaseUrl);connection.searchParams.set('options',`-c search_path=${schema}`);
  const sdk=new S3Client({endpoint:endpoint.href,region:'us-east-1',forcePathStyle:true,credentials,maxAttempts:1});
  const s3={endpoint:endpoint.href,region:'us-east-1',bucket,...credentials},storage=new StreamingOnlyS3(s3,sdk);
  const admin=new Database(base.databaseUrl),db=new Database(connection.toString());
  let createdBucket=false,createdSchema=false,system:Awaited<ReturnType<typeof buildApp>>|undefined,appOrigin:URL;
  const forbidden=async()=>{throw new Error('No commercial calls are permitted in object-storage fixtures.');};
  const runtime:PlatformProviderRuntime={capabilities:()=>[],streamChat:async function*(){throw new Error('No model use');},executeJob:forbidden,createVoiceSession:forbidden,transcribe:forbidden,speech:forbidden};
  const exchange=(route:string,actor?:Actor,options:{method?:string;headers?:Record<string,string>;body?:string}={})=>request(new URL(prefix+route,appOrigin),{...options,headers:{...(actor?{cookie:actor.cookie}:{}),...options.headers}});
  const register=async(name:string):Promise<Actor>=>{
    const response=await exchange('/auth/register',undefined,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({name,email:`${randomUUID()}@example.invalid`,password:'Fictional-password-123'})});
    assert.equal(response.status,201);const payload=JSON.parse(response.bytes.toString());return {id:payload.user.id,cookie:response.headers['set-cookie']![0]!.split(';')[0]!};
  };
  try{
    await sdk.send(new CreateBucketCommand({Bucket:bucket}));createdBucket=true;
    await admin.query(`CREATE SCHEMA ${schema}`);createdSchema=true;await db.migrate();
    system=await buildApp({config:{...base,databaseUrl:connection.toString(),s3},db,storage,runtime,enableQueue:false});
    await system.app.listen({host:'127.0.0.1',port:0});appOrigin=new URL(`http://127.0.0.1:${(system.app.server.address() as AddressInfo).port}`);
    const alice=await register('Fictional object owner'),bob=await register('Fictional second account');
    const uploadId=randomUUID(),artifactId=randomUUID(),jobId=randomUUID(),key=randomUUID();
    const media=Buffer.alloc(2*1024*1024,39);media.write('ftyp',4);
    await storage.put(key,media,'video/mp4');
    await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,\'fictional-video.mp4\',\'video/mp4\',$3,$4)',[uploadId,alice.id,media.length,key]);
    await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'video','fictional-fixture','Synthetic storage transport bytes; no model generated video','succeeded')",[jobId,alice.id]);
    await db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,'video','video/mp4','fictional-video.mp4',$4)",[artifactId,alice.id,jobId,uploadId]);

    await t.test('official SDK PUT/stat/full and partial streams preserve real object bytes',async()=>{
      const expected=await storage.stat(key);assert.equal(expected.size,media.length);assert.match(expected.etag!,/^"[\x21\x23-\x7e]+"$/);
      const full=await storage.openRead(key,{expected});assert.equal(full.length,media.length);assert.deepEqual(await bytes(full.stream),media);
      const partial=await storage.openRead(key,{expected,range:{start:11,end:127}});assert.equal(partial.length,117);assert.deepEqual(await bytes(partial.stream),media.subarray(11,128));
    });

    await t.test('IfMatch pins a real same-size object version before streaming',async()=>{
      const versionKey=randomUUID(),first=Buffer.from('Synthetic-version-A'),second=Buffer.from('Synthetic-version-B');assert.equal(first.length,second.length);
      await storage.put(versionKey,first,'text/plain');const expected=await storage.stat(versionKey);await storage.put(versionKey,second,'text/plain');
      const changed=await storage.stat(versionKey);assert.equal(changed.size,expected.size);assert.notEqual(changed.etag,expected.etag);
      await assert.rejects(storage.openRead(versionKey,{expected}),{code:'STORAGE_CHANGED'});
    });

    await t.test('real Node HTTP owner GET/Range/HEAD use streaming storage without get',async()=>{
      for(const route of [`/uploads/${uploadId}`,`/artifacts/${artifactId}`]){
        const full=await exchange(route,alice);assert.equal(full.status,200);assert.deepEqual(full.bytes,media);assert.equal(full.headers['content-type'],'video/mp4');assert.equal(full.headers['content-length'],String(media.length));assert.equal(full.headers['cache-control'],'private, no-store');assert.equal(full.headers['accept-ranges'],'bytes');assert.equal(full.headers['x-content-type-options'],'nosniff');
        const ranged=await exchange(route,alice,{headers:{range:'bytes=11-127','if-range':String(full.headers.etag)}});assert.equal(ranged.status,206);assert.equal(ranged.headers['content-range'],`bytes 11-127/${media.length}`);assert.equal(ranged.headers['content-length'],'117');assert.deepEqual(ranged.bytes,media.subarray(11,128));
        const opens=storage.openCalls,head=await exchange(route,alice,{method:'HEAD',headers:{range:'bytes=11-127'}});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],String(media.length));assert.equal(head.headers['content-range'],undefined);assert.equal(storage.openCalls,opens);
      }
      assert.equal(storage.getCalls,0);
    });

    await t.test('cross-owner and anonymous platform reads stop before touching object storage',async()=>{
      const stats=storage.statCalls,opens=storage.openCalls;
      for(const route of [`/uploads/${uploadId}`,`/artifacts/${artifactId}`]){
        assert.equal((await exchange(route)).status,401);
        for(const method of ['GET','HEAD'])assert.equal((await exchange(route,bob,{method,headers:{range:'bytes=0-3'}})).status,404);
      }
      assert.equal(storage.statCalls,stats);assert.equal(storage.openCalls,opens);assert.equal(storage.getCalls,0);
    });

    await t.test('a same-size change between route metadata and read returns a safe conflict',async()=>{
      const changed=Buffer.from(media);changed[100]=40;
      storage.beforeOpen=async target=>{if(target===key)await storage.put(key,changed,'video/mp4');};
      try{
        const response=await exchange(`/artifacts/${artifactId}`,alice,{headers:{range:'bytes=1-3'}});assert.equal(response.status,409);assert.match(response.bytes.toString(),/STORAGE_CHANGED/);assert(!response.bytes.toString().includes(key));assert.equal(response.headers['content-range'],undefined);
      }finally{storage.beforeOpen=undefined;await storage.put(key,media,'video/mp4');}
      assert.equal(storage.getCalls,0);
    });

    await t.test('anonymous direct S3 object GET is denied by real fixture authentication',async()=>{
      const anonymous=await request(new URL(`/${bucket}/${key}`,endpoint));assert(anonymous.status>=400&&anonymous.status<500,`Anonymous object request unexpectedly returned HTTP ${anonymous.status}.`);assert.notDeepEqual(anonymous.bytes,media);t.diagnostic(`Anonymous S3 object GET returned HTTP ${anonymous.status}.`);
    });
  }finally{
    // Attempt every owned cleanup even when an earlier close or delete failed.
    const failures:unknown[]=[];
    for(const cleanup of [
      async()=>{await system?.app.close();},async()=>{await db.close();},
      async()=>{if(createdSchema)await admin.query(`DROP SCHEMA ${schema} CASCADE`);},async()=>{await admin.close();},
      async()=>{
        // Never enumerate another bucket. The random per-run bucket was created above.
        if(!createdBucket)return;let token:string|undefined;
        do{const objects=await sdk.send(new ListObjectsV2Command({Bucket:bucket,ContinuationToken:token}));for(const object of objects.Contents??[])if(object.Key)await sdk.send(new DeleteObjectCommand({Bucket:bucket,Key:object.Key}));token=objects.NextContinuationToken;}while(token);
        await sdk.send(new DeleteBucketCommand({Bucket:bucket}));
      },
    ])try{await cleanup();}catch(error){failures.push(error);}
    sdk.destroy();if(failures.length)throw new Error('Owned object-storage fixture cleanup did not finish.');
  }
});
