import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseFeedbackSubmission,parseFeedbackUpdate,parseProductFeedback,parseProductEvent} from '@companion/platform-contracts';
import {ProductFeedbackService} from '../src/product-feedback.ts';
import {hashPassword} from '../src/auth.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {readConfig} from '../src/config.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {readAccountSchemaInventory,accountTableFingerprint} from '../src/account-data-coverage.ts';
import {ACCOUNT_DATA_SCHEMA} from '../src/account-data-schema.ts';
import type {Database} from '../src/database.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
before(async()=>{f=await createCompanionNameSafetyFixture();});after(async()=>{await f?.close();});
let recipientId=randomUUID();
const submit=()=>({operationId:randomUUID(),recipientId,category:'incorrect',surface:'conversation',description:'FICTIONAL_PRIVATE_REPORT',sharedExcerpt:null,shareWithSupport:true});
const update=(expectedRevision=1)=>({operationId:randomUUID(),expectedRevision,status:'in_review',triage:'quality',reply:'FICTIONAL_PRIVATE_REPLY'});
async function setup(){
 const owner=await f.actor(),other=await f.actor(),authority=await f.identityAuthority();
 recipientId=authority.orgId;
 const config={...f.config,supportOrganizationId:authority.orgId,productEventsEnabled:true};
 return {owner,other,authority,config,service:new ProductFeedbackService(f.db,config)};
}
test('submission requires explicit sharing and rejects owner, transcript IDs, URLs, unknown properties and invalid sizes',()=>{
 const body=submit();assert.equal(parseFeedbackSubmission(body).sharedExcerpt,null);
 for(const x of [{...body,shareWithSupport:false},{...body,ownerId:randomUUID()},{...body,conversationId:randomUUID()},
 {...body,surface:'https://example.invalid/private?q=secret'},{...body,description:' '},{...body,description:'x'.repeat(4001)},{...body,sharedExcerpt:'x'.repeat(12001)},{...body,sharedExcerpt:''}])assert.throws(()=>parseFeedbackSubmission(x));
 let touched=false;const getter={...body};Object.defineProperty(getter,'description',{enumerable:true,get(){touched=true;return 'secret';}});
 assert.throws(()=>parseFeedbackSubmission(getter));assert.equal(touched,false);
 const parsed=parseFeedbackSubmission({...body,sharedExcerpt:'Voluntarily pasted fictional fragment'});assert(Object.isFrozen(parsed));
 assert.throws(()=>parseFeedbackUpdate({...update(),status:'resolved',reply:' '}));
 assert.throws(()=>parseFeedbackUpdate({...update(),expectedRevision:0}));
 assert.throws(()=>parseProductEvent({event:'feedback_submitted',props:{category:'incorrect',description:'private'}}));
});
test('support routing is server configured, not inherited from a mentor organization',async()=>{
 const {owner,authority,config}=await setup();
 assert.equal(readConfig({}).supportOrganizationId,undefined);
 assert.equal(readConfig({PLATFORM_SUPPORT_ORG_ID:authority.orgId}).supportOrganizationId,authority.orgId);
 assert.throws(()=>readConfig({PLATFORM_SUPPORT_ORG_ID:'bad'}));
 await assert.rejects(new ProductFeedbackService(f.db,f.config).submit(owner,submit()),{code:'FEEDBACK_UNAVAILABLE'});
 await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND role='ops'",[authority.orgId]);
 await assert.rejects(new ProductFeedbackService(f.db,config).submit(owner,submit()),{code:'FEEDBACK_UNAVAILABLE'});
 assert.equal((await f.db.query('SELECT * FROM platform_product_feedback WHERE user_id=$1',[owner.userId])).rowCount,0);
});
test('a real persisted submission replays once, records only an enum event and remains private to its owner',async()=>{
 const {owner,other,service}=await setup(),body={...submit(),sharedExcerpt:'FICTIONAL_PRIVATE_EXCERPT'};
 const result=await Promise.all([service.submit(owner,body),service.submit(owner,body)]);
 assert.equal(result.filter(v=>v.operation.replayed).length,1);const p=result[0].feedback;
 assert.equal((await service.list(owner)).records.length,1);assert.equal((await service.list(other)).records.length,0);
 assert.equal((await service.get(owner,p.id)).sharedExcerpt,body.sharedExcerpt);
 await assert.rejects(service.get(other,p.id),{code:'NOT_FOUND'});
 await assert.rejects(service.submit(owner,{...body,description:'changed'}),{code:'FEEDBACK_CHANGED'});
 const rows=(await f.db.query('SELECT * FROM platform_product_feedback WHERE user_id=$1',[owner.userId])).rows;
 assert(!JSON.stringify(rows).includes('FICTIONAL_PRIVATE'));
 const events=(await f.db.query('SELECT event,props FROM platform_product_events WHERE user_id=$1',[owner.userId])).rows;
 assert.deepEqual(events,[{event:'feedback_submitted',props:{category:'incorrect'}}]);
});
test('only configured organization ops can read and update; audits contain no feedback bodies',async()=>{
 const {owner,other,authority,service}=await setup(),p=(await service.submit(owner,submit())).feedback;
 for(const actor of [owner,other,authority.reviewer])await assert.rejects(service.inbox(actor),{code:'STAFF_ROLE_REQUIRED'});
 const foreign=await f.identityAuthority();await assert.rejects(service.inbox(foreign.operator),{code:'STAFF_ROLE_REQUIRED'});
 const inbox=await service.inbox(authority.operator);assert.equal(inbox.records[0].id,p.id);
 const b=update(),r=await service.update(authority.operator,p.id,b);
 assert.equal(r.feedback.status,'in_review');assert.equal(r.feedback.updates.length,1);
 assert.equal((await service.update(authority.operator,p.id,b)).operation.replayed,true);
 const resolved=await service.update(authority.operator,p.id,{...update(2),status:'resolved',reply:'A fictional issue was corrected.'});
 assert.equal((await service.get(owner,p.id)).updates.length,2);
 assert.equal(resolved.feedback.status,'resolved');
 await assert.rejects(service.update(authority.operator,p.id,update(1)),{code:'FEEDBACK_CHANGED'});
 const audit=(await f.db.query("SELECT * FROM platform_staff_audit WHERE org_id=$1 AND action LIKE 'product_feedback_%'",[authority.orgId])).rows;
 assert(audit.some(r=>r.outcome==='deny'));assert(audit.some(r=>r.action==='product_feedback_updated'&&r.outcome==='allow'));assert(!JSON.stringify(audit).includes('FICTIONAL_PRIVATE'));
 assert.equal((await service.inbox(authority.operator,null,'submitted')).records.length,0);
 await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2",[authority.orgId,authority.operator.userId]);
 await assert.rejects(service.inbox(authority.operator),{code:'STAFF_ROLE_REQUIRED'});
 await assert.rejects(service.update(authority.operator,p.id,update(3)),{code:'STAFF_ROLE_REQUIRED'});
});
test('student cannot update status, inactive organizations reject and foreign feedback remains inaccessible',async()=>{
 const a=await setup(),b=await setup(),p=(await a.service.submit(a.owner,{...submit(),recipientId:a.authority.orgId})).feedback;
 await assert.rejects(a.service.update(a.owner,p.id,update()),{code:'STAFF_ROLE_REQUIRED'});
 await assert.rejects(b.service.update(b.authority.operator,p.id,update()),{code:'NOT_FOUND'});
 await f.db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1",[a.authority.orgId]);
 await assert.rejects(a.service.submit(a.owner,{...submit(),recipientId:a.authority.orgId}),{code:'FEEDBACK_UNAVAILABLE'});
 await assert.rejects(a.service.inbox(a.authority.operator),{code:'STAFF_ROLE_REQUIRED'});
 assert.equal((await a.service.get(a.owner,p.id)).id,p.id);
});
test('ciphertext swap, status rollback and missing receipts fail closed',async()=>{
 const {owner,service}=await setup(),a=(await service.submit(owner,submit())).feedback,b=(await service.submit(owner,submit())).feedback;
 const rollback=new Error('fixture rollback');
 for(const run of [
  async(c:any)=>c.query('UPDATE platform_product_feedback SET record_ciphertext=(SELECT record_ciphertext FROM platform_product_feedback WHERE id=$2) WHERE id=$1',[a.id,b.id]),
  async(c:any)=>c.query("UPDATE platform_product_feedback SET status='resolved' WHERE id=$1",[a.id]),
  async(c:any)=>c.query('DELETE FROM platform_product_feedback_operations WHERE feedback_id=$1',[a.id])
 ]){
  await assert.rejects(f.db.transaction(async c=>{
   await run(c);
   const proxy=new Proxy(f.db,{get(t,k){if(k==='withBoundedTransaction')return (fn:any)=>fn(c);return Reflect.get(t,k);}}) as Database;
   await assert.rejects(new ProductFeedbackService(proxy,f.config).get(owner,a.id),{code:'FEEDBACK_UNAVAILABLE'});throw rollback;
  }),e=>e===rollback);
 }
});
test('expired sessions and cancellation cannot create a report',async()=>{
 const {owner,service}=await setup(),abort=new AbortController();abort.abort();
 await assert.rejects(service.submit(owner,submit(),abort.signal));
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[owner.userId]);
 await assert.rejects(service.submit(owner,submit()),{code:'AUTH_REQUIRED'});
 assert.equal((await f.db.query('SELECT * FROM platform_product_feedback WHERE user_id=$1',[owner.userId])).rowCount,0);
});
test('export emits decoded owner data and sanitized receipts; account deletion removes reports and operations',async()=>{
 const {owner,other,service}=await setup(),p=(await service.submit(owner,submit())).feedback;
 const exported=await f.db.withBoundedTransaction(async c=>{const out=[];for await(const row of service.exportInTransaction(c,owner))out.push(row);return out;});
 assert.deepEqual(exported.map(x=>x.section),['productFeedback','productFeedbackOperations']);
 assert.equal((exported[0].record as any).id,p.id);
 assert(!JSON.stringify(exported).includes('commandDigest'));assert(!JSON.stringify(exported).includes('record_ciphertext'));
 const foreign=await f.db.withBoundedTransaction(async c=>{const out=[];for await(const row of service.exportInTransaction(c,other))out.push(row);return out;});assert.deepEqual(foreign,[]);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[owner.userId]);
 for(const table of ['platform_product_feedback','platform_product_feedback_operations','platform_product_events'])assert.equal((await f.db.query('SELECT 1 FROM '+table+' WHERE user_id=$1',[owner.userId])).rowCount,0);
});
test('schema metadata for owner projection review',async()=>{
 const inv=await readAccountSchemaInventory(f.db);
 for(const table of ['platform_product_feedback','platform_product_feedback_operations'])assert.equal(accountTableFingerprint(inv,table),ACCOUNT_DATA_SCHEMA.find(r=>r.table===table)?.fingerprint);
});

