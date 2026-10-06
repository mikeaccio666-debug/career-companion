/**
 * Same-process Product Panel adapter for UA-5's value-free run projection.
 *
 * This is a consumer only. It does not mount the UA-5 API route, trigger page
 * observation, navigate the host, or create a second ledger. The injected run
 * port remains the only place allowed to perform the certified UA-5 chain.
 */

import type { PilotUa5RunProjection } from '@edaix/contracts/draft/pilot-ua5-certification';
import type { PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';
import type {
  PilotUa5ProgressEvent,
  PilotUa5RunResult,
} from '../lib/pilotUa5Orchestrator';
import {
  ownDataValues, parsePilotUa5RunResult, PILOT_UA5_READINESS_STATUSES,
  parsePilotUa5ContinueOffer, parsePilotUa5ReadOnlyScanResult,
  type PilotUa5ContinueOffer, type PilotUa5ReadOnlyScanResult,
  type PilotUa5ReadinessStatus,
  readPilotUa5ResultWizard,
} from '../lib/pilotUa5ConnectedProtocol';
import type { ProductPanelViewModel } from './model';
import { validateProductPanelViewModel } from './model';
import type {
  ProductPanelEntryIntent,
  ProductPanelIntentResult,
  ProductPanelStartIntent,
  ProductPanelViewAdapter,
} from './panel';
import {
  normalizeProductPanelIntentResult,
  type ProductPanelContinueIntent,
} from './state';

export type ProductPanelUa5AdapterOptions = Readonly<{
  probeReadiness?(): Promise<Exclude<PilotUa5ReadinessStatus, 'CHECKING'>>;
  runCurrentPage(onProgress: (event: PilotUa5ProgressEvent) => void): Promise<PilotUa5RunResult>;
  recoverCurrentPage?(): Promise<PilotUa5RunResult>;
  getContinueOffer?(): Promise<PilotUa5ContinueOffer | null>;
  continueReadOnly?(intentId: string): Promise<PilotUa5ReadOnlyScanResult>;
  undoCurrentPage?(questionId: string): Promise<'RESTORED' | 'UNAVAILABLE'>;
  /** UI-only seam. It is deliberately not a UA-5 or CAP-AF-039 implementation. */
  continuePort?: Readonly<{
    getIntent(
      runId: string,
      projection: PilotUa5RunProjection,
    ): ProductPanelContinueIntent | null;
    request(
      intent: ProductPanelContinueIntent,
    ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
  }>;
  openEntry?(
    intent: ProductPanelEntryIntent,
  ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
}>;

const READY_ENTRIES = Object.freeze({
  currentJob: 'READY' as const,
  autofillInformation: 'READY' as const,
  resume: 'NEEDS_ATTENTION' as const,
  coverLetter: 'UNAVAILABLE' as const,
});

const BLOCKED_ENTRIES = Object.freeze({
  currentJob: 'UNAVAILABLE' as const,
  autofillInformation: 'UNAVAILABLE' as const,
  resume: 'UNAVAILABLE' as const,
  coverLetter: 'UNAVAILABLE' as const,
});

const HOME: ProductPanelViewModel = Object.freeze({
  revision: 1,
  entries: READY_ENTRIES,
  run: null,
});

const LOCAL_SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function parseSuccessfulRun(value: unknown): PilotUa5RunProjection | null {
  const result = parsePilotUa5RunResult(value);
  return result?.ok === true ? result.projection : null;
}

function parseContinueIntent(
  value: unknown,
  runId: string,
): ProductPanelContinueIntent | null {
  if (value === null) return null;
  const fields = ownDataValues(value, ['kind', 'runId', 'intentId']);
  if (
    fields?.kind !== 'CONTINUE_TO_NEXT_PAGE' ||
    fields.runId !== runId ||
    typeof fields.intentId !== 'string' ||
    !LOCAL_SAFE_ID.test(fields.intentId)
  ) return null;
  return Object.freeze({
    kind: 'CONTINUE_TO_NEXT_PAGE',
    runId,
    intentId: fields.intentId,
  });
}

export function createProductPanelUa5Adapter(
  options: ProductPanelUa5AdapterOptions,
): ProductPanelViewAdapter {
  const connected = options.probeReadiness !== undefined;
  let readiness: PilotUa5ReadinessStatus = connected ? 'USER_ACTION_REQUIRED' : 'READY';
  let snapshot = !connected
    ? HOME
    : Object.freeze({ revision: 1, entries: BLOCKED_ENTRIES, run: null });
  let startPending = false;
  let runOrdinal = 0;
  let continueConsumed = false;
  let currentProjection: PilotUa5RunProjection | null = null;
  const listeners = new Set<(model: ProductPanelViewModel) => void>();

  function emit(model: ProductPanelViewModel): void {
    snapshot = model;
    for (const listener of [...listeners]) {
      try {
        listener(model);
      } catch {
        // Subscribers are notification-only and carry no run or Continue
        // authority. Quarantine a broken view so it cannot strand canonical
        // replay mid-sequence or prevent a user-approved Continue request.
        listeners.delete(listener);
      }
    }
  }

  function canonicalReadiness(value: unknown): Exclude<PilotUa5ReadinessStatus, 'CHECKING'> {
    return typeof value === 'string' && (PILOT_UA5_READINESS_STATUSES as readonly string[]).includes(value)
      ? value as Exclude<PilotUa5ReadinessStatus, 'CHECKING'>
      : 'API_UNREACHABLE';
  }

  function presentReadiness(status: Exclude<PilotUa5ReadinessStatus, 'CHECKING'>): void {
    readiness = status;
    if (snapshot.run !== null) return;
    emit(Object.freeze({
      revision: snapshot.revision + 1,
      entries: status === 'READY' ? READY_ENTRIES : BLOCKED_ENTRIES,
      run: null,
    }));
  }

  async function refreshReadiness(): Promise<Exclude<PilotUa5ReadinessStatus, 'CHECKING'>> {
    if (options.probeReadiness === undefined) return 'READY';
    let status: Exclude<PilotUa5ReadinessStatus, 'CHECKING'>;
    try {
      status = canonicalReadiness(await options.probeReadiness());
    } catch {
      status = 'API_UNREACHABLE';
    }
    presentReadiness(status);
    return status;
  }

  function presentProjection(projection: PilotUa5RunProjection, wizard?: PilotLocalWizardProjection): ProductPanelIntentResult {
    const runId = `run-ua5-${++runOrdinal}`;
    const externalIntent = connected ? null : options.continuePort?.getIntent(runId, projection) ?? null;
    const continueIntent = parseContinueIntent(externalIntent, runId);
    if (externalIntent !== null && continueIntent === null) {
      return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
    }
    const validated = validateProductPanelViewModel({
      revision: snapshot.revision + 1,
      entries: READY_ENTRIES,
      run: {
        id: runId,
        ...(wizard ? { wizard } : {}),
        progress: {
          phase: 'SETTLED',
          requiredCompleted: projection.summary.requiredCompleted,
          requiredQuestions: projection.summary.requiredQuestions,
        },
        questions: projection.rows.map((row, order) => ({
          id: row.questionId,
          order,
          requirement: row.required ? 'REQUIRED' : 'OPTIONAL',
          status: row.state,
          ...(row.writeEffect ? { writeEffect: row.writeEffect } : {}),
        })),
        completeness: {
          discoveryComplete: projection.discoveryComplete,
          unobservedRegions: projection.unobservedRegions.length,
        },
        continueIntent: continueIntent === null ? null : {
          kind: 'CONTINUE_TO_NEXT_PAGE', intentId: continueIntent.intentId,
        },
      },
    });
    if (!validated.ok) return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
    currentProjection = projection;
    continueConsumed = false;
    emit(validated.model);
    if (connected && options.getContinueOffer && options.continueReadOnly) {
      // A failed offer lookup has the same explicit unavailable result as a
      // peer without this read-only operation; the settled run stays visible.
      void options.getContinueOffer().catch(() => null).then((candidate) => {
        const offer = parsePilotUa5ContinueOffer(candidate);
        if (!offer || snapshot.run?.id !== runId || continueConsumed) return;
        const offered = validateProductPanelViewModel({ ...snapshot, revision: snapshot.revision + 1,
          run: { ...snapshot.run, continueIntent: { kind: 'CONTINUE_TO_NEXT_PAGE', intentId: offer.intentId } } });
        if (offered.ok) emit(offered.model);
      });
    }
    return Object.freeze({ ok: true });
  }

  const adapter: ProductPanelViewAdapter = Object.freeze({
    getSnapshot: () => snapshot,
    getReadiness: () => readiness,
    subscribe(listener: (model: ProductPanelViewModel) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async requestStartAutofill(intent: ProductPanelStartIntent): Promise<ProductPanelIntentResult> {
      if (intent.kind !== 'START_AUTOFILL' || startPending || snapshot.run !== null) {
        return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_REJECTED' });
      }
      startPending = true;
      try {
        const currentReadiness = await refreshReadiness();
        if (currentReadiness !== 'READY') {
          return Object.freeze({ ok: false, code: currentReadiness });
        }
        const result = await options.runCurrentPage(() => {});
        const projection = parseSuccessfulRun(result);
        if (projection === null) {
          const failure = ownDataValues(result, ['ok', 'code']);
          if (failure?.ok === false && failure.code === 'PILOT_UA5_WRITER_UNAVAILABLE') {
            return Object.freeze({ ok: false, code: 'RECOVERY_REQUIRED' });
          }
          if (failure?.ok === false && failure.code === 'PILOT_NOT_USER_TRIGGERED') {
            presentReadiness('USER_ACTION_REQUIRED');
            return Object.freeze({ ok: false, code: 'USER_ACTION_REQUIRED' });
          }
          if (failure?.ok === false && failure.code === 'PILOT_UA5_COMPOSITION_UNAVAILABLE') {
            presentReadiness('PROFILE_UNAVAILABLE');
            return Object.freeze({ ok: false, code: 'PROFILE_UNAVAILABLE' });
          }
        }
        if (projection === null) {
          return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
        }
        return presentProjection(projection, readPilotUa5ResultWizard(result));
      } catch {
        return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
      } finally {
        startPending = false;
      }
    },
    async requestContinue(intent: ProductPanelContinueIntent): Promise<ProductPanelIntentResult> {
      const available = snapshot.run?.continueIntent ?? null;
      if (
        continueConsumed ||
        (connected ? options.continueReadOnly === undefined : options.continuePort === undefined) ||
        currentProjection === null ||
        snapshot.run === null ||
        available === null ||
        intent.kind !== 'CONTINUE_TO_NEXT_PAGE' ||
        intent.runId !== snapshot.run.id ||
        intent.intentId !== available.intentId
      ) return Object.freeze({ ok: false, code: 'CONTINUE_INTENT_REJECTED' });
      continueConsumed = true;
      const withoutIntent: ProductPanelViewModel = Object.freeze({
        ...snapshot,
        revision: snapshot.revision + 1,
        run: Object.freeze({ ...snapshot.run, continueIntent: null,
          ...(snapshot.run.wizard ? { wizard: Object.freeze({ ...snapshot.run.wizard, currentStep: null }) } : {}),
          ...(connected ? { continuation: Object.freeze({ status: 'SCANNING' as const }) } : {}) }),
      });
      emit(withoutIntent);
      if (connected) {
        let result: PilotUa5ReadOnlyScanResult | null;
        try { result = parsePilotUa5ReadOnlyScanResult(await options.continueReadOnly!(intent.intentId)); }
        catch { result = null; }
        if (snapshot.run?.id !== intent.runId) return Object.freeze({ ok: false, code: 'CONTINUE_INTENT_UNAVAILABLE' });
        const updated = validateProductPanelViewModel({ ...snapshot, revision: snapshot.revision + 1,
          run: { ...snapshot.run,
            ...(result?.ok && result.wizard ? { wizard: result.wizard } : {}),
            continuation: result?.ok ? { status: 'SCANNED', scan: result.scan } : { status: 'UNAVAILABLE' } } });
        if (updated.ok) emit(updated.model);
        return result?.ok && updated.ok ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, code: 'CONTINUE_INTENT_UNAVAILABLE' });
      }
      try {
        return normalizeProductPanelIntentResult(await options.continuePort!.request(intent));
      } catch {
        return Object.freeze({ ok: false, code: 'CONTINUE_INTENT_UNAVAILABLE' });
      }
    },
    async requestOpenEntry(intent: ProductPanelEntryIntent): Promise<ProductPanelIntentResult> {
      if (
        intent.kind !== 'OPEN_ENTRY' ||
        ![
          'CURRENT_JOB',
          'AUTOFILL_INFORMATION',
          'RESUME',
          'COVER_LETTER',
        ].includes(intent.target)
      ) return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_REJECTED' });
      const currentReadiness = await refreshReadiness();
      if (currentReadiness !== 'READY') {
        return Object.freeze({ ok: false, code: currentReadiness });
      }
      if (options.openEntry === undefined) {
        return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
      }
      try {
        return normalizeProductPanelIntentResult(await options.openEntry(intent));
      } catch {
        return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
      }
    },
    async requestUndoField(): Promise<ProductPanelIntentResult> {
      return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' });
    },
  });
  if (options.recoverCurrentPage !== undefined) {
    void options.recoverCurrentPage().then((result) => {
      if (startPending || snapshot.run !== null || runOrdinal !== 0) return;
      const projection = parseSuccessfulRun(result);
      if (projection !== null) presentProjection(projection, readPilotUa5ResultWizard(result));
    }).catch(() => { presentReadiness('RECOVERY_REQUIRED'); });
  }
  return adapter;
}
