import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { DEFAULT_REQUEST_LIMIT_POLICIES, RequestLimits } from '../src/request-limits.ts';

const userId = '00000000-0000-4000-8000-0000000000ab';
interface Query { sql: string; values: unknown[]; }
function fixture(run?: (query: Query) => Promise<{ rows: Record<string, unknown>[] }>) {
  const queries: Query[] = [];
  const db: Pick<Database, 'transaction'> = {
    async transaction(callback) {
      const client = { async query(sql: string, values: unknown[] = []) {
        const query = { sql, values }; queries.push(query);
        return run ? run(query) : { rows: sql.startsWith('INSERT') ? [{ request_count: 1 }] : [] };
      } } as unknown as PoolClient;
      return callback(client);
    },
  };
  return { db, queries };
}
function safeUnavailable(error: unknown) {
  assert(error instanceof ApiError);
  assert.equal(error.status, 503); assert.equal(error.code, 'REQUEST_LIMIT_UNAVAILABLE');
  assert.equal(error.publicMessage, 'Request availability could not be confirmed. Please try again.');
  assert.equal(error.cause, undefined);
  return true;
}

test('production policies explicitly cover bounded account and anonymous scopes', () => {
  assert.deepEqual(DEFAULT_REQUEST_LIMIT_POLICIES, {
    api: { max: 120, windowSeconds: 60 }, chat: { max: 20, windowSeconds: 60 },
    speech: { max: 20, windowSeconds: 60 }, transcription: { max: 20, windowSeconds: 60 },
    realtime: { max: 4, windowSeconds: 3600 }, control: { max: 120, windowSeconds: 60 },
    'auth-login': { max: 20, windowSeconds: 60 }, 'auth-register': { max: 10, windowSeconds: 60 },
    public: { max: 120, windowSeconds: 60 },
  });
  assert(Object.isFrozen(DEFAULT_REQUEST_LIMIT_POLICIES));
  assert(Object.isFrozen(DEFAULT_REQUEST_LIMIT_POLICIES.chat));
});

test('verified UUIDs and canonical socket-IP digests are the only stored subjects', async () => {
  const { db, queries } = fixture(), limits = new RequestLimits(db);
  const result = await limits.consumeUser(userId.toUpperCase(), 'chat');
  assert.deepEqual(result, { allowed: true, remaining: 19, retryAfterSeconds: 0 });
  await limits.consumeAnonymous('127.0.0.1', 'auth-login');
  await limits.consumeAnonymous('::FFFF:127.0.0.1', 'auth-login');
  await limits.consumeAnonymous('2001:db8:0:0:0:0:0:1', 'public');
  await limits.consumeAnonymous('2001:db8::1', 'public');
  const counters = queries.filter(query => query.sql.startsWith('INSERT'));
  assert.deepEqual(counters[0].values, ['user', userId, 'chat', 20, 60]);
  assert.match(String(counters[1].values[1]), /^[a-f0-9]{64}$/);
  assert.deepEqual(counters[1].values, counters[2].values, 'IPv4-mapped IPv6 cannot create another quota');
  assert.deepEqual(counters[3].values, counters[4].values, 'equivalent IPv6 forms cannot create another quota');
  assert(!JSON.stringify(queries).includes('127.0.0.1'));
  assert(!JSON.stringify(queries).includes('2001:db8'));
});

test('cookies, forwarded address lists, non-UUID users and crossed scopes fail before storage', async () => {
  const { db, queries } = fixture(), limits = new RequestLimits(db);
  for (const subject of ['companion_session=synthetic-private-cookie', '', 'synthetic@example.invalid', '127.0.0.1']) {
    await assert.rejects(limits.consumeUser(subject, 'api'), safeUnavailable);
  }
  for (const address of ['', 'synthetic-forwarded-host', '127.0.0.1, 127.0.0.2', 'companion_session=synthetic-private-cookie']) {
    await assert.rejects(limits.consumeAnonymous(address, 'public'), safeUnavailable);
  }
  await assert.rejects(limits.consumeUser(userId, 'auth-login' as any), safeUnavailable);
  await assert.rejects(limits.consumeAnonymous('127.0.0.1', 'chat' as any), safeUnavailable);
  await assert.rejects(limits.consumeUser(userId, 'unbounded-fixture-scope' as any), safeUnavailable);
  assert.equal(queries.length, 0);
});

