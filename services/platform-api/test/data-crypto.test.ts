import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DataCryptoError, MAX_DATA_PLAINTEXT_BYTES, readDataCrypto, type DataBinding } from '../src/data-crypto.ts';

// Public, fictional fixture material; no test reads server secrets or opens a connection.
const fixtureKey = 'd8a07ee729375ce432dc9f199ce30c7f78a01c26f6e9b204da19f412ab8305d1';
const binding: DataBinding = {
  table: 'platform_onboarding_drafts', column: 'answers_ciphertext',
  rowId: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002', revision: 1,
};
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: fixtureKey })!;
const publicFailure = 'The protected data could not be processed.';
function failsSafely(run: () => unknown): void {
  assert.throws(run, error => error instanceof DataCryptoError && error.code === 'DATA_CRYPTO_FAILED'
    && error.message === publicFailure && !Object.hasOwn(error, 'cause'));
}
function aad(context: DataBinding, version = 1): Buffer {
  return Buffer.from(JSON.stringify(['career-companion:data:v1', version, context.table, context.column,
    context.rowId, context.ownerId, context.revision]), 'utf8');
}
// Independent encryption can produce malformed authenticated plaintext and alternative envelopes.
function independentEnvelope(plain: Buffer, context = binding, options: { key?: string; version?: number; tagLength?: number; associatedData?: Buffer } = {}): Buffer {
  const iv = randomBytes(12), version = options.version ?? 1;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(options.key ?? fixtureKey, 'hex'), iv, { authTagLength: options.tagLength ?? 16 });
  cipher.setAAD(options.associatedData ?? aad(context, version));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), ciphertext]);
}

test('development has no implicit key, even when unrelated email or provider settings are present', () => {
  for (const NODE_ENV of [undefined, 'development', 'test']) {
    assert.equal(readDataCrypto({ NODE_ENV }), undefined);
    assert.equal(readDataCrypto({ NODE_ENV, PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: fixtureKey, PLATFORM_ALLOW_ACCOUNT_EMAIL: '1', PLATFORM_ALLOW_PROVIDER_CALLS: '1' }), undefined);
  }
  assert.throws(() => readDataCrypto({ NODE_ENV: 'production' }), /PLATFORM_DATA_KEY/);
});

test('explicit keys reject whitespace, malformed hex and wrong length without echoing configuration', () => {
  const expected = 'PLATFORM_DATA_KEY must be explicitly configured as a 32-byte hexadecimal key.';
  for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
    for (const PLATFORM_DATA_KEY of ['', ' ', 'fictional-private-key', 'ab'.repeat(31), 'ab'.repeat(33), 'gg'.repeat(32), `${fixtureKey}\n`, ` ${fixtureKey}`, `${fixtureKey} `, `${'a'.repeat(63)}\n`]) {
      assert.throws(() => readDataCrypto({ NODE_ENV, PLATFORM_DATA_KEY }), error => error instanceof Error
        && error.message === expected && !Object.hasOwn(error, 'cause'));
    }
  }
  const uppercase = readDataCrypto({ PLATFORM_DATA_KEY: fixtureKey.toUpperCase() })!;
  assert.equal(uppercase.openUtf8(crypto.sealUtf8('fictional', binding), binding), 'fictional');
});

test('factory keeps a private stable key and exposes only a frozen encryption port', () => {
  const env = { PLATFORM_DATA_KEY: fixtureKey }, captured = readDataCrypto(env)!;
  env.PLATFORM_DATA_KEY = '22'.repeat(32);
  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(Object.keys(captured).sort(), ['openUtf8', 'sealUtf8']);
  const envelope = captured.sealUtf8('fictional private state', binding);
  assert.equal(crypto.openUtf8(envelope, binding), 'fictional private state');
  failsSafely(() => readDataCrypto(env)!.openUtf8(envelope, binding));
});

test('versioned envelope interoperates with independent AES-GCM and uses different random IVs', () => {
  const value = '{"freeText":"虚构资料 only","identityStage":"f1_student"}';
  const first = crypto.sealUtf8(value, binding), second = crypto.sealUtf8(value, binding);
  assert.equal(first[0], 1); assert.equal(first.length, 29 + Buffer.byteLength(value, 'utf8'));
  assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13)); assert.notDeepEqual(first, second);
  assert.ok(!first.includes(Buffer.from(value, 'utf8')));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(fixtureKey, 'hex'), first.subarray(1, 13), { authTagLength: 16 });
  decipher.setAAD(aad(binding)); decipher.setAuthTag(first.subarray(13, 29));
  assert.equal(Buffer.concat([decipher.update(first.subarray(29)), decipher.final()]).toString('utf8'), value);
  assert.equal(crypto.openUtf8(independentEnvelope(Buffer.from(value, 'utf8')), binding), value);
  assert.equal(crypto.openUtf8(second, binding), value);
});

test('table, column, real row, owner and revision each authenticate the saved data', () => {
  const sealed = crypto.sealUtf8('fictional private draft', binding);
  const otherContexts: DataBinding[] = [
    { ...binding, table: 'platform_pending_items' }, { ...binding, column: 'input_ciphertext' },
    { ...binding, rowId: '00000000-0000-4000-8000-000000000003' },
    { ...binding, ownerId: '00000000-0000-4000-8000-000000000004' }, { ...binding, revision: 2 },
  ];
  for (const context of otherContexts) {
    failsSafely(() => crypto.openUtf8(sealed, context));
    failsSafely(() => crypto.openUtf8(independentEnvelope(Buffer.from('fictional'), context), binding));
  }
  failsSafely(() => crypto.openUtf8(independentEnvelope(Buffer.from('fictional'), binding, { associatedData: Buffer.from('career-companion:account-email:v1') }), binding));
});

