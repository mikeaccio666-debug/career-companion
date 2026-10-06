import { describe, expect, it } from 'vitest';
import { labScanIsActionable } from '../lab/labScanGate';

/**
 * A wizard page can be made entirely of employer questions, and that is not a
 * failed scan.
 *
 * Measured live 2026-09-15 (nvidia.wd5, Workday step 3
 * `applyFlowPrimaryQuestionsPage`): two questions, both required, both picker
 * widgets, zero canonical profile keys — there is no profile field on that page
 * to have one. The old gate asked for a canonical key and so reported
 * `NO_CANONICAL_FIELD` on the one page whose whole content is what the mock
 * answer layer exists to answer.
 */
describe('lab scan gate', () => {
  it('drives a page whose fields carry no canonical profile key', () => {
    // Workday step 3: two employer questions, canonical count 0.
    expect(labScanIsActionable(2)).toBe(true);
  });

  it('still refuses a scan that found nothing, so the pre-step retry keeps firing', () => {
    // A form still behind an "Apply for this job" expander or a consent gate.
    expect(labScanIsActionable(0)).toBe(false);
  });
});
