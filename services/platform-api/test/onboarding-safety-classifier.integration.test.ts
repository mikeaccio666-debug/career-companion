import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { OnboardingAction } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Actual PostgreSQL + actual ai-core HTTP/SSE adapter, redirected exclusively to loopback. No paid calls or clinical claims.
const base = readConfig(), schema = 'onboarding_classifier_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString()); let created = false;
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: '98'.repeat(32) })!;
const store = new OnboardingDrafts(db, { dataCrypto: crypto, requireVerifiedEmail: true }, FICTIONAL_LEGAL);
const profileContent = { schemaVersion: 1, revision: 9, instructions: 'Fictional QA policy only. Classify synthetic examples.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'en-low', language: 'en', level: 'L1', phrases: ['Synthetic risk marker'] },
    { id: 'zh-low', language: 'zh', level: 'L1', phrases: ['虚构风险标记'] },
    { id: 'en-high', language: 'en', level: 'L2', phrases: ['Synthetic highest marker'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable', review: { reference: 'fictional-review-not-professional-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const routeConfig = { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 10 };
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-only', OPENAI_CHAT_MODEL: 'fictional-expensive-chat', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-safety' };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db); await activate((await actor()).userId); });
after(async () => { try { await db.close(); } finally { try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); } } });
const unavailable = (error: unknown) => error instanceof ApiError && error.code === 'ONBOARDING_SAFETY_UNAVAILABLE';
async function actor(): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at) VALUES($1,$2,'Fictional classifier owner','fictional-unused-hash','student',clock_timestamp())`, [userId, userId + '@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, tokenHash(token)]);
  await seedFictionalConsent(db, userId); return { userId, tokenHash: tokenHash(token) };
}
async function activate(userId: string) {
  await db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`, [profile.revision, profile.digest, profile.reviewDigest, userId]);
}
async function save(who: FixedSessionContext, action: OnboardingAction) {
  const draft = await store.read(who); return store.save(who, { expectedRevision: draft?.revision ?? 0, operationId: randomUUID(), action });
}
async function text(who: FixedSessionContext, raw = 'Fictional DS student; program length unstated.') {
  if (!await store.read(who)) await save(who, { kind: 'start', mode: 'standard' });
  const draft = (await store.read(who))!; assert(draft.currentQuestion);
  return save(who, { kind: 'text', questionId: draft.currentQuestion, text: raw });
}
function respond(reply: http.ServerResponse, decision: unknown, overrides: Record<string, unknown> = {}) {
  const event = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }], usage: { input_tokens: 34, output_tokens: 21 }, ...overrides } };
  reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}
