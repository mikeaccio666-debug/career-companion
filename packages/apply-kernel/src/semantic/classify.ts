/**
 * L3 · UA-2 per-control classification → per-question classification.
 *
 * UA-2 answers "what is this control?" once per control. A question rendered as
 * three radios therefore gets three answers, and someone has to merge them.
 * That merge is the only thing this module does.
 *
 * It never promotes an inference to a fact, never maps a canonical field to a
 * profile concept (T3 owns that), and never decides eligibility.
 */

import type { PilotUa2Classification } from '@edaix/contracts/draft';
import { isJobDependentField, isOtherPersonField, isPhoneMetaField } from '../dict/guards.ts';
import type {
  ClassificationMergeOutcome,
  Digest64,
  QuestionClassification,
  QuestionGraph,
  StemGuard,
} from './ir.ts';

const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function classifyQuestions(
  graph: QuestionGraph,
  ua2ByDigest: ReadonlyMap<Digest64, PilotUa2Classification>,
): readonly QuestionClassification[] {
  // Two root-scope questions with the same stem and no row evidence cannot both
  // take the same answer, and nothing value-free says which is which.
  //
  // Co-presence is per epoch. One question re-observed at a shifted UA-1 address
  // is still one question: counting across the whole chain would flag a page
  // with a single Company field as ambiguous with itself.
  const nodesPerEpoch = new Map<number, Set<Digest64>>();
  for (const [key, lc] of Object.entries(graph.observationIndex)) {
    const epoch = Number(key.slice(0, key.indexOf(':')));
    const nodeId = graph.controlIndex[lc];
    if (nodeId === undefined) continue;
    const set = nodesPerEpoch.get(epoch) ?? new Set<Digest64>();
    set.add(nodeId);
    nodesPerEpoch.set(epoch, set);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const duplicateStems = new Set<Digest64>();
  for (const ids of nodesPerEpoch.values()) {
    const tally = new Map<Digest64, number>();
    for (const id of ids) {
      const n = byId.get(id);
      if (n?.kind === 'QUESTION' && n.rowToken === null) tally.set(n.stemDigest, (tally.get(n.stemDigest) ?? 0) + 1);
    }
    for (const [stem, count] of tally) if (count > 1) duplicateStems.add(stem);
  }

  const out: QuestionClassification[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'QUESTION') continue;
    const stem = node.control.legend ?? node.control.label ?? node.control.accessibleName ?? '';
    const members = node.control.members.map((m) => ua2ByDigest.get(m.identityDigest) ?? null);
    const present = members.filter((m): m is PilotUa2Classification => m !== null);

    let merge: ClassificationMergeOutcome;
    if (present.length !== members.length) merge = 'MEMBER_UNCLASSIFIED';
    else if (present.length === 1) merge = 'SINGLE';
    // Members agree only when they name the same thing. Same kind but different
    // canonical fields is a disagreement, and reporting it as agreement leaves
    // `canonicalField: null` as the only hint — indistinguishable from a group
    // nothing could resolve.
    else {
      merge = present.every((m) => m.kind === present[0]!.kind && m.canonicalField === present[0]!.canonicalField)
        ? 'MEMBERS_AGREE'
        : 'CLASSIFICATION_CONFLICT';
    }

    const kind = merge === 'CLASSIFICATION_CONFLICT' || present.length === 0 ? 'UNRESOLVED' : present[0]!.kind;
    const fields = new Set(present.map((m) => m.canonicalField));
    const canonicalField = merge === 'CLASSIFICATION_CONFLICT' || fields.size !== 1 ? null : present[0]!.canonicalField;
    const confidence = present.length === 0
      ? 'LOW'
      : present.reduce(
          (acc, m) => (CONFIDENCE_RANK[m.confidence] < CONFIDENCE_RANK[acc] ? m.confidence : acc),
          'HIGH' as PilotUa2Classification['confidence'],
        );

    // Negative tiers reuse the kernel's existing vendor-free dictionaries; this
    // module adds no new text knowledge of its own.
    const stemGuard: StemGuard = isOtherPersonField(stem)
      ? 'OTHER_PERSON'
      : isJobDependentField(stem)
        ? 'JOB_DEPENDENT'
        : canonicalField === 'PHONE' && isPhoneMetaField(stem)
          ? 'PHONE_META'
          : 'NONE';

    out.push({
      nodeId: node.id,
      stemGuard,
      assertion: 'INFERENCE',
      merge,
      members: present,
      kind,
      canonicalField,
      confidence,
      duplicateRootStem: node.rowToken === null && duplicateStems.has(node.stemDigest),
    });
  }
  return out;
}