test('pagination crosses the first page without duplicates, and internal archive contains all owner feedback',async()=>{
 const {owner,authority,service}=await setup();
 for(let i=0;i<52;i++)await service.submit(owner,{...submit(),description:'Fictional numbered report '+i});
 const first=await service.list(owner);assert.equal(first.records.length,50);assert(first.nextCursor);
 const second=await service.list(owner,first.nextCursor);assert.equal(second.records.length,2);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.records,...second.records].map(r=>r.id)).size,52);
 await service.update(authority.operator,first.records[0].id,update());
 await service.staffGet(authority.operator,first.records[0].id);
 const password='Fictional-feedback-export-123';await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[owner.userId,await hashPassword(password)]);
 const token=(await new AccountReauthentication(f.db).verify(owner,{purpose:'account_export',password})).token;
 const archive=await new AccountCoreExport(f.db,f.config).capture(owner,token);
 assert.equal(archive.sections.productFeedback.length,52);assert.equal(archive.sections.productFeedbackOperations.length,53);
 assert(archive.sections.organizationAccessEvents.some((r:any)=>r.relation==='product_feedback'&&r.action==='product_feedback_updated'));
 assert(archive.sections.organizationAccessEvents.some((r:any)=>r.relation==='product_feedback'&&r.action==='product_feedback_viewed'));
 assert(!JSON.stringify(archive.sections.organizationAccessEvents).includes(authority.operator.userId));
 assert.equal(archive.complete,false);assert(archive.includedTables.includes('platform_product_feedback'));
 assert(archive.includedTables.includes('platform_product_feedback_operations'));
 assert(!JSON.stringify(archive.sections.productFeedbackOperations).includes('commandDigest'));
});
test('expiry after persistence rolls back report, receipt and telemetry together',async()=>{
 const {owner,config,service}=await setup();let injected=false;
 const db=new Proxy(f.db,{get(target,key){
  if(key==='withBoundedTransaction')return (fn:any)=>target.withBoundedTransaction(async c=>{
   const intercepted=new Proxy(c,{get(client,k){
    if(k==='query')return async(sql:string,values:any[])=>{
     const result=await client.query(sql,values);
     if(!injected&&sql.startsWith('INSERT INTO platform_product_feedback_operations')){
      injected=true;await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[owner.userId]);
     }
     return result;
    };const v=Reflect.get(client,k);return typeof v==='function'?v.bind(client):v;
   }});
   return fn(intercepted);
  });const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }}) as Database;
 await assert.rejects(new ProductFeedbackService(db,config).submit(owner,submit()),{code:'AUTH_REQUIRED'});assert(injected);
 for(const table of ['platform_product_feedback','platform_product_feedback_operations','platform_product_events'])assert.equal((await f.db.query('SELECT 1 FROM '+table+' WHERE user_id=$1',[owner.userId])).rowCount,0);
 assert.equal((await service.list(owner)).records.length,0);
});
test('telemetry opt-out preserves feedback and audit failure does not publish a staff reply',async()=>{
 const {owner,authority,config}=await setup(),service=new ProductFeedbackService(f.db,{...config,productEventsEnabled:false});
 const p=(await service.submit(owner,submit())).feedback;
 assert.equal((await f.db.query('SELECT 1 FROM platform_product_events WHERE user_id=$1',[owner.userId])).rowCount,0);
 const fail=new Error('Fictional audit unavailable');
 const db=new Proxy(f.db,{get(target,key){
  if(key==='withBoundedTransaction')return (fn:any)=>target.withBoundedTransaction(c=>fn(new Proxy(c,{get(client,k){
   if(k==='query')return (sql:string,values:any[])=>{if(sql.includes('INSERT INTO platform_staff_audit'))throw fail;return client.query(sql,values);};
   const v=Reflect.get(client,k);return typeof v==='function'?v.bind(client):v;
  }})));const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }}) as Database;
 await assert.rejects(new ProductFeedbackService(db,config).update(authority.operator,p.id,update()),e=>e===fail);
 assert.equal((await service.get(owner,p.id)).revision,1);
 assert.equal((await f.db.query('SELECT 1 FROM platform_product_feedback_operations WHERE feedback_id=$1',[p.id])).rowCount,1);
});

