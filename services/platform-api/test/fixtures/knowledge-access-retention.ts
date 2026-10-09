import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Database} from '../../src/database.ts';
import type {PlatformConfig} from '../../src/config.ts';
import type {FixedSessionContext} from '../../src/auth.ts';
import {OrgKnowledge} from '../../src/org-knowledge.ts';
import {LocalBlobStorage} from '../../src/storage.ts';
import {FICTIONAL_LEGAL} from './student-entry.ts';
/** Real authorized local content path, with fictional license and question only. */
export async function knowledgeAccessFixture(f:{db:Database;config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'|'orgContentBrand'>;actor(staff?:boolean):Promise<FixedSessionContext>}){
 const directory=await mkdtemp(join(tmpdir(),'fictional-access-retention-'));
 const close=()=>rm(directory,{recursive:true,force:true});
 try{
  const operator=await f.actor(true),editor=await f.actor(true),reviewer=await f.actor(true),owner=await f.actor();
  const org=randomUUID(),agreementRef=randomUUID(),blobs=new LocalBlobStorage(directory);
  await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional retention library')",[org,'retention_'+org.replaceAll('-','')]);
  for(const [user,role] of [[operator.userId,'ops'],[editor.userId,'content_editor'],[reviewer.userId,'content_reviewer']])
   await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[org,user,role,operator.userId]);
  const bytes=Buffer.from('Fictional permission fixture, not a production license.');
  await blobs.put(agreementRef,bytes);
  await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',$3,$4)",[agreementRef,operator.userId,bytes.length,agreementRef]);
  const service=new OrgKnowledge(f.db,f.config,FICTIONAL_LEGAL,blobs);
  const license=await service.registerLicense(operator,org,{operationId:randomUUID(),assetClass:'question',agreementRef,allowedUses:['retrieve','model_context','display_full'],audience:'cohort',validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2028-10-01T00:00:00.000Z'});
  await service.setEntitlement(operator,org,{operationId:randomUUID(),userId:owner.userId,expectedRevision:0,audienceGrants:['cohort'],expiresAt:'2028-10-01T00:00:00.000Z',revoke:false});
  const batch=await service.importBundle(operator,org,{operationId:randomUUID(),licenseId:license.licenseId,sources:[{assetClass:'question',title:'Fictional retention question',structured:{question_ref:'fictional.retention',type:'sql',role_families:['da'],difficulty:1,topics:['aggregation'],prompt_en:'Explain a fictional grouped query.',prompt_zh:'解释虚构查询。',external_ref:null,rubric:null,key_points:['Describe grouping.'],follow_ups:[],time_budget_min:15},language:'mixed',roleFamilies:['da'],tags:['aggregation'],editor:editor.userId+'@example.invalid',reviewer:reviewer.userId+'@example.invalid',validUntil:'2028-10-01T00:00:00.000Z',reviewConfirmed:true,deidentified:true}]});
  await service.publishBatch(operator,org,batch.batchId,{operationId:randomUUID()});
  const sourceId=batch.sourceIds[0];
  async function access(){await service.readPassage(owner,sourceId,2,'2:0');return (await f.db.query('SELECT id FROM platform_knowledge_access_log WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[owner.userId])).rows[0].id as string;}
  return {service,owner,org,sourceId,access,close};
 }catch(error){await close();throw error;}
}
