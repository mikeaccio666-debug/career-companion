import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Database } from '../src/database.ts';
import {
  decryptAccountEmail, encryptAccountEmail, processAccountEmails, readAccountEmailConfig,
  type AccountEmailConfig, type AccountEmailPayload,
} from '../src/account-mail.ts';

// These addresses and credentials are fictional. No test opens a connection or sends email.
const trustedOrigins = new Set([
  'https://app.example.invalid', 'http://localhost:4321', 'http://127.0.0.1:4321', 'http://[::1]:4321',
]);
const enabledEnv: NodeJS.ProcessEnv = {
  PLATFORM_ALLOW_ACCOUNT_EMAIL: '1',
  RESEND_API_KEY: 're_synthetic_account_mail_key',
  PLATFORM_ACCOUNT_EMAIL_FROM: 'Career Companion <noreply@example.invalid>',
  PLATFORM_ACCOUNT_WEB_ORIGIN: 'https://app.example.invalid',
  PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: '31'.repeat(32),
};
const config: AccountEmailConfig = {
  apiKey: 're_synthetic_account_mail_key', from: 'Career Companion <noreply@example.invalid>',
  webOrigin: 'https://app.example.invalid', encryptionKey: Buffer.alloc(32, 0x31),
};
const payload: AccountEmailPayload = {
  from: config.from, to: 'student@example.invalid', subject: 'Verify your account',
  text: '你好，验证你的邮箱。\n\nUse your personal verification link.\r\n\tThis is fictional test text.',
};
const aad = Buffer.from('career-companion:account-email:v1', 'utf8');

function assertSafeFailure(run: () => unknown, privateValues: string[] = []) {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, 'invalid data must fail with an Error');
  assert.ok(failure.message.length > 0 && failure.message.length < 200, 'failure must have a bounded public message');
  for (const value of privateValues) assert.ok(!failure.message.includes(value), 'failure must not echo supplied private values');
  return failure.message;
}

// Seal arbitrary JSON independently, to exercise validation after authenticated decryption.
function sealJson(value: unknown, encryptionKey = config.encryptionKey, associatedData = aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}

test('account email stays disabled unless explicitly enabled, without reading secrets or contacting dependencies', async () => {
  const malformedSecrets: NodeJS.ProcessEnv = {
    RESEND_API_KEY: '\nfictional-secret-key', PLATFORM_ACCOUNT_EMAIL_FROM: 'bad\r\nBcc:other@example.invalid',
    PLATFORM_ACCOUNT_WEB_ORIGIN: 'http://remote.example.invalid/path', PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: 'bad-key',
  };
  assert.equal(readAccountEmailConfig({}, trustedOrigins), undefined);
  assert.equal(readAccountEmailConfig(malformedSecrets, trustedOrigins), undefined);
  assert.equal(readAccountEmailConfig({ ...malformedSecrets, PLATFORM_ALLOW_ACCOUNT_EMAIL: '0' }, trustedOrigins), undefined);

  let databaseAccesses = 0;
  const database = new Proxy({}, { get() { databaseAccesses++; throw new Error('Database must not be touched'); } }) as Database;
  let networkCalls = 0;
  const fetch: typeof globalThis.fetch = async () => { networkCalls++; throw new Error('Network must not be touched'); };
  assert.equal(await processAccountEmails(database, undefined, { fetch }), 0);
  assert.equal(databaseAccesses, 0); assert.equal(networkCalls, 0);
  let optionsAccesses = 0;
  const options = new Proxy({}, { get() { optionsAccesses++; throw new Error('Disabled email must not read options'); } });
  assert.equal(await processAccountEmails(database, undefined, options), 0);
  assert.equal(databaseAccesses, 0); assert.equal(optionsAccesses, 0);
});

