import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { CompanionIdentityReviewError, assertActiveCompanionIdentityBundle, expectedCompanionIdentityReviewDigest,
  parseCompanionIdentityReview, readCompanionIdentityReview } from '../src/companion-identity-review.ts';
import { expectedCompanionIdentityBundleDigest } from '../src/companion-identity-bundle.ts';
import { ApiError } from '../src/errors.ts';

// Fictional receipts test integrity, not a real review, complete normative
// character domain, staff authority, activation, or student release approval.
const content = () => ({ schemaVersion: 1, bundleRevision: 7, bundleDigest: 'a'.repeat(64),
  coverage: 'complete_eligible_level_one', reviewerUserId: '00000000-0000-4000-8000-000000000001',
  reviewedAt: '2026-10-01T12:34:56.789Z', reviewEvidenceRef: 'synthetic-review-evidence', tierOneSourceRef: 'synthetic-tier-one-source' });
const document = () => { const value = content(); return { ...value, reviewDigest: expectedCompanionIdentityReviewDigest(value) }; };
const invalid = (error: unknown) => error instanceof CompanionIdentityReviewError
  && error.code === 'COMPANION_IDENTITY_REVIEW_INVALID' && error.message === 'The companion identity review is not available.'
  && !Object.hasOwn(error, 'cause');
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503
  && error.code === 'COMPANION_IDENTITY_UNAVAILABLE' && error.message === 'Companion naming is not available.'
  && !Object.hasOwn(error, 'cause');

test('review manifest is an immutable snapshot and cannot manufacture factual review or activation', () => {
  const original = document(), parsed = parseCompanionIdentityReview(original);
  assert.deepEqual(parsed, original); assert(Object.isFrozen(parsed));
  original.reviewEvidenceRef = 'synthetic-replaced'; original.reviewerUserId = '00000000-0000-4000-8000-000000000002';
  assert.equal(parsed.reviewEvidenceRef, 'synthetic-review-evidence');
  assert.equal(parsed.reviewerUserId, '00000000-0000-4000-8000-000000000001');
  for (const absent of ['approved', 'activated', 'tierOneVerified', 'authorityVerified']) assert.equal(Object.hasOwn(parsed, absent), false);
});

test('digest binds every variable canonical field and ignores object key order, not ordered asset bytes', () => {
  const original = content(), digest = expectedCompanionIdentityReviewDigest(original);
  assert.equal(expectedCompanionIdentityReviewDigest(Object.fromEntries(Object.entries(original).reverse())), digest);
  const changes: Partial<ReturnType<typeof content>>[] = [{ bundleRevision: 8 }, { bundleDigest: 'b'.repeat(64) },
    { reviewerUserId: '00000000-0000-4000-8000-000000000002' }, { reviewedAt: '2026-10-02T12:34:56.789Z' },
    { reviewEvidenceRef: 'synthetic-other-evidence' }, { tierOneSourceRef: 'synthetic-other-source' }];
  for (const change of changes) {
    assert.notEqual(expectedCompanionIdentityReviewDigest({ ...original, ...change }), digest);
    assert.throws(() => parseCompanionIdentityReview({ ...document(), ...change }), invalid);
  }
  for (const reviewDigest of ['0'.repeat(64), digest.toUpperCase(), digest + '\n', 7]) {
    assert.throws(() => parseCompanionIdentityReview({ ...document(), reviewDigest }), invalid);
  }
});

test('all manifest keys are required, closed, own enumerable data properties with no getter execution', () => {
  const original = document();
  for (const key of Object.keys(original)) {
    const value: Record<string, unknown> = { ...original }; delete value[key];
    assert.throws(() => parseCompanionIdentityReview(value), invalid);
  }
  for (const value of [null, undefined, [], Object.create(original), { ...original, approved: true },
    { ...original, bundle: {} }, { ...original, [Symbol('synthetic')]: true }, Object.assign(Object.create({ extra: true }), original)]) {
    assert.throws(() => parseCompanionIdentityReview(value), invalid);
  }
  assert.deepEqual(parseCompanionIdentityReview(Object.assign(Object.create(null), original)), original);
  let accessed = 0;
  for (const key of Object.keys(original)) {
    const getter = { ...original }; Object.defineProperty(getter, key, { enumerable: true, get() { accessed++; throw new Error('synthetic-private-getter'); } });
    assert.throws(() => parseCompanionIdentityReview(getter), invalid);
    assert.throws(() => expectedCompanionIdentityReviewDigest(getter), invalid);
    const hidden = { ...original }; Object.defineProperty(hidden, key, { value: original[key as keyof typeof original], enumerable: false });
    assert.throws(() => parseCompanionIdentityReview(hidden), invalid);
  }
  assert.equal(accessed, 0);
});

test('schema, complete-domain attestation, revision, UUID and digest use exact canonical values', () => {
  const changes: Record<string, unknown>[] = [{ schemaVersion: 2 }, { schemaVersion: '1' }, { coverage: 'partial' },
    { coverage: 'complete_eligible_level_one\n' }, { coverage: true },
    ...[0, -0, -1, 1.5, 2147483648, NaN, Infinity, '7'].map(bundleRevision => ({ bundleRevision })),
    ...['', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '\n', 7].map(bundleDigest => ({ bundleDigest })),
    ...['', '00000000-0000-4000-8000-000000000001\n', 'ABC00000-0000-4000-8000-000000000001', 7].map(reviewerUserId => ({ reviewerUserId }))];
  for (const change of changes) assert.throws(() => expectedCompanionIdentityReviewDigest({ ...content(), ...change }), invalid);
  assert.equal(typeof expectedCompanionIdentityReviewDigest({ ...content(), bundleRevision: 2147483647 }), 'string');
});

