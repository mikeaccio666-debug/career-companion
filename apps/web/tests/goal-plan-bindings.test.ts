import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GoalPlanInput } from '@companion/platform-contracts';
import { goalBindingOptions, parseGoalTaskBindings, removeGoalStep } from '../src/goal-plan-bindings.ts';
import { GoalBindingFields } from '../src/goal-binding-fields.ts';
import { goalInputToDraft, parseGoalDraft } from '../src/goal-plans-editor.ts';
import { GoalDefinition } from '../src/goal-plan-review.ts';
import { plan } from './goal-plans-fixture.ts';

const definition = (): GoalPlanInput => ({ title: 'Fictional linked plan', goal: 'Review synthetic source inputs only.', steps: [
  { kind: 'agent_turn', title: 'Fictional analysis', provider: 'fictional', instruction: 'Compare fictional materials.' },
  { kind: 'task', title: 'Fictional image', task: { kind: 'image', provider: 'fictional', prompt: 'Base fictional instruction.', options: {} }, bindings: { prompt: { fromStep: 0, source: 'analysis_text', mode: 'append' } } },
  { kind: 'task', title: 'Fictional video', task: { kind: 'video', provider: 'fictional', prompt: 'Base fictional video.', options: {} }, bindings: { prompt: { fromStep: 1, source: 'artifact_text', artifactIndex: 2, mode: 'replace' }, referenceImages: [{ fromStep: 1, imageIndex: 1 }] } },
] });

test('save and copy retain exact natural source choices without mutating a frozen plan', () => {
  const input = definition(), draft = goalInputToDraft(input);
  assert.deepEqual(parseGoalDraft(draft), input);
  draft.steps[2].bindings!.referenceImages![0].imageIndex = 3;
  assert.equal(input.steps[2].kind === 'task' && input.steps[2].bindings!.referenceImages![0].imageIndex, 1);
  assert.equal(parseGoalDraft(draft).steps[2].kind, 'task');
});

test('current/future, cross-plan IDs and ambiguous source-type bindings reject instead of redirecting', () => {
  const steps = goalInputToDraft(definition()).steps;
  for (const value of [
    { prompt: { fromStep: 1, source: 'analysis_text', mode: 'append' } },
    { prompt: { fromStep: 2, source: 'artifact_text', mode: 'append' } },
    { prompt: { fromStep: 0, source: 'artifact_text', mode: 'append' } },
    { prompt: { fromStep: 0, source: 'analysis_text', artifactIndex: 0, mode: 'append' } },
    { prompt: { fromStep: 0, source: 'analysis_text', mode: 'append', jobId: 'fictional-other-plan' } },
    { referenceImages: [{ fromStep: 0 }] },
    { referenceImages: [{ fromStep: 1, imageIndex: 64 }] },
    { prompt: { fromStep: -1, source: 'analysis_text', mode: 'append' } },
  ]) assert.throws(() => parseGoalTaskBindings(value, 2, steps));
});

test('source/result limits, actual executor fields and combined image counts match server boundaries', () => {
  const steps = goalInputToDraft(definition()).steps;
  assert.deepEqual(parseGoalTaskBindings({ prompt: { fromStep: 1, source: 'artifact_text', artifactIndex: 63, mode: 'replace' } }, 2, steps), { prompt: { fromStep: 1, source: 'artifact_text', artifactIndex: 63, mode: 'replace' } });
  for (const taskKind of ['browser', 'mcp', 'workflow'] as const) { const changed = steps.map((step, i) => i === 2 ? { ...step, taskKind } : step); assert.throws(() => parseGoalTaskBindings(steps[2].bindings, 2, changed)); }
  for (const sourceKind of ['browser', 'mcp'] as const) { const changed = steps.map((step, i) => i === 1 ? { ...step, taskKind: sourceKind } : step); assert.throws(() => parseGoalTaskBindings({ prompt: { fromStep: 1, source: 'artifact_text', mode: 'append' } }, 2, changed)); assert.doesNotThrow(() => parseGoalTaskBindings({ referenceImages: [{ fromStep: 1 }] }, 2, changed)); }
  assert.throws(() => parseGoalTaskBindings({ referenceImages: [{ fromStep: 1 }, { fromStep: 1, imageIndex: 0 }] }, 2, steps));
  assert.throws(() => parseGoalTaskBindings({ referenceImages: [{ fromStep: 1 }] }, 2, steps, 4));
  assert.throws(() => parseGoalTaskBindings({ referenceImages: [] }, 2, steps));
});

test('deletion cannot silently shift a retained source; clearing an affected choice is explicit', () => {
  const steps = goalInputToDraft(definition()).steps, before = structuredClone(steps);
  assert.throws(() => removeGoalStep(steps, 0), /其他编辑已保留/);
  assert.throws(() => removeGoalStep(steps, 1));
  assert.deepEqual(steps, before);
  assert.equal(removeGoalStep(steps, 2).length, 2);
  const cleared = steps.map((step) => ({ ...step, bindings: undefined }));
  assert.equal(removeGoalStep(cleared, 0)[0].title, steps[1].title);
});

test('changing a source or target keeps its old choices visible and prevents saving until reselected', () => {
  const draft = goalInputToDraft(definition());
  draft.steps[0].kind = 'task'; draft.steps[0].taskKind = 'speech'; draft.steps[0].prompt = 'Fictional task source.';
  assert.throws(() => parseGoalDraft(draft));
  assert.equal(draft.steps[1].bindings!.prompt!.source, 'analysis_text');
  draft.steps[1].bindings = undefined;
  draft.steps[2].kind = 'agent_turn'; draft.steps[2].instruction = 'Fictional new analysis.';
  assert.throws(() => parseGoalDraft(draft));
  assert.ok(draft.steps[2].bindings);
});

test('binding selection UI uses earlier-step language and result numbers rather than JSON or UUID entry', () => {
  const steps = goalInputToDraft(definition()).steps;
  const choices = goalBindingOptions(steps, 1);
  assert.deepEqual(choices.map((choice) => choice.fromStep), [0]);
  const html = renderToStaticMarkup(createElement(GoalBindingFields, { steps, index: 2, bindings: steps[2].bindings, attachmentCount: 0, onChange() {} }));
  for (const text of ['文字来源', '第几份文字成果', '使用来源全文', '参考图 1 来源', '第几份图片成果', '取消全部前序绑定', '准备本步时']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('<textarea'), false);
  assert.equal(html.includes('bindings JSON'), false);
  assert.equal(html.includes('选择前序成果'), true);
});

test('full plan review discloses binding rules and distinguishes them from future actual input', () => {
  const input = definition(), value = plan({ ...input, steps: input.steps.map((entry, index) => ({ index, input: entry, state: 'pending', ready: false, artifacts: [] })) });
  const html = renderToStaticMarkup(createElement(GoalDefinition, { plan: value }));
  for (const text of ['前序成果使用规则', '第 1 步的分析正文', '第 2 步的第 3 份文字成果', '第 2 步的第 2 份图片成果', '不代表前序成果已经产生', 'Base fictional instruction.']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('<button'), false);
});
