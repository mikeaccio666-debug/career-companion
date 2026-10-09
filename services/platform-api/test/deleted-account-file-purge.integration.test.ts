import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UploadRemovals } from '../src/upload-removals.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';

async function fixture() {
  const f = await createCompanionNameSafetyFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fictional-account-purge-'));
  const storage = new LocalBlobStorage(directory), removals = new UploadRemovals(f.db, f.crypto, storage);
  async function file() {
    const who = await f.actor(), id = randomUUID(), key = randomUUID();
    await storage.put(key, Buffer.from('Fictional only.'));
    await f.db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, who.userId, 'Fictional.txt', 'text/plain', 15, key]);
    await removals.request(who, id, {operationId: randomUUID()});
    return {who, id, key};
  }
  async function count(id: string) {
    const r = await f.db.query(`SELECT (SELECT count(*)::int FROM platform_upload_removals WHERE upload_id=$1) records,
      (SELECT count(*)::int FROM platform_upload_removal_events WHERE upload_id=$1) events`, [id]);
    return r.rows[0];
  }
  return {...f, storage, removals, file, count, async close() {try {await f.close();} finally {await rm(directory, {recursive:true, force:true});}}};
}
const missing = (e: unknown) => e instanceof ApiError && e.code === 'STORAGE_NOT_FOUND';

test('cleanup after actual account deletion removes physical bytes and all identifying cleanup history', async () => {
  const f = await fixture(); try {
    const u = await f.file();
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [u.who.userId]);
    await f.removals.cleanup(u.id);
    await assert.rejects(f.storage.stat(u.key), missing);
    assert.deepEqual(await f.count(u.id), {records:0, events:0});
    await f.removals.cleanup(u.id); // Repeated maintenance needs no retained identity.
  } finally {await f.close();}
});

test('recovery purges already completed orphan history but preserves the live owner receipt', async () => {
  const f = await fixture(); try {
    const orphan = await f.file(), live = await f.file();
    for (const u of [orphan, live]) await f.removals.cleanup(u.id);
    const receipt = await f.removals.get(live.who, live.id);
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [orphan.who.userId]);
    await f.removals.recover();
    assert.deepEqual(await f.count(orphan.id), {records:0, events:0});
    assert.deepEqual(await f.removals.get(live.who, live.id), receipt);
    assert.deepEqual(await f.count(live.id), {records:1, events:3});
  } finally {await f.close();}
});

test('failed storage deletion retains the orphan journal until a later leased retry really removes bytes', async () => {
  const f = await fixture(); try {
    const u = await f.file(); await f.db.query('DELETE FROM platform_users WHERE id=$1', [u.who.userId]);
    const original = f.storage.delete.bind(f.storage); f.storage.delete = async () => {throw Error('Fictional private storage failure');};
    await f.removals.recover(); f.storage.delete = original;
    assert.deepEqual(await f.count(u.id), {records:1, events:2}); await f.storage.stat(u.key);
    const query = f.db.query.bind(f.db), bounded = f.db.withBoundedTransaction.bind(f.db);
    const future = (sql: string) => sql.replaceAll('clock_timestamp()', "(clock_timestamp()+interval '31 seconds')");
    f.db.query = (sql, values) => query(future(sql), values);
    f.db.withBoundedTransaction = (run, options) => bounded(client => {
      const q = client.query.bind(client);
      return run(new Proxy(client, {get(target, key) {return key === 'query' ? (sql:string, values:unknown[]) => q(future(sql), values) : Reflect.get(target, key);}}));
    }, options);
    try {await f.removals.recover();} finally {f.db.query=query; f.db.withBoundedTransaction=bounded;}
    await assert.rejects(f.storage.stat(u.key), missing); assert.deepEqual(await f.count(u.id), {records:0, events:0});
  } finally {await f.close();}
});

test('purging completed orphan history authenticates the actual receipt and rolls back on transaction failure', async () => {
  const f = await fixture(); try {
    const u = await f.file(); await f.removals.cleanup(u.id);
    await f.db.query('DELETE FROM platform_users WHERE id=$1', [u.who.userId]);
    const original = (await f.db.query('SELECT record_ciphertext FROM platform_upload_removals WHERE upload_id=$1', [u.id])).rows[0].record_ciphertext;
    await f.db.query('UPDATE platform_upload_removals SET record_ciphertext=$2 WHERE upload_id=$1', [u.id, Buffer.alloc(original.length)]);
    await assert.rejects(f.removals.cleanup(u.id), (e:unknown) => e instanceof ApiError && e.code==='UPLOAD_REMOVAL_UNAVAILABLE');
    assert.deepEqual(await f.count(u.id), {records:1, events:3});
    await f.db.query('UPDATE platform_upload_removals SET record_ciphertext=$2 WHERE upload_id=$1', [u.id, original]);
    const bounded = f.db.withBoundedTransaction.bind(f.db);
    f.db.withBoundedTransaction = (run, options) => bounded(async client => {await run(client); throw Error('Fictional failure before COMMIT');}, options);
    try {await assert.rejects(f.removals.cleanup(u.id));} finally {f.db.withBoundedTransaction=bounded;}
    assert.deepEqual(await f.count(u.id), {records:1, events:3});
    await f.removals.recover(); assert.deepEqual(await f.count(u.id), {records:0, events:0});
  } finally {await f.close();}
});

test('a different storage scope cannot erase pending cleanup coordinates after account deletion', async () => {
  const f = await fixture(); try {
    const u = await f.file(); await f.db.query('DELETE FROM platform_users WHERE id=$1', [u.who.userId]);
    const other = new LocalBlobStorage(path.join(os.tmpdir(), 'fictional-unused-' + randomUUID()));
    await new UploadRemovals(f.db, f.crypto, other).recover();
    assert.deepEqual(await f.count(u.id), {records:1, events:1}); await f.storage.stat(u.key);
    await f.removals.recover(); assert.deepEqual(await f.count(u.id), {records:0, events:0});
  } finally {await f.close();}
});

test('an older unavailable storage backlog cannot starve bounded completed-receipt purging', async () => {
  const f = await fixture(); try {
    const pending = [];
    for (let i=0;i<20;i++) pending.push(await f.file());
    const completed = [];
    for (let i=0;i<21;i++) {
      const u = await f.file(); await f.removals.cleanup(u.id);
      await f.db.query('DELETE FROM platform_users WHERE id=$1', [u.who.userId]); completed.push(u);
    }
    const other = new LocalBlobStorage(path.join(os.tmpdir(), 'fictional-unused-' + randomUUID()));
    const worker = new UploadRemovals(f.db, f.crypto, other);
    await worker.recover();
    assert.equal((await f.db.query("SELECT count(*)::int n FROM platform_upload_removals WHERE status='removed'")).rows[0].n, 1);
    await worker.recover();
    for (const u of completed) assert.deepEqual(await f.count(u.id), {records:0, events:0});
    for (const u of pending) {assert.deepEqual(await f.count(u.id), {records:1, events:1}); await f.storage.stat(u.key);}
  } finally {await f.close();}
});
