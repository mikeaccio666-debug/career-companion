import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MENTOR_INTENT_PRIVACY_VERSION,parseMentorRatingCommand } from '@companion/platform-contracts';
import { MentorRatingScope } from '../src/mentor-rating-scope.ts';
import { readMentorRating,changeMentorRating } from '../src/mentor-rating-api.ts';
import type { MentorControllerClient } from '../src/mentor-intent-controller.ts';
import { ApiError } from '../src/api-error.ts';
const owner=randomUUID(),id=randomUUID(),org=randomUUID(),offer=randomUUID();
const session={id,ownerId:owner,organizationId:org,offerId:offer,offerRevision:1,kind:'resume_direction',durationMin:45,contactName:'Fictional',contactEmail:'fictional@example.invalid',
 intentNote:'Fictional private demand',status:'completed',orderId:randomUUID(),mentorId:randomUUID(),privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,visibilityConfirmedAt:'2026-10-01T10:00:00.000Z',
 revision:4,createdAt:'2026-10-01T10:00:00.000Z',updatedAt:'2026-10-01T12:00:00.000Z',lastOperationId:randomUUID(),
 assignment:{mentorDisplayName:'Fictional mentor',slotId:randomUUID(),slotRevision:1,profileId:randomUUID(),profileRevision:1,startsAt:'2026-10-01T11:00:00.000Z',endsAt:'2026-10-01T11:45:00.000Z',timeZone:'America/New_York',matchedAt:'2026-10-01T10:10:00.000Z'},
 scheduled:{confirmedAt:'2026-10-01T10:20:00.000Z',meetingUrl:'https://meet.google.com/fictional'},completedAt:'2026-10-01T11:45:00.000Z'};
function saved(cmd:any,replayed=false){return {session,rating:{sessionId:id,ownerId:owner,operationId:cmd.operationId,action:cmd.action,score:cmd.action==='rate'?cmd.score:null,comment:cmd.action==='rate'?cmd.comment:null,createdAt:'2026-10-01T13:00:00.000Z'},operation:{id:cmd.operationId,replayed}};}
async function until(f:()=>boolean){for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,2));}assert(f());}

