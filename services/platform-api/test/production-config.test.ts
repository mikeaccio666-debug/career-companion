import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readConfig, workspaceRoot } from '../src/config.ts';

// Fictional connection values exercise validation, without contacting a provider.
const production: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', PLATFORM_DATABASE_URL: 'postgresql://synthetic:synthetic-password@db.example.invalid/companion',
  PLATFORM_BUILD_ID: 'synthetic-release-20261006',
  PLATFORM_REDIS_URL: 'rediss://:synthetic-password@redis.example.invalid:6379/0',
  PLATFORM_ALLOWED_ORIGINS: 'https://app.example.invalid', PLATFORM_S3_BUCKET: 'synthetic-private-objects',
  PLATFORM_S3_ENDPOINT: 'https://objects.example.invalid', PLATFORM_S3_REGION: 'auto',
  PLATFORM_S3_ACCESS_KEY_ID: 'synthetic-access-key', PLATFORM_S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret',
  PLATFORM_ALLOW_ACCOUNT_EMAIL: '1', RESEND_API_KEY: 'synthetic-mail-key',
  PLATFORM_ACCOUNT_EMAIL_FROM: 'noreply@example.invalid', PLATFORM_ACCOUNT_WEB_ORIGIN: 'https://app.example.invalid',
  PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: '11'.repeat(32),
};

test('listener defaults stay on loopback and hosted ports require explicit, valid configuration', () => {
  const local = readConfig({});
  assert.equal(local.host, '127.0.0.1'); assert.equal(local.port, 4320);
  assert.equal(local.secureCookies, false); assert.equal(local.s3, undefined); assert.equal(local.webStaticDir, undefined);
  assert.equal(local.accountEmail, undefined); assert.equal(local.requireVerifiedEmail, false);
  assert.equal(readConfig({ PLATFORM_HOST: '0.0.0.0', PORT: '10000' }).host, '0.0.0.0');
  assert.equal(readConfig({ PORT: '10000' }).port, 10000);
  assert.equal(readConfig({ PLATFORM_PORT: '4319' }).port, 4319);
  assert.equal(readConfig({ PLATFORM_PORT: '10000', PORT: '10000' }).port, 10000);
  assert.throws(() => readConfig({ PLATFORM_PORT: '4320', PORT: '10000' }), /must agree/);
  for (const value of ['', '0', '-1', '65536', '1.5', ' 4320', '04320', '1e4', '10000suffix']) {
    assert.throws(() => readConfig({ PORT: value }), /PORT/);
    assert.throws(() => readConfig({ PLATFORM_PORT: value }), /PLATFORM_PORT/);
  }
  for (const value of ['', '*', '192.0.2.1', '::', 'example.invalid']) assert.throws(() => readConfig({ PLATFORM_HOST: value }), /PLATFORM_HOST/);
  assert.equal(readConfig({ PLATFORM_WEB_STATIC_DIR: 'apps/web/dist' }).webStaticDir, path.join(workspaceRoot, 'apps/web/dist'));
  assert.throws(() => readConfig({ PLATFORM_WEB_STATIC_DIR: '   ' }), /PLATFORM_WEB_STATIC_DIR/);
});

test('production requires explicit backend connections, exact HTTPS origins and server-owned object credentials', () => {
  const valid = readConfig(production);
  assert.equal(valid.secureCookies, true); assert.equal(valid.host, '127.0.0.1');
  assert.equal(valid.requireVerifiedEmail, true); assert.ok(valid.accountEmail);
  assert.deepEqual([...valid.allowedOrigins], ['https://app.example.invalid']);
  assert.equal(valid.s3?.region, 'auto');
  // AWS's regional endpoint can be derived by the SDK when an explicit endpoint is absent.
  assert.equal(readConfig({ ...production, PLATFORM_S3_ENDPOINT: undefined }).s3?.endpoint, undefined);
  for (const key of ['PLATFORM_DATABASE_URL', 'PLATFORM_REDIS_URL', 'PLATFORM_ALLOWED_ORIGINS', 'PLATFORM_S3_BUCKET', 'PLATFORM_S3_ACCESS_KEY_ID', 'PLATFORM_S3_SECRET_ACCESS_KEY'] as const) {
    assert.throws(() => readConfig({ ...production, [key]: undefined }), Error, key);
    assert.throws(() => readConfig({ ...production, [key]: '   ' }), Error, key);
  }
  assert.throws(() => readConfig({ ...production, PLATFORM_S3_REGION: '' }), /storage/);
  for (const value of ['https://db.example.invalid', 'postgresql://synthetic:local-companion-dev-only@db.example.invalid/x', 'postgresql://db.example.invalid/x#secret', ' postgresql://db.example.invalid/x']) {
    assert.throws(() => readConfig({ ...production, PLATFORM_DATABASE_URL: value }), /connection|PLATFORM_DATABASE_URL/i);
  }
  for (const value of ['https://redis.example.invalid', 'redis://:local-companion-redis-only@redis.example.invalid', 'redis://redis.example.invalid/0\n']) {
    assert.throws(() => readConfig({ ...production, PLATFORM_REDIS_URL: value }), /connection|PLATFORM_REDIS_URL/i);
  }
});

