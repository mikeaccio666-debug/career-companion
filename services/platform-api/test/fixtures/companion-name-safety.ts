import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../../src/database.ts';
import { readConfig } from '../../src/config.ts';
import { readDataCrypto } from '../../src/data-crypto.ts';
import { tokenHash, type FixedSessionContext } from '../../src/auth.ts';
import { OnboardingDrafts } from '../../src/onboarding-drafts.ts';
import { CompanionDraftPreparation } from '../../src/companion-draft-preparation.ts';
import { BackgroundGeneration } from '../../src/background-generation.ts';
import { CompanionIdentityDrafts } from '../../src/companion-identity-drafts.ts';
import { CompanionNameSafety } from '../../src/companion-name-safety.ts';
import { expectedCompanionIdentityBundleDigest, parseCompanionIdentityBundle, type CompanionIdentityBundle } from '../../src/companion-identity-bundle.ts';
import { expectedCompanionIdentityReviewDigest, parseCompanionIdentityReview } from '../../src/companion-identity-review.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './student-entry.ts';

/** Fictional assets do not establish professional review or production launch
 * approval. Every task below nevertheless traverses actual PostgreSQL and the
 * actual completed runtime/call/cost path; provider I/O must be loopback. */
export function fictionalNameBundle(revision = 7): Readonly<CompanionIdentityBundle> {
  const content = { schemaVersion: 1, revision, sourceRefs: { names: 'https://example.invalid/fictional-name-safety-names',
    seals: 'https://example.invalid/fictional-name-safety-seals', aliases: 'https://example.invalid/fictional-name-safety-aliases' },
  policy: { familyOrPartner: ['伙伴甲'], teamOrOrg: ['角色甲'], abusive: ['坏词甲'], publicFigures: ['公众甲'],
    allowedSealCharacters: ['墨', '如', '舟', '远', '暖', '灯', '稳', '拾', '启', '朗'], englishSealAliases: [{ name: 'Juno', sealChar: '如' }] } };
  return parseCompanionIdentityBundle({ ...content, contentDigest: expectedCompanionIdentityBundleDigest(content) });
}
export async function createCompanionNameSafetyFixture() {
  const base = readConfig(), schema = 'companion_name_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.notEqual(url.port, '5442');
  url.searchParams.set('options', '-c search_path=' + schema);
  const admin = new Database(base.databaseUrl), db = new Database(url.toString()), crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'e5'.repeat(32) })!;
  const config = { dataCrypto: crypto, requireVerifiedEmail: true, safetyDailyModelCallLimit: 100,
    modelRoutes: { chat: { provider: 'openai' }, companion_generation: { provider: 'openai' }, safety_classify: { provider: 'openai' } } };
  const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
  async function actor(staff = false, name = 'Fictional owner'): Promise<FixedSessionContext> {
    const userId = randomUUID(), hash = tokenHash(randomUUID());
    await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
      VALUES($1,$2,$3,'fictional-unused-hash',$4,clock_timestamp())`, [userId, userId + '@example.invalid', name, staff ? 'staff' : 'student']);
    await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
    await seedFictionalConsent(db, userId); return { userId, tokenHash: hash };
  }
  async function identityAuthority(asset = fictionalNameBundle()) {
    const reviewer = await actor(true), operator = await actor(true), orgId = randomUUID();
    await db.query("INSERT INTO platform_orgs(id,slug,display_name,status) VALUES($1,$2,'Fictional name source fixture','active')", [orgId, 'name_' + orgId.replaceAll('-', '')]);
    for (const [user, role] of [[reviewer.userId, 'content_reviewer'], [operator.userId, 'ops']]) await db.query(`INSERT INTO platform_org_roles
      (org_id,user_id,role,status,granted_by,granted_at) VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [orgId, user, role, operator.userId]);
    const content = { schemaVersion: 1, bundleRevision: asset.revision, bundleDigest: asset.contentDigest,
      coverage: 'complete_eligible_level_one', reviewerUserId: reviewer.userId, reviewedAt: '2026-10-01T12:34:56.789Z',
      reviewEvidenceRef: 'https://example.invalid/fictional-name-review', tierOneSourceRef: 'https://example.invalid/fictional-name-tier-one' };
    const review = parseCompanionIdentityReview({ ...content, reviewDigest: expectedCompanionIdentityReviewDigest(content) });
    await db.query(`INSERT INTO platform_companion_identity_policy(singleton,revision,content_digest,review_digest,reviewed_by,org_id,activated_by,activated_at)
      VALUES(true,$1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
      content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,reviewed_by=EXCLUDED.reviewed_by,org_id=EXCLUDED.org_id,
      activated_by=EXCLUDED.activated_by,activated_at=EXCLUDED.activated_at`, [asset.revision, asset.contentDigest, review.reviewDigest, reviewer.userId, orgId, operator.userId]);
    return { asset, review, reviewer, operator, orgId };
  }
  async function ready(runtime: PlatformProviderRuntime, options: { who?: FixedSessionContext; generate?: boolean } = {}) {
    const who = options.who ?? await actor(), approver = await actor(true);
    await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
      VALUES($1,'fictional-name-preview','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, approver.userId]);
    let draft = await store.read(who);
    if (!draft) draft = (await store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
    while (draft.currentQuestion) draft = (await store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
      action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
    const prepared = await new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime).prepare(who, { expectedRevision: draft.revision });
    const background = new BackgroundGeneration(db, config, FICTIONAL_LEGAL, runtime);
    if (options.generate !== false) await background.generate(who, { taskId: prepared.taskId });
    const authority = await identityAuthority(), names = new CompanionIdentityDrafts(db, config, FICTIONAL_LEGAL, background, authority.asset, authority.review);
    const safety = new CompanionNameSafety(db, config, FICTIONAL_LEGAL, background, names);
    return { who, prepared, background, names, safety, authority };
  }
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db);
    const approver = await actor(true);
    await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
      VALUES(true,100000000,100000000,$1,clock_timestamp(),clock_timestamp())`, [approver.userId]);
    for (const [unit, price] of [['input_token', '1'], ['cached_input_token', '1'], ['cache_write_input_token', '1'], ['output_token', '2']]) await db.query(`INSERT INTO platform_model_prices
      (id,provider,model,capability,unit,micros_per_unit,effective_from) VALUES($1,'openai','fictional-companion-model','background',$2,$3,clock_timestamp())`, [randomUUID(), unit, price]);
  } catch (error) { await db.close(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); throw error; }
  return { db, config, crypto, schema, store, actor, ready, identityAuthority, async close() {
    await db.close(); try { await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      process.stdout.write(`Companion name fixture schema cleanup confirmed: ${schema}\n`);
    } finally { await admin.close(); }
  } };
}