test('availability exposes only an active configured recipient and rejects stale recipient consent without persisting',async()=>{
 const {owner,authority,service}=await setup();
 const a=await service.availability(owner);assert.equal(a.available,true);assert.equal(a.recipient?.id,authority.orgId);
 assert(!JSON.stringify(a).includes(authority.operator.userId));
 await assert.rejects(service.submit(owner,{...submit(),recipientId:randomUUID()}),{code:'FEEDBACK_RECIPIENT_CHANGED'});
 assert.equal((await service.list(owner)).records.length,0);
 const off=await new ProductFeedbackService(f.db,f.config).availability(owner);assert.deepEqual(off,{available:false,recipient:null});
});
test('read-only operation observation returns the current owner record without submitting or granting another owner access',async()=>{
 const {owner,other,authority,service}=await setup(),body=submit();
 await assert.rejects(service.observe(owner,body.operationId),{code:'NOT_FOUND'});
 const p=(await service.submit(owner,body)).feedback;
 await service.update(authority.operator,p.id,{...update(),status:'resolved',reply:'Fictional resolved reply'});
 const seen=await service.observe(owner,body.operationId);
 assert.equal(seen.operation.replayed,true);assert.equal(seen.operation.appliedRevision,1);assert.equal(seen.feedback.revision,2);assert.equal(seen.feedback.status,'resolved');
 await assert.rejects(service.observe(other,body.operationId),{code:'NOT_FOUND'});
 assert.equal((await f.db.query('SELECT 1 FROM platform_product_feedback WHERE user_id=$1',[owner.userId])).rowCount,1);
});

