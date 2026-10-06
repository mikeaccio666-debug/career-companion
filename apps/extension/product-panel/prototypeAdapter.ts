import type {
  PilotUa5ProgressEvent,
  PilotUa5RunResult,
} from '../lib/pilotUa5Orchestrator';
import type {
  ProductPanelEntryIntent,
  ProductPanelIntentResult,
  ProductPanelViewAdapter,
} from './panel';
import { normalizeProductPanelIntentResult } from './state';
import { createProductPanelUa5Adapter } from './ua5Adapter';

type ConfirmDefaultOffBoundary = () => Promise<ProductPanelIntentResult>;

const PREVIEW_PROGRESS: readonly PilotUa5ProgressEvent[] = Object.freeze([
  Object.freeze({ phase: 'OBSERVED', observedControls: 7 }),
  Object.freeze({ phase: 'COMPOSED', observableQuestions: 7, authorizedQuestions: 2 }),
  Object.freeze({ phase: 'SETTLED', requiredCompleted: 2, requiredQuestions: 5 }),
]);

/**
 * Value-free interaction rehearsal only. The canonical UA-5 parser consumes
 * this shape, but it is not a production run, terminal ledger, or E2E claim.
 */
const PREVIEW_PROJECTION = Object.freeze({
  schemaVersion: 2 as const,
  binding: Object.freeze({
    origin: 'https://preview.edaix.test',
    pathname: '/field-lab',
    domGeneration: 'b'.repeat(64),
  }),
  discoveryComplete: false,
  rows: Object.freeze([
    Object.freeze({
      questionId: 'q-preview-prefilled', required: true, state: 'PREFILLED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-preview-filled', required: true, state: 'FILLED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-preview-suggested', required: true, state: 'AI_SUGGESTED' as const, reason: null,
    }),
    Object.freeze({
      questionId: 'q-preview-confirm', required: true,
      state: 'USER_CONFIRMATION_REQUIRED' as const, reason: 'ANSWER_AUTHORITY_MISSING',
    }),
    Object.freeze({
      questionId: 'q-preview-manual', required: true, state: 'MANUAL_REQUIRED' as const,
      reason: 'PASSWORD',
    }),
    Object.freeze({
      questionId: 'q-preview-blocked', required: false, state: 'POLICY_BLOCKED' as const,
      reason: 'HOST_REJECTED',
    }),
    Object.freeze({
      questionId: 'q-preview-incomplete', required: false,
      state: 'DISCOVERY_INCOMPLETE' as const, reason: 'FUTURE_STEP_NOT_OPENED',
    }),
  ]),
  // Nothing unobserved in the preview; incompleteness here comes from the
  // FUTURE_STEP_NOT_OPENED row above, so discoveryComplete is false either way.
  unobservedRegions: Object.freeze([]),
  summary: Object.freeze({
    observableQuestions: 7,
    requiredQuestions: 5,
    requiredCompleted: 2,
    terminalQuestions: 7,
    unobservedRegions: 0,
  }),
});

export function createProductPanelPrototypeAdapter(
  confirmDefaultOffBoundary: ConfirmDefaultOffBoundary,
): ProductPanelViewAdapter {
  return createProductPanelUa5Adapter({
    async runCurrentPage(onProgress): Promise<PilotUa5RunResult> {
      const boundary = normalizeProductPanelIntentResult(await confirmDefaultOffBoundary());
      if (!boundary.ok) {
        return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
      }
      for (const event of PREVIEW_PROGRESS) onProgress(event);
      return Object.freeze({ ok: true, projection: PREVIEW_PROJECTION });
    },
    continuePort: Object.freeze({
      getIntent(runId) {
        return Object.freeze({
          kind: 'CONTINUE_TO_NEXT_PAGE' as const,
          runId,
          intentId: 'continue-preview-1',
        });
      },
      request() {
        return Object.freeze({ ok: true });
      },
    }),
    openEntry(intent: ProductPanelEntryIntent): ProductPanelIntentResult {
      if (
        intent.kind !== 'OPEN_ENTRY' ||
        ![
          'CURRENT_JOB',
          'AUTOFILL_INFORMATION',
          'RESUME',
          'COVER_LETTER',
        ].includes(intent.target)
      ) return Object.freeze({ ok: false, code: 'PRODUCT_PANEL_INTENT_REJECTED' });
      return Object.freeze({ ok: true });
    },
  });
}
