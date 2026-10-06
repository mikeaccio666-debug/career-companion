/**
 * Semantic Compiler conformance vectors (S1).
 *
 * One `it` per vector in ./vectors. Each vector is a value-free page fixture
 * plus the graph the compiler must produce from it, including the scenarios
 * that break today: proxy/native pairs, radio and checkbox groups, ARIA
 * radiogroups, contenteditable, dates, files, repeated rows, row id reuse,
 * revealed controls and same-URL injection.
 *
 * A vector that fails here is a real regression in observation conservation,
 * never a fixture drift.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runVector, type Vector } from './harness.ts';

const DIR = join(__dirname, 'vectors');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('semantic compiler · conformance vectors', () => {
  it('covers every scenario class the pilot has to survive', () => {
    const classes = new Set(files.map((f) => (JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Vector).scenarioClass));
    expect([...classes].sort()).toEqual([
      'classification-merge',
      'contenteditable',
      'date',
      'dynamic-dependency',
      'proxy-native',
      'radio-checkbox-group',
      'repeated-rows',
      'row-id-reuse',
      'same-url-injection',
    ]);
  });

  for (const file of files) {
    const vector = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Vector;
    it(`${vector.id} · ${vector.scenarioClass} · ${vector.title}`, () => {
      expect(runVector(vector)).toEqual([]);
    });
  }
});
