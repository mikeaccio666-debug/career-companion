import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { goalInputToDraft, goalTaskKinds, newGoalDraft, newGoalStep, parseGoalDraft } from '../src/goal-plans-editor.ts';
import { GoalDefinition } from '../src/goal-plan-review.ts';
import { artifactId, input, plan, taskPlan } from './goal-plans-fixture.ts';

test('empty initial plans contain no user facts, and unconfigured services can still save an explicit draft', () => {
  assert.equal(newGoalDraft().goal, ''); assert.equal(newGoalStep().instruction, ''); assert.throws(() => parseGoalDraft(newGoalDraft()));
  assert.deepEqual(parseGoalDraft(goalInputToDraft(input())), input());
});

test('all existing task kinds survive a draft round trip without inventing authorization', () => {
  for (const kind of goalTaskKinds) {
    const value = { title: 'Fictional plan', goal: 'Fictional task goal', steps: [{ kind: 'task' as const, title: 'Fictional task', task: { kind, provider: kind, prompt: 'Fictional instructions.', options: { fictional: true } } }] };
    assert.deepEqual(parseGoalDraft(goalInputToDraft(value)), value);
  }
});

test('editor limits match actual server task boundaries, including MCP fields and reference-image count', () => {
  const draft = goalInputToDraft(input()); draft.steps[0].provider = 'p'.repeat(81); assert.throws(() => parseGoalDraft(draft));
  draft.steps[0].provider = 'fictional'; draft.steps[0].model = 'm'.repeat(151); assert.throws(() => parseGoalDraft(draft));
  draft.steps[0].model = ''; draft.steps = Array.from({ length: 9 }, () => ({ ...draft.steps[0] })); assert.throws(() => parseGoalDraft(draft));
  const task = goalInputToDraft({ ...taskPlan(), steps: taskPlan().steps.map((step) => step.input) });
  task.steps[0].options = '[]'; assert.throws(() => parseGoalDraft(task)); task.steps[0].options = '{}';
  task.steps[0].attachmentIds = Array.from({ length: 5 }, (_, i) => `71000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`).join(','); assert.throws(() => parseGoalDraft(task));
  task.steps[0].attachmentIds = ''; task.steps[0].taskKind = 'mcp'; task.steps[0].model = 'fictional'; assert.throws(() => parseGoalDraft(task));
});

test('the actual review view includes complete frozen task parameters, attachments, analysis instructions and definition version', () => {
  const value = taskPlan(); value.steps[0].input = { kind: 'task', title: 'Fictional task', task: { kind: 'browser', provider: 'browser', prompt: 'Fictional browser observation', options: { url: 'https://example.invalid', actions: [{ type: 'scroll', direction: 'down', pixels: 120 }] }, attachmentIds: [artifactId] } };
  value.steps.push({ ...plan().steps[0], index: 1 });
  const html = renderToStaticMarkup(createElement(GoalDefinition, { plan: value }));
  for (const expected of ['example.invalid', 'actions', 'pixels', artifactId, 'fictional-unconfigured', 'Compare the saved fictional evidence', value.definitionHash, '计划版本']) assert.ok(html.includes(expected), expected);
  assert.equal(html.includes('<button'), false); // Reading the definition provides no execution action.
});
