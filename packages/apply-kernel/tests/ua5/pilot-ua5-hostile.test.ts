/**
 * UA-5 adversarial certification bridge — PREPARATION_ONLY.
 *
 * Nothing here certifies UA-5. UA-4 is CLAIMED / IN_PROGRESS / NOT_CERTIFIED
 * with a null exact head, so this suite exists to be ready the moment that head
 * lands: it proves the S1 conformance corpus can be driven through the real
 * chain, and it names precisely what the chain does with each hostile page.
 *
 * Scope boundary, stated so it is not mistaken for coverage it does not have:
 * leaf execution is exercised through the two plan kinds reachable without a
 * live host — PREFILLED and EXISTING_KERNEL — which is the same surface UA-4's
 * own writer suite uses. The DOM-branded primitives (text settle, choice group,
 * native select, date, file) mint their authority in module-private WeakMaps and
 * are covered by their own dedicated suites; re-driving them here would be a
 * second corpus, not extra assurance.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PilotUa4FinalDisposition } from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { certify, inspect, selfDisposed, type BridgePlan, type QuestionView } from './bridge.ts';
import type { Vector } from '../semantic/harness.ts';

const VECTORS = join(__dirname, '..', 'semantic', 'vectors');
const load = (file: string): Vector => JSON.parse(readFileSync(join(VECTORS, file), 'utf8')) as Vector;

/** Reused, never copied: the S1 corpus is the single fixture authority. */
const V = {
  proxyFile: 'v01-proxy-native-file-and-decoy.json',
  radioSharedName: 'v02-radio-group-shared-name.json',
  radioLegendOnly: 'v03-radio-legend-only-no-sidecar.json',
  radiogroupDouble: 'v04-radiogroup-double-count.json',
  contenteditable: 'v05-contenteditable-required.json',
  dateShapes: 'v06-date-shapes.json',
  rowsAdded: 'v07-rows-added-by-us.json',
  rowsMiddleHole: 'v08-rows-host-removed-middle.json',
  rowsUnobserved: 'v09-unobserved-row-group.json',
  sameUrlInjection: 'v10-same-url-injection-chain-broken.json',
  ariaButtons: 'v13-aria-role-button-controls.json',
  dynamicReveal: 'v14-revealed-controls-and-hidden-count.json',
  optionsOverflow: 'v18-options-overflow-placeholder.json',
  sidecarTamper: 'v19-sidecar-binding-tamper.json',
  rowReplaced: 'v22-row-container-replaced.json',
  rowSlotReused: 'v24-row-slot-reused-after-retirement.json',
  sidecarState: 'v25-sidecar-state-fields.json',
  classificationMerge: 'v12-classification-merge-boundary.json',
  stemGuards: 'v16-stem-guards-negative-tiers.json',
} as const;

/** Every question that is not driven through a leaf still needs one terminal. */
function fillRest(
  questions: readonly QuestionView[],
  driven: readonly string[],
  disposition: PilotUa4FinalDisposition,
  supplied: ReadonlySet<string>,
): Record<string, PilotUa4FinalDisposition> {
  const out: Record<string, PilotUa4FinalDisposition> = {};
  for (const q of questions) {
    // UA-4 issues the terminal for a bounded option list, and since the
    // certified head for every question its classification makes unwritable.
    // Adding one here would be a second disposition for one question, which the
    // ledger refuses — so the bridge fills only what UA-4 leaves open.
    if (q.optionsIncomplete || supplied.has(q.nodeId)) continue;
    if (!driven.some((k) => q.nodeId === k || q.refs.includes(k))) out[q.nodeId] = disposition;
  }
  return out;
}

/**
 * The certified UA-4 disposes of an UNRESOLVED question itself, so a scenario
 * that needs to reach the writer must state what UA-2 concluded. This changes no
 * fixture and grants no authority; it is the UA-2 output a real page would carry.
 */
const OPEN_WHY = { ua2Override: { why: { kind: 'OPEN_QUESTION' as const } } };

const AUTHORITY_MISSING = {
  state: 'USER_CONFIRMATION_REQUIRED',
  reason: 'ANSWER_AUTHORITY_MISSING',
} as const;

