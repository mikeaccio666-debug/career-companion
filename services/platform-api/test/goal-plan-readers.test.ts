import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JOB_KINDS } from '@companion/platform-contracts';
import { GoalPlanReaders, GOAL_PLAN_READER_MAX_BYTES, goalPlanReaderText, parseGoalPlanListInput, parseGoalPlanReadInput, projectGoalPlanReaderStep } from '../src/goal-plan-readers.ts';

const origin = { conversationId: randomUUID(), messageId: randomUUID() }, userId = randomUUID(), planId = randomUUID();
const when = new Date('2026-01-01T00:00:00Z');
const plan = (count = 1) => ({ id: planId, conversation_id: origin.conversationId, revision: 1, title: 'Fictional saved plan', status: 'draft', step_count: count, created_at: when, updated_at: when });
const step = (kind = 'image', index = 0) => ({ step_index: index, kind: 'task', task_kind: kind, job_id: null, job_generation: null, message_id: null, bound_at: null,
  receipt_present: false, receipt_kind: null, receipt_artifact_count: 0, receipt_artifact_ids: [], available_artifact_count: 0,
  title: 'Fictional step', provider: 'unconfigured', model: 'fictional-model', selected_text: 'Fictional task prompt', selected_text_characters: 21,
  static_attachment_count: 0, binding_count: 0, rawSecret: 'Never project this synthetic secret', options: { privateUrl: 'https://private.example.invalid' } });

function fake(rows: any[], plans = [plan(rows.length)], hook?: (sql: string) => void) {
  const queries: string[] = [];
  const db = { async transaction<T>(run: (client: any) => Promise<T>) {
    return run({ async query(sql: string) {
      queries.push(sql); hook?.(sql);
      if (sql.includes('FROM platform_goal_plans p JOIN')) return { rows: plans, rowCount: plans.length };
      if (sql.includes('SELECT left(goal')) return { rows: [{ goal_text: '\\"\n😀'.repeat(1536), goal_characters: 8000 }], rowCount: 1 };
      if (sql.startsWith('SELECT s.step_index')) return { rows, rowCount: rows.length };
      return { rows: [{ id: randomUUID() }], rowCount: 1 };
    } });
  } };
  return { readers: new GoalPlanReaders(db), queries };
}

