import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.ts';

// Only parser inputs; these fictional hosts and credentials are never contacted.
const production: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', PLATFORM_DATABASE_URL: 'postgresql://synthetic:synthetic-password@db.example.invalid/companion',
  PLATFORM_BUILD_ID: 'synthetic-routing-config-release', PLATFORM_REDIS_URL: 'rediss://:synthetic-password@redis.example.invalid:6379/0',
  PLATFORM_ALLOWED_ORIGINS: 'https://app.example.invalid', PLATFORM_S3_BUCKET: 'synthetic-private-objects',
  PLATFORM_S3_ENDPOINT: 'https://objects.example.invalid', PLATFORM_S3_REGION: 'auto',
  PLATFORM_S3_ACCESS_KEY_ID: 'synthetic-access-key', PLATFORM_S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret',
  PLATFORM_ALLOW_ACCOUNT_EMAIL: '1', RESEND_API_KEY: 'synthetic-mail-key', PLATFORM_ACCOUNT_EMAIL_FROM: 'noreply@example.invalid',
  PLATFORM_ACCOUNT_WEB_ORIGIN: 'https://app.example.invalid', PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY: '22'.repeat(32),
  PLATFORM_DATA_KEY: '33'.repeat(32),
};
const variables = {
  chat: 'PLATFORM_CHAT_PROVIDER', agent: 'PLATFORM_AGENT_PROVIDER', realtime: 'PLATFORM_REALTIME_PROVIDER',
  transcription: 'PLATFORM_TRANSCRIPTION_PROVIDER', speech: 'PLATFORM_SPEECH_PROVIDER',
} as const;

test('every purpose is unbound by default in development and production even with vendor or paid-call configuration', () => {
  for (const env of [{}, production, { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-provider-key', OPENAI_CHAT_MODEL: 'fictional-model', OPENAI_REALTIME_VOICE: 'fictional-voice' }]) {
    assert.deepEqual(readConfig(env).modelRoutes, {});
  }
});

test('five server provider variables bind independently without reading caller or vendor model defaults', () => {
  const env = Object.fromEntries(Object.values(variables).map((name, index) => [name, `fictional-provider-${index}`]));
  assert.deepEqual(readConfig(env).modelRoutes, {
    chat: { provider: 'fictional-provider-0' }, agent: { provider: 'fictional-provider-1' }, realtime: { provider: 'fictional-provider-2' },
    transcription: { provider: 'fictional-provider-3' }, speech: { provider: 'fictional-provider-4' },
  });
  assert.deepEqual(readConfig({ PLATFORM_CHAT_PROVIDER: 'fictional-provider', PLATFORM_CHAT_MODEL: 'caller-like-model', PLATFORM_PROVIDER: 'implicit-provider' }).modelRoutes,
    { chat: { provider: 'fictional-provider' } });
  assert.deepEqual(readConfig({ ...production, PLATFORM_SPEECH_PROVIDER: 'fictional-provider' }).modelRoutes, { speech: { provider: 'fictional-provider' } });
});

test('provider bindings reject empty, whitespace, control, ambiguous and oversized identifiers without exposing supplied values', () => {
  for (const purpose of Object.keys(variables) as (keyof typeof variables)[]) {
    const name = variables[purpose];
    for (const value of ['', ' ', ' synthetic-secret', 'synthetic-secret ', 'synthetic-secret\n', 'synthetic-secret\0', 'synthetic-secret/path',
      'synthetic-secret:other', 'synthetic-secret,other', 'synthetic-secret=other', 'x'.repeat(81)]) {
      assert.throws(() => readConfig({ [name]: value }), error => error instanceof Error && error.message.includes(name) && !error.message.includes('synthetic-secret'));
    }
    assert.equal(readConfig({ [name]: 'p'.repeat(80) }).modelRoutes[purpose]?.provider.length, 80);
  }
});

test('provider details require explicit development, details opt-in and the real internal workbench mode together', () => {
  for (const NODE_ENV of [undefined, 'development', 'test', 'Development', 'staging']) {
    for (const PLATFORM_ENABLE_WORKBENCH of [undefined, '0', '1']) {
      for (const PLATFORM_EXPOSE_PROVIDER_DETAILS of [undefined, '0', '1']) {
        assert.equal(readConfig({ NODE_ENV, PLATFORM_ENABLE_WORKBENCH, PLATFORM_EXPOSE_PROVIDER_DETAILS }).exposeProviderDetails,
          NODE_ENV === 'development' && PLATFORM_ENABLE_WORKBENCH === '1' && PLATFORM_EXPOSE_PROVIDER_DETAILS === '1');
      }
    }
  }
});

test('production always hides provider details and diagnostic flags do not enable a workbench', () => {
  for (const PLATFORM_EXPOSE_PROVIDER_DETAILS of [undefined, '0', '1']) {
    const config = readConfig({ ...production, PLATFORM_EXPOSE_PROVIDER_DETAILS });
    assert.equal(config.exposeProviderDetails, false); assert.equal(config.workbenchEnabled, false);
  }
  assert.equal(readConfig({ NODE_ENV: 'development', PLATFORM_EXPOSE_PROVIDER_DETAILS: '1' }).workbenchEnabled, false);
  assert.throws(() => readConfig({ ...production, PLATFORM_EXPOSE_PROVIDER_DETAILS: '1', PLATFORM_ENABLE_WORKBENCH: '1' }), /staff authorization/);
});

test('details validation remains strict even when its effective value would be hidden', () => {
  for (const env of [{}, { NODE_ENV: 'development', PLATFORM_ENABLE_WORKBENCH: '1' }, production]) {
    for (const value of ['', 'true', 'yes', ' 1', '1 ', '01', '1\n', 'synthetic-secret']) {
      assert.throws(() => readConfig({ ...env, PLATFORM_EXPOSE_PROVIDER_DETAILS: value }), error => error instanceof Error
        && error.message.includes('PLATFORM_EXPOSE_PROVIDER_DETAILS') && !error.message.includes('synthetic-secret'));
    }
  }
});
