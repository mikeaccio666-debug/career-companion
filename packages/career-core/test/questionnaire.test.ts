import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS } from '@companion/platform-contracts';
import { onboardingQuestionDefinition } from '../src/index.ts';

test('questionnaire revision 1 has fixed meaningful definitions for every canonical question', () => {
  for (const id of [...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra'] as const) {
    const definition = onboardingQuestionDefinition(id);
    assert.equal(definition.questionId, id); assert(definition.prompt.length > 4);
    assert(Object.isFrozen(definition)); assert(Object.isFrozen(definition.choices));
    for (const choice of definition.choices) assert(Object.isFrozen(choice));
    assert.equal(new Set(definition.choices.map(choice => choice.value)).size, definition.choices.length);
  }
  assert.equal(onboardingQuestionDefinition('Q1').choices[1].label, '帮我把剩下的拆成明天能做完的两件');
  assert.equal(onboardingQuestionDefinition('Q2').choices.length, 3);
  assert.equal(onboardingQuestionDefinition('Q4').choices.length, 4);
  assert.equal(onboardingQuestionDefinition('extra').choices.length, 0);
  assert.throws(() => onboardingQuestionDefinition('unknown' as never));
});
