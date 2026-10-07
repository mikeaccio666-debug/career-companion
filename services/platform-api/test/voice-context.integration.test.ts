import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLATFORM_ACCOUNT_HEADER, VOICE_CONTEXT_LIMITS, type PlatformProviderRuntime, type VoiceSessionInput } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { readVoiceContext } from '../src/voice-context.ts';
import { authorizeFixedSession, tokenHash } from '../src/auth.ts';

const prefix = '/api/platform', origin = 'http://localhost:4321', base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'voice-fixture', PLATFORM_AGENT_PROVIDER: 'voice-fixture', PLATFORM_REALTIME_PROVIDER: 'voice-fixture', PLATFORM_TRANSCRIPTION_PROVIDER: 'voice-fixture', PLATFORM_SPEECH_PROVIDER: 'voice-fixture' ,PLATFORM_REQUIRE_INVITE:'1'});
const schema = `voice_context_${randomUUID().replaceAll('-', '')}`, admin = new Database(base.databaseUrl);
const url = new URL(base.databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
type Gate = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
let issuerGate: Gate | undefined, persistedGate: Gate | undefined;
let accountGate: (Gate & { remaining: number }) | undefined;
class GatedDatabase extends Database {
  override async query(text: string, values: unknown[] = []) {
    if (accountGate && text.startsWith('SELECT u.id,u.email,u.name')) {
      const gate = accountGate;
      if (--gate.remaining === 0) { accountGate = undefined; gate.entered.resolve(); await gate.release.promise; }
    }
    if (persistedGate && text === 'UPDATE platform_usage SET model=$3 WHERE id=$1 AND user_id=$2') {
      const gate = persistedGate; gate.entered.resolve(); await gate.release.promise;
    }
    return super.query(text, values);
  }
}
const db = new GatedDatabase(url.toString()), issuedInputs: VoiceSessionInput[] = [];
const forbidden = async (): Promise<never> => { throw new Error('No model or media calls are used in this fixture.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'voice-fixture', name: 'Synthetic context issuer', enabled: true, keyConfigured: true, capabilities: ['realtime'], models: ['synthetic-voice'], voiceOptions: { speech: { voices: ['synthetic-voice'], defaultVoice: 'synthetic-voice' }, realtime: { voices: ['synthetic-voice'], defaultVoice: 'synthetic-voice', turnTaking: true } }, envVariables: [] }],
  async *streamChat() { throw new Error('No chat model is used.'); }, executeJob: forbidden, transcribe: forbidden, speech: forbidden,
  async createVoiceSession(input) {
    issuedInputs.push({ ...input });
    if (issuerGate) { const gate = issuerGate; gate.entered.resolve(); await gate.release.promise; }
    return { clientSecret: 'synthetic-credential-never-persist', model: 'synthetic-voice', endpoint: 'https://synthetic-voice.invalid/calls' };
  },
};
let system: Awaited<ReturnType<typeof buildApp>>, directory: string, registrations = 0;
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); await seedFictionalActiveLegal(db);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-voice-context-'));
  system = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config: { ...base, databaseUrl: url.toString(), storageDir: directory }, runtime, enableQueue: false });
});
after(async () => {
  issuerGate?.release.resolve(); persistedGate?.release.resolve(); accountGate?.release.resolve();
  await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
interface Actor { id: string; cookie: string; ip: string; }
async function register(): Promise<Actor> {
  const ip = `127.7.0.${++registrations}`;
  const response = await system.app.inject({ method: 'POST', url: prefix + '/auth/register', remoteAddress: ip, headers: { origin }, payload: await fictionalRegistration(db,{ name: 'Synthetic voice-context tester', email: `${randomUUID()}@example.invalid`, password: 'Fictional-voice-context-2026' }) });
  assert.equal(response.statusCode, 201, response.body);
  return { id: response.json().user.id, cookie: String(response.headers['set-cookie']).split(';')[0], ip };
}
async function request(actor: Actor, method: 'GET' | 'POST' | 'DELETE', route: string, payload?: Record<string, unknown>, expectedAccount = actor.id) {
  return system.app.inject({ method, url: prefix + route, remoteAddress: actor.ip, headers: { origin, cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: expectedAccount }, payload });
}
async function conversation(actor: Actor) {
  const response = await request(actor, 'POST', '/conversations', { title: 'Synthetic text handoff' });
  assert.equal(response.statusCode, 201, response.body); return response.json().conversation.id as string;
}
async function message(conversationId: string, text: string, options: { role?: string; status?: string; attachments?: unknown[]; audio?: unknown[] } = {}) {
  const id = randomUUID();
  await db.query('INSERT INTO platform_messages(id,conversation_id,role,content,status,attachments,audio_transcripts) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, conversationId, options.role ?? 'user', text, options.status ?? 'complete', JSON.stringify(options.attachments ?? []), JSON.stringify(options.audio ?? [])]);
  return id;
}
async function start(actor: Actor, conversationId?: string) {
  return request(actor, 'POST', '/voice/session', { ...(conversationId ? { conversationId } : {}) });
}
async function release(actor: Actor, sessionId: string) { assert.equal((await request(actor, 'POST', '/voice/session/release', { sessionId })).statusCode, 200); }
async function counts(actor: Actor) {
  const leases = (await db.query('SELECT count(*)::int AS n FROM platform_runtime_leases WHERE user_id=$1', [actor.id])).rows[0].n;
  const markers = (await db.query('SELECT count(*)::int AS n FROM platform_voice_sessions WHERE user_id=$1', [actor.id])).rows[0].n;
  const usage = (await db.query('SELECT count(*)::int AS n FROM platform_usage WHERE user_id=$1', [actor.id])).rows[0].n;
  return { leases, markers, usage };
}

test('an explicit owner snapshot preserves complete text order without sending history or identity to the issuer', async () => {
  const actor = await register(), id = await conversation(actor);
  const first = await message(id, 'Synthetic user observation'), second = await message(id, 'Synthetic assistant explanation', { role: 'assistant' });
  const before = issuedInputs.length, response = await request(actor, 'POST', '/voice/session', { conversationId: id.toUpperCase() });
  assert.equal(response.statusCode, 200, response.body); const result = response.json();
  assert.deepEqual(result.serverContext, { source: 'server_conversation', conversationId: id, items: [{ messageId: first, role: 'user', text: 'Synthetic user observation' }, { messageId: second, role: 'assistant', text: 'Synthetic assistant explanation' }], truncated: false });
  assert.deepEqual(issuedInputs[before], { provider: 'voice-fixture', model: 'synthetic-voice', voice: 'synthetic-voice', turnTaking: 'patient' });
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const marker = (await db.query('SELECT * FROM platform_voice_sessions WHERE id=$1', [result.sessionId])).rows[0];
  assert.equal(marker.conversation_id, id); assert.equal(marker.user_id, actor.id);
  for (const secret of ['Synthetic user observation', 'synthetic-credential-never-persist', 'synthetic-voice.invalid']) assert(!JSON.stringify(marker).includes(secret));
  const snapshot = await db.transaction(client => readVoiceContext(client, actor.id, id));
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.items)); assert(snapshot.items.every(Object.isFrozen));
  await release(actor, result.sessionId);
});

test('complete blank, tool, streaming and unsuccessful rows are excluded without claiming lost eligible history', async () => {
  const actor = await register(), id = await conversation(actor);
  const retained = await message(id, 'Synthetic retained text');
  for (const text of ['', ' \t\r\n ', '\u00a0\u2003\u2028\ufeff']) await message(id, text);
  await message(id, 'Synthetic tool output', { role: 'tool' });
  for (const status of ['streaming', 'failed', 'cancelled']) await message(id, `Synthetic ${status} output`, { role: 'assistant', status });
  await db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)', [randomUUID(), actor.id, 'Synthetic separate memory']);
  const saved = await request(actor, 'POST', `/conversations/${id}/voice-records`, { clientRecordId: randomUUID(), source: 'transcription_excerpt', role: 'user', text: 'Synthetic selected voice excerpt' });
  assert.equal(saved.statusCode, 201, saved.body);
  const response = await start(actor, id); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().serverContext.items, [{ messageId: retained, role: 'user', text: 'Synthetic retained text' }]);
  assert.equal(response.json().serverContext.truncated, false); await release(actor, response.json().sessionId);
});

