import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  parsePilotUa5RunProjection,
  type PilotUa5RunProjection,
} from '@edaix/contracts/draft/pilot-ua5-certification';
import type {
  PilotUa5RunResult,
} from '../lib/pilotUa5Orchestrator';
import { summarizeProductPanel } from '../product-panel/model';
import { createProductPanelUa5Adapter } from '../product-panel/ua5Adapter';

const RUN_ID = 'run-ua5-1';
const CONTINUE_INTENT = Object.freeze({
  kind: 'CONTINUE_TO_NEXT_PAGE' as const,
  runId: RUN_ID,
  intentId: 'continue-ua5-1',
});

const PROJECTION: PilotUa5RunProjection = Object.freeze({
  schemaVersion: 2,
  binding: Object.freeze({
    origin: 'https://example.invalid',
    pathname: '/apply',
    domGeneration: 'a'.repeat(64),
  }),
  // One row below is DISCOVERY_INCOMPLETE, so the ledger this came from could
  // not have claimed the page complete -- and the projection parser holds it
  // to the same rule.
  discoveryComplete: false,
  rows: Object.freeze([
    Object.freeze({
      questionId: 'q-filled', required: true, state: 'FILLED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-prefilled', required: true, state: 'PREFILLED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-manual', required: true, state: 'MANUAL_REQUIRED' as const,
      reason: 'PASSWORD',
    }),
    Object.freeze({
      questionId: 'q-blocked', required: true, state: 'POLICY_BLOCKED' as const,
      reason: 'HOST_REJECTED',
    }),
    Object.freeze({
      questionId: 'q-confirm', required: false,
      state: 'USER_CONFIRMATION_REQUIRED' as const, reason: 'ANSWER_AUTHORITY_MISSING',
    }),
    Object.freeze({
      questionId: 'q-suggested', required: false, state: 'AI_SUGGESTED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-incomplete', required: false, state: 'DISCOVERY_INCOMPLETE' as const,
      reason: 'FUTURE_STEP_NOT_OPENED',
    }),
  ]),
  unobservedRegions: Object.freeze([]),
  summary: Object.freeze({
    observableQuestions: 7,
    requiredQuestions: 4,
    requiredCompleted: 2,
    terminalQuestions: 7,
    unobservedRegions: 0,
  }),
});

function createHarness(projection: unknown = PROJECTION) {
  const runCurrentPage = vi.fn(async (): Promise<PilotUa5RunResult> =>
    Object.freeze({ ok: true, projection }) as PilotUa5RunResult);
  const getIntent = vi.fn(() => CONTINUE_INTENT);
  const requestContinue = vi.fn(async () => Object.freeze({ ok: true as const }));
  const openEntry = vi.fn(async () => Object.freeze({ ok: true as const }));
  const adapter = createProductPanelUa5Adapter({
    runCurrentPage,
    continuePort: Object.freeze({
      getIntent,
      request: requestContinue,
    }),
    openEntry,
  });
  return {
    adapter,
    getIntent,
    openEntry,
    requestContinue,
    runCurrentPage,
  };
}

