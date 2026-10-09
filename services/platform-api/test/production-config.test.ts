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
  // Public, fictional fixture material only; never use this key in a running service.
  PLATFORM_DATA_KEY: 'd8a07ee729375ce432dc9f199ce30c7f78a01c26f6e9b204da19f412ab8305d1',
};

test('listener defaults stay on loopback and hosted ports require explicit, valid configuration', () => {
  const local = readConfig({});
  assert.equal(local.host, '127.0.0.1'); assert.equal(local.port, 4320);
  assert.equal(local.secureCookies, false); assert.equal(local.s3, undefined); assert.equal(local.webStaticDir, undefined);
  assert.equal(local.accountEmail, undefined); assert.equal(local.requireVerifiedEmail, false);
  assert.equal(local.dataCrypto, undefined);
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

test('workbench admission defaults closed and only explicit non-production mode can enable it', () => {
  for (const NODE_ENV of [undefined, 'development', 'test']) {
    assert.equal(readConfig({ NODE_ENV }).workbenchEnabled, false);
    assert.equal(readConfig({ NODE_ENV, PLATFORM_ENABLE_WORKBENCH: '0' }).workbenchEnabled, false);
    assert.equal(readConfig({ NODE_ENV, PLATFORM_ENABLE_WORKBENCH: '1' }).workbenchEnabled, true);
  }
  assert.equal(readConfig(production).workbenchEnabled, false);
  assert.equal(readConfig({ ...production, PLATFORM_ENABLE_WORKBENCH: '0' }).workbenchEnabled, false);
  assert.throws(() => readConfig({ ...production, PLATFORM_ENABLE_WORKBENCH: '1' }), /staff authorization/);
  assert.equal(readConfig({ PLATFORM_ALLOW_PROVIDER_CALLS: '1', PLATFORM_ENABLE_BROWSER: '1', PLATFORM_ENABLE_CLI: '1' }).workbenchEnabled, false);
  for (const value of ['', 'true', 'yes', ' 1', '1 ', '01', '1\n', 'synthetic-secret']) {
    assert.throws(() => readConfig({ PLATFORM_ENABLE_WORKBENCH: value }), error => error instanceof Error && error.message.includes('PLATFORM_ENABLE_WORKBENCH') && !error.message.includes('synthetic-secret'));
  }
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

test('protected data uses a dedicated required production key without a development or email fallback', () => {
  assert.ok(readConfig(production).dataCrypto);
  assert.ok(readConfig({ PLATFORM_DATA_KEY: production.PLATFORM_DATA_KEY }).dataCrypto);
  assert.equal(readConfig({ ...production, NODE_ENV: 'development', PLATFORM_DATA_KEY: undefined }).dataCrypto, undefined);
  assert.throws(() => readConfig({ ...production, PLATFORM_DATA_KEY: undefined }), /PLATFORM_DATA_KEY/);
  for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
    for (const value of ['', ' ', 'fictional-data-secret', '11'.repeat(31), '11'.repeat(33), 'gg'.repeat(32), `${'11'.repeat(32)}\n`]) {
      assert.throws(() => readConfig({ ...production, NODE_ENV, PLATFORM_DATA_KEY: value }), error =>
        error instanceof Error && error.message === 'PLATFORM_DATA_KEY must be explicitly configured as a 32-byte hexadecimal key.' && !Object.hasOwn(error, 'cause'));
    }
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

test('production rejects local provider configuration even when commercial calls are disabled', () => {
  const names = ['KOKORO_BASE_URL', 'KOKORO_TTS_MODEL', 'KOKORO_TTS_VOICE', 'FASTER_WHISPER_BASE_URL',
    'FASTER_WHISPER_MODEL', 'OLLAMA_BASE_URL', 'OLLAMA_CHAT_MODEL', 'OLLAMA_API_KEY',
    'OLLAMA_REASONING_EFFORT', 'PLATFORM_CLI_OLLAMA_BASE_URL', 'KOKORO_FUTURE_OPTION'];
  for (const name of names) {
    for (const value of ['fictional-private-setting', ' ', '0']) {
      for (const gate of ['0', '1']) assert.throws(() => readConfig({
        ...production, [name]: value, PLATFORM_ALLOW_PROVIDER_CALLS: gate,
      }), error => error instanceof Error && error.message === 'Production cannot configure development-only local providers. Remove KOKORO_*, FASTER_WHISPER_*, OLLAMA_* and PLATFORM_CLI_OLLAMA_* settings.'
        && !error.message.includes('fictional-private-setting') && !Object.hasOwn(error, 'cause'), name);
    }
    // Empty template entries do not configure a runtime; local development remains usable.
    assert.doesNotThrow(() => readConfig({ ...production, [name]: '' }));
    assert.doesNotThrow(() => readConfig({ ...production, [name]: undefined }));
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      assert.doesNotThrow(() => readConfig({ NODE_ENV, [name]: 'fictional-private-setting' }));
    }
  }
});

test('production rejects every local provider route without requiring provider credentials', () => {
  const names = ['PLATFORM_CHAT_PROVIDER', 'PLATFORM_AGENT_PROVIDER', 'PLATFORM_REALTIME_PROVIDER',
    'PLATFORM_TRANSCRIPTION_PROVIDER', 'PLATFORM_SPEECH_PROVIDER', 'PLATFORM_SAFETY_CLASSIFY_PROVIDER',
    'PLATFORM_COMPANION_GENERATION_PROVIDER', 'PLATFORM_FIRST_LETTER_PROVIDER', 'PLATFORM_CLI_MODEL_PROVIDER'];
  for (const name of names) for (const provider of ['ollama', 'kokoro', 'faster-whisper']) {
    assert.throws(() => readConfig({ ...production, [name]: provider }),
      /Production cannot route requests to development-only local providers/, name);
    assert.doesNotThrow(() => readConfig({ NODE_ENV: 'development', [name]: provider }));
  }
  assert.equal(readConfig({ ...production, PLATFORM_CHAT_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fictional-provider-key', PLATFORM_ALLOW_PROVIDER_CALLS: '0' }).modelRoutes.chat?.provider, 'openai');
});

test('real API, worker, migration and operations entrypoints reject local settings before connecting', async () => {
  const { createServer } = await import('node:net');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  let connections = 0;
  const trap = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { trap.once('error', reject); trap.listen(0, '127.0.0.1', resolve); });
  const address = trap.address(); assert.ok(address && typeof address === 'object');
  try {
    for (const entry of ['main.ts', 'worker-main.ts', 'migrate.ts', 'operations-main.ts']) {
      await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(workspaceRoot, 'services/platform-api/src', entry)], {
        cwd: path.join(workspaceRoot, 'services/platform-api'), timeout: 15_000, maxBuffer: 128 * 1024,
        env: { ...production, PATH: process.env.PATH,
          PLATFORM_DATABASE_URL: `postgresql://fictional:fictional@127.0.0.1:${address.port}/fictional`,
          PLATFORM_REDIS_URL: `redis://127.0.0.1:${address.port}/0`,
          KOKORO_BASE_URL: 'fictional-private-setting', PLATFORM_ALLOW_PROVIDER_CALLS: '0' },
      }), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error && 'signal' in error && 'stdout' in error && 'stderr' in error, entry);
        assert.equal(error.code, 1, entry); assert.equal(error.signal, null, entry);
        assert.equal(error.stdout, '', entry); assert.equal(typeof error.stderr, 'string', entry);
        assert.match(String(error.stderr), /Production cannot configure development-only local providers/, entry);
        assert.equal(String(error.stderr).includes('fictional-private-setting'), false, entry);
        return true;
      });
      assert.equal(connections, 0, entry);
    }
  } finally { await new Promise<void>((resolve, reject) => trap.close(error => error ? reject(error) : resolve())); }
});