test('server overrides are validated and copied before later mutation', async () => {
  const { db, queries } = fixture(), chat = { max: 2, windowSeconds: 3 };
  const limits = new RequestLimits(db, { policies: { chat } });
  chat.max = 500; chat.windowSeconds = 500;
  assert.deepEqual(await limits.consumeUser(userId, 'chat'), { allowed: true, remaining: 1, retryAfterSeconds: 0 });
  assert.deepEqual(queries.find(query => query.sql.startsWith('INSERT'))!.values.slice(3), [2, 3]);
  for (const policy of [{ max: 0, windowSeconds: 60 }, { max: 1.5, windowSeconds: 60 },
    { max: Infinity, windowSeconds: 60 }, { max: 2_147_483_648, windowSeconds: 60 },
    { max: 1, windowSeconds: 0 }, { max: 1, windowSeconds: 0.5 }, { max: 1, windowSeconds: 86_401 }]) {
    assert.throws(() => new RequestLimits(db, { policies: { chat: policy } }), /Invalid request limit policy/);
  }
  assert.throws(() => new RequestLimits(db, { policies: { 'unbounded-fixture-scope': { max: 1, windowSeconds: 1 } } } as any));
  for (const options of [null, 1, [], { unbounded: true }, { policies: null }, { policies: [] }, { policies: { chat: null } },
    { policies: { chat: { max: 1, windowSeconds: 1, unbounded: true } } }]) {
    assert.throws(() => new RequestLimits(db, options as any), /Invalid request limit/);
  }
  for (const options of [{ cleanupEveryRequests: 1 }, { cleanupEveryRequests: NaN }, { cleanupBatchSize: 0 },
    { cleanupBatchSize: 1001 }, { cleanupTimeoutMs: 0 }, { cleanupTimeoutMs: 5001 }]) {
    assert.throws(() => new RequestLimits(db, options), /Invalid request limit cleanup/);
  }
  for (const counterTimeoutMs of [null, 0, 49, 5001, 50.5, NaN, Infinity, '100']) {
    assert.throws(() => new RequestLimits(db, { counterTimeoutMs } as any), /Invalid request limit counter timeout/);
  }
});

test('denial returns the locked store expiry with zero remaining; malformed store answers fail closed', async () => {
  const { db, queries } = fixture(async ({ sql }) => ({ rows: sql.startsWith('INSERT') ? [] : [{ request_count: 20, retry_after_seconds: 7 }] }));
  assert.deepEqual(await new RequestLimits(db).consumeUser(userId, 'chat'), { allowed: false, remaining: 0, retryAfterSeconds: 7 });
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[2].values, ['user', userId, 'chat']);
  for (const rows of [[], [{ request_count: 20, retry_after_seconds: 0 }], [{ request_count: 20, retry_after_seconds: 1.5 }],
    [{ request_count: 20, retry_after_seconds: 86_401 }], [{ request_count: 19, retry_after_seconds: 1 }]]) {
    const broken = fixture(async ({ sql }) => ({ rows: sql.startsWith('INSERT') ? [] : rows }));
    await assert.rejects(new RequestLimits(broken.db).consumeUser(userId, 'chat'), safeUnavailable);
  }
  const malformed = fixture(async () => ({ rows: [{ request_count: 21 }] }));
  await assert.rejects(new RequestLimits(malformed.db).consumeUser(userId, 'chat'), safeUnavailable);
});

