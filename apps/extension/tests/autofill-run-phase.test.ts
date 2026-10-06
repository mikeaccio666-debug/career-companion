import { describe, expect, it } from 'vitest';

import { autofillRunPhase } from '../product-panel/runPhase';
import type { ProductPanelViewModel } from '../product-panel/model';

type Run = NonNullable<ProductPanelViewModel['run']>;
const question = (status: Run['questions'][number]['status'], order = 0) =>
  ({ id: `q${order}`, order, requirement: 'REQUIRED', status }) as Run['questions'][number];

const run = (over: Partial<Run>): Run => ({
  id: 'r1', progress: { phase: 'OBSERVED', observedControls: 3 }, questions: [], completeness: null, continueIntent: null, ...over,
} as Run);

describe('autofillRunPhase', () => {
  it('is IDLE with no run at all', () => {
    expect(autofillRunPhase(null)).toBe('IDLE');
  });
  it('is SCANNING while the page is only observed', () => {
    expect(autofillRunPhase(run({ progress: { phase: 'OBSERVED', observedControls: 3 } }))).toBe('SCANNING');
  });
  it('is READY once questions are composed but nothing reached the host yet', () => {
    expect(autofillRunPhase(run({
      progress: { phase: 'COMPOSED', observableQuestions: 6, authorizedQuestions: 5 },
      questions: [question('MANUAL_REQUIRED'), question('MANUAL_REQUIRED', 1)],
    }))).toBe('READY');
  });
  it('is FILLING as soon as one value reached the host before the run settled', () => {
    expect(autofillRunPhase(run({
      progress: { phase: 'COMPOSED', observableQuestions: 6, authorizedQuestions: 5 },
      questions: [question('FILLED'), question('MANUAL_REQUIRED', 1)],
    }))).toBe('FILLING');
  });
  it('is COMPLETE only when the run itself settled, never inferred from the rows', () => {
    expect(autofillRunPhase(run({
      progress: { phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 },
      questions: [question('FILLED'), question('MANUAL_REQUIRED', 1)],
    }))).toBe('COMPLETE');
  });
});
