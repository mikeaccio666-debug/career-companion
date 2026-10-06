import type { PilotUa5ProgressEvent } from '../lib/pilotUa5Orchestrator';
import type { AutofillDockProgress } from '../lib/autofillDock';
import { COPY, type DockCopy } from '../lib/dock/copy';

/**
 * What a live run is allowed to tell the panel.
 *
 * The run's progress carries counts and nothing else — no field labels, no
 * values. That is not an oversight to work around: a run's contents must not
 * travel, and the panel is on the host page. So each phase says exactly what it
 * knows, and the wording changes with it rather than a number being invented to
 * fill a shape that wants one.
 *
 * Rows stay empty here on purpose. The list of fields the panel shows before a
 * fill is built from the user's own saved details, which we can name because
 * they are ours; a host question we only know by id is counted, never labelled.
 */
export type DockRunPhase = 'SCANNING' | 'COMPOSING' | 'SETTLED';

export interface DockRunProgress extends AutofillDockProgress {
  readonly phase: DockRunPhase;
  readonly observedControls?: number;
  readonly observableQuestions?: number;
  readonly authorizedQuestions?: number;
}

export function dockProgressFromRunEvent(
  runId: string,
  event: PilotUa5ProgressEvent,
): DockRunProgress | null {
  const base = { runId, rows: [] as const };
  switch (event.phase) {
    case 'OBSERVED':
      return Object.freeze({ ...base, phase: 'SCANNING', observedControls: event.observedControls,
        requiredCompleted: 0, requiredQuestions: 0 });
    case 'COMPOSED':
      return Object.freeze({ ...base, phase: 'COMPOSING',
        observableQuestions: event.observableQuestions, authorizedQuestions: event.authorizedQuestions,
        // Not a total of required fields, and not claimed as one: how many we
        // may answer is a different fact from how many the form demands.
        requiredCompleted: 0, requiredQuestions: 0 });
    case 'SETTLED':
      return Object.freeze({ ...base, phase: 'SETTLED',
        requiredCompleted: event.requiredCompleted, requiredQuestions: event.requiredQuestions });
    default:
      // An event we cannot name is not one we paraphrase to the user.
      return null;
  }
}

/**
 * The one line the collapsed sheet shows, worded for the phase it is in, in the
 * dock's own language (`copy`; Chinese when the caller does not say).
 */
export function dockRunSummary(progress: DockRunProgress | null, copy: DockCopy = COPY): string {
  if (progress === null) return '';
  if (progress.phase === 'SCANNING') return copy.run.scanning(progress.observedControls ?? 0);
  if (progress.phase === 'COMPOSING') return copy.run.composing(progress.observableQuestions ?? 0, progress.authorizedQuestions ?? 0);
  const { requiredCompleted, requiredQuestions } = progress;
  if (requiredQuestions <= 0) return copy.run.nothingRequired;
  return copy.run.required(requiredCompleted, requiredQuestions);
}