test('a whole message carrying any file or audio reference is omitted and disclosed', async () => {
  const actor = await register(), id = await conversation(actor), retained = await message(id, 'Synthetic plain text');
  await message(id, 'Synthetic file-dependent caption', { attachments: [{ id: randomUUID(), mime: 'text/plain' }] });
  await message(id, 'Synthetic audio-dependent analysis', { role: 'assistant', audio: [{ transcriptionId: randomUUID() }] });
  const response = await start(actor, id); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().serverContext.items, [{ messageId: retained, role: 'user', text: 'Synthetic plain text' }]);
  assert.equal(response.json().serverContext.truncated, true); await release(actor, response.json().sessionId);
});

test('empty owned conversations and the legacy unbound request remain valid without inventing context', async () => {
  const actor = await register(), id = await conversation(actor);
  const empty = await start(actor, id); assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().serverContext, { source: 'server_conversation', conversationId: id, items: [], truncated: false }); await release(actor, empty.json().sessionId);
  const unbound = await start(actor); assert.equal(unbound.statusCode, 200, unbound.body); assert.equal(unbound.json().serverContext, undefined);
  assert.equal((await db.query('SELECT conversation_id FROM platform_voice_sessions WHERE id=$1', [unbound.json().sessionId])).rows[0].conversation_id, null);
  await release(actor, unbound.json().sessionId);
});

