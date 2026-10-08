import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { CompanionBirthOriginStore } from '../src/companion-birth-origin-store.ts';
import { CompanionContextSources, type CompanionContextSourceSelection } from '../src/companion-context-source.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth, type ReadyBirth } from './fixtures/companion-birth.ts';

let fixture: PrebirthFixture;
before(async () => { fixture = await createPrebirthFixture(); });
after(async () => { await fixture?.close(); });
const origins = () => new CompanionBirthOriginStore(fixture.crypto);
const reader = (f: ReadyBirth) => new CompanionContextSources(fixture.db, origins(), f.ready.background, f.prebirth);
const denied = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const field of Object.values(value)) frozen(field);
}
async function born(f: ReadyBirth): Promise<CompanionContextSourceSelection> {
  const result = await f.service.birth(f.ready.who, f.body, f.key);
  return { companionId: result.receipt.identity.companionId, conversationId: result.receipt.main.id };
}
async function saved(who: FixedSessionContext) {
  const result: Record<string, unknown> = {};
  for (const table of ['platform_users', 'platform_sessions', 'platform_companions', 'platform_companion_answers',
    'platform_companion_generation_tasks', 'platform_companion_revisions', 'platform_companion_birth_receipts',
    'platform_companion_birth_assets', 'platform_conversations', 'platform_messages', 'platform_memories', 'platform_jobs']) {
    const ownerColumn = table === 'platform_users' ? 'id' : 'user_id';
    result[table] = (await fixture.db.query(`SELECT * FROM ${table} WHERE ${ownerColumn}=$1 ORDER BY 1`, [who.userId])).rows;
  }
  return result;
}

test('actual persisted birth and preview supply an owned frozen persona with no model work, turn, job or source rewrite', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), beforeRows = await saved(f.ready.who), count = calls.length;
    const source = await reader(f).observe(f.ready.who, selected); frozen(source);
    const proof = await fixture.db.withBoundedTransaction(client => f.ready.background.readSavedCompletedForViewerInTransaction(client, f.ready.who, { taskId: f.ready.prepared.taskId }));
    assert(proof);
    assert.equal(source.ownerId, f.ready.who.userId); assert.equal(source.companionId, selected.companionId);
    assert.equal(source.conversationId, selected.conversationId); assert.equal(source.persona.name, f.body.name);
    assert.equal(source.persona.styleCard, proof.envelope.preview.styleCard);
    assert.deepEqual(source.persona.samples, proof.envelope.preview.samples);
    assert.equal(source.persona.speaker, 'companion'); assert.equal(source.persona.revision, 1);
    assert.deepEqual(source.relationship, { ownerId: f.ready.who.userId, revision: 1, nickname: null, stage: 'acquainting' });
    assert.equal(source.provenance.proofKind, 'historical_completed_preview');
    assert.equal(source.provenance.taskId, f.ready.prepared.taskId);
    const task = (await fixture.db.query('SELECT source_receipt_version FROM platform_companion_generation_tasks WHERE id=$1', [f.ready.prepared.taskId])).rows[0];
    assert.equal(source.provenance.sourceReceiptVersion, task.source_receipt_version);
    assert([1, 2].includes(source.provenance.sourceReceiptVersion!));
    assert.equal(source.provenance.generatedBy, 'model'); assert.equal(source.provenance.previewRevision, 1);
    assert.deepEqual(await reader(f).observe(f.ready.who, selected), source);
    assert.deepEqual(await saved(f.ready.who), beforeRows); assert.equal(calls.length, count);
    assert.equal(fixture.db.pool.waitingCount, 0);
  });
});

