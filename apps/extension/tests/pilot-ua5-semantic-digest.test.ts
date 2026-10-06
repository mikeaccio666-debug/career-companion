import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pilotUa5SemanticDigest } from '../lib/pilotUa5SemanticDigest';

describe('pilot UA-5 browser semantic digest', () => {
  it.each([
    [] as string[],
    ['question', 'email'],
    ['unicode', '名字', 'München'],
  ])('matches the backend/compiler SHA-256 framing for %j', (...parts) => {
    const expected = createHash('sha256').update(parts.join(' '), 'utf8').digest('hex');
    expect(pilotUa5SemanticDigest(...parts)).toBe(expected);
  });
});
