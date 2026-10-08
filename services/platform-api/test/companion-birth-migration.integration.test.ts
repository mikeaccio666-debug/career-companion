import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';

// These cases establish storage consistency and legacy compatibility only.
// Fictional SQL fixtures are not current identity, reviewed assets or birth
// authorization. No provider, renderer, student route or actual birth runs.
const sqlRoot = new URL('../migrations/', import.meta.url);
const birthSQL = await readFile(new URL('051_companion_birth.sql', sqlRoot), 'utf8');
const constraint = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

async function fixture(run: (db: Database, who: string, companion: string, legacy: string) => Promise<void>, oldOnly = false) {
  assert(process.env.PLATFORM_DATABASE_URL, 'Supply a dedicated verification PostgreSQL URL.');
  const base = readConfig(), url = new URL(base.databaseUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.notEqual(url.port, '5442', 'Preserve the development database.');
  const schema = 'birth_storage_' + randomUUID().replaceAll('-', '');
  url.searchParams.set('options', '-c search_path=' + schema);
  const admin = new Database(base.databaseUrl), db = new Database(url.toString());
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    if (oldOnly) {
      const names = (await readdir(sqlRoot)).filter(name => /^\d+.*\.sql$/.test(name) && name < '051').sort();
      await db.transaction(async client => {
        await client.query('CREATE TABLE platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
        for (const name of names) {
          await client.query(await readFile(new URL(name, sqlRoot), 'utf8'));
          await client.query('INSERT INTO platform_migrations(name) VALUES($1)', [name]);
        }
      });
    } else await db.migrate();
    const who = randomUUID(), companion = randomUUID(), legacy = randomUUID();
    await db.query(`INSERT INTO platform_users(id,email,name,password_hash)
      VALUES($1,$2,'Fictional migration owner','fictional-unused-hash')`, [who, who + '@example.invalid']);
    await db.query(`INSERT INTO platform_companions(id,user_id,status,current_revision,fingerprint)
      VALUES($1,$2,'drafting',0,repeat('0',64))`, [companion, who]);
    await db.query(`INSERT INTO platform_conversations(id,user_id,title,mode,persona)
      VALUES($1,$2,'Fictional legacy record','chat','Fictional legacy persona')`, [legacy, who]);
    await db.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status)
      VALUES($1,$2,'assistant','Fictional stored legacy message','complete')`, [randomUUID(), legacy]);
    await run(db, who, companion, legacy);
  } finally {
    await db.close();
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      }
    } finally { await admin.close(); }
  }
}

async function children(db: Database, who: string) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_birth_receipts WHERE user_id=$1) AS receipts,
    (SELECT count(*)::int FROM platform_companion_birth_assets WHERE user_id=$1) AS assets,
    (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1 AND kind='main') AS mains,
    (SELECT count(*)::int FROM platform_messages WHERE user_id=$1 AND kind='event') AS events,
    (SELECT count(*)::int FROM platform_companions WHERE user_id=$1 AND status='active') AS active`, [who])).rows[0];
}
const noBirth = { receipts: 0, assets: 0, mains: 0, events: 0, active: 0 };

