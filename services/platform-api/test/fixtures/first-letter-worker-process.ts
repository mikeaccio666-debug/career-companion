import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {FICTIONAL_LEGAL} from './student-entry.ts';
import type {PrebirthFixture} from './companion-prebirth.ts';
import {ProducerQueue} from '../../src/queue-connection.ts';
import {companionQueueName} from '../../src/companion-generation-queue.ts';
import {companionNameQueueName} from '../../src/companion-name-queue.ts';
import {firstLetterQueueName} from '../../src/first-letter-queue.ts';

export async function workerProcessFixture(f:PrebirthFixture,a:{
 config:{databaseUrl:string;redisUrl:string;queueName:string;expertRoster:unknown};
 authority:{asset:unknown;review:unknown};respond:typeof fetch;
},model:string){
 assert.match(a.config.queueName,/^fictional-first-letter-start-[0-9a-f-]{36}$/);
 const db=new URL(a.config.databaseUrl),redis=new URL(a.config.redisUrl);
 assert(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.notEqual(db.port,'5442');
 assert(['localhost','127.0.0.1','[::1]'].includes(redis.hostname));
 db.searchParams.set('options','-c search_path='+f.schema);
 const directory=await mkdtemp(join(tmpdir(),'fictional-letter-worker-'));
 const children:Array<{dispose():Promise<void>}>=[];
 const server=createServer((request,response)=>{void(async()=>{
  assert.equal(request.method,'POST');assert.equal(request.url,'/');
  let body='';for await(const chunk of request){body+=chunk;assert(body.length<1024*1024);}
  const result=await a.respond('https://api.openai.com/v1/responses',{method:'POST',body});
  response.writeHead(result.status,{'content-type':'text/event-stream'});response.end(await result.text());
 })().catch(()=>{response.writeHead(500);response.end('Fictional transport fixture failed.');});});
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert(address&&typeof address!=='string');const endpoint='http://127.0.0.1:'+address.port+'/';
  const assets:Record<string,unknown>={
   PLATFORM_LEGAL_BUNDLE_FILE:FICTIONAL_LEGAL,PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE:a.authority.asset,
   PLATFORM_COMPANION_IDENTITY_REVIEW_FILE:a.authority.review,
   PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE:f.bundle,PLATFORM_SAFETY_DELIVERY_REVIEW_FILE:f.review,
  };
  const files:Record<string,string>={};
  for(const [key,value] of Object.entries(assets)){files[key]=join(directory,key+'.json');await writeFile(files[key],JSON.stringify(value),{mode:0o600});}
  async function until(check:()=>Promise<boolean>,timeout=10000){
   const end=Date.now()+timeout;
   while(!await check()){assert(Date.now()<end,'Actual worker process observation timed out');await new Promise(r=>setTimeout(r,40));}
  }
  async function start(enabled:boolean){
   const appName='fictional-worker-'+randomUUID(),connection=new URL(db);connection.searchParams.set('application_name',appName);
   // Explicit allowlist: never inherit keys, NODE_OPTIONS or production configuration.
   // Fictional mail configuration satisfies verified-email startup; the child denies mail fetch.
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:'test',...files,
    PLATFORM_DATABASE_URL:connection.toString(),PLATFORM_REDIS_URL:a.config.redisUrl,
    PLATFORM_QUEUE_NAME:a.config.queueName,PLATFORM_BUILD_ID:'fictional-process-test',
    PLATFORM_STORAGE_DIR:join(directory,'blobs'),PLATFORM_DATA_KEY:'e5'.repeat(32),
    PLATFORM_ALLOW_ACCOUNT_EMAIL:'1',RESEND_API_KEY:'fictional-denied-transport',
    PLATFORM_ACCOUNT_EMAIL_FROM:'Fictional <noreply@example.invalid>',PLATFORM_ACCOUNT_WEB_ORIGIN:'http://localhost:4321',
    PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY:'a1'.repeat(32),PLATFORM_REQUIRE_VERIFIED_EMAIL:'1',PLATFORM_ALLOW_PROVIDER_CALLS:enabled?'1':'0',
    PLATFORM_FIRST_LETTER_PROVIDER:'openai',PLATFORM_COMPANION_GENERATION_PROVIDER:'openai',PLATFORM_CHAT_PROVIDER:'openai',
    PLATFORM_EXPERT_ROSTER_JSON:JSON.stringify(a.config.expertRoster),
    OPENAI_API_KEY:'fictional-loopback-only',OPENAI_FIRST_LETTER_MODEL:model,
    OPENAI_COMPANION_GENERATION_MODEL:'fictional-companion-model',FICTIONAL_WORKER_ENDPOINT:endpoint};
   const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./first-letter-worker-child.ts',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
   let output='',errors='',ended=false,exitCode:number|null=null,exitSignal:NodeJS.Signals|null=null,failed=false,signalled=false;
   child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-4000);});
   // Bound captured diagnostics; never print raw process configuration or database URL.
   child.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-4000);});
   child.on('error',()=>{failed=true;ended=true;});
   const closed=new Promise<void>(resolve=>child.once('close',(code,signal)=>{exitCode=code;exitSignal=signal;ended=true;resolve();}));
   function signal(){if(!ended&&!signalled){signalled=true;assert(child.kill('SIGTERM'));}}
   async function dispose(){if(!ended)child.kill('SIGKILL');await closed;}
   children.push({dispose});
   await until(async()=>{assert(!ended&&!failed,'Actual worker failed before startup: '+errors.replace(/(?:postgres(?:ql)?|redis|https?):\/\/[^\s]+/g,'[redacted URL]').replace(/[a-f0-9]{64}/g,'[redacted digest]'));return output.includes('Platform task worker started.');});
   return {signal,exited:()=>ended,async stop(){
    signal();await until(async()=>ended);await closed;assert.equal(exitCode,0);assert.equal(exitSignal,null);assert.equal(errors,'');
    await until(async()=> (await f.db.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[appName])).rowCount===0);
   }};
  }
  return {start,until,async close(){
   try{
    for(const child of children)await child.dispose();
    const results=await Promise.allSettled([a.config.queueName,companionQueueName(a.config.queueName),companionNameQueueName(a.config.queueName),firstLetterQueueName(a.config.queueName)].map(async name=>{
     const queue=new ProducerQueue(name,a.config.redisUrl);
     try{await queue.obliterate({force:true});}finally{await queue.close();}
    }));
    assert(results.every(result=>result.status==='fulfilled'),'Owned worker queues could not all be cleaned up');
   }finally{
    server.closeAllConnections();
    try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    finally{await rm(directory,{recursive:true,force:true});}
   }
  }};
 }catch(error){
  for(const child of children)await child.dispose();
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(directory,{recursive:true,force:true});throw error;
 }
}