test('reader arguments bind only an explicit current plan revision, never caller-supplied origin or execution fields', () => {
  assert.deepEqual(parseGoalPlanReadInput({ planId: planId.toUpperCase(), revision: 1, stepIndex: 0 }), { planId, revision: 1, stepIndex: 0 });
  parseGoalPlanListInput({});
  for (const value of [{ planId }, { planId, revision: '1' }, { planId, revision: [1] }, { planId, revision: 0 }, { planId, revision: 1, stepIndex: 8 }, { planId, revision: 1, userId }, { planId, revision: 1, conversationId: origin.conversationId }]) assert.throws(() => parseGoalPlanReadInput(value), { code: 'INVALID_INPUT' });
  for (const value of [[], { before: planId }, { limit: 50 }, { approve: true }, { messageId: origin.messageId }]) assert.throws(() => parseGoalPlanListInput(value), { code: 'INVALID_INPUT' });
});
test('text budgets account for Unicode and JSON escaping and always disclose omitted content', () => {
  for (const value of ['😀中'.repeat(2000), '\\"\n\t'.repeat(2000)]) {
    const result = goalPlanReaderText(value, Array.from(value).length, 1024);
    assert(Buffer.byteLength(JSON.stringify(result.text), 'utf8') <= 1024); assert(result.truncated); assert.equal(result.totalCharacters, Array.from(value).length);
    assert(!/[\uD800-\uDBFF]$/.test(result.text)); assert(value.startsWith(result.text));
  }
  assert.deepEqual(goalPlanReaderText('Fictional complete text', 22, 1024), { text: 'Fictional complete text', totalCharacters: 22, truncated: false });
});
test('all saved task kinds project only safe states, fixed generations and exact receipts', () => {
  for (const kind of JOB_KINDS) {
    const row = { ...step(kind), job_id: randomUUID(), job_generation: 1, current_generation: 1, job_status: 'uncertain' };
    const result = projectGoalPlanReaderStep(row), encoded = JSON.stringify(result);
    assert.equal(result.taskKind, kind); assert.equal(result.state, 'uncertain'); assert.equal(result.generation, 1);
    assert(!encoded.includes('synthetic secret')); assert(!encoded.includes('private.example.invalid'));
    assert.equal(projectGoalPlanReaderStep({ ...row, current_generation: 2, job_status: 'succeeded' }).state, 'blocked');
    assert.equal(projectGoalPlanReaderStep({ ...row, job_status: 'succeeded' }).state, 'blocked');
    const receipt = { receipt_present: true, receipt_kind: 'task', receipt_job_id: row.job_id, receipt_generation: '1', receipt_artifact_ids: [randomUUID()], receipt_artifact_count: 1, available_artifact_count: 1, receipt_completed_at: when };
    assert.equal(projectGoalPlanReaderStep({ ...row, ...receipt, job_status: 'succeeded' }).state, 'succeeded');
    assert.equal(projectGoalPlanReaderStep({ ...row, ...receipt, job_status: 'succeeded', available_artifact_count: 0 }).state, 'blocked');
    assert.equal(projectGoalPlanReaderStep({ ...row, ...receipt, job_id: null, current_generation: null }).state, 'blocked');
  }
  const row = { ...step(), kind: 'agent_turn', message_id: randomUUID(), message_status: 'streaming', message_lease_active: false };
  assert.equal(projectGoalPlanReaderStep(row).state, 'uncertain'); assert.equal(projectGoalPlanReaderStep({ ...row, message_lease_active: true }).state, 'running');
  assert.equal(projectGoalPlanReaderStep({ ...row, message_status: 'complete' }).state, 'blocked');
});
test('list is latest-ten metadata with truthful hasMore, no complete plan definition or follow-up execution', async () => {
  const plans = Array.from({ length: 11 }, () => ({ ...plan(), id: randomUUID(), title: '\n'.repeat(119) + 'x' })), { readers, queries } = fake([step()], plans);
  const result = await readers.list(userId, origin, {});
  assert.equal(result.plans.length, 10); assert(result.hasMore); assert.equal(result.executionAuthorized, false); assert.equal(result.executionReadiness, 'not_checked');
  assert(Buffer.byteLength(JSON.stringify(result),'utf8') < GOAL_PLAN_READER_MAX_BYTES);
  assert(queries.every(sql => !/\b(INSERT|UPDATE|DELETE)\s+(INTO|platform_)/i.test(sql))); assert(!queries.some(sql => sql.includes('SELECT s.step_index')));
  assert.equal(result.plans[0].conversationId, origin.conversationId); assert(!Object.hasOwn(result.plans[0], 'goal'));
});
test('read stays within 16KiB with eight exact receipts, bounds selected template and omits raw inputs/results', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ ...step('image',index), job_id: randomUUID(), job_generation: 1, current_generation: 1, job_status: 'succeeded',
    receipt_present: true, receipt_kind: 'task', receipt_generation: '1', receipt_artifact_count: 64, available_artifact_count: 64, receipt_artifact_ids: Array.from({length:8},randomUUID), receipt_completed_at: when,
    selected_text: '\\"\n😀'.repeat(2048), selected_text_characters: 20_000, title: '\n'.repeat(119) + 'x' }));
  for (const row of rows) (row as any).receipt_job_id = row.job_id;
  const { readers, queries } = fake(rows), result = await readers.read(userId,origin,{planId,revision:1,stepIndex:7}), encoded = JSON.stringify(result);
  assert(Buffer.byteLength(encoded,'utf8') <= GOAL_PLAN_READER_MAX_BYTES); assert(result.selectedStep!.inputText.truncated); assert(result.goal.truncated);
  assert.equal(result.selectedStep!.inputText.totalCharacters, 20_000); assert.equal(result.selectedStep!.inputTextMeaning,'plan_template_not_resolved_execution_input');
  assert.equal(result.steps[0].receipt!.artifactCount,64); assert.equal(result.steps[0].receipt!.artifactsTruncated,true); assert(result.allStepsHaveSuccessReceipts);
  for (const denied of ['synthetic secret','private.example.invalid','rawSecret','execution_policy','approval','storage_key']) assert(!encoded.includes(denied),denied);
  assert(queries.findIndex(sql => sql.includes('FOR SHARE OF j')) < queries.findIndex(sql => sql.includes('ORDER BY step_index FOR SHARE')));
  assert(queries.findIndex(sql => sql.includes('FROM platform_conversations') && sql.includes('FOR KEY SHARE')) < queries.findIndex(sql => sql.includes('FOR SHARE OF p')));
  assert(queries.at(-1)!.includes('l.expires_at>clock_timestamp()')); assert(queries.at(-1)!.includes("m.status='streaming'"));
});
test('cancellation after waiting for a source lock stops before further source reads or result publication', async () => {
  const abort = new AbortController(), { readers, queries } = fake([step()],undefined,sql => { if (sql.includes('FOR SHARE OF j')) abort.abort(); });
  await assert.rejects(readers.read(userId,origin,{planId,revision:1},abort.signal),{name:'AbortError'});
  assert(!queries.some(sql => sql.startsWith('SELECT s.step_index'))); assert(!queries.some(sql => sql.includes('FOR SHARE OF m')));
});
