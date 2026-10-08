import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENTOR_INTENT_PRIVACY_VERSION,MENTOR_INTENT_PRIVACY,parseMentorIntentCommand } from '@companion/platform-contracts';
import { readMentorEntry,readMentorIntents,changeMentorIntent,observeMentorIntent,freezeMentorMutation,type MentorIntentClient } from '../src/mentor-intent-api.ts';
const owner='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222',id='33333333-3333-3333-3333-333333333333',op='44444444-4444-4444-4444-444444444444',offerId='55555555-5555-5555-5555-555555555555';
const command={operationId:op,offerId,offerRevision:1,contactName:'Fictional student',intentNote:'Fictional note.\nAnother line.',
  privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true};
const record={id,ownerId:owner,organizationId:other,offerId,offerRevision:1,kind:'resume_direction',durationMin:45,contactName:command.contactName,
  contactEmail:'fictional@example.invalid',intentNote:command.intentNote,status:'requested',orderId:null,mentorId:null,privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,
  visibilityConfirmedAt:'2026-10-01T00:00:00.000Z',revision:1,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',lastOperationId:op};
const result={session:record,operation:{id:op,sessionId:id,appliedRevision:1,replayed:false}};
function client(response:unknown):MentorIntentClient{return {account:{accountId:owner},isCurrent:()=>true,async request<T>(){return response as T;}};}
test('mutation freezes a closed explicit privacy choice without inferring consent or allowing email/attachments',()=>{
  const v=freezeMentorMutation({action:'create',sessionId:null,body:command});assert(Object.isFrozen(v)&&Object.isFrozen(v.body));
  command.intentNote='Later fictional editor text';assert.notEqual((v.body as {intentNote:string}).intentNote,command.intentNote);command.intentNote=record.intentNote;
  for(const body of [{...command,confirmVisibility:false},{...command,contactEmail:'other@example.invalid'},{...command,memoryIds:[id]},{...command,privacyVersion:'old'}])
    assert.throws(()=>parseMentorIntentCommand(body));
  assert.throws(()=>freezeMentorMutation({action:'cancel',sessionId:id,body:{operationId:op,expectedRevision:0}}));
});
test('entry accepts truthful unconfigured state and rejects altered privacy, unproven offers, extra fields and stale accounts',async()=>{
  const entry={configured:false,contactEmail:'fictional@example.invalid',privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,intentPrivacy:MENTOR_INTENT_PRIVACY,offers:[]};
  assert.equal((await readMentorEntry(client(entry))).configured,false);
  for(const patch of [{intentPrivacy:'We read your conversations.'},{privacyVersion:'old'},{configured:'false'},{offers:[{}]},{mentorId:other}])
    await assert.rejects(readMentorEntry(client({...entry,...patch})));
  const port=client(entry);port.isCurrent=()=>false;await assert.rejects(readMentorEntry(port));
});
test('owned lists reject foreign records, duplicate IDs, accessors, invalid pagination and closed-record extensions',async()=>{
  assert.equal((await readMentorIntents(client({sessions:[record],nextCursor:null}))).sessions[0].id,id);
  for(const response of [{sessions:[{...record,ownerId:other}],nextCursor:null},{sessions:[record,record],nextCursor:null},
      {sessions:[{...record,orderId:other}],nextCursor:null},{sessions:[record],nextCursor:id},{sessions:[record],nextCursor:null,rawMemory:'Forbidden'}])
    await assert.rejects(readMentorIntents(client(response)));
  let accesses=0;const sessions=[];Object.defineProperty(sessions,'0',{get(){accesses++;return record;},enumerable:true});sessions.length=1;
  await assert.rejects(readMentorIntents(client({sessions,nextCursor:null})));assert.equal(accesses,0);
  await assert.rejects(readMentorIntents(client({sessions:[],nextCursor:null}),''));
});
test('current mutation and original observer reject substituted nonce, offer, record, type and confirmation',async()=>{
  const intent=freezeMentorMutation({action:'create',sessionId:null,body:command});
  assert.equal((await changeMentorIntent(client(result),intent)).session.id,id);
  for(const patch of [{operation:{...result.operation,id:other}},{session:{...record,ownerId:other}},
      {session:{...record,offerRevision:2}},{session:{...record,intentNote:'Substituted note.'}},
      {operation:{...result.operation,appliedRevision:2}},{operation:{...result.operation,replayed:'true'}}])
    await assert.rejects(changeMentorIntent(client({...result,...patch}),intent));
  await assert.rejects(observeMentorIntent(client(result),intent),'observer requires actual original receipt');
  assert.equal((await observeMentorIntent(client({...result,operation:{...result.operation,replayed:true}}),intent)).operation.replayed,true);
});
test('account captured before actual asynchronous response cannot be rebound even by a port claiming current',async()=>{
  const mutable={accountId:owner},intent=freezeMentorMutation({action:'create',sessionId:null,body:command});
  const port:MentorIntentClient={account:mutable,isCurrent:()=>true,async request<T>(){mutable.accountId=other;return {...result,session:{...record,ownerId:other}} as T;}};
  await assert.rejects(changeMentorIntent(port,intent));
  const entry={configured:false,contactEmail:'fictional@example.invalid',privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,intentPrivacy:MENTOR_INTENT_PRIVACY,offers:[]};
  mutable.accountId=owner;port.request=async<T>()=>{mutable.accountId=other;return entry as T;};await assert.rejects(readMentorEntry(port));
});
