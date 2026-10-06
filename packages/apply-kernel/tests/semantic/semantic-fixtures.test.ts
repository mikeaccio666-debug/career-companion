/**
 * Tests for the fixture scaffolding itself.
 *
 * Vectors may say what CHANGED between epochs instead of restating the whole
 * packet, and may name a shared shape or option list instead of repeating it.
 * That scaffolding sits between the corpus and the compiler, so it needs its own
 * regression tests: a delta that quietly expanded to the wrong packet would make
 * every vector that uses it assert the wrong thing while still passing.
 */

import { describe, expect, it } from 'vitest';

import { OPTION_PRESETS, SHAPES, compiledEpochs, expandEpochs, type Vector } from './harness.ts';

const BASE = {
  scenarioClass: 'repeated-rows',
  title: 't',
  todayBehavior: 'b',
} as const;

const epoch0 = {
  cause: 'USER_TRIGGER',
  domGeneration: 'g0',
  controls: [
    { ref: 'a', shape: 'TEXT', label: 'Company', required: true, row: { group: 'exp', ordinal: 0, shape: 'exp', element: 'E1' } },
    { ref: 'b', shape: 'TEXT', label: 'Company', required: true, row: { group: 'exp', ordinal: 1, shape: 'exp', element: 'E2' } },
  ],
  ua2: { a: { kind: 'CANONICAL_FIELD', canonicalField: 'ORGANIZATION' }, b: { kind: 'CANONICAL_FIELD', canonicalField: 'ORGANIZATION' } },
} as const;

const vector = (epochs: unknown[]): Vector =>
  ({ ...BASE, id: 'fixture', epochs, expected: {} } as unknown as Vector);

describe('fixture scaffolding · shape and option presets', () => {
  it('expands to the exact pair a vector would otherwise restate', () => {
    const [e] = expandEpochs(vector([{ ...epoch0, controls: [{ ref: 'x', shape: 'EMAIL', optionsPreset: 'NO_YES' }], ua2: {} }]));
    expect(e!.controls[0]).toMatchObject({ ...SHAPES.EMAIL, ref: 'x', options: [...OPTION_PRESETS.NO_YES] });
  });

  it('lets an explicit field win over the preset', () => {
    const [e] = expandEpochs(vector([{ ...epoch0, controls: [{ ref: 'x', shape: 'TEXT', role: 'searchbox', options: ['only'] , optionsPreset: 'NO_YES' }], ua2: {} }]));
    expect(e!.controls[0]).toMatchObject({ role: 'searchbox', inputType: 'text', options: ['only'] });
  });
});

describe('fixture scaffolding · epoch deltas', () => {
  it('a delta and its fully explicit twin feed the compiler the same input', () => {
    const withDelta = vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1',
        delta: { inherit: true, remove: ['b'], add: [{ ref: 'c', shape: 'TEXT', label: 'Title' }] },
        ua2: { c: { kind: 'CANONICAL_FIELD', canonicalField: 'JOB_TITLE' } } },
    ]);
    const explicit = vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1',
        controls: [epoch0.controls[0], { ref: 'c', shape: 'TEXT', label: 'Title' }],
        ua2: { a: epoch0.ua2.a, c: { kind: 'CANONICAL_FIELD', canonicalField: 'JOB_TITLE' } } },
    ]);
    expect(compiledEpochs(withDelta)).toEqual(compiledEpochs(explicit));
  });

  it('inserts before patching, so every ref names the previous epoch', () => {
    const [, e1] = expandEpochs(vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1',
        delta: {
          inherit: true,
          insertBefore: { ref: 'b', controls: [{ ref: 'banner', shape: 'TEXT' }] },
          patch: { b: { ref: 'b_shifted', element: 'b' } },
        } },
    ]));
    expect(e1!.controls.map((c) => c.ref)).toEqual(['a', 'banner', 'b_shifted']);
  });

  it('carries an inherited classification through a rename and drops it on removal', () => {
    const [, e1] = expandEpochs(vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1',
        delta: { inherit: true, remove: ['a'], patch: { b: { ref: 'b_shifted', element: 'b' } } } },
    ]));
    expect(Object.keys(e1!.ua2)).toEqual(['b_shifted']);
  });

  it('refuses a rename that does not say whether the element is the same', () => {
    expect(() => expandEpochs(vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1', delta: { inherit: true, patch: { b: { ref: 'b_shifted' } } } },
    ]))).toThrow(/without stating element/);
  });

  it('refuses an epoch that both lists controls and inherits them', () => {
    expect(() => expandEpochs(vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1', controls: [], delta: { inherit: true } },
    ]))).toThrow(/exactly one of controls or delta/);
  });

  it('refuses a first epoch that inherits from nothing', () => {
    expect(() => expandEpochs(vector([
      { cause: 'USER_TRIGGER', domGeneration: 'g0', delta: { inherit: true } },
    ]))).toThrow(/first epoch cannot inherit/);
  });

  it('refuses a delta that edits a control the previous epoch did not have', () => {
    expect(() => expandEpochs(vector([
      epoch0,
      { cause: 'HOST_MUTATION_RESCAN', domGeneration: 'g1', delta: { inherit: true, patch: { ghost: { label: 'x' } } } },
    ]))).toThrow(/patches unknown control/);
  });
});
