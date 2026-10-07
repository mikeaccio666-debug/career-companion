import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { accountUsage, chatAccounting } from '../src/chat-usage.ts';
import { acquireRuntimeLease, recoverStaleStreams } from '../src/runtime-leases.ts';

const prefix = '/api/platform', origin = 'http://localhost:4321';
const base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'usage-fixture', PLATFORM_AGENT_PROVIDER: 'usage-fixture' }), schema = `chat_usage_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
let system: Awaited<ReturnType<typeof buildApp>>, directory: string, registrations = 0, httpOrigin: string;
let started: (() => void) | undefined;
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'usage-fixture', name: 'Synthetic call accounting', keyConfigured: true, enabled: true,
    capabilities: ['chat', 'agent'], models: ['synthetic-model'], envVariables: [] }],
  async *streamChat(input, context) {
    const prompt = input.messages.at(-1)?.content;
    if (prompt === 'legacy-invalid') { yield { type: 'usage', inputTokens: -1, outputTokens: 1.2 }; yield { type: 'delta', text: 'Synthetic legacy reply' }; return; }
    if (prompt === 'legacy-valid') { yield { type: 'usage', inputTokens: 12, outputTokens: 4 }; yield { type: 'delta', text: 'Synthetic legacy reply' }; return; }
    for (let index = 1; index <= (prompt === 'multi' ? 2 : 1); index++) {
      const callId = randomUUID();
      await context?.onModelCall?.({ type: 'started', callId, index, provider: input.provider, model: 'synthetic-model' });
      if (prompt === 'wait') {
        try {
          yield { type: 'delta', text: 'Synthetic unfinished reply' }; started?.();
          await new Promise<void>(resolve => {
            if (context?.signal?.aborted) resolve(); else context?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          context?.signal?.throwIfAborted();
        } finally {
          await context?.onModelCall?.({ type: 'finished', callId, status: 'cancelled', usage: { status: 'missing' } });
        }
        return;
      }
      const usage = prompt === 'multi' && index === 2 ? { status: 'missing' as const }
        : prompt === 'invalid' ? { status: 'invalid' as const }
          : { status: 'reported' as const, inputTokens: prompt === 'zero' ? 0 : 12, outputTokens: prompt === 'zero' ? 0 : 4 };
      const finish = { type: 'finished' as const, callId, status: prompt === 'failed-report' ? 'failed' as const : 'complete' as const, usage };
      await context?.onModelCall?.(finish);
      if (prompt === 'duplicate') await context?.onModelCall?.(finish);
      if (usage.status === 'reported') yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      if (prompt === 'failed-report') throw new Error('synthetic-provider-private-detail');
    }
    yield { type: 'delta', text: 'Synthetic recorded reply' };
  },
  executeJob: async () => ({ artifacts: [] }), createVoiceSession: async () => { throw new Error('Not configured'); },
  transcribe: async () => ({ text: '' }), speech: async () => ({ name: 'synthetic.wav', mime: 'audio/wav', bytes: new Uint8Array() }),
};
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'Only a local test database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-chat-usage-'));
  system = await buildApp({ db, runtime, enableQueue: false, config: { ...base, databaseUrl: url.toString(), storageDir: directory } });
  httpOrigin = await system.app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => { await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function register() {
  const response = await system.app.inject({ method: 'POST', url: prefix + '/auth/register', remoteAddress: `127.0.0.${++registrations}`,
    headers: { origin }, payload: { name: 'Synthetic usage tester', email: `${randomUUID()}@example.invalid`, password: 'Synthetic-usage-password-2026' } });
  assert.equal(response.statusCode, 201, response.body);
  return { userId: response.json().user.id as string, cookie: String(response.headers['set-cookie']).split(';')[0] };
}
type Actor = Awaited<ReturnType<typeof register>>;
async function request(actor: Actor, method: 'GET' | 'POST' | 'DELETE', route: string, payload?: unknown) {
  return system.app.inject({ method, url: prefix + route, headers: { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.userId, origin }, payload: payload as any });
}
async function conversation(actor: Actor) {
  const result = await request(actor, 'POST', '/conversations', { title: 'Synthetic usage conversation' });
  assert.equal(result.statusCode, 201, result.body); return result.json().conversation.id as string;
}
async function chat(actor: Actor, content: string, mode = 'chat') {
  const id = await conversation(actor), result = await request(actor, 'POST', `/conversations/${id}/messages`, { content, mode });
  assert.equal(result.statusCode, 200, result.body); return { id, result };
}
async function summary(actor: Actor) {
  const result = await request(actor, 'GET', '/usage'); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['cache-control'], 'private, no-store'); return result.json().usage;
}
async function activeBinding(actor: Actor) {
  const id = await conversation(actor), messageId = randomUUID();
  await db.transaction(async client => {
    await acquireRuntimeLease(client, actor.userId, 'chat', messageId);
    await client.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status,provider,model,lease_until)
      VALUES($1,$2,'assistant','','streaming','usage-fixture','synthetic-model',now()+interval '2 minutes')`, [messageId, id]);
  });
  const binding = { userId: actor.userId, conversationId: id, messageId, provider: 'usage-fixture', model: 'synthetic-model' };
  return { binding, record: chatAccounting(db, binding) };
}