/** Reads the vector's questions from the real compiler, then states a complete plan. */
async function certifyAll(file: string, plan: BridgePlan = {}) {
  const vector = load(file);
  const questions = inspect(vector);
  const supplied = selfDisposed(vector, plan.ua2Override);
  const driven = Object.keys(plan.leaves ?? {}).concat(Object.keys(plan.nonAdmitted ?? {}));
  const result = await certify(vector, {
    ...plan,
    nonAdmitted: { ...fillRest(questions, driven, AUTHORITY_MISSING, supplied), ...(plan.nonAdmitted ?? {}) },
  });
  return { vector, result };
}

const states = (r: Extract<Awaited<ReturnType<typeof certify>>, { ok: true }>) =>
  r.ledger.dispositions.map((d) => d.disposition.state).sort();

const ALL_VECTORS = readdirSync(VECTORS).filter((f) => f.endsWith('.json')).sort();

describe('UA-5 bridge · every visible question reaches exactly one existing-authority terminal', () => {
  it('drives the whole S1 corpus, not a hand-picked subset', () => {
    expect(ALL_VECTORS).toHaveLength(27);
  });

  for (const file of ALL_VECTORS) {
    it(`${file.replace(/\.json$/, '')}: the real chain closes the ledger`, async () => {
      const { vector, result } = await certifyAll(file);
      if (vector.expected.compile === 'COMPILE_INCOMPLETE') {
        // A page the compiler refuses must never reach a writer at all, and the
        // refusal must come from UA-3 or UA-4, not from the bridge.
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['UA3', 'UA4_PREPARE']).toContain(result.stage);
          expect(result.code).not.toBe('UNEXPECTEDLY_ADMITTED');
        }
        return;
      }
      if (!result.ok) throw new Error(`${vector.id} stopped at ${result.stage}: ${result.code}`);
      const summary = result.ledger.summary;
      expect(summary.terminalQuestions).toBe(summary.observableQuestions);
      expect(summary.terminalRequiredQuestions).toBe(summary.requiredQuestions);
      expect(summary.requiredFieldFinalDispositionCoverage).toBe(100);
      expect(new Set(result.ledger.dispositions.map((d) => d.questionId)).size).toBe(summary.observableQuestions);
      // No question may hide behind a catch-all: every terminal names a reason
      // from an existing closed set, and none is the writer's last resort.
      for (const entry of result.ledger.dispositions) {
        const disposition = entry.disposition;
        if (disposition.state === 'POLICY_BLOCKED') {
          expect(disposition.reason).not.toBe('WRITER_EXECUTION_FAILED');
        }
      }
    });
  }
});

describe('UA-5 bridge · structural facts survive into the writer admission', () => {
  it('a proxy-rendered anonymous file control is one FILE question, and the honeypot is not a question', async () => {
    const { result } = await certifyAll(V.proxyFile);
    if (!result.ok) throw new Error('unreachable');
    const file = result.questions.find((q) => q.kind === 'FILE');
    expect(file?.writerKind).toBe('FILE');
    expect(file?.identityDigests).toHaveLength(1);
    expect(result.questions.some((q) => q.refs.includes('hp_website'))).toBe(false);
  });

  it('opacity/geometry-hidden state reaches the admission as disabled and readOnly, and a multi-select stays NATIVE_SELECT', async () => {
    const { result } = await certifyAll(V.sidecarState);
    if (!result.ok) throw new Error('unreachable');
    const kinds = result.questions.map((q) => `${q.refs[0]}:${q.writerKind}`).sort();
    expect(kinds).toEqual(['handle:TEXT', 'single:NATIVE_SELECT', 'skills:NATIVE_SELECT', 'state:NATIVE_SELECT']);
  });

  for (const [name, file, refs] of [
    ['shared name', V.radioSharedName, ['sp_yes', 'sp_no', 'sp_maybe']],
    ['aria radiogroup', V.radiogroupDouble, ['rg', 'rg_ft', 'rg_pt']],
  ] as const) {
    it(`a radio group by ${name} is admitted once, carrying every member identity`, async () => {
      const { result } = await certifyAll(file);
      if (!result.ok) throw new Error('unreachable');
      const group = result.questions.filter((q) => q.writerKind === 'RADIO_GROUP');
      expect(group).toHaveLength(1);
      expect([...group[0]!.refs].sort()).toEqual([...refs].sort());
      expect(group[0]!.identityDigests).toHaveLength(refs.length);
    });
  }

  it('a bounded option list blocks only its own question, with the specific OPTIONS_INCOMPLETE reason', async () => {
    const { result } = await certifyAll(V.optionsOverflow);
    if (!result.ok) throw new Error('unreachable');
    const blocked = result.ledger.dispositions.filter(
      (d) => d.disposition.state === 'POLICY_BLOCKED' && d.disposition.reason === 'OPTIONS_INCOMPLETE',
    );
    expect(blocked).toHaveLength(1);
    const year = result.questions.find((q) => q.refs.includes('year'))!;
    expect(blocked[0]!.questionId).toBe(year.nodeId);
    // The page is not failed: the other two questions still reach terminals.
    expect(result.ledger.summary.observableQuestions).toBe(3);
  });

  it('a button carrying a form-control role is a question; a Submit button is never one', async () => {
    const { result } = await certifyAll(V.ariaButtons);
    if (!result.ok) throw new Error('unreachable');
    expect(result.questions.map((q) => q.refs[0]).sort()).toEqual(['agree', 'remote']);
    expect(result.questions.some((q) => q.refs.includes('next'))).toBe(false);
  });

  it('a row that keeps its incarnation across a middle-hole shift stays one question', async () => {
    const { result } = await certifyAll(V.rowsMiddleHole);
    if (!result.ok) throw new Error('unreachable');
    const tokens = result.questions.map((q) => q.rowToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.every((t) => t !== null)).toBe(true);
  });

  it('a reused row slot yields a different question from the incarnation it replaced', async () => {
    const { result } = await certifyAll(V.rowSlotReused);
    if (!result.ok) throw new Error('unreachable');
    expect(new Set(result.questions.map((q) => q.rowToken)).size).toBe(result.questions.length);
  });

  it('controls revealed by a later epoch are questions in the same ledger', async () => {
    const { result } = await certifyAll(V.dynamicReveal);
    if (!result.ok) throw new Error('unreachable');
    expect(result.questions.map((q) => q.refs[0]).sort()).toEqual(['sponsor_shifted', 'visa_expiry', 'visa_type']);
  });
});

