import type { PoolClient } from 'pg';
import type { DataCrypto } from './data-crypto.ts';
import { deliveryDigest, deliveryRecord, deliveryStorageUnavailable, deliveryUuid, openDelivery, sealDelivery } from './safety-delivery-review.ts';

async function rawLegacyReferences(client:PoolClient,userId:string,draftId:string){
  const rows=(await client.query<{id:string;value:string}>('SELECT p.id,row_to_json(p)::text AS value FROM platform_onboarding_safety_publications p WHERE p.user_id=$1 AND p.draft_id=$2 ORDER BY p.id FOR SHARE',[userId,draftId])).rows;
  return rows.map(row=>({id:row.id,transportDigest:deliveryDigest(row.value)}));
}
/** A real explicit publication/reservation creates the cutover; GET never does.
 * Raw transport integrity is sealed, never professional review or an asked time.
 * Body publication remains independent of old question-payload damage. */
export async function ensureIntakeResourceCutover(client:PoolClient,crypto:DataCrypto,userId:string,draftId:string,requireLegacyIntegrity=false){
  const root=(await client.query<{safety_resource_v2_draft_id:string|null}>('SELECT safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE',[draftId,userId])).rows[0];
  if(!root)throw deliveryStorageUnavailable();
  const row=(await client.query<{user_id:string;draft_id:string;recorded_at:Date;legacy_digest:string;payload_ciphertext:Buffer}>('SELECT * FROM platform_onboarding_resource_cutovers WHERE user_id=$1 AND draft_id=$2 FOR UPDATE',[userId,draftId])).rows[0];
  if(row){const raw=openDelivery(crypto,'platform_onboarding_resource_cutovers',draftId,userId,1,row.payload_ciphertext),data=deliveryRecord(raw,['schemaVersion','userId','draftId','recordedAt','legacyDigest','legacy']);
    if(!Array.isArray(data.legacy))throw deliveryStorageUnavailable();
    const legacy=data.legacy.map(value=>{const d=deliveryRecord(value,['id','transportDigest']);if(typeof d.transportDigest!=='string'||/^[0-9a-f]{64}$/.exec(d.transportDigest)?.[0]!==d.transportDigest)throw deliveryStorageUnavailable();return{id:deliveryUuid(d.id),transportDigest:d.transportDigest};});
    if(new Set(legacy.map(v=>v.id)).size!==legacy.length||legacy.some((v,i)=>i>0&&legacy[i-1].id>=v.id))throw deliveryStorageUnavailable();
    const expected={schemaVersion:1,userId,draftId,recordedAt:row.recorded_at.toISOString(),legacyDigest:deliveryDigest(JSON.stringify(legacy)),legacy};
    if(root.safety_resource_v2_draft_id!==draftId||row.legacy_digest!==expected.legacyDigest||JSON.stringify(raw)!==JSON.stringify(expected))throw deliveryStorageUnavailable();
    if(!(await client.query<{valid:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS valid',[row.recorded_at])).rows[0].valid)throw deliveryStorageUnavailable();
    if(requireLegacyIntegrity&&JSON.stringify(await rawLegacyReferences(client,userId,draftId))!==JSON.stringify(legacy))throw deliveryStorageUnavailable();return;
  }
  if(root.safety_resource_v2_draft_id!==null)throw deliveryStorageUnavailable();
  const legacy=await rawLegacyReferences(client,userId,draftId),digest=deliveryDigest(JSON.stringify(legacy));
  const at=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
  const cipher=sealDelivery(crypto,'platform_onboarding_resource_cutovers',draftId,userId,1,{schemaVersion:1,userId,draftId,recordedAt:at.toISOString(),legacyDigest:digest,legacy});
  await client.query('INSERT INTO platform_onboarding_resource_cutovers(user_id,draft_id,recorded_at,legacy_digest,payload_ciphertext) VALUES($1,$2,$3,$4,$5)',[userId,draftId,at,digest,cipher]);
  const saved=await client.query('UPDATE platform_onboarding_drafts SET safety_resource_v2_draft_id=id WHERE id=$1 AND user_id=$2 AND safety_resource_v2_draft_id IS NULL RETURNING id',[draftId,userId]);
  if(saved.rowCount!==1)throw deliveryStorageUnavailable();
}