test('usage is authenticated, owner scoped, current UTC month and private', async () => {
  const anonymous = await system.app.inject({ method: 'GET', url: prefix + '/usage' }); assert.equal(anonymous.statusCode, 401);
  const alice = await register(), bob = await register(); await chat(alice, 'multi', 'agent');
  const own = await summary(alice), empty = await summary(bob);
  assert.equal(own.chat.calls, 2); assert.equal(own.chat.reportedCalls, 1); assert.equal(own.chat.missingCalls, 1);
  assert.equal(own.chat.coverage, 'partial'); assert.equal(own.chat.inputTokens, 12); assert.equal(own.chat.outputTokens, 4);
  assert.equal(own.chat.legacyReports, 0); assert.equal(empty.chat.calls, 0); assert.equal(empty.chat.inputTokens, null);
  assert.equal(own.period.timeZone, 'UTC'); assert.match(own.period.from, /-01T00:00:00\.000Z$/);
  assert.deepEqual(own.chat.providers, [{ provider: 'usage-fixture', model: 'synthetic-model', calls: 2, reportedCalls: 1, inputTokens: 12, outputTokens: 4 }]);
  assert.equal((await request(bob, 'GET', `/usage?userId=${alice.userId}`)).statusCode, 400);
  assert(!JSON.stringify(own).includes('Synthetic usage conversation')); assert(!JSON.stringify(own).includes(alice.userId));
});

test('actual zero, invalid reports and legacy reports are distinct and never guessed', async () => {
  const zero = await register(); await chat(zero, 'zero');
  assert.equal((await summary(zero)).chat.inputTokens, 0); assert.equal((await summary(zero)).chat.coverage, 'complete');
  const invalid = await register(); await chat(invalid, 'invalid'); await chat(invalid, 'legacy-invalid');
  const invalidUsage = (await summary(invalid)).chat;
  assert.equal(invalidUsage.inputTokens, null); assert.equal(invalidUsage.invalidCalls, 1); assert.equal(invalidUsage.legacyReports, 0);
  const legacy = await register(); await chat(legacy, 'legacy-valid');
  const old = (await summary(legacy)).chat; assert.equal(old.calls, 0); assert.equal(old.inputTokens, null); assert.equal(old.legacyReports, 1);
});

test('duplicate final reports are idempotent and failed replies retain reported counts', async () => {
  const actor = await register(); await chat(actor, 'duplicate'); const failed = await chat(actor, 'failed-report');
  assert.match(failed.result.body, /event: error/); assert(!failed.result.body.includes('synthetic-provider-private-detail'));
  const value = (await summary(actor)).chat;
  assert.equal(value.calls, 2); assert.equal(value.reportedCalls, 2); assert.equal(value.inputTokens, 24); assert.equal(value.outcomes.failed, 1);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM platform_usage WHERE user_id=$1', [actor.userId])).rows[0].n, 0);
});

test('accounting rejects ownership, lease, index, model and malformed count changes', async () => {
  const actor = await register(), other = await register(), active = await activeBinding(actor), callId = randomUUID();
  const start = { type: 'started' as const, callId, index: 1, provider: 'usage-fixture', model: 'synthetic-model' };
  await assert.rejects(chatAccounting(db, { ...active.binding, userId: other.userId })(start));
  await assert.rejects(active.record({ ...start, model: 'different-model' }));
  await assert.rejects(active.record({ ...start, index: 7 }));
  await active.record(start); await active.record(start);
  for (const inputTokens of [-1, 1.2, Infinity, 2_147_483_648, '12']) {
    await assert.rejects(active.record({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens, outputTokens: 1 } } as any));
  }
  const finish = { type: 'finished' as const, callId, status: 'complete' as const, usage: { status: 'reported' as const, inputTokens: 12, outputTokens: 4 } };
  await active.record(finish); await active.record(finish);
  await assert.rejects(active.record({ ...finish, usage: { ...finish.usage, inputTokens: 13 } }));
  await db.query("UPDATE platform_messages SET lease_until=now()-interval '1 second' WHERE id=$1", [active.binding.messageId]);
  await assert.rejects(active.record({ ...start, callId: randomUUID(), index: 2 }));
  assert.equal((await summary(actor)).chat.inputTokens, 12);
});

