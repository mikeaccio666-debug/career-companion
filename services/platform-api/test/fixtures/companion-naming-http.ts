import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ACCOUNT_HEADER, type CompanionNamingAccepted, type CompanionNamingRequest } from '@companion/platform-contracts';
import { buildApp } from '../../src/app.ts';
import { hashPassword, tokenHash, type FixedSessionContext } from '../../src/auth.ts';
import { readConfig } from '../../src/config.ts';
import { processAccountEmails, type AccountEmailConfig, type AccountEmailPayload } from '../../src/account-mail.ts';
import { CompanionNameQueue, createCompanionNameWorker } from '../../src/companion-name-queue.ts';
import { createPrebirthFixture, prebirthDetector, withPrebirthLoopback } from './companion-prebirth.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';

export const namingHttpPrefix = '/api/platform';
export const namingHttpOrigin = 'https://fictional-naming-http.example.invalid';
export const namingHttpPassword = 'Fictional-naming-http-password-2026!';
export type NamingHttpActor = FixedSessionContext & { cookie: string; email: string; password: string };
type System = Awaited<ReturnType<typeof buildApp>>;
type Prebirth = Awaited<ReturnType<typeof createPrebirthFixture>>;
type Ready = Awaited<ReturnType<Prebirth['ready']>>;

