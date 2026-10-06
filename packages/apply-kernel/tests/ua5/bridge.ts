/**
 * UA-5 adversarial certification bridge (PREPARATION_ONLY).
 *
 * This is not a new pipeline. It walks one S1 conformance vector through the
 * REAL chain that already exists on main, in the order production would:
 *
 *   UA-1 observation epochs + StructureSidecarV1   (S1 vector corpus, reused)
 *     → UA-3 exact-page admission                  resolvePilotUa3CandidateRule
 *     → UA-4 writer batch                          preparePilotUa4WriterBatch
 *          (which internally runs #164's compileGraph and classifyQuestions,
 *           so the S1 compiler is exercised as the single semantic authority)
 *     → UA-4 leaf execution                        executePilotUa4Leaf
 *     → UA-4 terminal ledger                       buildPilotUa4TerminalLedger
 *
 * It adds no compiler, no writer and no ledger of its own. Every disposition it
 * reports comes from a UA-4 function; the bridge only decides which leaf plan a
 * scenario feeds in, exactly as a page-local runner would.
 *
 * The fixture corpus is NOT copied: epochs come from the S1 harness's own
 * `compiledEpochs`, so there is one fixture authority for both suites.
 */

import { createHash } from 'node:crypto';
import type { PilotUa1PageBinding, PilotUa2Classification } from '@edaix/contracts/draft';
import type {
  PilotUa4FinalDisposition,
  PilotUa4TerminalLedger,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { resolvePilotUa3CandidateRule } from '../../src/pilotUa3CandidateRule.ts';
import {
  buildPilotUa4TerminalLedger,
  executePilotUa4Leaf,
  preparePilotUa4WriterBatch,
  type PilotUa4CompiledQuestion,
  type PilotUa4LeafPlan,
} from '../../src/pilotUa4Writer.ts';
import { compileGraph } from '../../src/semantic/graph.ts';
import type { QuestionNode } from '../../src/semantic/ir.ts';
import { compiledEpochs, expandEpochs, sha256, type Vector } from '../semantic/harness.ts';

const NOW_MS = 1_000_000;
const TTL_MS = 30_000;

/** Writer kinds UA-4 admits. A question outside this set can never be authorized. */
export type WriterKind =
  | 'TEXT' | 'TEXTAREA' | 'CONTENTEDITABLE' | 'NATIVE_SELECT' | 'COMBOBOX'
  | 'RADIO_GROUP' | 'CHECKBOX_GROUP' | 'DATE' | 'FILE';

const WRITER_KIND: Readonly<Record<string, WriterKind>> = Object.freeze({
  TEXT_SINGLE: 'TEXT', TEXT_MULTILINE: 'TEXTAREA', TEXT_RICH: 'CONTENTEDITABLE',
  SELECT_ONE: 'NATIVE_SELECT', SELECT_MANY: 'NATIVE_SELECT', COMBOBOX: 'COMBOBOX',
  RADIO_GROUP: 'RADIO_GROUP', CHECKBOX_GROUP: 'CHECKBOX_GROUP', CHECKBOX_SINGLE: 'CHECKBOX_GROUP',
  SWITCH: 'CHECKBOX_GROUP', DATE: 'DATE', FILE: 'FILE',
});

export interface QuestionView {
  readonly nodeId: string;
  readonly kind: string;
  readonly writerKind: WriterKind | null;
  readonly required: boolean;
  readonly optionsIncomplete: boolean;
  readonly rowToken: string | null;
  readonly identityDigests: readonly string[];
  /** Vector refs behind this question, for readable expectations. */
  readonly refs: readonly string[];
}

/** What the scenario says happens when the runner touches an admitted question. */
export type LeafOutcome =
  | { readonly kind: 'PREFILLED'; readonly current: boolean }
  | { readonly kind: 'HOST_ACCEPTED' }
  | { readonly kind: 'APPLY_FAILURE'; readonly code: 'HOST_REJECTED' | 'LATE_REVERTED' | 'IDENTITY_CHANGED' | 'DETACHED' | 'JOURNAL_UNAVAILABLE' };

export interface BridgePlan {
  /** nodeId or vector ref → what the host does. Absent = not authorized at all. */
  readonly leaves?: Readonly<Record<string, LeafOutcome>>;
  /**
   * Dispositions the scenario asserts must come from an existing authority for
   * questions UA-4 cannot admit (password, action-shaped, unknown kind, …).
   * The bridge never invents these; a scenario that needs one and cannot name
   * an existing-authority state is itself the finding.
   */
  readonly nonAdmitted?: Readonly<Record<string, PilotUa4FinalDisposition>>;
  /** False when the page proves later steps exist (S7 territory). */
  readonly discoveryComplete?: boolean;
  /** Drift injections, for the identity mutation class only. */
  readonly tamper?: 'BINDING_GENERATION' | 'IDENTITY_SET' | 'EXPIRED' | 'RULE_ORDER';
  /** Which existing answer authority the backend cites; default PROFILE_CONFIRMED. */
  readonly answerAuthority?: Readonly<Record<string, 'PROFILE_CONFIRMED' | 'SCOPED_MEMORY_CONFIRMED' | 'USER_CONFIRMED'>>;
  /**
   * Supplies what UA-2 concluded for one control, instead of the vector's own
   * synthetic value. This does not modify the fixture and does not classify
   * anything: UA-2 remains the sole classifier, and this is the same shape a
   * real UA-2 response carries. It exists because the certified UA-4 disposes of
   * an unclassified question itself, so a scenario that needs to reach the
   * writer must say what UA-2 concluded, exactly as production would.
   */
  readonly ua2Override?: Readonly<Record<string, {
    kind: PilotUa2Classification['kind'];
    canonicalField?: PilotUa2Classification['canonicalField'];
    confidence?: PilotUa2Classification['confidence'];
    reasonCode?: PilotUa2Classification['reasonCode'];
  }>>;
}

/** Question ids UA-4 gives a terminal to by itself, asked of UA-4, not restated. */
export function selfDisposed(vector: Vector, override: BridgePlan['ua2Override'] = undefined): ReadonlySet<string> {
  const epochs = compiledEpochs(vector);
  const compiled = compileGraph(epochs, sha256);
  if (!compiled.ok) return new Set();
  const last = epochs[epochs.length - 1]!;
  const probe = preparePilotUa4WriterBatch({
    authority: emptyAuthority(vector, epochs),
    currentBinding: last.binding,
    currentControlIdentityDigests: last.controls.map((c) => c.identityDigest),
    nowMs: NOW_MS,
    semanticEpochs: epochs,
    ua2Classifications: ua2InPacketOrder(vector, last.controls.map((c) => c.identityDigest), override),
    semanticDigest: sha256,
    payloadRefs: [],
  });
  return new Set(probe.ok ? probe.value.dispositions.map((d) => d.questionId) : []);
}

export type BridgeResult =
  | { readonly ok: false; readonly stage: 'UA3' | 'UA4_PREPARE' | 'UA4_LEDGER'; readonly code: string }
  | {
      readonly ok: true;
      readonly questions: readonly QuestionView[];
      readonly admitted: readonly PilotUa4CompiledQuestion[];
      readonly ledger: PilotUa4TerminalLedger;
      readonly undoCount: number;
      readonly disposedUndos: number;
    };

function questionViews(vector: Vector): { views: QuestionView[]; binding: PilotUa1PageBinding; digests: string[]; epochs: ReturnType<typeof compiledEpochs> } {
  const epochs = compiledEpochs(vector);
  const compiled = compileGraph(epochs, sha256);
  if (!compiled.ok) throw new Error(`vector ${vector.id} does not compile: ${compiled.reason}`);
  const graph = compiled.graph;
  const finalIndex = graph.epochs.length - 1;
  // Refs come from the harness's own expansion, so a vector that describes a
  // later epoch as a delta is read exactly as the compiler read it.
  const refOf = new Map<string, string>();
  for (const epoch of expandEpochs(vector)) for (const c of epoch.controls) refOf.set(sha256('ref', c.ref), c.ref);
  const views = graph.nodes
    .filter((n): n is QuestionNode => n.kind === 'QUESTION' && n.lastObservedEpoch === finalIndex)
    .map((n) => Object.freeze({
      nodeId: n.id,
      kind: n.control.kind,
      writerKind: WRITER_KIND[n.control.kind] ?? null,
      required: n.required,
      optionsIncomplete: n.control.optionsIncomplete,
      rowToken: n.rowToken,
      identityDigests: Object.freeze(n.control.members.map((m) => m.identityDigest)),
      refs: Object.freeze(n.control.members.map((m) => refOf.get(m.identityDigest) ?? m.identityDigest.slice(0, 8))),
    }));
  const finalEpoch = graph.epochs[finalIndex]!;
  return {
    views,
    binding: graph.binding,
    digests: finalEpoch.controls.map((c) => c.identityDigest),
    epochs,
  };
}

/** Everything a vector's final epoch says UA-2 concluded, in packet order. */
function ua2InPacketOrder(
  vector: Vector,
  digests: readonly string[],
  override: BridgePlan['ua2Override'] = undefined,
): PilotUa2Classification[] {
  const byDigest = new Map<string, PilotUa2Classification>();
  const expanded = compiledEpochs(vector);
  void expanded;
  for (const epoch of vector.epochs) {
    for (const [ref, raw] of Object.entries(epoch.ua2 ?? {})) {
      const c = override?.[ref] ?? raw;
      const digest = sha256('ref', ref);
      byDigest.set(digest, Object.freeze({
        identityDigest: digest,
        kind: c.kind,
        canonicalField: c.canonicalField ?? null,
        confidence: c.confidence ?? (c.kind === 'UNRESOLVED' ? 'LOW' : 'HIGH'),
        // UA5-B, test-harness legalization only. The contract pins
        // reason -> provenance source. The S1 harness builds a looser synthetic
        // UA-2 because nothing parses it there; a real UA-3 rule IS parsed, so a
        // synthetic classification must carry a contract-legal pairing to reach
        // the admission at all. This grants no authority: UA-2 stays the only
        // classifier and UA-3 the only admission authority, both unmodified.
        provenance: Object.freeze({
          source: sourceForReason(c.reasonCode ?? defaultReason(c.kind)),
          semanticDigest: sha256('sem', ref),
        }),
        reasonCode: c.reasonCode ?? defaultReason(c.kind),
      }));
    }
  }
  return digests.map((digest) => byDigest.get(digest) ?? Object.freeze({
    identityDigest: digest,
    kind: 'UNRESOLVED' as const,
    canonicalField: null,
    confidence: 'LOW' as const,
    provenance: Object.freeze({ source: 'BACKEND_TEXT_CLASSIFIER' as const, semanticDigest: sha256('sem', digest) }),
    reasonCode: 'SEMANTIC_CLASSIFICATION_UNRESOLVED' as const,
  }));
}

function sourceForReason(reason: PilotUa2Classification['reasonCode']): PilotUa2Classification['provenance']['source'] {
  if (reason === 'CANONICAL_AUTOCOMPLETE_MATCH') return 'AUTOCOMPLETE';
  if (reason === 'CANONICAL_SEMANTIC_MATCH' || reason === 'SEMANTIC_CLASSIFICATION_UNRESOLVED') {
    return 'BACKEND_TEXT_CLASSIFIER';
  }
  return 'CONTROL_SEMANTICS';
}

function defaultReason(kind: PilotUa2Classification['kind']): PilotUa2Classification['reasonCode'] {
  switch (kind) {
    case 'CANONICAL_FIELD': return 'CANONICAL_AUTOCOMPLETE_MATCH';
    case 'STRUCTURED_CHOICE': return 'STRUCTURED_CHOICE_CONTROL';
    case 'STRUCTURED_DATE': return 'STRUCTURED_DATE_CONTROL';
    case 'STRUCTURED_NUMBER': return 'STRUCTURED_NUMBER_CONTROL';
    case 'STRUCTURED_FILE': return 'STRUCTURED_FILE_CONTROL';
    case 'OPEN_QUESTION': return 'OPEN_QUESTION_CONTROL';
    case 'HUMAN_ACTION_REQUIRED': return 'HUMAN_ACTION_CONTROL';
    default: return 'SEMANTIC_CLASSIFICATION_UNRESOLVED';
  }
}

/** An authority that authorizes nothing, so only the compiler stage can fail. */
function emptyAuthority(vector: Vector, epochs: readonly EpochInputLike[]) {
  const last = epochs[epochs.length - 1]!;
  const digests = last.controls.map((c) => c.identityDigest);
  return Object.freeze({
    authorityId: sha256('authority', vector.id),
    binding: last.binding,
    pageIdentityDigest: pageIdentity(digests),
    observedControlIdentityDigests: digests,
    expiresAtMs: NOW_MS + TTL_MS,
    questionAuthorizations: [],
    blockedQuestions: [],
    constraints: Object.freeze({
      exactTargetBinding: 'REQUIRED' as const,
      semanticReadback: 'REQUIRED' as const,
      hostValidation: 'REQUIRED' as const,
      lateRecheck: 'REQUIRED' as const,
      undo: 'REQUIRED' as const,
      submit: 'FORBIDDEN' as const,
      activationState: 'DEFAULT_OFF' as const,
      releaseState: 'NOT_RELEASED' as const,
    }),
  });
}

type EpochInputLike = ReturnType<typeof compiledEpochs>[number];

const pageIdentity = (digests: readonly string[]): string =>
  createHash('sha256').update(digests.join('|'), 'utf8').digest('hex');

/**
 * The questions the real compiler produces for a vector, with no authority and
 * no ledger. Scenarios use it to state a complete disposition plan up front.
 */
export function inspect(vector: Vector): readonly QuestionView[] {
  const compiled = compileGraph(compiledEpochs(vector), sha256);
  if (!compiled.ok) return Object.freeze([]);
  return questionViews(vector).views;
}

/** Runs one vector through the real chain. */
export async function certify(vector: Vector, plan: BridgePlan = {}): Promise<BridgeResult> {
  const compiledOnce = compileGraph(compiledEpochs(vector), sha256);
  if (!compiledOnce.ok) {
    // Drive the real refusal: UA-4 runs the compiler itself and must stop.
    const epochsOnly = compiledEpochs(vector);
    const refused = preparePilotUa4WriterBatch({
      authority: emptyAuthority(vector, epochsOnly),
      currentBinding: epochsOnly[epochsOnly.length - 1]!.binding,
      currentControlIdentityDigests: epochsOnly[epochsOnly.length - 1]!.controls.map((c) => c.identityDigest),
      nowMs: NOW_MS,
      semanticEpochs: epochsOnly,
      ua2Classifications: [],
      semanticDigest: sha256,
      payloadRefs: [],
    });
    return Object.freeze({
      ok: false as const,
      stage: 'UA4_PREPARE' as const,
      code: refused.ok ? 'UNEXPECTEDLY_ADMITTED' : refused.code,
    });
  }
  const { views, binding, digests, epochs } = questionViews(vector);
  const classifications = ua2InPacketOrder(vector, digests, plan.ua2Override);
  const byRefOrId = (key: string): QuestionView | undefined =>
    views.find((v) => v.nodeId === key || v.refs.includes(key));

  const liveBinding: PilotUa1PageBinding = plan.tamper === 'BINDING_GENERATION'
    ? { ...binding, domGeneration: sha256('gen', 'tampered') }
    : binding;
  const liveDigests = plan.tamper === 'IDENTITY_SET' ? digests.slice(0, -1) : digests;
  const nowMs = plan.tamper === 'EXPIRED' ? NOW_MS + TTL_MS : NOW_MS;

  const rule = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'EPHEMERAL_PAGE_CANDIDATE' as const,
    binding,
    pageIdentityDigest: pageIdentity(digests),
    issuedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + TTL_MS,
    classifications: plan.tamper === 'RULE_ORDER' ? [...classifications].reverse() : classifications,
    constraints: Object.freeze({
      remoteCode: 'FORBIDDEN' as const,
      automaticPublication: 'FORBIDDEN' as const,
      writerAuthority: 'NOT_GRANTED' as const,
      submit: 'HUMAN_ONLY' as const,
      activationState: 'DEFAULT_OFF' as const,
      releaseState: 'NOT_RELEASED' as const,
    }),
  });

  const admission = resolvePilotUa3CandidateRule({
    rule, currentBinding: liveBinding, currentControlIdentityDigests: liveDigests, nowMs,
  });
  if (!admission.ok) return Object.freeze({ ok: false, stage: 'UA3' as const, code: admission.code });

  // The backend issues authority only for questions UA-4 can admit. Everything
  // else stays in the denominator and must reach a terminal by another route.
  const named = (v: QuestionView): boolean =>
    plan.leaves?.[v.nodeId] !== undefined || v.refs.some((r) => plan.leaves?.[r] !== undefined);
  // Ask UA-4 which questions it disposes of on its own. Since the certified
  // head (#174) UA-4 issues its own terminal for a question whose classification
  // makes it unwritable — human action, conflicted, guarded, kind mismatch — and
  // refuses to authorize one. The bridge must not restate that rule: it runs a
  // no-authority prepare and reads the answer back, so UA-4 stays the authority.
  const selfDisposedIds = new Set(
    ((): readonly string[] => {
      const probe = preparePilotUa4WriterBatch({
        authority: emptyAuthority(vector, epochs),
        currentBinding: liveBinding,
        currentControlIdentityDigests: liveDigests,
        nowMs,
        semanticEpochs: epochs,
        ua2Classifications: classifications,
        semanticDigest: sha256,
        payloadRefs: [],
      });
      return probe.ok ? probe.value.dispositions.map((d) => d.questionId) : [];
    })(),
  );
  const admittable = views.filter(
    (v) => v.writerKind !== null && !v.optionsIncomplete && !selfDisposedIds.has(v.nodeId) && named(v),
  );
  const blocked = views.filter(
    (v) => v.writerKind !== null && v.optionsIncomplete && !selfDisposedIds.has(v.nodeId),
  );

  const authority = Object.freeze({
    authorityId: sha256('authority', vector.id),
    binding,
    pageIdentityDigest: rule.pageIdentityDigest,
    observedControlIdentityDigests: digests,
    expiresAtMs: NOW_MS + TTL_MS,
    questionAuthorizations: admittable.map((v) => Object.freeze({
      questionId: v.nodeId,
      controlKind: v.writerKind!,
      identityDigests: v.identityDigests,
      required: v.required,
      answerAuthority: plan.answerAuthority?.[v.nodeId] ?? 'PROFILE_CONFIRMED',
      answerDigest: sha256('answer', v.nodeId),
    })),
    blockedQuestions: blocked.map((v) => Object.freeze({
      questionId: v.nodeId,
      controlKind: v.writerKind as 'NATIVE_SELECT' | 'COMBOBOX' | 'RADIO_GROUP' | 'CHECKBOX_GROUP',
      identityDigests: v.identityDigests,
      required: v.required,
      code: 'OPTIONS_INCOMPLETE' as const,
    })),
    constraints: Object.freeze({
      exactTargetBinding: 'REQUIRED' as const,
      semanticReadback: 'REQUIRED' as const,
      hostValidation: 'REQUIRED' as const,
      lateRecheck: 'REQUIRED' as const,
      undo: 'REQUIRED' as const,
      // The authority's own zero-Submit clause. UA-3's rule says HUMAN_ONLY
      // (a human may submit); the writer authority says FORBIDDEN (we never do).
      submit: 'FORBIDDEN' as const,
      activationState: 'DEFAULT_OFF' as const,
      releaseState: 'NOT_RELEASED' as const,
    }),
  });

  const prepared = preparePilotUa4WriterBatch({
    authority,
    currentBinding: liveBinding,
    currentControlIdentityDigests: liveDigests,
    nowMs,
    semanticEpochs: epochs,
    ua2Classifications: classifications,
    semanticDigest: sha256,
    payloadRefs: admittable.map((v) => Object.freeze({ questionId: v.nodeId, payloadRef: `payload-${v.nodeId.slice(0, 12)}` })),
  });
  if (!prepared.ok) return Object.freeze({ ok: false, stage: 'UA4_PREPARE' as const, code: prepared.code });

  const dispositions: Array<{ questionId: string; disposition: PilotUa4FinalDisposition }> = [
    ...prepared.value.dispositions.map((d) => ({ questionId: d.questionId, disposition: d.disposition })),
  ];
  const undos: Array<{ dispose(): void }> = [];
  let disposed = 0;

  for (const question of prepared.value.questions) {
    const view = views.find((v) => v.nodeId === question.questionId)!;
    const outcome = plan.leaves?.[question.questionId] ?? plan.leaves?.[view.refs.find((r) => plan.leaves?.[r]) ?? ''];
    if (!outcome) continue;
    const leafPlan: PilotUa4LeafPlan = outcome.kind === 'PREFILLED'
      ? { kind: 'PREFILLED', readCurrentSemantic: () => outcome.current }
      : {
          kind: 'EXISTING_KERNEL',
          control: question.controlKind === 'COMBOBOX' ? 'COMBOBOX' : 'CONTENTEDITABLE',
          execute: async () => (outcome.kind === 'HOST_ACCEPTED'
            ? Object.freeze({
                ok: true as const, disposition: 'FILLED' as const,
                semanticReadback: 'HOST_ACCEPTED' as const, lateRecheck: 'STABLE' as const,
                undo: Object.freeze({ dispose: () => { disposed += 1; } }),
              })
            : Object.freeze({ ok: false as const, code: outcome.code })),
        };
    const result = await executePilotUa4Leaf(question, leafPlan);
    if (result.undo && 'dispose' in result.undo) undos.push(result.undo as { dispose(): void });
    dispositions.push({ questionId: question.questionId, disposition: result.disposition });
  }

  for (const [key, disposition] of Object.entries(plan.nonAdmitted ?? {})) {
    const view = byRefOrId(key);
    if (!view) throw new Error(`nonAdmitted names an unknown question "${key}" in ${vector.id}`);
    dispositions.push({ questionId: view.nodeId, disposition });
  }

  const ledger = buildPilotUa4TerminalLedger({
    binding,
    discoveryComplete: plan.discoveryComplete ?? true,
    questions: prepared.value.denominatorQuestions,
    dispositions: dispositions.map((d) => Object.freeze(d)),
  });
  if (!ledger.ok) return Object.freeze({ ok: false, stage: 'UA4_LEDGER' as const, code: ledger.code });
  return Object.freeze({
    ok: true, questions: views, admitted: prepared.value.questions,
    ledger: ledger.value, undoCount: undos.length, disposedUndos: disposed,
  });
}

export { NOW_MS, TTL_MS };