const l0 = { level: 'L0', resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } };
async function loopback(handler: (body: Record<string, any>, reply: http.ServerResponse) => Promise<void> | void,
  run: (runner: OnboardingSafetyRunner, bodies: Record<string, any>[]) => Promise<void>,
  options: { env?: NodeJS.ProcessEnv; profile?: typeof profile | null; limit?: number } = {}) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await handler(body, reply); }
    catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env: options.env ?? providerEnv, fetch: (target, init) => { const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com'); return fetch(local + remote.pathname, init); } });
  const runner = new OnboardingSafetyRunner(store, { ...routeConfig, safetyDailyModelCallLimit: options.limit ?? 10 }, runtime, options.profile === undefined ? profile : options.profile);
  try { await run(runner, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function submissions(who: FixedSessionContext) { return (await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision', [who.userId])).rows; }

test('real strict Responses completion becomes full L0 with actual encrypted persistence and one accounted call', async () => {
  const who = await actor(), pending = await text(who);
  await loopback((body, reply) => {
    assert.equal(body.model, 'fictional-safety'); assert.equal(body.max_output_tokens, 100); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []);
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert(body.input.some((message: any) => message.role === 'system' && JSON.stringify(message).includes('你现在读的是什么')));
    assert.equal(JSON.stringify(body).includes(who.userId), false); assert.equal(JSON.stringify(body).includes(pending.operation.id), false);
    respond(reply, l0);
  }, async (runner, bodies) => {
    assert.equal((await runner.runNext(who))?.advanced, true); assert.equal(bodies.length, 1);
    const row = (await submissions(who))[0]; assert.equal(row.status, 'detected'); assert.equal(row.level, 'L0'); assert.equal(row.detector_mode, 'full');
    assert.equal((await store.read(who))?.currentQuestion, 'graduation');
    assert(row.result_ciphertext instanceof Buffer); assert.equal(row.result_ciphertext.includes(Buffer.from('Fictional DS')), false);
    const usage = (await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows;
    assert.equal(usage.length, 1); assert.equal(usage[0].status, 'complete'); assert.equal(usage[0].usage_status, 'reported');
    assert.equal(usage[0].input_tokens, 34); assert.equal(usage[0].output_tokens, 21);
    assert.equal(await runner.runNext(who), null); assert.equal(bodies.length, 1);
  });
});

test('missing profile leaves actual saved text pending without claiming or HTTP', async () => {
  const who = await actor(); await text(who);
  await loopback((_body, _reply) => assert.fail('No model request is authorized.'), async (runner, bodies) => {
    await assert.rejects(runner.runNext(who), unavailable); assert.equal(bodies.length, 0);
    assert.equal((await submissions(who))[0].generation, 0); assert.equal((await store.readSafety(who)).status, 'pending');
  }, { profile: null });
});

test('disabled paid switch retains only actually matched L1/L2 and unmatched text never becomes L0/L1', async () => {
  await loopback((_body, _reply) => assert.fail('No paid HTTP.'), async (runner, bodies) => {
    for (const [raw, level] of [['Synthetic risk marker.', 'L1'], ['虚构风险标记。 Synthetic highest marker.', 'L2']] as const) {
      const who = await actor(); await text(who, raw); await runner.runNext(who);
      const row = (await submissions(who))[0]; assert.equal(row.level, level); assert.equal(row.detector_mode, 'keyword_only'); assert.equal((await store.readSafety(who)).status, 'blocked');
    }
    const who = await actor(); await text(who); await assert.rejects(runner.runNext(who), unavailable);
    const row = (await submissions(who))[0]; assert.equal(row.status, 'pending'); assert.equal(row.level, null); assert.equal(row.result_ciphertext, null);
    assert.equal((await store.read(who))?.state, 'safety_pending'); assert.equal(bodies.length, 0);
  }, { env: { ...providerEnv, PLATFORM_ALLOW_PROVIDER_CALLS: '0' } });
});

test('L2 literal match never waits for enabled model; daily call limit zero preserves local L1 fallback', async () => {
  await loopback((_body, _reply) => assert.fail('No HTTP.'), async (runner, bodies) => {
    const high = await actor(); await text(high, 'Synthetic highest marker.'); await runner.runNext(high);
    assert.equal((await submissions(high))[0].level, 'L2');
    const low = await actor(); await text(low, 'Synthetic risk marker.'); await runner.runNext(low);
    assert.equal((await submissions(low))[0].detector_mode, 'keyword_only');
    assert.equal(bodies.length, 0);
  }, { limit: 0 });
});

test('full completion merges reviewed L1 above a model L0 instead of approving the answer', async () => {
  const who = await actor(); await text(who, 'Synthetic risk marker; fictional DS.');
  await loopback((_body, reply) => respond(reply, l0), async (runner, bodies) => {
    await runner.runNext(who); const row = (await submissions(who))[0]; assert.equal(row.level, 'L1'); assert.equal(row.detector_mode, 'full');
    assert.equal((await store.read(who))?.currentQuestion, 'study'); assert.equal((await store.read(who))?.answersPartial.study, undefined); assert.equal(bodies.length, 1);
  });
});

test('refusal and malformed results use actual keyword fallback; no-hit failure stays pending', async () => {
  for (const raw of ['Synthetic risk marker.', 'Fictional ordinary note.']) {
    const who = await actor(); await text(who, raw);
    await loopback((_body, reply) => respond(reply, l0, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Fictional refusal.' }] }] }), async runner => {
      if (raw.startsWith('Synthetic')) { await runner.runNext(who); assert.equal((await submissions(who))[0].detector_mode, 'keyword_only'); }
      else { await assert.rejects(runner.runNext(who), unavailable); assert.equal((await submissions(who))[0].level, null); }
    });
  }
  const who = await actor(); await text(who);
  await loopback((_body, reply) => respond(reply, { ...l0, hidden: 'forbidden' }), async runner => {
    await assert.rejects(runner.runNext(who), unavailable); assert.equal((await submissions(who))[0].status, 'pending');
  });
});

test('domain rejects an impossible graduation month even when JSON schema is structurally valid', async () => {
  const who = await actor(); await save(who, { kind: 'start', mode: 'standard' }); await save(who, { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: null } }); await text(who, 'Fictional invalid date.');
  await loopback((_body, reply) => respond(reply, { level: 'L0', resolution: { kind: 'answer', questionId: 'graduation', value: { month: '2026-19', graduated: false } } }), async runner => {
    await assert.rejects(runner.runNext(who), unavailable); assert.equal((await store.read(who))?.currentQuestion, 'graduation'); assert.equal((await submissions(who))[0].result_ciphertext, null);
  });
});

test('real HTTP timeout falls back to matched L1 before outer deadline without inventing a full result', async () => {
  const who = await actor(); await text(who, 'Synthetic risk marker.');
  let closed = false;
  await loopback((_body, reply) => { reply.on('close', () => { closed = true; }); }, async (runner, bodies) => {
    await runner.runNext(who); assert.equal(bodies.length, 1); const row = (await submissions(who))[0]; assert.equal(row.level, 'L1'); assert.equal(row.detector_mode, 'keyword_only');
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, true);
  });
});

test('policy changed after admitted HTTP cannot accept the prior profile completion', async () => {
  const who = await actor(); await text(who);
  await loopback(async (_body, reply) => { await db.query('UPDATE platform_safety_detector_policy SET review_digest=$1 WHERE singleton=true', ['a'.repeat(64)]); respond(reply, l0); }, async runner => {
    await assert.rejects(runner.runNext(who), unavailable); const row = (await submissions(who))[0]; assert.equal(row.status, 'pending'); assert.equal(row.result_ciphertext, null);
  });
  await activate(who.userId);
});

test('auth revocation during actual HTTP fences persistence while accounting still records existing real usage', async () => {
  const who = await actor(); await text(who);
  await loopback(async (_body, reply) => { await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]); respond(reply, l0); }, async runner => {
    await assert.rejects(runner.runNext(who), error => error instanceof ApiError);
    const row = (await submissions(who))[0]; assert.equal(row.result_ciphertext, null); assert.equal(row.level, null);
    const usage = (await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows[0]; assert.equal(usage.status, 'complete'); assert.equal(usage.usage_status, 'reported');
  });
});

test('concurrent server runners launch at most one actual HTTP call for a generation', async () => {
  const who = await actor(); await text(who);
  await loopback((_body, reply) => respond(reply, l0), async (runner, bodies) => {
    const receipts = await Promise.all([runner.runNext(who), runner.runNext(who)]); assert.equal(receipts.filter(Boolean).length, 1); assert.equal(bodies.length, 1); assert.equal((await submissions(who))[0].generation, 1);
  });
});
