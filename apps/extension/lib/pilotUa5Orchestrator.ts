/**
 * UA-5 current-page orchestrator (Extension side).
 *
 * The one place the rungs become a run. It observes the current page through
 * the certified UA-1 runtime, asks the authenticated backend to compose
 * UA-2 → UA-3 → compiler → UA-4 authority, drives the sole UA-4 writer port,
 * and projects the terminal ledger UA-4 returns.
 *
 * It owns no rule of its own: no compiler, no classifier, no authority, no
 * second ledger. Every state it reports comes from the UA-4 terminal ledger.
 *
 * Value-free by construction. It never sees, stores or transmits a raw answer,
 * page HTML or a selector; answers are named to the backend by control digest
 * and answer digest only. It has no Submit path: the writer port cannot submit,
 * and this module dispatches no host event of its own.
 */

import type { PilotUa2Classification } from '@edaix/contracts/draft';
import type { PilotUa1Observation } from './pilotUa1DiscoveryRuntime';
import type {
  PilotUa4FinalDisposition,
  PilotUa4TerminalLedger,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import {
  PILOT_UA5_COMPLETED_STATES,
  PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION,
  PILOT_UA5_TRIGGER,
  type PilotUa5CompositionResponse,
  type PilotUa5RunProjection,
  type PilotUa5RunRow,
} from '@edaix/contracts/draft/pilot-ua5-certification';
import type { PilotUa4WriterRuntime, PilotUa4WriterRuntimeResult } from './pilotUa4WriterRuntime';

export const PILOT_UA5_COMPOSE_ENDPOINT = '/api/v1/agent/pilot/ua5/compose';

export const PILOT_UA5_RUN_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_NOT_USER_TRIGGERED',
  /**
   * UA-1 could not produce an observation. It already fails closed on the two
   * reachability facts this run would otherwise have to guess at: any iframe or
   * frame in the visible tree, and an exhausted scan budget. Neither is
   * re-checked here, because a second check would be a second authority.
   */
  'PILOT_DISCOVERY_UNAVAILABLE',
  /** The scan pruned a subtree it could not prove control-free: no sidecar. */
  'PILOT_UA5_STRUCTURE_UNAVAILABLE',
  /** Questions proven present but never given an identity: the denominator is short. */
  'PILOT_UA5_HIDDEN_QUESTIONS_UNOBSERVED',
  'PILOT_UA5_COMPOSITION_UNAVAILABLE',
  'PILOT_UA5_WRITER_UNAVAILABLE',
] as const;
export type PilotUa5RunFailureCode = (typeof PILOT_UA5_RUN_FAILURE_CODES)[number];

/** Value-free progress. Counts and closed states only; never a value or a label. */
export type PilotUa5ProgressEvent =
  | Readonly<{ phase: 'OBSERVED'; observedControls: number }>
  | Readonly<{ phase: 'COMPOSED'; observableQuestions: number; authorizedQuestions: number }>
  | Readonly<{ phase: 'SETTLED'; requiredCompleted: number; requiredQuestions: number }>;

export type PilotUa5RunResult =
  | Readonly<{ ok: true; projection: PilotUa5RunProjection }>
  | Readonly<{ ok: false; code: PilotUa5RunFailureCode }>;

const terminalLedgers = new WeakMap<object, PilotUa4TerminalLedger>();

/**
 * Content-realm checkpoint handoff for an exact successful run. Neither the
 * result wire nor its UI projection carries a ledger; copied result objects
 * cannot recreate this association. History consumers still parse canonical
 * UA-4 facts and bind them to their own current UA-1 observation.
 */
export function readPilotUa5TerminalLedger(result: PilotUa5RunResult): PilotUa4TerminalLedger | null {
  return terminalLedgers.get(result) ?? null;
}

export type PilotUa5OrchestratorPolicy = Readonly<{ enabled: boolean }>;

export type PilotUa5OrchestratorPorts = Readonly<{
  /**
   * The certified UA-1 runtime's own observation, unchanged: the packet with its
   * drop accounting, and the StructureSidecarV1 its producer emits only when the
   * scan proved it counted the whole document. There is no second observation
   * shape here, so no accounting fact can be restated or defaulted on the way in.
   * Null when the runtime could not observe at all.
   */
  observe: () => Promise<PilotUa1Observation | null>;
  /** Authenticated composition call; the orchestrator never talks to a rung directly. */
  compose: (request: unknown) => Promise<PilotUa5CompositionResponse>;
  /** The sole UA-4 composition port. */
  writer: PilotUa4WriterRuntime;
  /**
   * Optional content-local lookup for the opaque payload handle bound by the
   * authenticated Profile material plane. The resolver sees only the UA-4
   * question id and answer digest; the raw value remains owned by the leaf
   * session and never enters this orchestrator or its progress projection.
   *
   * Omitted for value-free certification fixtures, which retain the original
   * deterministic local handle. A present resolver must positively return one
   * safe handle for every authorization or the run stops before UA-4.
   */
  resolvePayloadRef?: (authorization: Readonly<{
    questionId: string;
    answerDigest: string;
  }>) => string | null;
  /** Injected so the kernel boundary stays deterministic and testable. */
  semanticDigest: (...parts: readonly string[]) => string;
  now: () => number;
  onProgress?: (event: PilotUa5ProgressEvent) => void;
}>;

