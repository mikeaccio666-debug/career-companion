import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { ApiError } from '../src/errors.ts';
import { assertActiveSafetyDetector, expectedSafetyProfileDigests, parseSafetyDetectorProfile, readSafetyDetectorProfile,
  runSafetyKeywords, SafetyDetectorProfileError } from '../src/safety-detector-profile.ts';

// Explicit fictional marker phrases and review metadata. Passing these tests is not clinical review or policy activation.
const content = () => ({ schemaVersion: 1, revision: 7, instructions: 'Synthetic classifier fixture only. No diagnosis or real user content.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'fictional_zh_l1', language: 'zh', level: 'L1', phrases: ['虚构风险标记'] },
    { id: 'fictional_en_l2', language: 'en', level: 'L2', phrases: ['Synthetic risk marker'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-fixture-review-not-professional-approval', approvedAt: '2026-01-01T00:00:00.000Z' } });
const document = () => { const value = content(); return { ...value, ...expectedSafetyProfileDigests(value) }; };
const invalid = (error: unknown) => error instanceof SafetyDetectorProfileError
  && error.code === 'SAFETY_DETECTOR_PROFILE_INVALID' && error.message === 'The safety detector profile is not available.' && !Object.hasOwn(error, 'cause');
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'ONBOARDING_SAFETY_UNAVAILABLE';

test('a profile is a copied deeply frozen configuration, without claiming approval from review metadata', () => {
  const original = document(), parsed = parseSafetyDetectorProfile(original);
  assert.deepEqual(parsed, original); assert.notEqual(parsed, original); assert.notEqual(parsed.lexicon, original.lexicon);
  for (const value of [parsed, parsed.review, parsed.lexicon, ...parsed.lexicon, ...parsed.lexicon.map(entry => entry.phrases)]) assert(Object.isFrozen(value));
  original.instructions = 'Synthetic changed instructions'; original.lexicon[0]!.phrases[0] = 'Synthetic changed phrase';
  assert.notEqual(parsed.instructions, original.instructions); assert.equal(parsed.lexicon[0]?.phrases[0], '虚构风险标记');
  assert.throws(() => { (parsed as { instructions: string }).instructions = 'Synthetic mutation'; }, TypeError);
});

test('canonical digests bind exact content separately from review and are independent of object property order', () => {
  const original = content(), expected = expectedSafetyProfileDigests(original);
  const reordered = { review: { approvedAt: original.review.approvedAt, reference: original.review.reference }, fallbackNoHit: original.fallbackNoHit,
    mergeRule: original.mergeRule, lexicon: original.lexicon.map(entry => ({ phrases: entry.phrases, level: entry.level, language: entry.language, id: entry.id })),
    algorithm: original.algorithm, instructions: original.instructions, revision: original.revision, schemaVersion: original.schemaVersion };
  assert.deepEqual(expectedSafetyProfileDigests(reordered), expected);
  const reviewChanged = expectedSafetyProfileDigests({ ...original, review: { ...original.review, reference: 'Synthetic changed review' } });
  assert.equal(reviewChanged.digest, expected.digest); assert.notEqual(reviewChanged.reviewDigest, expected.reviewDigest);
  for (const changed of [
    { ...original, revision: 8 }, { ...original, instructions: original.instructions+' Changed.' },
    { ...original, lexicon: [...original.lexicon].reverse() },
    { ...original, lexicon: original.lexicon.map(entry => ({ ...entry, phrases: [...entry.phrases, 'Synthetic additional marker'] })) },
  ]) { const next = expectedSafetyProfileDigests(changed); assert.notEqual(next.digest, expected.digest); assert.equal(next.reviewDigest, expected.reviewDigest); }
  for (const changed of [{ ...document(), digest: '0'.repeat(64) }, { ...document(), reviewDigest: '0'.repeat(64) }]) assert.throws(() => parseSafetyDetectorProfile(changed), invalid);
});

test('the external schema is closed at every level and requires explicit merge and no-hit rules', () => {
  const original = document();
  for (const key of Object.keys(original)) { const value: Record<string, unknown> = { ...original }; delete value[key]; assert.throws(() => parseSafetyDetectorProfile(value), invalid); }
  for (const value of [null, [], new Date(), Object.create(original), { ...original, extra: true }, { ...original, [Symbol('extra')]: true },
    { ...original, review: { ...original.review, actualApprover: true } }, { ...original, algorithm: 'regex' },
    { ...original, mergeRule: 'model_only' }, { ...original, fallbackNoHit: 'L0' },
    { ...original, lexicon: original.lexicon.map(entry => ({ ...entry, score: 1 })) },
  ]) assert.throws(() => parseSafetyDetectorProfile(value), invalid);
  let getterInvoked = false; const getter = { ...original };
  Object.defineProperty(getter, 'instructions', { get() { getterInvoked = true; return 'Synthetic getter'; } });
  assert.throws(() => parseSafetyDetectorProfile(getter), invalid); assert.equal(getterInvoked, false);
  const arrayGetter = document(); Object.defineProperty(arrayGetter.lexicon, '0', { get() { getterInvoked = true; return original.lexicon[0]; } });
  assert.throws(() => parseSafetyDetectorProfile(arrayGetter), invalid); assert.equal(getterInvoked, false);
});

test('revision, digest and canonical review timestamp bounds reject coercion and trailing characters', () => {
  for (const revision of [0, -0, -1, 1.5, 2147483648, NaN, Infinity, '7', new Number(7)]) assert.throws(() => parseSafetyDetectorProfile({ ...document(), revision }), invalid);
  for (const schemaVersion of [0, 2, '1']) assert.throws(() => parseSafetyDetectorProfile({ ...document(), schemaVersion }), invalid);
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => parseSafetyDetectorProfile({ ...document(), digest: document().digest+suffix }), invalid);
    assert.throws(() => parseSafetyDetectorProfile({ ...document(), review: { ...document().review, approvedAt: document().review.approvedAt+suffix } }), invalid);
  }
  for (const approvedAt of ['2026-01-01', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z']) assert.throws(() => parseSafetyDetectorProfile({ ...document(), review: { ...document().review, approvedAt } }), invalid);
});

test('a bounded bilingual lexicon requires unique ids and normalized unique nonempty phrases', () => {
  const original = document();
  const sparse = document(); delete sparse.lexicon[0];
  const extraArrayField = document(); Object.assign(extraArrayField.lexicon, { extra: true });
  for (const lexicon of [[], [original.lexicon[0]], [original.lexicon[1]], new Array(2), sparse.lexicon, extraArrayField.lexicon,
    [original.lexicon[0], { ...original.lexicon[1], id: original.lexicon[0]!.id }],
    original.lexicon.map(entry => ({ ...entry, id: 'x'.repeat(65) })),
    original.lexicon.map(entry => ({ ...entry, language: 'english' })),
    original.lexicon.map(entry => ({ ...entry, level: 'L0' })),
    original.lexicon.map(entry => ({ ...entry, phrases: [] })),
    original.lexicon.map(entry => ({ ...entry, phrases: [' '] })),
    original.lexicon.map(entry => ({ ...entry, phrases: ['x'.repeat(257)] })),
    original.lexicon.map(entry => ({ ...entry, phrases: ['Synthetic risk marker', 'SYNTHETIC RISK MARKER'] })),
    original.lexicon.map(entry => ({ ...entry, phrases: ['Synthetic café risk marker', 'Synthetic cafe\u0301 risk marker'] })),
  ]) assert.throws(() => parseSafetyDetectorProfile({ ...original, lexicon }), invalid);
  assert.throws(() => expectedSafetyProfileDigests({ ...content(), lexicon: Array.from({ length: 129 }, (_, index) => ({ ...original.lexicon[index % 2], id: 'fixture_'+index })) }), invalid);
  assert.throws(() => expectedSafetyProfileDigests({ ...content(), lexicon: original.lexicon.map(entry => ({ ...entry, phrases: Array.from({ length: 65 }, (_, index) => 'Synthetic risk marker '+index) })) }), invalid);
});

test('strings reject malformed UTF16/control data and instructions count characters within the explicit bound', () => {
  for (const instructions of ['', ' ', '\ud800', 'Synthetic\u0000instructions', 'x'.repeat(4001)]) assert.throws(() => parseSafetyDetectorProfile({ ...document(), instructions }), invalid);
  for (const reference of ['', ' ', '\ud800', 'x'.repeat(401)]) assert.throws(() => parseSafetyDetectorProfile({ ...document(), review: { ...document().review, reference } }), invalid);
  const unicode = { ...content(), instructions: '😀'.repeat(4000) }; assert.equal(parseSafetyDetectorProfile({ ...unicode, ...expectedSafetyProfileDigests(unicode) }).instructions, unicode.instructions);
  const oversized = { ...content(), lexicon: Array.from({ length: 10 }, (_, index) => ({ id: 'fictional_large_'+index, language: index % 2 ? 'zh' : 'en', level: 'L1',
    phrases: Array.from({ length: 64 }, (_, phrase) => 'Synthetic risk marker '+index+':'+phrase+' '+ 'x'.repeat(225)) })) };
  assert(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 128 * 1024);
  assert.throws(() => expectedSafetyProfileDigests(oversized), invalid);
});

test('literal matching uses NFC/case normalization, checks both languages and returns the highest level', () => {
  const profile = parseSafetyDetectorProfile(document());
  assert.equal(runSafetyKeywords(profile, 'Synthetic ordinary note.'), null); assert.equal(runSafetyKeywords(profile, ''), null);
  assert.equal(runSafetyKeywords(profile, '前缀：虚构风险标记。'), 'L1'); assert.equal(runSafetyKeywords(profile, 'SYNTHETIC RISK MARKER'), 'L2');
  assert.equal(runSafetyKeywords(profile, '虚构风险标记 then Synthetic risk marker'), 'L2');
  const accented = content(); accented.lexicon[1]!.phrases = ['Synthetic café risk marker'];
  assert.equal(runSafetyKeywords(parseSafetyDetectorProfile({ ...accented, ...expectedSafetyProfileDigests(accented) }), 'SYNTHETIC CAFE\u0301 RISK MARKER'), 'L2');
  const literal = content(); literal.lexicon[1]!.phrases = ['Synthetic risk marker [a+b].*'];
  const literalProfile = parseSafetyDetectorProfile({ ...literal, ...expectedSafetyProfileDigests(literal) });
  assert.equal(runSafetyKeywords(literalProfile, 'Synthetic risk marker aaab'), null); assert.equal(runSafetyKeywords(literalProfile, 'Synthetic risk marker [a+b].*'), 'L2');
});

test('keyword matching honors cancellation and does not synthesize a no-hit level', () => {
  const profile = parseSafetyDetectorProfile(document()), controller = new AbortController(); controller.abort();
  assert.throws(() => runSafetyKeywords(profile, 'Synthetic risk marker', controller.signal), { name: 'AbortError' });
  assert.equal(runSafetyKeywords(profile, 'Synthetic ordinary unmatched text.'), null);
  assert.throws(() => runSafetyKeywords(profile, '\ud800'), invalid);
});

test('an explicit UTF8 file is bounded and immutable; absent configuration supplies no profile or lexicon', async () => {
  assert.equal(await readSafetyDetectorProfile(), null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fictional-safety-profile-'));
  try {
    const filename = path.join(dir, 'profile.json'); await fs.writeFile(filename, JSON.stringify(document()));
    assert.deepEqual(await readSafetyDetectorProfile(filename), parseSafetyDetectorProfile(document()));
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('{"synthetic":'), Buffer.from('x'.repeat(128 * 1024 + 1))]) {
      await fs.writeFile(filename, bytes); await assert.rejects(readSafetyDetectorProfile(filename), invalid);
    }
    for (const filename of [dir, path.join(dir, 'missing.json'), '']) await assert.rejects(readSafetyDetectorProfile(filename), invalid);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('active policy check requests SHARE and binds revision, content and review without activating anything', async () => {
  const profile = parseSafetyDetectorProfile(document()); let queries = 0, statement = '';
  // Query-contract unit fixture only; actual PostgreSQL activation/locking is verified by the integrating service tests.
  const client = { query: async (sql: string) => { queries++; statement = sql; return { rows: [{ revision: profile.revision, content_digest: profile.digest, review_digest: profile.reviewDigest }] }; } } as unknown as Pick<PoolClient, 'query'>;
  assert.equal(await assertActiveSafetyDetector(client, profile), profile); assert.equal(queries, 1); assert.match(statement, /FOR SHARE$/); assert.match(statement, /platform_safety_detector_policy WHERE singleton=true/);
  await assert.rejects(assertActiveSafetyDetector(client, null), unavailable); assert.equal(queries, 1);
  for (const row of [undefined, { revision: 8, content_digest: profile.digest, review_digest: profile.reviewDigest },
    { revision: profile.revision, content_digest: '0'.repeat(64), review_digest: profile.reviewDigest },
    { revision: profile.revision, content_digest: profile.digest, review_digest: '0'.repeat(64) }]) {
    const fixture = { query: async () => ({ rows: row ? [row] : [] }) } as unknown as Pick<PoolClient, 'query'>;
    await assert.rejects(assertActiveSafetyDetector(fixture, profile), unavailable);
  }
});

test('active policy cancellation is checked before and after the query', async () => {
  const profile = parseSafetyDetectorProfile(document()), before = new AbortController(); before.abort(); let queries = 0;
  const client = { query: async () => { queries++; return { rows: [] }; } } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(assertActiveSafetyDetector(client, profile, before.signal), { name: 'AbortError' }); assert.equal(queries, 0);
  const during = new AbortController(), fixture = { query: async () => { during.abort(); return { rows: [{ revision: profile.revision, content_digest: profile.digest, review_digest: profile.reviewDigest }] }; } } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(assertActiveSafetyDetector(fixture, profile, during.signal), { name: 'AbortError' });
});
