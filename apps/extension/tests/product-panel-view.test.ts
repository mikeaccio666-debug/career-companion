// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProductPanelEntryIntent,
  ProductPanelIntentResult,
  ProductPanelStartIntent,
  ProductPanelUndoIntent,
  ProductPanelViewAdapter,
} from '../product-panel/panel';
import { mountProductPanel } from '../product-panel/panel';
import type { ProductPanelContinueIntent } from '../product-panel/state';
import type { ProductPanelViewModel } from '../product-panel/model';

const originalAnimate = HTMLElement.prototype.animate;

const homeModel: ProductPanelViewModel = {
  revision: 1,
  entries: {
    currentJob: 'READY',
    autofillInformation: 'READY',
    resume: 'NEEDS_ATTENTION',
    coverLetter: 'UNAVAILABLE',
  },
  run: null,
};

const runningModel: ProductPanelViewModel = {
  ...homeModel,
  revision: 2,
  run: {
    id: 'run-demo-1',
    progress: {
      phase: 'SETTLED',
      requiredCompleted: 2,
      requiredQuestions: 5,
    },
    questions: [
      {
        id: 'q-filled', order: 0, requirement: 'REQUIRED', status: 'FILLED',
      },
      {
        id: 'q-prefilled', order: 1, requirement: 'REQUIRED', status: 'PREFILLED',
      },
      {
        id: 'q-suggested', order: 2, requirement: 'REQUIRED', status: 'AI_SUGGESTED',
      },
      {
        id: 'q-confirmation', order: 3, requirement: 'REQUIRED',
        status: 'USER_CONFIRMATION_REQUIRED',
      },
      {
        id: 'q-manual', order: 4, requirement: 'REQUIRED', status: 'MANUAL_REQUIRED',
      },
      {
        id: 'q-blocked', order: 5, requirement: 'OPTIONAL', status: 'POLICY_BLOCKED',
      },
      {
        id: 'q-incomplete', order: 6, requirement: 'OPTIONAL', status: 'DISCOVERY_INCOMPLETE',
      },
    ],
    completeness: { discoveryComplete: false, unobservedRegions: 0 },
    continueIntent: { kind: 'CONTINUE_TO_NEXT_PAGE', intentId: 'continue-demo-1' },
  },
};

const observedModel: ProductPanelViewModel = {
  ...homeModel,
  revision: 2,
  run: {
    id: 'run-progress-1',
    progress: { phase: 'OBSERVED', observedControls: 7 },
    questions: [],
    completeness: null,
    continueIntent: null,
  },
};

const composedModel: ProductPanelViewModel = {
  ...observedModel,
  revision: 3,
  run: {
    ...observedModel.run!,
    progress: {
      phase: 'COMPOSED',
      observableQuestions: 7,
      authorizedQuestions: 2,
    },
  },
};

const progressedModel: ProductPanelViewModel = {
  ...runningModel,
  revision: 3,
  run: {
    ...runningModel.run!,
    progress: {
      phase: 'SETTLED',
      requiredCompleted: 4,
      requiredQuestions: 5,
    },
    questions: runningModel.run!.questions.map((question) => {
      if (question.id === 'q-suggested') return { ...question, status: 'FILLED' as const };
      if (question.id === 'q-confirmation') return { ...question, status: 'PREFILLED' as const };
      return question;
    }),
    continueIntent: null,
  },
};

function createAdapter(initial = homeModel): ProductPanelViewAdapter & {
  emit(model: ProductPanelViewModel): void;
  start: ReturnType<typeof vi.fn<(intent: ProductPanelStartIntent) => Promise<ProductPanelIntentResult>>>;
  next: ReturnType<typeof vi.fn<(intent: ProductPanelContinueIntent) => Promise<ProductPanelIntentResult>>>;
  openEntry: ReturnType<typeof vi.fn<(intent: ProductPanelEntryIntent) => Promise<ProductPanelIntentResult>>>;
  undo: ReturnType<typeof vi.fn<(intent: ProductPanelUndoIntent) => Promise<ProductPanelIntentResult>>>;
} {
  let snapshot = initial;
  const listeners = new Set<(model: ProductPanelViewModel) => void>();
  const start = vi.fn(async () => ({ ok: true }) as const);
  const next = vi.fn(async () => ({ ok: true }) as const);
  const openEntry = vi.fn(async () => ({ ok: true }) as const);
  const undo = vi.fn(async () => ({ ok: true }) as const);
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestStartAutofill: start,
    requestContinue: next,
    requestOpenEntry: openEntry,
    requestUndoField: undo,
    emit(model) {
      snapshot = model;
      for (const listener of listeners) listener(model);
    },
    start,
    next,
    openEntry,
    undo,
  };
}