const failure = (code: PilotUa5RunFailureCode): PilotUa5RunResult =>
  Object.freeze({ ok: false, code });

/**
 * Runs the chain once for the page the user is on. `userTriggered` is not a
 * parameter with a default: a run that cannot prove a user asked for it stops.
 */
export async function runPilotUa5CurrentPage(
  policy: PilotUa5OrchestratorPolicy,
  ports: PilotUa5OrchestratorPorts,
  userTriggered: boolean,
): Promise<PilotUa5RunResult> {
  if (!policy.enabled) return failure('PILOT_CAPABILITY_DISABLED');
  if (userTriggered !== true) return failure('PILOT_NOT_USER_TRIGGERED');

  let observation: PilotUa1Observation | null;
  try {
    observation = await ports.observe();
  } catch {
    observation = null;
  }
  if (!observation) return failure('PILOT_DISCOVERY_UNAVAILABLE');
  const discovery = observation.packet;
  const structure = observation.structure;
  // Without a sidecar the scan could not prove it counted the whole document,
  // so the ledger's denominator would be a floor posing as a total.
  if (structure === null) return failure('PILOT_UA5_STRUCTURE_UNAVAILABLE');
  // Questions the scan proved were there but could never name. They have no
  // identity, so no ledger row can exist for them and no DISCOVERY_INCOMPLETE
  // disposition can be attached to anything -- the ledger has no way to say
  // "and some more". Claiming a complete denominator over them would be the
  // fabrication this run exists to avoid, so the run stops instead.
  if (discovery.observation.hiddenNotObservedCount > 0) {
    return failure('PILOT_UA5_HIDDEN_QUESTIONS_UNOBSERVED');
  }
  // Frames the scan reached but could not see into. Unlike a hidden native,
  // each one HAS an identity, so the ledger can carry it in its own
  // unobserved-regions section -- never as a question -- and the run may
  // continue over the questions it did observe, without ever claiming the
  // page is complete. The reason is neutral: the scan checked nothing about
  // the frame's origin and asserts nothing about it.
  const opaqueBoundaries = discovery.observation.opaqueBoundaries;
  ports.onProgress?.(Object.freeze({
    phase: 'OBSERVED', observedControls: discovery.controls.length,
  }));

  let composed: PilotUa5CompositionResponse;
  try {
    composed = await ports.compose(Object.freeze({
      schemaVersion: 1,
      trigger: PILOT_UA5_TRIGGER,
      discovery,
      structure,
    }));
  } catch {
    return failure('PILOT_UA5_COMPOSITION_UNAVAILABLE');
  }
  if (!composed.ok) return failure('PILOT_UA5_COMPOSITION_UNAVAILABLE');
  ports.onProgress?.(Object.freeze({
    phase: 'COMPOSED',
    observableQuestions: composed.projection.summary.observableQuestions,
    authorizedQuestions: composed.projection.summary.authorizedQuestions,
  }));

  const classifications: readonly PilotUa2Classification[] = composed.candidateRule.classifications;
  const payloadRefs: Array<Readonly<{ questionId: string; payloadRef: string }>> = [];
  try {
    for (const entry of composed.authority.questionAuthorizations) {
      const payloadRef = ports.resolvePayloadRef === undefined
        ? `local.answer.${entry.questionId.slice(0, 32)}`
        : ports.resolvePayloadRef(Object.freeze({
            questionId: entry.questionId,
            answerDigest: entry.answerDigest,
          }));
      if (typeof payloadRef !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(payloadRef)) {
        return failure('PILOT_UA5_WRITER_UNAVAILABLE');
      }
      payloadRefs.push(Object.freeze({ questionId: entry.questionId, payloadRef }));
    }
  } catch {
    return failure('PILOT_UA5_WRITER_UNAVAILABLE');
  }
  let written: PilotUa4WriterRuntimeResult;
  try {
    written = await ports.writer.execute(Object.freeze({
      authority: composed.authority,
      currentBinding: discovery.binding,
      currentControlIdentityDigests: discovery.controls.map((control) => control.identityDigest),
      nowMs: ports.now(),
      semanticEpochs: [Object.freeze({
        cause: 'USER_TRIGGER' as const,
        binding: discovery.binding,
        controls: discovery.controls,
        // The producer's own sidecar, so grouping and cross-epoch identity rest
        // on exact evidence rather than on legends and a DOM address. The
        // compiler re-checks that it binds to this exact packet and states this
        // packet's accounting, and fails closed if it does not.
        structure,
        suppressedControls: discovery.observation.suppressedControls,
        hiddenNotObservedCount: discovery.observation.hiddenNotObservedCount,
        attributedAddRowGroup: null,
      })],
      ua2Classifications: classifications,
      semanticDigest: ports.semanticDigest,
      // A page-local handle, never the answer. Connected-dev resolves it from
      // the exact Profile/answer-digest binding; certification fixtures retain
      // the deterministic value-free fallback above.
      payloadRefs: Object.freeze(payloadRefs),
      // Derived from the producer's proof, never asserted: a sidecar exists only
      // when the scan proved it counted the document, and a run that could not
      // prove it has already returned above; an opaque boundary means part of
      // the page was never observed at all. Scoped to this binding -- multi-step
      // coverage is CAP-AF-039 and is not claimed here.
      discoveryComplete: structure !== null && opaqueBoundaries.length === 0,
      // One unobserved region per frame the scan reached but could not observe
      // into, expressed apart from the questions. The ledger's own invariant
      // (discoveryComplete ⇔ no incomplete question and no unobserved region)
      // then holds, and no "and some more" is left implicit.
      unobservedRegions: opaqueBoundaries.map((regionId) => Object.freeze({
        regionId,
        reason: 'FRAME_NOT_OBSERVED' as const,
      })),
      // Empty on purpose. Every question is either authorized, blocked with a
      // named reason, or given a terminal from its classification -- all three
      // by UA-4, from the one Profile snapshot it resolved. A terminal minted
      // out here would be a second opinion about the same question, and a
      // duplicate row the ledger would refuse outright.
      preResolvedDispositions: Object.freeze([]),
    }));
  } catch {
    return failure('PILOT_UA5_WRITER_UNAVAILABLE');
  }
  if (!written.ok) return failure('PILOT_UA5_WRITER_UNAVAILABLE');

  const projection = projectRun(written.value);
  ports.onProgress?.(Object.freeze({
    phase: 'SETTLED',
    requiredCompleted: projection.summary.requiredCompleted,
    requiredQuestions: projection.summary.requiredQuestions,
  }));
  const result = Object.freeze({ ok: true as const, projection });
  terminalLedgers.set(result, written.value);
  return result;
}

