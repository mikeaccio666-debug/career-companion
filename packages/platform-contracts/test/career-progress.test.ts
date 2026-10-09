import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCareerProgressSnapshot, CAREER_PROGRESS_KINDS } from '../src/career-progress.ts';
const ownerId = '11111111-1111-4111-8111-111111111111';
const counts = () => Object.fromEntries(CAREER_PROGRESS_KINDS.map(k => [k, 0]));
const fixture = () => ({ ownerId, coverage: ['project', 'application'], progress: { policyRevision: 1, counts: { ...counts(), project: 1 }, provisionalCounts: { ...counts(), project: 2, application: 53 }, milestones: ['first_project_evidence'] } });
test('current evidence snapshot copies and freezes true counts with explicit coverage', () => {
 const v=fixture(),r=parseCareerProgressSnapshot(v);v.progress.counts.project=8;v.coverage.pop();assert.equal(r.progress.counts.project,1);assert.equal(r.progress.provisionalCounts.application,53);assert.equal(r.coverage.length,2);assert(Object.isFrozen(r.progress.counts));assert(Object.isFrozen(r.coverage));assert(Object.isFrozen(r.progress.milestones));
});
test('unsupported evidence, missing sources, contradictory milestones, invalid counts and unknown fields fail closed', () => {
 const v=fixture();
 for(const change of [{policyRevision:2},{counts:{...v.progress.counts,application:1}},{counts:{...v.progress.counts,interview:1}},{provisionalCounts:{...v.progress.provisionalCounts,practice_review:1}},{counts:{...v.progress.counts,project:-1}},{counts:{...v.progress.counts,project:1.5}},{provisionalCounts:{...v.progress.provisionalCounts,application:501}},{counts:{...v.progress.counts,project:500}},{milestones:[]},{milestones:['first_confirmed_application']},{milestones:Array(1)},{score:99}])assert.throws(()=>parseCareerProgressSnapshot({...v,progress:{...v.progress,...change}}));
 for(const change of [{coverage:['project']},{ownerId:'someone'},{extra:true}])assert.throws(()=>parseCareerProgressSnapshot({...v,...change}));
 const getter=fixture();Object.defineProperty(getter.coverage,0,{get(){throw Error('Getter must not run');}});assert.throws(()=>parseCareerProgressSnapshot(getter),/Unsupported progress values/);
 const zero={...v,progress:{...v.progress,counts:counts(),milestones:[]}};assert.equal(parseCareerProgressSnapshot(zero).progress.counts.project,0);
});