test('birth migration preserves existing legacy data and drafting state without adopting a main or seeding authority', async () => {
  await fixture(async (db, who, companion, legacy) => {
    const oldRoom = (await db.query('SELECT id,user_id,title,mode,persona,created_at,updated_at FROM platform_conversations WHERE id=$1', [legacy])).rows[0];
    const oldMessages = (await db.query('SELECT id,conversation_id,role,content,status,created_at FROM platform_messages WHERE conversation_id=$1', [legacy])).rows;
    const oldCompanion = (await db.query('SELECT id,user_id,status,current_revision,fingerprint,created_at,updated_at FROM platform_companions WHERE id=$1', [companion])).rows[0];
    await db.migrate();
    assert.deepEqual((await db.query('SELECT id,user_id,title,mode,persona,created_at,updated_at FROM platform_conversations WHERE id=$1', [legacy])).rows[0], oldRoom);
    assert.deepEqual((await db.query('SELECT id,conversation_id,role,content,status,created_at FROM platform_messages WHERE conversation_id=$1', [legacy])).rows, oldMessages);
    assert.deepEqual((await db.query('SELECT id,user_id,status,current_revision,fingerprint,created_at,updated_at FROM platform_companions WHERE id=$1', [companion])).rows[0], oldCompanion);
    const room = (await db.query('SELECT kind,companion_id,birth_receipt_id FROM platform_conversations WHERE id=$1', [legacy])).rows[0];
    assert.deepEqual(room, { kind: 'legacy', companion_id: null, birth_receipt_id: null });
    assert.deepEqual(await children(db, who), noBirth);
    // Old internal writes remain legacy, including deletion of an ordinary room.
    await db.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status)
      VALUES($1,$2,'user','Fictional later legacy message','complete')`, [randomUUID(), legacy]);
    assert.equal((await db.query('SELECT 1 FROM platform_messages WHERE conversation_id=$1 AND room_kind=$2', [legacy, 'legacy'])).rowCount, 2);
    await db.query('DELETE FROM platform_conversations WHERE id=$1 AND user_id=$2', [legacy, who]);
    assert.equal((await db.query('SELECT 1 FROM platform_messages WHERE conversation_id=$1', [legacy])).rowCount, 0);
    assert.deepEqual(await children(db, who), noBirth);
  }, true);
});

test('the exact birth SQL can be repeated without rewriting stored legacy records or creating birth state', async () => {
  await fixture(async (db, who, _companion, legacy) => {
    assert.equal((await db.query('SELECT 1 FROM platform_migrations WHERE name=$1', ['051_companion_birth.sql'])).rowCount, 0);
    await db.transaction(client => client.query(birthSQL));
    const first = (await db.query('SELECT * FROM platform_conversations WHERE id=$1', [legacy])).rows[0];
    await db.transaction(client => client.query(birthSQL));
    await db.migrate();
    assert.deepEqual((await db.query('SELECT * FROM platform_conversations WHERE id=$1', [legacy])).rows[0], first);
    assert.deepEqual(await children(db, who), noBirth);
    assert.equal((await db.query('SELECT 1 FROM platform_migrations WHERE name=$1', ['051_companion_birth.sql'])).rowCount, 1);
  }, true);
});

test('a standalone main and a complete-looking active row fail at the real COMMIT and leave no partial birth', async () => {
  await fixture(async (db, who, companion) => {
    const before = (await db.query('SELECT * FROM platform_companions WHERE id=$1', [companion])).rows[0];
    await assert.rejects(db.transaction(async client => {
      await client.query(`INSERT INTO platform_conversations(id,user_id,title,mode,kind,companion_id,birth_receipt_id)
        VALUES($1,$2,'Fictional orphan main','companion','main',$3,$4)`, [randomUUID(), who, companion, randomUUID()]);
      assert.equal((await client.query('SELECT 1 FROM platform_conversations WHERE user_id=$1 AND kind=$2', [who, 'main'])).rowCount, 1);
    }), constraint('23503'));
    assert.deepEqual(await children(db, who), noBirth);
    await assert.rejects(db.transaction(async client => {
      await client.query(`UPDATE platform_companions SET status='active',current_revision=1,name='Fictional',name_origin='user_typed',
        seal_char='墨',seal_candidates='["墨","如","舟"]',ink_token='dai',relationship_stage='acquainting',
        stage_changed_at=date_trunc('milliseconds',now()),born_at=date_trunc('milliseconds',now()),
        birth_receipt_id=$2,birth_idempotency_key=$3,seal_asset_id=$4 WHERE id=$1`,
      [companion, randomUUID(), randomUUID(), randomUUID()]);
      assert.equal((await client.query('SELECT 1 FROM platform_companions WHERE id=$1 AND status=$2', [companion, 'active'])).rowCount, 1);
    }), constraint('23503'));
    assert.deepEqual((await db.query('SELECT * FROM platform_companions WHERE id=$1', [companion])).rows[0], before);
    assert.deepEqual(await children(db, who), noBirth);
  });
});

test('legacy records cannot be adopted as main and main defaults cannot borrow a legacy speaker', async () => {
  await fixture(async (db, who, companion, legacy) => {
    const before = (await db.query('SELECT * FROM platform_conversations WHERE id=$1', [legacy])).rows[0];
    await assert.rejects(db.query(`UPDATE platform_conversations SET kind='main',mode='companion',persona=NULL,
      companion_id=$2,birth_receipt_id=$3 WHERE id=$1`, [legacy, companion, randomUUID()]), constraint('23514'));
    assert.deepEqual((await db.query('SELECT * FROM platform_conversations WHERE id=$1', [legacy])).rows[0], before);
    await assert.rejects(db.transaction(async client => {
      const main = randomUUID();
      await client.query(`INSERT INTO platform_conversations(id,user_id,title,mode,kind,companion_id,birth_receipt_id)
        VALUES($1,$2,'Fictional pending main','companion','main',$3,$4)`, [main, who, companion, randomUUID()]);
      // An old generic writer omits room_kind/owner/speaker. The parent-kind
      // FK rejects it before any main message can be committed.
      await client.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status)
        VALUES($1,$2,'assistant','Fictional generic message','complete')`, [randomUUID(), main]);
    }), constraint('23503'));
    assert.deepEqual(await children(db, who), noBirth);
  });
});
