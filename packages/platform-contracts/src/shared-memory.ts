import { EXPERT_KEYS, type AgentSpeakerKey } from './agent-loop.ts';
export const SHARED_MEMORY_CATEGORIES = Object.freeze(['agreement','communication','goal_preference','experience','identity_timeline','emotion_rhythm'] as const);
export type SharedMemoryCategory = typeof SHARED_MEMORY_CATEGORIES[number];
export type SharedMemorySensitivity = 'normal' | 'sensitive' | 'restricted';
export interface SharedMemoryRecord {
  readonly id: string; readonly ownerId: string; readonly revision: number; readonly kind: 'needs_review' | 'memory';
  readonly content: string; readonly category: SharedMemoryCategory | null; readonly sensitivity: SharedMemorySensitivity | null;
  readonly source: 'user_saved' | 'user_stated' | 'companion_proposed' | 'expert_proposed' | 'imported' | null;
  readonly status: 'proposed' | 'confirmed' | 'archived' | null; readonly confidence: 'high' | 'medium' | 'low' | null;
  readonly usePolicy: 'normal' | 'only_if_user_raises' | null; readonly speakerScope: AgentSpeakerKey | null;
  readonly quote: string | null; readonly originConversationId: string | null; readonly originMessageId: string | null;
  readonly confirmedAt: string | null; readonly validUntil: string | null; readonly reviewDueAt: string | null;
  readonly createdAt: string; readonly updatedAt: string; readonly deletedAt: string | null; readonly undoUntil: string | null;
  readonly deletionOperationId: string | null; readonly lastOperationId: string | null;
}
export type SharedMemoryCommandKind = 'create' | 'confirm' | 'edit' | 'delete' | 'undo';
export interface SharedMemoryCommand {
  readonly operationId: string; readonly expectedRevision: number;
  readonly content?: string; readonly editedContent?: string; readonly category?: SharedMemoryCategory; readonly sensitivity?: SharedMemorySensitivity;
  readonly usePolicy?: 'normal' | 'only_if_user_raises'; readonly speakerScope?: AgentSpeakerKey | null;
  readonly validUntil?: string | null; readonly status?: 'confirmed' | 'archived';
  readonly deleteOriginMessage?: boolean; readonly deletionOperationId?: string;
}
export class SharedMemoryContractError extends Error { constructor() { super('Invalid shared memory value.'); this.name='SharedMemoryContractError'; } }
const fail = (): never => { throw new SharedMemoryContractError(); };
function object(value: unknown, allowed: readonly string[], required=allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors=Object.getOwnPropertyDescriptors(value), keys=Reflect.ownKeys(descriptors);
  if (keys.some(k=>typeof k!=='string'||!allowed.includes(k)) || required.some(k=>!descriptors[k])
    || Object.values(descriptors).some(d=>!('value' in d)||!d.enumerable)) fail();
  return Object.fromEntries(keys.map(k=>[k,descriptors[k as string].value]));
}
export function sharedMemoryId(v: unknown): string { if(typeof v!=='string'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(v)?.[0]!==v) fail(); return v as string; }
function text(v: unknown,max: number): string { if(typeof v!=='string'||!v.trim()||Array.from(v).length>max||/[\ud800-\udfff]/u.test(v)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) fail(); return v as string; }
function enumeration<T extends string>(v: unknown,values: readonly T[]): T { if(typeof v!=='string'||!values.includes(v as T)) fail(); return v as T; }
function revision(v: unknown) { if(!Number.isSafeInteger(v)||(v as number)<0||(v as number)>2147483647||Object.is(v,-0)) fail(); return v as number; }
function date(v: unknown): string { const s=text(v,24); if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s) fail(); return s; }
const nullable=<T>(v: unknown,parse:(v:unknown)=>T):T|null=>v===null?null:parse(v);
const speakers=['companion',...EXPERT_KEYS] as const;
const keys=['id','ownerId','revision','kind','content','category','sensitivity','source','status','confidence','usePolicy','speakerScope','quote',
  'originConversationId','originMessageId','confirmedAt','validUntil','reviewDueAt','createdAt','updatedAt','deletedAt','undoUntil','deletionOperationId','lastOperationId'] as const;
