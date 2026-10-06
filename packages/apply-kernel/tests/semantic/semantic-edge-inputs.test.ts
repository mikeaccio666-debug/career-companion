/**
 * Edge and adversarial inputs for the Semantic Compiler (S1).
 *
 * The vectors pin what the compiler produces from well-formed pages. These pin
 * what it does with input it cannot account for: an empty chain, a packet that
 * repeats an address, a sidecar describing a control that is not there, a
 * member pointing at a parent that is not a group. Each must either fail closed
 * with a stable reason or place every observation — never quietly drop one.
 *
 * The last two pin the kernel boundary itself: pure (no input mutation) and
 * deterministic (RULE-KERNEL-DETERMINISTIC-BOUNDARY).
 */

import { describe, expect, it } from 'vitest';
import { compileGraph, packetDigestOf, SEMANTIC_COMPILER_VERSION, type EpochInput } from '../../src/semantic/graph.ts';
import { sha256, d } from './harness.ts';

const ctl = (ref: string, o: Partial<EpochInput['controls'][number]> = {}) => ({
  identityDigest: d(ref), role: 'textbox' as const, inputType: 'text' as const, autocomplete: [],
  required: false, accessibleName: ref, label: ref, legend: null, options: [], fileAccept: null, ...o,
});
const base = { groupKeyDigest: null, memberOfGroupControl: null, placeholderShape: null, optionsOverflow: false, placeholderOptionIndexes: [], disabled: false, readOnly: false, multiple: false, row: null } as const;
const epoch = (controls: any[], entries: any[] | null, extra: Partial<EpochInput> = {}): EpochInput => ({
  cause: 'USER_TRIGGER', binding: { origin: 'https://x.invalid', pathname: '/a', domGeneration: sha256('gen', 'g0') },
  controls, structure: entries === null ? null : {
    schemaVersion: 1, packetDigest: packetDigestOf(controls, sha256), epochIndex: 0,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    counts: { controls: controls.length, entries: entries.length, suppressed: 0, hiddenNotObserved: 0 }, entries,
  }, suppressedControls: [], hiddenNotObservedCount: 0, attributedAddRowGroup: null, ...extra,
});

