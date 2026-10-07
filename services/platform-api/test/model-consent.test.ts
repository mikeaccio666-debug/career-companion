import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { ModelConsent, requireModelConsent } from '../src/model-consent.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

class FictionalDatabase extends Database {
  statements:string[]=[];locked=false;commits=0;rejectCommit=false;consented=true;sessionValid=true;policyCurrent=true;jobValid=true;authVersion='7';
  constructor(){super('postgresql://fictional@localhost/unused');}
  override async withBoundedTransaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{
    this.locked=true;
    // Explicit narrow fake query port. This tests sequencing, not PostgreSQL lock behavior.
    const query=async(sql:string)=>{
      this.statements.push(sql);
      if(sql.includes('platform_terms_policy'))return {rowCount:this.policyCurrent?1:0,rows:this.policyCurrent?[{terms_version:FICTIONAL_LEGAL.version,content_digest:FICTIONAL_LEGAL.digest,review_digest:FICTIONAL_LEGAL.reviewDigest}]:[]};
      if(sql.includes('platform_terms_consents'))return {rowCount:this.consented?1:0,rows:[]};
      if(sql.includes('platform_jobs'))return {rowCount:this.jobValid?1:0,rows:[]};
      if(sql.includes('SELECT auth_version'))return {rowCount:1,rows:[{auth_version:this.authVersion}]};
      return {rowCount:this.sessionValid?1:0,rows:[]};
    };
    const client={query} as unknown as PoolClient;
    try{const result=await run(client);if(this.rejectCommit)throw new Error('Fictional commit rejected');this.commits++;return result;}finally{this.locked=false;}
  }
}
const session=()=>({userId:'fictional-user',tokenHash:'fictional-hash'});
const isCode=(code:string)=>(error:unknown)=>error instanceof ApiError&&error.code===code;

test('a request launches under admission locks but headers and body are awaited outside',async()=>{
  const db=new FictionalDatabase(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(session());
  let finish!:(value:string)=>void;
  const request=gate(signal=>{assert.equal(db.locked,true);assert.equal(signal.aborted,false);return new Promise<string>(resolve=>{finish=resolve;});});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(db.locked,false);assert.equal(db.commits,1);finish('fictional');assert.equal(await request,'fictional');await db.close();
});
test('each next launch rechecks active legal and consent; no request on missing/currently invalid version',async()=>{
  const db=new FictionalDatabase(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(session());let launches=0;
  const launch=async()=>++launches;assert.equal(await gate(launch),1);db.consented=false;await assert.rejects(gate(launch),isCode('TERMS_CONFIRMATION_REQUIRED'));db.consented=true;db.policyCurrent=false;await assert.rejects(gate(launch),isCode('LEGAL_DOCUMENTS_UNAVAILABLE'));assert.equal(launches,1);await db.close();
});
test('fixed session cannot be changed by a mutable caller and revoked session stops before launch',async()=>{
  const db=new FictionalDatabase(),input=session(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(input);input.userId='other';input.tokenHash='other';
  let launches=0;db.sessionValid=false;await assert.rejects(gate(async()=>++launches),isCode('AUTH_REQUIRED'));assert.equal(launches,0);await db.close();
});
test('real worker claim requires frozen auth version, generation and unexpired authorized lease',async()=>{
  const db=new FictionalDatabase();const gate=new ModelConsent(db,FICTIONAL_LEGAL).forJob({userId:'fictional',jobId:'fictional-job',generation:2,leaseToken:'fictional-lease',authVersion:'7'});let launches=0;
  await gate(async()=>++launches);db.authVersion='8';await assert.rejects(gate(async()=>++launches),isCode('AUTH_REQUIRED'));db.authVersion='7';db.jobValid=false;await assert.rejects(gate(async()=>++launches),isCode('JOB_CANCELLED'));assert.equal(launches,1);assert(db.statements.some(sql=>sql.includes('generation=$3')&&sql.includes('lease_until>clock_timestamp()')));await db.close();
});
test('failed commit after synchronous network launch aborts that request, without calling it confirmed',async()=>{
  const db=new FictionalDatabase();db.rejectCommit=true;const gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(session());let launchSignal:AbortSignal|undefined;
  await assert.rejects(gate(signal=>{launchSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}),/commit rejected/);assert.equal(launchSignal?.aborted,true);assert.equal(db.commits,0);await db.close();
});
test('parent and per-request cancellation both prevent later network launches',async()=>{
  for(const which of ['parent','request']){const db=new FictionalDatabase(),parent=new AbortController(),request=new AbortController();let launches=0;
    const gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(session(),parent.signal);(which==='parent'?parent:request).abort();await assert.rejects(gate(async()=>++launches,request.signal));assert.equal(launches,0);await db.close();}
});
test('actual runtime wrapper fails closed across every entry when admission is absent',async()=>{
  let calls=0;const runtime:PlatformProviderRuntime={capabilities:()=>[],async *streamChat(){calls++;yield {type:'delta',text:'fictional'};},async *streamModelStep(){calls++;return {text:'fictional',calls:[]};},async executeJob(){calls++;return {artifacts:[]};},async createVoiceSession(){calls++;return {clientSecret:'synthetic',model:'synthetic',endpoint:'https://example.invalid'};},async transcribe(){calls++;return {text:'synthetic'};},async speech(){calls++;return {name:'synthetic',mime:'text/plain',bytes:new Uint8Array()};}};
  const guarded=requireModelConsent(runtime);const drain=async(iterable:AsyncIterable<unknown>)=>{for await(const _ of iterable){}};
  await assert.rejects(drain(guarded.streamChat({provider:'synthetic',mode:'chat',messages:[]})),isCode('TERMS_CONFIRMATION_REQUIRED'));
  await assert.rejects(guarded.executeJob({kind:'image',provider:'synthetic',prompt:'synthetic'},{jobId:'synthetic',userId:'synthetic',workspaceDirectory:'/fictional'}),isCode('TERMS_CONFIRMATION_REQUIRED'));
  await assert.rejects(guarded.createVoiceSession(),isCode('TERMS_CONFIRMATION_REQUIRED'));await assert.rejects(guarded.transcribe({name:'synthetic',mime:'audio/wav',bytes:new Uint8Array()}),isCode('TERMS_CONFIRMATION_REQUIRED'));await assert.rejects(guarded.speech({text:'synthetic'}),isCode('TERMS_CONFIRMATION_REQUIRED'));
  await assert.rejects(drain(guarded.streamModelStep!({provider:'synthetic',mode:'chat',messages:[]},{tools:[],toolChoice:'none',limits:{maxOutputTokens:1},callIndex:1,timeoutMs:1,invocation:{}})),isCode('TERMS_CONFIRMATION_REQUIRED'));assert.equal(calls,0);
});

test('a late transport that ignores abort cannot return a response after captured request cancellation',async()=>{
  const db=new FictionalDatabase(),parent=new AbortController(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(session(),parent.signal);let finish!:(value:Response)=>void,cancelled=false;
  const pending=gate(()=>new Promise<Response>(resolve=>{finish=resolve;}));await new Promise(resolve=>setImmediate(resolve));parent.abort();finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));await assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);await db.close();
});