test('production requires account email and cannot disable verification; development mail remains opt-in', () => {
  assert.throws(() => readConfig({ ...production, PLATFORM_ALLOW_ACCOUNT_EMAIL: '0' }), /email/i);
  assert.throws(() => readConfig({ ...production, PLATFORM_REQUIRE_VERIFIED_EMAIL: '0' }), /verified/i);
  assert.throws(() => readConfig({ PLATFORM_REQUIRE_VERIFIED_EMAIL: '1' }), /email/i);
  for (const value of ['', 'true', 'yes', ' 1']) assert.throws(() => readConfig({ PLATFORM_REQUIRE_VERIFIED_EMAIL: value }), /PLATFORM_REQUIRE_VERIFIED_EMAIL/);
  for (const key of ['RESEND_API_KEY', 'PLATFORM_ACCOUNT_EMAIL_FROM', 'PLATFORM_ACCOUNT_WEB_ORIGIN', 'PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY'] as const) {
    assert.throws(() => readConfig({ ...production, [key]: undefined }), Error);
  }
});

test('origins and storage endpoints reject wildcard, credential, path and query ambiguity without echoing secrets', () => {
  for (const value of ['*', 'http://app.example.invalid', 'https://*.example.invalid', 'https://app.example.invalid/', 'https://app.example.invalid/path', 'https://synthetic-secret@app.example.invalid', 'https://app.example.invalid?secret=synthetic-secret', 'https://app.example.invalid#secret', 'https://app.example.invalid,']) {
    assert.throws(() => readConfig({ ...production, PLATFORM_ALLOWED_ORIGINS: value }), error => error instanceof Error && !error.message.includes('synthetic-secret'));
  }
  for (const value of ['http://objects.example.invalid', 'https://*.example.invalid', 'https://objects.example.invalid/', 'https://objects.example.invalid/bucket', 'https://synthetic-secret@objects.example.invalid', 'https://objects.example.invalid?secret=synthetic-secret']) {
    assert.throws(() => readConfig({ ...production, PLATFORM_S3_ENDPOINT: value }), error => error instanceof Error && !error.message.includes('synthetic-secret'));
  }
  assert.deepEqual([...readConfig({ PLATFORM_ALLOWED_ORIGINS: 'http://localhost:4321,https://app.example.invalid' }).allowedOrigins], ['http://localhost:4321', 'https://app.example.invalid']);
  assert.throws(() => readConfig({ PLATFORM_ALLOWED_ORIGINS: 'http://localhost:4321/path' }), /origins/);
});

test('runtime identities and database budgets are explicit and bounded without disclosing supplied values', () => {
  const local = readConfig({});
  assert.equal(local.databasePoolMax, 12); assert.equal(local.databaseConnectTimeoutMs, 5000); assert.equal(local.codeVersion, 'development');
  const configured = readConfig({ PLATFORM_DATABASE_POOL_MAX: '1', PLATFORM_DATABASE_CONNECT_TIMEOUT_MS: '100', PLATFORM_BUILD_ID: 'a'.repeat(64), PLATFORM_QUEUE_NAME: 'isolated-queue-1' });
  assert.equal(configured.databasePoolMax, 1); assert.equal(configured.databaseConnectTimeoutMs, 100); assert.equal(configured.codeVersion, 'a'.repeat(64));
  for (const value of ['', '0', '-1', '101', '1.1', '01', '1e1', ' 1', '1\n']) assert.throws(() => readConfig({ PLATFORM_DATABASE_POOL_MAX: value }), /PLATFORM_DATABASE_POOL_MAX/);
  for (const value of ['', '0', '99', '5001', '1.1', '0100', '1e3', ' 100']) assert.throws(() => readConfig({ PLATFORM_DATABASE_CONNECT_TIMEOUT_MS: value }), /PLATFORM_DATABASE_CONNECT_TIMEOUT_MS/);
  for (const name of ['PLATFORM_BUILD_ID', 'PLATFORM_QUEUE_NAME'] as const) {
    for (const value of ['', 'a'.repeat(129), 'synthetic-secret/path', 'synthetic-secret:other', ' synthetic-secret', 'synthetic-secret\n']) {
      assert.throws(() => readConfig({ [name]: value }), error => error instanceof Error && error.message.includes(name) && !error.message.includes('synthetic-secret'));
    }
  }
  for (const value of [undefined, 'development', 'DEVELOPMENT', 'unknown', 'UNKNOWN']) assert.throws(() => readConfig({ ...production, PLATFORM_BUILD_ID: value }), /PLATFORM_BUILD_ID/);
  assert.equal(readConfig(production).codeVersion, 'synthetic-release-20261006');
});
