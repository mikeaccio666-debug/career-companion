import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToolExecution, ChatInput } from '@companion/platform-contracts';
import { CapabilityRegistry, type CapabilityExecutionScope, type CapabilityScope } from '../src/capabilities.ts';
import type { OwnedCareerProfile } from '../src/career-run-context.ts';

const profile: OwnedCareerProfile = { ownerId: 'fictional-owner', id: 'fictional-profile', revision: 3, state: 'current', normalSummary: 'Fictional student course project.', confirmed: { degree: true, graduation: true, roleFamily: true } };
const initial = (): CapabilityScope => ({ ownerId: 'fictional-owner', turnId: 'fictional-turn', profile: { speaker: 'companion' }, room: { kind: 'main' }, phase: { enabledFeatures: ['P0'], enabledSpeakers: ['companion', 'guide', 'interviewer', 'applier'], reviewedSkills: ['career-intake'] } });
const execution = (callId: string, effect: AgentToolExecution['effect']): AgentToolExecution => ({ callId, turnId: 'fictional-turn', idempotencyKey: `fictional-turn:${callId}`, effect });
const input: ChatInput = { provider: 'ollama', mode: 'companion', messages: [{ role: 'user', content: 'Plan one fictional next step.' }] };
const plan = { title: 'Fictional action', steps: ['Check a public report.'], references: [] };

