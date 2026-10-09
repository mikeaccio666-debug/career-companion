import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountOrganizationHistoryExport,ORGANIZATION_HISTORY_EXPORT_TABLES as tables} from '../src/account-organization-history-export.ts';
import {StaffAccess} from '../src/staff-access.ts';
import {OrgKnowledge} from '../src/org-knowledge.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {proof,capture,instrument,unused,encoded,password} from './fixtures/account-name-source-export.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,staff:StaffAccess,knowledge:OrgKnowledge;
before(async()=>{f=await createCompanionNameSafetyFixture();staff=new StaffAccess(f.db);
 knowledge=new OrgKnowledge(f.db,f.config,FICTIONAL_LEGAL,{stat:async()=>{throw Error('This test never accesses license files.');}});});
after(async()=>{await f?.close();});
const failure={code:'ACCOUNT_ORGANIZATION_HISTORY_EXPORT_UNAVAILABLE'};
const roleRead=(sql:string)=>sql.startsWith('SELECT * FROM platform_org_roles WHERE user_id=');
const auditRead=(sql:string)=>sql.startsWith('SELECT a.* FROM platform_staff_audit a WHERE ');
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function setup(){
 const who=await actor(),other=await actor(),operator=await f.actor(true),org=randomUUID();
 await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional organization archive')",[org,'archive_'+org.replaceAll('-','')]);
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$2)",[org,operator.userId]);
 const denied=async()=>{await assert.rejects(staff.getOrganization(who,org),{code:'STAFF_ROLE_REQUIRED'});};
 return {who,other,operator,org,denied};
}
async function snapshot(user:string){return {
 roles:(await f.db.query('SELECT row_to_json(r)::text AS row FROM platform_org_roles r WHERE user_id=$1 ORDER BY row_to_json(r)::text',[user])).rows,
 audit:(await f.db.query('SELECT row_to_json(a)::text AS row FROM platform_staff_audit a WHERE user_id=$1 OR target_id=$1 ORDER BY id',[user])).rows};
}
test('real denied access and stored memberships export only owner metadata and never grant staff authority',async()=>{
 const s=await setup();await s.denied();
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$3)",[s.org,s.who.userId,s.operator.userId]);
 await s.denied();await assert.rejects(staff.getOrganization(s.other,s.org),{code:'STAFF_ROLE_REQUIRED'});
 const before=await snapshot(s.who.userId),queries:string[]=[],token=await proof(f,s.who);
 const data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(s.who,token);
 assert.equal(data.sections.organizationMemberships.length,1);assert.equal(data.sections.organizationAccessEvents.length,2);
 const r=data.sections.organizationMemberships[0] as any;assert.equal(r.kind,'stored_membership_metadata');assert.equal(r.status,'active');
 for(const r of data.sections.organizationAccessEvents as any[]){assert.equal(r.actor,'self');assert.equal(r.relation,'own_action');assert.equal(r.outcome,'deny');assert.equal(r.recordCount,0);}
 assert.equal(data.includedTables.length,145);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
 for(const t of tables){assert(data.includedTables.includes(t));assert(!data.remainingTables.includes(t));}
 const json=JSON.stringify(data);
 for(const secret of [s.other.userId,s.operator.userId,token,s.who.tokenHash,password,encoded,'granted_by'])assert(!json.includes(secret),secret);
 assert(Object.isFrozen(data.sections.organizationAccessEvents[0]));assert.deepEqual(await snapshot(s.who.userId),before);
 assert(!queries.filter(q=>roleRead(q)||auditRead(q)).some(q=>/FOR (UPDATE|SHARE)/.test(q)));
});
test('a genuine operation about this student exports bounded audit metadata without entitlement values or other accounts',async()=>{
 const s=await setup(),input={operationId:randomUUID(),userId:s.who.userId,expectedRevision:0,audienceGrants:['cohort'],expiresAt:'2028-10-01T00:00:00.000Z',revoke:false};
 const own=await knowledge.setEntitlement(s.operator,s.org,input);
 const foreign=await knowledge.setEntitlement(s.operator,s.org,{...input,operationId:randomUUID(),userId:s.other.userId});
 await staff.getOrganization(s.operator,s.org); // No specific student target; no inferred personal view receipt.
 const queries:string[]=[],data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(s.who,await proof(f,s.who));
 assert.deepEqual(data.sections.organizationMemberships,[]);assert.equal(data.sections.organizationAccessEvents.length,1);
 const r=data.sections.organizationAccessEvents[0] as any;assert.equal(r.actor,'other_account');assert.equal(r.relation,'account');
 assert.equal(r.action,'org_entitlement_changed');assert.equal(r.targetId,s.who.userId);assert.equal(r.outcome,'allow');
 const json=JSON.stringify(data);for(const secret of [own.entitlementId,foreign.entitlementId,s.other.userId,s.operator.userId,'audienceGrants','cohort'])assert(!json.includes(secret),secret);
 assert(!queries.some(sql=>/\b(?:FROM|JOIN|UPDATE|INTO)\s+platform_(?:user_entitlements|knowledge_access_log|org_knowledge_sources|org_knowledge_passages|content_licenses|org_content_state_proofs|org_content_operations)\b/i.test(sql)));
 assert(data.remainingTables.includes('platform_org_content_state_proofs'));assert(data.remainingTables.includes('platform_org_content_operations'));
});
test('revoked membership and unavailable organization remain original historical metadata after consent withdrawal',async()=>{
 const s=await setup();
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'mentor',$3)",[s.org,s.who.userId,s.operator.userId]);
 await s.denied();await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE user_id=$1",[s.who.userId]);
 const before=await capture(f,s.who);
 await f.db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1",[s.org]);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.who.userId]);
 await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[s.who.userId]);
 const after=await capture(f,s.who);
 assert.deepEqual(after.sections.organizationMemberships,before.sections.organizationMemberships);assert.deepEqual(after.sections.organizationAccessEvents,before.sections.organizationAccessEvents);
 assert.equal((after.sections.organizationMemberships[0] as any).status,'revoked');
});
test('missing pages, foreign rows and malformed decisions cannot silently shrink or broaden the archive',async()=>{
 const s=await setup();await s.denied();
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role) VALUES($1,$2,'mentor')",[s.org,s.who.userId]);const token=await proof(f,s.who);
 for(const fault of ['roles','audit','foreignRole','foreignAudit','roleStatus','decision','count','date']){
  let reached=false;const db=instrument(f,(sql,rows)=>{if(!rows.length)return;
   if(roleRead(sql)&&['roles','foreignRole','roleStatus'].includes(fault)){reached=true;if(fault==='roles')rows.splice(0);else if(fault==='foreignRole')rows[0].user_id=s.other.userId;else rows[0].revoked_at=new Date();}
   if(auditRead(sql)&&['audit','foreignAudit','decision','count','date'].includes(fault)){reached=true;if(fault==='audit')rows.splice(0);else if(fault==='foreignAudit'){rows[0].user_id=s.other.userId;rows[0].target_id=s.other.userId;}else if(fault==='decision')rows[0].outcome='allow';else if(fault==='count')rows[0].record_count=-1;else rows[0].created_at=new Date('invalid');}
  });await assert.rejects(new AccountCoreExport(db,f.config).capture(s.who,token),failure);assert(reached,fault);await unused(f,s.who);
 }
});
test('105 genuine denied actions cross the page boundary and empty owners remain empty',async()=>{
 const s=await setup();for(let i=0;i<105;i++)await s.denied();const queries:string[]=[];
 const data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(s.who,await proof(f,s.who));
 assert.equal(data.sections.organizationAccessEvents.length,105);assert.equal(new Set(data.sections.organizationAccessEvents.map((r:any)=>r.id)).size,105);
 assert.equal(queries.filter(auditRead).length,2);
 const other=await capture(f,s.other);assert.deepEqual(other.sections.organizationAccessEvents,[]);assert.deepEqual(other.sections.organizationMemberships,[]);
});
test('membership composite pages retain all stored roles without converting student accounts into staff',async()=>{
 const who=await actor(),issuer=await f.actor(true);
 for(let i=0;i<21;i++){const org=randomUUID();await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional membership archive')",[org,'membership_'+org.replaceAll('-','')]);
  for(const role of ['content_editor','content_reviewer','mentor','ops','org_admin'])await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[org,who.userId,role,issuer.userId]);}
 const queries:string[]=[],data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(who,await proof(f,who));
 assert.equal(data.sections.organizationMemberships.length,105);assert.equal(queries.filter(roleRead).length,2);
 const org=(data.sections.organizationMemberships[0] as any).organizationId;await assert.rejects(staff.getOrganization(who,org),{code:'STAFF_ROLE_REQUIRED'});
});
test('cancellation, late authentication reset and capacity limits return no partial account data',async()=>{
 const s=await setup();await s.denied();
 for(const fault of ['cancel','auth','size']){
  const token=await proof(f,s.who),controller=new AbortController();let reached=false;
  const db=instrument(f,async(sql,rows,client)=>{if(!reached&&auditRead(sql)&&rows.length){reached=true;if(fault==='cancel')controller.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[s.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='size'?{maxBytes:1024}:{}).capture(s.who,token,controller.signal),
   {code:fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':fault==='auth'?'AUTH_REQUIRED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='size')assert(reached);await unused(f,s.who);
 }
});
test('the organization reader refuses staff context and an expired fixed session',async()=>{
 const s=await setup();
 const read=async(who:{userId:string;tokenHash:string})=>f.db.withBoundedTransaction(async client=>{
  const result=[];for await(const r of new AccountOrganizationHistoryExport().exportInTransaction(client,who))result.push(r);return result;
 });
 await assert.rejects(read(s.operator),failure);
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[s.who.tokenHash]);
 await assert.rejects(read(s.who),{code:'AUTH_REQUIRED'});
});

test('an organization UUID equal to an account UUID does not create a false subject access record',async()=>{
 const who=await actor(),operator=await f.actor(true);
 await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional UUID namespace collision')",[who.userId,'collision_'+who.userId.replaceAll('-','')]);
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role) VALUES($1,$2,'ops')",[who.userId,operator.userId]);
 await staff.getOrganization(operator,who.userId);await staff.listMembers(operator,who.userId);
 const data=await capture(f,who);assert.deepEqual(data.sections.organizationAccessEvents,[]);
 await assert.rejects(staff.getOrganization(who,who.userId),{code:'STAFF_ROLE_REQUIRED'});
 const own=await capture(f,who);assert.equal(own.sections.organizationAccessEvents.length,1);assert.equal((own.sections.organizationAccessEvents[0] as any).relation,'own_action');
});
