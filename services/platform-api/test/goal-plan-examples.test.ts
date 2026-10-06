import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserTaskOptions, workflowDefinitionHash } from '@companion/ai-core';
import { goalPlanExamples } from '../src/goal-plan-examples.ts';
import { goalPlanTools } from '../src/goal-plan-tools.ts';
import { parseGoalPlanInput } from '../src/goal-plans.ts';
import { parseMcpJob } from '../src/mcp-connections.ts';

test('model-facing examples satisfy actual plan, browser, MCP and workflow contracts without running them', () => {
  const parsed = Object.fromEntries(Object.entries(goalPlanExamples).map(([name, value]) => [name, parseGoalPlanInput(value)]));
  const task = (name: string) => { const step = parsed[name].steps[0]; assert.equal(step.kind, 'task'); if (step.kind !== 'task') throw new Error('Expected a task example'); return step.task; };
  assert.equal(parseBrowserTaskOptions(task('browser').options).url, 'https://example.invalid/');
  assert.equal(parseMcpJob(task('mcp')).toolName, 'fictional_read');
  assert.match(workflowDefinitionHash(task('workflow')), /^[a-f0-9]{64}$/);
  const creative = parsed.creative.steps;
  assert.equal(creative.length, 3);
  assert(creative[1].kind === 'task' && creative[1].bindings?.prompt?.fromStep === 0);
  assert(creative[2].kind === 'task' && creative[2].bindings?.referenceImages?.[0].fromStep === 1);
  const description = goalPlanTools.find(tool => tool.name === 'propose_goal_plan')!.description;
  assert(description.includes('Every step needs its own title'));
  assert(description.includes(JSON.stringify(goalPlanExamples)));
});
