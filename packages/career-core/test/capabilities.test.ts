import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPERT_KEYS } from '@companion/platform-contracts';
import { CAREER_CAPABILITIES, CAREER_SKILLS, capabilityPermitted, capabilityVisible, careerCapability, careerSkill, careerSkillCompletion, careerSkillIndex, careerSkillOutputMatchesContract, type CareerCapabilityPhase } from '../src/index.ts';

const phase: CareerCapabilityPhase = { enabledFeatures: ['P0'], enabledSpeakers: ['companion', 'guide', 'interviewer', 'applier'], reviewedSkills: [] };
test('student capabilities exclude act, workbench, mentor rooms and background conversation effects', () => {
  const forbidden = ['create_job', 'prepare_browser_task', 'executeCli', 'prepare_mcp_task', 'read_saved_memories'];
  assert.equal(CAREER_CAPABILITIES.some(item => item.effect === 'act'), false);
  for (const name of forbidden) assert.equal(careerCapability(name), undefined);
  for (const speaker of ['companion', ...EXPERT_KEYS] as const) {
    for (const capability of CAREER_CAPABILITIES) assert.equal(capabilityPermitted(capability, { speaker }, { kind: 'mentor_room' }, phase), false);
  }
  for (const id of ['consult', 'ask_user', 'start_background_task']) assert.equal(capabilityPermitted(careerCapability(id)!, { speaker: 'companion' }, { kind: 'main', background: true }, phase), false);
  assert.equal(capabilityPermitted(careerCapability('save_plan_draft')!, { speaker: 'companion' }, { kind: 'main', background: true }, phase), true);
});
test('speaker, room and independent future feature gates all apply', () => {
  assert.equal(capabilityPermitted(careerCapability('consult')!, { speaker: 'guide' }, { kind: 'main' }, phase), false);
  assert.equal(capabilityPermitted(careerCapability('use_skill')!, { speaker: 'guide' }, { kind: 'expert_room', expert: 'applier' }, phase), false);
  assert.equal(capabilityPermitted(careerCapability('save_practice_record')!, { speaker: 'interviewer' }, { kind: 'interview' }, phase), true);
  assert.equal(capabilityPermitted(careerCapability('use_skill')!, { speaker: 'guide' }, { kind: 'interview' }, phase), false);
  const future = { ...phase, enabledFeatures: ['P0', 'P1-10'] as const, enabledSpeakers: [...phase.enabledSpeakers, 'planner', 'coach', 'networker'] as const };
  for (const speaker of ['planner', 'coach', 'networker'] as const) assert.equal(capabilityPermitted(careerCapability('search_memories')!, { speaker }, { kind: 'main' }, future), false);
  assert.equal(capabilityPermitted(careerCapability('search_org_knowledge')!, { speaker: 'companion' }, { kind: 'main' }, phase), false);
});
test('skill tools become visible only for their reviewed enabled owner', () => {
  const save = careerCapability('save_plan_draft')!;
  assert.equal(capabilityVisible(save, { speaker: 'companion' }, { kind: 'main' }, phase), false);
  assert.equal(capabilityVisible(save, { speaker: 'companion', loadedSkillIds: ['career-intake'] }, { kind: 'main' }, phase), false);
  assert.equal(capabilityVisible(save, { speaker: 'companion', loadedSkillIds: ['career-intake'] }, { kind: 'main' }, { ...phase, reviewedSkills: ['career-intake'] }), true);
  assert.equal(capabilityVisible(careerCapability('save_story_draft')!, { speaker: 'applier', loadedSkillIds: ['evidence-story'] }, { kind: 'main' }, { ...phase, reviewedSkills: ['evidence-story'] }), false);
});
test('skill index stays within its character budget and contains no full instructions or gated skills', () => {
  const input = { speaker: 'guide' as const, enabledFeatures: ['P0', 'P1-10'] as const, reviewedSkills: ['resume-revision', 'evidence-story', 'mentor-handoff'] as const, contextCharacters: 5000 };
  const full = careerSkillIndex({ ...input, contextCharacters: 100000 });
  assert.ok(full.text.includes('mentor-handoff:'));
  assert.equal(full.text.includes(careerSkill('evidence-story').instructions), false);
  const short = careerSkillIndex(input);
  assert.ok(short.text.length <= 100);
  assert.equal(short.omitted[0], 'mentor-handoff');
  assert.deepEqual(careerSkillIndex({ ...input, reviewedSkills: [], contextCharacters: 100000 }), { text: '', omitted: [] });
  assert.equal(careerSkillIndex({ ...input, contextCharacters: 0 }).text, '');
});
test('manifests describe owned procedures and immutable structured output, without invented published references', () => {
  assert.equal(CAREER_SKILLS.length, 12);
  for (const skill of CAREER_SKILLS) {
    assert.ok(Array.from(skill.whenToUse).length <= 80);
    assert.ok(skill.instructions.length < 5000);
    assert.equal(Object.isFrozen(skill.outputContract), true);
    assert.deepEqual(skill.methodRefs, []);
    assert.ok(skill.evals.length > 0);
    assert.equal(skill.tools.some(tool => ['save_practice_draft', 'prepare_application_draft'].includes(tool)), false);
  }
  assert.equal(careerSkill('application-preparation').revision, 2);
  assert.equal(careerSkill('role-exploration').tools.includes('search_jobs'), false);
  assert.equal((careerSkill('application-preparation').outputContract.properties as any).application_packet.type, 'object');
});
test('completion requires the structured output and actual draft artifact receipts; a question remains pending', () => {
  const output = { fact_inventory: [{ fact: 'Fictional course project', sourceId: 'fictional-project', contribution: 'personal' }], story_draft: { id: 'fictional-story-draft', revision: 1, status: 'draft' }, follow_up_questions: [], evidence_gaps: [] };
  const receipt = { tool: 'save_story_draft' as const, id: 'fictional-story-draft', revision: 1 };
  assert.deepEqual(careerSkillCompletion('evidence-story', { output, finalText: 'The draft is ready for review.', successfulSaves: [receipt] }), { complete: true, reasons: [] });
  assert.equal(careerSkillCompletion('evidence-story', { output, finalText: 'Does this look right?', successfulSaves: [receipt] }).complete, false);
  assert.ok(careerSkillCompletion('evidence-story', { output, finalText: 'Ready.', successfulSaves: [] }).reasons.includes('draft_save_unconfirmed'));
  assert.ok(careerSkillCompletion('evidence-story', { output, finalText: 'Ready.', successfulSaves: [{ ...receipt, id: 'another-draft' }] }).reasons.includes('output_artifact_unconfirmed'));
  assert.ok(careerSkillCompletion('evidence-story', { output: { ...output, story_draft: ['Done'] }, finalText: 'Ready.', successfulSaves: [receipt] }).reasons.includes('output_contract_failed'));
});
test('output checking rejects unsupported schema types and keywords rather than silently passing future contracts', () => {
  assert.equal(careerSkillOutputMatchesContract('anything', { type: 'string', pattern: '^verified$' }), false);
  assert.equal(careerSkillOutputMatchesContract('bad-date', { type: 'string', format: 'date-time' }), false);
  assert.equal(careerSkillOutputMatchesContract(true, { type: 'boolean' }), false);
  assert.equal(careerSkillOutputMatchesContract({}, { oneOf: [{ type: 'object' }] }), false);
  assert.equal(careerSkillOutputMatchesContract({}, {}), false);
  assert.equal(careerSkillOutputMatchesContract('ready', { type: 'string', minLength: 1 }), true);
});
test('future engine tools have explicit skill bindings while deferred modes remain closed', () => {
  const loaded = { speaker: 'companion' as const, loadedSkillIds: ['career-intake'] as const }, enabled = { ...phase, reviewedSkills: ['career-intake'] as const };
  for (const id of ['update_plan', 'start_background_task', 'read_task_result']) {
    assert.equal(careerCapability(id)!.visibility, 'skill');
    assert.equal(capabilityVisible(careerCapability(id)!, loaded, { kind: 'main' }, enabled), true);
    assert.equal(capabilityVisible(careerCapability(id)!, { speaker: 'companion' }, { kind: 'main' }, enabled), false);
  }
  assert.equal(careerCapability('schedule_reminder')!.visibility, 'deferred');
});
