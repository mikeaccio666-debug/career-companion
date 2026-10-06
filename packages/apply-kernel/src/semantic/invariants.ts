/**
 * Conservation invariants (S1, kernel lane).
 *
 * Every check is total and pure. A violation names the invariant and the ids
 * involved, so a conformance vector or a mutation probe can assert on it
 * exactly. Four invariants, each with a probe: a checker nobody can break is a
 * checker that proves nothing.
 *
 * `compileGraph` runs this on its own output before returning, so a graph that
 * breaks conservation never reaches a consumer.
 */

import type { Digest64, QuestionClassification, QuestionGraph } from './ir.ts';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4';

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly message: string;
  readonly ids: readonly Digest64[];
}

export function checkInvariants(
  graph: QuestionGraph,
  classifications: readonly QuestionClassification[] = [],
): readonly InvariantViolation[] {
  const v: InvariantViolation[] = [];

  // I1 — every OBSERVATION of every epoch, emitted or suppressed, is placed in
  // one logical control that owns a node. Keyed by position, so two controls
  // sharing a UA-1 address are two observations and must both be placed.
  for (const e of graph.epochs) {
    const observations = [
      ...e.controls.map((c, i) => `${e.index}:c${i}:${c.identityDigest}`),
      ...e.suppressedControls.map((d, j) => `${e.index}:s${j}:${d}`),
    ];
    for (const key of observations) {
      const lc = graph.observationIndex[key];
      if (lc === undefined) v.push({ invariant: 'I1', message: 'observation not placed in any logical control', ids: [key] });
      else if (graph.controlIndex[lc] === undefined) v.push({ invariant: 'I1', message: 'placed control has no node', ids: [key, lc] });
    }
    const expected = e.controls.length + e.suppressedControls.length;
    const actual = Object.keys(graph.observationIndex).filter((k) => k.startsWith(`${e.index}:`)).length;
    if (actual !== expected) {
      v.push({ invariant: 'I1', message: `epoch ${e.index} has ${actual} index entries for ${expected} observations`, ids: [] });
    }
  }

  // I2 — every logical control in the observation index is owned by exactly one node.
  const owners = new Map<Digest64, Set<Digest64>>();
  for (const n of graph.nodes) {
    const set = owners.get(n.control.id) ?? new Set<Digest64>();
    set.add(n.id);
    owners.set(n.control.id, set);
  }
  for (const lc of new Set(Object.values(graph.observationIndex))) {
    const owned = owners.get(lc);
    if (!owned || owned.size === 0) v.push({ invariant: 'I2', message: 'logical control has no node', ids: [lc] });
    else if (owned.size > 1) v.push({ invariant: 'I2', message: 'logical control owned by two nodes', ids: [lc, ...owned] });
  }

  // I3 — incarnation tokens are unique, at most one incarnation is live per row
  // slot, and every node's row token resolves in the graph.
  const byToken = new Map<Digest64, number>();
  const liveBySlot = new Map<string, number>();
  for (const r of graph.rows) {
    byToken.set(r.token, (byToken.get(r.token) ?? 0) + 1);
    if (r.retiredAtEpoch !== null) continue;
    const slot = `${r.rowGroupDigest}:${r.rowElementToken}`;
    liveBySlot.set(slot, (liveBySlot.get(slot) ?? 0) + 1);
  }
  for (const [token, count] of byToken) {
    if (count > 1) v.push({ invariant: 'I3', message: 'two incarnations share a token', ids: [token] });
  }
  for (const [slot, count] of liveBySlot) {
    if (count > 1) v.push({ invariant: 'I3', message: 'two live incarnations occupy one row slot', ids: [slot] });
  }
  for (const n of graph.nodes) {
    if (n.rowToken !== null && !byToken.has(n.rowToken)) {
      v.push({ invariant: 'I3', message: 'node carries an incarnation the graph does not know', ids: [n.id, n.rowToken] });
    }
  }

  // I4 — a classification is an inference about exactly one QUESTION node.
  const questions = new Set(graph.nodes.filter((n) => n.kind === 'QUESTION').map((n) => n.id));
  const seen = new Set<Digest64>();
  for (const c of classifications) {
    if (!questions.has(c.nodeId)) v.push({ invariant: 'I4', message: 'classification attached to a non-question node', ids: [c.nodeId] });
    if (seen.has(c.nodeId)) v.push({ invariant: 'I4', message: 'node classified twice', ids: [c.nodeId] });
    seen.add(c.nodeId);
    if (c.assertion !== 'INFERENCE') v.push({ invariant: 'I4', message: 'classification recorded as a fact', ids: [c.nodeId] });
  }
  return v;
}
