/**
 * Boundary guard for the Semantic Compiler (S1).
 *
 * Ruling 2026-09-02 (Mike): this compiler produces structural facts only. The
 * UA-4 audit/receipt lane is the single terminal owner, and S1 must not claim
 * the chain is complete.
 *
 * The risk this file guards is regrowth: the deleted first version of S1 had
 * grown its own answer authority, eligibility reasons, terminal dispositions,
 * coverage math and Undo availability. A prose rule does not stop that coming
 * back one convenient field at a time, so the boundary is asserted mechanically
 * over the module's whole exported surface.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SEMANTIC_COMPILER_TERMINAL_CONSUMER } from '../../src/semantic/ir.ts';

const SOURCES = ['ir', 'grouping', 'graph', 'classify', 'invariants'] as const;

/**
 * Read the exported NAMES out of the source, not the runtime module. The IR is
 * almost entirely types: a runtime key list sees the closed-set arrays and
 * nothing else, so `export interface DispositionLedger` would be invisible to
 * this guard — and a type is exactly how the authority would grow back.
 */
function exportedNames(): { module: string; name: string }[] {
  const out: { module: string; name: string }[] = [];
  for (const module of SOURCES) {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'semantic', `${module}.ts`), 'utf8');
    for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|const|let|function|class|enum)\s+(\w+)/gm)) {
      out.push({ module, name: m[1]! });
    }
  }
  return out;
}

/** Concepts that belong to an owner outside this module. */
const FOREIGN = [
  /terminal/i,
  /ledger/i,
  /disposition/i,
  /eligib/i,
  /coverage/i,
  /undo/i,
  /authority$/i,
  /answer/i,
  /profile/i,
  /audit/i,
  /^PILOT_/,
];

describe('semantic compiler · boundary', () => {
  it('finds the exports it is supposed to police', () => {
    const names = exportedNames();
    // A guard that reads nothing passes everything.
    expect(names.length).toBeGreaterThan(30);
    expect(names.map((x) => x.name)).toContain('QuestionGraph');
    expect(names.map((x) => x.name)).toContain('LogicalControl');
  });

  it('exports nothing that names a terminal, ledger, eligibility, coverage or answer-authority concept', () => {
    const offenders = exportedNames()
      // The one deliberate exception: the marker that says who DOES own terminals.
      .filter(({ name }) => name !== 'SEMANTIC_COMPILER_TERMINAL_CONSUMER')
      .filter(({ name }) => FOREIGN.some((re) => re.test(name)))
      .map(({ module, name }) => `${module}.${name}`);
    expect(offenders).toEqual([]);
  });

  it('declares that a terminal consumer is still pending, and never that the chain is complete', () => {
    expect(SEMANTIC_COMPILER_TERMINAL_CONSUMER).toBe('PENDING_UA4_TERMINAL_CONSUMER');
  });

  it('grants no writer: nothing in the compiled output says how to write a control', () => {
    const offenders = exportedNames()
      .filter(({ name }) => /write|writer|submit|click|grant|capability/i.test(name))
      .map(({ module, name }) => `${module}.${name}`);
    expect(offenders).toEqual([]);
  });
});
