import test from 'node:test';
import assert from 'node:assert/strict';
import { CAREER_SKILLS, careerProgress, careerSkill, prepareCareerRun } from '../src/index.ts';
import type { CareerEvidence, CareerRunContext } from '../src/index.ts';

const context = (overrides: Partial<CareerRunContext> = {}): CareerRunContext => ({ ownerId: 'fictional-owner', profileRevision: 3, inputs: [], tools: { read_profile: 'ready', save_plan_draft: 'ready' }, ...overrides });
const evidence = (overrides: Partial<CareerEvidence> = {}): CareerEvidence => ({ id: 'fixture-receipt-1', ownerId: 'fictional-owner', subjectId: 'fixture-application-1', kind: 'application', state: 'active', verification: 'user_confirmed', referenceId: 'private-fixture-reference', occurredAt: '2026-10-06T12:00:00Z', ...overrides });

test('intake needs no invented profile and exposes only its compiled draft tools', () => {
  const result = prepareCareerRun('career-intake', context({ tools: { read_profile: 'ready', save_plan_draft: 'ready', prepare_application_draft: 'ready' } }));
  assert.equal(result.state, 'ready_for_draft');
  if (result.state !== 'ready_for_draft') return;
  assert.deepEqual(result.tools, ['read_profile', 'save_plan_draft']);
  assert.equal(result.externalActions, 'forbidden');
  assert.equal(result.reviewRequired, true);
  assert.equal(result.maxModelTurns, 6);
  result.tools.pop();
  assert.equal(careerSkill('career-intake').tools.length, 2);
  assert.equal(Object.isFrozen(CAREER_SKILLS), true);
  assert.equal(Object.isFrozen(CAREER_SKILLS[0]!.reviewCriteria), true);
});
test('foreign, stale and withdrawn inputs cannot satisfy a skill', () => {
  for (const override of [{ ownerId: 'different-fictional-owner' }, { state: 'stale' as const }, { state: 'withdrawn' as const }]) {
    const result = prepareCareerRun('evidence-story', context({ inputs: [
      { input: 'profile', id: 'profile-ref', revision: 3, ownerId: 'fictional-owner', state: 'current', ...override },
      { input: 'project-facts', id: 'project-ref', revision: 1, ownerId: 'fictional-owner', state: 'current' },
    ], tools: { read_profile: 'ready', read_evidence: 'ready', save_practice_draft: 'ready' } }));
    assert.equal(result.state, 'blocked');
    if (result.state === 'blocked') assert.deepEqual(result.reasons, ['missing_input:profile']);
  }
});
test('profile changes and conflicting current references require renewed preparation', () => {
  const reference = { input: 'profile' as const, id: 'profile-ref', revision: 2, ownerId: 'fictional-owner', state: 'current' as const };
  const project = { input: 'project-facts' as const, id: 'project-ref', revision: 1, ownerId: 'fictional-owner', state: 'current' as const };
  const tools = { read_profile: 'ready', read_evidence: 'ready', save_practice_draft: 'ready' } as const;
  let result = prepareCareerRun('evidence-story', context({ inputs: [reference, project], tools }));
  assert.equal(result.state, 'blocked');
  if (result.state === 'blocked') assert.ok(result.reasons.includes('profile_revision_changed:profile'));
  result = prepareCareerRun('evidence-story', context({ inputs: [{ ...reference, revision: 3 }, { ...reference, id: 'second-ref', revision: 3 }, project], tools }));
  if (result.state === 'blocked') assert.ok(result.reasons.includes('ambiguous_input:profile')); else assert.fail('Ambiguous data was accepted.');
});
test('missing connectors and invalid authenticated contexts block instead of falling back', () => {
  let result = prepareCareerRun('career-intake', context({ tools: { read_profile: 'requires_connection' } }));
  assert.equal(result.state, 'blocked');
  if (result.state === 'blocked') assert.deepEqual(result.reasons, ['tool_requires_connection:read_profile', 'tool_unavailable:save_plan_draft']);
  for (const override of [{ ownerId: '' }, { profileRevision: 0 }, { profileRevision: 1.5 }]) {
    result = prepareCareerRun('career-intake', context(override));
    assert.equal(result.state, 'blocked');
    if (result.state === 'blocked') assert.ok(result.reasons.includes('invalid_authenticated_context'));
  }
});
test('application preparation remains a draft and snapshots rather than aliases its inputs', () => {
  const inputs: CareerRunContext['inputs'] = ['target-job', 'confirmed-profile', 'reviewed-resume'].map(input => ({ input: input as 'target-job' | 'confirmed-profile' | 'reviewed-resume', id: `fixture-${input}`, revision: 3, ownerId: 'fictional-owner', state: 'current' }));
  const result = prepareCareerRun('application-preparation', context({ inputs, tools: { read_profile: 'ready', read_evidence: 'ready', prepare_application_draft: 'ready' } }));
  assert.equal(result.state, 'ready_for_draft');
  if (result.state !== 'ready_for_draft') return;
  assert.equal(result.externalActions, 'forbidden');
  result.inputs[0]!.id = 'changed-output';
  assert.equal(inputs[0]!.id, 'fixture-target-job');
});
test('email observations and self reports stay provisional rather than earning outcome milestones', () => {
  const result = careerProgress('fictional-owner', [evidence({ verification: 'observed' }), evidence({ id: 'fixture-interview', kind: 'interview', verification: 'self_reported' })]);
  assert.equal(result.counts.application, 0);
  assert.equal(result.provisionalCounts.application, 1);
  assert.equal(result.provisionalCounts.interview, 1);
  assert.deepEqual(result.milestones, []);
});
test('duplicate receipts, email copies and repeated imports count a single application', () => {
  const entries = [evidence(), evidence({ id: 'second-observation' }), evidence({ id: 'third-observation', verification: 'observed' })];
  const result = careerProgress('fictional-owner', entries);
  assert.equal(result.counts.application, 1);
  assert.equal(result.provisionalCounts.application, 0);
  assert.deepEqual(result.milestones, ['first_confirmed_application']);
  assert.deepEqual(careerProgress('fictional-owner', [...entries].reverse()), result);
});
test('withdrawal wins over duplicated active evidence independent of ordering', () => {
  const active = evidence();
  const withdrawn = evidence({ id: 'withdrawn-observation', state: 'withdrawn' });
  for (const entries of [[active, withdrawn], [withdrawn, active]]) assert.equal(careerProgress('fictional-owner', entries).counts.application, 0);
  assert.equal(careerProgress('fictional-owner', [active, evidence({ ownerId: 'different-fictional-owner', state: 'rejected' })]).counts.application, 1);
});
test('missing private references, malformed dates and foreign owners earn no progress', () => {
  const result = careerProgress('fictional-owner', [evidence({ referenceId: undefined }), evidence({ occurredAt: 'bad-date' }), evidence({ ownerId: 'different-fictional-owner' }), evidence({ subjectId: '' })]);
  assert.deepEqual(result.milestones, []);
  assert.equal(result.provisionalCounts.application, 0);
  assert.throws(() => careerProgress(' ', []));
});
test('model or user practice feedback does not claim independently reviewed ability', () => {
  let result = careerProgress('fictional-owner', [evidence({ kind: 'practice_review', verification: 'user_confirmed' })]);
  assert.equal(result.counts.practice_review, 0);
  assert.equal(result.provisionalCounts.practice_review, 1);
  result = careerProgress('fictional-owner', [evidence({ kind: 'practice_review', verification: 'mentor_reviewed', mentorReview: { reviewerId: 'fictional-reviewer', scope: 'practice_review', reviewedAt: '2026-10-06T12:30:00Z', rubricRevision: 'fictional-rubric-v1' } }), evidence({ kind: 'project', verification: 'user_confirmed' })]);
  assert.equal(result.counts.practice_review, 1);
  assert.equal(result.counts.project, 1);
  assert.deepEqual(result.milestones, ['first_project_evidence', 'first_reviewed_practice']);
});
test('mentor review needs identity, matching scope, date and rubric version', () => {
  const review = { reviewerId: 'fictional-reviewer', scope: 'practice_review' as const, reviewedAt: '2026-10-06T12:30:00Z', rubricRevision: 'fictional-rubric-v1' };
  for (const mentorReview of [undefined, { ...review, reviewerId: '' }, { ...review, scope: 'project' as const }, { ...review, reviewedAt: 'bad-date' }, { ...review, rubricRevision: '' }]) {
    const result = careerProgress('fictional-owner', [evidence({ kind: 'practice_review', verification: 'mentor_reviewed', mentorReview })]);
    assert.equal(result.counts.practice_review, 0);
    assert.equal(result.provisionalCounts.practice_review, 1);
  }
});
