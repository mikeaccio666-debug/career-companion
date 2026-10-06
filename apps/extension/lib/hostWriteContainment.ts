import type { ApplyPolicy } from '@edaix/apply-kernel/policy';

export const CONTROLLED_MOCK_WRITE_TARGET = Object.freeze({
  origin: 'https://job-boards.greenhouse.io:8443',
  pathname: '/acme/jobs/12345',
});

/** Is this a live site an internal test build may write to?
 *
 * Deliberately not an allowlist. Filling is developed against whatever posting
 * the catalog produced, and pinning one vendor would only move the ceiling
 * rather than lift it. The build flag is the whole gate: this asks only whether
 * the target is an ordinary public https origin.
 *
 * Rebuilt from the parse rather than string-matched, so plain http, a port, or
 * embedded credentials are refused — those are rehearsal-harness and
 * credential-bearing shapes, and a live write has no business on them.
 */
function isLiveWriteTarget(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return parsed.hostname.includes('.');
}

/**
 * Any writer-dispatched input/change/pointer event can synchronously reach a
 * host listener that invokes the eventless direct form-submit API. An
 * isolated-world submit gate cannot observe or cancel that call. Until VM2
 * supplies a complete containment proof, every normal Extension build applies
 * a code-owned whole-policy ceiling before the first value or host event.
 *
 * `e2e/t10-host-write-hazard.mjs` now measures that claim instead of asserting
 * it, driving the production `writeTextValue` envelope against local fixtures
 * in real Chromium. It widens the claim in one place and closes the obvious
 * substitute for it:
 *
 *  - the production text envelope is input/change/blur/focusout, and a
 *    focusout listener reaches the same eventless call, so the exposed surface
 *    is larger than the three events named above;
 *  - a document-start MAIN-world hook on `HTMLFormElement.prototype.submit`
 *    does contain and witness the call — but a listener that takes a pristine
 *    submit from a child realm walks past a top-realm hook, and a listener
 *    that posts the application by `fetch` never touches a form API at all.
 *    No form-submit containment can therefore produce the negative proof this
 *    ceiling is waiting for, which is why the ceiling is still here.
 *
 * `docs/status/T10-host-write-containment-2026-09-11.md` records the exact
 * measurements and what would have to replace this ceiling.
 *
 * The one exception is the exact local Mock rehearsal build. Its compile-time
 * flag is admitted only by wxt.config for the fixed localhost harness and is
 * forced false for store builds; it is functional test coverage, never release
 * or product-milestone evidence.
 */
export function enforceHostSubmissionContainmentPolicy(
  policy: ApplyPolicy,
  target: Readonly<{ origin: string; pathname: string }>,
): ApplyPolicy {
  const controlledMockWrites =
    typeof __VIBE_CONTROLLED_MOCK_WRITES__ !== 'undefined' &&
    __VIBE_CONTROLLED_MOCK_WRITES__ === true &&
    target.origin === CONTROLLED_MOCK_WRITE_TARGET.origin &&
    target.pathname === CONTROLLED_MOCK_WRITE_TARGET.pathname;
  // Live filling. The product owner ruled on 2026-09-11 that developing the write
  // path requires writing to real postings, and accepted the accidental-submission
  // risk this ceiling was raised against for the internal test build; on 2026-09-23
  // the same ruling was extended to the store build, whose flag wxt.config pins on.
  // The remote kill switch is the runtime bundle's policy, which stays closed
  // whenever it cannot be fetched or verified. Nothing here submits: the kernel has
  // no submit action and `HOST_SUBMITTED` stays an abort reason, so the final Submit
  // is still the user's own native gesture through the submission gesture gate.
  const liveWrites =
    typeof __VIBE_LIVE_HOST_WRITES__ !== 'undefined' &&
    __VIBE_LIVE_HOST_WRITES__ === true &&
    isLiveWriteTarget(target.origin);
  if (!controlledMockWrites && !liveWrites) {
    return Object.freeze({
      ...policy,
      enabled: false,
      source: 'disabled',
    });
  }
  // The mock rehearsal keeps its narrowed capabilities, because its fixture does
  // not exercise them. A live build keeps whatever the policy already granted:
  // narrowing here would stop the run from exercising the paths it exists for.
  if (liveWrites) return Object.freeze({ ...policy });
  return Object.freeze({
    ...policy,
    capabilities: Object.freeze({
      ...policy.capabilities,
      'set-combobox': false,
      'manage-rows': false,
    }),
  });
}
