import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readConfig, workspaceRoot } from '../src/config.ts';

// Fictional connection values exercise validation, without contacting a provider.
const production: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', PLATFORM_DATABASE_URL: 'postgresql://synthetic:synthetic-password@db.example.invalid/companion',
  PLATFORM_REDIS_URL: 'rediss://:synthetic-password@redis.example.invalid:6379/0',
  PLATFORM_ALLOWED_ORIGINS: 'https://app.example.invalid', PLATFORM_S3_BUCKET: 'synthetic-private-objects',
  PLATFORM_S3_ENDPOINT: 'https://objects.example.invalid', PLATFORM_S3_REGION: 'auto',
  PLATFORM_S3_ACCESS_KEY_ID: 'synthetic-access-key', PLATFORM_S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret',
};

test('listener defaults stay on loopback and hosted ports require explicit, valid configuration', () => {
  const local = readConfig({});
  assert.equal(local.host, '127.0.0.1'); assert.equal(local.port, 4320);
  assert.equal(local.secureCookies, false); assert.equal(local.s3, undefined); assert.equal(local.webStaticDir, undefined);
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
