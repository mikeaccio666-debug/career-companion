import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentorOperatorArguments } from '../src/mentor-service-files.ts';
import { parseMentorServiceTerms, MENTOR_INTENT_PRIVACY, parseMentorServiceOffer } from '@companion/platform-contracts';
const terms={kind:'resume_direction',title:'Fictional service',durationMin:45,priceCents:9900,currency:'USD',collector:'Fictional collector',
  description:'Fictional purpose.',exclusions:'No outcome promises.',refundVersion:'fictional-refund-1',refundRules:'Fictional rule.',
  appealInstructions:'Fictional appeal.',disclosureVersion:'fictional-disclosure-1',disclosure:'Fictional relationship.',
  validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',earliestSlotAt:null};
test('closed service contracts reject coercion, controls, getters, array inputs and unsupported free/referral kinds',()=>{
  const valid=parseMentorServiceTerms(terms);assert(Object.isFrozen(valid));
  for(const patch of [{priceCents:'9900'},{durationMin:NaN},{priceCents:-0},{currency:'EUR'},{title:'Bad\u202evalue'},
    {title:'Bad\ud800'},{kind:'free_diagnosis'},{kind:'referral_assessment'},{validFrom:'2026-02-30T00:00:00.000Z'},
    {earliestSlotAt:'2027-01-01T00:00:00.000Z'},{collector:'  Fictional collector'}])
    assert.throws(()=>parseMentorServiceTerms({...terms,...patch}));
  let calls=0;const getter={...terms};Object.defineProperty(getter,'title',{get(){calls++;return 'Malicious';},enumerable:true});
  assert.throws(()=>parseMentorServiceTerms(getter));assert.equal(calls,0);assert.throws(()=>parseMentorServiceTerms([terms]));
  const offer={...terms,id:'11111111-1111-1111-1111-111111111111',organizationId:'22222222-2222-2222-2222-222222222222',revision:1,
    updatedAt:'2026-01-01T00:00:00.000Z',availability:'unavailable',intentPrivacy:MENTOR_INTENT_PRIVACY};
  assert.equal(parseMentorServiceOffer(offer).availability,'unavailable');
  for(const patch of [{availability:'available'},{intentPrivacy:'We read your chats.'},{reviewEvidenceRef:offer.id}])
    assert.throws(()=>parseMentorServiceOffer({...offer,...patch}));
});
test('operator command parser requires explicit org and private file paths, and forbids mutations without input',()=>{
  assert.deepEqual(parseMentorOperatorArguments(['list','--org','fictional-org','--session-file','private.json']),
    {action:'list',org:'fictional-org',sessionFile:'private.json',inputFile:undefined});
  for(const args of [['set','--org','fictional-org','--session-file','private.json'],['list','--org','fictional-org','--session-file','private.json','--input-file','secret.json'],
    ['set','--org','a','--org','b','--session-file','x','--input-file','y'],['pay','--org','a','--session-file','x'],['set','--org','a','--session-file','x','--input-file','--token']])
    assert.throws(()=>parseMentorOperatorArguments(args));
});