test('review time is a real UTC timestamp with precisely canonical millisecond ISO spelling', () => {
  for (const reviewedAt of ['', 7, '2026-10-01', '2026-10-01T12:34:56Z', '2026-10-01T12:34:56.789+00:00',
    '2026-10-01t12:34:56.789z', '2026-10-01T12:34:56.789Z\n', '2026-02-29T00:00:00.000Z',
    '2026-10-01T24:00:00.000Z', '2026-10-01T12:34:60.000Z', '2026-13-01T00:00:00.000Z', '2026-10-01T12:34:56.78Z']) {
    assert.throws(() => expectedCompanionIdentityReviewDigest({ ...content(), reviewedAt }), invalid);
  }
  assert.equal(typeof expectedCompanionIdentityReviewDigest({ ...content(), reviewedAt: '2024-02-29T00:00:00.000Z' }), 'string');
});

test('evidence and tier-one references use bundle text bounds without resolving or trusting them', () => {
  for (const key of ['reviewEvidenceRef', 'tierOneSourceRef']) {
    for (const reference of ['', ' ', ' synthetic', 'synthetic ', 'synthetic\nprivate', 'synthetic\0private', '<b>synthetic</b>',
      'synthetic\u202eprivate', '\ud800', 'x'.repeat(301), '😀'.repeat(301), 7, {}]) {
      assert.throws(() => expectedCompanionIdentityReviewDigest({ ...content(), [key]: reference }), invalid);
    }
    assert.equal(typeof expectedCompanionIdentityReviewDigest({ ...content(), [key]: 'x'.repeat(300) }), 'string');
    assert.equal(typeof expectedCompanionIdentityReviewDigest({ ...content(), [key]: '😀'.repeat(300) }), 'string');
  }
});

test('optional reader enforces actual 32KiB bytes, regular files, UTF-8, integrity and fixed private errors', async () => {
  assert.equal(await readCompanionIdentityReview(), null);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-review-test-'));
  try {
    const filename = path.join(directory, 'synthetic-private-review.json'), json = JSON.stringify(document());
    await fs.writeFile(filename, json);
    assert.deepEqual(await readCompanionIdentityReview(filename), parseCompanionIdentityReview(document()));
    await fs.writeFile(filename, json + ' '.repeat(32 * 1024 - Buffer.byteLength(json)));
    assert.deepEqual(await readCompanionIdentityReview(filename), parseCompanionIdentityReview(document()));
    for (const bytes of [Buffer.from('{synthetic-bad-json'), Buffer.from([0xc3, 0x28]), Buffer.alloc(32 * 1024 + 1, 0x20),
      Buffer.from(JSON.stringify({ ...document(), reviewDigest: '0'.repeat(64) }))]) {
      await fs.writeFile(filename, bytes); await assert.rejects(readCompanionIdentityReview(filename), invalid);
    }
    for (const filename of [directory, path.join(directory, 'synthetic-missing.json'), '', 'synthetic\0private.json']) {
      await assert.rejects(readCompanionIdentityReview(filename), invalid);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('missing, malformed and cross-bundle review fails before any database authority check', async () => {
  let calls = 0;
  const client = { query: async () => { calls++; throw new Error('synthetic-db-must-not-be-used'); } } as unknown as Pick<PoolClient, 'query'>;
  const value = { schemaVersion: 1, revision: 7, sourceRefs: { names: 'synthetic-names', seals: 'synthetic-seals', aliases: 'synthetic-aliases' },
    policy: { familyOrPartner: [], teamOrOrg: [], abusive: [], publicFigures: [], allowedSealCharacters: ['如', '舟', '远'], englishSealAliases: [] } };
  const bundle = { ...value, contentDigest: expectedCompanionIdentityBundleDigest(value) };
  await assert.rejects(assertActiveCompanionIdentityBundle(client, null, null), unavailable);
  await assert.rejects(assertActiveCompanionIdentityBundle(client, bundle as never, document() as never), unavailable);
  const reviewContent = { ...content(), bundleDigest: bundle.contentDigest };
  const review = { ...reviewContent, reviewDigest: expectedCompanionIdentityReviewDigest(reviewContent) };
  await assert.rejects(assertActiveCompanionIdentityBundle(client, { ...bundle, contentDigest: '0'.repeat(64) } as never, review as never), unavailable);
  await assert.rejects(assertActiveCompanionIdentityBundle(client, bundle as never, { ...review, approved: true } as never), unavailable);
  assert.equal(calls, 0);
});

test('database failures are unavailable without private SQL/path/cause; cancellation does not grant authority', async () => {
  const value = { schemaVersion: 1, revision: 7, sourceRefs: { names: 'synthetic-names', seals: 'synthetic-seals', aliases: 'synthetic-aliases' },
    policy: { familyOrPartner: [], teamOrOrg: [], abusive: [], publicFigures: [], allowedSealCharacters: ['如', '舟', '远'], englishSealAliases: [] } };
  const bundle = { ...value, contentDigest: expectedCompanionIdentityBundleDigest(value) };
  const reviewContent = { ...content(), bundleDigest: bundle.contentDigest }, review = { ...reviewContent, reviewDigest: expectedCompanionIdentityReviewDigest(reviewContent) };
  let calls = 0;
  const client = { query: async () => { calls++; throw new Error('synthetic-private-SQL-and-path'); } } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(assertActiveCompanionIdentityBundle(client, bundle as never, review as never), unavailable);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(assertActiveCompanionIdentityBundle(client, bundle as never, review as never, controller.signal), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls, 1);
});
