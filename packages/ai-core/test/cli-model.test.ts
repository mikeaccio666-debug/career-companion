import test from 'node:test';
import assert from 'node:assert/strict';
import { cliModelConfiguration } from '../src/cli-model.ts';
import { providerStatuses } from '../src/config.ts';

test('local CLI uses an explicit installed model and literal loopback Responses endpoint without a commercial key', () => {
  const env = { PLATFORM_CLI_MODEL_PROVIDER: 'ollama', OLLAMA_CHAT_MODEL: 'fictional-local-model', OLLAMA_BASE_URL: 'http://127.0.0.1:23456/v1/',
    PLATFORM_ALLOW_PROVIDER_CALLS: '0', PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_MODEL_RELAY: '1', PLATFORM_CLI_IMAGE: 'fictional-harness:local', PLATFORM_CLI_COMMAND: '["codex","exec"]' };
  const config = cliModelConfiguration(env);
  assert.equal(config.endpoint, 'http://127.0.0.1:23456/v1/responses'); assert.equal(config.model, 'fictional-local-model'); assert.equal(config.enabled, true);
  const status = providerStatuses(env).find(item => item.id === 'cli')!;
  assert.equal(status.enabled, true); assert.deepEqual(status.modelsByCapability?.cli, ['fictional-local-model']);
  assert.equal(providerStatuses({ ...env, PLATFORM_CLI_MODEL_RELAY: '0' }).find(item => item.id === 'cli')!.enabled, false);
  assert.equal(cliModelConfiguration({ ...env, OLLAMA_BASE_URL: 'http://[::1]:23456' }).endpoint, 'http://[::1]:23456/v1/responses');
});
test('invalid local routes, cloud names and unknown providers cannot enable CLI', () => {
  const env = { PLATFORM_CLI_MODEL_PROVIDER: 'ollama', PLATFORM_CLI_MODEL: 'fictional-local-model', PLATFORM_ENABLE_CLI: '1', PLATFORM_CLI_MODEL_RELAY: '1', PLATFORM_CLI_IMAGE: 'fictional-harness:local', PLATFORM_CLI_COMMAND: '["codex","exec"]' };
  for (const base of ['http://localhost:23456', 'http://127.1:23456', 'http://2130706433:23456', 'http://0x7f000001:23456', 'http://10.0.0.1:23456', 'https://127.0.0.1:23456', 'http://user:pass@127.0.0.1:23456', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:23456/elsewhere', 'http://127.0.0.1:23456?key=fictional', 'http://127.0.0.1:23456#fragment']) {
    assert.throws(() => cliModelConfiguration({ ...env, OLLAMA_BASE_URL: base }));
    assert.equal(providerStatuses({ ...env, OLLAMA_BASE_URL: base }).find(item => item.id === 'cli')!.enabled, false);
  }
  for (const model of ['fictional-cloud', 'fictional:cloud', '', 'invalid model']) assert.throws(() => cliModelConfiguration({ ...env, PLATFORM_CLI_MODEL: model, OLLAMA_BASE_URL: 'http://127.0.0.1:23456' }));
  assert.throws(() => cliModelConfiguration({ ...env, PLATFORM_CLI_MODEL_PROVIDER: 'other' }));
});
test('default OpenAI relay retains its key and commercial call gate', () => {
  assert.equal(cliModelConfiguration({ OPENAI_API_KEY: 'fictional-key', PLATFORM_ALLOW_PROVIDER_CALLS: '0' }).enabled, false);
  assert.equal(cliModelConfiguration({ PLATFORM_ALLOW_PROVIDER_CALLS: '1' }).enabled, false);
  const config = cliModelConfiguration({ OPENAI_API_KEY: 'fictional-key', PLATFORM_ALLOW_PROVIDER_CALLS: '1' });
  assert.equal(config.provider, 'openai'); assert.equal(config.endpoint, 'https://api.openai.com/v1/responses'); assert.equal(config.enabled, true);
});
