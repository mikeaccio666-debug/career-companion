import { test } from 'node:test';import assert from 'node:assert/strict';
import { RESUME_REVIEW_STATES,type ResumeReviewItem } from '@companion/platform-contracts';import { ownerResumeActionAllowed,RESUME_PENDING_PRESENTATION } from '../src/pending/resume-original.ts';
test('confirmed none-action originals are terminal; edits require a different draft object',()=>{
 const state=(status:ResumeReviewItem['status'],resumeStatus:ResumeReviewItem['resumeStatus']='draft')=>({status,resumeStatus}) as ResumeReviewItem;
 assert(ownerResumeActionAllowed(state('pending'),'edit'));assert(!ownerResumeActionAllowed(state('approved','active'),'edit'));assert(!ownerResumeActionAllowed(state('approved','active'),'decline'));
 assert(ownerResumeActionAllowed(state('expired','archived'),'reopen'));assert(!ownerResumeActionAllowed(state('superseded','archived'),'reopen'));
 assert(ownerResumeActionAllowed(state('approved','active'),'archive'));assert(!ownerResumeActionAllowed(state('approved','archived'),'archive'));
 for(const status of RESUME_REVIEW_STATES)assert(ownerResumeActionAllowed(state(status),'delete'));
});
test('every implemented review enum has the design-system text and neutral/nonnegative tone',()=>{assert.deepEqual(Object.keys(RESUME_PENDING_PRESENTATION).sort(),[...RESUME_REVIEW_STATES].sort());assert.equal(RESUME_PENDING_PRESENTATION.approved.label,'已确认 · 可以用了');assert.equal(RESUME_PENDING_PRESENTATION.approved.tone,'done');});
