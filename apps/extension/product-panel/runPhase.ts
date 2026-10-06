import type { ProductPanelQuestionStatus, ProductPanelViewModel } from './model';

/**
 * Which of the panel's four faces the user should be looking at.
 *
 * The prototype's screens are phases of one run, not four components: the panel
 * is idle until a run exists, shows what it found before writing anything, shows
 * per-field progress while it writes, and reports what it did once the run has
 * settled. Deriving the phase from the run projection — rather than letting the
 * view carry its own flag — keeps the screen from claiming a state the run never
 * reached, which is the failure mode this panel exists to prevent.
 */
export type AutofillRunPhase = 'IDLE' | 'SCANNING' | 'READY' | 'FILLING' | 'COMPLETE';

/**
 * Every question status is terminal, so a row's presence proves it was decided,
 * not that anything was written. Only these two say a value reached the host,
 * which is what separates "here is what we found" from "we are filling it in".
 */
const WRITTEN: ReadonlySet<ProductPanelQuestionStatus> = new Set(['FILLED', 'PREFILLED']);

export function autofillRunPhase(run: ProductPanelViewModel['run']): AutofillRunPhase {
  if (run === null) return 'IDLE';
  // COMPLETE is only ever the run's own settlement. A row reaching a terminal
  // state says that field is decided, never that the application is done.
  if (run.progress.phase === 'SETTLED') return 'COMPLETE';
  if (run.progress.phase === 'OBSERVED') return 'SCANNING';
  return run.questions.some((question) => WRITTEN.has(question.status)) ? 'FILLING' : 'READY';
}
