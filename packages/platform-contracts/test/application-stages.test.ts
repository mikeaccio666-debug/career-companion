import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {APPLICATION_STAGES,APPLICATION_OPEN_STAGES,APPLICATION_CLOSE_REASONS,APPLICATION_OFFER_STATES,APPLICATION_STAGE_LABELS,APPLICATION_CLOSE_REASON_LABELS,APPLICATION_OFFER_STATE_LABELS,parseApplicationStageChoice,parseApplicationStageCommand,parseApplicationStageState} from '../src/application-stages.ts';
const saved={stage:'saved',closedReason:null,closedAtStage:null,offerState:null,submittedVia:null};
const command=()=>({operationId:randomUUID(),expectedRevision:1,stage:'applied'});
test('owner stage choices are closed and cannot declare attribution, source stage, time or tool authority',()=>{
 assert.deepEqual(parseApplicationStageCommand(command()).stage,'applied');
 for(const extra of [{ownerId:randomUUID()},{closedAtStage:'offer'},{submittedVia:'extension'},{receiptId:randomUUID()},{actor:'expert:applier'},{confirmedAt:'2026-10-08T00:00:00.000Z'},{authorized:true}])assert.throws(()=>parseApplicationStageCommand({...command(),...extra}));
 for(const expectedRevision of [0,-0,-1,1.5,Infinity,NaN,2147483648,'1'])assert.throws(()=>parseApplicationStageCommand({...command(),expectedRevision}));
 let touched=false;assert.throws(()=>parseApplicationStageCommand({...command(),get stage(){touched=true;return 'applied';}}));assert.equal(touched,false);
 const hidden=Object.defineProperty(command(),'hidden',{value:true});assert.throws(()=>parseApplicationStageCommand(hidden));
 assert.throws(()=>parseApplicationStageCommand({...command(),[Symbol('extra')]:true}));assert.throws(()=>parseApplicationStageCommand(Object.assign(Object.create({inherited:true}),command())));
});
test('closed and offer choices require their own explicit value and reject ambiguous metadata',()=>{
 for(const closedReason of APPLICATION_CLOSE_REASONS)assert.deepEqual(parseApplicationStageChoice({stage:'closed',closedReason}),{stage:'closed',closedReason});
 for(const offerState of APPLICATION_OFFER_STATES)assert.deepEqual(parseApplicationStageChoice({stage:'offer',offerState}),{stage:'offer',offerState});
 for(const value of [{stage:'closed'},{stage:'closed',closedReason:null},{stage:'closed',closedReason:'not_advanced',offerState:'written'},{stage:'offer'},{stage:'offer',offerState:'written',closedReason:'declined'},{stage:'applied',offerState:null},{stage:'interview',closedReason:null},{stage:'fabricated_stage'}])assert.throws(()=>parseApplicationStageChoice(value));
});
test('persisted states require coherent closure and offer fields and never turn saved into submitted',()=>{
 assert.deepEqual(parseApplicationStageState(saved),saved);
 for(const value of [{...saved,closedReason:'not_advanced'},{...saved,closedAtStage:'saved'},{...saved,offerState:'accepted'},{...saved,submittedVia:'extension'},{...saved,stage:'closed',closedReason:'not_advanced',closedAtStage:'closed'},{...saved,stage:'offer'},{...saved,stage:'closed',closedReason:'not_advanced',closedAtStage:'offer',offerState:'accepted'}])assert.throws(()=>parseApplicationStageState(value));
 assert.equal(parseApplicationStageState({...saved,stage:'applied'}).submittedVia,null,'A value codec cannot invent a verified channel.');
});
test('all specified state labels exist and immutable collections cannot drift independently',()=>{
 assert.deepEqual(Object.keys(APPLICATION_STAGE_LABELS),[...APPLICATION_STAGES]);
 assert.deepEqual(Object.keys(APPLICATION_CLOSE_REASON_LABELS),[...APPLICATION_CLOSE_REASONS]);
 assert.deepEqual(Object.keys(APPLICATION_OFFER_STATE_LABELS),[...APPLICATION_OFFER_STATES]);
 assert.equal(APPLICATION_STAGE_LABELS.closed,'已结束');
 for(const v of [APPLICATION_STAGES,APPLICATION_OPEN_STAGES,APPLICATION_CLOSE_REASONS,APPLICATION_OFFER_STATES,APPLICATION_STAGE_LABELS,APPLICATION_CLOSE_REASON_LABELS,APPLICATION_OFFER_STATE_LABELS])assert(Object.isFrozen(v));
});