test('context rejects aliases, unknown coordinates and ambiguous revisions before encryption or decryption', () => {
  const sealed = crypto.sealUtf8('fictional', binding);
  const invalid: unknown[] = [null, [], {}, { ...binding, extra: 'fictional-sensitive-value' }];
  for (const field of ['table', 'column'] as const) {
    for (const value of ['', 'a'.repeat(64), 'Platform_Draft', 'draft.column', 'draft\u0000other', 'draft\n', 'draft:other']) invalid.push({ ...binding, [field]: value });
  }
  for (const field of ['rowId', 'ownerId'] as const) {
    for (const value of ['', 'fictional-secret', binding[field] + '\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) invalid.push({ ...binding, [field]: value });
  }
  for (const revision of [-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) invalid.push({ ...binding, revision });
  for (const context of invalid) {
    failsSafely(() => crypto.sealUtf8('fictional', context as DataBinding));
    failsSafely(() => crypto.openUtf8(sealed, context as DataBinding));
  }
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    const context = { ...binding, revision };
    assert.equal(crypto.openUtf8(crypto.sealUtf8('fictional', context), context), 'fictional');
  }
});

test('every byte of version, nonce, tag and ciphertext is authenticated', () => {
  const sealed = crypto.sealUtf8('fictional draft with private date 2099-01-02', binding);
  for (let offset = 0; offset < sealed.length; offset++) {
    const changed = Buffer.from(sealed); changed[offset] ^= 1;
    failsSafely(() => crypto.openUtf8(changed, binding));
  }
});

test('truncated, appended, wrong-key and unknown-version envelopes all fail without a plaintext fallback', () => {
  const sealed = crypto.sealUtf8('fictional', binding);
  for (let end = 0; end < sealed.length; end++) failsSafely(() => crypto.openUtf8(sealed.subarray(0, end), binding));
  for (const envelope of [Buffer.concat([sealed, Buffer.from([0])]), Buffer.from('fictional plaintext'), independentEnvelope(Buffer.from('fictional'), binding, { key: '22'.repeat(32) }), independentEnvelope(Buffer.from('fictional'), binding, { version: 0 }), independentEnvelope(Buffer.from('fictional'), binding, { version: 2 })]) {
    failsSafely(() => crypto.openUtf8(envelope, binding));
  }
  failsSafely(() => crypto.openUtf8(new Uint8Array(sealed) as unknown as Buffer, binding));
});

test('a shorter valid GCM tag is not accepted as this envelope format', () => {
  // Long payload prevents the global header length bound alone from rejecting it.
  const envelope = independentEnvelope(Buffer.from('fictional payload with enough bytes'), binding, { tagLength: 12 });
  failsSafely(() => crypto.openUtf8(envelope, binding));
});

test('UTF-8 storage preserves empty text, BOM, multibyte characters and literal controls', () => {
  for (const value of ['', '\uFEFFfictional', '虚构测试资料 🧑‍💻', 'line one\nline two\t\u0000literal controls']) {
    const sealed = crypto.sealUtf8(value, binding);
    assert.equal(crypto.openUtf8(sealed, binding), value);
  }
  assert.equal(crypto.sealUtf8('', binding).length, 29);
});

test('malformed Unicode and authenticated invalid UTF-8 fail before exposing replacement text', () => {
  for (const value of ['fictional\uD800', '\uDC00fictional', '\uD800\uD800']) failsSafely(() => crypto.sealUtf8(value, binding));
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
    failsSafely(() => crypto.openUtf8(independentEnvelope(Buffer.from(bytes)), binding));
  }
  for (const value of [null, undefined, 42, {}, Buffer.from('fictional')]) failsSafely(() => crypto.sealUtf8(value as string, binding));
});

test('byte limits cover exact boundaries, multibyte input and independently sealed oversized content', () => {
  assert.equal(MAX_DATA_PLAINTEXT_BYTES, 65536);
  const ascii = 'a'.repeat(MAX_DATA_PLAINTEXT_BYTES), chinese = '界'.repeat(Math.floor(MAX_DATA_PLAINTEXT_BYTES / 3)) + 'a';
  for (const value of [ascii, chinese]) {
    assert.equal(Buffer.byteLength(value, 'utf8'), MAX_DATA_PLAINTEXT_BYTES);
    const sealed = crypto.sealUtf8(value, binding);
    assert.equal(sealed.length, MAX_DATA_PLAINTEXT_BYTES + 29); assert.equal(crypto.openUtf8(sealed, binding), value);
  }
  for (const value of [ascii + 'a', chinese + 'a', '界'.repeat(Math.floor(MAX_DATA_PLAINTEXT_BYTES / 3) + 1)]) failsSafely(() => crypto.sealUtf8(value, binding));
  failsSafely(() => crypto.openUtf8(independentEnvelope(Buffer.alloc(MAX_DATA_PLAINTEXT_BYTES + 1, 0x61)), binding));
});

test('decrypting does not mutate the caller envelope or returned bindings', () => {
  const context = Object.freeze({ ...binding }), sealed = crypto.sealUtf8('fictional', context), original = Buffer.from(sealed);
  assert.equal(crypto.openUtf8(sealed, context), 'fictional'); assert.deepEqual(sealed, original);
  assert.deepEqual(context, binding);
});