test('counter connection, update and expiry-read errors become one sanitized 503', async () => {
  const privateError = new Error('Synthetic cookie, IP, body and connection credential details.');
  const connection: Pick<Database, 'transaction'> = { transaction: async () => { throw privateError; } };
  await assert.rejects(new RequestLimits(connection).consumeUser(userId, 'api'), safeUnavailable);
  const write = fixture(async ({ sql }) => { if (sql.startsWith('SELECT set_config')) return { rows: [] }; throw privateError; });
  await assert.rejects(new RequestLimits(write.db).consumeAnonymous('127.0.0.1', 'public'), safeUnavailable);
  const read = fixture(async ({ sql }) => { if (sql.startsWith('INSERT') || sql.startsWith('SELECT set_config')) return { rows: [] }; throw privateError; });
  await assert.rejects(new RequestLimits(read.db).consumeUser(userId, 'chat'), safeUnavailable);
});

test('counter statements use a validated transaction-local database timeout; timeout details stay private', async () => {
  for (const counterTimeoutMs of [undefined, 50, 5000]) {
    const { db, queries } = fixture();
    assert((await new RequestLimits(db, { counterTimeoutMs }).consumeUser(userId, 'chat')).allowed);
    assert.equal(queries.length, 2);
    assert.equal(queries[0].sql, "SELECT set_config('statement_timeout',$1,true)");
    assert.deepEqual(queries[0].values, [String(counterTimeoutMs ?? 2000)]);
    assert(queries[1].sql.startsWith('INSERT'), 'timeout is configured before the atomic counter statement');
  }
  const privateTimeout = Object.assign(new Error('Synthetic SQL, IP, cookie, body and connection credentials.'), { code: '57014' });
  for (const phase of ['configuration', 'counter', 'expiry']) {
    const { db, queries } = fixture(async ({ sql }) => {
      if (sql.startsWith('SELECT set_config')) {
        if (phase === 'configuration') throw privateTimeout;
        return { rows: [] };
      }
      if (sql.startsWith('INSERT')) {
        if (phase === 'counter') throw privateTimeout;
        return { rows: [] };
      }
      throw privateTimeout;
    });
    await assert.rejects(new RequestLimits(db, { counterTimeoutMs: 100 }).consumeUser(userId, 'chat'), safeUnavailable);
    assert.deepEqual(queries[0].values, ['100']);
    assert.equal(queries.length, phase === 'configuration' ? 1 : phase === 'counter' ? 2 : 3);
  }
});

test('cleanup is count gated, bounded, timed and coalesced during concurrent requests', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { db, queries } = fixture(async ({ sql }) => {
    if (sql.startsWith('WITH expired')) await pending;
    return { rows: sql.startsWith('INSERT') ? [{ request_count: 1 }] : [] };
  });
  const limits = new RequestLimits(db, { cleanupEveryRequests: 2, cleanupBatchSize: 3, cleanupTimeoutMs: 100 });
  await limits.consumeUser(userId, 'api');
  assert.equal(queries.length, 2, 'ordinary requests only configure their timeout and consume the counter');
  const second = limits.consumeUser(userId, 'api'), third = limits.consumeUser(userId, 'chat');
  await new Promise<void>(resolve => setImmediate(resolve));
  const deletes = queries.filter(query => query.sql.startsWith('WITH expired'));
  assert.equal(deletes.length, 1, 'concurrent attempts share the pending bounded cleanup');
  assert.deepEqual(deletes[0].values, [3]);
  assert.equal(queries.filter(query => query.sql.startsWith('SELECT set_config') && query.values[0] === '100').length, 1);
  assert.match(deletes[0].sql, /LIMIT \$1 FOR UPDATE SKIP LOCKED/);
  release();
  assert((await second).allowed); assert((await third).allowed);
  await limits.consumeUser(userId, 'control');
  assert.equal(queries.filter(query => query.sql.startsWith('WITH expired')).length, 1);
});

test('optional cleanup failure does not hide a confirmed counter decision', async () => {
  const { db } = fixture(async ({ sql }) => {
    if (sql.startsWith('WITH expired')) throw new Error('Synthetic private housekeeping failure.');
    return { rows: sql.startsWith('INSERT') ? [{ request_count: 1 }] : [] };
  });
  const limits = new RequestLimits(db, { cleanupEveryRequests: 2 });
  assert((await limits.consumeUser(userId, 'chat')).allowed);
  assert((await limits.consumeUser(userId, 'control')).allowed);
});
