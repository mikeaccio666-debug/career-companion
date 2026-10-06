import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JOB_OUTCOME_REVIEW_HISTORY_LIMIT } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { jobOutcomeEvidence, jobOutcomeWriteEligibility, parseJobOutcomeReviewInput, parseJobOutcomeReviewQuery, type JobOutcomeEvidenceSources } from '../src/job-outcome-reviews.ts';

const input = () => ({ generation: 1, evidenceVersion: 'a'.repeat(64), expectedRevision: 0, requestId: randomUUID(), outcome: 'still_unknown' });
const row = (change: Record<string, unknown> = {}) => ({ generation: 1, kind: 'image', status: 'uncertain', attempt_count: 1, provider: 'synthetic', options: {}, ...change });
const sources = (change: Partial<JobOutcomeEvidenceSources> = {}): JobOutcomeEvidenceSources => ({ attempts: [], relayUncertain: false, ...change });
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'INVALID_INPUT';

test('review input normalizes the request UUID and note without allowing claimed execution facts', () => {
  const base = input(), parsed = parseJobOutcomeReviewInput({ ...base, requestId: base.requestId.toUpperCase(), note: '  Fictional observation\nwith Unicode 🌱  ' });
  assert.equal(parsed.requestId, base.requestId); assert.equal(parsed.note, 'Fictional observation\nwith Unicode 🌱');
  assert.deepEqual(parseJobOutcomeReviewInput({ ...base, note: ' \n ' }), parseJobOutcomeReviewInput(base));
  for (const outcome of ['observed_effect', 'no_effect_observed', 'still_unknown']) assert.equal(parseJobOutcomeReviewInput({ ...base, outcome }).outcome, outcome);
  for (const extra of [{ verified: true }, { status: 'succeeded' }, { userId: randomUUID() }, { providerTaskId: 'fictional' }, { artifactId: randomUUID() }, { provenance: 'server_verified' }]) assert.throws(() => parseJobOutcomeReviewInput({ ...base, ...extra }), invalid);
});
test('input rejects enum coercion, missing fields, unbounded notes and malformed identity or CAS', () => {
  const base = input();
  for (const change of [{ outcome: ['still_unknown'] }, { outcome: 'succeeded' }, { outcome: null }, { generation: '1' }, { generation: 0 }, { generation: 1.5 }, { generation: 2147483648 }, { expectedRevision: -1 }, { expectedRevision: '0' }, { evidenceVersion: ['a'.repeat(64)] }, { evidenceVersion: 'A'.repeat(64) }, { requestId: 'not-a-uuid' }, { requestId: [base.requestId] }, { note: [] }, { note: '\u0000' }, { note: '\ud800' }, { note: 'x'.repeat(2001) }, { note: '🌱'.repeat(1001) }]) assert.throws(() => parseJobOutcomeReviewInput({ ...base, ...change }), invalid);
  assert.equal(parseJobOutcomeReviewInput({ ...base, note: '界'.repeat(2000) }).note?.length, 2000);
  for (const key of Object.keys(base)) { const missing: any = { ...base }; delete missing[key]; assert.throws(() => parseJobOutcomeReviewInput(missing), invalid); }
});
test('query accepts one bounded generation only and never silently chooses a coerced historical version', () => {
  assert.equal(parseJobOutcomeReviewQuery({}), undefined); assert.equal(parseJobOutcomeReviewQuery({ generation: '2' }), 2);
  for (const value of [{ generation: ['1', '2'] }, { generation: 1 }, { generation: '0' }, { generation: '-1' }, { generation: ' 1' }, { generation: '1.0' }, { generation: '2147483648' }, { generation: '1', userId: randomUUID() }, { requestId: randomUUID() }]) assert.throws(() => parseJobOutcomeReviewQuery(value), invalid);
});
test('evidence projects bounded safe fields and hashes private handles without exposing source text', () => {
  const marker = 'fictional-private-value-not-in-public-evidence';
  const saved = sources({ attempts: [{ attempt: 1, status: 'uncertain', provider_task_id: marker, error_code: marker }],
    workflow: { revision: 3, definition_hash: marker, steps: [{ index: 1, inputHash: marker, state: 'uncertain', text: marker }, { index: 0, inputHash: marker, state: 'completed', artifacts: [{ attachmentId: marker }] }] },
    relayUncertain: true });
  const evidence = jobOutcomeEvidence(row({ kind: 'workflow', provider_task_id: marker, error_code: marker, prompt: marker, model: marker, options: { private: marker } }), saved);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(marker)); assert.match(evidence.version, /^[a-f0-9]{64}$/);
  assert.equal(evidence.workflow?.scope, 'task_checkpoint'); assert.deepEqual(evidence.workflow?.steps.map(step => step.index), [0, 1]);
  assert(evidence.reasons.includes('workflow_result_unknown'));
  const changed = jobOutcomeEvidence(row({ kind: 'workflow', provider_task_id: 'another-fictional-handle', error_code: marker }), saved);
  assert.notEqual(evidence.version, changed.version); assert.equal(evidence.hasProviderTask, changed.hasProviderTask);
  const mcp = jobOutcomeEvidence(row({ kind: 'mcp' }), sources({ mcp: { generation: 1, status: 'uncertain', definition_hash: marker, arguments_hash: marker } }));
  assert.equal(mcp.mcp?.generation, 1); assert.doesNotMatch(JSON.stringify(mcp), new RegExp(marker));
});
test('evidence version changes with checkpoint revision, receipt state and lease presence', () => {
  const saved = sources({ browser: { revision: 1, state: 'started', next_index: 0, total_actions: 2, definition_hash: 'b'.repeat(64) } });
  const initial = jobOutcomeEvidence(row({ kind: 'browser' }), saved);
  for (const next of [jobOutcomeEvidence(row({ kind: 'browser', lease_token: randomUUID() }), saved), jobOutcomeEvidence(row({ kind: 'browser' }), sources({ ...saved, browser: { ...saved.browser, revision: 2 } }))]) assert.notEqual(initial.version, next.version);
  assert.notEqual(jobOutcomeEvidence(row({ kind: 'mcp' }), sources({ mcp: { generation: 1, status: 'started' } })).version, jobOutcomeEvidence(row({ kind: 'mcp' }), sources({ mcp: { generation: 1, status: 'uncertain' } })).version);
  assert.equal(jobOutcomeWriteEligibility(initial).allowed, true);
});
test('cleanup, known completion and active jobs remain ineligible while blocked terminal outcomes are recordable', () => {
  for (const status of ['needs_approval', 'queued', 'running', 'succeeded']) assert.deepEqual(jobOutcomeWriteEligibility(jobOutcomeEvidence(row({ status }), sources())), { allowed: false, reason: 'not_reviewable' });
  assert.deepEqual(jobOutcomeWriteEligibility(jobOutcomeEvidence(row({ lease_token: randomUUID() }), sources())), { allowed: false, reason: 'cleanup_pending' });
  assert.deepEqual(jobOutcomeWriteEligibility(jobOutcomeEvidence(row({ lease_until: new Date(Date.now() - 1000) }), sources())), { allowed: false, reason: 'cleanup_pending' });
  assert.equal(jobOutcomeWriteEligibility(jobOutcomeEvidence(row({ status: 'failed' }), sources())).allowed, false);
  for (const current of [row({ status: 'failed', error_code: 'CLI_CLEANUP_UNCONFIRMED', kind: 'cli' }), row({ status: 'cancelled', kind: 'browser', options: { actions: [{}] } }), row({ status: 'failed', kind: 'workflow' })]) assert.equal(jobOutcomeWriteEligibility(jobOutcomeEvidence(current, sources())).allowed, true);
  assert.equal(jobOutcomeWriteEligibility(jobOutcomeEvidence(row({ status: 'failed', kind: 'mcp' }), sources({ mcp: { generation: 1, status: 'tool_error', artifact_id: randomUUID(), response_hash: 'c'.repeat(64) } }))).allowed, true);
});
test('attempt summaries are bounded and damaged arbitrary database states fail safely', () => {
  const attempts = Array.from({ length: JOB_OUTCOME_REVIEW_HISTORY_LIMIT + 1 }, (_, index) => ({ attempt: 30 - index, status: 'uncertain' }));
  const evidence = jobOutcomeEvidence(row({ attempt_count: 30 }), sources({ attempts })); assert.equal(evidence.attempts.length, 20); assert.equal(evidence.attemptsHasMore, true);
  for (const saved of [sources({ attempts: [{ attempt: 1, status: 'arbitrary-private-error' }] }), sources({ workflow: { revision: 1, steps: [{ index: 0, state: 'started' }, { index: 0, state: 'completed' }] } }), sources({ browser: { revision: 1, state: 'started', next_index: 3, total_actions: 2 } }), sources({ mcp: { generation: 2, status: 'started' } })]) assert.throws(() => jobOutcomeEvidence(row(), saved), { code: 'JOB_OUTCOME_EVIDENCE_UNAVAILABLE' });
  assert.throws(() => jobOutcomeEvidence(row({ kind: 'mcp' }), sources({ mcp: { generation: 2, status: 'started' } })), { code: 'JOB_OUTCOME_EVIDENCE_UNAVAILABLE' });
  assert.throws(() => jobOutcomeEvidence(row({ kind: 'workflow' }), sources({ workflow: { revision: 1, steps: [{ index: 0, state: 'started' }, { index: 0, state: 'completed' }] } })), { code: 'JOB_OUTCOME_EVIDENCE_UNAVAILABLE' });
  assert.throws(() => jobOutcomeEvidence(row({ kind: 'browser' }), sources({ browser: { revision: 1, state: 'started', next_index: 3, total_actions: 2 } })), { code: 'JOB_OUTCOME_EVIDENCE_UNAVAILABLE' });
});