test('targeted staff reads are audited, operation observation belongs to the original operator and retains earlier revisions',async()=>{
 const {owner,authority,service}=await setup(),p=(await service.submit(owner,submit())).feedback;
 const detail=await service.staffGet(authority.operator,p.id);assert.equal(detail.actorId,authority.operator.userId);assert.equal(detail.organizationId,authority.orgId);
 const b=update(),saved=await service.update(authority.operator,p.id,b);assert.equal(saved.actorId,authority.operator.userId);
 await service.update(authority.operator,p.id,{...update(2),status:'resolved',reply:'Final fictional response'});
 const observed=await service.staffObserve(authority.operator,p.id,b.operationId);assert.equal(observed.operation.appliedRevision,2);assert.equal(observed.feedback.revision,3);assert.equal(observed.operation.replayed,true);
 const second=await f.actor(true);await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,status,granted_by,granted_at) VALUES($1,$2,'ops','active',$3,clock_timestamp())",[authority.orgId,second.userId,authority.operator.userId]);
 assert.equal((await service.staffGet(second,p.id)).feedback.id,p.id);
 await assert.rejects(service.staffObserve(second,p.id,b.operationId),{code:'NOT_FOUND'});
 await assert.rejects(service.staffObserve(authority.operator,p.id,p.lastOperationId),{code:'NOT_FOUND'});
 await assert.rejects(service.staffGet(owner,p.id),{code:'STAFF_ROLE_REQUIRED'});
 const foreign=await f.identityAuthority();await assert.rejects(service.staffGet(foreign.operator,p.id),{code:'STAFF_ROLE_REQUIRED'});
 const other=(await service.submit(owner,submit())).feedback;
 await assert.rejects(service.staffObserve(authority.operator,other.id,b.operationId),{code:'NOT_FOUND'});
 const audits=(await f.db.query("SELECT * FROM platform_staff_audit WHERE org_id=$1 AND target_id=$2 AND action='product_feedback_viewed'",[authority.orgId,p.id])).rows;
 assert(audits.some(r=>r.outcome==='allow'));assert(!JSON.stringify(audits).includes('FICTIONAL_PRIVATE'));
 await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2",[authority.orgId,authority.operator.userId]);
 await assert.rejects(service.staffObserve(authority.operator,p.id,b.operationId),{code:'STAFF_ROLE_REQUIRED'});
});
