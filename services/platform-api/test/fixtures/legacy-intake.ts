import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOnboardingDraft, parseOnboardingCommand, transitionOnboardingDraft } from '@companion/career-core';
import type { OnboardingCommand, OnboardingDraft } from '@companion/platform-contracts';
import type { Database } from '../../src/database.ts';
import type { DataCrypto } from '../../src/data-crypto.ts';

/** Controlled pre-inbox 026-shaped raw fixture, not an organically old deployment.
 * Only the real reducer's unclassified commands/draft are stored. No modern
 * enrollment is removed, no constraint is disabled, and no safety result,
 * handling, authorization or historical receipt is manufactured. The separate
 * private PR39 -> 048 migration run supplies genuine old-version evidence.
 */
export async function seedControlledLegacyIntake(db: Database, crypto: DataCrypto, userId: string,
  texts: readonly [string, string]): Promise<{ draft: OnboardingDraft; textCommands: readonly [OnboardingCommand, OnboardingCommand] }> {
  return db.withBoundedTransaction(async client => {
    const schema = (await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0].schema;
    assert.match(schema, /^onboarding_safety_[0-9a-f]{32}$/, 'Use only this test\'s dedicated fictional schema.');
    const owner = (await client.query<{ account_kind: string; prebirth_inventory_owner_id: string | null }>(
      'SELECT account_kind,prebirth_inventory_owner_id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [userId])).rows[0];
    assert(owner); assert.equal(owner.account_kind, 'student'); assert.equal(owner.prebirth_inventory_owner_id, null);
    const absent = (await client.query(`SELECT
      (SELECT count(*)::int FROM platform_onboarding_drafts WHERE user_id=$1) AS drafts,
      (SELECT count(*)::int FROM platform_onboarding_operations WHERE user_id=$1) AS operations,
      (SELECT count(*)::int FROM platform_onboarding_safety_submissions WHERE user_id=$1) AS submissions,
      (SELECT count(*)::int FROM platform_companion_prebirth_heads WHERE user_id=$1) AS heads,
      (SELECT count(*)::int FROM platform_companion_prebirth_inventory WHERE user_id=$1) AS inventory`, [userId])).rows[0];
    assert.deepEqual(absent, { drafts: 0, operations: 0, submissions: 0, heads: 0, inventory: 0 });
    const at = async () => (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    const createdAt = await at();
    let draft = createOnboardingDraft({ id: randomUUID(), userId, at: createdAt });
    const start = parseOnboardingCommand({ expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } });
    draft = transitionOnboardingDraft(draft, start, { at: createdAt });
    const first = parseOnboardingCommand({ expectedRevision: draft.revision, operationId: randomUUID(),
      action: { kind: 'text', questionId: 'study', text: texts[0] } });
    const firstAt = await at(); draft = transitionOnboardingDraft(draft, first, { at: firstAt, textId: first.operationId });
    const second = parseOnboardingCommand({ expectedRevision: draft.revision, operationId: randomUUID(),
      action: { kind: 'text', questionId: 'study', text: texts[1] } });
    const secondAt = await at(); draft = transitionOnboardingDraft(draft, second, { at: secondAt, textId: second.operationId });
    const ciphertext = crypto.sealUtf8(JSON.stringify(draft), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext',
      rowId: draft.id, ownerId: userId, revision: draft.revision });
    await client.query(`INSERT INTO platform_onboarding_drafts(id,user_id,revision,payload_ciphertext,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [draft.id, userId, draft.revision, ciphertext, createdAt, draft.updatedAt]);
    for (const [command, timestamp] of [[start, createdAt], [first, firstAt], [second, secondAt]] as const) {
      const revision = command.expectedRevision + 1;
      const input = crypto.sealUtf8(JSON.stringify(command), { table: 'platform_onboarding_operations', column: 'request_ciphertext',
        rowId: command.operationId, ownerId: userId, revision });
      await client.query(`INSERT INTO platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision,request_ciphertext,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [userId, command.operationId, draft.id, revision, input, timestamp]);
    }
    return { draft, textCommands: [first, second] as const };
  });
}

export async function assertLegacyIntakeRemainsUnadopted(db: Database, userId: string): Promise<void> {
  const actual = (await db.query(`SELECT prebirth_inventory_owner_id,
    (SELECT count(*)::int FROM platform_companion_prebirth_heads WHERE user_id=$1) AS heads,
    (SELECT count(*)::int FROM platform_companion_prebirth_inventory WHERE user_id=$1) AS inventory
    FROM platform_users WHERE id=$1`, [userId])).rows[0];
  assert.deepEqual(actual, { prebirth_inventory_owner_id: null, heads: 0, inventory: 0 });
}

export async function legacyIntakeRawRows(db: Database, userId: string) {
  return {
    drafts: (await db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [userId])).rows,
    operations: (await db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id', [userId])).rows,
  };
}
