import { careerRecordId,careerRecordObject,parseMentorIntent,parseMentorIntentCommand,parseMentorServiceOffer,
  mentorIntentEmail,MENTOR_INTENT_PRIVACY,MENTOR_INTENT_PRIVACY_VERSION,type MentorIntent,type MentorServiceOffer,type MentorIntentCommand } from '@companion/platform-contracts';
export interface MentorIntentClient {
  readonly account:{readonly accountId:string};isCurrent():boolean;request<T>(path:string,init?:RequestInit):Promise<T>;
}
const root='/career/mentor-intents';
const fail=():never=>{throw Error('真人服务或预约意向暂时无法确认，请重新读取。');};
function current(c:MentorIntentClient){if(!c.isCurrent())return fail();}
function bound(c:MentorIntentClient):MentorIntentClient {
  current(c);const accountId=careerRecordId(c.account.accountId);
  return Object.freeze({account:Object.freeze({accountId}),isCurrent:()=>c.isCurrent()&&c.account.accountId===accountId,
    request<T>(path:string,init?:RequestInit){return c.request<T>(path,init);}});
}
function array<T>(v:unknown,max:number,parse:(v:unknown)=>T):readonly T[]{
  if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>max)return fail();
  const d=Object.getOwnPropertyDescriptors(v),result:T[]=[];if(Reflect.ownKeys(d).length!==v.length+1)return fail();
  for(let i=0;i<v.length;i++){if(!d[i]||!('value' in d[i])||!d[i].enumerable)return fail();result.push(parse(d[i].value));}
  return Object.freeze(result);
}
function owned(c:MentorIntentClient,v:unknown):Readonly<MentorIntent>{
  const r=parseMentorIntent(v);if(!c.isCurrent()||r.ownerId!==c.account.accountId)return fail();return r;
}
export interface MentorEntry {
  readonly configured:boolean;readonly contactEmail:string;readonly privacyVersion:typeof MENTOR_INTENT_PRIVACY_VERSION;
  readonly intentPrivacy:typeof MENTOR_INTENT_PRIVACY;readonly offers:readonly Readonly<MentorServiceOffer>[];
}
export async function readMentorEntry(c:MentorIntentClient,signal?:AbortSignal):Promise<Readonly<MentorEntry>>{
  c=bound(c);current(c);const v=careerRecordObject(await c.request(root+'/entry',{signal}),['configured','contactEmail','privacyVersion','intentPrivacy','offers']);
  if(typeof v.configured!=='boolean'||v.privacyVersion!==MENTOR_INTENT_PRIVACY_VERSION||v.intentPrivacy!==MENTOR_INTENT_PRIVACY)return fail();
  const offers=array(v.offers,3,parseMentorServiceOffer);
  if(!v.configured&&offers.length || new Set(offers.map(o=>o.kind)).size!==offers.length || new Set(offers.map(o=>o.organizationId)).size>1)return fail();
  current(c);return Object.freeze({configured:v.configured,contactEmail:mentorIntentEmail(v.contactEmail),privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,intentPrivacy:MENTOR_INTENT_PRIVACY,offers});
}
export async function readMentorIntents(c:MentorIntentClient,after:string|null=null,signal?:AbortSignal){
  c=bound(c);current(c);const v=careerRecordObject(await c.request(root+(after!==null?'?after='+careerRecordId(after):''),{signal}),['sessions','nextCursor']);
  const sessions=array(v.sessions,50,v=>owned(c,v)),nextCursor=v.nextCursor===null?null:careerRecordId(v.nextCursor);
  if(new Set(sessions.map(r=>r.id)).size!==sessions.length||sessions.some(r=>r.id===after)||
    nextCursor!==null&&(sessions.length!==50||nextCursor!==sessions.at(-1)!.id))return fail();
  current(c);return Object.freeze({sessions,nextCursor});
}
export interface MentorMutationIntent {
  readonly action:'create'|'cancel';readonly sessionId:string|null;readonly body:Readonly<MentorIntentCommand>|Readonly<{operationId:string;expectedRevision:1}>;
}
export function freezeMentorMutation(input:unknown):Readonly<MentorMutationIntent>{
  const v=careerRecordObject(input,['action','sessionId','body']);
  if(v.action==='create'){
    if(v.sessionId!==null)return fail();return Object.freeze({action:'create',sessionId:null,body:parseMentorIntentCommand(v.body)});
  }
  if(v.action!=='cancel')return fail();
  const b=careerRecordObject(v.body,['operationId','expectedRevision']);if(b.expectedRevision!==1)return fail();
  return Object.freeze({action:'cancel',sessionId:careerRecordId(v.sessionId),body:Object.freeze({operationId:careerRecordId(b.operationId),expectedRevision:1})});
}
export interface MentorIntentResult {
  readonly session:Readonly<MentorIntent>;readonly operation:Readonly<{id:string;sessionId:string;appliedRevision:number;replayed:boolean}>;
}
function result(c:MentorIntentClient,value:unknown,operationId:string):Readonly<MentorIntentResult>{
  const v=careerRecordObject(value,['session','operation']),session=owned(c,v.session),p=careerRecordObject(v.operation,['id','sessionId','appliedRevision','replayed']);
  if(p.id!==operationId||p.sessionId!==session.id||!Number.isSafeInteger(p.appliedRevision)||(p.appliedRevision!==1&&p.appliedRevision!==2)||
    (p.appliedRevision as number)>session.revision||typeof p.replayed!=='boolean')return fail();
  return Object.freeze({session,operation:Object.freeze({id:careerRecordId(p.id),sessionId:careerRecordId(p.sessionId),appliedRevision:p.appliedRevision as number,replayed:p.replayed})});
}
export async function changeMentorIntent(c:MentorIntentClient,input:MentorMutationIntent,signal?:AbortSignal):Promise<Readonly<MentorIntentResult>>{
  c=bound(c);current(c);const intent=freezeMentorMutation(input);
  const response=result(c,await c.request(intent.action==='create'?root:root+'/'+intent.sessionId+'/cancel',
    {method:'POST',body:JSON.stringify(intent.body),signal}),intent.body.operationId);
  if(intent.action==='cancel'&&(response.session.id!==intent.sessionId||response.operation.appliedRevision!==2||response.session.status!=='cancelled'))return fail();
  if(intent.action==='create'){
    const b=intent.body as MentorIntentCommand;
    if(response.operation.appliedRevision!==1||response.session.offerId!==b.offerId||response.session.offerRevision!==b.offerRevision||
      response.session.contactName!==b.contactName||response.session.intentNote!==b.intentNote||response.session.privacyVersion!==b.privacyVersion)return fail();
  }
  current(c);return response;
}
export async function observeMentorIntent(c:MentorIntentClient,input:MentorMutationIntent,signal?:AbortSignal){
  c=bound(c);current(c);const intent=freezeMentorMutation(input),response=result(c,await c.request(root+'/operations/'+intent.body.operationId,{signal}),intent.body.operationId);
  if(!response.operation.replayed)return fail();
  if(intent.action==='cancel'&&(response.session.id!==intent.sessionId||response.operation.appliedRevision!==2||response.session.status!=='cancelled'))return fail();
  if(intent.action==='create'){
    const b=intent.body as MentorIntentCommand;
    if(response.operation.appliedRevision!==1||response.session.offerId!==b.offerId||response.session.offerRevision!==b.offerRevision||
      response.session.contactName!==b.contactName||response.session.intentNote!==b.intentNote)return fail();
  }
  current(c);return response;
}