test('enabled account email uses an explicit server sender, trusted origin and exactly 32 key bytes', () => {
  const actual = readAccountEmailConfig(enabledEnv, trustedOrigins);
  assert.ok(actual);
  assert.equal(actual.apiKey, config.apiKey); assert.equal(actual.from, config.from);
  assert.equal(actual.webOrigin, config.webOrigin); assert.deepEqual(actual.encryptionKey, config.encryptionKey);
  assert.deepEqual(readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: 'AB'.repeat(32) }, trustedOrigins)?.encryptionKey, Buffer.alloc(32, 0xab));
  assert.equal(readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_EMAIL_FROM: 'noreply@example.invalid' }, trustedOrigins)?.from, 'noreply@example.invalid');
  assert.equal(readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_EMAIL_FROM: '职业伙伴 <noreply@example.invalid>' }, trustedOrigins)?.from, '职业伙伴 <noreply@example.invalid>');
  for (const origin of trustedOrigins) {
    assert.equal(readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_WEB_ORIGIN: origin }, trustedOrigins)?.webOrigin, origin);
  }
});

test('configuration rejects ambiguous switches and invalid credentials without echoing input', () => {
  let switchMessage: string | undefined;
  for (const value of ['', 'false', 'true', ' 1', '1 ', '01', 'fictional-switch-secret']) {
    const message = assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, PLATFORM_ALLOW_ACCOUNT_EMAIL: value }, trustedOrigins), value ? [value] : []);
    switchMessage ??= message; assert.equal(message, switchMessage, 'the switch error must not be derived from its value');
  }
  for (const key of ['RESEND_API_KEY', 'PLATFORM_ACCOUNT_EMAIL_FROM', 'PLATFORM_ACCOUNT_WEB_ORIGIN', 'PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY'] as const) {
    assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, [key]: undefined }, trustedOrigins));
    assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, [key]: '' }, trustedOrigins));
  }
  for (const value of ['fictional-key secret', 'fictional-key\tsecret', 'fictional-key\r\nsecret', 'fictional-key-秘密', 'x'.repeat(4097)]) {
    assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, RESEND_API_KEY: value }, trustedOrigins), [value]);
  }
  for (const value of ['31'.repeat(31), '31'.repeat(33), 'zz'.repeat(32), ` ${'31'.repeat(32)}`, `${'31'.repeat(32)}\n`]) {
    assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: value }, trustedOrigins), [value]);
  }
});

test('sender and callback origin cannot inject headers, credentials, paths or off-site redirects', () => {
  for (const value of [
    'not-an-email', 'Sender <noreply@example.invalid>\r\nBcc:other@example.invalid',
    'Sender\n<noreply@example.invalid>', 'Sender\u0000<noreply@example.invalid>',
    'Sender, Other <noreply@example.invalid>', 'Sender; Other <noreply@example.invalid>',
    'Sender <nested> <noreply@example.invalid>', 'a'.repeat(321),
  ]) assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_EMAIL_FROM: value }, trustedOrigins), [value]);
  assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_WEB_ORIGIN: 'https://untrusted.example.invalid' }, trustedOrigins));
  for (const value of [
    'https://app.example.invalid/', 'https://app.example.invalid/recover',
    'https://app.example.invalid?token=fictional-token', 'https://app.example.invalid#fictional-token',
    'https://fictional-secret@app.example.invalid', ' https://app.example.invalid',
    'http://app.example.invalid', 'https://*.example.invalid',
  ]) {
    // Even an accidentally supplied allow-list entry cannot make an unsafe URL a callback origin.
    assertSafeFailure(() => readAccountEmailConfig({ ...enabledEnv, PLATFORM_ACCOUNT_WEB_ORIGIN: value }, new Set([...trustedOrigins, value])), [value]);
  }
});

