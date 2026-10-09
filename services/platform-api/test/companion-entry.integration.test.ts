import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Job } from 'bullmq';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { COMPANION_INK_TOKENS, PLATFORM_ACCOUNT_HEADER, type PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionGenerationQueue, createCompanionGenerationWorker } from '../src/companion-generation-queue.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Actual HTTP authentication, PostgreSQL receipts, BullMQ delivery, and ai-core
// Responses parsing. Every provider request goes to an owned loopback SSE
// fixture; synthetic agreements/prices are not production approval or content.
const base = readConfig(), schema = 'companion_entry_' + randomUUID().replaceAll('-', '');
assert(process.env.PLATFORM_DATABASE_URL, 'Supply a dedicated verification PostgreSQL URL.');
assert(process.env.PLATFORM_REDIS_URL, 'Supply a dedicated verification Redis URL.');
const url = new URL(base.databaseUrl), redis = new URL(base.redisUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.notEqual(url.port, '5442', 'Preserve the local development database.');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname));
assert.notEqual(redis.port, '6388', 'Preserve the local development Redis instance.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'c3'.repeat(32) })!;
const prefix = '/api/platform', origin = 'http://localhost:4321';
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' };
const validPreview = { summary: '说话简短，先把下一步理清楚。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
type Actor = FixedSessionContext & { cookie: string };
type System = Awaited<ReturnType<typeof buildApp>>;
type Handler = (body: Record<string, any>, reply: http.ServerResponse) => void | Promise<void>;
let created = false, approver: Actor;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
  approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
    VALUES(true,100000000,100000000,$1,clock_timestamp(),clock_timestamp())`, [approver.userId]);
  for (const [unit, price] of [['input_token', '1'], ['cached_input_token', '1'], ['cache_write_input_token', '1'], ['output_token', '2']]) {
    await db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
      VALUES($1,'openai','fictional-companion-model','background',$2,$3,clock_timestamp())`, [randomUUID(), unit, price]);
  }
});
after(async () => {
  try { await db.close(); }
  finally {
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        process.stdout.write(`# Companion entry fixture schema cleanup confirmed: ${schema}\n`);
      }
    } finally { await admin.close(); }
  }
});
async function actor(staff = false): Promise<Actor> {
  const userId = randomUUID(), raw = randomUUID(), hash = tokenHash(raw);
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional entry owner','fictional-unused-password',$3,clock_timestamp())`,
  [userId, userId + '@example.invalid', staff ? 'staff' : 'student']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  await seedFictionalConsent(db, userId);
  return { userId, tokenHash: hash, cookie: 'companion_session=' + raw };
}
async function freshSession(who: Actor, version = 0): Promise<Actor> {
  const raw = randomUUID(), hash = tokenHash(raw);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [who.userId, hash, version]);
  return { userId: who.userId, tokenHash: hash, cookie: 'companion_session=' + raw };
}
const headers = (who: Actor) => ({ cookie: who.cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId, origin });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < deadline, 'Timed out observing ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function respond(reply: http.ServerResponse) {
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(validPreview) }] }],
    usage: { input_tokens: 34, output_tokens: 21 } } })}\n\ndata: [DONE]\n\n`);
}
interface Fixture {
  system: System; queue: CompanionGenerationQueue; runtime: PlatformProviderRuntime;
  local: string; bodies: Record<string, any>[]; owners: Actor[];
  ready(): Promise<{ who: Actor; revision: number }>;
  worker(): Promise<void>;
  done(id: string): Promise<Job>;
}
async function fixture(run: (fixture: Fixture) => Promise<void>, handler: Handler = (_body, reply) => respond(reply)) {
  const bodies: Record<string, any>[] = [], owners: Actor[] = [], workers: ReturnType<typeof createCompanionGenerationWorker>[] = [];
  let failure: unknown, system: System | undefined, queue: CompanionGenerationQueue | undefined;
  const server = http.createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await handler(body, reply);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env: providerEnv, fetch: (target, init) => {
    const remote = new URL(String(target));
    assert.equal(remote.origin, 'https://api.openai.com'); assert.equal(remote.pathname, '/v1/responses');
    return fetch(local + remote.pathname, init);
  } });
  const config = { ...base, databaseUrl: url.toString(), queueName: 'entry-fixture-' + randomUUID(), dataCrypto: crypto,
    requireVerifiedEmail: true, workbenchEnabled: false, allowedOrigins: new Set([origin]),
    accountEmail: undefined, s3: undefined, mcp: undefined, webStaticDir: undefined,
    safetyDetectorProfilePath: undefined, safetyResponseBundlePath: undefined,
    modelRoutes: { companion_generation: { provider: 'openai' } } };
  try {
    system = await buildApp({ db, config, legalBundle: FICTIONAL_LEGAL, runtime, enableQueue: false,
      requestLimits: { policies: { api: { max: 2000, windowSeconds: 60 } } } });
    queue = new CompanionGenerationQueue(system.companion);
    const current = system, notifications = queue;
    const f: Fixture = { system, queue, runtime, local, bodies, owners,
      async ready() {
        const who = await actor(); owners.push(who);
        await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
          VALUES($1,'fictional-entry-explicit-policy','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, approver.userId]);
        const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
        let draft = (await store.save(who, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'fast_track' } })).draft;
        while (draft.currentQuestion) draft = (await store.save(who, { operationId: randomUUID(), expectedRevision: draft.revision,
          action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
        assert.equal(draft.state, 'intake_ready'); return { who, revision: draft.revision };
      },
      async worker() { const worker = createCompanionGenerationWorker(current.companion); workers.push(worker); await worker.waitUntilReady(); },
      async done(id) {
        let job: Job | undefined;
        await until(async () => {
          job = await notifications.queue.getJob(id);
          // getState is a later Redis read. It may see failed/completed while
          // this Job object still contains pre-completion fields. Require the
          // actual terminal record before interpreting its failedReason.
          return !!job && typeof job.finishedOn==='number' && ['completed', 'failed'].includes(await job.getState());
        }, 'actual worker terminal notification');
        assert(job); return job;
      },
    };
    await run(f); if (failure) throw failure;
  } finally {
    for (const worker of workers) await worker.close();
    if (queue) {
      const client = await queue.queue.client, pattern = 'bull:' + queue.queue.name + ':*';
      await queue.queue.obliterate({ force: true });
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        assert.deepEqual(keys, [], 'Only the owned BullMQ queue is removed.'); cursor = next;
      } while (cursor !== '0');
      process.stdout.write(`# Companion entry fixture Redis cleanup confirmed: ${queue.queue.name}\n`);
      await queue.close();
    }
    await system?.app.close();
    if (owners.length) await db.query('DELETE FROM platform_users WHERE id=ANY($1::uuid[])', [owners.map(item => item.userId)]);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