describe('Product Panel UA-5 projection adapter', () => {
  it('requires an explicit CONNECTED start and never derives or dispatches Continue', async () => {
    const probeReadiness = vi.fn(async () => 'READY' as const);
    const runCurrentPage = vi.fn(async () => ({ ok: true as const, projection: PROJECTION }));
    const getIntent = vi.fn(() => CONTINUE_INTENT);
    const request = vi.fn(async () => ({ ok: true as const }));
    const adapter = createProductPanelUa5Adapter({
      probeReadiness, runCurrentPage, continuePort: { getIntent, request },
    });
    expect(adapter.getReadiness?.()).toBe('USER_ACTION_REQUIRED');
    expect(Object.values(adapter.getSnapshot().entries)).not.toContain('READY');
    await Promise.resolve();
    expect(probeReadiness).not.toHaveBeenCalled();
    expect(runCurrentPage).not.toHaveBeenCalled();
    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({ ok: true });
    expect(probeReadiness).toHaveBeenCalledTimes(1);
    expect(runCurrentPage).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().run?.continueIntent).toBeNull();
    expect(getIntent).not.toHaveBeenCalled();
    await expect(adapter.requestContinue(CONTINUE_INTENT)).resolves.toEqual({
      ok: false, code: 'CONTINUE_INTENT_REJECTED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('recovers the retained result on reopen without running or probing', async () => {
    const runCurrentPage = vi.fn();
    const probeReadiness = vi.fn();
    const undoCurrentPage = vi.fn(async () => 'RESTORED' as const);
    const adapter = createProductPanelUa5Adapter({
      runCurrentPage, probeReadiness, undoCurrentPage,
      recoverCurrentPage: async () => ({ ok: true, projection: PROJECTION }),
    });
    await vi.waitFor(() => expect(adapter.getSnapshot().run).not.toBeNull());
    expect(runCurrentPage).not.toHaveBeenCalled();
    expect(probeReadiness).not.toHaveBeenCalled();
    await expect(adapter.requestUndoField?.({
      kind: 'UNDO_FIELD', runId: RUN_ID, questionId: 'q-filled',
    })).resolves.toEqual({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
    expect(undoCurrentPage).not.toHaveBeenCalled();
  });

  it('freezes Undo even for a recovered FILLED row without changing the result', async () => {
    const undoCurrentPage = vi.fn(async () => 'RESTORED' as const);
    const adapter = createProductPanelUa5Adapter({
      probeReadiness: async () => 'READY', undoCurrentPage,
      runCurrentPage: async () => ({ ok: true, projection: PROJECTION }),
    });
    await adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    const before = adapter.getSnapshot();
    await expect(adapter.requestUndoField?.({ kind: 'UNDO_FIELD', runId: RUN_ID, questionId: 'q-filled' }))
      .resolves.toEqual({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
    expect(undoCurrentPage).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toBe(before);
  });

  it('consumes the official value-free projection and preserves every exact terminal', async () => {
    expect(parsePilotUa5RunProjection(PROJECTION).ok).toBe(true);
    const {
      adapter,
        getIntent,
      requestContinue,
      runCurrentPage,
    } = createHarness();
    const snapshots: ReturnType<typeof adapter.getSnapshot>[] = [];
    adapter.subscribe((snapshot) => snapshots.push(snapshot));

    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: true,
    });

    expect(runCurrentPage).toHaveBeenCalledTimes(1);
    expect(runCurrentPage).toHaveBeenCalledWith(expect.any(Function));
    expect(snapshots.map((snapshot) => snapshot.run?.progress.phase)).toEqual([
      'SETTLED',
    ]);
    expect(getIntent).toHaveBeenCalledTimes(1);
    expect(requestContinue).not.toHaveBeenCalled();

    const snapshot = adapter.getSnapshot();
    expect(snapshot.run?.questions.map((question) => ({
      id: question.id,
      requirement: question.requirement,
      status: question.status,
    }))).toEqual([
      { id: 'q-filled', requirement: 'REQUIRED', status: 'FILLED' },
      { id: 'q-prefilled', requirement: 'REQUIRED', status: 'PREFILLED' },
      { id: 'q-manual', requirement: 'REQUIRED', status: 'MANUAL_REQUIRED' },
      { id: 'q-blocked', requirement: 'REQUIRED', status: 'POLICY_BLOCKED' },
      { id: 'q-confirm', requirement: 'OPTIONAL', status: 'USER_CONFIRMATION_REQUIRED' },
      { id: 'q-suggested', requirement: 'OPTIONAL', status: 'AI_SUGGESTED' },
      { id: 'q-incomplete', requirement: 'OPTIONAL', status: 'DISCOVERY_INCOMPLETE' },
    ]);
    for (const question of snapshot.run?.questions ?? []) {
      expect(
        Object.prototype.hasOwnProperty.call(question, 'semanticReadbackEventId'),
        'the panel must not mint a readback event that UA-5 did not project',
      ).toBe(false);
    }

    const summary = summarizeProductPanel(snapshot);
    expect(summary).toMatchObject({
      detected: 7,
      requiredFilled: 2,
      requiredTotal: 4,
      requiredPercentage: 50,
    });
    expect(summary.required).toHaveLength(4);
    expect(summary.optional).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain('example.invalid');
    expect(JSON.stringify(snapshot)).not.toContain('/apply');
    expect(JSON.stringify(snapshot)).not.toContain('PASSWORD');
    expect(JSON.stringify(snapshot)).not.toContain('HOST_REJECTED');
  });

  it('carries an unobserved region as completeness, never as a question, and refuses a whole-page claim over it', async () => {
    const region = 'f'.repeat(64);
    const rows = PROJECTION.rows.filter((row) => row.state !== 'DISCOVERY_INCOMPLETE');
    const withRegion = Object.freeze({
      ...PROJECTION,
      rows: Object.freeze(rows),
      unobservedRegions: Object.freeze([
        Object.freeze({ regionId: region, reason: 'FRAME_NOT_OBSERVED' as const }),
      ]),
      summary: Object.freeze({
        ...PROJECTION.summary, observableQuestions: 6, terminalQuestions: 6, unobservedRegions: 1,
      }),
    });
    expect(parsePilotUa5RunProjection(withRegion).ok).toBe(true);
    const { adapter } = createHarness(withRegion);
    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({ ok: true });
    const run = adapter.getSnapshot().run!;
    expect(run.questions).toHaveLength(6);
    expect(run.questions.some((question) => question.id === region)).toBe(false);
    expect(run.completeness).toEqual({ discoveryComplete: false, unobservedRegions: 1 });
    expect(summarizeProductPanel(adapter.getSnapshot())).toMatchObject({
      requiredFilled: 2, requiredTotal: 4, requiredPercentage: 50,
      discoveryComplete: false, unobservedRegions: 1,
    });

    // The same rows with the whole page claimed over the region never reach the view.
    const { adapter: strict } = createHarness(Object.freeze({ ...withRegion, discoveryComplete: true }));
    await expect(strict.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
    expect(strict.getSnapshot().run).toBeNull();
  });

  it('re-parses the projection and fails closed on a caller-inflated completion count', async () => {
    const invalid = Object.freeze({
      ...PROJECTION,
      summary: Object.freeze({
        ...PROJECTION.summary,
        requiredCompleted: 3,
      }),
    });
    expect(parsePilotUa5RunProjection(invalid).ok).toBe(false);
    const { adapter, getIntent, requestContinue } = createHarness(invalid);
    const listener = vi.fn();
    adapter.subscribe(listener);

    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
    expect(adapter.getSnapshot().run).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(getIntent).not.toHaveBeenCalled();
    expect(requestContinue).not.toHaveBeenCalled();
  });

  it('quarantines a throwing subscriber without stranding the canonical terminal', async () => {
    const { adapter } = createHarness();
    const throwingListener = vi.fn(() => {
      throw new Error('test subscriber failure');
    });
    const healthySnapshots: ReturnType<typeof adapter.getSnapshot>[] = [];
    adapter.subscribe(throwingListener);
    adapter.subscribe((snapshot) => healthySnapshots.push(snapshot));

    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: true,
    });

    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(healthySnapshots.map((snapshot) => snapshot.run?.progress.phase)).toEqual([
      'SETTLED',
    ]);
    expect(adapter.getSnapshot().run?.progress.phase).toBe('SETTLED');
  });

  it.each([false, true])('dispatches Continue only after user intent despite throwing subscriber=%s', async (throws) => {
    const { adapter, getIntent, requestContinue, runCurrentPage } = createHarness();
    await adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    const listener = vi.fn(() => { if (throws) throw new Error('TEST_SUBSCRIBER_FAILURE'); });
    adapter.subscribe(listener);
    expect(adapter.getSnapshot().run?.continueIntent).toEqual({
      kind: 'CONTINUE_TO_NEXT_PAGE', intentId: 'continue-ua5-1',
    });
    expect(getIntent).toHaveBeenCalledTimes(1);
    expect(requestContinue).not.toHaveBeenCalled();
    await expect(adapter.requestContinue(CONTINUE_INTENT)).resolves.toEqual({ ok: true });
    expect(requestContinue).toHaveBeenCalledTimes(1);
    expect(requestContinue).toHaveBeenCalledWith(CONTINUE_INTENT);
    expect(runCurrentPage).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().run?.continueIntent).toBeNull();
  });

  it('contains no host navigation, submission, or CAP-AF-039 browser primitive', () => {
    const source = readFileSync(
      resolve(__dirname, '../product-panel/ua5Adapter.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/(?:\.click\s*\(|\.submit\s*\(|requestSubmit\s*\()/u);
    expect(source).not.toMatch(/\b(?:document|window)\./u);
    expect(source).not.toMatch(/MutationObserver|pushState|replaceState|popstate/u);
  });
});


it('preserves a possible partial write through projection and view-model validation', async () => {
  const projection: PilotUa5RunProjection = { ...PROJECTION, rows: PROJECTION.rows.map((row) =>
    row.state === 'POLICY_BLOCKED' ? { ...row, writeEffect: 'MAY_HAVE_CHANGED' } : row),
  };
  const { adapter } = createHarness(projection);
  await adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
  expect(adapter.getSnapshot().run?.questions.find((row) => row.id === 'q-blocked'))
    .toMatchObject({ status: 'POLICY_BLOCKED', writeEffect: 'MAY_HAVE_CHANGED' });
  expect(summarizeProductPanel(adapter.getSnapshot()).requiredFilled).toBe(2);
});