test('unregistered and unreviewed executors never become visible or executable', () => {
  const registry = new CapabilityRegistry({ registrations: [{ id: 'save_plan_draft', reviewed: false, execute: async () => assert.fail('Unreviewed executor ran.') }] });
  const scope = initial();
  assert.deepEqual(registry.toolsFor(scope.profile, scope.room, scope.phase).map(tool => tool.name), ['use_skill']);
  assert.equal(registry.executorFor('save_plan_draft'), undefined);
  assert.equal(registry.executorFor('executeCli'), undefined);
  assert.throws(() => new CapabilityRegistry({ registrations: [{ id: 'executeCli', reviewed: true, execute: async () => null }] }));
});
test('progressive skill loading waits for a real prepared context and the next step, while instructions inject once', async () => {
  let commits = 0;
  const registry = new CapabilityRegistry({ careerPorts: { readProfile: async scope => { assert.equal(scope.ownerId, profile.ownerId); return profile; } }, registrations: [
    { id: 'read_profile', reviewed: true, execute: async () => ({ normal: 'Fictional summary' }) },
    { id: 'save_plan_draft', reviewed: true, execute: async (_args, scope) => { commits++; assert.equal(scope.execution.idempotencyKey, 'fictional-turn:save'); assert.equal(scope.preparedSkills?.[0]?.profileRevision, 3); assert.equal(Object.isFrozen(scope.preparedSkills), true); return { id: 'fictional-plan', revision: 1, status: 'draft' }; } },
  ] });
  const session = registry.session(initial);
  assert.ok(session.toolDefinitions.some(tool => tool.name === 'save_plan_draft'));
  session.beforeStep(input);
  assert.deepEqual(session.resolveTools().map(tool => tool.name), ['use_skill']);
  const result: any = await session.executeTool('use_skill', { id: 'career-intake' }, execution('load', 'read'));
  assert.equal(result.state, 'ready_for_draft');
  assert.equal(result.activation, 'next_step');
  assert.equal(session.limitsForStep(), undefined);
  assert.equal(session.resolveTools().some(tool => tool.name === 'save_plan_draft'), false);
  await assert.rejects(session.executeTool('save_plan_draft', plan, execution('save', 'draft')), { code: 'TOOL_NOT_ALLOWED' });
  const next = session.beforeStep(input);
  assert.ok(next.messages.some(message => message.content.includes('Server-owned skill procedure')));
  assert.equal(session.resolveTools().some(tool => tool.name === 'save_plan_draft'), true);
  assert.deepEqual(session.limitsForStep(), { maxRounds: 6, maxToolCalls: 12 });
  await session.executeTool('save_plan_draft', plan, execution('save', 'draft'));
  assert.equal(commits, 1);
  assert.deepEqual(session.beforeStep(next).messages, next.messages);
});
test('changing the prepared input selection starts a new binding rather than silently reusing a run', async () => {
  let scope = { ...initial(), selection: { projectId: 'fictional-project-one' } };
  const registry = new CapabilityRegistry(), session = registry.session(() => scope);
  session.beforeStep(input); session.resolveTools();
  scope = { ...scope, selection: { projectId: 'fictional-project-two' } };
  await assert.rejects(session.executeTool('use_skill', { id: 'career-intake' }, execution('load', 'read')), { code: 'TOOL_NOT_ALLOWED' });
});
test('draft ports receive immutable prepared input revisions and can reject a source changed after preparation', async () => {
  let currentRevision = 3, commits = 0;
  const scope: CapabilityScope = { ...initial(), profile: { speaker: 'guide' }, room: { kind: 'expert_room', expert: 'guide' }, phase: { ...initial().phase, reviewedSkills: ['evidence-story'] } };
  const registry = new CapabilityRegistry({ careerPorts: { readProfile: async () => profile, listEvidence: async () => [{ ownerId: profile.ownerId, id: 'fictional-project', revision: 3, state: 'current', kind: 'project', normalSummary: 'Fictional course project.' }] }, registrations: [
    { id: 'read_profile', reviewed: true, execute: async () => ({}) }, { id: 'read_evidence', reviewed: true, execute: async () => ({}) },
    { id: 'save_story_draft', reviewed: true, authorize: async (_args, current) => {
      const prepared = current.preparedSkills![0]!;
      assert.equal(prepared.id, 'evidence-story');
      assert.equal(prepared.inputs.find(ref => ref.input === 'profile')!.revision, 3);
      assert.deepEqual(prepared.snapshots[0]!.members, [{ id: 'fictional-project', revision: 3 }]);
      assert.equal(Object.isFrozen(prepared.snapshots[0]!.members[0]), true);
      if (currentRevision !== prepared.profileRevision) throw Object.assign(new Error('Fictional owned source changed.'), { code: 'CAREER_INPUT_CHANGED' });
    }, execute: async () => { commits++; return { id: 'fictional-story', revision: 1 }; } },
  ] });
  const session = registry.session(() => scope); session.beforeStep(input); session.resolveTools();
  const ready: any = await session.executeTool('use_skill', { id: 'evidence-story' }, execution('load', 'read'));
  assert.equal(ready.state, 'ready_for_draft');
  session.beforeStep(input); session.resolveTools(); currentRevision = 4;
  await assert.rejects(session.executeTool('save_story_draft', { content: 'Fictional draft.', references: [] }, execution('story', 'draft')), { code: 'CAREER_INPUT_CHANGED' });
  assert.equal(commits, 0);
});
test('bare preloaded ids and missing sources never authorize draft execution', async () => {
  const scope = initial(); scope.profile.loadedSkillIds = ['career-intake'];
  const registry = new CapabilityRegistry({ registrations: [
    { id: 'read_profile', reviewed: true, execute: async () => ({}) }, { id: 'save_plan_draft', reviewed: true, execute: async () => assert.fail('Unprepared draft ran.') },
  ] });
  const session = registry.session(() => scope); session.beforeStep(input); session.resolveTools();
  assert.equal(session.resolveTools().some(tool => tool.name === 'save_plan_draft'), false);
  const result: any = await session.executeTool('use_skill', { id: 'career-intake' }, execution('load', 'read'));
  assert.equal(result.state, 'blocked');
  assert.ok(result.reasons.includes('invalid_authenticated_context'));
  assert.deepEqual(result.unavailableSources, ['readProfile']);
  session.beforeStep(input);
  await assert.rejects(session.executeTool('save_plan_draft', plan, execution('save', 'draft')), { code: 'TOOL_NOT_ALLOWED' });
});
test('session cancellation reaches an in-flight preparation port even when the execution signal is present', async () => {
  const sessionController = new AbortController(), executionController = new AbortController();
  let start!: () => void, observedAbort = false;
  const started = new Promise<void>(resolve => { start = resolve; });
  const scope = { ...initial(), signal: sessionController.signal };
  const registry = new CapabilityRegistry({ careerPorts: { readProfile: async readScope => {
    assert.ok(readScope.signal);
    assert.notEqual(readScope.signal, executionController.signal);
    start();
    return new Promise(resolve => readScope.signal!.addEventListener('abort', () => { observedAbort = true; resolve(profile); }, { once: true }));
  } }, registrations: [{ id: 'read_profile', reviewed: true, execute: async () => ({}) }, { id: 'save_plan_draft', reviewed: true, execute: async () => assert.fail('Cancelled preparation cannot authorize a draft.') }] });
  const session = registry.session(() => scope); session.beforeStep(input); session.resolveTools();
  const preparing = session.executeTool('use_skill', { id: 'career-intake' }, { ...execution('load', 'read'), signal: executionController.signal });
  await started; sessionController.abort();
  await assert.rejects(preparing, { code: 'CAREER_PREPARATION_CANCELLED' });
  assert.equal(observedAbort, true);
  assert.equal(executionController.signal.aborted, false);
});
test('skill ownership and review gates cannot be overridden in function arguments', async () => {
  const registry = new CapabilityRegistry(), scope = initial(), session = registry.session(() => scope);
  session.beforeStep(input); session.resolveTools();
  await assert.rejects(session.executeTool('use_skill', { id: 'evidence-story' }, execution('foreign', 'read')), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(session.executeTool('use_skill', { id: 'career-intake', ownerId: 'another-owner' }, execution('extra', 'read')), { code: 'TOOL_ARGUMENTS_INVALID' });
  scope.phase.reviewedSkills = [];
  await assert.rejects(session.executeTool('use_skill', { id: 'career-intake' }, execution('unreviewed', 'read')), { code: 'TOOL_NOT_ALLOWED' });
});
test('owner, turn, phase, extra parameters and mismatched idempotency bind execution, including after an awaited preflight', async () => {
  let commits = 0, current = initial();
  const registry = new CapabilityRegistry({ registrations: [{ id: 'save_plan_draft', reviewed: true,
    authorize: async () => { current = { ...current, phase: { ...current.phase, enabledFeatures: [] } }; }, execute: async () => { commits++; } }], careerPorts: { readProfile: async () => profile } });
  const executor = registry.executorFor('save_plan_draft')!, allowed = new Set(['save_plan_draft']);
  const scope = { ...current, execution: execution('save', 'draft') };
  await assert.rejects(executor(plan, scope, allowed, () => ({ ...current, execution: execution('save', 'draft') })), { code: 'TOOL_NOT_ALLOWED' });
  assert.equal(commits, 0);
  current = initial();
  for (const bad of [{ ...plan, userId: 'foreign' }, { ...plan, ownerId: 'foreign' }, { ...plan, steps: [] }]) await assert.rejects(executor(bad, { ...current, execution: execution('save', 'draft') }, allowed), { code: 'TOOL_ARGUMENTS_INVALID' });
  await assert.rejects(executor(plan, { ...current, execution: { ...execution('save', 'draft'), idempotencyKey: 'unbound' } }, allowed), { code: 'TOOL_NOT_ALLOWED' });
  const session = registry.session(() => current); session.beforeStep(input); session.resolveTools();
  current = { ...current, ownerId: 'different-fictional-owner' };
  await assert.rejects(session.executeTool('use_skill', { id: 'career-intake' }, execution('load', 'read')), { code: 'TOOL_NOT_ALLOWED' });
});
test('parameter-level draft type, template and expert gates are checked before the executor', async () => {
  let commits = 0;
  const registry = new CapabilityRegistry({ registrations: ['draft_outbound', 'draft_authorization_card', 'start_background_task', 'consult'].map(id => ({ id, reviewed: true, execute: async () => { commits++; } })) });
  async function deniedCall(id: string, args: Record<string, unknown>, scope: CapabilityScope, effect: AgentToolExecution['effect']) {
    const bound: CapabilityExecutionScope = { ...scope, execution: execution('policy', effect) };
    await assert.rejects(registry.executorFor(id)!(args, bound, new Set([id])), { code: 'TOOL_NOT_ALLOWED' });
  }
  await deniedCall('draft_outbound', { kind: 'application_packet', content: 'Fictional material.', references: [] }, initial(), 'draft');
  await deniedCall('draft_outbound', { kind: 'mentor_packet', content: 'Fictional packet.', references: [] }, { ...initial(), profile: { speaker: 'guide' } }, 'draft');
  await deniedCall('draft_outbound', { kind: 'outreach_message', content: 'Fictional note.', references: [] }, { ...initial(), profile: { speaker: 'applier' } }, 'draft');
  await deniedCall('start_background_task', { template: 'resume_full_pass', brief: 'Fictional work.', inputs: [] }, initial(), 'background');
  await deniedCall('start_background_task', { template: 'job_triage', brief: 'Fictional work.', inputs: [] }, { ...initial(), profile: { speaker: 'applier' } }, 'background');
  const consentScope = { ...initial(), profile: { speaker: 'guide' as const }, phase: { ...initial().phase, enabledFeatures: ['P0', 'P1-1'] as const } };
  await deniedCall('draft_authorization_card', { kind: 'apply_authorization', targetId: 'fictional-application' }, consentScope, 'draft');
  await deniedCall('consult', { expert: 'planner', objective: 'Fictional objective', mode: 'advise' }, initial(), 'consult');
  const futureListed: CapabilityScope = { ...initial(), phase: { ...initial().phase, enabledFeatures: ['P0', 'P1-10'], enabledSpeakers: ['companion', 'guide', 'interviewer', 'applier', 'planner', 'coach', 'networker'] } };
  for (const expert of ['planner', 'coach', 'networker']) await deniedCall('consult', { expert, objective: 'Fictional objective', mode: 'advise' }, futureListed, 'consult');
  await deniedCall('consult', { expert: 'guide', objective: 'Fictional objective', mode: 'task', skillHint: 'application-preparation' }, initial(), 'consult');
  assert.equal(commits, 0);
});
