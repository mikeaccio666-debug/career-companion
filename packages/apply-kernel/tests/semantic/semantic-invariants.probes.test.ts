/**
 * Mutation probes for the conservation invariants (S1).
 *
 * Each probe corrupts exactly one guarantee of a healthy graph and asserts the
 * checker raises the invariant that guards it. A probe that passes without a
 * violation proves the checker is vacuous for that guarantee.
 *
 * The second block proves the sidecar binding: every tamper class must fail
 * closed, because a sidecar that does not bind to its packet could regroup a
 * different page's controls.
 */

import { describe, expect, it } from 'vitest';

import { classifyQuestions } from '../../src/semantic/classify.ts';
import { SEMANTIC_COMPILER_VERSION, compileGraph, packetDigestOf, type EpochInput } from '../../src/semantic/graph.ts';
import { checkInvariants, type InvariantId } from '../../src/semantic/invariants.ts';
import type { QuestionClassification, QuestionGraph } from '../../src/semantic/ir.ts';
import { SIDECAR_TAMPERS, d, runVector, sha256, type SidecarTamper, type Vector } from './harness.ts';

interface Healthy {
  graph: QuestionGraph;
  classifications: readonly QuestionClassification[];
}

function healthy(): Healthy {
  const controls: EpochInput['controls'] = [
    { identityDigest: d('email'), role: 'textbox', inputType: 'email', autocomplete: ['email'], required: true, accessibleName: 'Email', label: 'Email', legend: null, options: [], fileAccept: null },
    { identityDigest: d('c1'), role: 'textbox', inputType: 'text', autocomplete: [], required: true, accessibleName: 'Company', label: 'Company', legend: null, options: [], fileAccept: null },
    { identityDigest: d('submit'), role: 'button', inputType: 'submit', autocomplete: [], required: false, accessibleName: 'Submit', label: null, legend: null, options: [], fileAccept: null },
  ];
  const base = {
    groupKeyDigest: null, memberOfGroupControl: null, placeholderShape: null,
    optionsOverflow: false, placeholderOptionIndexes: [], disabled: false, readOnly: false, multiple: false,
  } as const;
  const entries = [
    { ...base, identityDigest: d('email'), elementToken: d('el:email'), row: null, documentOrder: 0 },
    { ...base, identityDigest: d('c1'), elementToken: d('el:c1'), row: { rowGroupDigest: d('rowgroup:exp'), ordinal: 0, shapeDigest: d('shape:exp'), rowElementToken: d('rowel:E1') }, documentOrder: 1 },
    { ...base, identityDigest: d('submit'), elementToken: d('el:submit'), row: null, documentOrder: 2 },
  ];
  const input: EpochInput = {
    cause: 'USER_TRIGGER',
    binding: { origin: 'https://example.invalid', pathname: '/apply', domGeneration: sha256('gen', 'g0') },
    controls,
    structure: {
      schemaVersion: 1,
      packetDigest: packetDigestOf(controls, sha256),
      epochIndex: 0,
      compilerVersion: SEMANTIC_COMPILER_VERSION,
      counts: { controls: controls.length, entries: entries.length, suppressed: 1, hiddenNotObserved: 0 },
      entries,
    },
    suppressedControls: [d('hp')],
    hiddenNotObservedCount: 0,
    attributedAddRowGroup: null,
  };
  const compiled = compileGraph([input], sha256);
  if (!compiled.ok) throw new Error(`healthy input must compile: ${compiled.reason}`);
  const ua2 = new Map([
    [d('email'), { identityDigest: d('email'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'EMAIL' as const, confidence: 'HIGH' as const, provenance: { source: 'AUTOCOMPLETE' as const, semanticDigest: sha256('s', 'email') }, reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const }],
    [d('c1'), { identityDigest: d('c1'), kind: 'CANONICAL_FIELD' as const, canonicalField: 'ORGANIZATION' as const, confidence: 'HIGH' as const, provenance: { source: 'AUTOCOMPLETE' as const, semanticDigest: sha256('s', 'c1') }, reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH' as const }],
  ]);
  return { graph: compiled.graph, classifications: classifyQuestions(compiled.graph, ua2) };
}

type Probe = { name: string; expect: InvariantId; mutate: (h: Healthy) => Healthy };

const actionNode = (g: QuestionGraph) => g.nodes.find((n) => n.kind === 'ACTION')!;
const decoyNode = (g: QuestionGraph) => g.nodes.find((n) => n.kind === 'DECOY')!;

const PROBES: readonly Probe[] = [
  {
    name: 'forget an observed control entirely',
    expect: 'I1',
    mutate: (h) => {
      const observationIndex = { ...h.graph.observationIndex };
      delete observationIndex[`0:c0:${d('email')}`];
      return { ...h, graph: { ...h.graph, observationIndex } };
    },
  },
  {
    name: 'place a control in a logical control that no node owns',
    expect: 'I1',
    mutate: (h) => ({
      ...h,
      graph: { ...h.graph, observationIndex: { ...h.graph.observationIndex, [`0:c0:${d('email')}`]: sha256('logical', 'orphan') } },
    }),
  },
  {
    name: 'drop a suppressed honeypot from the observation index',
    expect: 'I1',
    mutate: (h) => {
      const observationIndex = { ...h.graph.observationIndex };
      delete observationIndex[`0:s0:${d('hp')}`];
      return { ...h, graph: { ...h.graph, observationIndex } };
    },
  },
  {
    name: 'let two nodes own the same logical control',
    expect: 'I2',
    mutate: (h) => {
      const twin = { ...decoyNode(h.graph), id: sha256('node', 'twin'), control: actionNode(h.graph).control };
      return { ...h, graph: { ...h.graph, nodes: [...h.graph.nodes, twin] } };
    },
  },
  {
    name: 'give two live rows the same incarnation token',
    expect: 'I3',
    mutate: (h) => ({
      ...h,
      graph: { ...h.graph, rows: [...h.graph.rows, { ...h.graph.rows[0]!, birthEpoch: 1 }] },
    }),
  },
  {
    name: 'point a node at an incarnation the graph does not know',
    expect: 'I3',
    mutate: (h) => ({
      ...h,
      graph: {
        ...h.graph,
        nodes: h.graph.nodes.map((n) => (n.rowToken ? { ...n, rowToken: sha256('incarnation', 'ghost') } : n)),
      },
    }),
  },
  {
    name: 'add an index entry for an observation the epoch never made',
    expect: 'I1',
    mutate: (h) => ({
      ...h,
      graph: {
        ...h.graph,
        observationIndex: { ...h.graph.observationIndex, [`0:c9:${sha256('ref', 'phantom')}`]: h.graph.nodes[0]!.control.id },
      },
    }),
  },
  {
    name: 'let two live incarnations occupy one row slot',
    expect: 'I3',
    mutate: (h) => ({
      ...h,
      graph: {
        ...h.graph,
        rows: [...h.graph.rows, { ...h.graph.rows[0]!, token: sha256('incarnation', 'second'), birthEpoch: 1 }],
      },
    }),
  },
  {
    name: 'drop an observation from the index without dropping its control',
    expect: 'I1',
    mutate: (h) => {
      const observationIndex = { ...h.graph.observationIndex };
      const key = Object.keys(observationIndex).find((k) => k.startsWith('0:c'))!;
      delete observationIndex[key];
      return { ...h, graph: { ...h.graph, observationIndex } };
    },
  },
  {
    name: 'classify a Submit button as a question',
    expect: 'I4',
    mutate: (h) => ({
      ...h,
      classifications: [...h.classifications, { ...h.classifications[0]!, nodeId: actionNode(h.graph).id }],
    }),
  },
  {
    name: 'classify one question twice',
    expect: 'I4',
    mutate: (h) => ({ ...h, classifications: [...h.classifications, h.classifications[0]!] }),
  },
  {
    name: 'record an inference as a fact',
    expect: 'I4',
    mutate: (h) => ({
      ...h,
      classifications: h.classifications.map((c, i) => (i === 0 ? { ...c, assertion: 'FACT' as unknown as 'INFERENCE' } : c)),
    }),
  },
];

describe('semantic compiler · invariant mutation probes', () => {
  it('healthy baseline raises no violation', () => {
    const base = healthy();
    expect(checkInvariants(base.graph, base.classifications)).toEqual([]);
  });

  for (const probe of PROBES) {
    it(`${probe.expect} · ${probe.name}`, () => {
      const mutated = probe.mutate(healthy());
      expect(checkInvariants(mutated.graph, mutated.classifications).map((v) => v.invariant)).toContain(probe.expect);
    });
  }
});

const TAMPER_VECTOR = (tamper: SidecarTamper): Vector => ({
  id: `sidecar-${tamper}`,
  scenarioClass: 'same-url-injection',
  title: `sidecar tamper ${tamper} fails closed`,
  todayBehavior: 'no binding exists today',
  epochs: [{
    cause: 'USER_TRIGGER',
    domGeneration: 'g0',
    sidecarTamper: tamper,
    controls: [
      { ref: 'a', inputType: 'radio', role: 'radio', label: 'Yes', legend: 'Remote?', groupKey: 'remote' },
      { ref: 'b', inputType: 'radio', role: 'radio', label: 'No', legend: 'Remote?', groupKey: 'remote' },
    ],
    ua2: { a: { kind: 'STRUCTURED_CHOICE' }, b: { kind: 'STRUCTURED_CHOICE' } },
  }],
  expected: { compile: 'COMPILE_INCOMPLETE', compileReason: 'SIDECAR_MISMATCH' },
});

describe('semantic compiler · sidecar binding', () => {
  // Per field, not per class: each bound field gets its own tamper, so removing
  // any single line of the binding turns this suite red.
  for (const tamper of SIDECAR_TAMPERS) {
    it(`rejects a sidecar with a tampered ${tamper}`, () => {
      expect(runVector(TAMPER_VECTOR(tamper))).toEqual([]);
    });
  }

  it('accepts the same fixture when the sidecar binds correctly', () => {
    const ok = { ...TAMPER_VECTOR('PACKET_DIGEST'), epochs: [{ ...TAMPER_VECTOR('PACKET_DIGEST').epochs[0]!, sidecarTamper: undefined }] };
    expect(runVector({
      ...ok,
      expected: {
        compile: 'OK',
        logicalControls: [{ kind: 'RADIO_GROUP', members: ['a', 'b'], grouping: 'SHARED_NAME' }],
        nodeCount: 1,
      },
    })).toEqual([]);
  });
});
