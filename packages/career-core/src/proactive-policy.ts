import {careerRecordId as id, careerRecordObject as object} from '@companion/platform-contracts';

export const PROACTIVE_KINDS = Object.freeze(['morning_brief','interview_reminder','deadline_reminder','identity_reminder',
  'user_requested','rejection_letter','parent_report_draft','dormancy_greeting','care_followup'] as const);
export type ProactiveKind = typeof PROACTIVE_KINDS[number];
export const P0_PROACTIVE_KINDS = Object.freeze(['morning_brief','interview_reminder','deadline_reminder',
  'user_requested','dormancy_greeting','care_followup'] as const);
type Channel = 'web' | 'discord';
type Overlay = 'post_rejection' | 'post_crisis' | 'low_mood' | 'sprint';
export interface ProactiveCandidate {
  readonly id:string; readonly ownerId:string; readonly kind:ProactiveKind;
  readonly scheduledFor:string; readonly expiresAt:string|null; readonly eventAt:string|null;
  /** Server classification of the structured reminder, never inferred from free text here. */
  readonly containsTaskContent:boolean;
  readonly entitlement:'free'|'included'|'paid'|'unknown'; readonly sensitivity:'normal'|'sensitive'|'restricted';
}
export interface ProactiveHistoryEntry {
  readonly id:string; readonly ownerId:string; readonly kind:ProactiveKind; readonly candidateIds:readonly string[];
  readonly at:string; readonly channel:Channel; readonly state:'reserved'|'sent'|'uncertain'|'released';
}
/** Internal, complete server facts only; this DTO authenticates no source.
 * Unknown overlays/history must remain unavailable rather than becoming [].
 * History is one row per logical message across channels, including reservations
 * and uncertain sends. 'released' requires confirmed no-send evidence upstream. */
export interface ProactiveInput {
  readonly ownerId:string; readonly now:string; readonly timeZone:string;
  readonly quietStart:string; readonly quietEnd:string; readonly channel:Channel;
  readonly enabledKinds:readonly ProactiveKind[];
  readonly preferences:{
    readonly bornAt:string; readonly firstLetterAt:string|null;
    readonly frequency:'daily'|'alternate'; readonly frequencyAnchorDate:string;
    readonly optedOutDate:string|null; readonly pauseUntil:string|null;
    readonly reminders:'keep'|'off'; readonly dormancy:'active'|'awaiting_greeting'|'quiet';
  };
  readonly overlays:readonly {readonly kind:Overlay;readonly until:string}[];
  readonly history:{readonly from:string;readonly through:string;readonly entries:readonly ProactiveHistoryEntry[]};
  readonly candidates:readonly ProactiveCandidate[];
}
export type ProactiveReason = 'ready'|'disabled'|'first_letter_required'|'birth_day'|'private_content'|'paid_or_unknown'
  |'expired'|'event_passed'|'not_due'|'quiet_hours'|'resting'|'opted_out'|'care_overlay'|'dormant'
  |'not_dormant'|'alternate_day'|'recent_rejection_letter'|'replaces_morning'|'regular_limit'|'exception_limit'
  |'daily_limit'|'already_recorded'|'parent_report_in_morning'|'window_missed';
