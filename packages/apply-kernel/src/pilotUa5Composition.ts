/**
 * UA-5 composition port (kernel side).
 *
 * Derives the authority-shaped questions for one observed page from #164's
 * compiler, so an authenticated backend can issue a UA-4 write authority
 * without inventing question ids or restating any rule. It adds no compiler and
 * no second mapping: `compileGraph`, `classifyQuestions` and the one shared
 * `writerKind` mapping are called, never reimplemented. It imports no writer,
 * so a backend consuming this port never pulls browser-side kernel code.
 *
 * Pure. No DOM, no network, no vendor knowledge, no values: the output carries
 * digests, ordinals, booleans and closed sets only.
 */

import type { PilotUa2Classification } from '@edaix/contracts/draft';
import type { PilotUa4ControlKind } from '@edaix/contracts/draft/pilot-ua4-write-authority';
import { classificationTerminalDisposition, writerKind } from './semantic/writerKind.ts';
import { classifyQuestions } from './semantic/classify.ts';
import { compileGraph, type EpochInput } from './semantic/graph.ts';
import type { Digest } from './semantic/grouping.ts';
import type { CompileIncompleteReason, QuestionNode } from './semantic/ir.ts';

/** One logical question, as UA-4's authority request needs to see it. */
export type PilotUa5DerivedQuestion = Readonly<{
  questionId: string;
  /** Null when no writer can ever take this question; it still needs a terminal. */
  controlKind: PilotUa4ControlKind | null;
  identityDigests: readonly string[];
  required: boolean;
  optionsIncomplete: boolean;
  /**
   * True when this question's terminal depends on an authority rather than on
   * its classification: UA-4's prepare step mints nothing for it and asks no
   * host to execute it, so an unauthorized one leaves the ledger a row short
   * unless the run supplies its terminal.
   */
  awaitsAuthority: boolean;
}>;

export type PilotUa5DerivationResult =
  | Readonly<{ ok: true; questions: readonly PilotUa5DerivedQuestion[] }>
  | Readonly<{ ok: false; reason: CompileIncompleteReason }>;

/**
 * Compiles the observed epochs and returns the questions that exist on the page
 * as last observed. A question absent from the final epoch is not on the page
 * any more and is deliberately not offered for authority.
 */
export function derivePilotUa5Questions(
  epochs: readonly EpochInput[],
  ua2Classifications: readonly PilotUa2Classification[],
  digest: Digest,
): PilotUa5DerivationResult {
  const compiled = compileGraph(epochs, digest);
  if (!compiled.ok) return Object.freeze({ ok: false, reason: compiled.reason });
  const graph = compiled.graph;
  const finalEpochIndex = graph.epochs.length - 1;
  const byDigest = new Map<string, PilotUa2Classification>();
  for (const classification of ua2Classifications) {
    if (byDigest.has(classification.identityDigest)) {
      return Object.freeze({ ok: false, reason: 'UNPLACED_OBSERVATION' });
    }
    byDigest.set(classification.identityDigest, classification);
  }
  const classifications = new Map(
    classifyQuestions(graph, byDigest).map((entry) => [entry.nodeId, entry]),
  );
  const questions = graph.nodes
    .filter((node): node is QuestionNode => node.kind === 'QUESTION' && node.lastObservedEpoch === finalEpochIndex)
    .map((node) => {
      const classification = classifications.get(node.id) ?? null;
      const controlKind = writerKind(node.control.kind);
      // Asked of the writer's own rule, not restated here: a question UA-2 could
      // not resolve, whose members disagree, or that no writer of this kind may
      // take, already has a terminal from its classification.
      const awaitsAuthority =
        classificationTerminalDisposition(classification, controlKind) === null;
      return Object.freeze({
        questionId: node.id,
        controlKind,
        identityDigests: Object.freeze(node.control.members.map((member) => member.identityDigest)),
        required: node.required,
        optionsIncomplete: node.control.optionsIncomplete,
        awaitsAuthority,
      });
    });
  return Object.freeze({ ok: true, questions: Object.freeze(questions) });
}
