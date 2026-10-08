import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APPLICATION_OPEN_STAGES,APPLICATION_CLOSE_REASONS,APPLICATION_OFFER_STATES,type ApplicationStageState} from '@companion/platform-contracts';
import {applicationNeedsPostRejection,planApplicationStageChange} from '../src/application-stage-policy.ts';
const at='2026-10-08T12:00:00.000Z';
const state=(stage:ApplicationStageState['stage']):ApplicationStageState=>({stage,closedReason:null,closedAtStage:null,offerState:stage==='offer'?'written':null,submittedVia:stage==='saved'?null:'user_sends'});
test('every source stage and neutral ending reason follows the authoritative care-window matrix',()=>{
 for(const source of APPLICATION_OPEN_STAGES)for(const closedReason of APPLICATION_CLOSE_REASONS){
  const original=state(source),plan=planApplicationStageChange(original,{stage:'closed',closedReason},at);
  assert.equal(plan.next.closedAtStage,source);assert.equal(plan.next.closedReason,closedReason);assert.equal(plan.next.offerState,null);
  const qualifies=['oa','interview','offer'].includes(source)&&['not_advanced','rescinded'].includes(closedReason);
  assert.equal(applicationNeedsPostRejection(plan.next),qualifies);assert.equal(plan.postRejection!==null,qualifies);
  if(qualifies)assert.deepEqual(plan.postRejection,{kind:'post_rejection',until:'2026-10-10T12:00:00.000Z'});
  assert.deepEqual(original,state(source));assert(Object.isFrozen(plan));assert(Object.isFrozen(plan.next));
 }
});
test('accepted and expired offers stay in offer and do not imply a closed stage or care window',()=>{
 for(const offerState of APPLICATION_OFFER_STATES){const plan=planApplicationStageChange(state('interview'),{stage:'offer',offerState},at);assert.equal(plan.next.stage,'offer');assert.equal(plan.next.offerState,offerState);assert.equal(plan.next.closedReason,null);assert.equal(plan.postRejection,null);}
});
test('same closure and later correction preserve the real original closure stage without renewing the care window',()=>{
 const first=planApplicationStageChange(state('interview'),{stage:'closed',closedReason:'not_advanced'},at);
 const repeated=planApplicationStageChange(first.next,{stage:'closed',closedReason:'not_advanced'},'2026-10-09T12:00:00.000Z');assert.equal(repeated.changed,false);assert.equal(repeated.postRejection,null);assert.equal(repeated.next.closedAtStage,'interview');
 const correction=planApplicationStageChange(first.next,{stage:'closed',closedReason:'rescinded'},'2026-10-09T12:00:00.000Z');assert.equal(correction.changed,true);assert.equal(correction.next.closedAtStage,'interview');assert.equal(correction.postRejection,null);
});
test('explicit factual correction can reopen while prior immutable events belong to the writer',()=>{
 const ended=planApplicationStageChange(state('oa'),{stage:'closed',closedReason:'role_closed'},at);
 const corrected=planApplicationStageChange(ended.next,{stage:'interview'},at);assert.equal(corrected.next.closedReason,null);assert.equal(corrected.next.closedAtStage,null);assert.equal(corrected.next.stage,'interview');assert.equal(corrected.postRejection,null);
 const qualify=planApplicationStageChange(ended.next,{stage:'closed',closedReason:'not_advanced'},at);assert.equal(qualify.next.closedAtStage,'oa');assert(qualify.postRejection);
});
test('choosing a stage never manufactures a submission channel, click receipt or authority',()=>{
 const plan=planApplicationStageChange(state('saved'),{stage:'applied'},at);assert.equal(plan.next.submittedVia,null);
 assert.throws(()=>planApplicationStageChange(state('saved'),{stage:'applied',submittedVia:'extension'},at));
 assert.throws(()=>planApplicationStageChange(state('saved'),{stage:'closed',closedReason:'not_advanced',closedAtStage:'offer'},at));
 for(const bad of ['2026-10-08',null,'invalid','2026-10-08T12:00:00Z'])assert.throws(()=>planApplicationStageChange(state('saved'),{stage:'applied'},bad));
});