function harness(run:(p:string,i:RequestInit)=>unknown){
 let active=true;const listeners=new Set<()=>void>();
 const client:MentorControllerClient={account:{accountId:owner},isCurrent:()=>active,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async(p,i={})=>await run(p,i) as any};
 const scope=new MentorRatingScope(client,40);
 return {scope,invalid(){active=false;for(const fn of [...listeners])fn();}};
}
const cmd=()=>parseMentorRatingCommand({operationId:randomUUID(),action:'rate',score:4,comment:'Fictional private feedback.'});
test('card disappearance while a write is in flight preserves the original operation and unload protection across offline resume',async()=>{
 let receipt:any,posts=0,resolve!:(v:unknown)=>void;
 const h=harness((path,init)=>{
  if(path.includes('/operations/'))return {...receipt,operation:{...receipt.operation,replayed:true}};
  if(!init.method)return{session,rating:null};posts++;receipt=saved(JSON.parse(String(init.body)));return new Promise(r=>{resolve=r;});
 });
 const release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
 const input=cmd();h.scope.controller(id)!.begin(input);assert.equal(h.scope.snapshot().length,1);
 release();h.scope.suspend();assert.equal(h.scope.snapshot()[0].state.pending?.operationId,input.operationId);
 assert.equal(h.scope.snapshot()[0].state.rating,null);assert(h.scope.snapshot()[0].state.suspended);
 resolve(receipt);h.scope.resume();await until(()=>!h.scope.snapshot()[0].state.busy);
 assert.equal(posts,1);assert.equal(h.scope.snapshot()[0].state.pending?.operationId,input.operationId);
 let observed:any;const releaseAgain=h.scope.attach(id,s=>observed=s);
 assert.equal(observed.pending.operationId,input.operationId);await h.scope.controller(id)!.observe();
 assert.equal(observed.rating.score,4);assert.equal(h.scope.snapshot().length,0);assert.equal(posts,1);
 releaseAgain();assert.equal(h.scope.controller(id),null);h.scope.stop();
});
test('missing or failed parent list cannot discard an uncertain submission; recovery works without remounting the card',async()=>{
 let receipt:any,posts=0,reads=0;
 const h=harness((path,init)=>{if(path.includes('/operations/'))return{...receipt,operation:{...receipt.operation,replayed:true}};
  if(!init.method){reads++;return{session,rating:receipt?.rating??null};}posts++;receipt=saved(JSON.parse(String(init.body)));throw Error('Lost response');});
 const release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
 h.scope.controller(id)!.begin(cmd());await until(()=>!!h.scope.snapshot()[0]?.state.uncertain);release();
 h.scope.suspend();h.scope.resume();await until(()=>!!h.scope.snapshot()[0]?.state.loaded);
 assert(h.scope.snapshot()[0].state.rating);assert(h.scope.snapshot()[0].state.pending);assert.equal(posts,1);
 await h.scope.controller(id)!.observe();assert.equal(h.scope.snapshot().length,0);assert.equal(h.scope.controller(id),null);assert.equal(posts,1);assert(reads>=2);h.scope.stop();
});
test('observer failure retains recovery, explicit retry uses precisely the same operation, and no second decision is accepted',async()=>{
 let receipt:any,effects=0;const ids:string[]=[];
 const h=harness((path,init)=>{if(path.includes('/operations/'))throw new ApiError('Not visible',404,'NOT_FOUND');
  if(!init.method)return{session,rating:null};const body=JSON.parse(String(init.body));ids.push(body.operationId);
  if(receipt)return{...receipt,operation:{...receipt.operation,replayed:true}};effects++;receipt=saved(body);throw Error('Lost reply');});
 const release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
 const input=cmd();h.scope.controller(id)!.begin(input);await until(()=>!!h.scope.snapshot()[0]?.state.uncertain);release();
 await h.scope.controller(id)!.observe();h.scope.controller(id)!.begin(cmd());assert.equal(ids.length,1);
 await h.scope.controller(id)!.retry();assert.deepEqual(ids,[input.operationId,input.operationId]);assert.equal(effects,1);assert.equal(h.scope.snapshot().length,0);h.scope.stop();
});
test('unmounting a read-only card discards its data; strict setup-cleanup-setup reattaches a fresh controller',async()=>{
 let reads=0;const h=harness(()=>{reads++;return{session,rating:null};});
 let release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
 const old=h.scope.controller(id);release();assert.equal(h.scope.controller(id),null);h.scope.stop();
 release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
 assert.notEqual(h.scope.controller(id),old);assert.equal(reads,2);release();h.scope.stop();
});
test('scope created or mounted while offline performs no read until actual resume',async()=>{
 let reads=0;const h=harness(()=>{reads++;return{session,rating:null};});h.scope.start(true);
 const release=h.scope.attach(id,()=>{});assert(h.scope.controller(id)?.snapshot().suspended);assert.equal(reads,0);
 h.scope.resume();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);assert.equal(reads,1);release();h.scope.stop();
});
test('account invalidation or leaving the page clears every pending command and ignores late writes',async()=>{
 for(const invalidate of [true,false]){
  let resolve!:(v:unknown)=>void,receipt:any;
  const h=harness((_path,init)=>{if(!init.method)return{session,rating:null};receipt=saved(JSON.parse(String(init.body)));return new Promise(r=>{resolve=r;});});
  const release=h.scope.attach(id,()=>{});h.scope.start();await until(()=>!!h.scope.controller(id)?.snapshot().loaded);
  h.scope.controller(id)!.begin(cmd());release();assert.equal(h.scope.snapshot().length,1);
  if(invalidate)h.invalid();else h.scope.stop();resolve(receipt);await new Promise(r=>setTimeout(r,2));
  assert.equal(h.scope.snapshot().length,0);assert.equal(h.scope.controller(id),null);
 }
});
