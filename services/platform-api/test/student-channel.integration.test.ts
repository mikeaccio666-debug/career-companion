import { seedFictionalConsent } from './fixtures/student-entry.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InjectOptions } from 'fastify';
import type { PoolClient } from 'pg';
import { PLATFORM_ACCOUNT_HEADER, type ChatInput, type PlatformProviderRuntime, type VoiceSessionInput } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { tokenHash } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { createWorkflowTemplate } from '../src/workflow-templates.ts';

const origin = 'http://localhost:4321', prefix = '/api/platform';
const base = readConfig({ ...process.env, NODE_ENV: 'development', PLATFORM_ENABLE_WORKBENCH: '0', PLATFORM_EXPOSE_PROVIDER_DETAILS: '0',
  PLATFORM_CHAT_PROVIDER: 'channel-fixture', PLATFORM_AGENT_PROVIDER: 'channel-fixture', PLATFORM_REALTIME_PROVIDER: 'channel-fixture',
  PLATFORM_TRANSCRIPTION_PROVIDER: 'channel-fixture', PLATFORM_SPEECH_PROVIDER: 'channel-fixture' ,PLATFORM_REQUIRE_INVITE:'1'});
const schema = `student_channel_${randomUUID().replaceAll('-', '')}`, admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
let directory: string, schemaCreated = false;
let student: Awaited<ReturnType<typeof buildApp>>, internal: typeof student, unbound: typeof student;
const seenChats: ChatInput[] = [], seenVoice: VoiceSessionInput[] = [], seenAsr: string[] = [], seenSpeech: unknown[] = [];
let failChat = false;
const answer = 'Synthetic evidence mentions OpenAI, Gmail and a model in ordinary user-facing text.';
function wav() { const bytes = Buffer.alloc(92); bytes.write('RIFF'); bytes.writeUInt32LE(84, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(48, 40); return bytes; }
const runtime: PlatformProviderRuntime = {
  capabilities: () => [
    { id: 'channel-fixture', name: 'Private synthetic runtime', enabled: true, keyConfigured: true,
      capabilities: ['chat', 'agent', 'speech', 'transcription', 'realtime'], models: ['synthetic-chat', 'synthetic-agent', 'synthetic-speech', 'synthetic-asr', 'synthetic-realtime'],
      modelsByCapability: { chat: ['synthetic-chat'], agent: ['synthetic-agent'], speech: ['synthetic-speech'], transcription: ['synthetic-asr'], realtime: ['synthetic-realtime'] },
      voiceOptions: { speech: { voices: ['synthetic-fixed-speech'], defaultVoice: 'synthetic-fixed-speech' }, realtime: { voices: ['synthetic-fixed-realtime'], defaultVoice: 'synthetic-fixed-realtime', turnTaking: true } }, envVariables: ['SYNTHETIC_PRIVATE_CONFIG'] },
    { id: 'historic-fixture', name: 'Historical fixed analysis', enabled: true, keyConfigured: true, capabilities: ['agent'], models: ['synthetic-historic'], modelsByCapability: { agent: ['synthetic-historic'] }, envVariables: [] },
    { id: 'openai', name: 'Synthetic unselected PDF capability', enabled: true, keyConfigured: true, capabilities: ['chat'], models: ['synthetic-unselected'], envVariables: [] },
    { id: 'faster-whisper', name: 'Synthetic local source receipts', enabled: true, keyConfigured: true, capabilities: ['transcription'], models: ['whisper-tiny'], modelsByCapability: { transcription: ['whisper-tiny'] }, envVariables: [] },
  ],
  async *streamChat(input, context) {
    seenChats.push(structuredClone(input));
    if (failChat) throw new ApiError(502, 'SYNTHETIC_PRIVATE_FAILURE', 'channel-fixture synthetic-chat PRIVATE_CONFIG should not be reflected.');
    const callId = randomUUID();
    await context?.onModelCall?.({ type: 'started', callId, index: 1, provider: input.provider, model: input.model! });
    yield { type: 'delta', text: answer };
    await context?.onModelCall?.({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens: 11, outputTokens: 7 } });
  },
  async executeJob() { throw new Error('This fixture does not start workers, browsers, external tools or paid providers.'); },
  async createVoiceSession(input = {}) { seenVoice.push({ ...input }); return { clientSecret: 'synthetic-ephemeral-credential', model: 'synthetic-realtime', endpoint: 'https://synthetic-voice.invalid/calls', nativeSession: { private: 'synthetic-native-model' } }; },
  async transcribe(_audio, context) { seenAsr.push(context!.provider!); return { text: 'Synthetic reviewed OpenAI and Gmail transcript' }; },
  async speech(input) { seenSpeech.push({ ...input }); return { name: 'synthetic.wav', mime: 'audio/wav', bytes: wav() }; },
};
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await db.migrate(); await seedFictionalActiveLegal(db);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-student-channel-'));
  const config = { ...base, databaseUrl: url.toString(), storageDir: directory, maxActiveJobs: 100, requireVerifiedEmail: false,
    accountEmail: undefined, s3: undefined, webStaticDir: undefined, allowedOrigins: new Set([origin]), mcp: undefined };
  const requestLimits = { policies: { api: { max: 2000, windowSeconds: 60 }, chat: { max: 2000, windowSeconds: 60 },
    control: { max: 2000, windowSeconds: 60 }, realtime: { max: 2000, windowSeconds: 60 }, transcription: { max: 2000, windowSeconds: 60 }, speech: { max: 2000, windowSeconds: 60 } } };
  student = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config, runtime, enableQueue: false, requestLimits });
  internal = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config: { ...config, workbenchEnabled: true, exposeProviderDetails: true }, runtime, storage: student.jobs.storage, enableQueue: false, requestLimits });
  unbound = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config: { ...config, modelRoutes: {} }, runtime, storage: student.jobs.storage, enableQueue: false, requestLimits });
});
after(async () => {
  await student?.app.close(); await internal?.app.close(); await unbound?.app.close(); await db.close();
  try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
});
async function actor() {
  const userId = randomUUID(), conversationId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [userId, `${userId}@example.invalid`, 'Synthetic channel user', 'synthetic-unused-password-hash']); await seedFictionalConsent(db,userId);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)", [tokenHash(token), userId]);
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode,persona) VALUES($1,$2,'Synthetic OpenAI course project','companion','Synthetic old client persona')", [conversationId, userId]);
  return { userId, conversationId, cookie: `companion_session=${token}` };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function request(system: typeof student, owner: Actor, method: InjectOptions['method'], route: string, payload?: InjectOptions['payload'], account = owner.userId) {
  return system.app.inject({ method, url: prefix + route, payload, headers: { origin, cookie: owner.cookie, [PLATFORM_ACCOUNT_HEADER]: account,
    'x-platform-admin': '1', 'x-workbench-enabled': '1' } });
}
function frames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body.split('\n\n').filter(frame => /^event: /m.test(frame)).map(frame => ({ event: /^event: (.+)$/m.exec(frame)![1], data: JSON.parse(/^data: (.+)$/m.exec(frame)![1]) }));
}
function publicKeys(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert(!['provider', 'model', 'persona', 'mode', 'voice', 'envVariables', 'nativeSession', 'providerTaskId', 'options', 'executionTemplate'].includes(key), `Unexpected public routing field: ${key}`);
    publicKeys(item);
  }
}
async function state(owner: Actor) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1) AS messages,
    (SELECT count(*)::int FROM platform_chat_calls WHERE user_id=$1) AS calls,
    (SELECT count(*)::int FROM platform_runtime_leases WHERE user_id=$1) AS leases,
    (SELECT count(*)::int FROM platform_usage WHERE user_id=$1) AS usage,
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
    (SELECT count(*)::int FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1) AS outbox`, [owner.userId])).rows[0];
}
async function speechPlan(owner: Actor) {
  const draft = await internal.goalPlans.create(owner.userId, owner.conversationId, { title: 'Synthetic saved speech', goal: 'Synthetic historic work', steps: [
    { kind: 'task', title: 'Synthetic speech step', task: { kind: 'speech', provider: 'channel-fixture', prompt: 'Synthetic saved text', options: { voice: 'synthetic-fixed-speech' } } },
  ] });
  return internal.goalPlans.confirm(owner.userId, draft.id, { revision: draft.revision });
}
async function multipart(system: typeof student, owner: Actor, route: string, fields: 'none' | 'before' | 'after' = 'none') {
  const boundary = `synthetic-${randomUUID()}`, field = `--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\nchannel-fixture\r\n`;
  const file = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wav(), Buffer.from('\r\n')]);
  return system.app.inject({ method: 'POST', url: prefix + route, headers: { origin, cookie: owner.cookie, [PLATFORM_ACCOUNT_HEADER]: owner.userId,
    'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(fields === 'before' ? field : ''), file, Buffer.from(fields === 'after' ? field : ''), Buffer.from(`--${boundary}--\r\n`)]) });
}

test('anonymous capabilities are genuine booleans with selected chat attachments; details require real secured identity and flag', async () => {
  const owner = await actor(), stranger = await actor();
  for (const system of [student, internal, unbound]) {
    const response = await system.app.inject({ method: 'GET', url: prefix + '/capabilities' });
    assert.equal(response.statusCode, 200); publicKeys(response.json());
    assert(Object.values(response.json().capabilities).every(value => typeof value === 'boolean'));
    assert.equal(Object.hasOwn(response.json(), 'providers'), false);
    assert.equal(response.json().capabilities.speech, system === internal);
    if (system !== unbound) assert(!response.json().chatAttachments.directMimeTypes.includes('application/pdf'), 'An unselected PDF provider cannot expand chat support.');
    const anonymous = await system.app.inject({ method: 'GET', url: prefix + '/capabilities/details' });
    assert.equal(anonymous.statusCode, 401);
  }
  assert.deepEqual((await student.app.inject({ url: prefix + '/features' })).json(), { version: 1, workbench: false, providerDetails: false });
  assert.deepEqual((await internal.app.inject({ url: prefix + '/features' })).json(), { version: 1, workbench: true, providerDetails: true });
  const closed = await request(student, owner, 'GET', '/capabilities/details'); assert.equal(closed.statusCode, 403); assert.equal(closed.json().error.code, 'PROVIDER_DETAILS_DISABLED');
  assert.equal((await request(internal, owner, 'GET', '/capabilities/details', undefined, stranger.userId)).statusCode, 409);
  const details = await request(internal, owner, 'GET', '/capabilities/details'); assert.equal(details.statusCode, 403); assert.equal(details.json().error.code, 'STAFF_ROLE_REQUIRED');
  await db.query('DELETE FROM platform_sessions WHERE user_id=$1', [owner.userId]);
  assert.equal((await request(internal, owner, 'GET', '/capabilities/details')).statusCode, 401);
});

test('all HTTP modes reject client routing; closed channel also rejects saved-mode/persona policy controls before admission', async () => {
  const owner = await actor(), before = await state(owner), calls = seenChats.length;
  for (const system of [student, internal, unbound]) for (const key of ['provider', 'model']) for (const value of ['channel-fixture', null, {}, '']) {
    const response = await request(system, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic question', [key]: value });
    assert.equal(response.statusCode, 400, response.body);
  }
  for (const [key, value] of [['mode', 'agent'], ['persona', 'Synthetic override'], ['suppressSavedPersona', false], ['workbenchEnabled', true], ['internal', true]]) {
    const response = await request(student, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic question', [String(key)]: value }); assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await request(student, owner, 'POST', '/conversations', { title: 'Synthetic', mode: 'agent' })).statusCode, 400);
  assert.equal((await request(student, owner, 'POST', '/conversations', { title: 'Synthetic', persona: 'Synthetic' })).statusCode, 400);
  assert.deepEqual(await state(owner), before); assert.equal(seenChats.length, calls);
});

test('student default chat suppresses old client persona and exposes semantic SSE while real model/accounting remain persisted', async () => {
  const owner = await actor(), before = seenChats.length;
  const response = await request(student, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic OpenAI and Gmail course comparison' });
  assert.equal(response.statusCode, 200, response.body); const events = frames(response.body);
  assert.deepEqual(events.map(item => item.event), ['start', 'delta', 'done']); events.forEach(item => publicKeys(item.data));
  assert.equal((events.at(-1)!.data.message as { content: string }).content, answer);
  assert.equal(seenChats[before].mode, 'chat'); assert.equal(seenChats[before].provider, 'channel-fixture'); assert.equal(seenChats[before].model, 'synthetic-chat'); assert.equal(seenChats[before].persona, undefined);
  const assistant = (await db.query("SELECT provider,model,status FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [owner.conversationId])).rows[0];
  assert.deepEqual(assistant, { provider: 'channel-fixture', model: 'synthetic-chat', status: 'complete' });
  assert.deepEqual((await db.query('SELECT provider,model,status,input_tokens,output_tokens FROM platform_chat_calls WHERE user_id=$1', [owner.userId])).rows,
    [{ provider: 'channel-fixture', model: 'synthetic-chat', status: 'complete', input_tokens: 11, output_tokens: 7 }]);
  assert.equal((await db.query('SELECT persona FROM platform_conversations WHERE id=$1', [owner.conversationId])).rows[0].persona, 'Synthetic old client persona');
  const legacyToolId = randomUUID(), legacyToolText = '{"provider":"channel-fixture","model":"synthetic-chat","private":"synthetic legacy tool result"}', legacyToolHash = createHash('sha256').update(legacyToolText).digest('hex');
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,content) VALUES($1,$2,'tool',$3)", [legacyToolId, owner.conversationId, legacyToolText]);
  const history = await request(student, owner, 'GET', `/conversations/${owner.conversationId}`); assert.equal(history.statusCode, 200); publicKeys(history.json()); assert.match(history.body, /OpenAI/);
  assert(!history.json().messages.some((message: { id: string }) => message.id === legacyToolId)); assert.equal(history.json().messages.length, 2);
  const usage = await request(student, owner, 'GET', '/usage'); publicKeys(usage.json()); assert.equal(usage.json().usage.chat.calls, 1); assert.equal(usage.json().usage.chat.inputTokens, 11);
  const internalHistory = await request(internal, owner, 'GET', `/conversations/${owner.conversationId}`); assert.equal(internalHistory.json().messages.find((message: { role: string }) => message.role === 'assistant').provider, 'channel-fixture');
  assert.equal(internalHistory.json().messages.find((message: { id: string }) => message.id === legacyToolId).content, legacyToolText);
  assert.equal(createHash('sha256').update((await db.query('SELECT content FROM platform_messages WHERE id=$1', [legacyToolId])).rows[0].content).digest('hex'), legacyToolHash);
});

test('internal mode/persona remain trusted runtime inputs but normal server purpose selects the model', async () => {
  const owner = await actor(), before = seenChats.length;
  const response = await request(internal, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic internal analysis', mode: 'agent' }); assert.equal(response.statusCode, 200, response.body);
  assert.match(seenChats[before].persona!, /^Synthetic old client persona/); assert.equal(seenChats[before].provider, 'channel-fixture'); assert.equal(seenChats[before].model, 'synthetic-agent'); assert.equal(seenChats[before].mode, 'agent');
  const next = await request(internal, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic style', mode: 'companion', persona: 'Synthetic explicit internal persona' }); assert.equal(next.statusCode, 200, next.body); assert.equal(seenChats.at(-1)!.persona, 'Synthetic explicit internal persona'); assert.equal(seenChats.at(-1)!.model, 'synthetic-chat');
});

test('an unbound student route truthfully rejects with neutral error and no fallback, messages, calls or leases', async () => {
  const owner = await actor(), before = await state(owner), calls = seenChats.length;
  const response = await request(unbound, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic question' });
  assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'CAPABILITY_UNAVAILABLE'); publicKeys(response.json());
  assert.deepEqual(await state(owner), before); assert.equal(seenChats.length, calls);
});

test('student stream failures retain truthful failed persistence and omit private exception configuration', async () => {
  const owner = await actor(); failChat = true;
  try {
    const response = await request(student, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { content: 'Synthetic failure request' });
    assert.equal(response.statusCode, 200); const error = frames(response.body).find(item => item.event === 'error'); assert(error); assert.equal(error.data.code, 'REQUEST_FAILED');
    assert.doesNotMatch(response.body, /PRIVATE_CONFIG|channel-fixture|synthetic-chat/);
    assert.equal((await db.query("SELECT status FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [owner.conversationId])).rows[0].status, 'failed');
    assert.equal((await state(owner)).leases, 0);
  } finally { failChat = false; }
});

for (const kind of ['image', 'video', 'speech', 'browser', 'cli', 'workflow', 'mcp']) test(`student HTTP refuses new ${kind} workbench jobs regardless of forged caller flags`, async () => {
  const owner = await actor(), before = await state(owner);
  const response = await request(student, owner, 'POST', '/jobs', { kind, provider: 'channel-fixture', prompt: 'Synthetic new task', options: { admin: true, workbenchEnabled: true } });
  assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED'); assert.deepEqual(await state(owner), before);
});

test('student definition writes reject while reads, ownership, confirmed idempotence and frozen analysis inputs survive', async () => {
  const owner = await actor(), stranger = await actor();
  const definition = { title: 'Synthetic historical analysis', goal: 'Synthetic evidence', steps: [{ kind: 'agent_turn', title: 'Synthetic compare', instruction: 'Synthetic historic instruction', provider: 'historic-fixture', model: 'synthetic-historic' }] };
  const draft = await internal.goalPlans.create(owner.userId, owner.conversationId, definition);
  const template = await createWorkflowTemplate(db, owner.userId, { name: 'Synthetic stored workflow', description: 'Synthetic description', steps: [{ kind: 'chat', provider: 'historic-fixture', model: 'synthetic-historic', prompt: 'Synthetic {{input}}' }] });
  for (const [method, route, payload] of [['POST', `/conversations/${owner.conversationId}/goal-plans`, definition], ['PUT', `/goal-plans/${draft.id}`, { ...definition, revision: 1 }], ['POST', `/goal-plans/${draft.id}/confirm`, { revision: 1 }], ['POST', '/workflow-templates', {}], ['PUT', `/workflow-templates/${template.id}`, { revision: 1 }]] as const) {
    const response = await request(student, owner, method, route, payload); assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
  }
  assert.equal((await request(student, stranger, 'PUT', `/goal-plans/${draft.id}`, {})).statusCode, 404);
  assert.equal((await request(student, stranger, 'PUT', `/workflow-templates/${template.id}`, {})).statusCode, 404);
  assert.equal((await request(student, stranger, 'POST', `/conversations/${owner.conversationId}/goal-plans`, definition)).statusCode, 404);
  const confirmed = await internal.goalPlans.confirm(owner.userId, draft.id, { revision: 1 }), hash = confirmed.definitionHash;
  const repeat = await request(student, owner, 'POST', `/goal-plans/${draft.id}/confirm`, { revision: 1 }); assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().plan.definitionHash, hash); publicKeys(repeat.json());
  const next = await request(student, owner, 'POST', `/goal-plans/${draft.id}/continue`, { revision: 1, stepIndex: 0 }); assert.equal(next.statusCode, 200); assert.equal(next.json().kind, 'agent_turn'); publicKeys(next.json());
  const before = seenChats.length, response = await request(student, owner, 'POST', `/conversations/${owner.conversationId}/messages`, { goalPlanStep: next.json().continuation });
  assert.equal(response.statusCode, 200, response.body); assert.equal(seenChats[before].provider, 'historic-fixture'); assert.equal(seenChats[before].model, 'synthetic-historic'); assert.doesNotMatch(seenChats[before].persona ?? '', /Synthetic old client persona/); assert.match(seenChats[before].persona!, /untrusted source data/); assert.match(seenChats[before].messages.at(-1)!.content, /Synthetic historic instruction/);
  assert.equal((await internal.goalPlans.get(owner.userId, draft.id)).definitionHash, hash);
  const templates = await request(student, owner, 'GET', '/workflow-templates'); assert.equal(templates.statusCode, 200); publicKeys(templates.json()); assert.match(templates.body, /Synthetic \{\{input\}\}/);
});

test('a new confirmed speech binding is atomically refused; existing pending and queued bindings remain read-only recoverable', async () => {
  const owner = await actor(), stranger = await actor(), plan = await speechPlan(owner), before = await state(owner);
  const blocked = await request(student, owner, 'POST', `/goal-plans/${plan.id}/continue`, { revision: plan.revision, stepIndex: 0 }); assert.equal(blocked.statusCode, 403, blocked.body); assert.equal(blocked.json().error.code, 'WORKBENCH_DISABLED'); assert.deepEqual(await state(owner), before);
  assert.equal((await request(student, stranger, 'POST', `/goal-plans/${plan.id}/continue`, { revision: plan.revision, stepIndex: 0 })).statusCode, 404);
  assert.equal((await request(student, owner, 'POST', `/goal-plans/${plan.id}/continue`, { revision: plan.revision + 1, stepIndex: 0 })).statusCode, 409);
  const binding = (await db.query('SELECT job_id,bound_at,resolved_task,input_sources FROM platform_goal_plan_steps WHERE plan_id=$1', [plan.id])).rows[0]; assert.deepEqual(binding, { job_id: null, bound_at: null, resolved_task: null, input_sources: null });
  const started = await internal.goalPlans.continue(owner.userId, plan.id, { revision: plan.revision, stepIndex: 0 }); assert.equal(started.kind, 'task'); if (started.kind !== 'task') throw new Error('Expected the real stored task binding.');
  const pendingBefore = await state(owner), snapshot = (await db.query('SELECT execution_policy FROM platform_jobs WHERE id=$1', [started.job.id])).rows[0];
  const existing = await request(student, owner, 'POST', `/goal-plans/${plan.id}/continue`, { revision: 1, stepIndex: 0 }); assert.equal(existing.statusCode, 200); assert.equal(existing.json().kind, 'existing'); publicKeys(existing.json()); assert.deepEqual(await state(owner), pendingBefore);
  const approve = await request(student, owner, 'POST', `/approvals/${started.approval!.id}/decision`, { decision: 'approved' }); assert.equal(approve.statusCode, 403); assert.deepEqual(await state(owner), pendingBefore);
  await internal.jobs.decide(owner.userId, started.approval!.id, 'approved'); const queued = await state(owner);
  const repeated = await request(student, owner, 'POST', `/approvals/${started.approval!.id}/decision`, { decision: 'approved' }); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().approval.status, 'approved'); publicKeys(repeated.json()); assert.deepEqual(await state(owner), queued);
  const restored = await request(student, owner, 'POST', `/goal-plans/${plan.id}/continue`, { revision: 1, stepIndex: 0 }); assert.equal(restored.statusCode, 200); assert.equal(restored.json().kind, 'existing'); assert.deepEqual(await state(owner), queued);
  assert.deepEqual((await db.query('SELECT execution_policy FROM platform_jobs WHERE id=$1', [started.job.id])).rows[0], snapshot);
});

test('speech retry/approval admission preserves ownership, reject, accepted reads/cancel and existing state errors', async () => {
  const owner = await actor(), stranger = await actor(), failed = await internal.jobs.create(owner.userId, { kind: 'speech', provider: 'channel-fixture', prompt: 'Synthetic failed speech' });
  await db.query("UPDATE platform_jobs SET status='failed' WHERE id=$1", [failed.job.id]);
  const before = (await db.query('SELECT * FROM platform_jobs WHERE id=$1', [failed.job.id])).rows[0], counts = await state(owner);
  assert.equal((await request(student, stranger, 'POST', `/jobs/${failed.job.id}/retry`, {})).statusCode, 404);
  const retry = await request(student, owner, 'POST', `/jobs/${failed.job.id}/retry`, {}); assert.equal(retry.statusCode, 403); assert.deepEqual((await db.query('SELECT * FROM platform_jobs WHERE id=$1', [failed.job.id])).rows[0], before); assert.deepEqual(await state(owner), counts);
  const plan = await speechPlan(owner), started = await internal.goalPlans.continue(owner.userId, plan.id, { revision: 1, stepIndex: 0 }); assert.equal(started.kind, 'task'); if (started.kind !== 'task') throw new Error('Expected task.');
  const approvalId = started.approval!.id;
  assert.equal((await request(student, stranger, 'POST', `/approvals/${approvalId}/decision`, { decision: 'approved' })).statusCode, 404);
  const rejected = await request(student, owner, 'POST', `/approvals/${approvalId}/decision`, { decision: 'rejected' }); assert.equal(rejected.statusCode, 200); assert.equal(rejected.json().approval.status, 'rejected');
  const accepted = await internal.jobs.create(owner.userId, { kind: 'speech', provider: 'channel-fixture', prompt: 'Synthetic accepted speech' });
  for (const status of ['queued', 'running']) { await db.query('UPDATE platform_jobs SET status=$2 WHERE id=$1', [accepted.job.id, status]); const response = await request(student, owner, 'POST', `/jobs/${accepted.job.id}/retry`, {}); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'JOB_NOT_RETRYABLE'); }
  const read = await request(student, owner, 'GET', `/jobs/${accepted.job.id}`); assert.equal(read.statusCode, 200); publicKeys(read.json()); assert.equal(read.json().job.status, 'running');
  const cancelled = await request(student, owner, 'POST', `/jobs/${accepted.job.id}/cancel`, {}); assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().job.status, 'cancelled');
  publicKeys((await request(student, owner, 'GET', '/approvals')).json()); publicKeys((await request(student, owner, 'GET', '/jobs')).json());
});

async function waitForBlocker(holder: PoolClient, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await holder.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The synthetic HTTP request did not reach the owned row lock within its deadline.');
}
test('real row-lock status change cannot admit a new speech generation through HTTP retry', { timeout: 10000 }, async () => {
  const owner = await actor(), accepted = await internal.jobs.create(owner.userId, { kind: 'speech', provider: 'channel-fixture', prompt: 'Synthetic accepted changing task' });
  await db.query("UPDATE platform_jobs SET status='running' WHERE id=$1", [accepted.job.id]);
  const holder = await db.pool.connect(); let pending: ReturnType<typeof request> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query("SET LOCAL lock_timeout='2000ms'");
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE', [accepted.job.id]);
    await holder.query("UPDATE platform_jobs SET status='failed' WHERE id=$1", [accepted.job.id]);
    pending = request(student, owner, 'POST', `/jobs/${accepted.job.id}/retry`, {});
    await waitForBlocker(holder, pid); await holder.query('COMMIT');
    const response = await pending; assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
    const row = (await db.query('SELECT status,generation,attempt_count FROM platform_jobs WHERE id=$1', [accepted.job.id])).rows[0]; assert.deepEqual(row, { status: 'failed', generation: 1, attempt_count: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_job_outbox WHERE job_id=$1', [accepted.job.id])).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_approvals WHERE job_id=$1', [accepted.job.id])).rows[0].n, 0);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
});

test('real row-lock transition cannot admit pending speech approval, while same approved decision stays idempotent', { timeout: 10000 }, async () => {
  const owner = await actor(), plan = await speechPlan(owner), started = await internal.goalPlans.continue(owner.userId, plan.id, { revision: 1, stepIndex: 0 }); if (started.kind !== 'task') throw new Error('Expected task.');
  const approvalId = started.approval!.id;
  // Simulate the prior accepted state visible to an unlocked HTTP reader.
  await db.query("UPDATE platform_jobs SET status='queued' WHERE id=$1", [started.job.id]); await db.query("UPDATE platform_approvals SET status='approved' WHERE id=$1", [approvalId]);
  const holder = await db.pool.connect(); let pending: ReturnType<typeof request> | undefined;
  try {
    await holder.query('BEGIN'); const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE', [started.job.id]); await holder.query('SELECT id FROM platform_approvals WHERE id=$1 FOR UPDATE', [approvalId]);
    await holder.query("UPDATE platform_jobs SET status='needs_approval' WHERE id=$1", [started.job.id]); await holder.query("UPDATE platform_approvals SET status='pending' WHERE id=$1", [approvalId]);
    pending = request(student, owner, 'POST', `/approvals/${approvalId}/decision`, { decision: 'approved' });
    await waitForBlocker(holder, pid); await holder.query('COMMIT');
    const response = await pending; assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
    assert.equal((await db.query('SELECT status FROM platform_approvals WHERE id=$1', [approvalId])).rows[0].status, 'pending'); assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_job_outbox WHERE job_id=$1', [started.job.id])).rows[0].n, 0);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
});

test('voice controls are server-owned in every HTTP mode; student speech stays unavailable without side effects', async () => {
  const owner = await actor(), before = await state(owner), voices = seenVoice.length, speeches = seenSpeech.length;
  for (const system of [student, internal]) for (const field of ['provider', 'model', 'voice', 'instructions', 'persona', 'turnTaking']) {
    assert.equal((await request(system, owner, 'POST', '/voice/session', { [field]: 'Synthetic override' })).statusCode, 400);
    assert.equal((await request(system, owner, 'POST', '/voice/speech', { text: 'Synthetic text', [field]: 'Synthetic override' })).statusCode, 400);
  }
  for (const payload of [{ text: 'Synthetic student text' }, { message_id: randomUUID() }]) { const response = await request(student, owner, 'POST', '/voice/speech', payload); assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, 'SPEECH_NOT_AVAILABLE'); }
  assert.deepEqual(await state(owner), before); assert.equal(seenVoice.length, voices); assert.equal(seenSpeech.length, speeches);
});

test('student realtime preserves genuine transport and bounded owned text context while issuer and public DTO omit old persona/config', async () => {
  const owner = await actor(), stranger = await actor(), messageId = randomUUID();
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,content) VALUES($1,$2,'user','Synthetic OpenAI evidence')", [messageId, owner.conversationId]);
  const before = seenVoice.length, response = await request(student, owner, 'POST', '/voice/session', { conversationId: owner.conversationId }); assert.equal(response.statusCode, 200, response.body); publicKeys(response.json());
  assert.deepEqual(seenVoice[before], { provider: 'channel-fixture', model: 'synthetic-realtime', voice: 'synthetic-fixed-realtime', turnTaking: 'patient' });
  assert.equal(response.json().clientSecret, 'synthetic-ephemeral-credential'); assert.equal(response.json().endpoint, 'https://synthetic-voice.invalid/calls'); assert.deepEqual(response.json().serverContext.items, [{ messageId, role: 'user', text: 'Synthetic OpenAI evidence' }]);
  const sessionId = response.json().sessionId;
  assert.deepEqual((await db.query('SELECT provider,model,conversation_id FROM platform_voice_sessions WHERE id=$1', [sessionId])).rows[0], { provider: 'channel-fixture', model: 'synthetic-realtime', conversation_id: owner.conversationId });
  const saved = await request(student, owner, 'POST', `/conversations/${owner.conversationId}/voice-records`, { clientRecordId: randomUUID(), source: 'realtime_transcript', role: 'assistant', text: 'Synthetic browser-reported OpenAI excerpt', sessionId }); assert.equal(saved.statusCode, 201, saved.body); publicKeys(saved.json());
  assert.equal((await request(student, owner, 'POST', '/voice/session/release', { sessionId })).statusCode, 200);
  assert.equal((await request(student, stranger, 'POST', '/voice/session', { conversationId: owner.conversationId })).statusCode, 404);
  publicKeys((await request(student, owner, 'GET', `/conversations/${owner.conversationId}/voice-records`)).json());
});

test('file-only ASR uses the explicit server binding, while internal speech fixes model/voice and private owner storage', async () => {
  const owner = await actor(), stranger = await actor(), before = seenAsr.length;
  for (const system of [student, internal]) for (const position of ['before', 'after'] as const) assert.equal((await multipart(system, owner, '/voice/transcribe', position)).statusCode, 400);
  assert.equal(seenAsr.length, before);
  const response = await multipart(student, owner, '/voice/transcribe'); assert.equal(response.statusCode, 200, response.body); assert.equal(seenAsr.at(-1), 'channel-fixture'); assert.match(response.json().text, /OpenAI/);
  const missing = await multipart(unbound, owner, '/voice/transcribe'); assert.equal(missing.statusCode, 503); assert.equal(missing.json().error.code, 'CAPABILITY_UNAVAILABLE');
  const spoken = await request(internal, owner, 'POST', '/voice/speech', { text: 'Synthetic internal spoken text' }); assert.equal(spoken.statusCode, 201, spoken.body);
  assert.deepEqual(seenSpeech.at(-1), { provider: 'channel-fixture', model: 'synthetic-speech', voice: 'synthetic-fixed-speech', text: 'Synthetic internal spoken text' });
  assert.equal((await request(student, owner, 'GET', `/uploads/${spoken.json().attachment.id}`)).statusCode, 200); assert.equal((await request(student, stranger, 'GET', `/uploads/${spoken.json().attachment.id}`)).statusCode, 404); assert.equal((await state(owner)).leases, 0);
});

test('saved audio receipt HTTP projection preserves real source hash/text and legacy internal accounting', async () => {
  const owner = await actor(), uploaded = await multipart(student, owner, '/uploads'); assert.equal(uploaded.statusCode, 201, uploaded.body); const id = uploaded.json().attachment.id, clientRequestId = randomUUID();
  const created = await request(student, owner, 'POST', `/uploads/${id}/transcriptions`, { clientRequestId }); assert.equal(created.statusCode, 201, created.body); publicKeys(created.json());
  assert.equal(created.json().receipt.sourceSha256, createHash('sha256').update(wav()).digest('hex')); assert.match(created.json().receipt.text, /OpenAI/);
  const receiptId = created.json().receipt.id;
  const stored = (await db.query('SELECT provider,model FROM platform_audio_transcriptions WHERE id=$1', [receiptId])).rows[0]; assert.deepEqual(stored, { provider: 'faster-whisper', model: 'whisper-tiny' });
  for (const route of [`/audio-transcriptions/${receiptId}`, `/uploads/${id}/transcriptions/${clientRequestId}`]) { const read = await request(student, owner, 'GET', route); assert.equal(read.statusCode, 200); publicKeys(read.json()); assert.equal(read.json().receipt.sourceSha256, created.json().receipt.sourceSha256); }
  assert.equal((await request(internal, owner, 'GET', `/audio-transcriptions/${receiptId}`)).json().receipt.provider, 'faster-whisper');
});
