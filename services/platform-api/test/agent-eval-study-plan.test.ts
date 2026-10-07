import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { P0_EVAL_CASES, PILOT_CASE_IDS, FORMAL_CASE_IDS } from '../evals/cases.ts';
import { baselineInput, evalDigest } from '../evals/baseline-input.ts';
import { createEvalStudyPlan, assertEvalStudyPlan, assertStudyInput, studyEntry } from '../evals/study-plan.ts';

test('one frozen plan binds the actual120, fixed12 pilot and same-source20 formal scripts', () => {
  const plan = createEvalStudyPlan();
  assert.equal(plan.scripts.length, 120); assert.equal(plan.entries.length, 140);
  assert.deepEqual(plan.pilotCaseIds, PILOT_CASE_IDS.map(id => `development/${id}`));
  assert.deepEqual(plan.formalCaseIds, FORMAL_CASE_IDS.map(id => `formal/${id}`));
  assert.equal(plan.formalPilotCaseIds.length, 0);
  for (const speaker of ['companion', 'guide', 'applier', 'interviewer']) {
    assert.equal(plan.entries.filter(entry => entry.speaker === speaker && entry.caseId.startsWith('development/')).length, 30);
    assert.equal(plan.entries.filter(entry => entry.speaker === speaker && entry.stage === 'pilot').length, 3);
    assert.equal(plan.entries.filter(entry => entry.speaker === speaker && entry.caseId.startsWith('formal/')).length, 5);
  }
  for (const entry of plan.entries) {
    assert.equal(entry.purpose, entry.speaker === 'companion' ? 'companion_reply' : 'expert_consult');
    const item = plan.scripts.find(item => item.id === entry.scriptId)!;
    assert.equal(entry.scriptDigest, evalDigest(item));
    assert.equal(entry.seedInputDigest, evalDigest(baselineInput(item)));
    if (entry.caseId.startsWith('formal/')) {
      const development = studyEntry(plan, `development/${entry.scriptId}`);
      assert.equal(entry.scriptDigest, development.scriptDigest);
      assert.equal(entry.seedInputDigest, development.seedInputDigest);
    }
  }
});
test('deep immutability protects scripts, stage members and hash identity', () => {
  const original = structuredClone(P0_EVAL_CASES), plan = createEvalStudyPlan({ scripts: original });
  (original[0]!.state.facts as string[])[0] = 'Fictional caller mutation';
  assert.equal(plan.digest, createEvalStudyPlan().digest);
  assert.throws(() => { (plan.scripts[0]!.state.facts as string[])[0] = 'Fictional mutation'; }, TypeError);
  assert.throws(() => { (plan.formalCaseIds as string[]).push('fictional-unplanned'); }, TypeError);
  assert.throws(() => { (plan.entries[0] as { purpose: string }).purpose = 'room_turn'; }, TypeError);
  assert.notEqual(plan.scripts[0]!.state.facts[0], original[0]!.state.facts[0]);
});
test('same-ID changes to facts, history, prompt or criteria cannot replace the authored study', () => {
  const plan = createEvalStudyPlan(), caseId = plan.pilotCaseIds[0]!;
  for (const change of ['facts', 'history', 'prompt', 'criteria'] as const) {
    const changed = structuredClone(P0_EVAL_CASES);
    const item = changed[0]!;
    if (change === 'facts') (item.state.facts as string[]).push('Fictional added fact');
    else if (change === 'history') (item.history as { role: 'user'; content: string }[]).push({ role: 'user', content: 'Fictional changed input' });
    else if (change === 'prompt') (item as { prompt: string }).prompt += ' Fictional change';
    else (item.expectations as string[]).push('Fictional changed scoring');
    assert.throws(() => createEvalStudyPlan({ scripts: changed }), { code: 'EVAL_STUDY_INVALID' });
    assert.throws(() => assertStudyInput(plan, caseId, item), { code: 'EVAL_STUDY_INVALID' });
  }
});
test('unknown, duplicate, missing or swapped source scripts are not a size-only valid suite', () => {
  for (const changed of [P0_EVAL_CASES.slice(1), [...P0_EVAL_CASES.slice(1), P0_EVAL_CASES[1]!],
    [...P0_EVAL_CASES].reverse()]) assert.throws(() => createEvalStudyPlan({ scripts: changed }), { code: 'EVAL_STUDY_INVALID' });
  const changed = structuredClone(P0_EVAL_CASES);
  (changed[0] as { id: string }).id = 'fictional-unrelated';
  assert.throws(() => createEvalStudyPlan({ scripts: changed }), { code: 'EVAL_STUDY_INVALID' });
});
test('optional formal pilot is normalized and frozen only from the existing fixed20', () => {
  const selected = [FORMAL_CASE_IDS[1]!, FORMAL_CASE_IDS[0]!];
  const plan = createEvalStudyPlan({ formalPilotIds: selected }); selected.length = 0;
  assert.deepEqual(plan.formalPilotCaseIds, FORMAL_CASE_IDS.slice(0, 2).map(id => `formal/${id}`));
  assert.equal(plan.digest, createEvalStudyPlan({ formalPilotIds: FORMAL_CASE_IDS.slice(0, 2) }).digest);
  assert.notEqual(plan.digest, createEvalStudyPlan().digest);
  for (const ids of [['fictional-unknown'], [FORMAL_CASE_IDS[0]!, FORMAL_CASE_IDS[0]!], ['companion-02-en']]) {
    assert.throws(() => createEvalStudyPlan({ formalPilotIds: ids }), { code: 'EVAL_STUDY_INVALID' });
  }
});
test('a serialized or hand-forged plan is not an issued immutable study', () => {
  const plan = createEvalStudyPlan();
  assert.throws(() => assertEvalStudyPlan(structuredClone(plan)), { code: 'EVAL_STUDY_INVALID' });
  assert.throws(() => studyEntry(plan, 'unrelated-case'), { code: 'EVAL_STUDY_INVALID' });
  assert.throws(() => assertStudyInput(plan, plan.pilotCaseIds[0]!, plan.scripts[2]!), { code: 'EVAL_STUDY_INVALID' });
});
test('prompt-only seed excludes scoring criteria and retains declared conditions solely as supplied text', () => {
  const plan = createEvalStudyPlan();
  const item = plan.scripts.find(item => item.tags.includes('tool_failure'))!;
  const seed = baselineInput(item);
  assert.equal(plan.scope, 'prompt_only');
  const text = JSON.stringify(seed);
  for (const criterion of [...item.expectations, ...item.mustNot]) assert(!text.includes(criterion));
  assert(seed.persona.includes(JSON.stringify(item.state.toolCondition)));
  assert(!Object.hasOwn(seed, 'tools')); assert(!Object.hasOwn(seed, 'passed'));
});

