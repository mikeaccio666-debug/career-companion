// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PilotUa4UnobservedRegion } from '@edaix/contracts/draft/pilot-ua4-write-authority';

import {
  createMultipagePageCheckpoint,
  createPilotMultipageFoundation,
  projectMultipageCheckpoint,
  type ArmMultipageFoundationResult,
  type MultipageMutationObserverCallback,
  type MultipageMutationObserverFactory,
  type MultipageObservationIdentity,
  type MultipageCheckpointProjection,
  type MultipagePageCheckpoint,
  type MultipageStablePageIdentity,
  type PilotMultipageFoundation,
  type PilotMultipageFoundationInput,
} from '../lib/pilotMultipageFoundation';
import {
  digest,
  MULTIPAGE_DOM_FIXTURES,
  MULTIPAGE_MISSION_DIGEST,
  MULTIPAGE_PAGES,
  terminalLedger,
  type FixtureDispositionRow,
} from './helpers/pilotMultipageFixture';

const DEFAULT_ROWS = Object.freeze([
  Object.freeze({
    disposition: Object.freeze({ state: 'PREFILLED', semanticReadback: 'CURRENT' }),
    questionId: 'question.shared',
    required: true,
  }),
] satisfies readonly FixtureDispositionRow[]);

function pageIdentity(pageIndex: 0 | 1 | 2): MultipageStablePageIdentity {
  return Object.freeze({
    ...MULTIPAGE_PAGES[pageIndex],
    missionStepDigest: MULTIPAGE_MISSION_DIGEST,
  });
}

function checkpoint(input: Readonly<{
  pageIndex: 0 | 1 | 2;
  checkpointCharacter: string;
  predecessorCheckpointId: string | null;
  identity?: MultipageObservationIdentity;
  documentEpoch?: number;
  historyEpoch?: number;
  rows?: readonly FixtureDispositionRow[];
  discoveryComplete?: boolean;
  ledgerPageIndex?: 0 | 1 | 2;
  domGenerationDigest?: string;
  unobservedRegions?: readonly PilotUa4UnobservedRegion[];
}>): MultipagePageCheckpoint {
  const identity = input.identity ?? Object.freeze({
    ...pageIdentity(input.pageIndex),
    documentEpoch: input.documentEpoch ?? input.pageIndex,
    historyEpoch: input.historyEpoch ?? input.pageIndex,
  });
  const result = createMultipagePageCheckpoint({
    checkpointId: digest(input.checkpointCharacter),
    identity,
    predecessorCheckpointId: input.predecessorCheckpointId,
    terminalLedger: terminalLedger(
      input.ledgerPageIndex ?? input.pageIndex,
      input.rows ?? DEFAULT_ROWS,
      input.discoveryComplete ?? true,
      input.domGenerationDigest ?? digest(String((input.ledgerPageIndex ?? input.pageIndex) + 4)),
      input.unobservedRegions,
    ),
  });
  if (!result.ok) throw new Error(result.code);
  return result.checkpoint;
}

function observerHarness() {
  const callbacks: MultipageMutationObserverCallback[] = [];
  const observe = vi.fn();
  const disconnect = vi.fn();
  const observerFactory: MultipageMutationObserverFactory = (callback) => {
    callbacks.push(callback);
    return { disconnect, observe };
  };
  return {
    callback: (index = callbacks.length - 1) => {
      const callback = callbacks[index];
      if (callback === undefined) throw new Error('observer callback was not installed');
      return callback;
    },
    callbacks,
    disconnect,
    observe,
    observerFactory,
  };
}

function childListRecord(addedNodes: readonly Node[]): MutationRecord {
  return {
    addedNodes,
    attributeName: null,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes: [],
    target: document.documentElement,
    type: 'childList',
  } as unknown as MutationRecord;
}

function mutationMayRevealControls(records: readonly MutationRecord[]): boolean {
  const selector = 'input,select,textarea,[contenteditable],[role="combobox"]';
  return records.some((record) => [...record.addedNodes].some((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as Element;
    return element.matches(selector) || element.querySelector(selector) !== null;
  }));
}

function continueProofHarness() {
  const issued = new WeakSet<object>();
  const consumed = new WeakSet<object>();
  const consume = vi.fn((proof: object) => {
    if (!issued.has(proof) || consumed.has(proof)) return false;
    consumed.add(proof);
    return true;
  });
  return {
    consume,
    issue: () => {
      const proof = Object.freeze({});
      issued.add(proof);
      return proof;
    },
  };
}

interface LiveState {
  root: Element | null;
  identity: MultipageStablePageIdentity | null;
  domGenerationDigest: string | null;
}

function foundationInput(
  state: LiveState,
  observer: ReturnType<typeof observerHarness>,
  proofs: ReturnType<typeof continueProofHarness>,
  rediscover: PilotMultipageFoundationInput['rediscover'],
  overrides: Partial<PilotMultipageFoundationInput> = {},
): PilotMultipageFoundationInput {
  const base: PilotMultipageFoundationInput = {
    consumeUserContinueProof: proofs.consume,
    enabled: true,
    getDocumentElement: () => state.root,
    invalidateCurrentPageAuthority: () => true,
    mutationMayRevealControls,
    observerFactory: observer.observerFactory,
    readCurrentDomGenerationDigest: () => state.domGenerationDigest,
    readPageIdentity: () => state.identity,
    rediscover,
  };
  return { ...base, ...overrides };
}

function stableIdentityOf(
  identity: MultipageObservationIdentity,
): MultipageStablePageIdentity {
  return Object.freeze({
    exactPageUrlDigest: identity.exactPageUrlDigest,
    missionStepDigest: identity.missionStepDigest,
    pageOrdinal: identity.pageOrdinal,
    stepIdentityDigest: identity.stepIdentityDigest,
  });
}