test('real HTTP disconnect cancels a pending call and releases its runtime lease', async () => {
  const actor = await register(), id = await conversation(actor), abort = new AbortController();
  const begin = new Promise<void>(resolve => { started = resolve; });
  const response = await fetch(httpOrigin + prefix + `/conversations/${id}/messages`, { method: 'POST', headers: { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.userId, origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'wait', mode: 'chat' }), signal: abort.signal });
  assert.equal(response.status, 200); await begin;
  const pending = (await summary(actor)).chat; assert.equal(pending.pendingCalls, 1); assert.equal(pending.inputTokens, null);
  const reader = response.body!.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {}); reader.releaseLock();
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await summary(actor);
    const leases = (await db.query('SELECT count(*)::integer AS n FROM platform_runtime_leases WHERE user_id=$1', [actor.userId])).rows[0].n;
    if (current.chat.outcomes.cancelled === 1 && leases === 0) {
      assert.equal(current.chat.missingCalls, 1); assert.equal(current.chat.pendingCalls, 0);
      assert.equal(leases, 0);
      started = undefined; return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The HTTP cancellation did not settle its call ledger.');
});

test('stale recovery preserves known reports and labels abandoned calls interrupted', async () => {
  const actor = await register(); await chat(actor, 'zero');
  const active = await activeBinding(actor), callId = randomUUID();
  await active.record({ type: 'started', callId, index: 1, provider: 'usage-fixture', model: 'synthetic-model' });
  await db.query("UPDATE platform_messages SET lease_until=now()-interval '1 second' WHERE id=$1", [active.binding.messageId]);
  await recoverStaleStreams(db); await recoverStaleStreams(db);
  const value = (await summary(actor)).chat; assert.equal(value.calls, 2); assert.equal(value.reportedCalls, 1); assert.equal(value.inputTokens, 0);
  assert.equal(value.outcomes.interrupted, 1); assert.equal(value.missingCalls, 1);
  // The still-live trusted runtime may supply a late terminal report; recovery must not erase it.
  await active.record({ type: 'finished', callId, status: 'cancelled', usage: { status: 'reported', inputTokens: 8, outputTokens: 2 } });
  assert.equal((await summary(actor)).chat.inputTokens, 8);
});

test('deleting a conversation retains owner accounting without keeping content or identifiers', async () => {
  const actor = await register(), active = await activeBinding(actor), callId = randomUUID();
  await active.record({ type: 'started', callId, index: 1, provider: 'usage-fixture', model: 'synthetic-model' });
  assert.equal((await request(actor, 'DELETE', `/conversations/${active.binding.conversationId}`)).statusCode, 200);
  await active.record({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens: 9, outputTokens: 2 } });
  const row = (await db.query('SELECT * FROM platform_chat_calls WHERE id=$1', [callId])).rows[0];
  assert.equal(row.message_id, null); assert.equal(row.conversation_id, null); assert.equal(row.input_tokens, 9);
  assert(!('content' in row)); assert.equal((await summary(actor)).chat.calls, 1);
});

test('month aggregation excludes other periods and realtime session placeholders', async () => {
  const actor = await register(); await chat(actor, 'zero');
  await db.query("UPDATE platform_chat_calls SET created_at='2026-01-31T23:59:59Z' WHERE user_id=$1", [actor.userId]);
  await db.query("INSERT INTO platform_usage(id,user_id,provider,capability) VALUES($1,$2,'synthetic-voice','realtime')", [randomUUID(), actor.userId]);
  const january = await accountUsage(db, actor.userId, new Date('2026-01-31T23:59:59Z'));
  const february = await accountUsage(db, actor.userId, new Date('2026-02-01T00:00:00Z'));
  assert.equal(january.chat.calls, 1); assert.equal(february.chat.calls, 0); assert.equal(february.chat.inputTokens, null);
  assert.equal((await summary(actor)).chat.legacyReports, 0);
});
