/**
 * ATS lab scan gate (VIBE_DIST=ats-lab only).
 */

/**
 * Is a resolved scan worth driving?
 *
 * The old answer was "only if at least one control carries a canonical profile
 * key". That was a proxy for "this really is an application form", and on a
 * single-page form it is a good one. On a **wizard** it is wrong: Workday's
 * step 3 (`applyFlowPrimaryQuestionsPage`, measured live 2026-09-15 on
 * nvidia.wd5) holds nothing but two employer questions — "Are you legally
 * authorized to work in the country where this position is located?" and the
 * sponsorship follow-up — so its canonical count is 0 by construction. The lab
 * reported `NO_CANONICAL_FIELD` and never built a plan, which meant the mock
 * answer layer, whose entire job is questions the profile cannot answer, never
 * ran on the one page made of them.
 *
 * The vendor anchor is the better proof and it has already spoken: the root
 * came from a rule-declared `applyFlow…Page` selector inside a verified apply
 * path, after the gate resolved. What remains to ask is only whether the scan
 * found anything at all — and a scan that found nothing still reports
 * `NO_CANONICAL_FIELD`, so the runner's pre-step retry (a form still behind an
 * expander or a consent gate) keeps firing exactly as before.
 */
export function labScanIsActionable(fieldCount: number): boolean {
  return fieldCount > 0;
}