function initialProjection(checkpoint: MultipagePageCheckpoint): MultipageCheckpointProjection {
  const observer = observerHarness();
  const proofs = continueProofHarness();
  const state: LiveState = {
    domGenerationDigest: checkpoint.sourceDomGenerationDigest,
    identity: stableIdentityOf(checkpoint.identity),
    root: document.documentElement,
  };
  const foundation = createPilotMultipageFoundation(
    foundationInput(state, observer, proofs, vi.fn()),
  );
  const result = foundation.createInitialProjection(checkpoint);
  if (!result.ok) throw new Error(result.code);
  return result.projection;
}

async function observedSuccessor(
  previous: MultipagePageCheckpoint,
  input: Readonly<{
    pageIndex: 0 | 1 | 2;
    checkpointCharacter: string;
    domGenerationCharacter: string;
    identity?: MultipageStablePageIdentity;
    rows?: readonly FixtureDispositionRow[];
  }>,
): Promise<MultipagePageCheckpoint> {
  vi.useFakeTimers();
  const observer = observerHarness();
  const proofs = continueProofHarness();
  const state: LiveState = {
    domGenerationDigest: previous.sourceDomGenerationDigest,
    identity: stableIdentityOf(previous.identity),
    root: document.documentElement,
  };
  const nextStableIdentity = input.identity ?? pageIdentity(input.pageIndex);
  const nextDomGeneration = digest(input.domGenerationCharacter);
  const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
    const candidate = checkpoint({
      checkpointCharacter: input.checkpointCharacter,
      domGenerationDigest: nextDomGeneration,
      identity,
      pageIndex: input.pageIndex,
      predecessorCheckpointId:
        identity.pageOrdinal === previous.identity.pageOrdinal
          ? previous.predecessorCheckpointId
          : previous.checkpointId,
      rows: input.rows,
    });
    state.domGenerationDigest = nextDomGeneration;
    return candidate;
  });
  const foundation = createPilotMultipageFoundation(
    foundationInput(state, observer, proofs, rediscover),
  );
  const armed = arm(foundation, proofs.issue(), previous);
  state.identity = nextStableIdentity;
  foundation.notifyHistoryChange('pushState');
  await vi.advanceTimersByTimeAsync(450);
  const result = await armed.completion;
  if (!result.ok) throw new Error(result.code);
  return result.checkpoint;
}