test('the newest twenty eligible messages are returned in original order with an accurate truncation flag', async () => {
  const actor = await register(), id = await conversation(actor), expected = [];
  for (let index = 0; index < VOICE_CONTEXT_LIMITS.messages + 1; index++) { const text = `Synthetic message ${index}`; expected.push({ messageId: await message(id, text), role: 'user', text }); }
  const response = await start(actor, id); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().serverContext.items, expected.slice(1)); assert.equal(response.json().serverContext.truncated, true);
  await release(actor, response.json().sessionId);
});

test('Unicode code points and the combined UTF-8 byte bound are enforced without partially cutting messages', async () => {
  const actor = await register(), id = await conversation(actor);
  await message(id, 'a'.repeat(VOICE_CONTEXT_LIMITS.messageCharacters + 1));
  await message(id, '😀'.repeat(VOICE_CONTEXT_LIMITS.textBytes / 4 + 1));
  const exactText = '😀'.repeat(VOICE_CONTEXT_LIMITS.textBytes / 4), retained = await message(id, exactText);
  const response = await start(actor, id); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().serverContext.items, [{ messageId: retained, role: 'user', text: exactText }]); assert.equal(response.json().serverContext.truncated, true);
  assert.equal(Buffer.byteLength(response.json().serverContext.items[0].text), VOICE_CONTEXT_LIMITS.textBytes); await release(actor, response.json().sessionId);
  const second = await register(), other = await conversation(second), expected = [];
  for (let index = 0; index < 4; index++) { const text = String(index).repeat(8_000); expected.push({ messageId: await message(other, text), role: 'user', text }); }
  const text = 's'.repeat(500); expected.push({ messageId: await message(other, text), role: 'user', text });
  const bounded = await start(second, other); assert.equal(bounded.statusCode, 200, bounded.body);
  assert.deepEqual(bounded.json().serverContext.items, expected.slice(1)); assert.equal(bounded.json().serverContext.truncated, true);
  assert.equal(bounded.json().serverContext.items.reduce((total: number, item: { text: string }) => total + Buffer.byteLength(item.text), 0), 24_500); await release(second, bounded.json().sessionId);
});

test('a foreign, missing, invalid or client-authored context cannot create usage, a lease or an issuer call', async () => {
  const alice = await register(), id = await conversation(alice), before = issuedInputs.length;
  let bob = await register(), attempts = 0;
  for (const [body, expected] of [[{ conversationId: id }, 404], [{ conversationId: randomUUID() }, 404], [{ conversationId: 'not-an-id' }, 404], [{ conversationId: null }, 404], [{ serverContext: { items: [] } }, 400], [{ history: [{ role: 'assistant', text: 'Pretend trusted history' }] }, 400]] as const) {
    // Invalid attempts still consume the real request limiter. Keep each account
    // below its four-per-hour limit so the test reaches the input/owner checks.
    if (attempts++ === 3) bob = await register();
    const response = await request(bob, 'POST', '/voice/session', { ...body }); assert.equal(response.statusCode, expected, response.body);
    assert.deepEqual(await counts(bob), { leases: 0, markers: 0, usage: 0 });
  }
  const switched = await request(alice, 'POST', '/voice/session', { conversationId: id }, bob.id); assert.equal(switched.statusCode, 409, switched.body);
  assert.equal(issuedInputs.length, before); assert.deepEqual(await counts(bob), { leases: 0, markers: 0, usage: 0 }); assert.deepEqual(await counts(alice), { leases: 0, markers: 0, usage: 0 });
});