test('birth is required and closed selection/session shapes cannot provide caller persona or borrowed identity', async () => {
  await withPrebirthLoopback(async runtime => {
    const f = await readyBirth(fixture, runtime), source = reader(f), unknown = { companionId: randomUUID(), conversationId: randomUUID() };
    await assert.rejects(source.observe(f.ready.who, unknown), denied(409));
    const selected = await born(f);
    for (const shape of [{ ...selected, persona: { name: 'Forged' } }, { ...selected, conversationId: 'not-a-room' },
      Object.create(selected), { get companionId() { throw Error('must not invoke accessor'); }, conversationId: selected.conversationId }]) {
      await assert.rejects(source.observe(f.ready.who, shape), denied(400));
    }
    await assert.rejects(source.observe({ ...f.ready.who, authVersion: '0' } as FixedSessionContext, selected), denied(401));
    await assert.rejects(source.observe({ ...f.ready.who, tokenHash: 'f'.repeat(64) }, selected), denied(401));
  });
});

test('real second account and different main IDs cannot read or adopt another companion source', async () => {
  await withPrebirthLoopback(async runtime => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), other = await fixture.actor();
    await assert.rejects(reader(f).observe(other, selected), denied(409));
    await assert.rejects(reader(f).observe(f.ready.who, { ...selected, companionId: randomUUID() }), denied(404));
    await assert.rejects(reader(f).observe(f.ready.who, { ...selected, conversationId: randomUUID() }), denied(404));
    const staff = await fixture.actor(true, 'Fictional context reader staff');
    await assert.rejects(reader(f).observe(staff, selected), denied(403));
  });
});

test('revoked and expired genuine sessions stop observation; deleted accounts cannot retain source access', async () => {
  await withPrebirthLoopback(async runtime => {
    for (const mutation of ['expire', 'revoke', 'delete']) {
      const f = await readyBirth(fixture, runtime), selected = await born(f);
      if (mutation === 'expire') await fixture.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [f.ready.who.tokenHash]);
      else if (mutation === 'revoke') await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [f.ready.who.userId]);
      else await fixture.db.query('DELETE FROM platform_users WHERE id=$1', [f.ready.who.userId]);
      await assert.rejects(reader(f).observe(f.ready.who, selected), denied(401));
    }
  });
});

test('fresh actual session can observe its historic persona after withdrawn admission; preparation still uses real current email/legal gates', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), original = await reader(f).observe(f.ready.who, selected), count = calls.length;
    const fresh = { userId: f.ready.who.userId, tokenHash: tokenHash(randomUUID()) };
    await fixture.db.transaction(async client => {
      await client.query('UPDATE platform_users SET auth_version=auth_version+1,email_verified_at=NULL WHERE id=$1', [fresh.userId]);
      await client.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1", [fresh.userId, fresh.tokenHash]);
      await client.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [fresh.userId]);
    });
    await assert.rejects(reader(f).observe(f.ready.who, selected), denied(401));
    assert.deepEqual(await reader(f).observe(fresh, selected), original);
    await assert.rejects(fixture.db.withBoundedTransaction(client => reader(f).prepareInTransaction(client, fresh, selected)), denied(403));
    await fixture.db.query('UPDATE platform_users SET email_verified_at=clock_timestamp() WHERE id=$1', [fresh.userId]);
    await assert.rejects(fixture.db.withBoundedTransaction(client => reader(f).prepareInTransaction(client, fresh, selected)), error => error instanceof ApiError && [403, 409].includes(error.status));
    assert.deepEqual(await reader(f).observe(fresh, selected), original); assert.equal(calls.length, count);
  });
});

test('preparation consults real surviving safety evidence; historic observation never serves as current L0 or turn permission', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), source = reader(f), observed = await source.observe(f.ready.who, selected), count = calls.length;
    assert.deepEqual(await fixture.db.withBoundedTransaction(client => source.prepareInTransaction(client, f.ready.who, selected)), observed);
    await fixture.db.query('UPDATE platform_companion_name_submissions SET result_ciphertext=$2 WHERE user_id=$1', [f.ready.who.userId, Buffer.from('fictional corrupted safety receipt')]);
    assert.deepEqual(await source.observe(f.ready.who, selected), observed);
    await assert.rejects(fixture.db.withBoundedTransaction(client => source.prepareInTransaction(client, f.ready.who, selected)), denied(503));
    assert.equal(calls.length, count);
    assert.equal((await fixture.db.query('SELECT id FROM platform_jobs WHERE user_id=$1', [f.ready.who.userId])).rowCount, 0);
  });
});

