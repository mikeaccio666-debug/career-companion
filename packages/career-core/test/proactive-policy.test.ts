import assert from 'node:assert/strict';
import test from 'node:test';
import {canSendProactive,PROACTIVE_KINDS,P0_PROACTIVE_KINDS,ProactiveInputError,
  type ProactiveInput,type ProactiveCandidate,type ProactiveKind,type ProactiveHistoryEntry} from '../src/proactive-policy.ts';
const owner='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
let sequence=100;
const uuid=()=> '00000000-0000-4000-8000-'+String(sequence++).padStart(12,'0');
function fixture(now='2026-10-09T16:00:00.000Z'):ProactiveInput {
 return {ownerId:owner,now,timeZone:'America/New_York',quietStart:'22:30',quietEnd:'08:30',channel:'web',enabledKinds:[...P0_PROACTIVE_KINDS],
  preferences:{bornAt:'2026-01-01T12:00:00.000Z',firstLetterAt:'2026-01-01T13:00:00.000Z',frequency:'daily',frequencyAnchorDate:'2026-10-09',
   optedOutDate:null,pauseUntil:null,reminders:'keep',dormancy:'active'},overlays:[],
  history:{from:new Date(Date.parse(now)-8*86400000).toISOString(),through:now,entries:[]},candidates:[]};
}
function candidate(f:ProactiveInput,kind:ProactiveKind,patch:Partial<ProactiveCandidate>={}):ProactiveCandidate {
 return {id:uuid(),ownerId:owner,kind,scheduledFor:new Date(Date.parse(f.now)-60000).toISOString(),expiresAt:null,
  eventAt:['interview_reminder','deadline_reminder','identity_reminder'].includes(kind)?new Date(Date.parse(f.now)+86400000).toISOString():null,
  containsTaskContent:['morning_brief','parent_report_draft','user_requested'].includes(kind),sensitivity:'normal',entitlement:'free',...patch};
}
function history(f:ProactiveInput,kind:ProactiveKind,patch:Partial<ProactiveHistoryEntry>={}):ProactiveHistoryEntry {
 return {id:uuid(),ownerId:owner,kind,candidateIds:[uuid()],at:f.now,channel:'discord',state:'sent',...patch};
}
const decision=(f:ProactiveInput,kind:ProactiveKind)=>canSendProactive({...f,candidates:[candidate(f,kind)]}).decisions[0];
test('one regular plus two exception messages share one cross-channel daily quota; output is immutable metadata',()=>{
 const f=fixture(),items=['morning_brief','care_followup','deadline_reminder','interview_reminder','user_requested'].map(k=>candidate(f,k as ProactiveKind));
 const result=canSendProactive({...f,candidates:items});
 assert.equal(result.decisions.filter(d=>d.action==='admit').length,3);assert.deepEqual(result.usage,{regular:0,exceptions:0,proposedRegular:1,proposedExceptions:2});
 assert.equal(result.channel,'web');assert(Object.isFrozen(result.decisions));assert(Object.isFrozen(result.decisions[0].candidateIds));assert(Object.isFrozen(result.usage));
 assert(!JSON.stringify(result).includes('entitlement'));assert(!JSON.stringify(result).includes('scheduledFor'));
});
test('deadline precedes interview then identity then user request independent of candidate input order',()=>{
 const f={...fixture(),enabledKinds:[...PROACTIVE_KINDS]},items=['user_requested','identity_reminder','interview_reminder','deadline_reminder'].map(k=>candidate(f,k as ProactiveKind));
 const one=canSendProactive({...f,candidates:items}),two=canSendProactive({...f,candidates:[...items].reverse()});
 assert.deepEqual(one,two);assert.deepEqual(one.decisions.filter(d=>d.action==='admit').map(d=>d.kind),['deadline_reminder','interview_reminder']);
 assert(one.decisions.filter(d=>d.action!=='admit').every(d=>d.action==='merge_next_morning'));
});
test('multiple due interviews merge into one proposal; a previously recorded interview reminder cannot become a second send',()=>{
 const f=fixture(),a=candidate(f,'interview_reminder'),b=candidate(f,'interview_reminder'),c=candidate(f,'deadline_reminder');
 const result=canSendProactive({...f,candidates:[a,b,c]});assert.equal(result.usage.proposedExceptions,2);
 assert.deepEqual(result.decisions.find(d=>d.kind==='interview_reminder')?.candidateIds,[a.id,b.id].sort());
 const prior=history(f,'interview_reminder',{candidateIds:[a.id]});
 const again=canSendProactive({...f,history:{...f.history,entries:[prior]},candidates:[a,b]});
 assert.equal(again.decisions.find(d=>d.candidateIds.includes(a.id))?.action,'already_recorded');
 assert.equal(again.decisions.find(d=>d.candidateIds.includes(b.id))?.action,'merge_next_morning');
});
test('reserved and uncertain sends consume quota across channels, while a proven release permits a fresh proposal',()=>{
 const f=fixture();
 for(const state of ['reserved','sent','uncertain'] as const){
  const row=history(f,'morning_brief',{state});const result=decision({...f,history:{...f.history,entries:[row]}},'care_followup');
  assert.equal(result.reason,'regular_limit');
 }
 const row=history(f,'morning_brief',{state:'released'});assert.equal(decision({...f,history:{...f.history,entries:[row]}},'care_followup').action,'admit');
 const full=[history(f,'morning_brief'),history(f,'deadline_reminder'),history(f,'user_requested')];
 assert.equal(decision({...f,history:{...f.history,entries:full}},'care_followup').reason,'daily_limit');
});
test('quota dates are local calendar days, not UTC dates or elapsed 24 hours',()=>{
 const f=fixture('2026-10-10T03:00:00.000Z'),row=history(f,'care_followup',{at:'2026-10-09T13:00:00.000Z'});
 const base={...f,quietStart:'23:30',quietEnd:'08:30',history:{...f.history,entries:[row]}};
 assert.equal(decision(base,'care_followup').reason,'regular_limit');
 const next=fixture('2026-10-10T12:30:00.000Z');assert.equal(decision({...next,history:{...next.history,entries:[row]}},'care_followup').action,'admit');
});
test('quiet hours defer regular and exception messages at exact boundaries without reserving quota',()=>{
 const f=fixture('2026-10-10T02:30:00.000Z');
 for(const kind of ['care_followup','deadline_reminder'] as const){const d=decision(f,kind);assert.equal(d.action,'defer');assert.equal(d.notBefore,'2026-10-10T12:30:00.000Z');}
 assert.equal(decision(fixture('2026-10-10T12:30:00.000Z'),'care_followup').action,'admit');
 const day={...fixture('2026-10-09T18:00:00.000Z'),quietStart:'13:00',quietEnd:'15:00'};
 assert.equal(decision(day,'care_followup').notBefore,'2026-10-09T19:00:00.000Z');
});
test('spring gaps and both occurrences of a fall-back quiet minute use actual instants',()=>{
 const spring={...fixture('2026-03-08T06:50:00.000Z'),quietEnd:'02:30'};
 assert.equal(decision(spring,'care_followup').notBefore,'2026-03-08T07:00:00.000Z');
 for(const hour of ['05','06']){const fall={...fixture('2026-11-01T'+hour+':10:00.000Z'),quietEnd:'01:30'};
  assert.equal(decision(fall,'care_followup').notBefore,'2026-11-01T'+hour+':30:00.000Z');}
});
test('quiet deferral drops reminders whose actual event or validity ends before delivery, retaining other merged events',()=>{
 const f=fixture('2026-10-10T02:30:00.000Z'),early=candidate(f,'interview_reminder',{eventAt:'2026-10-10T12:00:00.000Z'}),later=candidate(f,'interview_reminder',{eventAt:'2026-10-10T14:00:00.000Z'});
 const r=canSendProactive({...f,candidates:[early,later]});
 assert.equal(r.decisions.find(d=>d.candidateIds.includes(early.id))?.reason,'window_missed');
 assert.equal(r.decisions.find(d=>d.candidateIds.includes(later.id))?.notBefore,'2026-10-10T12:30:00.000Z');
});
test('rest suppresses other proactive messages but keeps interview/deadline reminders without preparation until all-off',()=>{
 const f=fixture(),rest={...f,preferences:{...f.preferences,pauseUntil:'2026-10-10T16:00:00.000Z'}};
 for(const kind of ['morning_brief','care_followup','user_requested'] as const)assert.equal(decision(rest,kind).reason,'resting');
 for(const kind of ['interview_reminder','deadline_reminder'] as const){const d=decision(rest,kind);assert.equal(d.action,'admit');assert.equal(d.omitPreparation,true);
  assert.equal(decision({...rest,preferences:{...rest.preferences,reminders:'off'}},kind).reason,'resting');}
 assert.equal(decision({...rest,preferences:{...rest.preferences,pauseUntil:f.now,reminders:'off'}},'deadline_reminder').action,'admit');
});
test('today opt-out suppresses task reminders and morning content; a new local day does not inherit it',()=>{
 const f=fixture(),rest={...f,preferences:{...f.preferences,optedOutDate:'2026-10-09'}};
 assert.equal(decision(rest,'morning_brief').reason,'opted_out');assert.equal(decision(rest,'user_requested').reason,'opted_out');
 assert.equal(decision(rest,'deadline_reminder').omitPreparation,true);
 assert.equal(decision({...rest,preferences:{...rest.preferences,optedOutDate:'2026-10-08'}},'morning_brief').action,'admit');
});
test('rejection and crisis overlays suppress tasks even with sprint, but retain care and stripped reminders',()=>{
 const f=fixture();
 for(const kind of ['post_rejection','post_crisis'] as const){
  const state={...f,overlays:[{kind,until:'2026-10-11T16:00:00.000Z'},{kind:'sprint' as const,until:'2026-10-12T16:00:00.000Z'}]};
  assert.equal(decision(state,'morning_brief').reason,'care_overlay');assert.equal(decision(state,'interview_reminder').action,'admit');
  assert.equal(decision(state,'interview_reminder').omitPreparation,true);assert.equal(decision(state,'care_followup').action,'admit');
 }
 assert.equal(decision({...f,overlays:[{kind:'post_crisis',until:f.now}]},'morning_brief').action,'admit');
 assert.equal(decision({...f,overlays:[{kind:'low_mood',until:'2026-10-11T16:00:00.000Z'}]},'morning_brief').action,'admit');
});
test('alternate frequency uses anchored local dates across DST and does not suppress requested reminders',()=>{
 const f=fixture('2026-11-01T14:00:00.000Z'),state={...f,preferences:{...f.preferences,frequency:'alternate' as const,frequencyAnchorDate:'2026-10-31'}};
 assert.equal(decision(state,'morning_brief').reason,'alternate_day');assert.equal(decision(state,'deadline_reminder').action,'admit');
 const next=fixture('2026-11-02T14:00:00.000Z');assert.equal(decision({...next,preferences:{...state.preferences}},'morning_brief').action,'admit');
});
test('morning requires the first letter and next local birth day without blocking independent care',()=>{
 const f=fixture();assert.equal(decision({...f,preferences:{...f.preferences,firstLetterAt:null}},'morning_brief').reason,'first_letter_required');
 assert.equal(decision({...f,preferences:{...f.preferences,firstLetterAt:null}},'care_followup').action,'admit');
 const born={...f,preferences:{...f.preferences,bornAt:'2026-10-09T12:00:00.000Z',firstLetterAt:'2026-10-09T13:00:00.000Z'}};
 assert.equal(decision(born,'morning_brief').reason,'birth_day');assert.equal(decision(born,'deadline_reminder').action,'admit');
});
test('dormancy allows one greeting phase, then remains quiet until the real state changes',()=>{
 const f=fixture(),awaiting={...f,preferences:{...f.preferences,dormancy:'awaiting_greeting' as const}};
 assert.equal(decision(awaiting,'dormancy_greeting').action,'admit');assert.equal(decision(awaiting,'deadline_reminder').reason,'dormant');
 const quiet={...f,preferences:{...f.preferences,dormancy:'quiet' as const}};
 for(const kind of P0_PROACTIVE_KINDS)assert.equal(decision(quiet,kind).reason,'dormant');
 assert.equal(decision(f,'dormancy_greeting').reason,'not_dormant');
});
test('future kinds stay disabled in P0; when explicitly enabled rejection letters replace morning and respect rolling seven days',()=>{
 const f=fixture();assert.equal(decision(f,'rejection_letter').reason,'disabled');
 const enabled={...f,enabledKinds:[...PROACTIVE_KINDS]},morning=candidate(f,'morning_brief'),letter=candidate(f,'rejection_letter');
 const r=canSendProactive({...enabled,candidates:[morning,letter]});
 assert.equal(r.decisions.find(d=>d.kind==='morning_brief')?.reason,'replaces_morning');assert.equal(r.usage.proposedRegular,1);
 for(const delta of [7*86400000-1,7*86400000]){const previous=history(f,'rejection_letter',{at:new Date(Date.parse(f.now)-delta).toISOString()});
  assert.equal(decision({...enabled,history:{...f.history,entries:[previous]}},'rejection_letter').action,delta<7*86400000?'suppress':'admit');}
});
test('parent reports fold into morning without a separate quota slot; crisis suspends even that proposal',()=>{
 const f={...fixture(),enabledKinds:[...PROACTIVE_KINDS]};
 const r=canSendProactive({...f,candidates:[candidate(f,'parent_report_draft'),candidate(f,'morning_brief')]});
 assert.equal(r.usage.proposedRegular,1);assert.equal(r.decisions.find(d=>d.kind==='parent_report_draft')?.action,'merge_morning');
 assert.equal(decision({...f,overlays:[{kind:'post_crisis',until:'2026-10-10T16:00:00.000Z'}]},'parent_report_draft').reason,'care_overlay');
 assert.equal(decision({...f,overlays:[{kind:'post_rejection',until:'2026-10-10T16:00:00.000Z'}]},'parent_report_draft').action,'merge_morning');
});
test('paid, unknown, private, expired, past-event and not-yet-due candidates never enter an admission group',()=>{
 const f=fixture();
 for(const patch of [{entitlement:'paid'},{entitlement:'unknown'},{sensitivity:'sensitive'},{sensitivity:'restricted'},{expiresAt:f.now}]){
  const r=canSendProactive({...f,candidates:[candidate(f,'care_followup',patch as any)]});assert.equal(r.decisions[0].action,'suppress');}
 const late=candidate(f,'deadline_reminder',{eventAt:f.now});assert.equal(canSendProactive({...f,candidates:[late]}).decisions[0].reason,'event_passed');
 const later=candidate(f,'care_followup',{scheduledFor:'2026-10-10T16:00:00.000Z'});assert.equal(canSendProactive({...f,candidates:[later]}).decisions[0].notBefore,later.scheduledFor);
});
test('incomplete, foreign, malformed, duplicate or caller-expanded sources fail closed without reading accessors',()=>{
 const f=fixture(),c=candidate(f,'morning_brief'),h=history(f,'morning_brief');
 const bad:any[]=[{...f,overlays:null},{...f,quietStart:f.quietEnd},{...f,timeZone:'fictional/zone'},
  {...f,history:{...f.history,from:f.now}},{...f,history:{...f.history,through:'2026-10-09T15:59:59.000Z'}},
  {...f,candidates:[{...c,ownerId:foreign}]},{...f,candidates:[c,c]},{...f,history:{...f.history,entries:[h,{...h,id:uuid()}]}},
  {...f,candidates:[{...c,body:'not allowed'}]},{...f,history:{...f.history,entries:[{...h,ownerId:foreign}]}},
  {...f,candidates:[{...c,eventAt:f.now}]},{...f,enabledKinds:['made_up']},{...f,preferences:{...f.preferences,firstLetterAt:'2027-01-01T00:00:00.000Z'}}];
 for(const value of bad)assert.throws(()=>canSendProactive(value),ProactiveInputError);
 let read=false;const getter={...f};Object.defineProperty(getter,'overlays',{get(){read=true;return [];}});
 assert.throws(()=>canSendProactive(getter),ProactiveInputError);assert.equal(read,false);
 const sparse={...f,candidates:new Array(1)};assert.throws(()=>canSendProactive(sparse),ProactiveInputError);
});