test('encrypted email is authenticated, uses a fresh IV and has an interoperable versioned envelope', () => {
  const first = encryptAccountEmail(config, payload);
  const second = encryptAccountEmail(config, payload);
  assert.ok(Buffer.isBuffer(first)); assert.equal(first[0], 1); assert.ok(first.length > 29);
  assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13));
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptAccountEmail(config, first), payload);
  assert.deepEqual(decryptAccountEmail(config, second), payload);
  assert.ok(!first.includes(Buffer.from(payload.to))); assert.ok(!first.includes(Buffer.from(payload.text)));

  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, first.subarray(1, 13));
  decipher.setAAD(aad); decipher.setAuthTag(first.subarray(13, 29));
  const plaintext = Buffer.concat([decipher.update(first.subarray(29)), decipher.final()]).toString('utf8');
  assert.deepEqual(JSON.parse(plaintext), payload);
  assert.deepEqual(decryptAccountEmail(config, sealJson(payload)), payload);
});

test('tampered, truncated, wrong-version, wrong-key and wrong-context envelopes all fail safely', () => {
  const encrypted = encryptAccountEmail(config, payload);
  const malformed = [Buffer.alloc(0), encrypted.subarray(0, 1), encrypted.subarray(0, 28), encrypted.subarray(0, encrypted.length - 1)];
  for (const offset of [0, 1, 13, 29, encrypted.length - 1]) {
    const changed = Buffer.from(encrypted); changed[offset] = changed[offset]! ^ 0xff; malformed.push(changed);
  }
  malformed.push(sealJson(payload, config.encryptionKey, Buffer.from('some-other-purpose')));
  for (const ciphertext of malformed) {
    assertSafeFailure(() => decryptAccountEmail(config, ciphertext), [payload.to, payload.text, config.apiKey]);
  }
  assertSafeFailure(() => decryptAccountEmail({ ...config, encryptionKey: Buffer.alloc(32, 0x32) }, encrypted), [payload.to, payload.text, config.apiKey]);
});

test('payload validation rejects unknown mail fields and header injection before and after encryption', () => {
  const invalidPayloads: unknown[] = [
    null, [], {}, { ...payload, bcc: 'other@example.invalid' }, { ...payload, headers: { 'X-Secret': 'fictional-secret' } },
    { ...payload, subject: '' }, { ...payload, subject: 'x'.repeat(201) }, { ...payload, subject: 'Reset\r\nBcc:other@example.invalid' },
    { ...payload, subject: 'Reset\taccount' }, { ...payload, subject: 'Reset\u007faccount' },
    { ...payload, from: '' }, { ...payload, from: 'Sender\r\n<noreply@example.invalid>' }, { ...payload, from: 'x'.repeat(321) },
    { ...payload, to: 'Student <student@example.invalid>' }, { ...payload, to: 'student@example.invalid,other@example.invalid' },
    { ...payload, to: ' student@example.invalid' }, { ...payload, to: 'student@example.invalid\n' },
    { ...payload, text: '' }, { ...payload, text: 'x'.repeat(16 * 1024 + 1) },
    { ...payload, text: '界'.repeat(Math.floor(16 * 1024 / 3) + 1) },
    { ...payload, text: 'Body\u0000fictional-secret' }, { ...payload, text: 'Body\u000bfictional-secret' },
    { ...payload, text: 'Body\u007ffictional-secret' }, { ...payload, text: 42 },
  ];
  for (const invalid of invalidPayloads) {
    assertSafeFailure(() => encryptAccountEmail(config, invalid as AccountEmailPayload), ['fictional-secret']);
    assertSafeFailure(() => decryptAccountEmail(config, sealJson(invalid)), ['fictional-secret']);
  }
  const largestBody = { ...payload, subject: 'x'.repeat(200), text: 'x'.repeat(16 * 1024) };
  assert.deepEqual(decryptAccountEmail(config, encryptAccountEmail(config, largestBody)), largestBody);
  // JSON escaping must not make a permitted 16 KiB body unreadable in the outbox.
  for (const text of ['\n'.repeat(16 * 1024), '\t'.repeat(16 * 1024), '\r\n'.repeat(8 * 1024)]) {
    const escapedBody = { ...payload, text };
    assert.deepEqual(decryptAccountEmail(config, encryptAccountEmail(config, escapedBody)), escapedBody);
  }
  assert.deepEqual(decryptAccountEmail(config, encryptAccountEmail(config, payload)), payload);
});
