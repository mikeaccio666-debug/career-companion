import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FORMAL_CASE_IDS,
  P0_EVAL_CASES,
  P0_EVAL_SPEAKERS,
  PILOT_CASE_IDS,
  type P0EvalSpeaker,
  type ScriptCase,
} from '../evals/cases.ts';

const byId = new Map(P0_EVAL_CASES.map(script => [script.id, script]));
const selected = (ids: readonly string[]): ScriptCase[] => ids.map(id => {
  const script = byId.get(id);
  assert.ok(script, `Unknown selected script: ${id}`);
  return script;
});
const forSpeaker = (cases: readonly ScriptCase[], speaker: P0EvalSpeaker) => cases.filter(script => script.speaker === speaker);
const assertBalancedLanguages = (cases: readonly ScriptCase[]) => {
  assert.equal(cases.filter(script => script.language === 'zh').length, cases.length / 2);
  assert.equal(cases.filter(script => script.language === 'en').length, cases.length / 2);
};
const assertNonFirstCoverage = (cases: readonly ScriptCase[]) => {
  assert.ok(cases.filter(script => script.turnKind !== 'opening').length / cases.length >= 0.3);
};

test('corpus has 120 unique scripts and 60 explicitly identified translation pairs', () => {
  assert.equal(P0_EVAL_CASES.length, 120);
  assert.equal(byId.size, 120);
  const pairs = new Map<string, ScriptCase[]>();
  for (const script of P0_EVAL_CASES) {
    assert.match(script.id, /^(companion|guide|applier|interviewer)-\d{2}-(zh|en)$/);
    assert.equal(script.id, `${script.pairId}-${script.language}`);
    assert.equal(script.translationPair, true);
    const pair = pairs.get(script.pairId) ?? [];
    pair.push(script);
    pairs.set(script.pairId, pair);
  }
  assert.equal(pairs.size, 60);
  assert.equal(new Set([...pairs.values()].map(pair => pair[0]!.title)).size, 60);
  for (const pair of pairs.values()) {
    assert.equal(pair.length, 2);
    assertBalancedLanguages(pair);
    const [left, right] = pair;
    assert.ok(left && right);
    assert.equal(left.speaker, right.speaker);
    assert.equal(left.title, right.title);
    assert.equal(left.turnKind, right.turnKind);
    assert.deepEqual(left.tags, right.tags);
    assert.deepEqual(left.student, right.student);
    assert.deepEqual(left.state.toolCondition, right.state.toolCondition);
    assert.deepEqual(left.expectations, right.expectations);
    assert.notEqual(left.prompt, right.prompt);
  }
});

test('each of the four speakers has 30 scripts with 15 Chinese and 15 English prompts', () => {
  assert.equal(new Set(P0_EVAL_CASES.map(script => script.speaker)).size, 4);
  for (const speaker of P0_EVAL_SPEAKERS) {
    const scripts = forSpeaker(P0_EVAL_CASES, speaker);
    assert.equal(scripts.length, 30);
    assertBalancedLanguages(scripts);
    for (const script of scripts) {
      assert.ok(script.prompt.trim().length > 0);
      if (script.language === 'zh') assert.match(script.prompt, /\p{Script=Han}/u);
      else assert.doesNotMatch(script.prompt, /\p{Script=Han}/u);
    }
  }
  assert.equal(new Set(P0_EVAL_CASES.map(script => script.prompt)).size, 120);
});

test('scripts use independent fictional STEM new-grad identities and explicit source state', () => {
  const identities = new Map<string, string>();
  for (const script of P0_EVAL_CASES) {
    assert.equal(script.student.fictional, true);
    assert.equal(script.student.degree, 'M.S. Computer Science');
    assert.equal(script.student.location, 'United States');
    assert.equal(script.student.graduation, '2027-05');
    assert.equal(script.student.targetStage, 'new_grad');
    assert.match(script.student.fixtureId, /^fictional-/);
    const existingPair = identities.get(script.student.fixtureId);
    if (existingPair) assert.equal(existingPair, script.pairId);
    identities.set(script.student.fixtureId, script.pairId);
    assert.ok(script.state.facts.length > 0);
    assert.ok(script.state.facts.every(fact => fact.trim().length > 0));
    assert.ok(script.expectations.length >= 2);
    assert.ok(script.expectations.every(criterion => criterion.trim().length > 0));
    assert.ok(script.mustNot.length >= 3);
    // Corpus inputs never include an asserted model completion or an executed route/card.
    assert.equal(Object.hasOwn(script, 'completion'), false);
    assert.equal(Object.hasOwn(script, 'route'), false);
    assert.equal(Object.hasOwn(script, 'card'), false);
    assert.equal(Object.hasOwn(script, 'passed'), false);
  }
  assert.equal(identities.size, 60);
});

