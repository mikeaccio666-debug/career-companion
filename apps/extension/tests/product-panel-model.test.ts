import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_PANEL_QUESTION_STATUSES,
  summarizeProductPanel,
  validateProductPanelViewModel,
  type ProductPanelViewModel,
} from '../product-panel/model';
import {
  createContinueIntentGate,
  reduceProductPanelState,
  type ProductPanelContinueIntent,
} from '../product-panel/state';

const runningModel: ProductPanelViewModel = {
  revision: 2,
  entries: {
    currentJob: 'READY',
    autofillInformation: 'READY',
    resume: 'NEEDS_ATTENTION',
    coverLetter: 'UNAVAILABLE',
  },
  run: {
    id: 'run-demo-1',
    progress: {
      phase: 'SETTLED',
      requiredCompleted: 2,
      requiredQuestions: 5,
    },
    questions: [
      {
        id: 'q-prefilled',
        order: 0,
        requirement: 'REQUIRED',
        status: 'PREFILLED',
      },
      {
        id: 'q-filled',
        order: 1,
        requirement: 'REQUIRED',
        status: 'FILLED',
      },
      {
        id: 'q-ai-suggested',
        order: 2,
        requirement: 'REQUIRED',
        status: 'AI_SUGGESTED',
      },
      {
        id: 'q-confirmation',
        order: 3,
        requirement: 'REQUIRED',
        status: 'USER_CONFIRMATION_REQUIRED',
      },
      {
        id: 'q-manual',
        order: 4,
        requirement: 'REQUIRED',
        status: 'MANUAL_REQUIRED',
      },
      {
        id: 'q-policy-blocked',
        order: 5,
        requirement: 'OPTIONAL',
        status: 'POLICY_BLOCKED',
      },
      {
        id: 'q-discovery-incomplete',
        order: 6,
        requirement: 'OPTIONAL',
        status: 'DISCOVERY_INCOMPLETE',
      },
    ],
    // One question was never reached, so the run is not whole-page complete.
    completeness: { discoveryComplete: false, unobservedRegions: 0 },
    continueIntent: {
      kind: 'CONTINUE_TO_NEXT_PAGE',
      intentId: 'continue-demo-1',
    },
  },
};