function mountedView(initial = homeModel, options: Parameters<typeof mountProductPanel>[2] = {}) {
  const root = document.createElement('main');
  const adapter = createAdapter(initial);
  mountProductPanel(root, adapter, options);
  return { root, adapter };
}

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: originalAnimate,
  });
  vi.restoreAllMocks();
});

describe('Product Panel view', () => {
  it('requires a trusted active user click before CONNECTED Begin reaches the adapter', () => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    mountProductPanel(root, {
      ...adapter,
      getReadiness: () => 'USER_ACTION_REQUIRED',
    }, { presentation: 'CONNECTED' });

    const begin = root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!;
    expect(begin.disabled).toBe(false);
    begin.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(adapter.start).not.toHaveBeenCalled();
    expect(root.textContent).toContain(
      'Click the EdAIX extension icon on this page, then click Begin assisted fill.',
    );

    const testRoot = document.createElement('main');
    const testAdapter = createAdapter();
    mountProductPanel(testRoot, {
      ...testAdapter,
      getReadiness: () => 'USER_ACTION_REQUIRED',
    }, {
      presentation: 'CONNECTED',
      testOnlyIsTrustedUserAction: () => true,
    });
    testRoot.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(testAdapter.start).toHaveBeenCalledTimes(1);
    expect(testAdapter.start).toHaveBeenCalledWith({ kind: 'START_AUTOFILL' });

    const throwingRoot = document.createElement('main');
    const throwingAdapter = createAdapter();
    mountProductPanel(throwingRoot, {
      ...throwingAdapter,
      getReadiness: () => 'USER_ACTION_REQUIRED',
    }, {
      presentation: 'CONNECTED',
      testOnlyIsTrustedUserAction: () => { throw new Error('test verifier failure'); },
    });
    expect(() => throwingRoot.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    expect(throwingAdapter.start).not.toHaveBeenCalled();
  });

  it.each([
    'USER_ACTION_REQUIRED',
    'SITE_ACCESS_REQUIRED',
    'API_UNREACHABLE',
    'AUTH_REQUIRED',
    'PAGE_NOT_REGISTERED',
    'LIVE_WRITE_NOT_AUTHORIZED',
    'PROFILE_UNAVAILABLE',
  ] as const)('allows trusted Begin to re-probe recoverable CONNECTED state %s', (readiness) => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    mountProductPanel(root, {
      ...adapter,
      getReadiness: () => readiness,
    }, {
      presentation: 'CONNECTED',
      testOnlyIsTrustedUserAction: () => true,
    });

    const begin = root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!;
    expect(begin.disabled).toBe(false);
    if (readiness === 'SITE_ACCESS_REQUIRED') {
      expect(root.textContent).toContain('Allow EdAIX access to this site in Chrome, then try again.');
    }
    begin.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it('keeps CONNECTED Begin disabled while readiness is CHECKING', () => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    mountProductPanel(root, {
      ...adapter,
      getReadiness: () => 'CHECKING',
    }, {
      presentation: 'CONNECTED',
      testOnlyIsTrustedUserAction: () => true,
    });

    expect(root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')?.disabled)
      .toBe(true);
  });

  it('keeps CONNECTED rows generic and freezes Undo', async () => {
    const root = document.createElement('main');
    const adapter = createAdapter(runningModel);
    mountProductPanel(root, {
      ...adapter,
      getReadiness: () => 'READY',
    }, {
      presentation: 'CONNECTED',
      testOnlyIsTrustedUserAction: () => true,
    });

    expect([...root.querySelectorAll('.pp-question__label')].map((item) => item.textContent))
      .toEqual(Array.from({ length: 7 }, () => 'Recognized'));
    expect([...root.querySelectorAll('.pp-question__status')].map((item) => item.textContent))
      .toEqual([
        'Success',
        'Success',
        'Manual review',
        'Manual review',
        'Manual review',
        'Manual review',
        'Manual review',
      ]);
    expect([...root.querySelectorAll('.pp-question__icon')].map((item) => item.textContent))
      .toEqual(['✓', '✓', '–', '–', '–', '–', '–']);
    expect([...root.querySelectorAll('.pp-question')].map((item) => item.getAttribute('data-status')))
      .toEqual([
        'SUCCESS',
        'SUCCESS',
        'MANUAL_REVIEW',
        'MANUAL_REVIEW',
        'MANUAL_REVIEW',
        'MANUAL_REVIEW',
        'MANUAL_REVIEW',
      ]);
    expect(root.querySelector('[data-question-id]')).toBeNull();
    expect(root.textContent).not.toMatch(
      /Filled and verified|Already complete|Suggestion ready|confirmation needed|Complete manually|safety check|Not reached/u,
    );
    const continueButton = root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]');
    expect(continueButton?.textContent).toBe('Continue: scan current page');
    expect(adapter.next).not.toHaveBeenCalled();

    expect(root.querySelector('[data-action="undo-field"]')).toBeNull();
    expect(adapter.undo).not.toHaveBeenCalled();
  });

  it('renders the complete neutral home without competitor content or submit controls', () => {
    const root = document.createElement('main');
    document.body.append(root);
    mountProductPanel(root, createAdapter());

    expect(root.textContent).toContain('Interaction prototype');
    expect(root.textContent).toContain('Visual design pending');
    expect(root.textContent).toContain('Application overview');
    expect(root.textContent).toContain('Begin assisted fill');
    expect(root.textContent).toContain('Saved applicant data');
    expect(root.textContent).toContain('Résumé source');
    expect(root.textContent).toContain('Letter source');
    expect(root.textContent).toContain('Submission always stays with you');
    expect(root.textContent).not.toMatch(/Jobright|Turbo|Credits Left|Get Unlimited/iu);
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[type="submit"]')).toBeNull();
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(root.querySelector('.pp-entry__chevron')).toBeNull();
    expect(root.querySelectorAll('[data-action^="open-"]')).toHaveLength(4);
    expect([...root.querySelectorAll('button')].every((button) => button.type === 'button')).toBe(true);
  });

  it('dispatches all four home-entry actions through the injected adapter', async () => {
    const { root, adapter } = mountedView();

    for (const action of [
      'open-current-job',
      'open-autofill-information',
      'open-resume',
      'open-cover-letter',
    ]) {
      root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    await vi.waitFor(() => expect(adapter.openEntry).toHaveBeenCalledTimes(4));
    expect(adapter.openEntry.mock.calls.map(([intent]) => intent)).toEqual([
      { kind: 'OPEN_ENTRY', target: 'CURRENT_JOB' },
      { kind: 'OPEN_ENTRY', target: 'AUTOFILL_INFORMATION' },
      { kind: 'OPEN_ENTRY', target: 'RESUME' },
      { kind: 'OPEN_ENTRY', target: 'COVER_LETTER' },
    ]);
    await vi.waitFor(() => expect(root.textContent).toContain('Letter source preview opened'));
    expect(root.querySelector('[data-entry-preview-target="COVER_LETTER"]')).not.toBeNull();
    expect(root.textContent).not.toContain('action is ready');
  });

  it('opens an honest value-free entry preview and returns focus when it closes', async () => {
    const root = document.createElement('main');
    document.body.append(root);
    const adapter = createAdapter();
    mountProductPanel(root, adapter);
    const origin = root.querySelector<HTMLButtonElement>('[data-action="open-resume"]')!;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    origin.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector(
      '[data-entry-preview-target="RESUME"]',
    )).not.toBeNull());
    expect(root.textContent).toContain('Résumé destination preview');
    expect(root.textContent).toContain('Document content is intentionally excluded');
    expect(document.activeElement?.id).toBe('product-panel-entry-preview-title');
    expect(focus).toHaveBeenLastCalledWith();

    root.querySelector<HTMLButtonElement>('[data-action="close-entry-preview"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-entry-preview-target]')).toBeNull();
    expect(document.activeElement).toBe(origin);
    expect(focus).toHaveBeenLastCalledWith();
    expect(root.textContent).toContain('Résumé source preview closed.');
    expect(root.textContent).not.toContain('Résumé source preview opened.');
  });

  it('clears the previous entry status and preview when another destination opens', async () => {
    const { root, adapter } = mountedView();

    root.querySelector<HTMLButtonElement>('[data-action="open-current-job"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain(
      'Application overview preview opened.',
    ));

    root.querySelector<HTMLButtonElement>('[data-action="open-resume"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-entry-preview-target]')).toBeNull();
    await vi.waitFor(() => expect(root.textContent).toContain('Résumé source preview opened.'));

    expect(root.textContent).not.toContain('Application overview preview opened.');
    expect(root.querySelector('[data-entry-preview-target="RESUME"]')).not.toBeNull();
  });

  it('freezes entry intents and ignores a superseded completion that resolves last', async () => {
    const root = document.createElement('main');
    document.body.append(root);
    const adapter = createAdapter();
    const frozenIntents: boolean[] = [];
    let resolveOverview!: (result: ProductPanelIntentResult) => void;
    let resolveResume!: (result: ProductPanelIntentResult) => void;
    adapter.openEntry.mockImplementation((intent) => {
      frozenIntents.push(Object.isFrozen(intent));
      return new Promise<ProductPanelIntentResult>((resolve) => {
        if (intent.target === 'CURRENT_JOB') resolveOverview = resolve;
        if (intent.target === 'RESUME') resolveResume = resolve;
      });
    });
    mountProductPanel(root, adapter);

    root.querySelector<HTMLButtonElement>('[data-action="open-current-job"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="open-resume"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(frozenIntents).toEqual([true, true]);
    resolveResume({ ok: true });
    await vi.waitFor(() => expect(root.querySelector(
      '[data-entry-preview-target="RESUME"]',
    )).not.toBeNull());

    resolveOverview({ ok: true });
    await Promise.resolve();
    expect(root.querySelector('[data-entry-preview-target="RESUME"]')).not.toBeNull();
    expect(root.querySelector('[data-entry-preview-target="CURRENT_JOB"]')).toBeNull();
  });

  it('rejects an accessor-backed entry result without reading or rendering its detail', async () => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    const codeGetter = vi.fn()
      .mockReturnValueOnce('PRODUCT_PANEL_INTENT_REJECTED')
      .mockReturnValue('private-page-detail');
    const hostileResult = { ok: false } as Record<string, unknown>;
    Object.defineProperty(hostileResult, 'code', {
      enumerable: true,
      get: codeGetter,
    });
    adapter.openEntry.mockResolvedValueOnce(hostileResult as ProductPanelIntentResult);
    mountProductPanel(root, adapter);

    root.querySelector<HTMLButtonElement>('[data-action="open-current-job"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('PRODUCT_PANEL_INTENT_UNAVAILABLE'));
    expect(root.textContent).not.toContain('private-page-detail');
    expect(codeGetter).not.toHaveBeenCalled();
  });

  it('shows all seven UA-5 terminals, exact group counts, and settled progress after start', async () => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    adapter.start.mockImplementationOnce(async () => {
      adapter.emit(runningModel);
      return { ok: true };
    });
    mountProductPanel(root, adapter);

    root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1));

    expect(adapter.start).toHaveBeenCalledWith({ kind: 'START_AUTOFILL' });
    // One optional question was never reached, so nothing here may read as a
    // whole-page figure.
    expect(root.textContent).toContain('7 observed questions settled · page not fully observed');
    expect(root.textContent).toContain('Required completion: 2/5 observed verified');
    expect(root.textContent).toContain('40% of observed');
    expect(root.textContent).toContain('Page not fully observed: some questions were not reached');
    expect(root.querySelector('progress')?.getAttribute('value')).toBe('2');
    expect(root.querySelector('progress')?.getAttribute('max')).toBe('5');
    expect(root.querySelectorAll('[aria-labelledby="required-questions-title"] li')).toHaveLength(5);
    expect(root.querySelectorAll('[aria-labelledby="optional-questions-title"] li')).toHaveLength(2);
    for (const label of [
      'Already complete',
      'Filled and verified',
      'Suggestion ready for review',
      'Your confirmation needed',
      'Complete manually',
      'Held by a safety check',
      'Not reached on this page',
    ]) expect(root.textContent, label).toContain(label);

    const continueButton = root.querySelector<HTMLButtonElement>(
      '[data-action="continue-next-page"]',
    );
    expect(continueButton?.type).toBe('button');
    expect(continueButton?.textContent).toBe('Continue to next page');
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[type="submit"]')).toBeNull();
    expect(root.textContent).toContain('final submission stay on the application page');
  });

  it('reports a whole-page percentage only when the whole page was observed', () => {
    const complete: ProductPanelViewModel = {
      ...runningModel,
      run: {
        ...runningModel.run!,
        questions: runningModel.run!.questions
          .filter((question) => question.status !== 'DISCOVERY_INCOMPLETE'),
        completeness: { discoveryComplete: true, unobservedRegions: 0 },
      },
    };
    const { root } = mountedView(complete);
    expect(root.textContent).toContain('6 questions settled');
    expect(root.textContent).toContain('Required completion: 2/5 verified');
    expect(root.textContent).toContain('40%');
    expect(root.textContent).not.toContain('of observed');
    expect(root.textContent).not.toContain('not fully observed');
    expect(root.querySelector('[data-completeness="INCOMPLETE"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-action="expand-autofill"]')?.textContent)
      .toContain('40% complete');
  });

  it('never presents 100% over a page with a region the scan could not observe', () => {
    // Every observed required question is filled, and one frame on the page was
    // reached but never observed into. The old panel showed "100% complete".
    const allObservedFilled: ProductPanelViewModel = {
      ...runningModel,
      run: {
        ...runningModel.run!,
        progress: { phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 5 },
        questions: runningModel.run!.questions
          .filter((question) => question.status !== 'DISCOVERY_INCOMPLETE')
          .map((question) => (
            question.requirement === 'REQUIRED' ? { ...question, status: 'FILLED' as const } : question
          )),
        completeness: { discoveryComplete: false, unobservedRegions: 1 },
      },
    };
    const { root } = mountedView(allObservedFilled);
    expect(root.textContent).toContain('100% of observed');
    expect(root.textContent).toContain('Page not fully observed: 1 region could not be scanned');
    expect(root.textContent).not.toContain('100% complete');
    expect(root.textContent).not.toContain('6 questions settled');
    expect(root.querySelector('progress')?.getAttribute('aria-label'))
      .toContain('observed verified; page not fully observed');
    expect(root.querySelector('[data-completeness="INCOMPLETE"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const sticky = root.querySelector('[data-action="expand-autofill"]')?.textContent ?? '';
    expect(sticky).toContain('100% of observed · page not fully observed');
    expect(sticky).not.toContain('100% complete');
  });

  it('does not report zero required questions before UA-5 settles', () => {
    const { root, adapter } = mountedView(observedModel);

    expect(root.textContent).toContain('7 controls observed');
    expect(root.textContent).toContain('Required completion will appear after the run settles');
    expect(root.textContent).not.toContain('No required questions detected');

    adapter.emit(composedModel);
    expect(root.textContent).toContain('7 questions recognized · 2 authorized');
    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-action="expand-autofill"]')?.textContent)
      .toContain('Run in progress');
    expect(root.textContent).not.toContain('No required questions');
  });

  it('returns to home with a sticky summary, updates while collapsed, and re-expands retained state', () => {
    const { root, adapter } = mountedView(runningModel);

    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.textContent).toContain('Application overview');
    const summary = root.querySelector<HTMLButtonElement>('[data-action="expand-autofill"]')!;
    expect(summary).not.toBeNull();
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('Required completion: 2/5 observed verified');
    expect(summary.textContent).toContain('40% of observed · page not fully observed');
    expect(summary.querySelector('.pp-sticky-summary__chevron')?.getAttribute('aria-hidden'))
      .toBe('true');
    const homeDisclosure = root.querySelector('[data-action="expand-autofill-home"]');
    expect(homeDisclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(homeDisclosure?.getAttribute('aria-controls')).toBe('product-panel-autofill-details');

    adapter.emit(progressedModel);
    expect(root.querySelector('[data-panel="autofill-details"]')).toBeNull();
    expect(root.querySelector('[data-action="expand-autofill"]')?.textContent)
      .toContain('Required completion: 4/5 observed verified');
    expect(root.querySelector('[data-action="expand-autofill"]')?.textContent)
      .toContain('80% of observed');

    root.querySelector<HTMLButtonElement>('[data-action="expand-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-panel="autofill-details"]')).not.toBeNull();
    expect(root.textContent).toContain('Required completion: 4/5 observed verified');
  });

  it('moves focus to the surviving control or heading across tree-replacing state changes', () => {
    const root = document.createElement('main');
    document.body.append(root);
    const adapter = createAdapter(runningModel);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mountProductPanel(root, adapter);

    const collapse = root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!;
    collapse.focus();
    collapse.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement?.getAttribute('data-action')).toBe('expand-autofill');
    expect(focus).toHaveBeenLastCalledWith();

    const expand = root.querySelector<HTMLButtonElement>('[data-action="expand-autofill"]')!;
    expand.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement?.id).toBe('product-panel-progress-title');
    expect(focus).toHaveBeenLastCalledWith();
  });

  it('moves focus into updated progress after Start and Continue snapshots', async () => {
    const root = document.createElement('main');
    document.body.append(root);
    const adapter = createAdapter();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    adapter.start.mockImplementationOnce(async () => {
      adapter.emit(runningModel);
      return { ok: true };
    });
    adapter.next.mockImplementationOnce(async () => {
      adapter.emit(progressedModel);
      return { ok: true };
    });
    mountProductPanel(root, adapter);

    const start = root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!;
    start.focus();
    start.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('product-panel-progress-title'));
    expect(focus).toHaveBeenLastCalledWith();

    const next = root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]')!;
    next.focus();
    next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('product-panel-progress-title'));
    expect(focus).toHaveBeenLastCalledWith();
  });

  it('does not expose a contradictory native progressbar when there are no required questions', () => {
    const root = document.createElement('main');
    const noRequired: ProductPanelViewModel = {
      ...runningModel,
      run: {
        ...runningModel.run!,
        progress: {
          phase: 'SETTLED',
          requiredCompleted: 0,
          requiredQuestions: 0,
        },
        questions: runningModel.run!.questions.map((question) => ({
          ...question,
          requirement: 'OPTIONAL' as const,
        })),
      },
    };
    mountProductPanel(root, createAdapter(noRequired));

    expect(root.textContent).toContain('Required completion: 0/0 observed verified');
    expect(root.textContent).toContain('No required questions detected');
    expect(root.textContent).not.toContain('0%');
    expect(root.querySelector('progress')).toBeNull();
  });

  it('keeps one live announcer mounted across subscription-driven progress updates', () => {
    const { root, adapter } = mountedView(runningModel);
    const announcer = root.querySelector('[data-product-panel-announcer]');

    adapter.emit(progressedModel);
    expect(root.querySelector('[data-product-panel-announcer]')).toBe(announcer);
    expect(announcer?.textContent).toContain('Activity update 3');
    expect(announcer?.textContent).toContain('Required completion: 4/5 observed verified');
  });

  it('animates PREFILLED and FILLED checks only on unseen terminal transitions', () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    const { root, adapter } = mountedView(runningModel, { reducedMotion: false });
    expect(animate).not.toHaveBeenCalled();

    adapter.emit(progressedModel);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.instances.map((instance) => (instance as HTMLElement)
      .closest('[data-question-id]')?.getAttribute('data-question-id'))).toEqual([
      'q-suggested',
      'q-confirmation',
    ]);
    expect(root.querySelector('[data-question-id="q-suggested"]')?.textContent)
      .toContain('Filled and verified');
    expect(root.querySelector('[data-question-id="q-confirmation"]')?.textContent)
      .toContain('Already complete');

    adapter.emit({ ...progressedModel, revision: 4 });
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('keeps the verified check but suppresses motion for reduced-motion users', () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    const { root, adapter } = mountedView(runningModel, { reducedMotion: true });
    adapter.emit(progressedModel);

    expect(animate).not.toHaveBeenCalled();
    expect(root.querySelector('[data-question-id="q-suggested"]')?.textContent)
      .toContain('Filled and verified');
    expect(root.querySelector('[data-question-id="q-confirmation"]')?.textContent)
      .toContain('Already complete');
  });

  it('keeps a cosmetic animation failure from blocking the verified update', () => {
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(() => { throw new Error('animation unavailable'); }),
    });
    const { root, adapter } = mountedView(runningModel, { reducedMotion: false });

    expect(() => adapter.emit(progressedModel)).not.toThrow();
    expect(root.textContent).toContain('Required completion: 4/5 observed verified');
    expect(root.querySelector('[data-question-id="q-suggested"]')?.textContent)
      .toContain('Filled and verified');
    expect(root.querySelector('[data-question-id="q-confirmation"]')?.textContent)
      .toContain('Already complete');
  });

  it('disables Continue synchronously and invokes one exact intent only once', async () => {
    let resolveNext!: (result: ProductPanelIntentResult) => void;
    const pending = new Promise<ProductPanelIntentResult>((resolve) => { resolveNext = resolve; });
    const root = document.createElement('main');
    const adapter = createAdapter(runningModel);
    adapter.next.mockImplementation(() => pending);
    mountProductPanel(root, adapter);
    const button = root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]')!;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(button.disabled).toBe(true);
    expect(adapter.next).toHaveBeenCalledTimes(1);
    expect(adapter.next).toHaveBeenCalledWith({
      kind: 'CONTINUE_TO_NEXT_PAGE',
      runId: 'run-demo-1',
      intentId: 'continue-demo-1',
    });

    resolveNext({ ok: true });
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(adapter.next).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an invalid injected model without exposing its extra content', () => {
    const root = document.createElement('main');
    const invalid = { ...homeModel, rawHtml: '<private-page>' } as ProductPanelViewModel;
    mountProductPanel(root, createAdapter(invalid));

    expect(root.textContent).toContain('PRODUCT_PANEL_VIEW_MODEL_INVALID');
    expect(root.textContent).not.toContain('private-page');
  });

  it('ignores a stale revision instead of rolling visible progress backward or forward', () => {
    const { root, adapter } = mountedView(runningModel);

    adapter.emit({ ...progressedModel, revision: 1 });
    expect(root.textContent).toContain('Required completion: 2/5 observed verified');
    expect(root.querySelector('[data-question-id="q-suggested"]')?.textContent)
      .toContain('Suggestion ready for review');
  });

  it('keeps the revision watermark after an invalid snapshot', () => {
    const { root, adapter } = mountedView(progressedModel);

    adapter.emit({ ...progressedModel, rawLabel: 'private page text' } as ProductPanelViewModel);
    expect(root.textContent).toContain('PRODUCT_PANEL_VIEW_MODEL_INVALID');
    expect(root.querySelector('.pp-error')?.getAttribute('role')).toBe('alert');
    expect(root.textContent).not.toContain('private page text');

    adapter.emit(runningModel);
    expect(root.textContent).toContain('PRODUCT_PANEL_VIEW_MODEL_INVALID');
    expect(root.querySelector('[data-action="continue-next-page"]')).toBeNull();
  });

  it('maps a synchronous start-adapter exception to stable value-free UI copy', async () => {
    const root = document.createElement('main');
    const adapter = createAdapter();
    adapter.start.mockImplementationOnce(() => {
      throw new Error('must not reach the panel');
    });
    mountProductPanel(root, adapter);

    expect(() => root.querySelector<HTMLButtonElement>('[data-action="start-autofill"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    await vi.waitFor(() => expect(root.textContent).toContain('PRODUCT_PANEL_INTENT_UNAVAILABLE'));
    expect(root.textContent).not.toContain('must not reach the panel');
  });

  it('clears the root and returns a stable result when unsubscribe throws', () => {
    const root = document.createElement('main');
    const baseAdapter = createAdapter();
    const unsubscribe = vi.fn()
      .mockImplementationOnce(() => { throw new Error('private unsubscribe detail'); })
      .mockImplementation(() => undefined);
    const adapter: ProductPanelViewAdapter = {
      ...baseAdapter,
      subscribe: () => unsubscribe,
    };
    const mounted = mountProductPanel(root, adapter);

    expect(mounted.destroy()).toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_UNSUBSCRIBE_FAILED',
    });
    expect(root.childElementCount).toBe(0);
    expect(mounted.destroy()).toEqual({ ok: true });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(mounted.destroy()).toEqual({ ok: true });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});


it('shows possible page changes as a failed row without counting it as completed or offering Undo', () => {
  const root = document.createElement('main');
  const model: ProductPanelViewModel = { ...runningModel, run: { ...runningModel.run!,
    questions: runningModel.run!.questions.map((row) => row.status === 'POLICY_BLOCKED'
      ? { ...row, writeEffect: 'MAY_HAVE_CHANGED' } : row),
  } };
  const adapter = createAdapter(model);
  mountProductPanel(root, adapter, { presentation: 'CONNECTED' });
  expect(root.textContent).toContain('Failed — check page');
  expect(root.textContent).toContain('Required completion: 2/5 observed verified');
  expect(root.textContent).toContain('use the page’s file control if available');
  expect(root.querySelector('[data-action="undo-field"]')).toBeNull();
});