/**
 * Projects the UA-4 terminal ledger for the product panel: one state per logical
 * question and a required-completion count. It reads the ledger and adds no
 * judgement — the ledger's own parser already guarantees exactly one terminal
 * per question, so a question can neither vanish nor appear twice here.
 */
export function projectRun(ledger: PilotUa4TerminalLedger): PilotUa5RunProjection {
  const requiredById = new Map(ledger.questions.map((question) => [question.questionId, question.required]));
  const rows: PilotUa5RunRow[] = ledger.dispositions.map((entry) => Object.freeze({
    questionId: entry.questionId,
    required: requiredById.get(entry.questionId) ?? false,
    state: entry.disposition.state,
    reason: reasonOf(entry.disposition),
    ...(entry.disposition.state === 'POLICY_BLOCKED' && entry.disposition.writeEffect
      ? { writeEffect: entry.disposition.writeEffect } : {}),
  }));
  const requiredQuestions = rows.filter((row) => row.required).length;
  const requiredCompleted = rows.filter(
    (row) => row.required && PILOT_UA5_COMPLETED_STATES.includes(row.state),
  ).length;
  return Object.freeze({
    schemaVersion: PILOT_UA5_RUN_PROJECTION_SCHEMA_VERSION,
    binding: ledger.binding,
    discoveryComplete: ledger.discoveryComplete,
    rows: Object.freeze(rows),
    // Carried through unchanged so the panel can say what was not observed
    // instead of presenting the observed questions as the whole page.
    unobservedRegions: ledger.unobservedRegions,
    summary: Object.freeze({
      observableQuestions: rows.length,
      requiredQuestions,
      requiredCompleted,
      terminalQuestions: rows.length,
      unobservedRegions: ledger.unobservedRegions.length,
    }),
  });
}

function reasonOf(disposition: PilotUa4FinalDisposition): string | null {
  if ('reason' in disposition) return disposition.reason;
  if (disposition.state === 'DISCOVERY_INCOMPLETE') return disposition.reachability;
  return null;
}