test('mutable SQL name does not impersonate a reviewed rename; relationship changes acquire no invented revision', async () => {
  await withPrebirthLoopback(async runtime => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), source = reader(f);
    await fixture.db.query("UPDATE platform_companions SET name='Forged' WHERE id=$1", [selected.companionId]);
    await assert.rejects(source.observe(f.ready.who, selected), denied(503));
    await fixture.db.query('UPDATE platform_companions SET name=$2 WHERE id=$1', [selected.companionId, f.body.name]);
    await fixture.db.query("UPDATE platform_companions SET relationship_stage='familiar',stage_changed_at=clock_timestamp() WHERE id=$1", [selected.companionId]);
    assert.equal((await source.observe(f.ready.who, selected)).relationship, null);
    await fixture.db.query("UPDATE platform_companions SET relationship_stage='acquainting' WHERE id=$1", [selected.companionId]);
    assert.equal((await source.observe(f.ready.who, selected)).relationship, null);
  });
});

test('immutable origin rejects direct corruption; damaged preview and failed task each close composition without repair', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    for (const column of ['origin', 'preview', 'status']) {
      const f = await readyBirth(fixture, runtime), selected = await born(f), source = reader(f), count = calls.length;
      if (column === 'origin') {
        await assert.rejects(fixture.db.query('UPDATE platform_companion_birth_receipts SET snapshot_ciphertext=$2 WHERE user_id=$1', [f.ready.who.userId, Buffer.from('fictional damaged birth origin')]));
        assert.equal((await source.observe(f.ready.who, selected)).persona.name, f.body.name);
        assert.equal(calls.length, count); continue;
      }
      else if (column === 'preview') await fixture.db.query('UPDATE platform_companion_revisions SET payload_ciphertext=set_byte(payload_ciphertext,octet_length(payload_ciphertext)-1,get_byte(payload_ciphertext,octet_length(payload_ciphertext)-1) # 1) WHERE user_id=$1', [f.ready.who.userId]);
      else await fixture.db.query("UPDATE platform_companion_generation_tasks SET status='failed',error_code='COMPANION_GENERATION_UNAVAILABLE' WHERE id=$1", [f.ready.prepared.taskId]);
      const beforeRows = await saved(f.ready.who);
      await assert.rejects(source.observe(f.ready.who, selected), denied(503));
      assert.deepEqual(await saved(f.ready.who), beforeRows); assert.equal(calls.length, count);
    }
  });
});

test('late genuine session invalidation inside source read rolls back; no saved source escapes final authorization', async () => {
  await withPrebirthLoopback(async runtime => {
    const f = await readyBirth(fixture, runtime), selected = await born(f);
    const source = new CompanionContextSources(fixture.db, origins(), {
      async readSavedCompletedForViewerInTransaction(client, who, input, signal) {
        const proof = await f.ready.background.readSavedCompletedForViewerInTransaction(client, who, input, signal);
        await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
        return proof;
      },
    }, f.prebirth);
    await assert.rejects(source.observe(f.ready.who, selected), denied(401));
    assert.equal((await reader(f).observe(f.ready.who, selected)).persona.name, f.body.name);
  });
});

test('cancellation after authentic preview verification aborts and leaves persisted state unchanged', async () => {
  await withPrebirthLoopback(async runtime => {
    const f = await readyBirth(fixture, runtime), selected = await born(f), beforeRows = await saved(f.ready.who), cancel = new AbortController();
    const source = new CompanionContextSources(fixture.db, origins(), {
      async readSavedCompletedForViewerInTransaction(client, who, input, signal) {
        const proof = await f.ready.background.readSavedCompletedForViewerInTransaction(client, who, input, signal);
        cancel.abort(); return proof;
      },
    }, f.prebirth);
    await assert.rejects(source.observe(f.ready.who, selected, cancel.signal), error => error instanceof DOMException && error.name === 'AbortError');
    assert.deepEqual(await saved(f.ready.who), beforeRows);
  });
});
