import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const applyRoot = resolve(root, 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * No owner approval exists for the Phase-F local prompt exception. Until one
 * does, a store build is protected most strongly by having no prompt source at
 * all; future approved local AI work must replace this guard with the explicit
 * build-time tree-shaking assertion from the V2 plan.
 */
describe('S0 · no AI prompt in store build', () => {
  it('contains no local prompt module or prompt literal in the apply source graph', () => {
    expect(existsSync(resolve(applyRoot, 'ai/local/prompt.ts'))).toBe(false);
    const source = sourceFiles(applyRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/\b(?:systemPrompt|userPrompt|promptTemplate)\b/i);
  });
});