describe('Product Panel value-free model', () => {
  it('closes the logical-question status set and derives one denominator', () => {
    expect(PRODUCT_PANEL_QUESTION_STATUSES).toEqual([
      'PREFILLED',
      'FILLED',
      'AI_SUGGESTED',
      'USER_CONFIRMATION_REQUIRED',
      'MANUAL_REQUIRED',
      'POLICY_BLOCKED',
      'DISCOVERY_INCOMPLETE',
    ]);
    expect(validateProductPanelViewModel(runningModel)).toEqual({
      ok: true,
      model: runningModel,
    });
    expect(summarizeProductPanel(runningModel)).toEqual({
      phase: 'SETTLED',
      observedControls: null,
      authorizedQuestions: null,
      detected: 7,
      requiredFilled: 2,
      requiredTotal: 5,
      requiredPercentage: 40,
      discoveryComplete: false,
      unobservedRegions: 0,
      required: runningModel.run?.questions.slice(0, 5),
      optional: runningModel.run?.questions.slice(5),
    });
  });

  it('ties completeness to the rows and regions, so a partially observed page cannot read as whole', () => {
    const run = runningModel.run!;
    const observedOnly = run.questions.filter((question) => question.status !== 'DISCOVERY_INCOMPLETE');
    const complete: ProductPanelViewModel = {
      ...runningModel,
      run: { ...run, questions: observedOnly, completeness: { discoveryComplete: true, unobservedRegions: 0 } },
    };
    expect(validateProductPanelViewModel(complete)).toEqual({ ok: true, model: complete });
    expect(summarizeProductPanel(complete)).toMatchObject({ discoveryComplete: true, unobservedRegions: 0 });

    // A region the scan reached but could not observe into: not a question, yet
    // it withdraws the whole-page claim and is counted for the panel.
    const withRegion: ProductPanelViewModel = {
      ...complete,
      run: { ...complete.run!, completeness: { discoveryComplete: false, unobservedRegions: 1 } },
    };
    expect(validateProductPanelViewModel(withRegion)).toEqual({ ok: true, model: withRegion });
    expect(summarizeProductPanel(withRegion)).toMatchObject({
      requiredPercentage: 40, discoveryComplete: false, unobservedRegions: 1,
    });

    const rejected = (candidate: unknown) => {
      expect(validateProductPanelViewModel(candidate)).toEqual({ ok: false, code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID' });
    };
    // Complete claimed over an unobserved region, or over an unreached question.
    rejected({ ...withRegion, run: { ...withRegion.run!, completeness: { discoveryComplete: true, unobservedRegions: 1 } } });
    rejected({ ...runningModel, run: { ...run, completeness: { discoveryComplete: true, unobservedRegions: 0 } } });
    // Incomplete claimed with nothing unreached and nothing unobserved.
    rejected({ ...complete, run: { ...complete.run!, completeness: { discoveryComplete: false, unobservedRegions: 0 } } });
    // Completeness is required once settled, exact-keyed, and bounded.
    rejected({ ...complete, run: { ...complete.run!, completeness: null } });
    const { completeness: _completeness, ...withoutCompleteness } = complete.run!;
    rejected({ ...complete, run: withoutCompleteness });
    rejected({ ...complete, run: { ...complete.run!, completeness: { discoveryComplete: true, unobservedRegions: 0, src: 'x' } } });
    rejected({ ...complete, run: { ...complete.run!, completeness: { discoveryComplete: true, unobservedRegions: -1 } } });
    rejected({ ...complete, run: { ...complete.run!, completeness: { discoveryComplete: 'yes', unobservedRegions: 0 } } });
    // Before SETTLED nothing is established: completeness must be null.
    rejected({
      ...complete,
      run: {
        ...complete.run!, progress: { phase: 'OBSERVED', observedControls: 7 }, questions: [], continueIntent: null,
        completeness: { discoveryComplete: false, unobservedRegions: 0 },
      },
    });
  });

  it('requires UA-5 progress and rejects unknown states, duplicate identity, and extra row fields', () => {
    const question = runningModel.run!.questions[0]!;
    const secondQuestion = runningModel.run!.questions[1]!;
    const cases: unknown[] = [
      {
        ...runningModel,
        run: {
          id: runningModel.run!.id,
          questions: runningModel.run!.questions,
          continueIntent: runningModel.run!.continueIntent,
        },
      },
      {
        ...runningModel,
        run: {
          ...runningModel.run,
          questions: [
            { ...question, status: 'FAILED' },
            ...runningModel.run!.questions.slice(1),
          ],
        },
      },
      {
        ...runningModel,
        run: {
          ...runningModel.run,
          questions: [
            question,
            { ...secondQuestion, id: question.id },
            ...runningModel.run!.questions.slice(2),
          ],
        },
      },
      {
        ...runningModel,
        run: {
          ...runningModel.run,
          questions: [
            question,
            { ...secondQuestion, order: question.order },
            ...runningModel.run!.questions.slice(2),
          ],
        },
      },
      {
        ...runningModel,
        run: {
          ...runningModel.run,
          questions: [
            { ...question, presentationKey: 'FULL_NAME' },
            ...runningModel.run!.questions.slice(1),
          ],
        },
      },
      {
        ...runningModel,
        run: {
          ...runningModel.run,
          questions: [
            { ...question, semanticReadbackEventId: 'readback-not-projected' },
            ...runningModel.run!.questions.slice(1),
          ],
        },
      },
    ];

    for (const candidate of cases) {
      expect(validateProductPanelViewModel(candidate)).toEqual({
        ok: false,
        code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID',
      });
    }
  });

  it('accepts the official 500-row and 128-character id maxima and rejects overflow', () => {
    const boundaryQuestions = Array.from({ length: 500 }, (_, order) => ({
      id: order === 0 ? 'q'.repeat(128) : `q-${order}`,
      order,
      requirement: 'OPTIONAL' as const,
      status: 'DISCOVERY_INCOMPLETE' as const,
    }));
    const valid: ProductPanelViewModel = {
      ...runningModel,
      run: {
        ...runningModel.run!,
        progress: {
          phase: 'SETTLED',
          requiredCompleted: 0,
          requiredQuestions: 0,
        },
        questions: boundaryQuestions,
      },
    };
    expect(validateProductPanelViewModel(valid)).toEqual({ ok: true, model: valid });

    const tooManyRows = {
      ...valid,
      run: {
        ...valid.run!,
        questions: [
          ...boundaryQuestions,
          {
            id: 'q-overflow',
            order: 500,
            requirement: 'OPTIONAL',
            status: 'DISCOVERY_INCOMPLETE',
          },
        ],
      },
    };
    expect(validateProductPanelViewModel(tooManyRows)).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID',
    });

    const oversizedId = {
      ...valid,
      run: {
        ...valid.run!,
        questions: [
          { ...boundaryQuestions[0]!, id: 'q'.repeat(129) },
          ...boundaryQuestions.slice(1),
        ],
      },
    };
    expect(validateProductPanelViewModel(oversizedId)).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID',
    });
  });

  it('maps hostile accessors to the stable invalid-model result', () => {
    const candidate = { revision: 1, run: null } as Record<string, unknown>;
    Object.defineProperty(candidate, 'entries', {
      enumerable: true,
      get() {
        throw new Error('private accessor detail');
      },
    });
    expect(() => validateProductPanelViewModel(candidate)).not.toThrow();
    expect(validateProductPanelViewModel(candidate)).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID',
    });
  });

  it('returns a deeply frozen canonical projection with no caller-owned array payload', () => {
    const candidate = structuredClone(runningModel) as ProductPanelViewModel;
    const questions = candidate.run!.questions as unknown as Array<{ status: string }>;
    const validated = validateProductPanelViewModel(candidate);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.model).not.toBe(candidate);
    expect(validated.model.run?.questions).not.toBe(candidate.run?.questions);
    expect(Object.isFrozen(validated.model)).toBe(true);
    expect(Object.isFrozen(validated.model.entries)).toBe(true);
    expect(Object.isFrozen(validated.model.run)).toBe(true);
    expect(Object.isFrozen(validated.model.run?.progress)).toBe(true);
    expect(Object.isFrozen(validated.model.run?.questions)).toBe(true);
    expect(Object.isFrozen(validated.model.run?.questions[0])).toBe(true);
    expect(Object.isFrozen(validated.model.run?.continueIntent)).toBe(true);

    (questions[1] as { status: string }).status = 'POLICY_BLOCKED';
    expect(validated.model.run?.questions[1]?.status).toBe('FILLED');

    const withArrayPayload = structuredClone(runningModel) as ProductPanelViewModel;
    Object.defineProperty(withArrayPayload.run!.questions, 'rawPagePayload', {
      enumerable: false,
      value: 'private page text',
    });
    expect(validateProductPanelViewModel(withArrayPayload)).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_VIEW_MODEL_INVALID',
    });
  });

  it('canonicalizes descriptor snapshots without re-reading a stateful Proxy', () => {
    const sourceQuestion = structuredClone(runningModel.run!.questions[0]!);
    let directReads = 0;
    const statefulQuestion = new Proxy(sourceQuestion, {
      get(target, property, receiver) {
        if (property === 'id') {
          directReads += 1;
          return directReads < 4 ? 'q-safe' : 'host-page-value';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const candidate = {
      ...structuredClone(runningModel),
      run: {
        ...structuredClone(runningModel.run!),
        questions: [statefulQuestion, ...structuredClone(runningModel.run!.questions.slice(1))],
      },
    };

    const validated = validateProductPanelViewModel(candidate);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.model.run?.questions[0]?.id).toBe('q-prefilled');
    expect(directReads).toBe(0);
  });
});

describe('Product Panel three-state reducer', () => {
  it('moves home → expanded → sticky collapsed → expanded without losing the run', () => {
    const presented = reduceProductPanelState(
      { kind: 'HOME' },
      { type: 'PRESENT_RUN', runId: 'run-demo-1' },
    );
    expect(presented).toEqual({
      ok: true,
      state: { kind: 'AUTOFILL_EXPANDED', runId: 'run-demo-1' },
    });
    const collapsed = reduceProductPanelState(
      presented.state,
      { type: 'COLLAPSE_AUTOFILL', runId: 'run-demo-1' },
    );
    expect(collapsed).toEqual({
      ok: true,
      state: { kind: 'AUTOFILL_STICKY_COLLAPSED', runId: 'run-demo-1' },
    });
    expect(reduceProductPanelState(
      collapsed.state,
      { type: 'EXPAND_AUTOFILL', runId: 'run-demo-1' },
    )).toEqual({
      ok: true,
      state: { kind: 'AUTOFILL_EXPANDED', runId: 'run-demo-1' },
    });
  });

  it('fails closed on a stale run transition', () => {
    const state = { kind: 'AUTOFILL_EXPANDED', runId: 'run-demo-1' } as const;
    expect(reduceProductPanelState(
      state,
      { type: 'COLLAPSE_AUTOFILL', runId: 'run-stale' },
    )).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_TRANSITION_INVALID',
      state,
    });
  });
});