export function namingHttpHeaders(who: NamingHttpActor) {
  return { cookie: who.cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId, origin: namingHttpOrigin };
}
export function assertPrivateNamingResponse(response: { statusCode: number; headers: Record<string, unknown>; body: string }, status: number) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
}
export async function observeNamingUntil(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert(Date.now() < deadline, 'Timed out observing ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Only user-domain evidence is compared. Actual HTTP admission intentionally
// consumes request-limit counters; those counters are not naming execution.
const evidenceTables = [
  'platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_companion_generation_tasks',
  'platform_companion_name_entries', 'platform_companion_name_submissions',
  'platform_companion_name_dispatches', 'platform_companion_name_dispatch_outbox',
  'platform_companion_name_dispatch_operations', 'platform_companion_identity_drafts',
  'platform_companion_identity_operations', 'platform_companion_identity_selections', 'platform_companion_identity_selection_operations',
  'platform_companion_name_identity_receipts', 'platform_companion_name_identity_provenance',
  'platform_companion_name_safety_responses', 'platform_safety_model_usage',
  'platform_companion_name_safety_publications', 'platform_companion_name_safety_body_projections',
  'platform_companion_name_safety_followup_states', 'platform_companion_name_safety_followups', 'platform_companion_name_safety_handled',
  'platform_companion_name_delivery_heads', 'platform_companion_name_delivery_operations',
  'platform_conversations', 'platform_memories', 'platform_jobs',
  'platform_companion_prebirth_heads', 'platform_companion_prebirth_inventory',
] as const;

export interface NamingHttpFixture {
  prebirth: Prebirth; ready: Ready; system: System; queue: CompanionNameQueue;
  requests: Record<string, unknown>[]; who: NamingHttpActor; address: string; mail: AccountEmailConfig;
  login(userId: string, password?: string): Promise<NamingHttpActor>;
  other(staff?: boolean): Promise<NamingHttpActor>;
  command(name?: string, expectedEntryRevision?: number, expectedIdentityRevision?: number): CompanionNamingRequest;
  accept(command: CompanionNamingRequest, who?: NamingHttpActor): Promise<CompanionNamingAccepted>;
  evidence(userId?: string): Promise<Record<string, string[]>>;
  startWorker(): Promise<void>;
  done(dispatchId: string): Promise<void>;
  dropAcceptedBody(command: CompanionNamingRequest): Promise<CompanionNamingAccepted>;
  actualResetToken(who: NamingHttpActor): Promise<string>;
}

/** Real app factory, PostgreSQL, file parsers, HTTP cookies, Redis and runtime.
 * Reused prebirth assets are explicitly fictional, not professional approval.
 * Every model/mail network destination is checked before translating to owned
 * loopback. No service override, production test hook or authority boolean. */
export async function withNamingHttpFixture(run: (fixture: NamingHttpFixture) => Promise<void>, decision: 'L0' | 'L1' | 'L2' = 'L0', options: { apiLimit?: number } = {}) {
  assert(process.env.PLATFORM_DATABASE_URL, 'Supply a dedicated verification PostgreSQL URL.');
  assert(process.env.PLATFORM_REDIS_URL, 'Supply a dedicated verification Redis URL.');
  const base = readConfig(), database = new URL(base.databaseUrl), redis = new URL(base.redisUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname));
  assert(database.port && !['5432', '5442'].includes(database.port), 'Preserve non-verification PostgreSQL.');
  assert(redis.port && !['6379', '6388'].includes(redis.port), 'Preserve non-verification Redis.');
  await withPrebirthLoopback(async (runtime, requests) => {
    const prebirth = await createPrebirthFixture();
    assert.match(prebirth.schema, /^companion_name_[0-9a-f]{32}$/);
    let system: System | undefined, queue: CompanionNameQueue | undefined, directory: string | undefined;
    const workers: ReturnType<typeof createCompanionNameWorker>[] = [];
    try {
      const ready = await prebirth.ready(runtime);
      await prebirth.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [ready.who.userId, await hashPassword(namingHttpPassword)]);
      const localRoot = fileURLToPath(new URL('../../.local/', import.meta.url));
      await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(localRoot, 'companion-naming-http-'));
      await fs.chmod(directory, 0o700);
      async function asset(name: string, value: unknown) {
        const filename = path.join(directory!, name);
        await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        return filename;
      }
      database.searchParams.set('options', '-c search_path=' + prebirth.schema);
      const mail: AccountEmailConfig = { apiKey: 're_fictional_naming_loopback_only',
        from: 'Fictional naming QA <no-reply@example.invalid>', webOrigin: namingHttpOrigin, encryptionKey: Buffer.alloc(32, 0x69) };
      const config = { ...base, ...prebirth.config, databaseUrl: database.toString(),
        queueName: 'naming-http-fixture-' + randomUUID(), allowedOrigins: new Set([namingHttpOrigin]),
        storageDir: directory, accountEmail: mail, requireVerifiedEmail: true, workbenchEnabled: false,
        secureCookies: false, s3: undefined, mcp: undefined, webStaticDir: undefined,
        safetyDetectorProfilePath: await asset('fictional-detector.json', prebirthDetector),
        safetyResponseBundlePath: await asset('fictional-responses.json', prebirth.bundle),
        companionIdentityBundlePath: await asset('fictional-identity.json', ready.authority.asset),
        companionIdentityReviewPath: await asset('fictional-identity-review.json', ready.authority.review) };
      system = await buildApp({ db: prebirth.db, config, legalBundle: FICTIONAL_LEGAL, runtime, enableQueue: false,
        requestLimits: { policies: Object.fromEntries(['api', 'control', 'auth-login', 'auth-email-request', 'auth-email-consume']
          .map(scope => [scope, { max: scope === 'api' ? options.apiLimit ?? 2000 : 2000, windowSeconds: 60 }])) } });
      queue = new CompanionNameQueue(system.naming);
      const current = system, notifications = queue;
      const address = await current.app.listen({ host: '127.0.0.1', port: 0 });
      async function login(userId: string, password = namingHttpPassword): Promise<NamingHttpActor> {
        const account = (await prebirth.db.query('SELECT email FROM platform_users WHERE id=$1', [userId])).rows[0];
        assert(account);
        const response = await current.app.inject({ method: 'POST', url: namingHttpPrefix + '/auth/login',
          headers: { origin: namingHttpOrigin }, payload: { email: account.email, password } });
        assertPrivateNamingResponse(response, 200);
        const user = response.json().user;
        assert.equal(user.id, userId);
        const header = response.headers['set-cookie'];
        const setCookie = Array.isArray(header) ? header[0] : header;
        assert(typeof setCookie === 'string');
        assert.match(setCookie, /HttpOnly/);
        const cookie = setCookie.split(';')[0]!, raw = cookie.slice('companion_session='.length);
        return { userId, cookie, tokenHash: tokenHash(raw), email: account.email, password };
      }
      const who = await login(ready.who.userId);
      const f: NamingHttpFixture = { prebirth, ready, system: current, queue: notifications, requests, who, address, mail, login,
        async other(staff = false) {
          const actor = await prebirth.actor(staff);
          await prebirth.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [actor.userId, await hashPassword(namingHttpPassword)]);
          return login(actor.userId);
        },
        command(name = '舟', expectedEntryRevision = 0, expectedIdentityRevision = 0) {
          return { taskId: ready.prepared.taskId, operationId: randomUUID(), expectedEntryRevision, expectedIdentityRevision, name };
        },
        async accept(command, actor = who) {
          const response = await current.app.inject({ method: 'POST', url: namingHttpPrefix + '/companion/naming/submissions',
            headers: namingHttpHeaders(actor), payload: command });
          assertPrivateNamingResponse(response, 202);
          const accepted = response.json<CompanionNamingAccepted>();
          assert.equal(accepted.acceptance.operation.id, command.operationId);
          return accepted;
        },
        async evidence(userId = who.userId) {
          const snapshot: Record<string, string[]> = {};
          for (const table of evidenceTables) snapshot[table] = (await prebirth.db.query(`SELECT row_to_json(t)::text AS value
            FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`, [userId])).rows.map(row => row.value);
          return snapshot;
        },
        async startWorker() {
          const worker = createCompanionNameWorker(current.naming); workers.push(worker);
          await worker.waitUntilReady();
        },
        async done(dispatchId) {
          await observeNamingUntil(async () => {
            const job = await notifications.queue.getJob(dispatchId);
            return !!job && ['completed', 'failed'].includes(await job.getState());
          }, 'real naming worker completion');
          const job = await notifications.queue.getJob(dispatchId); assert(job);
          assert.equal(await job.getState(), 'completed', job.failedReason);
        },
        async dropAcceptedBody(command) {
          // buildApp is already ready, so Fastify cannot register a new onSend
          // hook. Intercept only this actual Node response.end AFTER Fastify's
          // real onSend/serialization path and confirm a separate DB reader can
          // see COMMIT before destroying the real socket. This is not a fake
          // handler response, database result or production test hook.
          let resolve!: (accepted: CompanionNamingAccepted) => void, reject!: (cause: unknown) => void;
          const committed = new Promise<CompanionNamingAccepted>((done, fail) => { resolve = done; reject = fail; });
          let armed = true;
          const intercept = (request: http.IncomingMessage, response: http.ServerResponse) => {
            if (!armed || request.method !== 'POST' || request.url !== namingHttpPrefix + '/companion/naming/submissions') return;
            armed = false;
            const originalEnd = response.end;
            response.end = (function(this: http.ServerResponse, ...args: any[]) {
              response.end = originalEnd;
              void (async () => {
                assert.equal(response.statusCode, 202);
                assert(typeof args[0] === 'string' || Buffer.isBuffer(args[0]));
                const accepted = JSON.parse(String(args[0])) as CompanionNamingAccepted;
                assert.equal(accepted.acceptance.operation.id, command.operationId);
                const row = (await prebirth.db.query(`SELECT d.id,s.first_name_dispatch_id
                  FROM platform_companion_name_dispatches d JOIN platform_companion_name_submissions s
                    ON s.id=d.submission_id AND s.user_id=d.user_id WHERE d.user_id=$1 AND d.operation_id=$2`, [who.userId, command.operationId])).rows[0];
                assert(row); assert.equal(row.id, accepted.acceptance.dispatchId); assert.equal(row.first_name_dispatch_id, row.id);
                resolve(accepted); response.destroy();
              })().catch(cause => { reject(cause); response.destroy(); });
              return this;
            }) as typeof response.end;
          };
          current.app.server.prependListener('request', intercept);
          const timer = setTimeout(() => reject(new Error('Actual committed response interception was not reached.')), 7000);
          try {
            const dropped = new Promise<void>((done, fail) => {
              const request = http.request(address + namingHttpPrefix + '/companion/naming/submissions', {
                method: 'POST', agent: false, headers: { ...namingHttpHeaders(who), 'content-type': 'application/json' } }, response => {
                response.resume(); fail(new Error('The intentionally dropped 202 must not reach the TCP client.'));
              });
              request.setTimeout(8000, () => request.destroy(new Error('Owned HTTP fixture timed out.')));
              request.on('error', cause => {
                if ((cause as NodeJS.ErrnoException).code === 'ECONNRESET') done(); else fail(cause);
              });
              request.end(JSON.stringify(command));
            });
            const [accepted] = await Promise.all([committed, dropped]); return accepted;
          } finally { clearTimeout(timer); current.app.server.removeListener('request', intercept); }
        },
        async actualResetToken(actor) {
          const requested = await current.app.inject({ method: 'POST', url: namingHttpPrefix + '/auth/password-reset/request',
            headers: { origin: namingHttpOrigin }, payload: { email: actor.email } });
          assertPrivateNamingResponse(requested, 202); assert.deepEqual(requested.json(), { accepted: true });
          const delivered: AccountEmailPayload[] = []; let failure: unknown;
          const server = http.createServer(async (request, response) => {
            try {
              assert.equal(request.method, 'POST'); assert.equal(request.url, '/emails');
              const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const mailBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AccountEmailPayload;
              assert.equal(mailBody.to, actor.email); delivered.push(mailBody);
              response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID() }));
            } catch (cause) { failure = cause; response.destroy(); }
          });
          await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
          const listener = server.address(); assert(listener && typeof listener === 'object');
          try {
            assert.equal(await processAccountEmails(prebirth.db, mail, { limit: 1, fetch: (target, init) => {
              assert.equal(String(target), 'https://api.resend.com/emails'); assert.equal(init?.redirect, 'error');
              assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + mail.apiKey);
              return fetch(`http://127.0.0.1:${listener.port}/emails`, init);
            } }), 1);
            if (failure) throw failure;
            assert.equal(delivered.length, 1);
            const link = /https:\/\/[^\s]+/.exec(delivered[0]!.text)?.[0]; assert(link);
            const actual = new URL(link); assert.equal(actual.origin, namingHttpOrigin);
            const fields = new URLSearchParams(actual.hash.slice(1)); assert.equal(fields.get('account-action'), 'password-reset');
            const token = fields.get('token'); assert(token && /^[A-Za-z0-9_-]{43}$/.exec(token)?.[0] === token);
            const action = (await prebirth.db.query('SELECT token_hash FROM platform_account_actions WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL', [actor.userId, 'password-reset'])).rows[0];
            assert(action); assert.equal(action.token_hash, tokenHash(token)); return token;
          } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
        },
      };
      await run(f);
    } finally {
      try {
        await Promise.all(workers.map(worker => worker.close()));
        if (queue) {
          assert.match(queue.entry.config.queueName, /^naming-http-fixture-[0-9a-f-]{36}$/);
          try { await queue.queue.obliterate({ force: true }); } finally { await queue.close(); }
        }
      } finally {
        try { if (system) await system.app.close(); }
        finally {
          try { await prebirth.close(); }
          finally {
            if (directory) {
              assert.equal(path.dirname(directory), fileURLToPath(new URL('../../.local/', import.meta.url)).replace(/\/$/, ''));
              assert.match(path.basename(directory), /^companion-naming-http-[A-Za-z0-9]+$/);
              await fs.rm(directory, { recursive: true, force: true });
              await assert.rejects(fs.stat(directory), (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT');
            }
          }
        }
      }
    }
  }, decision);
}
