import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';
import {StaffFeedbackController} from '../src/staff-feedback-controller.ts';
import {readStaffFeedbackPage,readStaffFeedback,updateStaffFeedback,isStaffFeedbackPath} from '../src/staff-feedback-api.ts';
import type {FeedbackClient} from '../src/product-feedback-api.ts';import {ApiError} from '../src/api-error.ts';
const actor=randomUUID(),owner=randomUUID(),org=randomUUID(),id=randomUUID(),time='2026-10-09T12:00:00.000Z';
const original={id,ownerId:owner,organizationId:org,revision:1,lastOperationId:randomUUID(),category:'other',surface:'today',description:'Fictional student feedback',sharedExcerpt:null,shareWithSupport:true,status:'submitted',triage:null,createdAt:time,updatedAt:time,updates:[]};
const command=()=>({operationId:randomUUID(),expectedRevision:1,status:'resolved',triage:'defect',reply:'Fictional issue corrected.'});
const wrap=(v:any)=>({actorId:actor,organizationId:org,...v});
function accepted(body:any,replayed=false){return wrap({feedback:{...original,revision:2,lastOperationId:body.operationId,status:body.status,triage:body.triage,updates:[{revision:2,status:body.status,triage:body.triage,reply:body.reply,at:time}]},operation:{id:body.operationId,appliedRevision:2,replayed}});}
function initial(path:string){return path.includes('?')||path==='/staff/feedback'?wrap({records:[original],nextCursor:null}):wrap({feedback:original});}
function harness(run:(p:string,i:RequestInit)=>unknown,timeout=50){
 let current=true;const listeners=new Set<()=>void>();
 const client:FeedbackClient={account:{accountId:actor},isCurrent:()=>current,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},request:async(p,i={})=>await run(p,i) as any};
 return {client,controller:new StaffFeedbackController(client,()=>{},timeout),invalidate(){current=false;for(const fn of listeners)fn();}};
}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>!!h.controller.snapshot().records&&!h.controller.snapshot().busy);await h.controller.select(id);assert(h.controller.snapshot().selected);}
test('lost staff acknowledgement observes the same operation without repeating PATCH, explicit retry keeps the exact body',async()=>{
 let stored:any,writes=0;const bodies:any[]=[];
 const h=harness((p,i)=>{if(p.includes('/operations/'))throw new ApiError('missing',404,'NOT_FOUND');if(!i.method)return initial(p);
  writes++;const b=JSON.parse(String(i.body));bodies.push(b);if(stored)return {...stored,operation:{...stored.operation,replayed:true}};stored=accepted(b);throw Error('lost ack');});
 await ready(h);assert(h.controller.begin(command()));await until(()=>!h.controller.snapshot().busy);
 assert(h.controller.snapshot().pending);await h.controller.refresh();assert.equal(writes,1);assert.equal(h.controller.begin(command()),false);
 await h.controller.retry();assert.equal(writes,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().selected?.status,'resolved');h.controller.stop();
});
test('suspend hides records, resume only observes and late mutation completion cannot roll back the observed record',async()=>{
 let body:any,resolve!:(v:any)=>void,writes=0;
 const h=harness((p,i)=>{if(p.includes('/operations/'))return accepted(body,true);if(!i.method)return initial(p);writes++;body=JSON.parse(String(i.body));return new Promise(r=>resolve=r);});
 await ready(h);h.controller.begin(command());await until(()=>!!body);h.controller.suspend();assert.equal(h.controller.snapshot().records,null);assert.equal(h.controller.snapshot().selected,null);assert(h.controller.snapshot().pending);
 h.controller.resume();await until(()=>!h.controller.snapshot().pending);assert.equal(writes,1);assert.equal(h.controller.snapshot().selected?.revision,2);
 resolve(wrap({feedback:original}));await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().selected?.revision,2);h.controller.stop();
});
test('revision conflict requires a fresh detail and explicit new decision; account invalidation erases pending private content',async()=>{
 let writes=0;const h=harness((p,i)=>{if(!i.method)return initial(p);writes++;throw new ApiError('conflict',409,'FEEDBACK_CHANGED');});
 await ready(h);h.controller.begin(command());await until(()=>!h.controller.snapshot().busy);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().selected,null);
 assert.equal(h.controller.begin(command()),false);await h.controller.retry();assert.equal(writes,1);await h.controller.refresh();assert(h.controller.snapshot().selected);h.controller.stop();
 const unknown=harness((p,i)=>i.method?new Promise(()=>{}):initial(p));await ready(unknown);unknown.controller.begin(command());unknown.invalidate();
 assert.equal(unknown.controller.snapshot().pending,null);assert.equal(unknown.controller.snapshot().selected,null);await unknown.controller.retry();
});
test('staff envelopes bind actor, organization, requested id, sorting, status and cursor',async()=>{
 for(const bad of [wrap({records:[original,original],nextCursor:null}),wrap({records:[original],nextCursor:id}),{...wrap({records:[original],nextCursor:null}),actorId:owner},wrap({records:[{...original,organizationId:randomUUID()}],nextCursor:null})])
  await assert.rejects(readStaffFeedbackPage(harness(()=>bad).client,'submitted'));
 await assert.rejects(readStaffFeedbackPage(harness(()=>wrap({records:[original],nextCursor:null})).client,'resolved'));
 await assert.rejects(readStaffFeedback(harness(()=>wrap({feedback:{...original,id:randomUUID()}})).client,id));
});
test('observed receipts must belong to the original actor, operation, organization, revision and exact reply',async()=>{
 const body=command(),ok=accepted(body,true);
 for(const bad of [{...ok,actorId:owner},{...ok,organizationId:randomUUID()},{...ok,operation:{...ok.operation,id:randomUUID()}},{...ok,operation:{...ok.operation,appliedRevision:3}},{...ok,feedback:{...ok.feedback,updates:[{...ok.feedback.updates[0],reply:'Wrong reply'}]}}])
  await assert.rejects(updateStaffFeedback(harness(()=>bad).client,id,org,body,undefined,true));
 await assert.rejects(updateStaffFeedback(harness(()=>accepted(body,false)).client,id,org,body,undefined,true));
 const h=harness((_p,i)=>{assert.equal(i.method,undefined);assert.equal(i.body,undefined);return ok;});assert.equal((await updateStaffFeedback(h.client,id,org,body,undefined,true)).revision,2);
});
test('revocation removes previously visible records, hidden views do not read and stale accounts do not send writes',async()=>{
 let denied=false,calls=0;const h=harness((p)=>{calls++;if(denied)throw new ApiError('denied',403,'STAFF_ROLE_REQUIRED');return initial(p);});
 await ready(h);denied=true;await h.controller.refresh();assert.equal(h.controller.snapshot().records,null);assert.equal(h.controller.snapshot().selected,null);assert.match(h.controller.snapshot().error,/权限/);
 h.controller.suspend();const count=calls;await h.controller.refresh();assert.equal(calls,count);h.invalidate();await assert.rejects(updateStaffFeedback(h.client,id,org,command()));assert.equal(calls,count);
});
test('exact staff route keeps email gate and server authorization while preserving all student gates',()=>{
 assert(isStaffFeedbackPath('/staff/feedback'));for(const p of ['/staff','/staff/feedback/','/staff/feedback/evil','/welcome'])assert(!isStaffFeedbackPath(p));
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),gate=app.indexOf('if (!accountReady) return'),staff=app.indexOf('if (staffFeedbackRoute) return null'),consent=app.indexOf('if (!consentCurrent) return'),letter=app.indexOf('if (!privateAllowed) return');
 assert(gate<staff&&staff<consent&&consent<letter);assert(app.includes('const privateAllowed = false;'));
 assert(app.includes('initialLogin={staffFeedbackRoute ||'));assert(app.includes('!accountReady || staffFeedbackRoute'));
});