describe('Continue intent one-shot gate', () => {
  const intent: ProductPanelContinueIntent = {
    kind: 'CONTINUE_TO_NEXT_PAGE',
    runId: 'run-demo-1',
    intentId: 'continue-demo-1',
  };

  it('consumes before awaiting and never dispatches the same intent twice', async () => {
    let resolveFirst!: () => void;
    const pending = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const handler = vi.fn(async () => {
      await pending;
      return { ok: true } as const;
    });
    const gate = createContinueIntentGate(handler);

    const first = gate.dispatch(intent);
    const second = await gate.dispatch(intent);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ok: false, code: 'CONTINUE_INTENT_ALREADY_CONSUMED' });

    resolveFirst();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(gate.dispatch(intent)).resolves.toEqual({
      ok: false,
      code: 'CONTINUE_INTENT_ALREADY_CONSUMED',
    });
  });

  it('maps thrown details to a stable code and permits only a new intent id', async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('must not reach the view'))
      .mockResolvedValueOnce({ ok: true });
    const gate = createContinueIntentGate(handler);

    await expect(gate.dispatch(intent)).resolves.toEqual({
      ok: false,
      code: 'CONTINUE_INTENT_UNAVAILABLE',
    });
    await expect(gate.dispatch({ ...intent, intentId: 'continue-demo-2' })).resolves.toEqual({
      ok: true,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
