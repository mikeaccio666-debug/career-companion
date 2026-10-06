import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GOAL_PLAN_MAX_BYTES, type GoalPlan, type GoalPlanInputSnapshot, type GoalPlanInputSource } from '@companion/platform-contracts';
import { GOAL_PLAN_RESPONSE_MAX_BYTES, parseGoalPlan } from '../src/goal-plans-api.ts';
import { goalInputToDraft, parseGoalDraft } from '../src/goal-plans-editor.ts';
import { goalReceiptResults } from '../src/goal-plan-inputs.ts';
import { GoalPreparedInput } from '../src/goal-prepared-input.ts';
import { conversationId, instant, plan, taskPlan } from './goal-plans-fixture.ts';

const ids = Array.from({ length: 8 }, (_, i) => `85000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
function prepared(): GoalPlan {
  const analysis = plan().steps[0]; analysis.state = 'succeeded'; analysis.ready = false; analysis.messageId = ids[0]; analysis.receipt = { kind: 'agent_turn', messageId: ids[0], completedAt: instant };
  const source = taskPlan().steps[0]; source.index = 1; source.state = 'succeeded'; source.ready = false; delete source.approval; source.job!.id = ids[1]; source.job!.status = 'succeeded';
  source.artifacts = [
    { id: ids[2], name: 'fictional-last.txt', mime: 'text/plain', url: `/api/platform/artifacts/${ids[2]}` },
    { id: ids[3], name: 'fictional-first.md', mime: 'text/markdown', url: `/api/platform/artifacts/${ids[3]}` },
    { id: ids[4], name: 'fictional-image.png', mime: 'image/png', url: `/api/platform/artifacts/${ids[4]}` },
  ];
  source.receipt = { kind: 'task', jobId: ids[1], generation: 1, artifactIds: [ids[3], ids[4], ids[2]], completedAt: instant };
  source.job!.artifacts = source.artifacts;
  const target = taskPlan().steps[0]; target.index = 2; target.input = { kind: 'task', title: 'Fictional bound video', task: { kind: 'video', provider: 'fictional', prompt: 'Fictional video base.', options: {} }, bindings: { prompt: { fromStep: 1, source: 'artifact_text', artifactIndex: 1, mode: 'append' }, referenceImages: [{ fromStep: 1 }] } };
  target.resolvedTask = { ...target.input.task, prompt: 'Fictional video base.\n\nComplete fictional source text.', attachmentIds: [ids[5]] };
  target.job = { ...target.job!, ...target.resolvedTask, id: ids[6] };
  target.inputSources = [
    { source: 'artifact_text', fromStep: 1, mode: 'append', artifactIndex: 1, jobId: ids[1], generation: 1, artifactId: ids[2], mime: 'text/plain', sha256: 'b'.repeat(64), byteSize: 31 },
    { source: 'reference_image', fromStep: 1, imageIndex: 0, jobId: ids[1], generation: 1, artifactId: ids[4], attachmentId: ids[5], mime: 'image/png', sha256: 'c'.repeat(64), byteSize: 80 },
  ];
  const value = plan({ status: 'active', steps: [analysis, source, target] });
  const snapshot: GoalPlanInputSnapshot = { planId: value.id, revision: value.revision, stepIndex: 2, templateHash: 'd'.repeat(64), effectiveInputHash: 'e'.repeat(64), inputSources: structuredClone(target.inputSources) };
  target.approval = { ...target.approval!, jobId: target.job.id, toolName: 'video', args: { ...target.resolvedTask, goalPlanInput: snapshot } };
  return value;
}

test('actual source selection follows receipt order across mixed MIME types, not shuffled display order', () => {
  const value = prepared();
  assert.equal(parseGoalPlan(value, conversationId).steps[2].inputSources!.length, 2);
  assert.deepEqual(goalReceiptResults(value.steps[1], ['text/plain', 'text/markdown']).map((file) => file.id), [ids[3], ids[2]]);
  assert.deepEqual(goalReceiptResults(value.steps[1], ['image/png']).map((file) => file.id), [ids[4]]);
  const wrong = prepared(); wrong.steps[2].inputSources![0] = { ...wrong.steps[2].inputSources![0], artifactId: ids[3] } as GoalPlanInputSource;
  assert.throws(() => parseGoalPlan(wrong, conversationId));
});

test('bound tasks cannot expose approval until complete exact resolved input and provenance are consistent', () => {
  for (const mutate of [
    (value: GoalPlan) => { delete value.steps[2].resolvedTask; },
    (value: GoalPlan) => { delete value.steps[2].inputSources; },
    (value: GoalPlan) => { value.steps[2].resolvedTask!.prompt = 'Fictional mismatched prepared input.'; },
    (value: GoalPlan) => { value.steps[2].job!.attachmentIds = [ids[7]]; value.steps[2].approval!.args.attachmentIds = [ids[7]]; },
    (value: GoalPlan) => { (value.steps[2].inputSources![0] as { generation: number }).generation = 2; },
    (value: GoalPlan) => { (value.steps[2].inputSources![0] as { fromStep: number }).fromStep = 0; },
    (value: GoalPlan) => { value.steps[2].inputSources!.push({ ...value.steps[2].inputSources![0] }); },
  ]) { const value = prepared(); mutate(value); assert.throws(() => parseGoalPlan(value, conversationId)); }
});

test('unknown source fields, missing input snapshots and snapshot/hash conflicts reject the whole response', () => {
  for (const mutate of [
    (value: GoalPlan) => { Object.assign(value.steps[2].inputSources![0], { arbitraryUrl: 'https://example.invalid' }); },
    (value: GoalPlan) => { delete value.steps[2].approval!.args.goalPlanInput; },
    (value: GoalPlan) => { (value.steps[2].approval!.args.goalPlanInput as GoalPlanInputSnapshot).inputSources[0].sha256 = 'f'.repeat(64); },
    (value: GoalPlan) => { (value.steps[2].approval!.args.goalPlanInput as GoalPlanInputSnapshot).templateHash = 'invalid'; },
    (value: GoalPlan) => { (value.steps[2].approval!.args.goalPlanInput as GoalPlanInputSnapshot).revision = 2; },
    (value: GoalPlan) => { Object.assign(value.steps[2].approval!.args.goalPlanInput!, { credential: 'fictional-unused' }); },
  ]) { const value = prepared(); mutate(value); assert.throws(() => parseGoalPlan(value, conversationId)); }
});

test('analysis binding pins the prior saved assistant receipt rather than metadata from another message', () => {
  const value = prepared(), target = value.steps[2]; if (target.input.kind !== 'task') throw new Error('fixture');
  target.input.bindings = { prompt: { fromStep: 0, source: 'analysis_text', mode: 'replace' } };
  target.resolvedTask = { ...target.input.task, prompt: 'Complete fictional assistant analysis.', attachmentIds: [] };
  Object.assign(target.job!, target.resolvedTask); target.inputSources = [{ source: 'analysis_text', fromStep: 0, mode: 'replace', messageId: ids[0], sha256: 'b'.repeat(64), byteSize: 38 }];
  target.approval!.args = { ...target.resolvedTask, goalPlanInput: { ...(target.approval!.args.goalPlanInput as GoalPlanInputSnapshot), inputSources: structuredClone(target.inputSources) } };
  assert.doesNotThrow(() => parseGoalPlan(value, conversationId));
  (target.inputSources[0] as { messageId: string }).messageId = ids[7];
  assert.throws(() => parseGoalPlan(value, conversationId));
});

test('deleted source histories keep their frozen receipt metadata without pointing to a substitute result', () => {
  const value = prepared(), source = value.steps[1], target = value.steps[2]; source.state = 'blocked'; source.artifacts = []; delete source.job; target.state = 'blocked'; delete target.approval;
  assert.doesNotThrow(() => parseGoalPlan(value, conversationId));
  const html = renderToStaticMarkup(createElement(GoalPreparedInput, { plan: value, step: target, onViewSource() {}, renderAttachmentPreview() { throw new Error('must not fetch a preview'); } }));
  assert.ok(html.includes('来源当前不可用'));
  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes('历史记录'));
  const bad = prepared(); bad.steps[1].artifacts = [];
  assert.throws(() => parseGoalPlan(bad, conversationId));
});

test('prepared review renders the full actual prompt and reference count without auto-fetch or hidden truncation', () => {
  const value = prepared(), target = value.steps[2], full = `${'Fictional video base.\n\n'}${'x'.repeat(19_850)}END-OF-FICTIONAL-SOURCE`;
  target.resolvedTask!.prompt = full; target.job!.prompt = full; target.approval!.args.prompt = full;
  assert.doesNotThrow(() => parseGoalPlan(value, conversationId));
  let previews = 0;
  const html = renderToStaticMarkup(createElement(GoalPreparedInput, { plan: value, step: target, onViewSource() {}, renderAttachmentPreview() { previews++; return createElement('img', { src: 'https://example.invalid' }); } }));
  assert.ok(html.includes('END-OF-FICTIONAL-SOURCE'));
  assert.ok(html.includes('本步实际参考图共 1 张'));
  assert.ok(html.includes('第 2 步的第 2 份文字成果'));
  assert.ok(html.includes('任务版本 1'));
  assert.ok(html.includes('SHA-256'));
  assert.equal(previews, 0); assert.equal(html.includes('<img'), false);
});

test('near-limit definitions restore complete seven-step Chinese/escaped bound prompts within the derived GET budget', () => {
  for (const fullText of ['证据'.repeat(10_000), `结果${'\u0001'.repeat(19_998)}`]) {
  const value = prepared(), analysis = value.steps[0], seed = value.steps[2];
  value.goal = '目标'.repeat(4_000);
  if (analysis.input.kind !== 'agent_turn') throw new Error('fixture');
  analysis.input.instruction = '分析'.repeat(3_000);
  value.steps = [analysis, ...Array.from({ length: 7 }, (_, i) => {
    const step = structuredClone(seed), stepIndex = i + 1, jobId = `86000000-0000-4000-8000-${String(stepIndex).padStart(12, '0')}`;
    step.index = stepIndex; step.input = { kind: 'task', title: `Fictional expanded ${stepIndex}`, task: { kind: 'video', provider: 'fictional', prompt: 'b'.repeat(2_000), options: { fictionalPayload: 'o'.repeat(19_500) } }, bindings: { prompt: { fromStep: 0, source: 'analysis_text', mode: 'replace' } } };
    step.resolvedTask = { ...step.input.task, prompt: fullText, attachmentIds: [] };
    step.inputSources = [{ source: 'analysis_text', fromStep: 0, mode: 'replace', messageId: ids[0], sha256: 'b'.repeat(64), byteSize: new TextEncoder().encode(fullText).byteLength }];
    step.job = { ...step.job!, ...step.resolvedTask, id: jobId, artifacts: [], status: stepIndex === 7 ? 'needs_approval' : 'succeeded' };
    if (stepIndex < 7) { step.state = 'succeeded'; step.receipt = { kind: 'task', jobId, generation: 1, artifactIds: [], completedAt: instant }; delete step.approval; }
    else step.approval = { ...step.approval!, jobId, args: { ...step.resolvedTask, goalPlanInput: { planId: value.id, revision: value.revision, stepIndex, templateHash: 'd'.repeat(64), effectiveInputHash: 'e'.repeat(64), inputSources: structuredClone(step.inputSources) } } };
    return step;
  })];
  const definition = { title: value.title, goal: value.goal, steps: value.steps.map((step) => step.input) };
  assert.deepEqual(parseGoalDraft(goalInputToDraft(definition)), definition);
  const definitionBytes = new TextEncoder().encode(JSON.stringify(definition)).byteLength;
  assert.ok(definitionBytes > GOAL_PLAN_MAX_BYTES * 0.95 && definitionBytes <= GOAL_PLAN_MAX_BYTES);
  const responseBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(responseBytes > GOAL_PLAN_MAX_BYTES);
  if (fullText.includes('\u0001')) assert.ok(responseBytes > GOAL_PLAN_MAX_BYTES * 8); // Regression: the previous cap rejected its own legal response.
  assert.doesNotThrow(() => parseGoalPlan(value, conversationId));
  }
  const oversized = prepared(); oversized.steps[2].job!.error = { code: 'FICTIONAL_OVERSIZE', message: 'x'.repeat(GOAL_PLAN_RESPONSE_MAX_BYTES) };
  assert.throws(() => parseGoalPlan(oversized, conversationId)); // Metadata does not get an unbounded exception.
});
