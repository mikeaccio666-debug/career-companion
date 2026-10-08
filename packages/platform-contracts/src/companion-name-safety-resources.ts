/** Transport contracts only. No student route is mounted by these definitions.
 * Resource presentation is a client declaration, never clinical or execution clearance. */
export type NameSafetyResourceAction = Readonly<{kind:'present_body';bodyProjectionId:string}>
  | Readonly<{kind:'acknowledge'|'continue_naming';presentationReceipt:string}>
  | Readonly<{kind:'clarify_exaggeration';presentationReceipt:string;safe:true;exaggeration:true}>
  | Readonly<{kind:'need_support'}>;
export interface NameSafetyResourceCommand {readonly operationId:string;readonly publicationId:string;readonly expectedPublicationRevision:number;readonly action:NameSafetyResourceAction;}
export interface NameSafetyPublicationCommand {readonly operationId:string;readonly submissionId:string;readonly expectedEdition:number;}
export interface NameSafetyResourceBody {
  readonly text:string;readonly resourceCard:Readonly<{title:string;contacts:readonly Readonly<{id:string;verifiedAt:string;name:string;description:string;
    actions:readonly (Readonly<{kind:'call';number:string;label:string}>|Readonly<{kind:'sms';number:string;body:string|null;label:string}>|Readonly<{kind:'web';url:string;label:string}>)[]}>[];
    schoolUnknown:string;footer:string;outsideUs:Readonly<{label:string;text:string}>}>;
}
export interface NameSafetyResourceState {
  readonly publicationId:string;readonly submissionId:string;readonly edition:number;readonly revision:number;
  readonly status:'ready'|'expired';readonly level:'L1'|'L2';readonly mode:'full'|'keyword_only';
  readonly preparedAt:string;readonly publishedAt:string;readonly retentionUntil:string;
  readonly presented:boolean;readonly acknowledged:boolean;readonly handled:boolean;readonly clarifiedAt:string|null;
}
export interface NameSafetyBodyProjection {readonly publicationId:string;readonly submissionId:string;readonly revision:number;readonly bodyProjectionId:string;readonly body:NameSafetyResourceBody;readonly retentionUntil:string;}
export interface NameSafetyResourceResult {
  readonly state:NameSafetyResourceState;readonly operation:Readonly<{id:string;appliedRevision:number;replayed:boolean}>;
  /** Only the first committed live body presentation returns this hash-only stored capability. */
  readonly presentationReceipt?:string;
}
export interface SafetyQuestionReserveCommand {readonly operationId:string;readonly publicationId:string;readonly expectedQuestionScopeRevision:number;readonly renderOwnerId:string;}
export interface SafetyQuestionClaimCommand {readonly operationId:string;readonly occurrenceId:string;readonly reservationId:string;readonly reservationToken:string;readonly generation:number;readonly renderOwnerId:string;}
export interface SafetyQuestionPresentCommand {readonly operationId:string;readonly occurrenceId:string;readonly grantId:string;readonly grantPresentationToken:string;readonly renderOwnerId:string;}
export class NameSafetyResourceContractError extends Error {readonly code='INVALID_INPUT';constructor(){super('Use a valid resource delivery operation.');}}
function invalid():never{throw new NameSafetyResourceContractError();}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!Object.hasOwn(ds,k))
    ||Object.values(ds).some(d=>!('value'in d)||!d.enumerable))invalid();return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function uuid(v:unknown):string{if(typeof v!=='string'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(v)?.[0]!==v)invalid();return v;}
function revision(v:unknown,min=0):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min||v>2147483646)invalid();return v;}
function token(v:unknown):string{if(typeof v!=='string'||/^[A-Za-z0-9_-]{43}$/.exec(v)?.[0]!==v)invalid();return v;}
export function parseNameSafetyPublicationCommand(value:unknown):Readonly<NameSafetyPublicationCommand>{const d=record(value,['operationId','submissionId','expectedEdition']);return Object.freeze({operationId:uuid(d.operationId),submissionId:uuid(d.submissionId),expectedEdition:revision(d.expectedEdition)});}
export function parseNameSafetyResourceCommand(value:unknown):Readonly<NameSafetyResourceCommand>{
  const d=record(value,['operationId','publicationId','expectedPublicationRevision','action']);
  const ds=d.action&&typeof d.action==='object'?Object.getOwnPropertyDescriptor(d.action,'kind'):undefined;if(!ds||!('value'in ds))invalid();const kind=ds.value;
  let action:NameSafetyResourceAction;
  if(kind==='present_body'){const a=record(d.action,['kind','bodyProjectionId']);action={kind,bodyProjectionId:uuid(a.bodyProjectionId)};}
  else if(kind==='need_support'){record(d.action,['kind']);action={kind};}
  else if(kind==='acknowledge'||kind==='continue_naming'){const a=record(d.action,['kind','presentationReceipt']);action={kind,presentationReceipt:token(a.presentationReceipt)};}
  else if(kind==='clarify_exaggeration'){const a=record(d.action,['kind','presentationReceipt','safe','exaggeration']);if(a.safe!==true||a.exaggeration!==true)invalid();action={kind,presentationReceipt:token(a.presentationReceipt),safe:true,exaggeration:true};}
  else invalid();return Object.freeze({operationId:uuid(d.operationId),publicationId:uuid(d.publicationId),expectedPublicationRevision:revision(d.expectedPublicationRevision),action:Object.freeze(action)});
}
export function parseSafetyQuestionReserveCommand(v:unknown):Readonly<SafetyQuestionReserveCommand>{const d=record(v,['operationId','publicationId','expectedQuestionScopeRevision','renderOwnerId']);return Object.freeze({operationId:uuid(d.operationId),publicationId:uuid(d.publicationId),expectedQuestionScopeRevision:revision(d.expectedQuestionScopeRevision),renderOwnerId:uuid(d.renderOwnerId)});}
export function parseSafetyQuestionClaimCommand(v:unknown):Readonly<SafetyQuestionClaimCommand>{const d=record(v,['operationId','occurrenceId','reservationId','reservationToken','generation','renderOwnerId']);return Object.freeze({operationId:uuid(d.operationId),occurrenceId:uuid(d.occurrenceId),reservationId:uuid(d.reservationId),reservationToken:token(d.reservationToken),generation:revision(d.generation,1),renderOwnerId:uuid(d.renderOwnerId)});}
export function parseSafetyQuestionPresentCommand(v:unknown):Readonly<SafetyQuestionPresentCommand>{const d=record(v,['operationId','occurrenceId','grantId','grantPresentationToken','renderOwnerId']);return Object.freeze({operationId:uuid(d.operationId),occurrenceId:uuid(d.occurrenceId),grantId:uuid(d.grantId),grantPresentationToken:token(d.grantPresentationToken),renderOwnerId:uuid(d.renderOwnerId)});}
