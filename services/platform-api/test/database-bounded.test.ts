import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { PoolClient } from 'pg';
import { Database, DatabaseOperationTimeout } from '../src/database.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
function fixture(query: (sql: string) => Promise<unknown> = async () => ({rows: []})) {
  const client = new EventEmitter() as PoolClient;
  const socket = new PassThrough(), calls: string[] = [], releases: (boolean | Error | undefined)[] = [];
  Object.defineProperty(client, 'connection', {value: {stream: socket}});
  client.query = (async (sql: string) => { calls.push(sql); return query(sql); }) as PoolClient['query'];
  client.release = error => { releases.push(error); };
  const db = Object.create(Database.prototype) as Database;
  Object.defineProperty(db, 'pool', {value: {connect: async () => client}});
  return {db, client, socket, calls, releases};
}

test('bounded read-only transactions release once after commit and reject delayed use of their captured client', async () => {
  const f = fixture(); let captured!: PoolClient;
  assert.equal(await f.db.withBoundedTransaction(async client => { captured = client; await client.query('SELECT 1'); return 7; }, {readOnly: true}), 7);
  assert.equal(f.calls[0], 'BEGIN READ ONLY'); assert.equal(f.calls.at(-1), 'COMMIT'); assert.deepEqual(f.releases, [false]);
  const before = f.calls.length; await assert.rejects(captured.query('SELECT private_late_work'), DatabaseOperationTimeout); assert.equal(f.calls.length, before);
  assert.equal(f.socket.destroyed, false); f.socket.destroy();
});
test('operation deadline actually destroys only the owned socket, frees its pool slot and prevents late callback queries', async () => {
  const callback = deferred<void>(), f = fixture(), unrelated = new PassThrough(); let captured!: PoolClient;
  await assert.rejects(f.db.withBoundedTransaction(async client => { captured = client; await callback.promise; await client.query('SELECT late'); }, {timeoutMs: 20}), DatabaseOperationTimeout);
  assert.equal(f.socket.destroyed, true); assert.equal(f.socket.closed, true); assert.equal(unrelated.destroyed, false); assert.deepEqual(f.releases, [true]);
  callback.resolve(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(captured.query('SELECT later'), DatabaseOperationTimeout); assert.equal(f.calls.some(sql => /late|COMMIT/.test(sql)), false); unrelated.destroy();
});
test('a rollback stalled behind a failed operation is also bounded and destroys the owned connection', async () => {
  const f = fixture(async sql => { if (sql === 'ROLLBACK') return new Promise(() => {}); return {rows: []}; });
  await assert.rejects(f.db.withBoundedTransaction(async () => { throw new Error('Fictional operation failed.'); }, {timeoutMs: 20}), /Fictional operation failed/);
  assert.equal(f.socket.closed, true); assert.deepEqual(f.releases, [true]); assert.equal(f.calls.at(-1), 'ROLLBACK');
});
test('normal query failure rolls back before reusing the client; native acquisition rejection never releases someone else', async () => {
  const f = fixture(); await assert.rejects(f.db.withBoundedTransaction(async () => { throw new Error('Fictional failure.'); }), /Fictional failure/);
  assert.deepEqual(f.calls.slice(-1), ['ROLLBACK']); assert.deepEqual(f.releases, [false]); f.socket.destroy();
  const db = Object.create(Database.prototype) as Database;
  Object.defineProperty(db, 'pool', {value: {connect: async () => { throw new Error('Fictional native acquire timeout.'); }}});
  await assert.rejects(db.withBoundedTransaction(async () => assert.fail('Must not be acquired.')), /native acquire timeout/);
});
test('pool limits remain finite and idle errors are counted safely without throwing or exposing their values', async () => {
  const db = new Database('postgresql://fictional@127.0.0.1:1/fictional', {max: 2, connectionTimeoutMillis: 100});
  assert.equal(db.pool.options.max, 2); assert.equal(db.pool.options.connectionTimeoutMillis, 100);
  db.pool.emit('error', new Error('Fictional private URL/SQL deliberately omitted.')); assert.equal(db.idleErrorCount, 1);
  await db.close(); assert.throws(() => new Database('unused', {max: 0}), /pool limits/); assert.throws(() => new Database('unused', {connectionTimeoutMillis: 0}), /pool limits/);
});
