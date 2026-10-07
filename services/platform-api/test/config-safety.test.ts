import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createProviderRuntime } from '@companion/ai-core';
import { readConfig, workspaceRoot } from '../src/config.ts';
import { modelRouteAvailability } from '../src/model-routing.ts';

test('safety detector profile and model route are absent by default despite ordinary chat configuration',() => {
  const config = readConfig({ PLATFORM_CHAT_PROVIDER:'openai',OPENAI_CHAT_MODEL:'fictional-chat',OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-safety' });
  assert.equal(config.safetyDetectorProfilePath,undefined); assert.equal(config.modelRoutes.safety_classify,undefined);
  assert.deepEqual(config.modelRoutes,{ chat:{ provider:'openai' } });
  assert.equal(config.safetyDailyModelCallLimit,0);
});

test('daily safety model call allowance defaults closed and accepts only canonical integers from 0 to 10000',() => {
  for (const value of ['0','1','9999','10000']) assert.equal(readConfig({ PLATFORM_SAFETY_DAILY_MODEL_CALL_LIMIT:value }).safetyDailyModelCallLimit,Number(value));
  for (const value of ['', ' ', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '10001', '999999999999999999', '1\n', '1\r', '1\r\n', '1\u2028', '1\u2029']) assert.throws(() => readConfig({ PLATFORM_SAFETY_DAILY_MODEL_CALL_LIMIT:value }),error => error instanceof Error && error.message === 'PLATFORM_SAFETY_DAILY_MODEL_CALL_LIMIT must be an integer from 0 to 10000');
});

test('explicit internal safety route and profile location do not enable public routes or execute requests',() => {
  let calls = 0;
  const config = readConfig({ PLATFORM_SAFETY_CLASSIFY_PROVIDER:'openai',PLATFORM_SAFETY_PROFILE_FILE:'.local/fictional-safety-profile.json' });
  assert.deepEqual(config.modelRoutes,{ safety_classify:{ provider:'openai' } });
  assert.equal(config.safetyDetectorProfilePath,path.join(workspaceRoot,'.local/fictional-safety-profile.json'));
  const runtime = createProviderRuntime({ env:{ PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-only',OPENAI_SAFETY_CLASSIFY_MODEL:'fictional-safety' },fetch:async () => { calls++; throw new Error('No execution in config validation.'); } });
  assert.deepEqual(modelRouteAvailability(config,runtime),{ chat:false,agent:false,realtime:false,transcription:false,speech:false });
  assert.equal(calls,0); assert.equal(config.workbenchEnabled,false);
});

test('safety provider rejects noncanonical identifiers without printing supplied values',() => {
  for (const value of ['', ' fictional-private', 'fictional-private ', 'fictional-private\n', 'fictional-private\r', 'fictional-private\r\n', 'fictional-private\u2028', 'fictional-private\u2029', 'fictional-private/path', 'x'.repeat(81)]) assert.throws(() => readConfig({ PLATFORM_SAFETY_CLASSIFY_PROVIDER:value }),error => error instanceof Error && error.message.includes('PLATFORM_SAFETY_CLASSIFY_PROVIDER') && !error.message.includes('fictional-private'));
  assert.equal(readConfig({ PLATFORM_SAFETY_CLASSIFY_PROVIDER:'x'.repeat(80) }).modelRoutes.safety_classify?.provider.length,80);
});

test('safety profile configuration rejects blank and control paths and never claims asset approval',() => {
  for (const value of ['', ' ', 'fictional-private\n.json', 'fictional-private\r.json', 'fictional-private\0.json', 'fictional-private\x7f.json']) assert.throws(() => readConfig({ PLATFORM_SAFETY_PROFILE_FILE:value }),error => error instanceof Error && error.message.includes('PLATFORM_SAFETY_PROFILE_FILE') && !error.message.includes('fictional-private'));
  const config = readConfig({ PLATFORM_SAFETY_PROFILE_FILE:'.local/nonexistent-fictional-profile.json' });
  assert.equal(config.safetyDetectorProfilePath,path.join(workspaceRoot,'.local/nonexistent-fictional-profile.json'));
  assert.equal(config.dataCrypto,undefined); assert.equal(config.modelRoutes.safety_classify,undefined);
});

test('fixed-response bundle is server-only, absent by default, and rejects invalid paths without echoing them',() => {
  assert.equal(readConfig({}).safetyResponseBundlePath,undefined);
  for (const value of ['', ' ', 'fictional-private\n.json', 'fictional-private\r.json', 'fictional-private\0.json', 'fictional-private\x7f.json']) {
    assert.throws(()=>readConfig({ PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE:value }),error=>error instanceof Error
      && error.message==='PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE must name a server-controlled file');
  }
  const config=readConfig({ PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE:'.local/nonexistent-fictional-response-bundle.json' });
  assert.equal(config.safetyResponseBundlePath,path.join(workspaceRoot,'.local/nonexistent-fictional-response-bundle.json'));
  assert.equal(config.dataCrypto,undefined); assert.equal(config.workbenchEnabled,false);
  assert.deepEqual(config.modelRoutes,{}); assert.equal(config.safetyDailyModelCallLimit,0);
});