export interface ProactiveDecision {
  readonly kind:ProactiveKind; readonly candidateIds:readonly string[];
  readonly action:'admit'|'defer'|'suppress'|'merge_next_morning'|'merge_morning'|'already_recorded';
  readonly reason:ProactiveReason; readonly notBefore:string|null;
  /** Deadline/interview reminders retain the reminder, omit preparation tasks. */
  readonly omitPreparation:boolean;
}
export interface ProactivePlan {
  readonly policyRevision:1; readonly ownerId:string; readonly localDate:string; readonly channel:Channel;
  readonly decisions:readonly ProactiveDecision[];
  readonly usage:Readonly<{regular:number;exceptions:number;proposedRegular:number;proposedExceptions:number}>;
}
export class ProactiveInputError extends Error {constructor(){super('The proactive policy sources could not be confirmed.');}}
const fail=():never=>{throw new ProactiveInputError();};
const DAY=86400000, MINUTE=60000;
const exceptions:readonly ProactiveKind[]=['deadline_reminder','interview_reminder','identity_reminder','user_requested'];
const priority:Partial<Record<ProactiveKind,number>>={deadline_reminder:0,interview_reminder:1,identity_reminder:2,user_requested:3};
function choice<T extends string>(value:unknown,values:readonly T[]):T {
  if(typeof value!=='string'||!values.includes(value as T))return fail();return value as T;
}
function instant(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))
    ||new Date(value).toISOString()!==value)return fail();return value;
}
const optionalInstant=(value:unknown)=>value===null?null:instant(value);
function date(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||instant(value+'T00:00:00.000Z').slice(0,10)!==value)return fail();return value;
}
function clock(value:unknown):number {
  if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))return fail();
  const [h,m]=value.split(':').map(Number);return h*60+m;
}
function array<T>(value:unknown,max:number,parse:(v:unknown)=>T):T[] {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return fail();
  const ds=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(ds).length!==value.length+1)return fail();
  return Array.from({length:value.length},(_,i)=>{if(!ds[i]||!('value' in ds[i])||!ds[i].enumerable)return fail();return parse(ds[i].value);});
}
function unique(values:readonly unknown[]){if(new Set(values).size!==values.length)fail();}
function timePolicy(zone:unknown,start:unknown,end:unknown) {
  if(typeof zone!=='string'||zone.length>100||zone.startsWith('+')||zone.startsWith('-'))return fail();
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const quietStart=clock(start),quietEnd=clock(end);if(quietStart===quietEnd)return fail();
  const parts=(at:string)=>Object.fromEntries(format.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const localDate=(at:string)=>{const p=parts(at);return date(p.year+'-'+p.month+'-'+p.day);};
  const isQuiet=(at:string)=>{const p=parts(at),m=Number(p.hour)*60+Number(p.minute);
    return quietStart<quietEnd?m>=quietStart&&m<quietEnd:m>=quietStart||m<quietEnd;};
  const nextAllowed=(now:string)=>{
    // Walk UTC minutes, not nominal 24-hour local days. Both occurrences of a
    // repeated local quiet minute remain quiet; skipped times never become instants.
    for(let at=Math.floor(Date.parse(now)/MINUTE)*MINUTE+MINUTE,stop=at+2*DAY;at<=stop;at+=MINUTE){
      const value=new Date(at).toISOString();if(!isQuiet(value))return value;
    }return fail();
  };
  return {localDate,isQuiet,nextAllowed};
}
function parse(input:unknown) {
  const v=object(input,['ownerId','now','timeZone','quietStart','quietEnd','channel','enabledKinds','preferences','overlays','history','candidates']);
  const ownerId=id(v.ownerId),now=instant(v.now),time=timePolicy(v.timeZone,v.quietStart,v.quietEnd),today=time.localDate(now);
  const channel=choice(v.channel,['web','discord'] as const),enabled=array(v.enabledKinds,PROACTIVE_KINDS.length,x=>choice(x,PROACTIVE_KINDS));unique(enabled);
  const p=object(v.preferences,['bornAt','firstLetterAt','frequency','frequencyAnchorDate','optedOutDate','pauseUntil','reminders','dormancy']);
  const preferences={bornAt:instant(p.bornAt),firstLetterAt:optionalInstant(p.firstLetterAt),frequency:choice(p.frequency,['daily','alternate'] as const),
    frequencyAnchorDate:date(p.frequencyAnchorDate),optedOutDate:p.optedOutDate===null?null:date(p.optedOutDate),pauseUntil:optionalInstant(p.pauseUntil),
    reminders:choice(p.reminders,['keep','off'] as const),dormancy:choice(p.dormancy,['active','awaiting_greeting','quiet'] as const)};
  if(preferences.bornAt>now||preferences.firstLetterAt!==null&&(preferences.firstLetterAt<preferences.bornAt||preferences.firstLetterAt>now))fail();
  const overlays=array(v.overlays,4,value=>{const o=object(value,['kind','until']);return {kind:choice(o.kind,['post_rejection','post_crisis','low_mood','sprint'] as const),until:instant(o.until)};});unique(overlays.map(o=>o.kind));
  const h=object(v.history,['from','through','entries']),from=instant(h.from),through=instant(h.through);
  if(through!==now||Date.parse(from)>Date.parse(now)-7*DAY)fail();
  const history=array(h.entries,10000,value=>{
    const r=object(value,['id','ownerId','kind','candidateIds','at','channel','state']);
    const row={id:id(r.id),ownerId:id(r.ownerId),kind:choice(r.kind,PROACTIVE_KINDS),candidateIds:array(r.candidateIds,1000,id),at:instant(r.at),
      channel:choice(r.channel,['web','discord'] as const),state:choice(r.state,['reserved','sent','uncertain','released'] as const)};
    if(row.ownerId!==ownerId||row.at<from||row.at>through||!row.candidateIds.length||row.kind==='parent_report_draft')fail();
    if(row.kind!=='interview_reminder'&&row.candidateIds.length!==1)fail();unique(row.candidateIds);return row;
  });unique(history.map(r=>r.id));unique(history.filter(r=>r.state!=='released').flatMap(r=>r.candidateIds));
  const candidates=array(v.candidates,1000,value=>{
    const c=object(value,['id','ownerId','kind','scheduledFor','expiresAt','eventAt','containsTaskContent','entitlement','sensitivity']);
    const row={id:id(c.id),ownerId:id(c.ownerId),kind:choice(c.kind,PROACTIVE_KINDS),scheduledFor:instant(c.scheduledFor),expiresAt:optionalInstant(c.expiresAt),
      eventAt:optionalInstant(c.eventAt),containsTaskContent:c.containsTaskContent as boolean,entitlement:choice(c.entitlement,['free','included','paid','unknown'] as const),sensitivity:choice(c.sensitivity,['normal','sensitive','restricted'] as const)};
    if(row.ownerId!==ownerId||row.expiresAt!==null&&row.expiresAt<row.scheduledFor||typeof row.containsTaskContent!=='boolean')fail();
    if(['morning_brief','parent_report_draft'].includes(row.kind)&&!row.containsTaskContent
      ||['care_followup','rejection_letter','dormancy_greeting'].includes(row.kind)&&row.containsTaskContent)fail();
    const needsEvent=['interview_reminder','deadline_reminder','identity_reminder'].includes(row.kind);
    if(needsEvent!==(row.eventAt!==null)||row.eventAt!==null&&row.scheduledFor>=row.eventAt)fail();return row;
  });unique(candidates.map(c=>c.id));
  for(const c of candidates)if(history.some(h=>h.candidateIds.includes(c.id)&&h.kind!==c.kind))fail();
  return {ownerId,now,time,today,channel,enabled:new Set(enabled),preferences,overlays,history,candidates};
}
/** Proposes admissions for one atomic server snapshot; never sends, reserves,
 * schedules, selects content, grants consent or authorizes an external action.
 * The scheduler must authenticate sources, serialize owner-wide reservations,
 * recheck this policy at dispatch, and persist the selected single channel. */
export function canSendProactive(input:ProactiveInput):ProactivePlan {
  let p:ReturnType<typeof parse>;try{p=parse(input);}catch{return fail();}
  const {ownerId,now,time,today,channel,preferences:s}=p;
  const live=p.history.filter(r=>r.state!=='released'),todayHistory=live.filter(r=>time.localDate(r.at)===today);
  const regular=todayHistory.filter(r=>!exceptions.includes(r.kind)).length,exceptionCount=todayHistory.length-regular;
  const paused=s.pauseUntil!==null&&s.pauseUntil>now,optedOut=s.optedOutDate===today;
  const activeOverlays=p.overlays.filter(o=>o.until>now);
  const care=activeOverlays.some(o=>['post_rejection','post_crisis'].includes(o.kind));
  const crisis=activeOverlays.some(o=>o.kind==='post_crisis');
  const decisions:ProactiveDecision[]=[],eligible:ProactiveCandidate[]=[];
  const decision=(rows:readonly ProactiveCandidate[],action:ProactiveDecision['action'],reason:ProactiveReason,notBefore:string|null=null)=>{
    const kind=rows[0].kind,keep=['interview_reminder','deadline_reminder'].includes(kind);
    decisions.push(Object.freeze({kind,candidateIds:Object.freeze(rows.map(c=>c.id).sort()),action,reason,notBefore,
      omitPreparation:keep&&(activeOverlays.length>0||paused||optedOut)}));
  };
  for(const c of [...p.candidates].sort((a,b)=>a.scheduledFor.localeCompare(b.scheduledFor)||a.id.localeCompare(b.id))) {
    const row=[c],keptReminder=['interview_reminder','deadline_reminder'].includes(c.kind);
    if(live.some(r=>r.candidateIds.includes(c.id))){decision(row,'already_recorded','already_recorded');continue;}
    let reason:ProactiveReason|null=null;
    if(!p.enabled.has(c.kind))reason='disabled';
    else if(s.firstLetterAt===null&&['morning_brief','parent_report_draft'].includes(c.kind))reason='first_letter_required';
    else if(c.sensitivity!=='normal')reason='private_content';
    else if(!['free','included'].includes(c.entitlement))reason='paid_or_unknown';
    else if(c.expiresAt!==null&&c.expiresAt<=now)reason='expired';
    else if(c.eventAt!==null&&c.eventAt<=now)reason='event_passed';
    else if(s.dormancy==='quiet'||s.dormancy==='awaiting_greeting'&&c.kind!=='dormancy_greeting')reason='dormant';
    else if(s.dormancy==='active'&&c.kind==='dormancy_greeting')reason='not_dormant';
    else if(paused&&(!keptReminder||s.reminders==='off'))reason='resting';
    else if(optedOut&&(c.containsTaskContent&&!keptReminder||keptReminder&&s.reminders==='off'))reason='opted_out';
    else if(care&&c.containsTaskContent&&!keptReminder&&c.kind!=='parent_report_draft'
      ||crisis&&c.kind==='parent_report_draft')reason='care_overlay';
    else if(c.kind==='morning_brief'&&time.localDate(s.bornAt)===today)reason='birth_day';
    else if(c.kind==='morning_brief'&&s.frequency==='alternate'
      &&(today<s.frequencyAnchorDate||(Date.parse(today)-Date.parse(s.frequencyAnchorDate))/DAY%2!==0))reason='alternate_day';
    else if(c.kind==='rejection_letter'&&live.some(r=>r.kind===c.kind&&Date.parse(r.at)>Date.parse(now)-7*DAY))reason='recent_rejection_letter';
    if(reason){decision(row,'suppress',reason);continue;}
    if(c.scheduledFor>now){decision(row,'defer','not_due',c.scheduledFor);continue;}
    eligible.push(c);
  }
  // A qualified rejection letter replaces, rather than accompanies, the morning.
  const hasRejection=eligible.some(c=>c.kind==='rejection_letter');
  const groups:ProactiveCandidate[][]=[],interviews=eligible.filter(c=>c.kind==='interview_reminder');
  for(const c of eligible){
    if(c.kind==='morning_brief'&&hasRejection){decision([c],'suppress','replaces_morning');continue;}
    if(c.kind==='parent_report_draft'){decision([c],'merge_morning','parent_report_in_morning');continue;}
    if(c.kind==='interview_reminder')continue;groups.push([c]);
  }
  if(interviews.length)groups.push(interviews);
  groups.sort((a,b)=>(priority[a[0].kind]??(a[0].kind==='rejection_letter'?4:5))-(priority[b[0].kind]??(b[0].kind==='rejection_letter'?4:5))
    ||a[0].scheduledFor.localeCompare(b[0].scheduledFor)||a[0].id.localeCompare(b[0].id));
  let proposedRegular=0,proposedExceptions=0;
  const quietUntil=time.isQuiet(now)?time.nextAllowed(now):null;
  for(const rows of groups){
    const kind=rows[0].kind,isException=exceptions.includes(kind);
    if(quietUntil){
      const valid=rows.filter(c=>!(c.expiresAt!==null&&c.expiresAt<=quietUntil||c.eventAt!==null&&c.eventAt<=quietUntil));
      for(const c of rows)if(!valid.includes(c))decision([c],'suppress','window_missed');
      if(valid.length)decision(valid,'defer','quiet_hours',quietUntil);continue;
    }
    if(kind==='interview_reminder'&&todayHistory.some(h=>h.kind===kind)){
      decision(rows,'merge_next_morning','exception_limit');continue;
    }
    if(regular+exceptionCount+proposedRegular+proposedExceptions>=3){decision(rows,'merge_next_morning','daily_limit');continue;}
    if(isException&&exceptionCount+proposedExceptions>=2){decision(rows,'merge_next_morning','exception_limit');continue;}
    if(!isException&&regular+proposedRegular>=1){decision(rows,'merge_next_morning','regular_limit');continue;}
    decision(rows,'admit','ready');if(isException)proposedExceptions++;else proposedRegular++;
  }
  return Object.freeze({policyRevision:1,ownerId,localDate:today,channel,decisions:Object.freeze(decisions),
    usage:Object.freeze({regular,exceptions:exceptionCount,proposedRegular,proposedExceptions})});
}