function freshProcess(body: string): unknown {
  const casesUrl = new URL('../evals/cases.ts', import.meta.url).href;
  const planUrl = new URL('../evals/study-plan.ts', import.meta.url).href;
  const source = `const cases = await import(${JSON.stringify(casesUrl)});\n${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    source.replaceAll('STUDY_PLAN_URL', JSON.stringify(planUrl))], { encoding: 'utf8', timeout: 10_000 }));
}
test('fresh-process mutations before importing the plan cannot become reviewed canonical inputs', () => {
  for (const mutation of [
    "cases.P0_EVAL_CASES[0].prompt += ' Fictional pre-import revision';",
    "cases.P0_EVAL_CASES[0].state.facts.push('Fictional pre-import fact');",
    "cases.PILOT_CASE_IDS[0] = 'companion-02-en';",
    "cases.FORMAL_CASE_IDS[0] = 'companion-02-en';",
  ]) {
    const result = freshProcess(`${mutation}\ntry {
      const module = await import(STUDY_PLAN_URL); module.createEvalStudyPlan();
      console.log(JSON.stringify({issued:true}));
    } catch (error) { console.log(JSON.stringify({issued:false,code:error.code})); }`);
    assert.deepEqual(result, { issued: false, code: 'EVAL_STUDY_INVALID' });
  }
});
test('fresh-process post-capture mutations cannot revise an already anchored plan or input', () => {
  const result = freshProcess(`const module = await import(STUDY_PLAN_URL);
    const before = module.createEvalStudyPlan();
    const original = structuredClone(cases.P0_EVAL_CASES[0]);
    cases.P0_EVAL_CASES[0].prompt += ' Fictional late revision';
    cases.P0_EVAL_CASES[0].state.facts.push('Fictional late fact');
    cases.PILOT_CASE_IDS[0] = 'companion-02-en';
    cases.FORMAL_CASE_IDS[0] = 'companion-02-en';
    const after = module.createEvalStudyPlan();
    const accepted = module.assertStudyInput(after, 'development/' + original.id, original);
    let revisedRejected = false;
    try { module.assertStudyInput(after, 'development/' + original.id, cases.P0_EVAL_CASES[0]); }
    catch(error) { revisedRejected = error.code === 'EVAL_STUDY_INVALID'; }
    console.log(JSON.stringify({sameDigest:before.digest === after.digest,
      originalAccepted:accepted.prompt === original.prompt,
      samePilot:JSON.stringify(before.pilotCaseIds) === JSON.stringify(after.pilotCaseIds),
      sameFormal:JSON.stringify(before.formalCaseIds) === JSON.stringify(after.formalCaseIds), revisedRejected}));`);
  assert.deepEqual(result, { sameDigest: true, originalAccepted: true, samePilot: true, sameFormal: true, revisedRejected: true });
});