async function accept(f: Fixture, who: Actor, revision: number, operationId = randomUUID()) {
  const response = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who),
    payload: { operationId, expectedRevision: revision } });
  assert.equal(response.statusCode, 202, response.body);
  const value = response.json(); assert.equal(value.operation.id, operationId); assert.equal(value.entry.kind, 'generation');
  return { operationId, taskId: value.entry.taskId as string, value };
}
async function counts(who: Actor) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_generation_tasks WHERE user_id=$1) AS tasks,
    (SELECT count(*)::int FROM platform_companion_generation_requests WHERE user_id=$1) AS requests,
    (SELECT count(*)::int FROM platform_companion_generation_outbox WHERE user_id=$1) AS outbox,
    (SELECT count(*)::int FROM platform_companion_generation_calls WHERE user_id=$1) AS calls,
    (SELECT count(*)::int FROM platform_companion_revisions WHERE user_id=$1) AS revisions`, [who.userId])).rows[0];
}
test('GET is a private read: it neither prepares intake nor creates or consumes companion work', async () => {
  await fixture(async f => {
    const empty = await actor(); f.owners.push(empty);
    const absent = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(empty) });
    assert.equal(absent.statusCode, 200); assert.deepEqual(absent.json(), { entry: { kind: 'intake_required' } });
    const { who, revision } = await f.ready();
    for (let i = 0; i < 3; i++) {
      const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
      assert.equal(read.statusCode, 200); assert.match(String(read.headers['cache-control']), /no-store/);
      assert.deepEqual(read.json(), { entry: { kind: 'not_prepared', intakeRevision: revision, generationAvailable: true } });
    }
    assert.deepEqual(await counts(who), { tasks: 0, requests: 0, outbox: 0, calls: 0, revisions: 0 });
    assert.equal(f.bodies.length, 0); assert.equal(await f.queue.queue.getWaitingCount(), 0);
    const accepted = await accept(f, who, revision);
    await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal((await counts(who)).calls, 0); assert.equal(await f.queue.queue.getWaitingCount(), 0);
    assert.equal((await db.query('SELECT status FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0].status, 'pending');
  });
});
test('HTTP and closed command reject forged authority, foreign account, stale source and executable fields before acceptance', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), other = await f.ready();
    for (const value of [{}, { operationId: randomUUID(), expectedRevision: revision, persona: 'invented' },
      { operationId: randomUUID(), expectedRevision: revision, provider: 'openai' },
      { operationId: randomUUID(), expectedRevision: revision, safe: true },
      { operationId: randomUUID(), expectedRevision: revision + 0.5 }]) {
      const response = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: value });
      assert.equal(response.statusCode, 400);
    }
    let evaluated = false;
    await assert.rejects(f.system.companion.accept(who, { operationId: randomUUID(), get expectedRevision() { evaluated = true; return revision; } }), code('INVALID_INPUT'));
    assert.equal(evaluated, false);
    const foreign = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: { ...headers(who), [PLATFORM_ACCOUNT_HEADER]: other.who.userId }, payload: { operationId: randomUUID(), expectedRevision: revision } });
    assert.equal(foreign.statusCode, 409);
    const stale = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: { operationId: randomUUID(), expectedRevision: revision - 1 } });
    assert.equal(stale.statusCode, 409);
    const query = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current?taskId=' + randomUUID(), headers: headers(who) });
    assert.equal(query.statusCode, 400);
    assert.deepEqual(await counts(who), { tasks: 0, requests: 0, outbox: 0, calls: 0, revisions: 0 }); assert.equal(f.bodies.length, 0);
  });
});
test('concurrent retries atomically retain one authentic private request, receipt, task and outbox', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), operationId = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => accept(f, who, revision, operationId)));
    assert.equal(new Set(results.map(item => item.taskId)).size, 1);
    assert.equal(results.filter(item => !item.value.operation.replayed).length, 1);
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
    const row = (await db.query('SELECT * FROM platform_companion_generation_requests WHERE id=$1', [operationId])).rows[0];
    const plaintext = crypto.openUtf8(row.payload_ciphertext, { table: 'platform_companion_generation_requests', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision });
    assert.equal(JSON.parse(plaintext).tokenHash, who.tokenHash);
    assert.equal(row.payload_ciphertext.includes(Buffer.from(who.tokenHash)), false);
    const fresh = await freshSession(who);
    assert.equal((await accept(f, fresh, revision, operationId)).taskId, results[0].taskId);
    const after = (await db.query('SELECT payload_ciphertext FROM platform_companion_generation_requests WHERE id=$1', [operationId])).rows[0];
    assert.deepEqual(after.payload_ciphertext, row.payload_ciphertext, 'A replay never replaces original authorization.');
    const changed = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: { operationId, expectedRevision: revision + 1 } });
    assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'REQUEST_FAILED');
    await assert.rejects(f.system.companion.accept(who, { operationId, expectedRevision: revision + 1 }), code('COMPANION_OPERATION_CONFLICT'));
  });
});
test('different concurrent operation IDs serialize to one task without a second accepted intent', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready();
    const results = await Promise.all([randomUUID(), randomUUID()].map(operationId => f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: { operationId, expectedRevision: revision } })));
    assert.deepEqual(results.map(item => item.statusCode).sort(), [202, 409]);
    assert.equal(results.find(item => item.statusCode === 409)!.json().error.code, 'REQUEST_FAILED');
    await assert.rejects(f.system.companion.accept(who, { operationId: randomUUID(), expectedRevision: revision }), code('COMPANION_REQUEST_EXISTS'));
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
  });
});
test('a real deferred COMMIT rejection rolls back preparation, accepted receipt and its outbox together', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready();
    const name = 'entry_rollback_' + randomUUID().replaceAll('-', '');
    await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional acceptance rollback'; END IF;
      RETURN NEW; END $$`);
    await db.query(`CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON platform_companion_generation_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      const failed = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: { operationId: randomUUID(), expectedRevision: revision } });
      assert.equal(failed.statusCode, 502); assert.equal('entry' in failed.json(), false);
      assert.deepEqual(await counts(who), { tasks: 0, requests: 0, outbox: 0, calls: 0, revisions: 0 });
      assert.equal(f.bodies.length, 0); assert.equal(await f.queue.queue.getWaitingCount(), 0);
    } finally {
      await db.query(`DROP TRIGGER ${name} ON platform_companion_generation_requests`); await db.query(`DROP FUNCTION ${name}()`);
    }
  });
});
test('lost accepted HTTP response and a cancelled observation cannot cancel the actual worker; public preview survives provider closure', async () => {
  const entered = deferred(), release = deferred();
  await fixture(async f => {
    try {
      const { who, revision } = await f.ready(), operationId = randomUUID();
      const address = await f.system.app.listen({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        const request = http.request(address + prefix + '/companion/drafts', { method: 'POST', headers: { ...headers(who), 'content-type': 'application/json' } }, response => {
          assert.equal(response.statusCode, 202); response.destroy(); request.destroy(); resolve();
        });
        request.on('error', reject); request.end(JSON.stringify({ operationId, expectedRevision: revision }));
      });
      const accepted = await accept(f, who, revision, operationId); assert.equal(accepted.value.operation.replayed, true);
      await f.queue.dispatch();
      const notification = await f.queue.queue.getJob(operationId); assert(notification);
      assert.deepEqual(notification.data, { requestId: operationId, taskId: accepted.taskId });
      assert.equal(JSON.stringify(notification.data).includes(who.tokenHash), false);
      await f.worker(); await entered.promise;
      const lock = await db.pool.connect(); let observed: Promise<void> | undefined;
      try {
        await lock.query('BEGIN'); await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
        const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let request!: http.ClientRequest;
        observed = new Promise<void>(resolve => {
          request = http.get(address + prefix + '/companion/drafts/current', { headers: headers(who) }, response => { response.resume(); resolve(); });
          request.on('error', () => resolve());
        });
        await until(async () => (await db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0, 'actual observation waiting on its own account lock');
        request.destroy(new Error('Fictional browser closed its observation.')); await observed;
        await lock.query('COMMIT');
      } finally { await lock.query('ROLLBACK').catch(() => {}); lock.release(); }
      release.resolve(); assert.equal(await (await f.done(operationId)).getState(), 'completed');
      const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
      assert.equal(read.statusCode, 200, read.body); const entry = read.json().entry;
      assert.equal(entry.kind, 'preview'); assert.equal(entry.preview.summary, validPreview.summary); assert.deepEqual(entry.preview.samples, validPreview.samples);
      assert.equal(entry.preview.generatedBy, 'model'); assert(COMPANION_INK_TOKENS.includes(entry.preview.inkToken));
      assert.deepEqual(Object.keys(entry.preview).sort(), ['taskId', 'companionId', 'revision', 'generatedBy', 'summary', 'samples', 'inkToken'].sort());
      for (const key of ['styleCard', 'quirks', 'dimensions', 'provider', 'model', 'tokenHash', 'callIds', 'leaseToken']) assert.equal(Object.hasOwn(entry.preview, key), false);
      assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].model, 'fictional-companion-model'); assert.equal(f.bodies[0].store, false); assert.equal(f.bodies[0].text.format.strict, true);
      assert.equal(JSON.stringify(f.bodies[0]).includes(who.userId), false); assert.equal(JSON.stringify(f.bodies[0]).includes(accepted.taskId), false);
      const call = (await db.query('SELECT * FROM platform_companion_generation_calls WHERE user_id=$1', [who.userId])).rows[0];
      assert.equal(call.status, 'complete'); assert.equal(call.validation_status, 'passed_rules');
      assert.equal(call.usage_status, 'reported'); assert(call.admitted_at instanceof Date);
      const ledger = (await db.query('SELECT * FROM platform_cost_ledger WHERE user_id=$1', [who.userId])).rows;
      assert.equal(ledger.length, 1); assert.equal(ledger[0].usage_status, 'reported'); assert.equal(ledger[0].cost_micros, '76');
      const disabled = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: () => { throw new Error('Closed provider must never be called.'); } });
      const closed = await buildApp({ db, config: { ...f.system.companion.config, modelRoutes: {} }, legalBundle: FICTIONAL_LEGAL, runtime: disabled, enableQueue: false });
      try {
        const restored = await closed.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
        assert.equal(restored.statusCode, 200, restored.body); assert.deepEqual(restored.json().entry, entry);
      } finally { await closed.app.close(); }
      assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 1 });
    } finally { release.resolve(); }
  }, async (_body, reply) => { entered.resolve(); await release.promise; respond(reply); });
});
test('genuine initial budget denial reaches the actual worker as configuration without a provider call or lost accepted source', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready();
    await db.query('UPDATE platform_cost_user_policy SET effective_to=clock_timestamp() WHERE user_id=$1', [who.userId]);
    assert.equal((await db.query('SELECT 1 FROM platform_cost_user_policy WHERE user_id=$1 AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())', [who.userId])).rowCount, 0);
    const accepted = await accept(f, who, revision);
    const sources = async () => {
      const request = await db.query('SELECT * FROM platform_companion_generation_requests WHERE id=$1 AND user_id=$2', [accepted.operationId, who.userId]);
      const answers = await db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1 ORDER BY id', [who.userId]);
      const prefix = await db.query('SELECT * FROM platform_companion_source_prefixes WHERE user_id=$1 ORDER BY id', [who.userId]);
      const task = await db.query(`SELECT id,user_id,companion_id,answers_id,source_draft_id,source_revision,auth_version,
        questionnaire_revision,rules_revision,generator_version,purpose,seed_ciphertext,source_receipt_version
        FROM platform_companion_generation_tasks WHERE id=$1 AND user_id=$2`, [accepted.taskId, who.userId]);
      return { request: request.rows, answers: answers.rows, prefix: prefix.rows, task: task.rows };
    };
    const original = await sources(); assert.equal(original.request.length, 1); assert.equal(original.answers.length, 1);
    assert.equal(original.prefix.length, 1); assert.equal(original.task.length, 1);
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
    await f.queue.dispatch(); const job = await f.queue.queue.getJob(accepted.operationId); assert(job);
    assert.deepEqual(job.data, { requestId: accepted.operationId, taskId: accepted.taskId });
    await f.worker(); assert.equal(await (await f.done(accepted.operationId)).getState(), 'completed');
    const task = (await db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0];
    assert.equal(task.status, 'failed'); assert.equal(task.error_code, 'COMPANION_GENERATION_BUDGET_UNAVAILABLE');
    assert.equal(task.generation, 1); assert.equal(task.lease_token, null); assert.equal(task.lease_until, null); assert.equal(task.runtime_lease_id, null);
    const outbox = (await db.query('SELECT * FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0];
    assert.equal(outbox.held_reason, 'configuration'); assert.equal(f.bodies.length, 0);
    const effects = (await db.query(`SELECT
      (SELECT count(*)::int FROM platform_cost_reservations WHERE user_id=$1) AS reservations,
      (SELECT count(*)::int FROM platform_cost_ledger WHERE user_id=$1) AS ledger,
      (SELECT count(*)::int FROM platform_runtime_leases WHERE user_id=$1) AS leases,
      (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
      (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
      (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
      (SELECT count(*)::int FROM platform_chat_calls WHERE user_id=$1) AS chat_calls,
      (SELECT count(*)::int FROM platform_usage WHERE user_id=$1) AS usage`, [who.userId])).rows[0];
    assert.deepEqual(effects, { reservations: 0, ledger: 0, leases: 0, rooms: 0, memories: 0, jobs: 0, chat_calls: 0, usage: 0 });
    for (let i = 0; i < 2; i++) {
      const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().entry.kind, 'generation'); assert.equal(read.json().entry.status, 'failed');
      assert.equal(read.json().entry.generation, 1); assert.equal(read.json().entry.hold, 'configuration_unavailable');
    }
    assert.deepEqual(await sources(), original); assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
    assert.deepEqual((await db.query('SELECT * FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0], outbox);
    assert.equal(f.bodies.length, 0);
  }, () => { assert.fail('An initial budget rejection must never launch provider HTTP.'); });
});
test('actual Redis notification loss is restored from the accepted DB outbox into the same task', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    await f.queue.dispatch(); const first = await f.queue.queue.getJob(accepted.operationId); assert(first); await first.remove();
    assert.equal(await f.queue.queue.getJob(accepted.operationId), undefined);
    await db.query("UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp()-interval '16 seconds' WHERE request_id=$1", [accepted.operationId]);
    await Promise.all([f.queue.dispatch(), f.queue.dispatch()]);
    const restored = await f.queue.queue.getJob(accepted.operationId); assert(restored);
    assert.deepEqual(restored.data, { requestId: accepted.operationId, taskId: accepted.taskId });
    const observing = Promise.all(Array.from({ length: 12 }, () => f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) })));
    await f.worker(); await f.done(accepted.operationId);
    for (const read of await observing) {
      assert.equal(read.statusCode, 200, 'Ordinary concurrent reads and worker locks must not deadlock or timeout.');
      const entry = read.json().entry;
      if (entry.kind === 'generation') assert.equal(entry.hold, null);
    }
    let diagnostics:string|undefined;
    if(f.bodies.length!==1){
      const actual=(await db.query(`SELECT t.status,t.generation,o.held_reason FROM platform_companion_generation_tasks t
        JOIN platform_companion_generation_outbox o ON o.task_id=t.id WHERE t.id=$1`,[accepted.taskId])).rows[0];
      const job=await f.queue.queue.getJob(accepted.operationId);
      diagnostics=JSON.stringify({notificationState:await job?.getState(),knownDatabaseRetry:job?.failedReason==='Companion notification is waiting for database contention to clear.',
        taskStatus:['pending','running','failed','uncertain','interrupted','completed'].includes(actual.status)?actual.status:'unknown',generation:actual.generation,
        holdReason:[null,'authorization','configuration','source_changed','storage','terminal'].includes(actual.held_reason)?actual.held_reason:'unknown',counts:await counts(who)});
    }
    assert.equal(f.bodies.length, 1,diagnostics); assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 1 });
  });
});
test('a bounded actual account lock does not permanently hold an accepted worker or replay its model call', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    await f.queue.dispatch();
    const notification = await f.queue.queue.getJob(accepted.operationId); assert(notification);
    assert.deepEqual(notification.data, { requestId: accepted.operationId, taskId: accepted.taskId });
    const lock = await db.pool.connect(); let locked = false;
    try {
      await lock.query('BEGIN'); locked = true;
      await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
      const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await f.worker();
      await until(async () => (await db.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount! > 0,
      'actual worker waiting on the accepted owner account');
      // The actual worker is blocked before any request can be admitted. Keep
      // the real row lock beyond the default 500ms lock wait, then release it.
      const waitingSince = Date.now();
      await new Promise(resolve => setTimeout(resolve, 650));
      assert(Date.now() - waitingSince >= 600); assert.equal(f.bodies.length, 0);
      await lock.query('COMMIT'); locked = false;
    } finally { if (locked) await lock.query('ROLLBACK'); lock.release(); }
    assert.equal(await (await f.done(accepted.operationId)).getState(), 'completed');
    const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal(read.statusCode, 200, read.body);
    const entry = read.json().entry;
    if (entry.kind === 'generation') assert.equal(entry.hold, null, 'A brief actual account lock must not become a permanent requires_review hold.');
    assert.equal(entry.kind, 'preview'); assert.equal(entry.preview.taskId, accepted.taskId);
    assert.equal(entry.preview.generatedBy, 'model'); assert.equal(entry.preview.summary, validPreview.summary);
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 1 });
    const request = (await db.query('SELECT id,task_id FROM platform_companion_generation_requests WHERE user_id=$1', [who.userId])).rows;
    assert.deepEqual(request, [{ id: accepted.operationId, task_id: accepted.taskId }]);
    const task = (await db.query('SELECT status,generation FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0];
    assert.deepEqual(task, { status: 'completed', generation: 1 });
    const ledger = (await db.query('SELECT usage_status,cost_micros FROM platform_cost_ledger WHERE user_id=$1', [who.userId])).rows;
    assert.deepEqual(ledger, [{ usage_status: 'reported', cost_micros: '76' }]);
    assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0].held_reason, null);
  });
});
test('an actual rolled-back account lock wait is redelivered through the same accepted outbox without new authority or duplicate calls', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    const original = (await db.query('SELECT payload_ciphertext,payload_digest FROM platform_companion_generation_requests WHERE id=$1', [accepted.operationId])).rows[0];
    await f.queue.dispatch();
    const lock = await db.pool.connect(); let locked = false;
    try {
      await lock.query('BEGIN'); locked = true;
      await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
      const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await f.worker();
      await until(async () => (await db.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount! > 0,
      'actual worker blocked until PostgreSQL rejects its lock wait');
      // Let PostgreSQL itself reject the real 1500ms lock acquisition inside the
      // bounded transaction. This is neither a thrown fixture error nor an
      // uncertain provider request; the original generation is still zero.
      await new Promise(resolve => setTimeout(resolve, 1750));
      const failed = await f.done(accepted.operationId);
      assert.equal(await failed.getState(), 'failed');
      assert.equal(failed.failedReason, 'Companion notification is waiting for database contention to clear.');
      assert.equal(f.bodies.length, 0);
      assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
      const task = (await db.query('SELECT status,generation FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0];
      assert.deepEqual(task, { status: 'pending', generation: 0 });
      assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0].held_reason, null);
      await lock.query('COMMIT'); locked = false;
    } finally { if (locked) await lock.query('ROLLBACK'); lock.release(); }
    const pending = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal(pending.statusCode, 200, pending.body);
    assert.deepEqual(pending.json().entry, { kind: 'generation', taskId: accepted.taskId,
      companionId: accepted.value.entry.companionId, generation: 0, status: 'pending', hold: null });
    // Only age the existing dispatch timestamp, as in the notification-loss
    // fixture; there is no new intent, generation, authorization or 15s sleep.
    await db.query("UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp()-interval '16 seconds' WHERE request_id=$1", [accepted.operationId]);
    await f.queue.dispatch();
    const restored = await f.queue.queue.getJob(accepted.operationId); assert(restored);
    assert.deepEqual(restored.data, { requestId: accepted.operationId, taskId: accepted.taskId });
    assert.equal(await (await f.done(accepted.operationId)).getState(), 'completed');
    const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal(read.statusCode, 200, read.body); assert.equal(read.json().entry.kind, 'preview');
    assert.equal(read.json().entry.preview.taskId, accepted.taskId); assert.equal(read.json().entry.preview.generatedBy, 'model');
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 1 });
    const unchanged = (await db.query('SELECT payload_ciphertext,payload_digest FROM platform_companion_generation_requests WHERE id=$1', [accepted.operationId])).rows[0];
    assert.deepEqual(unchanged, original);
    const task = (await db.query('SELECT status,generation FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0];
    assert.deepEqual(task, { status: 'completed', generation: 1 });
    const ledger = (await db.query('SELECT usage_status,cost_micros FROM platform_cost_ledger WHERE user_id=$1', [who.userId])).rows;
    assert.deepEqual(ledger, [{ usage_status: 'reported', cost_micros: '76' }]);
    assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0].held_reason, null);
  });
});
test('forged foreign references or extra authorization fields in Redis never reach a model or alter another accepted request', async () => {
  await fixture(async f => {
    const one = await f.ready(), two = await f.ready(), a = await accept(f, one.who, one.revision), b = await accept(f, two.who, two.revision);
    const three = await f.ready(), four = await f.ready(), c = await accept(f, three.who, three.revision), d = await accept(f, four.who, four.revision);
    const forged = a.operationId, extra = b.operationId;
    await f.queue.queue.add('companion-preview', { requestId: a.operationId, taskId: b.taskId }, { jobId: forged, attempts: 1 });
    await f.queue.queue.add('companion-preview', { requestId: b.operationId, taskId: b.taskId, tokenHash: two.who.tokenHash }, { jobId: extra, attempts: 1 });
    await f.queue.queue.add('invented-executor', { requestId: c.operationId, taskId: c.taskId }, { jobId: c.operationId, attempts: 1 });
    const unrelatedJobId = randomUUID();
    await f.queue.queue.add('companion-preview', { requestId: d.operationId, taskId: d.taskId }, { jobId: unrelatedJobId, attempts: 1 });
    await f.worker(); await f.done(forged); const invalid = await f.done(extra);
    assert.equal(await (await f.done(c.operationId)).getState(), 'failed');
    assert.equal(await (await f.done(unrelatedJobId)).getState(), 'failed');
    assert.equal(await invalid.getState(), 'failed'); assert.equal(f.bodies.length, 0);
    assert.deepEqual(await counts(one.who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
    assert.deepEqual(await counts(two.who), { tasks: 1, requests: 1, outbox: 1, calls: 0, revisions: 0 });
    assert.equal((await counts(three.who)).calls, 0); assert.equal((await counts(four.who)).calls, 0);
    assert((await db.query('SELECT held_reason FROM platform_companion_generation_outbox')).rows.every(item => item.held_reason === null));
  });
});
test('one actual poisoned Redis record is held without rolling back delivery of another valid accepted task', async () => {
  await fixture(async f => {
    const one = await f.ready(), two = await f.ready(), a = await accept(f, one.who, one.revision), b = await accept(f, two.who, two.revision);
    await f.queue.queue.add('companion-preview', { requestId: a.operationId, taskId: b.taskId }, { jobId: a.operationId, attempts: 1 });
    await f.queue.dispatch();
    const valid = await f.queue.queue.getJob(b.operationId); assert(valid);
    assert.deepEqual(valid.data, { requestId: b.operationId, taskId: b.taskId });
    assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [a.operationId])).rows[0].held_reason, 'storage');
    await f.worker(); await f.done(a.operationId); await f.done(b.operationId);
    assert.equal(f.bodies.length, 1); assert.equal((await counts(one.who)).calls, 0); assert.equal((await counts(two.who)).calls, 1);
    const held = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(one.who) });
    assert.equal(held.statusCode, 200, held.body); assert.equal(held.json().entry.hold, 'requires_review');
  });
});
test('an unavailable provider is reported before acceptance instead of creating a fake preview or fallback', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready();
    const disabled = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: () => { throw new Error('No external fixture request allowed.'); } });
    const closed = await buildApp({ db, config: { ...f.system.companion.config, modelRoutes: {} }, legalBundle: FICTIONAL_LEGAL, runtime: disabled, enableQueue: false });
    try {
      const read = await closed.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
      assert.equal(read.statusCode, 200); assert.deepEqual(read.json().entry, { kind: 'not_prepared', intakeRevision: revision, generationAvailable: false });
      const refused = await closed.app.inject({ method: 'POST', url: prefix + '/companion/drafts', headers: headers(who), payload: { operationId: randomUUID(), expectedRevision: revision } });
      assert.equal(refused.statusCode, 503); assert.equal(refused.json().error.code, 'CAPABILITY_UNAVAILABLE');
      await assert.rejects(closed.companion.accept(who, { operationId: randomUUID(), expectedRevision: revision }), code('MODEL_ROUTE_UNAVAILABLE'));
      assert.deepEqual(await counts(who), { tasks: 0, requests: 0, outbox: 0, calls: 0, revisions: 0 }); assert.equal(f.bodies.length, 0);
    } finally { await closed.app.close(); }
  });
});
test('damaged encrypted accepted intent fails closed in the actual worker and HTTP read without a call', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    const row = (await db.query('SELECT payload_ciphertext FROM platform_companion_generation_requests WHERE id=$1', [accepted.operationId])).rows[0];
    const damaged = Buffer.from(row.payload_ciphertext); damaged[damaged.length - 1] ^= 1;
    await db.query('UPDATE platform_companion_generation_requests SET payload_ciphertext=$2 WHERE id=$1', [accepted.operationId, damaged]);
    await f.queue.dispatch(); await f.worker(); await f.done(accepted.operationId);
    assert.equal(f.bodies.length, 0); assert.equal((await counts(who)).calls, 0);
    const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal(read.statusCode, 503); assert.equal(read.json().error.code, 'DATA_STORAGE_UNAVAILABLE');
    assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0].held_reason, 'storage');
  });
});
for (const change of ['session_revoked', 'auth_version_changed', 'legal_consent_removed', 'active_legal_changed'] as const) {
  test(`actual accepted ${change} cannot be replaced by a new real session before worker launch`, async () => {
    await fixture(async f => {
      const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
      try {
      if (change === 'session_revoked') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      if (change === 'auth_version_changed') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
      if (change === 'legal_consent_removed') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
      if (change === 'active_legal_changed') await db.query("UPDATE platform_terms_policy SET terms_version='fictional-unavailable-new-policy' WHERE singleton=true");
      const fresh = await freshSession(who, change === 'auth_version_changed' ? 1 : 0);
      await f.queue.dispatch(); await f.worker(); await f.done(accepted.operationId);
      assert.equal(f.bodies.length, 0); assert.equal((await counts(who)).calls, 0);
      const row = (await db.query('SELECT * FROM platform_companion_generation_requests WHERE id=$1', [accepted.operationId])).rows[0];
      const original = JSON.parse(crypto.openUtf8(row.payload_ciphertext, { table: 'platform_companion_generation_requests', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision }));
      assert.equal(original.tokenHash, who.tokenHash); assert.notEqual(original.tokenHash, fresh.tokenHash);
      assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1', [accepted.operationId])).rows[0].held_reason, 'authorization');
      if (change === 'session_revoked' || change === 'auth_version_changed') {
        const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(fresh) });
        assert.equal(read.statusCode, 200, read.body); assert.equal(read.json().entry.status, 'pending');
        assert.equal(read.json().entry.hold, 'authorization_required');
      }
      const delivered = await f.queue.queue.getJob(accepted.operationId); assert(delivered); await delivered.remove();
      await db.query("UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp()-interval '16 seconds' WHERE request_id=$1", [accepted.operationId]);
      await f.queue.dispatch(); assert.equal(await f.queue.queue.getJob(accepted.operationId), undefined, 'Authorization hold prevents another automatic delivery.');
      await f.system.companion.executeNotification({ requestId: accepted.operationId, taskId: accepted.taskId }).then(() => assert.fail('Original authorization must remain rejected.'), () => {});
      assert.equal(f.bodies.length, 0);
      } finally { if (change === 'active_legal_changed') await seedFictionalActiveLegal(db); }
    });
  });
}
async function crash(f: Fixture, who: Actor, taskId: string, phase: 'no_calls' | 'dispatch_risk') {
  const child = fork(fileURLToPath(new URL('./fixtures/companion-generation-recovery-child.ts', import.meta.url)), [], {
    execArgv: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))],
    env: { ...process.env, COMPANION_RECOVERY_TEST_DATABASE_URL: url.toString(), COMPANION_RECOVERY_TEST_MODEL_URL: f.local, COMPANION_RECOVERY_TEST_CRASH_PHASE: phase },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let paused = false; const timeout = setTimeout(() => child.kill('SIGKILL'), 10000); timeout.unref();
  try {
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('error', reject); child.on('message', (event: any) => {
        if (event.type === 'ready') child.send({ context: who, taskId });
        else if (event.type === 'paused') { assert.equal(event.phase, phase); paused = true; child.kill('SIGKILL'); }
        else reject(new Error('Actual generation did not reach the owned crash boundary.'));
      });
      child.on('exit', (_code, value) => resolve(value));
    });
    assert(paused); assert.equal(signal, 'SIGKILL');
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  await db.withBoundedTransaction(async client => {
    await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
    const row = (await client.query("UPDATE platform_companion_generation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running' RETURNING runtime_lease_id", [taskId])).rows[0];
    assert(row); await client.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [row.runtime_lease_id]);
  });
}
test('dispatcher and real worker recover an actually abandoned no-call execution in the original generation', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    await crash(f, who, accepted.taskId, 'no_calls'); assert.equal(f.bodies.length, 0);
    assert.equal((await counts(who)).calls, 0);
    await f.queue.dispatch(); await f.worker(); await f.done(accepted.operationId);
    assert.equal(f.bodies.length, 1); const task = (await db.query('SELECT status,generation FROM platform_companion_generation_tasks WHERE id=$1', [accepted.taskId])).rows[0];
    assert.deepEqual(task, { status: 'completed', generation: 1 });
    assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 1 });
  });
});
test('real dispatch uncertainty becomes public uncertainty and a later dispatcher never manufactures a replay or fallback', async () => {
  await fixture(async f => {
    const { who, revision } = await f.ready(), accepted = await accept(f, who, revision);
    await crash(f, who, accepted.taskId, 'dispatch_risk');
    assert.equal(f.bodies.length, 0); assert.equal((await counts(who)).calls, 1);
    await f.queue.dispatch(); await f.worker(); await f.done(accepted.operationId);
    const read = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/drafts/current', headers: headers(who) });
    assert.equal(read.statusCode, 200, read.body); assert.equal(read.json().entry.status, 'uncertain'); assert.equal(read.json().entry.generation, 1);
    const notification = await f.queue.queue.getJob(accepted.operationId); assert(notification); await notification.remove();
    await db.query("UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp()-interval '16 seconds' WHERE request_id=$1", [accepted.operationId]);
    await f.queue.dispatch(); assert.equal(await f.queue.queue.getJob(accepted.operationId), undefined);
    await f.system.companion.executeNotification({ requestId: accepted.operationId, taskId: accepted.taskId });
    assert.equal(f.bodies.length, 0); assert.deepEqual(await counts(who), { tasks: 1, requests: 1, outbox: 1, calls: 1, revisions: 0 });
  });
});

for(const [timeoutKind,revoked] of [['operation_deadline',false],['statement_timeout',false],['operation_deadline',true]] as const){
 test('actual initial notification read '+timeoutKind+(revoked?' rechecks revoked authority on redelivery':' is redelivered with original authority and one model request'),async()=>{
  await fixture(async f=>{
   const {who,revision}=await f.ready(),accepted=await accept(f,who,revision);
   const source=(await db.query('SELECT payload_ciphertext,payload_digest FROM platform_companion_generation_requests WHERE id=$1',[accepted.operationId])).rows[0];
   await f.queue.dispatch();
   const previous=db.withBoundedTransaction,original=previous.bind(db);let delayed=false;
   db.withBoundedTransaction=<T>(run:(client:PoolClient)=>Promise<T>,options={})=>original<T>(client=>run(new Proxy(client,{get(target,key){
    if(key==='query')return async(...args:unknown[])=>{
     if(!delayed&&typeof args[0]==='string'&&/^SELECT \* FROM platform_companion_generation_requests\s+WHERE id=/.test(args[0])){
      delayed=true;
      if(timeoutKind==='statement_timeout')await target.query("SET LOCAL statement_timeout='80ms'");
      await target.query('SELECT pg_sleep(3) /* fictional initial source read latency */');
     }
     return Reflect.apply(target.query,target,args);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }})),options);
   try{
    await f.worker();const notification=await f.done(accepted.operationId);
    assert(delayed,'A real source query must encounter the actual SQL latency.');
    if(await notification.getState()!=='failed'){
      const actual=(await db.query(`SELECT t.status,t.generation,o.held_reason FROM platform_companion_generation_tasks t
        JOIN platform_companion_generation_outbox o ON o.task_id=t.id WHERE t.id=$1`,[accepted.taskId])).rows[0];
      assert.fail(JSON.stringify({notificationState:await notification.getState(),...actual,modelRequests:f.bodies.length}));
    }
    assert.equal(notification.failedReason,'Companion notification is waiting for database contention to clear.');
   }finally{db.withBoundedTransaction=previous;}
   assert.equal(f.bodies.length,0);assert.deepEqual(await counts(who),{tasks:1,requests:1,outbox:1,calls:0,revisions:0});
   assert.deepEqual((await db.query('SELECT status,generation FROM platform_companion_generation_tasks WHERE id=$1',[accepted.taskId])).rows[0],{status:'pending',generation:0});
   assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1',[accepted.operationId])).rows[0].held_reason,null);
   if(revoked){await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);await db.query('DELETE FROM platform_sessions WHERE user_id=$1',[who.userId]);await freshSession(who,1);}
   // Only age the actual accepted notification, as in the Redis loss test.
   await db.query("UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp()-interval '16 seconds' WHERE request_id=$1",[accepted.operationId]);
   await f.queue.dispatch();const restored=await f.queue.queue.getJob(accepted.operationId);assert(restored);
   assert.deepEqual(restored.data,{requestId:accepted.operationId,taskId:accepted.taskId});
   assert.equal(await (await f.done(accepted.operationId)).getState(),'completed');
   if(revoked){
    assert.equal(f.bodies.length,0);assert.deepEqual(await counts(who),{tasks:1,requests:1,outbox:1,calls:0,revisions:0});
    assert.equal((await db.query('SELECT held_reason FROM platform_companion_generation_outbox WHERE request_id=$1',[accepted.operationId])).rows[0].held_reason,'authorization');
    assert.deepEqual((await db.query('SELECT payload_ciphertext,payload_digest FROM platform_companion_generation_requests WHERE id=$1',[accepted.operationId])).rows[0],source);
    return;
   }
   const read=await f.system.app.inject({method:'GET',url:prefix+'/companion/drafts/current',headers:headers(who)});
   assert.equal(read.statusCode,200,read.body);assert.equal(read.json().entry.kind,'preview');assert.equal(read.json().entry.preview.taskId,accepted.taskId);
   assert.equal(f.bodies.length,1);assert.deepEqual(await counts(who),{tasks:1,requests:1,outbox:1,calls:1,revisions:1});
   assert.deepEqual((await db.query('SELECT payload_ciphertext,payload_digest FROM platform_companion_generation_requests WHERE id=$1',[accepted.operationId])).rows[0],source);
   await f.queue.dispatch();assert.equal(f.bodies.length,1);
  });
 });
}