function arm(
  foundation: PilotMultipageFoundation,
  proof: object,
  previousCheckpoint: MultipagePageCheckpoint,
): Extract<ArmMultipageFoundationResult, { ok: true }> {
  const result = foundation.armFromUserContinue({ previousCheckpoint, proof });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('canonical multipage checkpoint projection', () => {
  it('aggregates canonical required dispositions without creating completion authority', async () => {
    const first = checkpoint({
      checkpointCharacter: 'e',
      pageIndex: 0,
      predecessorCheckpointId: null,
      rows: [
        {
          disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' },
          questionId: 'question.shared',
          required: true,
        },
        {
          disposition: { state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' },
          questionId: 'question.optional',
          required: false,
        },
      ],
    });
    const second = await observedSuccessor(first, {
      checkpointCharacter: 'f',
      domGenerationCharacter: '5',
      pageIndex: 1,
      rows: [{
        disposition: { state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' },
        questionId: 'question.shared',
        required: true,
      }],
    });
    const two = projectMultipageCheckpoint(initialProjection(first), second);
    if (!two.ok) throw new Error(two.code);

    expect(two.projection.aggregate.observedPageCount).toBe(2);
    expect(two.projection.aggregate.requiredDispositions).toEqual([
      expect.objectContaining({
        pageOrdinal: 0,
        questionId: 'question.shared',
        stepIdentityDigest: MULTIPAGE_PAGES[0].stepIdentityDigest,
        disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' },
      }),
      expect.objectContaining({
        pageOrdinal: 1,
        questionId: 'question.shared',
        stepIdentityDigest: MULTIPAGE_PAGES[1].stepIdentityDigest,
        disposition: { state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' },
      }),
    ]);
    expect(two.projection.aggregate.requiredDispositions.map(
      (entry) => entry.disposition.state,
    )).toEqual(['PREFILLED', 'MANUAL_REQUIRED']);
    expect(two.projection.aggregate.canUndoPriorSteps).toBe(false);
    expect(two.projection.aggregate).not.toHaveProperty('discoveryComplete');
    expect(two.projection.aggregate).not.toHaveProperty('resolvedCount');
    expect(two.projection.aggregate).not.toHaveProperty('submitReady');
  });

  it('rejects forged UA-4 summaries and accessor-backed ledger data', () => {
    const valid = terminalLedger(0, DEFAULT_ROWS);
    const forged = {
      ...valid,
      summary: { ...valid.summary, requiredQuestions: 99 },
    };
    expect(createMultipagePageCheckpoint({
      checkpointId: digest('e'),
      identity: { ...pageIdentity(0), documentEpoch: 0, historyEpoch: 0 },
      predecessorCheckpointId: null,
      terminalLedger: forged,
    })).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'schemaVersion', {
      enumerable: true,
      get: () => {
        throw new Error('must not invoke accessor');
      },
    });
    expect(createMultipagePageCheckpoint({
      checkpointId: digest('e'),
      identity: { ...pageIdentity(0), documentEpoch: 0, historyEpoch: 0 },
      predecessorCheckpointId: null,
      terminalLedger: accessor,
    })).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  });

  it('preserves canonical incomplete dispositions without calling the wizard complete', () => {
    const incomplete = checkpoint({
      checkpointCharacter: 'e',
      discoveryComplete: false,
      pageIndex: 0,
      predecessorCheckpointId: null,
      rows: [{
        disposition: {
          reachability: 'FUTURE_STEP_NOT_OPENED',
          state: 'DISCOVERY_INCOMPLETE',
        },
        questionId: 'surface.future-step',
        required: true,
      }],
    });
    const projection = initialProjection(incomplete);

    expect(incomplete.currentGenerationDiscoveryComplete).toBe(false);
    expect(projection.aggregate.requiredDispositions[0]?.disposition.state).toBe(
      'DISCOVERY_INCOMPLETE',
    );
    expect(projection.aggregate).not.toHaveProperty('discoveryComplete');
  });

  it('enforces forward-only chains and exact predecessor object binding', async () => {
    const first = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const second = await observedSuccessor(first, {
      checkpointCharacter: 'f', domGenerationCharacter: '5', pageIndex: 1,
    });
    const one = initialProjection(first);
    const two = projectMultipageCheckpoint(one, second);
    if (!two.ok) throw new Error(two.code);

    expect(projectMultipageCheckpoint(two.projection, first)).toEqual({
      ok: false, code: 'PILOT_TARGET_DRIFT',
    });
    const brokenChain = checkpoint({
      checkpointCharacter: '0', pageIndex: 2, predecessorCheckpointId: digest('9'),
    });
    expect(projectMultipageCheckpoint(two.projection, brokenChain)).toEqual({
      ok: false, code: 'PILOT_TARGET_DRIFT',
    });
    const firstTwin = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    expect(projectMultipageCheckpoint(initialProjection(firstTwin), second)).toEqual({
      ok: false, code: 'PILOT_TARGET_DRIFT',
    });
  });

  it('retains v2 unobserved regions outside the observed required denominator across pages', async () => {
    const region = Object.freeze({ regionId: digest('7'), reason: 'FRAME_NOT_OBSERVED' as const });
    const first = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      discoveryComplete: false, unobservedRegions: [region],
    });
    const initial = initialProjection(first);
    expect(first.currentGenerationDiscoveryComplete).toBe(false);
    expect(first.unobservedRegions).toEqual([region]);
    expect(initial.aggregate.unobservedRegions).toEqual([{
      ...region, checkpointId: first.checkpointId, pageOrdinal: 0,
      stepIdentityDigest: first.identity.stepIdentityDigest,
    }]);

    const next = await observedSuccessor(first, {
      checkpointCharacter: 'f', domGenerationCharacter: '5', pageIndex: 1,
    });
    const projected = projectMultipageCheckpoint(initial, next);
    if (!projected.ok) throw new Error(projected.code);
    expect(projected.projection.aggregate.unobservedRegions).toEqual(initial.aggregate.unobservedRegions);
    expect(projected.projection.aggregate.requiredDispositions).toHaveLength(2);
    expect(projected.projection.aggregate).not.toHaveProperty('discoveryComplete');
    expect(projected.projection.aggregate.canUndoPriorSteps).toBe(false);
  });

  it('rejects v1 and false-complete region ledgers through the canonical parser', () => {
    const ledger = terminalLedger(0, DEFAULT_ROWS, false, digest('4'), [
      { regionId: digest('7'), reason: 'FRAME_NOT_OBSERVED' },
    ]);
    for (const invalid of [
      { ...ledger, schemaVersion: 1 },
      { ...ledger, discoveryComplete: true },
      { ...ledger, summary: { ...ledger.summary, unobservedRegions: 0 } },
    ]) {
      expect(createMultipagePageCheckpoint({
        checkpointId: digest('e'),
        identity: { ...pageIdentity(0), documentEpoch: 0, historyEpoch: 0 },
        predecessorCheckpointId: null,
        terminalLedger: invalid,
      })).toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    }
  });

  it('replaces a fresh current-page checkpoint instead of double-counting it', async () => {
    const first = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const refreshed = await observedSuccessor(first, {
      checkpointCharacter: 'f',
      domGenerationCharacter: '5',
      pageIndex: 0,
      rows: [{
        disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' },
        questionId: 'question.shared',
        required: true,
      }],
    });
    const two = projectMultipageCheckpoint(initialProjection(first), refreshed);
    if (!two.ok) throw new Error(two.code);

    expect(two.projection.checkpoints).toEqual([refreshed]);
    expect(two.projection.aggregate.requiredDispositions).toHaveLength(1);
    expect(two.projection.aggregate.requiredDispositions[0]?.disposition.state).toBe(
      'POLICY_BLOCKED',
    );
  });

  it('rejects structurally forged checkpoints and projections', () => {
    const real = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const forgedCheckpoint = { ...real } as MultipagePageCheckpoint;
    const projection = initialProjection(real);
    expect(projectMultipageCheckpoint(projection, forgedCheckpoint)).toEqual({
      ok: false, code: 'PILOT_TARGET_DRIFT',
    });
    expect(projectMultipageCheckpoint({
      aggregate: projection.aggregate,
      checkpoints: [real],
    }, real)).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });
});

describe('dormant multipage transition lifecycle', () => {
  it('is inert while disabled/unarmed and consumes only an issued opaque proof', () => {
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'),
      identity: pageIdentity(0),
      root: document.documentElement,
    };
    const rediscover = vi.fn();
    const disabled = createPilotMultipageFoundation(foundationInput(
      state, h, proofs, rediscover, { enabled: false },
    ));
    disabled.notifyHistoryChange('pushState');
    expect(disabled.armFromUserContinue({
      previousCheckpoint: previous,
      proof: proofs.issue(),
    })).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    expect(h.observe).not.toHaveBeenCalled();
    expect(rediscover).not.toHaveBeenCalled();

    const enabled = createPilotMultipageFoundation(foundationInput(state, h, proofs, rediscover));
    expect(enabled.armFromUserContinue({
      previousCheckpoint: previous,
      proof: Object.freeze({}),
    })).toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    enabled.notifyHistoryChange('popstate');
    expect(h.observe).not.toHaveBeenCalled();
  });

  it('rejects proof replay even when the injected verifier would accept twice', () => {
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proof = Object.freeze({});
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: null,
    };
    const foundation = createPilotMultipageFoundation({
      ...foundationInput(state, h, continueProofHarness(), vi.fn()),
      consumeUserContinueProof: () => true,
    });
    expect(foundation.armFromUserContinue({ previousCheckpoint: previous, proof })).toEqual({
      ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
    });
    expect(foundation.armFromUserContinue({ previousCheckpoint: previous, proof })).toEqual({
      ok: false, code: 'PILOT_NOT_USER_TRIGGERED',
    });
  });

  it('binds the previous checkpoint before invalidation and installs the exact observer', async () => {
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const invalidate = vi.fn(() => true);
    const state: LiveState = {
      domGenerationDigest: digest('4'),
      identity: pageIdentity(0),
      root: document.documentElement,
    };
    const foundation = createPilotMultipageFoundation(foundationInput(
      state, h, proofs, vi.fn(), { invalidateCurrentPageAuthority: invalidate },
    ));
    const armed = arm(foundation, proofs.issue(), previous);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(h.observe).toHaveBeenCalledWith(document.documentElement, {
      childList: true, subtree: true,
    });

    expect(foundation.armFromUserContinue({
      previousCheckpoint: previous,
      proof: proofs.issue(),
    })).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    foundation.dispose();
    await expect(armed.completion).resolves.toEqual({
      ok: false, code: 'PILOT_CAPABILITY_DISABLED',
    });

    const mismatchInvalidate = vi.fn(() => true);
    const mismatchState = { ...state, domGenerationDigest: digest('9') };
    const mismatch = createPilotMultipageFoundation(foundationInput(
      mismatchState, observerHarness(), proofs, vi.fn(),
      { invalidateCurrentPageAuthority: mismatchInvalidate },
    ));
    expect(mismatch.armFromUserContinue({
      previousCheckpoint: previous,
      proof: proofs.issue(),
    })).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(mismatchInvalidate).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'] as const)(
    'does not observe or rediscover when old-page revocation returns %s', (failure) => {
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const state: LiveState = {
        domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
      };
      const h = observerHarness();
      const proofs = continueProofHarness();
      const rediscover = vi.fn();
      const foundation = createPilotMultipageFoundation(foundationInput(state, h, proofs, rediscover, {
        invalidateCurrentPageAuthority: () => {
          if (failure === 'throw') throw new Error('fixture revocation failure');
          return false;
        },
      }));
      expect(foundation.armFromUserContinue({ previousCheckpoint: previous, proof: proofs.issue() })).toEqual({
        ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
      });
      foundation.notifyHistoryChange('pushState');
      expect(h.observe).not.toHaveBeenCalled();
      expect(rediscover).not.toHaveBeenCalled();
    },
  );

  it.each(['observe', 'now'] as const)(
    'does not resurrect a transition when %s disposes reentrantly',
    (port) => {
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const proofs = continueProofHarness();
      const h = observerHarness();
      const state: LiveState = {
        domGenerationDigest: digest('4'),
        identity: pageIdentity(0),
        root: document.documentElement,
      };
      let foundation!: PilotMultipageFoundation;
      const observerFactory: MultipageMutationObserverFactory = (callback) => ({
        disconnect: vi.fn(),
        observe: () => {
          if (port === 'observe') foundation.dispose();
          else h.observerFactory(callback).observe(document.documentElement, {});
        },
      });
      foundation = createPilotMultipageFoundation(foundationInput(
        state,
        h,
        proofs,
        vi.fn(),
        {
          now: () => {
            if (port === 'now') foundation.dispose();
            return Date.now();
          },
          observerFactory,
        },
      ));
      expect(foundation.armFromUserContinue({
        previousCheckpoint: previous,
        proof: proofs.issue(),
      })).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
      expect(foundation.armFromUserContinue({
        previousCheckpoint: previous,
        proof: proofs.issue(),
      })).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    },
  );

  it('uses the added-node prefilter and a trailing 450ms debounce without reading values', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'),
      identity: pageIdentity(0),
      root: document.documentElement,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      const candidate = checkpoint({
        checkpointCharacter: 'f',
        domGenerationDigest: digest('5'),
        identity,
        pageIndex: 1,
        predecessorCheckpointId: previous.checkpointId,
      });
      state.domGenerationDigest = digest('5');
      return candidate;
    });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);

    h.callback()([childListRecord([document.createElement('span')])]);
    await vi.advanceTimersByTimeAsync(500);
    expect(rediscover).not.toHaveBeenCalled();

    state.identity = pageIdentity(1);
    const template = document.createElement('template');
    template.innerHTML = MULTIPAGE_DOM_FIXTURES.spaNext;
    const wrapper = template.content.firstElementChild!;
    const control = wrapper.querySelector('input')!;
    Object.defineProperty(control, 'value', {
      configurable: true,
      get: () => {
        throw new Error('Data-L1 value was read');
      },
    });
    h.callback()([childListRecord([wrapper])]);
    await vi.advanceTimersByTimeAsync(449);
    expect(rediscover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rediscover).toHaveBeenCalledTimes(1);
    await expect(armed.completion).resolves.toMatchObject({ ok: true });
  });

  it.each(['pushState', 'replaceState', 'popstate'] as const)(
    'observes %s without receiving a raw URL',
    async (kind) => {
      vi.useFakeTimers();
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const h = observerHarness();
      const proofs = continueProofHarness();
      const state: LiveState = {
        domGenerationDigest: digest('4'),
        identity: pageIdentity(0),
        root: document.documentElement,
      };
      const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
        const candidate = checkpoint({
          checkpointCharacter: 'f',
          domGenerationDigest: digest('5'),
          identity,
          pageIndex: 1,
          predecessorCheckpointId: previous.checkpointId,
        });
        state.domGenerationDigest = digest('5');
        return candidate;
      });
      const foundation = createPilotMultipageFoundation(
        foundationInput(state, h, proofs, rediscover),
      );
      const armed = arm(foundation, proofs.issue(), previous);
      state.identity = pageIdentity(1);
      foundation.notifyHistoryChange(kind);
      await vi.advanceTimersByTimeAsync(450);

      await expect(armed.completion).resolves.toMatchObject({ ok: true });
      expect(rediscover.mock.calls[0]).toHaveLength(1);
      expect(rediscover.mock.calls[0]?.[0]).not.toHaveProperty('url');
      expect(rediscover.mock.calls[0]?.[0]).not.toHaveProperty('href');
    },
  );

  it('rejects a stale canonical ledger wrapped in a fresh page identity', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => checkpoint({
      checkpointCharacter: 'f',
      domGenerationDigest: digest('4'),
      identity,
      ledgerPageIndex: 0,
      pageIndex: 1,
      predecessorCheckpointId: previous.checkpointId,
    }));
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);

    await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it('requires this rediscovery to produce a fresh UA-1 generation', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const proofs = continueProofHarness();
    const rediscover = vi.fn((identity: MultipageObservationIdentity) => checkpoint({
      checkpointCharacter: 'f', pageIndex: 1, identity, domGenerationDigest: digest('5'),
      predecessorCheckpointId: previous.checkpointId,
    }));
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, observerHarness(), proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    state.domGenerationDigest = digest('5'); // A generation from before this rediscovery.
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);
    await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it.each(['dispose', 'pagehide'] as const)(
    'does not start queued rediscovery after %s retires the scan', async (event) => {
      vi.useFakeTimers();
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const state: LiveState = {
        domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
      };
      const proofs = continueProofHarness();
      const rediscover = vi.fn();
      const foundation = createPilotMultipageFoundation(
        foundationInput(state, observerHarness(), proofs, rediscover),
      );
      const armed = arm(foundation, proofs.issue(), previous);
      state.identity = pageIdentity(1);
      foundation.notifyHistoryChange('pushState');
      vi.advanceTimersByTime(450); // Leave the rediscovery microtask queued.
      if (event === 'dispose') foundation.dispose();
      else foundation.notifyPageHide({ persisted: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(rediscover).not.toHaveBeenCalled();
      foundation.dispose();
      await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    },
  );

  it('rejects an unannounced root replacement before calling rediscovery', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const proofs = continueProofHarness();
    const rediscover = vi.fn();
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, observerHarness(), proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    state.root = document.createElement('html');
    await vi.advanceTimersByTimeAsync(450);
    expect(rediscover).not.toHaveBeenCalled();
    await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it('coalesces mutation during an in-flight scan and discards the stale result', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    let releaseFirst!: (checkpoint: MultipagePageCheckpoint) => void;
    let firstObservation!: MultipageObservationIdentity;
    const rediscover = vi.fn()
      .mockImplementationOnce((identity: MultipageObservationIdentity) => {
        firstObservation = identity;
        return new Promise<MultipagePageCheckpoint>((resolve) => {
          releaseFirst = resolve;
        });
      })
      .mockImplementationOnce(async (identity: MultipageObservationIdentity) => {
        const candidate = checkpoint({
          checkpointCharacter: '0',
          domGenerationDigest: digest('6'),
          identity,
          pageIndex: 1,
          predecessorCheckpointId: previous.checkpointId,
        });
        state.domGenerationDigest = digest('6');
        return candidate;
      });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);
    expect(rediscover).toHaveBeenCalledTimes(1);

    h.callback()([childListRecord([document.createElement('textarea')])]);
    state.domGenerationDigest = digest('5');
    releaseFirst(checkpoint({
      checkpointCharacter: 'f',
      domGenerationDigest: digest('5'),
      identity: firstObservation,
      pageIndex: 1,
      predecessorCheckpointId: previous.checkpointId,
    }));
    await vi.advanceTimersByTimeAsync(450);

    expect(rediscover).toHaveBeenCalledTimes(2);
    await expect(armed.completion).resolves.toMatchObject({ ok: true });
  });

  it('fails closed when identity drifts during rediscovery', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    let release!: (checkpoint: MultipagePageCheckpoint) => void;
    let observation!: MultipageObservationIdentity;
    const rediscover = vi.fn((identity: MultipageObservationIdentity) => {
      observation = identity;
      return new Promise<MultipagePageCheckpoint>((resolve) => {
        release = resolve;
      });
    });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);
    state.identity = pageIdentity(2);
    state.domGenerationDigest = digest('6');
    release(checkpoint({
      checkpointCharacter: 'f',
      domGenerationDigest: digest('5'),
      identity: observation,
      pageIndex: 1,
      predecessorCheckpointId: previous.checkpointId,
    }));
    await vi.advanceTimersByTimeAsync(0);

    await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it('retains a fresh incomplete checkpoint for projection without reporting a successful transition', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      const candidate = checkpoint({
        checkpointCharacter: 'f',
        discoveryComplete: false,
        domGenerationDigest: digest('5'),
        identity,
        pageIndex: 1,
        predecessorCheckpointId: previous.checkpointId,
        rows: [{
          disposition: {
            reachability: 'DOM_GENERATION_CHANGED',
            state: 'DISCOVERY_INCOMPLETE',
          },
          questionId: 'surface.dom-generation',
          required: true,
        }],
      });
      state.domGenerationDigest = digest('5');
      return candidate;
    });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('replaceState');
    await vi.advanceTimersByTimeAsync(450);

    const result = await armed.completion;
    expect(result).toMatchObject({
      ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
      observedCheckpoint: { currentGenerationDiscoveryComplete: false },
    });
    if (result.ok || !('observedCheckpoint' in result)) throw new Error('incomplete checkpoint lost');
    const projected = projectMultipageCheckpoint(initialProjection(previous), result.observedCheckpoint);
    if (!projected.ok) throw new Error(projected.code);
    expect(projected.projection.aggregate.requiredDispositions.at(-1)?.disposition.state).toBe(
      'DISCOVERY_INCOMPLETE',
    );
  });

  it('retains fresh unobserved regions when the next page cannot be fully observed', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const region = Object.freeze({ regionId: digest('7'), reason: 'FRAME_NOT_OBSERVED' as const });
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      state.domGenerationDigest = digest('5');
      return checkpoint({
        checkpointCharacter: 'f', pageIndex: 1, identity, domGenerationDigest: digest('5'),
        predecessorCheckpointId: previous.checkpointId,
        discoveryComplete: false, unobservedRegions: [region], rows: [],
      });
    });
    const foundation = createPilotMultipageFoundation(foundationInput(state, h, proofs, rediscover));
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);
    const result = await armed.completion;
    expect(result).toMatchObject({
      ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
      observedCheckpoint: { currentGenerationDiscoveryComplete: false, unobservedRegions: [region] },
    });
    if (result.ok || !('observedCheckpoint' in result)) throw new Error('unobserved region lost');
    const projected = projectMultipageCheckpoint(initialProjection(previous), result.observedCheckpoint);
    if (!projected.ok) throw new Error(projected.code);
    expect(projected.projection.aggregate.unobservedRegions).toEqual([{
      ...region, checkpointId: digest('f'), pageOrdinal: 1,
      stepIdentityDigest: pageIdentity(1).stepIdentityDigest,
    }]);
    expect(projected.projection.aggregate.requiredDispositions).toHaveLength(1);
  });

  it('rebinds a replacement root for a same-URL SPA step', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const oldRoot = document.createElement('html');
    oldRoot.innerHTML = MULTIPAGE_DOM_FIXTURES.initial;
    const nextRoot = document.createElement('html');
    nextRoot.innerHTML = MULTIPAGE_DOM_FIXTURES.replacement;
    const nextIdentity = Object.freeze({
      ...pageIdentity(1),
      exactPageUrlDigest: previous.identity.exactPageUrlDigest,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: oldRoot,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      state.domGenerationDigest = digest('5');
      return checkpoint({
        checkpointCharacter: 'f',
        domGenerationDigest: digest('5'),
        identity,
        pageIndex: 1,
        predecessorCheckpointId: previous.checkpointId,
      });
    });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const armed = arm(foundation, proofs.issue(), previous);
    state.root = nextRoot;
    state.identity = nextIdentity;
    foundation.notifyDocumentReplaced();
    await vi.advanceTimersByTimeAsync(450);

    expect(h.disconnect).toHaveBeenCalled();
    expect(h.observe).toHaveBeenLastCalledWith(nextRoot, { childList: true, subtree: true });
    await expect(armed.completion).resolves.toMatchObject({ ok: true });
  });

  it('supports a same-page BFCache restore without extending the absolute deadline', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      state.domGenerationDigest = digest('5');
      return checkpoint({
        checkpointCharacter: 'f',
        domGenerationDigest: digest('5'),
        identity,
        pageIndex: 0,
        predecessorCheckpointId: null,
      });
    });
    const foundation = createPilotMultipageFoundation(foundationInput(
      state, h, proofs, rediscover, { maxSettleMs: 2_000 },
    ));
    const armed = arm(foundation, proofs.issue(), previous);
    foundation.notifyPageHide({ persisted: true });
    await vi.advanceTimersByTimeAsync(1_000);
    foundation.notifyPageShow({ persisted: true });
    await vi.advanceTimersByTimeAsync(450);

    const restored = await armed.completion;
    expect(restored).toMatchObject({
      ok: true,
      checkpoint: { predecessorCheckpointId: null, sourceDomGenerationDigest: digest('5') },
    });
    if (!restored.ok) throw new Error(restored.code);

    const expiredFoundation = createPilotMultipageFoundation(foundationInput(
      state, observerHarness(), proofs, rediscover, { maxSettleMs: 1_000 },
    ));
    const expired = arm(expiredFoundation, proofs.issue(), restored.checkpoint);
    expiredFoundation.notifyPageHide({ persisted: true });
    await vi.advanceTimersByTimeAsync(1_001);
    expiredFoundation.notifyPageShow({ persisted: true });
    await expect(expired.completion).resolves.toEqual({
      ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
    });
  });

  it('keeps the absolute settle bound under continuous relevant mutations', async () => {
    vi.useFakeTimers();
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const rediscover = vi.fn();
    const foundation = createPilotMultipageFoundation(foundationInput(
      state, h, proofs, rediscover, { maxSettleMs: 1_000 },
    ));
    const armed = arm(foundation, proofs.issue(), previous);
    const node = document.createElement('input');
    for (let index = 0; index < 5; index += 1) {
      h.callback()([childListRecord([node])]);
      await vi.advanceTimersByTimeAsync(200);
    }

    await expect(armed.completion).resolves.toEqual({
      ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE',
    });
    expect(rediscover).not.toHaveBeenCalled();
  });

  it('ignores a disconnected observer callback from a retired transition', async () => {
    vi.useFakeTimers();
    const first = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const rediscover = vi.fn(async (identity: MultipageObservationIdentity) => {
      state.domGenerationDigest = identity.pageOrdinal === 1 ? digest('5') : digest('6');
      return checkpoint({
        checkpointCharacter: identity.pageOrdinal === 1 ? 'f' : '0',
        domGenerationDigest: state.domGenerationDigest,
        identity,
        pageIndex: identity.pageOrdinal as 1 | 2,
        predecessorCheckpointId: identity.pageOrdinal === 1 ? first.checkpointId : digest('f'),
      });
    });
    const foundation = createPilotMultipageFoundation(
      foundationInput(state, h, proofs, rediscover),
    );
    const firstArm = arm(foundation, proofs.issue(), first);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);
    const firstResult = await firstArm.completion;
    if (!firstResult.ok) throw new Error(firstResult.code);

    const secondArm = arm(foundation, proofs.issue(), firstResult.checkpoint);
    state.identity = pageIdentity(2);
    const node = document.createElement('textarea');
    h.callback(0)([childListRecord([node])]);
    await vi.advanceTimersByTimeAsync(500);
    expect(rediscover).toHaveBeenCalledTimes(1);

    h.callback(1)([childListRecord([node])]);
    await vi.advanceTimersByTimeAsync(450);
    expect(rediscover).toHaveBeenCalledTimes(2);
    await expect(secondArm.completion).resolves.toMatchObject({ ok: true });
  });

  it('never invokes Continue, Next, or Submit host controls', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = [
      '<button id="continue">Continue</button>',
      '<button id="next">Next</button>',
      '<button id="submit" type="submit">Submit</button>',
    ].join('');
    const hostAction = vi.fn();
    for (const button of document.querySelectorAll('button')) {
      Object.defineProperty(button, 'click', { configurable: true, value: hostAction });
    }
    const previous = checkpoint({
      checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
    });
    const h = observerHarness();
    const proofs = continueProofHarness();
    const state: LiveState = {
      domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
    };
    const foundation = createPilotMultipageFoundation(foundationInput(
      state,
      h,
      proofs,
      async (identity) => {
        state.domGenerationDigest = digest('5');
        return checkpoint({
          checkpointCharacter: 'f',
          domGenerationDigest: digest('5'),
          identity,
          pageIndex: 1,
          predecessorCheckpointId: previous.checkpointId,
        });
      },
    ));
    const armed = arm(foundation, proofs.issue(), previous);
    state.identity = pageIdentity(1);
    foundation.notifyHistoryChange('pushState');
    await vi.advanceTimersByTimeAsync(450);

    await expect(armed.completion).resolves.toMatchObject({ ok: true });
    expect(hostAction).not.toHaveBeenCalled();
  });

  describe.each(['complete', 'incomplete'] as const)('%s checkpoint retirement', (observation) => {
    it.each([
      'pagehide', 'root-replaced', 'deadline', 'bfcache-roundtrip', 'root-roundtrip',
      'history-roundtrip', 'mutation', 'root-unreported', 'identity-unreported',
      'generation-unreported', 'final-read-pagehide',
    ] as const)(
      'rejects publication when disconnect reports %s', async (event) => {
        vi.useFakeTimers();
        const previous = checkpoint({
          checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
        });
        const initial = initialProjection(previous);
        const state: LiveState = {
          domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
        };
        const h = observerHarness();
        const proofs = continueProofHarness();
        let candidate!: MultipagePageCheckpoint;
        let currentTimeMs = 0;
        let retiring = false;
        const rediscover = vi.fn((identity: MultipageObservationIdentity) => {
          state.domGenerationDigest = digest('5');
          candidate = checkpoint({
            checkpointCharacter: 'f', pageIndex: 1, identity, domGenerationDigest: digest('5'),
            predecessorCheckpointId: previous.checkpointId,
            discoveryComplete: observation === 'complete',
            rows: observation === 'complete' ? DEFAULT_ROWS : [],
            unobservedRegions: observation === 'complete'
              ? []
              : [{ regionId: digest('7'), reason: 'FRAME_NOT_OBSERVED' }],
          });
          return candidate;
        });
        const foundation: PilotMultipageFoundation = createPilotMultipageFoundation(foundationInput(
          state, h, proofs, rediscover, { now: () => {
            if (retiring && event === 'final-read-pagehide') {
              foundation.notifyPageHide({ persisted: false });
            }
            return currentTimeMs;
          } },
        ));
        let reentrantArm: ArmMultipageFoundationResult | undefined;
        let reentrantProjection: ReturnType<typeof projectMultipageCheckpoint> | undefined;
        h.disconnect.mockImplementation(() => {
          reentrantArm = foundation.armFromUserContinue({ previousCheckpoint: candidate, proof: proofs.issue() });
          reentrantProjection = projectMultipageCheckpoint(initial, candidate);
          retiring = true;
          switch (event) {
            case 'pagehide':
              foundation.notifyPageHide({ persisted: false });
              break;
            case 'bfcache-roundtrip':
              foundation.notifyPageHide({ persisted: true });
              foundation.notifyPageShow({ persisted: true });
              break;
            case 'deadline':
              currentTimeMs = 10_000;
              break;
            case 'root-replaced':
            case 'root-roundtrip': {
              const originalRoot = state.root;
              state.root = document.createElement('html');
              foundation.notifyDocumentReplaced();
              if (event === 'root-roundtrip') state.root = originalRoot;
              break;
            }
            case 'history-roundtrip':
              state.identity = pageIdentity(2);
              foundation.notifyHistoryChange('popstate');
              state.identity = pageIdentity(1);
              break;
            case 'mutation':
              h.callback()([childListRecord([document.createElement('input')])]);
              break;
            case 'root-unreported':
              state.root = document.createElement('html');
              break;
            case 'identity-unreported':
              state.identity = pageIdentity(2);
              break;
            case 'generation-unreported':
              state.domGenerationDigest = digest('6');
              break;
            case 'final-read-pagehide':
              break;
          }
        });
        const armed = arm(foundation, proofs.issue(), previous);
        state.identity = pageIdentity(1);
        foundation.notifyHistoryChange('pushState');
        await vi.advanceTimersByTimeAsync(450);

        const result = await armed.completion;
        expect.soft(result).toEqual({
          ok: false,
          code: ['pagehide', 'deadline', 'bfcache-roundtrip', 'final-read-pagehide'].includes(event)
            ? 'PILOT_DISCOVERY_UNAVAILABLE' : 'PILOT_TARGET_DRIFT',
        });
        expect.soft(projectMultipageCheckpoint(initial, candidate)).toEqual({
          ok: false, code: 'PILOT_TARGET_DRIFT',
        });
        expect(reentrantArm).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
        expect(reentrantProjection).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
        h.callback()([childListRecord([document.createElement('input')])]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.disconnect).toHaveBeenCalledTimes(1);
        expect(rediscover).toHaveBeenCalledTimes(1);
      },
    );
  });

  it.each(['throws', 'disposes'] as const)(
    'does not expose or rearm a successful checkpoint when observer retirement %s', async (failure) => {
      vi.useFakeTimers();
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const initial = initialProjection(previous);
      const state: LiveState = {
        domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
      };
      const h = observerHarness();
      const proofs = continueProofHarness();
      let candidate!: MultipagePageCheckpoint;
      const rediscover = vi.fn((identity: MultipageObservationIdentity) => {
        state.domGenerationDigest = digest('5');
        candidate = checkpoint({
          checkpointCharacter: 'f', pageIndex: 1, identity, domGenerationDigest: digest('5'),
          predecessorCheckpointId: previous.checkpointId,
        });
        return candidate;
      });
      const foundation = createPilotMultipageFoundation(foundationInput(state, h, proofs, rediscover));
      let reentrantArm: ArmMultipageFoundationResult | undefined;
      let reentrantProjection: ReturnType<typeof projectMultipageCheckpoint> | undefined;
      h.disconnect.mockImplementation(() => {
        reentrantArm = foundation.armFromUserContinue({ previousCheckpoint: candidate, proof: proofs.issue() });
        reentrantProjection = projectMultipageCheckpoint(initial, candidate);
        if (failure === 'throws') throw new Error('fixture disconnect failure');
        foundation.dispose();
      });
      const armed = arm(foundation, proofs.issue(), previous);
      state.identity = pageIdentity(1);
      foundation.notifyHistoryChange('pushState');
      await vi.advanceTimersByTimeAsync(450);
      await expect(armed.completion).resolves.toEqual({
        ok: false,
        code: failure === 'throws' ? 'PILOT_DISCOVERY_UNAVAILABLE' : 'PILOT_CAPABILITY_DISABLED',
      });
      expect(reentrantArm).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
      expect(reentrantProjection).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
      expect(projectMultipageCheckpoint(initial, candidate)).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
      h.callback()([childListRecord([document.createElement('input')])]);
      await vi.advanceTimersByTimeAsync(450);
      expect(rediscover).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['queued', 'in-flight'] as const)(
    'enforces the absolute deadline during %s rediscovery without exposing a checkpoint', async (phase) => {
      vi.useFakeTimers();
      const previous = checkpoint({
        checkpointCharacter: 'e', pageIndex: 0, predecessorCheckpointId: null,
      });
      const state: LiveState = {
        domGenerationDigest: digest('4'), identity: pageIdentity(0), root: document.documentElement,
      };
      const proofs = continueProofHarness();
      let nowMs = 0;
      let release!: (value: MultipagePageCheckpoint) => void;
      let observation!: MultipageObservationIdentity;
      const rediscover = vi.fn((identity: MultipageObservationIdentity) => {
        observation = identity;
        return new Promise<MultipagePageCheckpoint>((resolve) => { release = resolve; });
      });
      const foundation = createPilotMultipageFoundation(foundationInput(
        state, observerHarness(), proofs, rediscover, { now: () => nowMs, maxSettleMs: 1_000 },
      ));
      const armed = arm(foundation, proofs.issue(), previous);
      state.identity = pageIdentity(1);
      foundation.notifyHistoryChange('pushState');
      vi.advanceTimersByTime(450);
      if (phase === 'in-flight') await vi.advanceTimersByTimeAsync(0);
      nowMs = 1_000;
      if (phase === 'in-flight') {
        state.domGenerationDigest = digest('5');
        release(checkpoint({
          checkpointCharacter: 'f', pageIndex: 1, identity: observation,
          domGenerationDigest: digest('5'), predecessorCheckpointId: previous.checkpointId,
        }));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(rediscover).toHaveBeenCalledTimes(phase === 'in-flight' ? 1 : 0);
      await expect(armed.completion).resolves.toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    },
  );
});