test('at least 30 percent per speaker are actual follow-ups, answers or thanks with prior conversation', () => {
  assertNonFirstCoverage(P0_EVAL_CASES);
  for (const speaker of P0_EVAL_SPEAKERS) {
    const scripts = forSpeaker(P0_EVAL_CASES, speaker);
    assertNonFirstCoverage(scripts);
    for (const kind of ['followup', 'answer', 'thanks']) {
      assert.ok(scripts.some(script => script.turnKind === kind), `${speaker} lacks ${kind}`);
    }
  }
  for (const script of P0_EVAL_CASES) {
    if (script.turnKind === 'opening') {
      assert.equal(script.history.length, 0);
      continue;
    }
    assert.ok(script.history.length >= 2);
    assert.equal(script.history.at(-1)?.role, 'assistant');
    assert.ok(script.history.some(message => message.role === 'user'));
    for (const [index, message] of script.history.entries()) {
      assert.equal(message.role, index % 2 === 0 ? 'user' : 'assistant');
      assert.ok(message.content.trim().length > 0);
    }
  }
});

test('every role includes task, missing-input, failure, unauthorized and harmless-exaggeration cases', () => {
  for (const speaker of P0_EVAL_SPEAKERS) {
    const scripts = forSpeaker(P0_EVAL_CASES, speaker);
    for (const tag of ['typical_task', 'missing_input', 'tool_failure', 'unauthorized_request', 'harmless_hyperbole'] as const) {
      assert.ok(scripts.some(script => script.tags.includes(tag)), `${speaker} lacks ${tag}`);
    }
    assert.ok(scripts.some(script => script.tags.includes('untrusted_data')));
    assert.ok(scripts.some(script => script.tags.includes('evidence_boundary')));
  }
  for (const script of P0_EVAL_CASES) {
    assert.equal(new Set(script.tags).size, script.tags.length);
    if (script.tags.includes('tool_failure')) {
      assert.ok(script.state.toolCondition, `Missing synthetic port condition: ${script.id}`);
      assert.match(script.state.toolCondition.tool, /^[a-z][a-z0-9_]*$/);
      assert.ok(['timeout', 'unavailable', 'denied', 'empty'].includes(script.state.toolCondition.outcome));
    } else {
      assert.equal(script.state.toolCondition, undefined);
    }
  }
});

test('formal sample is fixed, fair, language-balanced and covers earlier and later turns', () => {
  assert.equal(FORMAL_CASE_IDS.length, 20);
  assert.equal(new Set(FORMAL_CASE_IDS).size, 20);
  const formal = selected(FORMAL_CASE_IDS);
  assertBalancedLanguages(formal);
  assertNonFirstCoverage(formal);
  assert.equal(new Set(formal.map(script => script.pairId)).size, 20);
  for (const speaker of P0_EVAL_SPEAKERS) {
    const scripts = forSpeaker(formal, speaker);
    assert.equal(scripts.length, 5);
    assert.ok(scripts.some(script => script.language === 'zh'));
    assert.ok(scripts.some(script => script.language === 'en'));
    assert.ok(scripts.some(script => script.turnKind === 'opening'));
    assert.ok(scripts.some(script => script.turnKind !== 'opening'));
    assert.ok(scripts.some(script => script.tags.includes('tool_failure')));
    assert.ok(scripts.some(script => script.tags.includes('unauthorized_request')));
  }
  assert.deepEqual(selected(FORMAL_CASE_IDS).map(script => script.id), FORMAL_CASE_IDS);
});

test('10 percent pilot is fixed and nested in formal sample with three cases per role', () => {
  assert.equal(PILOT_CASE_IDS.length, P0_EVAL_CASES.length * 0.1);
  assert.equal(PILOT_CASE_IDS.length, 12);
  assert.equal(new Set(PILOT_CASE_IDS).size, 12);
  assert.ok(PILOT_CASE_IDS.every(id => FORMAL_CASE_IDS.includes(id)));
  const pilot = selected(PILOT_CASE_IDS);
  assertBalancedLanguages(pilot);
  assertNonFirstCoverage(pilot);
  assert.equal(new Set(pilot.map(script => script.pairId)).size, 12);
  for (const speaker of P0_EVAL_SPEAKERS) {
    const scripts = forSpeaker(pilot, speaker);
    assert.equal(scripts.length, 3);
    assert.ok(scripts.some(script => script.language === 'zh'));
    assert.ok(scripts.some(script => script.language === 'en'));
    assert.ok(scripts.some(script => script.turnKind === 'opening'));
    assert.ok(scripts.some(script => script.turnKind !== 'opening'));
  }
  assert.deepEqual(selected(PILOT_CASE_IDS).map(script => script.id), PILOT_CASE_IDS);
});
