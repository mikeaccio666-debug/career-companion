import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {decodePaidSettingsReceipt,decodePaidSettingsSnapshot,type PaidSettingsOperationRow,type PaidSettingsRow} from './companion-paid-settings-snapshot.ts';
import {ApiError} from './errors.ts';

export const COMPANION_EXPORT_TABLES=Object.freeze(['platform_companions','platform_companion_paid_setting_operations'] as const);
export type CompanionExportSection='companions'|'companionPaidSettingOperations';
const unavailable=()=>new ApiError(503,'ACCOUNT_COMPANION_EXPORT_UNAVAILABLE','The saved companion records could not be confirmed.');
interface CompanionRow extends PaidSettingsRow {
 status:string;current_revision:number;draft_rerolls:number;fingerprint:string;created_at:Date;updated_at:Date;
 name:string|null;name_origin:string|null;seal_char:string|null;seal_candidates:unknown;seal_changed_at:Date|null;
 ink_token:string|null;relationship_stage:string|null;stage_changed_at:Date|null;overlays:unknown;
 birth_receipt_id:string|null;birth_idempotency_key:string|null;born_at:Date|null;retired_at:Date|null;seal_asset_id:string|null;
}
/** Archive the retained current row of every owned companion and every original
 * preference operation. No active-companion selection, model admission, policy
 * consumption or mutation; the coordinator owns the repeatable-read snapshot. */
export class AccountCompanionExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:CompanionExportSection;record:unknown}>{
  const raw=careerRecordObject(value,['userId','tokenHash']),who=Object.freeze({userId:careerRecordId(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();
    const companions:CompanionRow[]=(await client.query<CompanionRow>(`SELECT id,user_id,status,current_revision,draft_rerolls,fingerprint,created_at,updated_at,
      name,name_origin,seal_char,seal_candidates,seal_changed_at,ink_token,relationship_stage,stage_changed_at,overlays,
      birth_receipt_id,birth_idempotency_key,born_at,retired_at,seal_asset_id,
      paid_suggestions_mode,paid_suggestions_revision,paid_suggestions_ciphertext,paid_suggestions_updated_at,paid_suggestions_operation_id
      FROM platform_companions WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of companions){
     signal?.throwIfAborted();if(row.user_id!==who.userId)throw unavailable();
     let revision=0,latest:PaidSettingsOperationRow|undefined;
     for(;;){
      const operations=(await client.query<PaidSettingsOperationRow>(`SELECT user_id,companion_id,operation_id,applied_revision,receipt_ciphertext,created_at
       FROM platform_companion_paid_setting_operations WHERE user_id=$1 AND companion_id=$2 AND applied_revision>$3 ORDER BY applied_revision LIMIT 100`,[who.userId,row.id,revision])).rows;
      for(const operation of operations){
       signal?.throwIfAborted();
       if(operation.user_id!==who.userId||operation.companion_id!==row.id||operation.applied_revision!==revision+1)throw unavailable();
       const receipt=decodePaidSettingsReceipt(this.config.dataCrypto,who.userId,operation);
       revision=operation.applied_revision;latest=operation;
       yield {section:'companionPaidSettingOperations',record:{...receipt.command,appliedRevision:receipt.appliedRevision,createdAt:receipt.createdAt}};
      }
      if(operations.length<100)break;
     }
     // Every receipt, including old choices, must survive; the last one must
     // authenticate the current state. A gap or rollback fails the whole capture.
     if(revision!==row.paid_suggestions_revision)throw unavailable();
     const paidSuggestions=decodePaidSettingsSnapshot(this.config.dataCrypto,who.userId,row,latest);
     yield {section:'companions',record:{id:row.id,ownerId:row.user_id,status:row.status,currentRevision:row.current_revision,
      draftRerolls:row.draft_rerolls,fingerprint:row.fingerprint,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),
      name:row.name,nameOrigin:row.name_origin,sealChar:row.seal_char,sealCandidates:row.seal_candidates,sealChangedAt:row.seal_changed_at?.toISOString()??null,
      inkToken:row.ink_token,relationshipStage:row.relationship_stage,stageChangedAt:row.stage_changed_at?.toISOString()??null,overlays:row.overlays,
      birthReceiptId:row.birth_receipt_id,birthIdempotencyKey:row.birth_idempotency_key,bornAt:row.born_at?.toISOString()??null,
      retiredAt:row.retired_at?.toISOString()??null,sealAssetId:row.seal_asset_id,paidSuggestions}};
    }
    if(companions.length<100)break;after=companions.at(-1)!.id;
   }
  }catch(error){signal?.throwIfAborted();if(error instanceof ApiError)throw error;throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