export function parseSharedMemoryRecord(value: unknown): Readonly<SharedMemoryRecord> {
  const v=object(value,keys), kind=enumeration(v.kind,['needs_review','memory']);
  const out: SharedMemoryRecord={id:sharedMemoryId(v.id),ownerId:sharedMemoryId(v.ownerId),revision:revision(v.revision),kind,
    content:text(v.content,kind==='needs_review'?4000:2000),category:nullable(v.category,x=>enumeration(x,SHARED_MEMORY_CATEGORIES)),
    sensitivity:nullable(v.sensitivity,x=>enumeration(x,['normal','sensitive','restricted'])),source:nullable(v.source,x=>enumeration(x,['user_saved','user_stated','companion_proposed','expert_proposed','imported'])),
    status:nullable(v.status,x=>enumeration(x,['proposed','confirmed','archived'])),confidence:nullable(v.confidence,x=>enumeration(x,['high','medium','low'])),
    usePolicy:nullable(v.usePolicy,x=>enumeration(x,['normal','only_if_user_raises'])),speakerScope:nullable(v.speakerScope,x=>enumeration(x,speakers)),quote:nullable(v.quote,x=>text(x,280)),
    originConversationId:nullable(v.originConversationId,sharedMemoryId),originMessageId:nullable(v.originMessageId,sharedMemoryId),confirmedAt:nullable(v.confirmedAt,date),
    validUntil:nullable(v.validUntil,date),reviewDueAt:nullable(v.reviewDueAt,date),createdAt:date(v.createdAt),updatedAt:date(v.updatedAt),deletedAt:nullable(v.deletedAt,date),
    undoUntil:nullable(v.undoUntil,date),deletionOperationId:nullable(v.deletionOperationId,sharedMemoryId),lastOperationId:nullable(v.lastOperationId,sharedMemoryId)};
  const metadata=[out.category,out.sensitivity,out.source,out.status,out.confidence,out.usePolicy];
  if(out.updatedAt<out.createdAt || (kind==='needs_review'?metadata.some(x=>x!==null)||out.confirmedAt!==null:metadata.some(x=>x===null)||out.revision<1)
    || out.status==='confirmed'&&out.confirmedAt===null || out.confirmedAt!==null&&out.confirmedAt>out.updatedAt
    || out.speakerScope!==null&&out.category!=='communication' || (out.originMessageId!==null&&out.originConversationId===null)
    || (out.revision===0)!==(out.lastOperationId===null)
    || (out.deletedAt===null ? out.undoUntil!==null||out.deletionOperationId!==null : out.undoUntil===null||out.deletionOperationId===null||Date.parse(out.undoUntil)-Date.parse(out.deletedAt)!==10000)) fail();
  return Object.freeze(out);
}
export function parseSharedMemoryCommand(kind: SharedMemoryCommandKind,value: unknown): Readonly<SharedMemoryCommand> {
  if(!['create','confirm','edit','delete','undo'].includes(kind)) fail();
  const metadata=['content','category','sensitivity','usePolicy','speakerScope','validUntil'];
  const allowed=kind==='create'?['operationId','expectedRevision',...metadata]:kind==='confirm'?['operationId','expectedRevision','editedContent',...metadata.filter(k=>k!=='content')]:kind==='edit'?['operationId','expectedRevision',...metadata,'status']
    :kind==='delete'?['operationId','expectedRevision','deleteOriginMessage']:['operationId','expectedRevision','deletionOperationId'];
  const required=kind==='create'?['operationId','content','category','sensitivity','usePolicy','speakerScope','validUntil']
    :kind==='confirm'?['operationId','expectedRevision','category','sensitivity']:kind==='undo'?['operationId','expectedRevision','deletionOperationId']:['operationId','expectedRevision'];
  const v=object(value,allowed,required);if(kind==='create'&&v.expectedRevision!==undefined&&v.expectedRevision!==0)fail();
  const out: any={operationId:sharedMemoryId(v.operationId),expectedRevision:kind==='create'?0:revision(v.expectedRevision)};
  for(const key of Object.keys(v)) {
    if(key==='content'||key==='editedContent') out[key]=text(v[key],2000);
    else if(key==='category') out.category=enumeration(v.category,SHARED_MEMORY_CATEGORIES);
    else if(key==='sensitivity') out.sensitivity=enumeration(v.sensitivity,['normal','sensitive','restricted']);
    else if(key==='usePolicy') out.usePolicy=enumeration(v.usePolicy,['normal','only_if_user_raises']);
    else if(key==='speakerScope') out.speakerScope=nullable(v.speakerScope,x=>enumeration(x,speakers));
    else if(key==='validUntil') out.validUntil=nullable(v.validUntil,date);
    else if(key==='status') out.status=enumeration(v.status,['confirmed','archived']);
    else if(key==='deleteOriginMessage') { if(typeof v.deleteOriginMessage!=='boolean') fail(); out.deleteOriginMessage=v.deleteOriginMessage; }
    else if(key==='deletionOperationId') out.deletionOperationId=sharedMemoryId(v.deletionOperationId);
  }
  if(kind==='edit'&&Object.keys(v).length===2 || out.speakerScope!==undefined&&out.speakerScope!==null&&out.category!==undefined&&out.category!=='communication') fail();
  return Object.freeze(out);
}