describe('edge inputs', () => {
  it('empty epoch list fails closed', () => {
    const r = compileGraph([], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EPOCH_CHAIN_BROKEN');
  });

  it('an epoch with zero controls compiles to an empty graph', () => {
    const r = compileGraph([epoch([], [])], sha256);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.nodes).toHaveLength(0);
  });

  it('the same identityDigest twice in one packet loses no observation: the second is unplaced', () => {
    const c = ctl('dup');
    // One sidecar entry, two packet positions: the sidecar itself is well formed,
    // so this exercises observation totality rather than the binding.
    const r = compileGraph([epoch([c, c], [{ ...base, identityDigest: d('dup'), elementToken: d('el:dup'), documentOrder: 0 }])], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('UNPLACED_OBSERVATION');
      expect(r.unplaced).toContain(d('dup'));
    }
  });

  it('two sidecar entries for one control are contradictory evidence, not a last-write-wins merge', () => {
    const c = ctl('dup');
    const e = epoch([c], [{ ...base, identityDigest: d('dup'), elementToken: d('el:dup'), documentOrder: 0 }]);
    const doubled = { ...e, structure: { ...e.structure!, entries: [...e.structure!.entries, e.structure!.entries[0]!] } };
    const r = compileGraph([{ ...doubled, structure: { ...doubled.structure, counts: { ...doubled.structure.counts, entries: 2 } } }], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIDECAR_MISMATCH');
  });

  it('a generation the chain has already seen is not a new observation', () => {
    const gen = (g: string) => ({ origin: 'https://x.invalid', pathname: '/a', domGeneration: sha256('gen', g) });
    const one = epoch([ctl('a')], [{ ...base, identityDigest: d('a'), elementToken: d('el:a'), documentOrder: 0 }]);
    const at = (g: string, k: number) => ({
      ...one, binding: gen(g),
      structure: { ...one.structure!, epochIndex: k },
    });
    const r = compileGraph([at('gA', 0), at('gB', 1), at('gA', 2)], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EPOCH_CHAIN_BROKEN');
  });

  it('a control that is both emitted and suppressed reaches one node, or none', () => {
    const c = ctl('both');
    const e = epoch([c], [{ ...base, identityDigest: d('both'), elementToken: d('el:both'), documentOrder: 0 }], { suppressedControls: [d('both')] });
    const r = compileGraph([{ ...e, structure: { ...e.structure!, counts: { ...e.structure!.counts, suppressed: 1 } } }], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MEMBER_IN_TWO_CONTROLS');
  });

  it('a sidecar entry for a control that is not in the packet fails closed', () => {
    const controls = [ctl('a')];
    const entries = [
      { ...base, identityDigest: d('a'), elementToken: d('el:a'), documentOrder: 0 },
      { ...base, identityDigest: d('ghost'), elementToken: d('el:ghost'), documentOrder: 1 },
    ];
    const e = epoch(controls, entries);
    const r = compileGraph([{ ...e, structure: { ...e.structure!, counts: { ...e.structure!.counts, entries: 2 } } }], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIDECAR_MISMATCH');
  });

  it('memberOf pointing at a control that is not a radiogroup does not swallow the member', () => {
    const controls = [ctl('text1'), ctl('r1', { inputType: 'radio', role: 'radio' })];
    const entries = [
      { ...base, identityDigest: d('text1'), elementToken: d('el:text1'), documentOrder: 0 },
      { ...base, identityDigest: d('r1'), elementToken: d('el:r1'), documentOrder: 1, memberOfGroupControl: d('text1') },
    ];
    const r = compileGraph([epoch(controls, entries)], sha256);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(2);
      expect(Object.keys(r.graph.observationIndex)).toHaveLength(2);
    }
  });

  it('row evidence that contradicts itself inside one epoch fails closed', () => {
    const controls = [ctl('a'), ctl('b')];
    const row = (ordinal: number, shape: string) => ({ rowGroupDigest: d('rg'), ordinal, shapeDigest: d(shape), rowElementToken: d('slot') });
    const entries = [
      { ...base, identityDigest: d('a'), elementToken: d('el:a'), documentOrder: 0, row: row(0, 'S1') },
      { ...base, identityDigest: d('b'), elementToken: d('el:b'), documentOrder: 1, row: row(7, 'S2') },
    ];
    const r = compileGraph([epoch(controls, entries)], sha256);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIDECAR_MISMATCH');
  });

  it('a colliding injected digest cannot merge two controls into one node', () => {
    // The digest is a caller-supplied dependency. A weak one would give two
    // distinct controls the same logical id, and they would share a node while
    // every totality count still balanced.
    const constant = () => 'c'.repeat(64);
    const controls = [ctl('a'), ctl('b')];
    const entries = controls.map((c, i) => ({ ...base, identityDigest: c.identityDigest, elementToken: sha256('el', String(i)), documentOrder: i }));
    const e = epoch(controls, entries);
    const r = compileGraph([{ ...e, structure: { ...e.structure!, packetDigest: packetDigestOf(controls, constant) }, binding: { ...e.binding, domGeneration: constant() } }], constant);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVARIANT_VIOLATION');
  });

  it('does not mutate its inputs', () => {
    const controls = [ctl('a')];
    const entries = [{ ...base, identityDigest: d('a'), elementToken: d('el:a'), documentOrder: 0 }];
    const input = epoch(controls, entries);
    const snapshot = JSON.stringify(input);
    compileGraph([input], sha256);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is deterministic across runs', () => {
    const controls = [ctl('a'), ctl('b'), ctl('c')];
    const entries = controls.map((c, i) => ({ ...base, identityDigest: c.identityDigest, elementToken: sha256('el', String(i)), documentOrder: i }));
    const one = compileGraph([epoch(controls, entries)], sha256);
    const two = compileGraph([epoch(controls, entries)], sha256);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