describe('UA-5 bridge · same-URL injection and drift stop before any writer', () => {
  it('a rescan that reuses the previous DOM generation never reaches UA-4', async () => {
    const { result } = await certifyAll(V.sameUrlInjection);
    expect(result.ok).toBe(false);
  });

  it('a sidecar that does not bind to its packet never reaches UA-4', async () => {
    const { result } = await certifyAll(V.sidecarTamper);
    expect(result.ok).toBe(false);
  });

  it('a control whose element persists while its row container is replaced never reaches UA-4', async () => {
    const { result } = await certifyAll(V.rowReplaced);
    expect(result.ok).toBe(false);
  });
});

describe('UA-5 bridge · mutations on the four guarantees that matter', () => {
  // ---- identity -----------------------------------------------------------
  for (const [name, tamper, code] of [
    ['a changed DOM generation', 'BINDING_GENERATION', 'PILOT_TARGET_DRIFT'],
    ['a control that vanished between admission and write', 'IDENTITY_SET', 'PILOT_TARGET_DRIFT'],
    ['a rule whose ordered identities do not match the page', 'RULE_ORDER', 'PILOT_TARGET_DRIFT'],
    ['an expired candidate', 'EXPIRED', 'PILOT_EPHEMERAL_RULE_EXPIRED'],
  ] as const) {
    it(`identity: ${name} is refused with ${code}`, async () => {
      const { result } = await certifyAll(V.contenteditable, { tamper });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe('UA3');
        expect(result.code).toBe(code);
      }
    });
  }

  // ---- readback -----------------------------------------------------------
  it('readback: a PREFILLED claim without semantic proof becomes HOST_REJECTED, never PREFILLED', async () => {
    const proven = await certifyAll(V.contenteditable, { leaves: { fullname: { kind: 'PREFILLED', current: true } } });
    const unproven = await certifyAll(V.contenteditable, { leaves: { fullname: { kind: 'PREFILLED', current: false } } });
    if (!proven.result.ok || !unproven.result.ok) throw new Error('unreachable');
    expect(states(proven.result)).toContain('PREFILLED');
    expect(states(unproven.result)).not.toContain('PREFILLED');
    const blocked = unproven.result.ledger.dispositions.find((d) => d.disposition.state === 'POLICY_BLOCKED');
    expect(blocked?.disposition).toEqual({ state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED' });
  });

  it('readback: a host that accepts the write yields HOST_ACCEPTED with a stable late recheck', async () => {
    const { result } = await certifyAll(V.contenteditable, { ...OPEN_WHY, leaves: { why: { kind: 'HOST_ACCEPTED' } } });
    if (!result.ok) throw new Error('unreachable');
    const filled = result.ledger.dispositions.find((d) => d.disposition.state === 'FILLED');
    expect(filled?.disposition).toEqual({
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    });
  });

  for (const [name, code, reason] of [
    ['the host rejects the value', 'HOST_REJECTED', 'HOST_REJECTED'],
    ['the value is reverted after the late window', 'LATE_REVERTED', 'LATE_REVERTED'],
    ['the target is replaced mid-write', 'IDENTITY_CHANGED', 'EXACT_TARGET_DRIFT'],
    ['the target detaches mid-write', 'DETACHED', 'EXACT_TARGET_DRIFT'],
  ] as const) {
    it(`readback: ${name} is a specific terminal, not a generic failure`, async () => {
      const { result } = await certifyAll(V.contenteditable, { ...OPEN_WHY, leaves: { why: { kind: 'APPLY_FAILURE', code } } });
      if (!result.ok) throw new Error('unreachable');
      const blocked = result.ledger.dispositions.map((d) => d.disposition).filter((d) => d.state === 'POLICY_BLOCKED');
      expect(blocked.map((d) => d.reason)).toContain(reason);
      expect(blocked.map((d) => d.reason)).not.toContain('WRITER_EXECUTION_FAILED');
    });
  }

  // ---- Undo ---------------------------------------------------------------
  it('undo: a write that cannot be journalled is UNDO_UNAVAILABLE and yields no undo handle', async () => {
    const { result } = await certifyAll(V.contenteditable, {
      ...OPEN_WHY, leaves: { why: { kind: 'APPLY_FAILURE', code: 'JOURNAL_UNAVAILABLE' } },
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.undoCount).toBe(0);
    const blocked = result.ledger.dispositions.map((d) => d.disposition).filter((d) => d.state === 'POLICY_BLOCKED');
    expect(blocked.map((d) => d.reason)).toContain('UNDO_UNAVAILABLE');
  });

  it('undo: a filled question owns exactly one targeted undo handle', async () => {
    const { result } = await certifyAll(V.contenteditable, { ...OPEN_WHY, leaves: { why: { kind: 'HOST_ACCEPTED' } } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.undoCount).toBe(1);
    expect(result.ledger.dispositions.filter((d) => d.disposition.state === 'FILLED')).toHaveLength(1);
  });

  // ---- Submit -------------------------------------------------------------
  it('submit: the writer authority forbids Submit and no action control is ever a writable question', async () => {
    const { result } = await certifyAll(V.ariaButtons, { leaves: { agree: { kind: 'PREFILLED', current: true } } });
    if (!result.ok) throw new Error('unreachable');
    // The Submit button is an action node: it is not in the ledger at all, so
    // it can neither be authorized nor counted as an unanswered question.
    expect(result.ledger.dispositions).toHaveLength(2);
    expect(result.questions.some((q) => q.refs.includes('next'))).toBe(false);
    // The guarantee is that nothing the chain produces means "we submitted".
    // MANUAL_REQUIRED itself is correct and expected here: the certified UA-4
    // issues MANUAL_REQUIRED/HUMAN_ACTION for a consent checkbox. What must
    // never appear on its own is the FINAL_SUBMIT reason.
    for (const d of result.ledger.dispositions) {
      if (d.disposition.state === 'MANUAL_REQUIRED') expect(d.disposition.reason).not.toBe('FINAL_SUBMIT');
    }
  });

  it('submit: a question UA-2 calls a submit control gets FINAL_SUBMIT from UA-4 and is never written', async () => {
    const { result } = await certifyAll(V.ariaButtons, {
      ua2Override: { agree: { kind: 'HUMAN_ACTION_REQUIRED', reasonCode: 'HUMAN_SUBMIT_CONTROL' } },
    });
    if (!result.ok) throw new Error('unreachable');
    const agree = result.questions.find((q) => q.refs.includes('agree'))!;
    expect(result.ledger.dispositions.find((d) => d.questionId === agree.nodeId)!.disposition)
      .toEqual({ state: 'MANUAL_REQUIRED', reason: 'FINAL_SUBMIT' });
    expect(states(result)).not.toContain('FILLED');
    expect(states(result)).not.toContain('PREFILLED');
  });

  it('guards: an other-person question gets its own terminal, never a generic one', async () => {
    const { result } = await certifyAll(V.stemGuards);
    if (!result.ok) throw new Error('unreachable');
    const emergency = result.questions.find((q) => q.refs.includes('ec_email'))!;
    expect(result.ledger.dispositions.find((d) => d.questionId === emergency.nodeId)!.disposition)
      .toEqual({ state: 'MANUAL_REQUIRED', reason: 'OTHER_PERSON' });
  });

  it('submit: a Submit question can only ever be a human terminal, never a written one', async () => {
    const { result } = await certifyAll(V.proxyFile, {
      nonAdmitted: { resume: { state: 'MANUAL_REQUIRED', reason: 'FINAL_SUBMIT' } },
    });
    if (!result.ok) throw new Error('unreachable');
    const manual = result.ledger.dispositions.find((d) => d.disposition.state === 'MANUAL_REQUIRED');
    expect(manual?.disposition).toEqual({ state: 'MANUAL_REQUIRED', reason: 'FINAL_SUBMIT' });
    expect(states(result)).not.toContain('FILLED');
  });
});

describe('UA-5 bridge · findings handed to the UA-4 owner (PREPARATION_ONLY)', () => {
  /**
   * FINDING UA5-A — status: CLOSED_BY_PR174
   *
   * Detected against pre-#174 UA-4 (base 808dd0cb): a required PASSWORD question
   * was a visible required logical question that no UA-4 function could give a
   * terminal to, so the ledger closed only because the caller supplied one.
   *
   * PR #174 (merged as 40fa0adc, the certified UA-4 exact head) added
   * `classificationTerminalDisposition`, which issues UA-4's own terminal for
   * every question its classification makes unwritable — human action, password,
   * Submit, other-person, conflicted, guarded, and writerKind = null. The fix is
   * the owner's; this branch changed no UA-4 runtime.
   *
   * This test now asserts the closure: UA-4 produces the password terminal
   * itself, and the caller supplies nothing for it.
   */
  it('UA5-A: the certified UA-4 issues the password terminal itself (CLOSED_BY_PR174)', async () => {
    const vector = load(V.classificationMerge);
    const questions = inspect(vector);
    const password = questions.find((q) => q.kind === 'PASSWORD');
    expect(password).toBeDefined();
    expect(password!.required).toBe(true);
    // Still unauthorizable — that never was the defect.
    expect(password!.writerKind).toBeNull();

    // The closure: UA-4 disposes of it without any caller-supplied terminal.
    expect(selfDisposed(vector).has(password!.nodeId)).toBe(true);

    // And the terminal it issues is the specific one, not a catch-all. With the
    // vector's own classification UA-2 says only "human action"; when UA-2 names
    // a password control, UA-4 names PASSWORD.
    const asClassified = await certifyAll(V.classificationMerge);
    if (!asClassified.result.ok) throw new Error(`stopped at ${asClassified.result.stage}`);
    const pwTerminal = asClassified.result.ledger.dispositions
      .find((d) => d.questionId === password!.nodeId)!.disposition;
    expect(pwTerminal).toEqual({ state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' });

    const asPassword = await certifyAll(V.classificationMerge, {
      ua2Override: { pw: { kind: 'HUMAN_ACTION_REQUIRED', reasonCode: 'HUMAN_PASSWORD_CONTROL' } },
    });
    if (!asPassword.result.ok) throw new Error(`stopped at ${asPassword.result.stage}`);
    expect(asPassword.result.ledger.dispositions.find((d) => d.questionId === password!.nodeId)!.disposition)
      .toEqual({ state: 'MANUAL_REQUIRED', reason: 'PASSWORD' });
  });

  /**
   * FINDING UA5-B — test-harness legalization only.
   *
   * The S1 test harness builds a synthetic UA-2 whose provenance source does not
   * follow the contract's reason -> source pairing, because nothing parses it
   * inside the S1 suite. A UA-3 rule built straight from it is therefore
   * rejected by parsePilotUa3CandidateRule.
   *
   * The bridge's `sourceForReason` adapter exists to make a TEST fixture legal
   * for a real parser. It changes no authority: UA-2 remains the sole classifier
   * and UA-3 remains the sole admission authority, and neither is patched,
   * relaxed or re-implemented here. The adapter only chooses which contract-legal
   * provenance a synthetic classification carries; a real UA-2 response already
   * carries its own and would flow through untouched.
   *
   * Recorded so the next reader does not mistake the rejection for a UA-3 defect
   * or the adapter for a second classifier.
   */
  it('UA5-B: the bridge maps UA-2 provenance to the pairing UA-3 actually parses', async () => {
    const { result } = await certifyAll(V.contenteditable);
    expect(result.ok).toBe(true);
  });
});