test('user-requested reminders preserve non-task meaning while crisis and opted-out days suppress task content',()=>{
 const f=fixture(),task=candidate(f,'user_requested'),reminder=candidate(f,'user_requested',{containsTaskContent:false});
 for(const state of [{...f,preferences:{...f.preferences,optedOutDate:'2026-10-09'}},
  {...f,overlays:[{kind:'post_crisis' as const,until:'2026-10-11T16:00:00.000Z'}]}]){
  const r=canSendProactive({...state,candidates:[task,reminder]});
  assert.equal(r.decisions.find(d=>d.candidateIds.includes(task.id))?.action,'suppress');
  assert.equal(r.decisions.find(d=>d.candidateIds.includes(reminder.id))?.action,'admit');
 }
 for(const bad of [candidate(f,'morning_brief',{containsTaskContent:false}),candidate(f,'care_followup',{containsTaskContent:true}),
  candidate(f,'user_requested',{containsTaskContent:null as any})])assert.throws(()=>canSendProactive({...f,candidates:[bad]}),ProactiveInputError);
});

test('all active overlay kinds remove preparation from kept reminders, without turning low mood into a task pause',()=>{
 const f=fixture();
 for(const kind of ['low_mood','sprint'] as const){
  const state={...f,overlays:[{kind,until:'2026-10-11T16:00:00.000Z'}]};
  for(const reminder of ['interview_reminder','deadline_reminder'] as const){
   assert.equal(decision(state,reminder).action,'admit');
   assert.equal(decision(state,reminder).omitPreparation,true);
  }
  assert.equal(decision(state,'morning_brief').action,'admit');
  assert.equal(decision({...f,overlays:[{kind,until:f.now}]},'interview_reminder').omitPreparation,false);
 }
});
