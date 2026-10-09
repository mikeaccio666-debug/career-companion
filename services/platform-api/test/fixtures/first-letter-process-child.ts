// A disposable child process, killed only by its owning integration test.
// No production credentials, external transport, migrations, or fake source readers.
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {createProviderRuntime} from '@companion/ai-core';
import {Database} from '../../src/database.ts';
import {readDataCrypto} from '../../src/data-crypto.ts';
import {BackgroundGeneration} from '../../src/background-generation.ts';
import {CompanionIdentityDrafts} from '../../src/companion-identity-drafts.ts';
import {CompanionNameSafety} from '../../src/companion-name-safety.ts';
import {CompanionPrebirthSafety} from '../../src/companion-prebirth-safety.ts';
import {FirstLetterSources} from '../../src/first-letter-sources.ts';
import {FirstLetterTasks} from '../../src/first-letter-tasks.ts';
import {FirstLetterGeneration} from '../../src/first-letter-generation.ts';
import {FICTIONAL_LEGAL} from './student-entry.ts';

async function pause(phase:string):Promise<never>{
 process.send?.({kind:'paused',phase});
 return new Promise<never>(()=>{setInterval(()=>{},1000);});
}
process.once('message',async(value:any)=>{
 let db:Database|undefined;
 try{
  const url=new URL(value.databaseUrl);
  assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.notEqual(url.port,'5442');
  assert.match(url.searchParams.get('options')??'',/^-c search_path=companion_name_[0-9a-f]{32}$/);
  const local=value.local?new URL(value.local):null;
  if(local)assert.equal(local.hostname,'127.0.0.1');
  const phase=value.phase;
  class CrashDatabase extends Database{
   override async withBoundedTransaction<T>(run:(c:PoolClient)=>Promise<T>,options={}):Promise<T>{
    let boundary=false;
    const result=await super.withBoundedTransaction(c=>run(new Proxy(c,{get(target,key){
     if(key==='query')return async(sql:string,args?:unknown[])=>{
      const result=await target.query(sql,args);
      if(phase==='dispatch'&&sql.startsWith("UPDATE platform_first_letter_stages s SET call_status='admitted'")
       ||phase==='receipt'&&sql.startsWith('UPDATE platform_first_letter_stages SET call_status=$2')
       ||phase==='saved'&&sql.startsWith('UPDATE platform_first_letter_stages SET status=$2,output_ciphertext=$3'))boundary=true;
      return result;
     };
     const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }})),options);
    if(boundary){
     // Admission committed; the server only flushes headers after consuming the
     // entire request. Other boundaries are also after real PostgreSQL COMMIT.
     if(phase==='dispatch')await (result as any).pendingResponse;
     await pause(phase);
    }
    return result;
   }
  }
  db=new CrashDatabase(url.toString());
  const config={dataCrypto:readDataCrypto({PLATFORM_DATA_KEY:'e5'.repeat(32)})!,requireVerifiedEmail:true,
   modelRoutes:{chat:{provider:'openai'},companion_generation:{provider:'openai'},first_letter_generation:{provider:'openai'}}};
  const runtime=createProviderRuntime({env:local?{PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-loopback-only',
   OPENAI_FIRST_LETTER_MODEL:'fictional-first-letter'}:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:(target,init)=>{
    assert(local);const remote=new URL(String(target));
    assert.equal(remote.origin,'https://api.openai.com');assert.equal(remote.pathname,'/v1/responses');assert.equal(remote.search,'');
    return fetch(local.origin+remote.pathname,init);
   }});
  const background=new BackgroundGeneration(db,config,FICTIONAL_LEGAL,runtime);
  const names=new CompanionIdentityDrafts(db,config,FICTIONAL_LEGAL,background,value.asset,value.review);
  const safety=new CompanionNameSafety(db,config,FICTIONAL_LEGAL,background,names);
  const prebirth=new CompanionPrebirthSafety(db,config,FICTIONAL_LEGAL,background,safety,names);
  const sources=new FirstLetterSources(db,config,FICTIONAL_LEGAL,background,prebirth);
  const tasks=new FirstLetterTasks(db,config,sources),generation=new FirstLetterGeneration(db,config,runtime,tasks);
  assert(['generate','review','recover','recoverReview'].includes(value.mode));
  const result=await generation[value.mode as 'generate'](value.who,{taskId:value.taskId},value.settings);
  process.send?.({kind:'result',result});
 }catch(error){process.send?.({kind:'failure',code:error&&typeof error==='object'&&'code' in error?String(error.code):'TEST_CHILD_FAILED'});}
 finally{await db?.close();process.disconnect?.();}
});
process.send?.({kind:'ready'});
