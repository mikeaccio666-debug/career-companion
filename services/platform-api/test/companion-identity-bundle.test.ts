import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionIdentityBundleError, expectedCompanionIdentityBundleDigest,
  parseCompanionIdentityBundle, readCompanionIdentityBundle } from '../src/companion-identity-bundle.ts';
import { readConfig, workspaceRoot } from '../src/config.ts';

// Synthetic integrity fixtures: not a complete names list, a normative character table or release approval.
const content = () => ({ schemaVersion: 1, revision: 7,
  sourceRefs: { names: 'synthetic-name-source', seals: 'synthetic-character-source', aliases: 'synthetic-alias-source' },
  policy: { familyOrPartner: ['妈妈'], teamOrOrg: ['SyntheticRole'], abusive: ['SyntheticBad'], publicFigures: ['SyntheticFame'],
    allowedSealCharacters: ['如', '舟', '远', '暖'], englishSealAliases: [{ name: 'Juno', sealChar: '如' }] } });
const document = () => { const value = content(); return { ...value, contentDigest: expectedCompanionIdentityBundleDigest(value) }; };
const invalid = (error: unknown) => error instanceof CompanionIdentityBundleError
  && error.code === 'COMPANION_IDENTITY_BUNDLE_INVALID' && error.message === 'The companion identity bundle is not available.'
  && !Object.hasOwn(error, 'cause');
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const entry of Object.values(value)) frozen(entry);
}

test('external identity assets are copied and immutable without manufacturing review or activation', () => {
  const original = document(), parsed = parseCompanionIdentityBundle(original);
  assert.deepEqual(parsed, original); frozen(parsed);
  original.policy.allowedSealCharacters[0] = '朗'; original.sourceRefs.names = 'synthetic-modified-source';
  assert.equal(parsed.policy.allowedSealCharacters[0], '如'); assert.equal(parsed.sourceRefs.names, 'synthetic-name-source');
  for (const absent of ['approved', 'activated', 'tierOneVerified', 'completeVocabulary']) assert.equal(Object.hasOwn(parsed, absent), false);
});

test('canonical digest binds provenance, revision and ordered vocabulary, independently of object key order', () => {
  const original = content(), expected = expectedCompanionIdentityBundleDigest(original);
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
  assert.equal(expectedCompanionIdentityBundleDigest(reorder(original)), expected);
  for (const change of [
    (value: ReturnType<typeof content>) => { value.revision++; },
    (value: ReturnType<typeof content>) => { value.sourceRefs.seals += '-modified'; },
    (value: ReturnType<typeof content>) => { value.policy.allowedSealCharacters.reverse(); },
    (value: ReturnType<typeof content>) => { value.policy.publicFigures.push('SyntheticOther'); },
    (value: ReturnType<typeof content>) => { value.policy.englishSealAliases[0]!.sealChar = '舟'; },
  ]) { const value = content(); change(value); assert.notEqual(expectedCompanionIdentityBundleDigest(value), expected); }
  for (const digest of ['0'.repeat(64), expected.toUpperCase(), expected + '\n']) assert.throws(() => parseCompanionIdentityBundle({ ...document(), contentDigest: digest }), invalid);
});

test('manifest keys and data descriptors are closed, and failure never evaluates private getters', () => {
  const original = document();
  for (const key of Object.keys(original)) { const value: Record<string, unknown> = { ...original }; delete value[key]; assert.throws(() => parseCompanionIdentityBundle(value), invalid); }
  for (const value of [{ ...original, approved: true }, { ...original, sourceRefs: { ...original.sourceRefs, unknown: 'synthetic' } },
    Object.create(original), { ...original, [Symbol('private')]: true }]) assert.throws(() => parseCompanionIdentityBundle(value), invalid);
  let accessed = 0;
  for (const place of ['revision', 'sourceRef', 'policy']) {
    const value = document(), target = place === 'sourceRef' ? value.sourceRefs : value, key = place === 'sourceRef' ? 'names' : place;
    Object.defineProperty(target, key, { enumerable: true, get() { accessed++; throw new Error('Synthetic private getter'); } });
    assert.throws(() => parseCompanionIdentityBundle(value), invalid);
  }
  assert.equal(accessed, 0);
});

test('manifest revisions and provenance text reject invalid bounds, coercion and hidden formatting', () => {
  for (const revision of [0, -0, -1, 1.5, 2147483648, NaN, Infinity, '7']) assert.throws(() => expectedCompanionIdentityBundleDigest({ ...content(), revision }), invalid);
  for (const reference of ['', ' ', 'synthetic\nref', 'synthetic\0ref', 'synthetic\u202eref', '<b>synthetic</b>', '\ud800', 'x'.repeat(301)]) {
    assert.throws(() => expectedCompanionIdentityBundleDigest({ ...content(), sourceRefs: { ...content().sourceRefs, names: reference } }), invalid);
  }
  const badPolicy = content(); badPolicy.policy.allowedSealCharacters[0] = '导';
  assert.throws(() => expectedCompanionIdentityBundleDigest(badPolicy), invalid);
});

test('bounded file reader rejects absent, malformed, non-file, oversized and invalid UTF-8 assets without echoing paths', async () => {
  assert.equal(await readCompanionIdentityBundle(), null);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-identity-test-'));
  try {
    const filename = path.join(directory, 'synthetic-private-asset.json');
    await fs.writeFile(filename, JSON.stringify(document()));
    assert.deepEqual(await readCompanionIdentityBundle(filename), parseCompanionIdentityBundle(document()));
    for (const bytes of [Buffer.from('{bad synthetic JSON'), Buffer.from([0xc3, 0x28]), Buffer.alloc(256 * 1024 + 1, 0x20)]) {
      await fs.writeFile(filename, bytes); await assert.rejects(readCompanionIdentityBundle(filename), invalid);
    }
    for (const filename of [directory, path.join(directory, 'synthetic-missing.json'), '', 'synthetic\0private.json']) {
      await assert.rejects(readCompanionIdentityBundle(filename), invalid);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('identity asset configuration is server-only and closed by default without enabling generation or student release', () => {
  assert.equal(readConfig({}).companionIdentityBundlePath, undefined);
  for (const value of ['', ' ', 'synthetic\nprivate.json', 'synthetic\0private.json', 'synthetic\x7fprivate.json']) {
    assert.throws(() => readConfig({ PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE: value }), error => error instanceof Error
      && error.message === 'PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE must name a server-controlled file');
  }
  const config = readConfig({ PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE: '.local/private/synthetic-not-loaded.json' });
  assert.equal(config.companionIdentityBundlePath, path.join(workspaceRoot, '.local/private/synthetic-not-loaded.json'));
  assert.equal(config.workbenchEnabled, false); assert.equal(config.dataCrypto, undefined);
  assert.deepEqual(config.modelRoutes, {}); assert.equal(config.safetyDailyModelCallLimit, 0);
});
