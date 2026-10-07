import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime, VoiceSessionResult } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';

const prefix='/api/platform',origin='http://localhost:4321',base=readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'voice-fixture', PLATFORM_AGENT_PROVIDER: 'voice-fixture', PLATFORM_REALTIME_PROVIDER: 'voice-fixture', PLATFORM_TRANSCRIPTION_PROVIDER: 'voice-fixture', PLATFORM_SPEECH_PROVIDER: 'voice-fixture' ,PLATFORM_REQUIRE_INVITE:'1'});
const schema=`voice_cancel_${randomUUID().replaceAll('-','')}`,admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);
url.searchParams.set('options',`-c search_path=${schema}`);
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve}; }
let persistGate:{entered:ReturnType<typeof deferred<void>>;release:ReturnType<typeof deferred<void>>}|undefined;
class GatedDatabase extends Database {
  override async query(text:string,values:unknown[]=[]){
    if(persistGate&&text==='UPDATE platform_usage SET model=$3 WHERE id=$1 AND user_id=$2'){
      const gate=persistGate;gate.entered.resolve();await gate.release.promise;
    }
    return super.query(text,values);
  }
}
const db=new GatedDatabase(url.toString());
let issueGate:{entered:ReturnType<typeof deferred<AbortSignal>>;release:ReturnType<typeof deferred<void>>;obeyAbort:boolean}|undefined;
let issuedSignal:AbortSignal|undefined;
const sessionResult:VoiceSessionResult={clientSecret:'fictional-ephemeral-credential',model:'synthetic-voice-model',endpoint:'https://synthetic-voice.invalid/calls'};
const forbidden=async():Promise<never>=>{throw new Error('This fixture only exercises voice-session transport.');};
const runtime:PlatformProviderRuntime={
  capabilities:()=>[{id:'voice-fixture',name:'Synthetic cancellable voice',enabled:true,keyConfigured:true,capabilities:['realtime'],models: ['synthetic-voice-model'], voiceOptions: { speech: { voices: ['synthetic-voice'], defaultVoice: 'synthetic-voice' }, realtime: { voices: ['synthetic-voice'], defaultVoice: 'synthetic-voice', turnTaking: true } }, envVariables: []}],
  async *streamChat(){throw new Error('No chat model is used.');},executeJob:forbidden,transcribe:forbidden,speech:forbidden,
  async createVoiceSession(_input,context){
    assert(context?.signal,'The issuer receives the actual HTTP cancellation signal.');
    issuedSignal=context.signal;
    if(issueGate){
      const gate=issueGate;gate.entered.resolve(context.signal);
      if(gate.obeyAbort)await new Promise<void>((resolve,reject)=>{
        const abort=()=>{context.signal!.removeEventListener('abort',abort);reject(context.signal!.reason);};
        if(context.signal!.aborted)abort();else context.signal!.addEventListener('abort',abort,{once:true});
        void gate.release.promise.then(()=>{context.signal!.removeEventListener('abort',abort);resolve();});
      });else await gate.release.promise;
    }
    return {...sessionResult};
  },
};
let system:Awaited<ReturnType<typeof buildApp>>,directory:string,httpOrigin:string,registrations=0;
before(async()=>{
  assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only the local test database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`);await db.migrate(); await seedFictionalActiveLegal(db);directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-voice-cancel-'));
  system=await buildApp({legalBundle:FICTIONAL_LEGAL,db,runtime,enableQueue:false,config:{...base,databaseUrl:url.toString(),storageDir:directory,s3:undefined}});
  httpOrigin=await system.app.listen({host:'127.0.0.1',port:0});
});
after(async()=>{
  issueGate?.release.resolve();persistGate?.release.resolve();
  await system?.app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  if(directory)await fs.rm(directory,{recursive:true,force:true});
});
async function register(){
  const response=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:`127.9.0.${++registrations}`,headers:{origin},payload:await fictionalRegistration(db,{name:'Synthetic cancellation tester',email:`${randomUUID()}@example.invalid`,password:'Fictional-voice-test-2026'})});
  assert.equal(response.statusCode,201,response.body);
  return {id:response.json().user.id as string,cookie:String(response.headers['set-cookie']).split(';')[0]};
}
type Actor=Awaited<ReturnType<typeof register>>;
async function state(actor:Actor){
  const leases=await db.query('SELECT count(*)::integer AS n FROM platform_runtime_leases WHERE user_id=$1',[actor.id]);
  const sessions=await db.query('SELECT released_at IS NOT NULL AS released FROM platform_voice_sessions WHERE user_id=$1',[actor.id]);
  const usage=await db.query('SELECT count(*)::integer AS n FROM platform_usage WHERE user_id=$1',[actor.id]);
  return {leases:leases.rows[0].n,sessions:sessions.rows,attempts:usage.rows[0].n};
}
async function until(check:()=>Promise<boolean>){
  const deadline=Date.now()+5000;
  while(!await check()){if(Date.now()>deadline)throw new Error('Timed out waiting for actual voice cancellation cleanup.');await new Promise(resolve=>setTimeout(resolve,10));}
}
function begin(actor:Actor,controller:AbortController){
  return fetch(httpOrigin+prefix+'/voice/session',{method:'POST',headers:{origin,cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id,'content-type':'application/json'},body:JSON.stringify({}),signal:controller.signal})
    .then(response=>({status:response.status,aborted:false}),()=>({status:0,aborted:true}));
}

test('a real HTTP disconnect reaches the issuer and frees the owned lease without saving a session',async()=>{
  const actor=await register(),controller=new AbortController();
  const gate={entered:deferred<AbortSignal>(),release:deferred<void>(),obeyAbort:true};issueGate=gate;
  try{
    const request=begin(actor,controller),signal=await gate.entered.promise;
    assert.equal((await state(actor)).leases,1);controller.abort();assert.equal((await request).aborted,true);
    await until(async()=>signal.aborted&&(await state(actor)).leases===0);
    assert.deepEqual(await state(actor),{leases:0,sessions:[],attempts:1});
  }finally{gate.release.resolve();issueGate=undefined;}
});

test('a late issuer that ignores cancellation cannot persist or hand back its temporary credential',async()=>{
  const actor=await register(),controller=new AbortController();
  const gate={entered:deferred<AbortSignal>(),release:deferred<void>(),obeyAbort:false};issueGate=gate;
  try{
    const request=begin(actor,controller),signal=await gate.entered.promise;controller.abort();assert.equal((await request).aborted,true);
    await until(async()=>signal.aborted);gate.release.resolve();
    await until(async()=>(await state(actor)).leases===0);
    assert.deepEqual(await state(actor),{leases:0,sessions:[],attempts:1});
  }finally{gate.release.resolve();issueGate=undefined;}
});

test('disconnect after a real session insert releases both its persisted state and lease',async()=>{
  const actor=await register(),controller=new AbortController(),gate={entered:deferred<void>(),release:deferred<void>()};persistGate=gate;
  try{
    const request=begin(actor,controller);await gate.entered.promise;
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM platform_voice_sessions WHERE user_id=$1',[actor.id])).rows[0].n,1);
    controller.abort();assert.equal((await request).aborted,true);await until(async()=>issuedSignal!.aborted);gate.release.resolve();
    await until(async()=>{const current=await state(actor);return current.leases===0&&current.sessions[0]?.released;});
    assert.deepEqual(await state(actor),{leases:0,sessions:[{released:true}],attempts:1});
  }finally{gate.release.resolve();persistGate=undefined;}
});

test('normal HTTP delivery retains its lease until the owner releases it, with idempotence and account isolation',async()=>{
  const owner=await register(),other=await register();
  const response=await fetch(httpOrigin+prefix+'/voice/session',{method:'POST',headers:{origin,cookie:owner.cookie, [PLATFORM_ACCOUNT_HEADER]: owner.id,'content-type':'application/json'},body:JSON.stringify({})});
  assert.equal(response.status,200);const {sessionId}=await response.json() as {sessionId:string};
  assert.deepEqual(await state(owner),{leases:1,sessions:[{released:false}],attempts:1});
  for(const actor of [other,owner,owner]){
    const release=await fetch(httpOrigin+prefix+'/voice/session/release',{method:'POST',headers:{origin,cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id,'content-type':'application/json'},body:JSON.stringify({sessionId})});
    assert.equal(release.status,200);
    assert.equal((await state(owner)).leases,actor===other?1:0);
  }
  assert.deepEqual(await state(owner),{leases:0,sessions:[{released:true}],attempts:1});
});
