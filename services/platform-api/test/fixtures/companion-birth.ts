import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { FixedSessionContext } from '../../src/auth.ts';
import { CompanionBirthService } from '../../src/companion-birth-service.ts';
import { CompanionBirthOriginStore } from '../../src/companion-birth-origin-store.ts';
import { CompanionNameSafety } from '../../src/companion-name-safety.ts';
import { CompanionPrebirthSafety } from '../../src/companion-prebirth-safety.ts';
import type { CompanionSealGlyphLookup } from '../../src/companion-seal-rendering.ts';
import { classifyPrebirthName, type PrebirthFixture, type ReadyPrebirthSource } from './companion-prebirth.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';

// Server-owned fictional triangle, neither an actual character/font nor
// vocabulary or professional review. Tests still run the actual bounded native
// renderer, actual origin/asset codecs, and actual PostgreSQL COMMIT.
export const FICTIONAL_BIRTH_GLYPH_PATH = 'M20 20 L80 20 L50 80 Z';
export const FICTIONAL_BIRTH_GLYPH_DIGEST = createHash('sha256')
  .update('fictional-native-birth-test-outline-not-font-review').digest('hex');
export function fictionalBirthGlyphs(sealChar: string, observe?: (call: number) => void): CompanionSealGlyphLookup {
  let calls = 0;
  return { lookup(char) {
    observe?.(++calls);
    return char === sealChar ? { path: FICTIONAL_BIRTH_GLYPH_PATH, assetDigest: FICTIONAL_BIRTH_GLYPH_DIGEST } : null;
  } };
}
interface BirthComposition {
  readonly ready: ReadyPrebirthSource;
  readonly namesService: CompanionNameSafety;
  readonly prebirth: CompanionPrebirthSafety;
}
export function createFixtureBirthService(fixture: PrebirthFixture, source: BirthComposition, glyphs: CompanionSealGlyphLookup | null) {
  return new CompanionBirthService(fixture.db, fixture.config, FICTIONAL_LEGAL, source.prebirth,
    source.namesService, source.ready.background, source.ready.names, new CompanionBirthOriginStore(fixture.crypto), glyphs);
}

/** Reuse an actual already authenticated owner when transport tests need one.
 * Full-L0 classification is actual runner + loopback provider SSE; both apply
 * and explicit selection go through the complete production prebirth barrier.
 * No fake source, generated preview, approved identity or birth row is seeded.
 */
export async function readyBirth(fixture: PrebirthFixture, runtime: PlatformProviderRuntime, options: {
  readonly who?: FixedSessionContext;
  readonly glyphs?: CompanionSealGlyphLookup | null;
  readonly observeGlyph?: (call: number) => void;
} = {}) {
  const ready = await fixture.ready(runtime, { who: options.who });
  const submitted = await classifyPrebirthName(fixture, ready, runtime);
  const namesService = new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL,
    ready.background, ready.names, fixture.resources);
  const prebirth = new CompanionPrebirthSafety(fixture.db, fixture.config, FICTIONAL_LEGAL,
    ready.background, namesService, ready.names);
  const applied = await prebirth.apply(ready.who, { taskId: ready.prepared.taskId, submissionId: submitted.submissionId });
  assert.equal(applied.status, 'applied'); assert.equal(applied.appliedIdentityRevision, 1);
  const identity = await ready.names.read(ready.who, { taskId: ready.prepared.taskId }); assert(identity);
  const sealChar = identity.sealCandidates[0].char;
  const selection = await prebirth.select(ready.who, { taskId: ready.prepared.taskId,
    expectedIdentityRevision: identity.revision, expectedRevision: 0, operationId: randomUUID(), sealChar });
  assert.equal(selection.selection.selectedSeal, sealChar);
  const body = Object.freeze({ name: identity.name, sealChar });
  const source = { ready, prebirth, namesService };
  const glyphs = options.glyphs === undefined ? fictionalBirthGlyphs(sealChar, options.observeGlyph) : options.glyphs;
  return { ...source, identity, submitted, body, key: randomUUID(), service: createFixtureBirthService(fixture, source, glyphs) };
}

export type ReadyBirth = Awaited<ReturnType<typeof readyBirth>>;
