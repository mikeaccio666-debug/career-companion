import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {ProductFeedbackController} from '../src/product-feedback-controller.ts';
import {feedbackAvailability,readFeedbackPage,readFeedback,submitFeedback,type FeedbackClient} from '../src/product-feedback-api.ts';
import {feedbackSurface} from '../src/product-feedback-presentation.ts';import {ApiError} from '../src/api-error.ts';
const owner=randomUUID(),recipient=randomUUID(),time='2026-10-09T12:00:00.000Z';
const availability={available:true,recipient:{id:recipient,name:'Fictional support'}};
const command=()=>({operationId:randomUUID(),recipientId:recipient,category:'incorrect',surface:'today',description:'Fictional report',sharedExcerpt:null,shareWithSupport:true});
function accepted(body:any,replayed=false,id=randomUUID()){
 const {operationId,recipientId,...fields}=body;
 return {feedback:{...fields,id,ownerId:owner,organizationId:recipientId,revision:1,lastOperationId:operationId,status:'submitted',triage:null,createdAt:time,updatedAt:time,updates:[]},
 operation:{id:operationId,appliedRevision:1,replayed}};
}
function harness(run:(p:string,i:RequestInit)=>unknown,timeout=30){
 let current=true;const listeners=new Set<()=>void>();
 const client:FeedbackClient={account:{accountId:owner},isCurrent:()=>current,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
 request:async(p,i={})=>await run(p,i) as any};
 return {client,controller:new ProductFeedbackController(client,()=>{},timeout),invalidate(){current=false;for(const fn of listeners)fn();}};
}
function initial(p:string){return p==='/feedback/availability'?availability:{records:[],nextCursor:null};}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>!!h.controller.snapshot().availability&&!h.controller.snapshot().busy);}
test('lost acknowledgement retains one submission; missing read-only observation never turns into an automatic write',async()=>{
 let stored:any,writes=0;const bodies:any[]=[];
 const h=harness((p,i)=>{if(p.includes('/operations/'))throw new ApiError('not found',404,'NOT_FOUND');if(!i.method)return initial(p);
  writes++;const body=JSON.parse(String(i.body));bodies.push(body);if(stored)return {...stored,operation:{...stored.operation,replayed:true}};stored=accepted(body);throw Error('lost response');});
 await ready(h);assert(h.controller.begin(command()));await until(()=>!h.controller.snapshot().busy&&!!h.controller.snapshot().pending);
 const pending=h.controller.snapshot().pending;assert(Object.isFrozen(pending));await h.controller.refresh();assert.equal(writes,1);assert.equal(h.controller.snapshot().pending,pending);
 assert.equal(h.controller.begin(command()),false);await h.controller.retry();assert.equal(writes,2);assert.deepEqual(bodies[0],bodies[1]);
 assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().selected?.id,stored.feedback.id);h.controller.stop();
});
test('suspend clears private records, preserves uncertain intent, and resume only observes; late response cannot replace staff progress',async()=>{
 let body:any,resolve!:(v:any)=>void,writes=0,record:any;
 const h=harness((p,i)=>{
  if(p.includes('/operations/'))return {feedback:{...record,revision:2,lastOperationId:randomUUID(),status:'in_review',triage:'quality',updates:[{revision:2,status:'in_review',triage:'quality',reply:'Fictional reply',at:time}]},operation:{id:body.operationId,appliedRevision:1,replayed:true}};
  if(!i.method)return initial(p);writes++;body=JSON.parse(String(i.body));record=accepted(body).feedback;return new Promise(r=>resolve=r);
 });
 await ready(h);h.controller.begin(command());await until(()=>!!body);h.controller.suspend();
 assert.equal(h.controller.snapshot().records,null);assert.equal(h.controller.snapshot().selected,null);assert.equal(h.controller.snapshot().availability,null);assert(h.controller.snapshot().pending);
 h.controller.resume();await until(()=>!h.controller.snapshot().busy&&!h.controller.snapshot().pending);
 assert.equal(writes,1);assert.equal(h.controller.snapshot().selected?.status,'in_review');
 resolve(accepted(body));await new Promise(r=>setTimeout(r,3));assert.equal(h.controller.snapshot().selected?.status,'in_review');h.controller.stop();
});
test('account invalidation cancels reads and removes pending private content without sending another request',async()=>{
 const h=harness((p,i)=>i.method?new Promise(()=>{}):initial(p));await ready(h);h.controller.begin(command());await until(()=>!h.controller.snapshot().busy&&!!h.controller.snapshot().error);
 assert(h.controller.snapshot().pending);h.invalidate();assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().availability,null);assert.equal(h.controller.snapshot().records,null);
 await h.controller.retry();assert.equal(h.controller.snapshot().pending,null);
});
test('recipient changes require a fresh read and explicit user action; unavailable routing prevents submission',async()=>{
 let writes=0;const h=harness((p,i)=>{if(!i.method)return initial(p);writes++;throw new ApiError('changed',409,'FEEDBACK_RECIPIENT_CHANGED');});
 await ready(h);assert.equal(h.controller.begin({...command(),recipientId:randomUUID()}),false);assert.equal(writes,0);
 h.controller.begin(command());await until(()=>!h.controller.snapshot().busy);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().availability,null);
 assert.equal(h.controller.begin(command()),false);assert.equal(writes,1);h.controller.stop();
 const disabled=harness(p=>p.endsWith('/availability')?{available:false,recipient:null}:{records:[],nextCursor:null});await ready(disabled);
 assert.equal(disabled.controller.begin(command()),false);disabled.controller.stop();
});
test('availability and owner pages reject malformed recipients, other owners, duplicate rows, unsorted pages and forged cursors',async()=>{
 for(const bad of [{available:true,recipient:null},{available:false,recipient:availability.recipient},{available:true,recipient:{id:recipient,name:''}},{...availability,internalKey:'secret'}])
  await assert.rejects(feedbackAvailability(harness(()=>bad).client));
 const p=accepted(command()).feedback;
 for(const bad of [{records:[{...p,ownerId:randomUUID()}],nextCursor:null},{records:[p,p],nextCursor:null},{records:[p],nextCursor:p.id},{records:[],nextCursor:randomUUID()}])
  await assert.rejects(readFeedbackPage(harness(()=>bad).client));
 await assert.rejects(readFeedback(harness(()=>({...p,id:randomUUID()})).client,p.id));
});
test('receipts must match submitted text, explicit recipient, operation and owner, even for read-only observation',async()=>{
 const body=command(),ok=accepted(body,true);
 for(const bad of [{...ok,feedback:{...ok.feedback,description:'Wrong content'}},{...ok,feedback:{...ok.feedback,organizationId:randomUUID()}},
 {...ok,feedback:{...ok.feedback,ownerId:randomUUID()}},{...ok,operation:{...ok.operation,id:randomUUID()}},{...ok,operation:{...ok.operation,appliedRevision:2}}])
  await assert.rejects(submitFeedback(harness(()=>bad).client,body));
 let calls=0;const stale=harness(()=>{calls++;return ok;});stale.invalidate();await assert.rejects(submitFeedback(stale.client,body));assert.equal(calls,0);
 const abort=new AbortController();abort.abort();await assert.rejects(readFeedbackPage(harness(()=>{calls++;return {records:[],nextCursor:null};}).client,null,abort.signal));assert.equal(calls,0);
 const read=harness((_p,i)=>{assert.equal(i.method,undefined);assert.equal(i.body,undefined);return ok;});assert.equal((await submitFeedback(read.client,body,undefined,true)).feedback.description,body.description);
 await assert.rejects(submitFeedback(harness(()=>accepted(body,false)).client,body,undefined,true));
});
test('list pagination appends current validated records and suspension prevents background fetches',async()=>{
 const records=Array.from({length:51},()=>accepted(command()).feedback).sort((a,b)=>a.id.localeCompare(b.id));let calls=0;
 const h=harness(p=>{calls++;if(p.endsWith('/availability'))return availability;return p.includes('?after=')?{records:records.slice(50),nextCursor:null}:{records:records.slice(0,50),nextCursor:records[49].id};});
 await ready(h);await h.controller.more();assert.equal(h.controller.snapshot().records?.length,51);assert.equal(h.controller.snapshot().nextCursor,null);
 h.controller.suspend();const count=calls;await h.controller.more();await h.controller.refresh();assert.equal(calls,count);assert.equal(h.controller.snapshot().records,null);h.controller.stop();
});
test('raw URL and query data never enter the fixed page category',()=>{
 assert.equal(feedbackSurface('/journey/private-id?email=private#fragment'),'journey');assert.equal(feedbackSurface('/welcome'),'onboarding');
 assert.equal(feedbackSurface('/me/private-file.pdf'),'me');assert.equal(feedbackSurface('/unrecognized?secret=true'),'other');
});
