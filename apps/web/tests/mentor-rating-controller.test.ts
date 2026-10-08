import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MENTOR_INTENT_PRIVACY_VERSION,parseMentorRatingCommand } from '@companion/platform-contracts';
import { MentorRatingController } from '../src/mentor-rating-controller.ts';
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
function harness(run:(p:string,i:RequestInit)=>unknown){let active=true;const listeners=new Set<()=>void>();const client:MentorControllerClient={account:{accountId:owner},isCurrent:()=>active,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async(p,i={})=>await run(p,i) as any};
 return {client,controller:new MentorRatingController(client,id,()=>{},40),invalidate(){active=false;for(const fn of [...listeners])fn();}};}
async function until(f:()=>boolean){for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,2));}assert(f());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>h.controller.snapshot().loaded&&!h.controller.snapshot().busy);}
const cmd=()=>parseMentorRatingCommand({operationId:randomUUID(),action:'rate',score:4,comment:'Fictional private feedback.'});
test('lost acknowledgement keeps frozen feedback and nonce; observing 404 or merely refreshing cannot release it; exact retry has one effect',async()=>{
 let receipt:any,effects=0;const nonces:string[]=[];const h=harness((p,i)=>{
  if(p.includes('/operations/'))throw new ApiError('Not yet visible',404,'NOT_FOUND');
  if(!i.method)return {session,rating:receipt?.rating??null};const body=JSON.parse(String(i.body));nonces.push(body.operationId);
  if(receipt)return {...receipt,operation:{...receipt.operation,replayed:true}};effects++;receipt=saved(body);throw Error('Lost acknowledgement');});
 await ready(h);const input=cmd();h.controller.begin(input);await until(()=>h.controller.snapshot().uncertain);await h.controller.observe();assert(h.controller.snapshot().pending);
 await h.controller.refresh();assert(h.controller.snapshot().pending);h.controller.begin(cmd());assert.equal(nonces.length,1);
 await h.controller.retry();assert.equal(effects,1);assert.deepEqual(nonces,[input.operationId,input.operationId]);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().rating?.score,4);h.controller.stop();
});
test('pending feedback is bounded; late response, suspend/resume and logout cannot publish private data or automatically submit it again',async()=>{
 let resolve!:(v:unknown)=>void,receipt:any,posts=0;const h=harness((p,i)=>{
  if(p.includes('/operations/'))return {...receipt,operation:{...receipt.operation,replayed:true}};if(!i.method)return {session,rating:null};posts++;receipt=saved(JSON.parse(String(i.body)));return new Promise(r=>{resolve=r;});});
 await ready(h);h.controller.begin(cmd());await until(()=>h.controller.snapshot().uncertain);resolve(receipt);await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().rating,null);
 h.controller.suspend();assert.equal(h.controller.snapshot().loaded,false);assert.equal(h.controller.snapshot().rating,null);h.controller.resume();await until(()=>h.controller.snapshot().loaded);assert.equal(posts,1);assert(h.controller.snapshot().pending);
 await h.controller.observe();assert.equal(h.controller.snapshot().rating?.score,4);h.invalidate();assert.equal(h.controller.snapshot().rating,null);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().loaded,false);
});
test('actual stored skip/rating never sends a new decision on revisit, while failed reads conceal old feedback',async()=>{
 const receipt=saved({operationId:randomUUID(),action:'skip'});let posts=0,fail=false;const h=harness((_p,i)=>{if(i.method)posts++;if(fail)throw Error('Read unavailable');return {session,rating:receipt.rating};});
 await ready(h);h.controller.begin(cmd());assert.equal(posts,0);assert.equal(h.controller.snapshot().rating?.action,'skip');fail=true;await h.controller.refresh();assert.equal(h.controller.snapshot().rating,null);assert(!h.controller.snapshot().loaded);h.controller.stop();
});
test('feedback client rejects foreign owner, incorrect phase, swapped operation/score/comment and stale account rebinding',async()=>{
 const input=cmd(),receipt=saved(input);const h=harness(()=>receipt);assert.equal((await changeMentorRating(h.client,id,input)).rating?.score,4);
 for(const value of [{...receipt,session:{...session,ownerId:randomUUID()}},{...receipt,session:{...session,status:'scheduled',revision:3,completedAt:undefined}},
  {...receipt,rating:{...receipt.rating,score:5}},{...receipt,rating:{...receipt.rating,comment:'Substituted'}},{...receipt,operation:{...receipt.operation,id:randomUUID()}}]){
  const c=harness(()=>value);await assert.rejects(changeMentorRating(c.client,id,input));}
 const mutable={accountId:owner},client={account:mutable,isCurrent:()=>true,request:async()=>{mutable.accountId=randomUUID();return {session,rating:null};}};await assert.rejects(readMentorRating(client,id));
});
