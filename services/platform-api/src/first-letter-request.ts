import {createHash} from 'node:crypto';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import {snapshotFirstLetterSettings,type FirstLetterCompositionSettings} from './first-letter-composition.ts';
import type {PlatformConfig} from './config.ts';
import {ApiError} from './errors.ts';
export interface FirstLetterRequestRow{
 id:string;user_id:string;task_id:string;preparation_id:string;auth_version:string;payload_digest:string;
 payload_ciphertext:Buffer;accepted_at:Date;
}
export interface FirstLetterRequestSnapshot{
 readonly schemaVersion:1;readonly requestId:string;readonly ownerId:string;readonly taskId:string;
 readonly companionId:string;readonly welcomeId:string;readonly preparationId:string;readonly sourceId:string;
 readonly tokenHash:string;readonly authVersion:string;readonly settings:Readonly<FirstLetterCompositionSettings>;
 readonly provider:string;readonly model:string;readonly acceptedAt:string;
}
export const firstLetterRequestUnavailable=()=>new ApiError(503,'FIRST_LETTER_REQUEST_UNAVAILABLE','The accepted letter request could not be confirmed.');
export const firstLetterRequestDigest=(text:string)=>createHash('sha256').update(text).digest('hex');
export const firstLetterRequestBinding=(row:{id:string;user_id:string})=>({table:'platform_first_letter_requests',
 column:'payload_ciphertext',rowId:row.id,ownerId:row.user_id,revision:1});
function hash(value:unknown,prefix=''){
 if(typeof value!=='string'||value.length!==prefix.length+64||!value.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(value.slice(prefix.length)))throw firstLetterRequestUnavailable();
 return value;
}
export function decodeFirstLetterRequest(row:FirstLetterRequestRow,crypto:PlatformConfig['dataCrypto']):Readonly<FirstLetterRequestSnapshot>{
 try{
  if(!crypto)throw firstLetterRequestUnavailable();
  const raw=crypto.openUtf8(row.payload_ciphertext,firstLetterRequestBinding(row));
  const v=careerRecordObject(JSON.parse(raw),['schemaVersion','requestId','ownerId','taskId','companionId','welcomeId','preparationId','sourceId',
   'tokenHash','authVersion','settings','provider','model','acceptedAt']);
  if(v.schemaVersion!==1||v.requestId!==row.id||v.ownerId!==row.user_id||v.taskId!==row.task_id||v.preparationId!==row.preparation_id
   ||v.authVersion!==String(row.auth_version)||v.acceptedAt!==row.accepted_at.toISOString()
   ||firstLetterRequestDigest(raw)!==row.payload_digest||typeof v.authVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.authVersion)
   ||typeof v.provider!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/.test(v.provider)
   ||typeof v.model!=='string'||!/^[A-Za-z0-9._:/-]{1,160}$/.test(v.model))throw firstLetterRequestUnavailable();
  const result:FirstLetterRequestSnapshot={schemaVersion:1,requestId:careerRecordId(v.requestId),ownerId:careerRecordId(v.ownerId),
   taskId:careerRecordId(v.taskId),companionId:careerRecordId(v.companionId),welcomeId:careerRecordId(v.welcomeId),
   preparationId:hash(v.preparationId,'first_letter_preparation_'),sourceId:hash(v.sourceId,'first_letter_source_'),tokenHash:hash(v.tokenHash),
   authVersion:v.authVersion,settings:snapshotFirstLetterSettings(v.settings as FirstLetterCompositionSettings),
   provider:v.provider,model:v.model,acceptedAt:row.accepted_at.toISOString()};
  if(JSON.stringify(result)!==raw)throw firstLetterRequestUnavailable();
  return Object.freeze(result);
 }catch{throw firstLetterRequestUnavailable();}
}
export function projectFirstLetterRequest(v:FirstLetterRequestSnapshot){
 const {tokenHash:_,authVersion:__,...metadata}=v;return Object.freeze(metadata);
}
export function firstLetterNotification(value:unknown){
 const v=careerRecordObject(value,['requestId','taskId']);
 return Object.freeze({requestId:careerRecordId(v.requestId),taskId:careerRecordId(v.taskId)});
}