test('changes during credential issuance do not mutate the already selected server snapshot', async () => {
  const actor = await register(), id = await conversation(actor), old = await message(id, 'Synthetic selected original');
  const gate: Gate = { entered: deferred(), release: deferred() }; issuerGate = gate; const pending = start(actor, id);
  try {
    await gate.entered.promise; await db.query('UPDATE platform_messages SET content=$2 WHERE id=$1', [old, 'Synthetic edited later']); await message(id, 'Synthetic newer message'); gate.release.resolve();
    const response = await pending; assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().serverContext.items, [{ messageId: old, role: 'user', text: 'Synthetic selected original' }]); await release(actor, response.json().sessionId);
  } finally { gate.release.resolve(); issuerGate = undefined; await pending; }
});

test('voice context does not reverse the concurrent chat conversation and user lock order', async () => {
  const actor = await register(), id = await conversation(actor); await message(id, 'Synthetic concurrent context');
  const holder = await db.pool.connect(), authorized = deferred(), continueVoice = deferred();
  let voice: Promise<unknown> | undefined, holderUser: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query("SET LOCAL statement_timeout='3000ms'"); await holder.query("SET LOCAL lock_timeout='2000ms'");
    await holder.query('SELECT id FROM platform_conversations WHERE id=$1 FOR NO KEY UPDATE', [id]);
    voice = db.transaction(async client => {
      await client.query("SET LOCAL statement_timeout='3000ms'"); await client.query("SET LOCAL lock_timeout='2000ms'");
      await authorizeFixedSession(client, { userId: actor.id, tokenHash: tokenHash(actor.cookie.split('=')[1]) });
      authorized.resolve(); await continueVoice.promise;
      return readVoiceContext(client, actor.id, id);
    });
    await authorized.promise;
    // The chat transaction now waits for voice's user lock. Voice must still be
    // able to inspect the conversation before chat releases its conversation lock.
    holderUser = holder.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [actor.id]);
    continueVoice.resolve(); const [snapshot] = await Promise.all([voice, holderUser]);
    assert.deepEqual(snapshot, { source: 'server_conversation', conversationId: id, items: [{ messageId: (await db.query('SELECT id FROM platform_messages WHERE conversation_id=$1', [id])).rows[0].id, role: 'user', text: 'Synthetic concurrent context' }], truncated: false });
  } finally {
    continueVoice.resolve(); await holder.query('ROLLBACK'); holder.release();
    await Promise.allSettled([voice, holderUser].filter((pending): pending is Promise<unknown> => !!pending));
  }
});

test('deleting the bound conversation while issuance is pending rejects the credential and releases its lease', async () => {
  const actor = await register(), id = await conversation(actor); await message(id, 'Synthetic deleted history');
  const gate: Gate = { entered: deferred(), release: deferred() }; issuerGate = gate; const pending = start(actor, id);
  try {
    await gate.entered.promise; assert.equal((await counts(actor)).leases, 1);
    assert.equal((await request(actor, 'DELETE', `/conversations/${id}`)).statusCode, 200); gate.release.resolve();
    const response = await pending; assert.equal(response.statusCode, 404, response.body); assert(!response.body.includes('synthetic-credential-never-persist'));
    assert.deepEqual(await counts(actor), { leases: 0, markers: 0, usage: 1 });
  } finally { gate.release.resolve(); issuerGate = undefined; await pending; }
});

test('deleting the conversation after a marker insert still rejects delivery and cleans the remaining lease', async () => {
  const actor = await register(), id = await conversation(actor);
  const gate: Gate = { entered: deferred(), release: deferred() }; persistedGate = gate; const pending = start(actor, id);
  try {
    await gate.entered.promise; assert.deepEqual(await counts(actor), { leases: 1, markers: 1, usage: 1 });
    assert.equal((await request(actor, 'DELETE', `/conversations/${id}`)).statusCode, 200); gate.release.resolve();
    const response = await pending; assert.equal(response.statusCode, 404, response.body); assert.deepEqual(await counts(actor), { leases: 0, markers: 0, usage: 1 });
  } finally { gate.release.resolve(); persistedGate = undefined; await pending; }
});

test('logout, expiry and authentication-version changes during issuance cannot return a credential or owned history', async () => {
  for (const revoke of ['logout', 'expiry', 'version'] as const) {
    const actor = await register(), id = await conversation(actor); await message(id, 'Synthetic revoked-account history');
    const gate: Gate = { entered: deferred(), release: deferred() }; issuerGate = gate; const pending = start(actor, id);
    try {
      await gate.entered.promise;
      if (revoke === 'logout') assert.equal((await request(actor, 'POST', '/auth/logout', {})).statusCode, 200);
      else if (revoke === 'expiry') await db.query("UPDATE platform_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenHash(actor.cookie.split('=')[1])]);
      else await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [actor.id]);
      gate.release.resolve(); const response = await pending; assert.equal(response.statusCode, 401, response.body);
      for (const sensitive of ['synthetic-credential-never-persist', 'Synthetic revoked-account history']) assert(!response.body.includes(sensitive));
      assert.deepEqual(await counts(actor), { leases: 0, markers: 0, usage: 1 });
    } finally { gate.release.resolve(); issuerGate = undefined; await pending; }
  }
});

test('revocation after lease acquisition is rechecked before the issuer is called', async () => {
  const actor = await register(), id = await conversation(actor), before = issuedInputs.length;
  const gate = { entered: deferred(), release: deferred(), remaining: 3 }; accountGate = gate; const pending = start(actor, id);
  try {
    await gate.entered.promise; assert.equal((await counts(actor)).leases, 1);
    await db.query('DELETE FROM platform_sessions WHERE user_id=$1', [actor.id]); gate.release.resolve();
    const response = await pending; assert.equal(response.statusCode, 401, response.body); assert.equal(issuedInputs.length, before);
    assert.deepEqual(await counts(actor), { leases: 0, markers: 0, usage: 1 });
  } finally { gate.release.resolve(); accountGate = undefined; await pending; }
});

test('bound voice excerpts can only be saved to that conversation, while unbound sessions retain compatibility', async () => {
  const actor = await register(), id = await conversation(actor), other = await conversation(actor), response = await start(actor, id);
  assert.equal(response.statusCode, 200, response.body); const sessionId = response.json().sessionId; await release(actor, sessionId);
  const excerpt = { clientRecordId: randomUUID(), source: 'realtime_transcript', role: 'assistant', text: 'Synthetic user-reviewed voice text', sessionId };
  assert.equal((await request(actor, 'POST', `/conversations/${other}/voice-records`, excerpt)).statusCode, 404);
  const saved = await request(actor, 'POST', `/conversations/${id}/voice-records`, excerpt); assert.equal(saved.statusCode, 201, saved.body); assert.equal(saved.json().record.provenance, 'client_submitted');
  assert.equal((await request(actor, 'DELETE', `/conversations/${id}`)).statusCode, 200);
  assert.equal((await db.query('SELECT id FROM platform_voice_sessions WHERE id=$1', [sessionId])).rowCount, 0);
  assert.equal((await db.query('SELECT id FROM platform_voice_records WHERE session_id=$1', [sessionId])).rowCount, 0);
  const unbound = await start(actor); assert.equal(unbound.statusCode, 200, unbound.body); await release(actor, unbound.json().sessionId);
  const legacy = await request(actor, 'POST', `/conversations/${other}/voice-records`, { ...excerpt, clientRecordId: randomUUID(), sessionId: unbound.json().sessionId }); assert.equal(legacy.statusCode, 201, legacy.body);
});

test('the appended migration can be reapplied and retains the conversation cascade and history index', async () => {
  const sql = await fs.readFile(new URL('../migrations/023_voice_session_context.sql', import.meta.url), 'utf8');
  await db.query(sql); await db.query(sql);
  const foreignKey = await db.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='platform_voice_sessions'::regclass AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='platform_voice_sessions'::regclass AND attname='conversation_id')]::smallint[]");
  assert.equal(foreignKey.rows[0].confdeltype, 'c');
  assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='platform_messages_voice_context'")).rowCount, 1);
});
