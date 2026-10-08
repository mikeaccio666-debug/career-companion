import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject, orgKnowledgeBrand, careerRecordId, careerLibraryTime, STAFF_ROLES, type AgentSpeakerKey } from '@companion/platform-contracts';
import { parseOrgP0Asset, orgChoice, orgArray, orgInteger, orgText, orgAssetBody, orgAssetLegacyBody, orgAssetSpeakers } from '@companion/career-core';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import type { LegalBundle } from './legal-documents.ts';
import { StaffAccess, type StaffAuditAction } from './staff-access.ts';
import { splitKnowledgePassages } from './knowledge-sources.ts';
import { ApiError } from './errors.ts';
import type { BlobStorage } from './storage.ts';
import { parseOrgLicenseInput, parseOrgImport, parseOrgSearch, orgDigest, orgInvalid, orgUnavailable, orgDenied, orgStale, orgSourceContent, ORG_LICENSE_USES, ORG_AUDIENCES, uniq } from './org-knowledge-values.ts';

function fixed(v: FixedSessionContext) {
  const o = careerRecordObject(v, ['userId', 'tokenHash']);
  if (typeof o.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.tokenHash)) throw new ApiError(401, 'AUTH_REQUIRED', '请重新登录。');
  return Object.freeze({ userId: careerRecordId(o.userId), tokenHash: o.tokenHash });
}
export interface OrgPassage {
  readonly sourceId: string; readonly revision: number; readonly passageId: string;
  readonly title: string; readonly text: string; readonly updatedAt: string;
  readonly scope: 'org'; readonly assetClass: string; readonly provenanceLabel: string;
  readonly brand: string; readonly assetRevision: number | null;
  readonly provenance: 'untrusted_knowledge'; readonly deidentified: true; readonly older: boolean;
}
export class OrgKnowledge {
  private readonly store: OnboardingStorage;
  private readonly brand: string;
  private readonly staff: StaffAccess;
  constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail' | 'orgContentBrand'>, legal: LegalBundle | null, private readonly blobs: Pick<BlobStorage, 'stat'>, staff?: StaffAccess) {
    this.brand = orgKnowledgeBrand(config.orgContentBrand ?? '蔓藤'); this.store = new OnboardingStorage(config, legal); this.staff = staff ?? new StaffAccess(db);
  }
  private crypto() { if (!this.store.crypto) throw orgUnavailable(); return this.store.crypto; }
  private seal(table: string, id: string, ownerId: string, revision: number, value: unknown) {
    try { return this.crypto().sealUtf8(JSON.stringify(value), { table, column: 'payload', rowId: id, ownerId, revision }); } catch { throw orgUnavailable(); }
  }
  private open(table: string, id: string, ownerId: string, revision: number, cipher: Buffer): any {
    try { return JSON.parse(this.crypto().openUtf8(cipher, { table, column: 'payload', rowId: id, ownerId, revision })); } catch { throw orgUnavailable(); }
  }
  private async at(c: PoolClient) { return (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString() as string; }
  private async proof(c: PoolClient, orgId: string, kind: string, id: string, revision: number, value: unknown, userId: string | null = null) {
    const body = { orgId, kind, id, revision, digest: orgDigest(value) };
    await c.query('INSERT INTO platform_org_content_state_proofs(org_id,kind,object_id,revision,user_id,proof_ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
      [orgId, kind, id, revision, userId, this.seal('org_state_' + kind, id, orgId, revision, body)]);
  }
  private async verify(c: PoolClient, orgId: string, kind: string, id: string, revision: number, value: unknown) {
    const row = (await c.query('SELECT revision,proof_ciphertext FROM platform_org_content_state_proofs WHERE org_id=$1 AND kind=$2 AND object_id=$3 ORDER BY revision DESC LIMIT 1 FOR SHARE', [orgId, kind, id])).rows[0];
    if (!row || row.revision !== revision) throw orgUnavailable();
    const proof = careerRecordObject(this.open('org_state_' + kind, id, orgId, revision, row.proof_ciphertext), ['orgId', 'kind', 'id', 'revision', 'digest']);
    if (proof.orgId !== orgId || proof.kind !== kind || proof.id !== id || proof.revision !== revision || proof.digest !== orgDigest(value)) throw orgUnavailable();
  }
  private async operation<T>(c: PoolClient, orgId: string, action: StaffAuditAction, operationId: string, command: unknown, run: () => Promise<T>): Promise<T> {
    const old = (await c.query('SELECT receipt_ciphertext FROM platform_org_content_operations WHERE org_id=$1 AND operation_id=$2 FOR SHARE', [orgId, operationId])).rows[0];
    const digest = orgDigest(command);
    if (old) {
      const p = careerRecordObject(this.open('org_operation', operationId, orgId, 1, old.receipt_ciphertext), ['action', 'operationId', 'digest', 'result', 'reason']);
      if (p.operationId !== operationId || p.action !== action || p.digest !== digest) throw new ApiError(409, 'ORG_OPERATION_CONFLICT', '原操作已用于其他内容。');
      return p.result as T;
    }
    const result = await run();
    await c.query('INSERT INTO platform_org_content_operations(org_id,operation_id,receipt_ciphertext) VALUES($1,$2,$3)',
      [orgId, operationId, this.seal('org_operation', operationId, orgId, 1, { action, operationId, digest, result, reason: (command as { reason?: string }).reason ?? null })]);
    return result;
  }
  private async authorized<T>(session: FixedSessionContext, organizationId: string, action: StaffAuditAction, command: { operationId: string }, run: (c: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const s = fixed(session), orgId = careerRecordId(organizationId);
    const target = command as { sourceId?: string; batchId?: string; licenseId?: string; userId?: string };
    const targetId = target.sourceId ?? target.batchId ?? target.licenseId ?? target.userId ?? command.operationId;
    return this.staff.readWithAccess(s, orgId, { roles: ['ops', 'org_admin'], action, targetId, exclusiveOrganization: true }, async c => {
      // Serialize organization changes and duplicate nonces; source readers take SHARE.
      this.crypto(); signal?.throwIfAborted();
      const value = await this.operation(c, orgId, action, command.operationId, command, () => run(c));
      signal?.throwIfAborted(); return { value, recordCount: (value as { sourceIds?: string[] }).sourceIds?.length ?? 1 };
    }, signal);
  }
  async registerLicense(session: FixedSessionContext, organizationId: string, input: unknown, signal?: AbortSignal) {
    let cmd: ReturnType<typeof parseOrgLicenseInput>; try { cmd = parseOrgLicenseInput(input); } catch { throw orgInvalid(); }
    const s = fixed(session), orgId = careerRecordId(organizationId);
    return this.authorized(s, orgId, 'org_license_registered', cmd, async c => {
      const file = (await c.query('SELECT id,byte_size,storage_key FROM platform_uploads WHERE id=$1 AND user_id=$2 AND byte_size>0 FOR SHARE', [cmd.agreementRef, s.userId])).rows[0];
      if (!file) throw new ApiError(404, 'NOT_FOUND', '请先登记本人的私有授权凭据。');
      const actual = await this.blobs.stat(file.storage_key, signal).catch(() => { throw orgUnavailable(); });
      if (actual.size !== Number(file.byte_size)) throw orgUnavailable();
      const id = randomUUID(), payload = { id, orgId, assetClass: cmd.assetClass, agreementRef: cmd.agreementRef,
        allowedUses: cmd.allowedUses, audience: cmd.audience, validFrom: cmd.validFrom, validUntil: cmd.validUntil,
        revokedAt: null, revocationReason: null, revision: 1 };
      await c.query('INSERT INTO platform_content_licenses(id,org_id,asset_class,agreement_ref,allowed_uses,audience,valid_from,valid_until,revision,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)',
        [id, orgId, cmd.assetClass, cmd.agreementRef, cmd.allowedUses, cmd.audience, cmd.validFrom, cmd.validUntil, this.seal('org_license', id, orgId, 1, payload)]);
      await this.proof(c, orgId, 'license', id, 1, payload); return { licenseId: id, revision: 1 };
    }, signal);
  }
  private async license(c: PoolClient, orgId: string, id: string, uses: readonly string[], at: string) {
    const row = (await c.query('SELECT * FROM platform_content_licenses WHERE org_id=$1 AND id=$2 FOR SHARE', [orgId, id])).rows[0];
    if (!row) throw orgDenied();
    const p = careerRecordObject(this.open('org_license', id, orgId, row.revision, row.payload_ciphertext),
      ['id', 'orgId', 'assetClass', 'agreementRef', 'allowedUses', 'audience', 'validFrom', 'validUntil', 'revokedAt', 'revocationReason', 'revision']);
    if (p.id !== id || p.orgId !== orgId || p.revision !== row.revision || p.assetClass !== row.asset_class ||
        p.agreementRef !== row.agreement_ref || orgDigest(p.allowedUses) !== orgDigest(row.allowed_uses) || p.audience !== row.audience ||
        p.validFrom !== row.valid_from.toISOString() || p.validUntil !== row.valid_until.toISOString() ||
        p.revokedAt !== (row.revoked_at?.toISOString() ?? null)) throw orgUnavailable();
    orgArray(p.allowedUses, v => orgChoice(v, ORG_LICENSE_USES), 5, 1); orgChoice(p.audience, ORG_AUDIENCES);
    await this.verify(c, orgId, 'license', id, row.revision, p);
    const agreement = (await c.query('SELECT id FROM platform_uploads WHERE id=$1 FOR SHARE', [p.agreementRef])).rows[0];
    if (!agreement || p.revokedAt !== null || (p.validFrom as string) > at || (p.validUntil as string) <= at || uses.some(u => !(p.allowedUses as string[]).includes(u))) throw orgDenied();
    return p;
  }
  async revokeLicense(session: FixedSessionContext, organizationId: string, id: string, input: unknown, signal?: AbortSignal) {
    const v = careerRecordObject(input, ['operationId', 'expectedRevision', 'reason']), cmd = { operationId: careerRecordId(v.operationId), expectedRevision: orgInteger(v.expectedRevision, 1, 2147483646), reason: orgText(v.reason, 500), licenseId: careerRecordId(id) };
    const orgId = careerRecordId(organizationId);
    return this.authorized(session, orgId, 'org_license_revoked', cmd, async c => {
      const row = (await c.query('SELECT * FROM platform_content_licenses WHERE id=$1 AND org_id=$2 FOR UPDATE', [cmd.licenseId, orgId])).rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', '授权不存在。');
      const old = this.open('org_license', row.id, orgId, row.revision, row.payload_ciphertext);
      await this.verify(c, orgId, 'license', row.id, row.revision, old);
      if (row.revision !== cmd.expectedRevision) throw orgStale();
      const at = await this.at(c), payload = { ...old, revision: row.revision + 1, revokedAt: at, revocationReason: cmd.reason };
      await c.query('UPDATE platform_content_licenses SET revision=$3,revoked_at=$4,payload_ciphertext=$5 WHERE id=$1 AND org_id=$2',
        [row.id, orgId, payload.revision, at, this.seal('org_license', row.id, orgId, payload.revision, payload)]);
      await this.proof(c, orgId, 'license', row.id, payload.revision, payload); return { licenseId: row.id, revision: payload.revision };
    }, signal);
  }
  async setEntitlement(session: FixedSessionContext, organizationId: string, input: unknown, signal?: AbortSignal) {
    const v = careerRecordObject(input, ['operationId', 'userId', 'expectedRevision', 'audienceGrants', 'expiresAt', 'revoke']);
    if (typeof v.revoke !== 'boolean') throw orgInvalid();
    const cmd = { operationId: careerRecordId(v.operationId), userId: careerRecordId(v.userId),
      expectedRevision: orgInteger(v.expectedRevision, 0, 2147483646), audienceGrants: uniq(orgArray(v.audienceGrants, x => orgChoice(x, ['cohort', 'entitled'] as const), 2, 1)),
      expiresAt: careerLibraryTime(v.expiresAt), revoke: v.revoke }, orgId = careerRecordId(organizationId);
    return this.authorized(session, orgId, 'org_entitlement_changed', cmd, async c => {
      const user = (await c.query("SELECT id FROM platform_users WHERE id=$1 AND account_kind='student' FOR KEY SHARE", [cmd.userId])).rows[0];
      if (!user) throw new ApiError(404, 'NOT_FOUND', '学生账号不存在。');
      const old = (await c.query('SELECT * FROM platform_user_entitlements WHERE user_id=$1 AND org_id=$2 FOR UPDATE', [cmd.userId, orgId])).rows[0];
      if ((old?.revision ?? 0) !== cmd.expectedRevision || cmd.revoke && !old) throw orgStale();
      if (old) await this.verify(c, orgId, 'entitlement', old.id, old.revision, this.open('org_entitlement', old.id, cmd.userId, old.revision, old.payload_ciphertext));
      const at = await this.at(c);
      if (cmd.expiresAt <= at) throw orgInvalid();
      const id = old?.id ?? randomUUID(), revision = cmd.expectedRevision + 1, payload = { id, ownerId: cmd.userId, orgId, audienceGrants: cmd.audienceGrants,
        grantedAt: at, expiresAt: cmd.expiresAt, revokedAt: cmd.revoke ? at : null, revision };
      await c.query('INSERT INTO platform_user_entitlements(id,user_id,org_id,audience_grants,granted_at,expires_at,revoked_at,revision,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,org_id) DO UPDATE SET audience_grants=EXCLUDED.audience_grants,granted_at=EXCLUDED.granted_at,expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at,revision=EXCLUDED.revision,payload_ciphertext=EXCLUDED.payload_ciphertext',
        [id, cmd.userId, orgId, cmd.audienceGrants, at, cmd.expiresAt, payload.revokedAt, revision, this.seal('org_entitlement', id, cmd.userId, revision, payload)]);
      await this.proof(c, orgId, 'entitlement', id, revision, payload, cmd.userId); return { entitlementId: id, revision };
    }, signal);
  }
  private sourceState(row: any) {
    return { id: row.id, orgId: row.org_id, licenseId: row.license_id, revision: row.revision, reviewStatus: row.review_status,
      contentHash: row.content_hash, publishBatch: row.publish_batch, reviewedAt: row.reviewed_at?.toISOString() ?? null,
      validUntil: row.valid_until.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      withdrawnAt: row.withdrawn_at?.toISOString() ?? null, deidVersion: row.deid_version };
  }
  private async source(c: PoolClient, row: any) {
    const state = this.sourceState(row), proof = this.open('org_source', row.id, row.org_id, row.revision, row.receipt_ciphertext);
    if (orgDigest(proof) !== orgDigest(state)) throw orgUnavailable();
    await this.verify(c, row.org_id, 'source', row.id, row.revision, state);
    if (row.review_status !== 'withdrawn') {
      try {
        const asset = parseOrgP0Asset(row.asset_class, row.structured);
        if ((orgAssetBody(asset) !== row.body && orgAssetLegacyBody(asset) !== row.body) || orgDigest(orgSourceContent(row)) !== row.content_hash || row.deid_status !== 'passed') throw orgUnavailable();
      } catch { throw orgUnavailable(); }
    }
    return state;
  }
  private async writeSourceProof(c: PoolClient, id: string) {
    const row = (await c.query('SELECT * FROM platform_org_knowledge_sources WHERE id=$1', [id])).rows[0], state = this.sourceState(row);
    await c.query('UPDATE platform_org_knowledge_sources SET receipt_ciphertext=$2 WHERE id=$1', [id, this.seal('org_source', id, row.org_id, row.revision, state)]);
    await this.proof(c, row.org_id, 'source', id, row.revision, state);
  }
  async importBundle(session: FixedSessionContext, organizationId: string, input: unknown, signal?: AbortSignal) {
    let cmd: ReturnType<typeof parseOrgImport>; try { cmd = parseOrgImport(input); } catch { throw orgInvalid(); }
    const orgId = careerRecordId(organizationId);
    return this.authorized(session, orgId, 'org_content_imported', cmd, async c => {
      const at = await this.at(c), license = await this.license(c, orgId, cmd.licenseId, ['retrieve', 'model_context'], at);
      const emails = [...new Set(cmd.sources.flatMap(r => [r.editor, r.reviewer]))];
      const roles = (await c.query("SELECT u.id,u.email,r.role FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id WHERE r.org_id=$1 AND r.status='active' AND u.account_kind='staff' AND u.email=ANY($2::text[]) ORDER BY u.id,r.role FOR SHARE OF r", [orgId, emails])).rows;
      const person = (email: string, role: string) => { const row = roles.find(r => r.email === email && r.role === role); if (!row) throw new ApiError(403, 'STAFF_ROLE_REQUIRED', '编辑与审核员需要有效的独立员工角色。'); return row.id as string; };
      const batchId = randomUUID(), ids: string[] = [];
      await c.query('INSERT INTO platform_org_knowledge_batches(id,org_id,license_id,created_at) VALUES($1,$2,$3,$4)', [batchId, orgId, cmd.licenseId, at]);
      for (const r of cmd.sources) {
        signal?.throwIfAborted();
        const editorId = person(r.editor, 'content_editor'), reviewerId = person(r.reviewer, 'content_reviewer');
        if (r.assetClass === 'method_card' && ((r.structured as any).reviewer_id !== reviewerId || (r.structured as any).author_id === reviewerId)) throw orgInvalid();
        if (editorId === reviewerId || r.assetClass !== license.assetClass || r.validUntil <= at || r.validUntil > (license.validUntil as string)) throw orgInvalid();
        if (r.assetClass === 'question' && !(r.structured as any).external_ref && !(license.allowedUses as string[]).includes('display_full')) throw orgDenied();
        const id = randomUUID(), contentHash = orgDigest({ assetClass: r.assetClass, title: r.title, body: r.body, structured: r.structured, language: r.language, roleFamilies: r.roleFamilies, tags: r.tags });
        await c.query("INSERT INTO platform_org_knowledge_sources(id,org_id,batch_id,asset_class,title,body,structured,language,role_families,tags,license_id,deid_status,deid_version,review_status,editor_id,reviewer_id,valid_until,revision,content_hash,created_at,updated_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'passed',1,'in_review',$12,$13,$14,1,$15,$16,$16,$17)",
          [id, orgId, batchId, r.assetClass, r.title, r.body, JSON.stringify(r.structured), r.language, r.roleFamilies, r.tags, cmd.licenseId, editorId, reviewerId, r.validUntil, contentHash, at, Buffer.alloc(0)]);
        const passages = splitKnowledgePassages(id, 1, r.body);
        await c.query('INSERT INTO platform_org_knowledge_passages(source_id,revision,passage_id,passage_index,content) SELECT $1,1,p.id,p.i,p.t FROM jsonb_to_recordset($2::jsonb) AS p(id text,i integer,t text)',
          [id, JSON.stringify(passages.map(p => ({ id: p.passageId, i: p.passageIndex, t: p.text })))]);
        await this.writeSourceProof(c, id); ids.push(id);
      }
      return { batchId, sourceIds: ids };
    }, signal);
  }
  async publishBatch(session: FixedSessionContext, organizationId: string, batchId: string, input: unknown, signal?: AbortSignal) {
    const v = careerRecordObject(input, ['operationId']), cmd = { operationId: careerRecordId(v.operationId), batchId: careerRecordId(batchId) }, orgId = careerRecordId(organizationId);
    return this.authorized(session, orgId, 'org_content_published', cmd, async c => {
      const rows = (await c.query('SELECT * FROM platform_org_knowledge_sources WHERE org_id=$1 AND batch_id=$2 ORDER BY id FOR UPDATE', [orgId, cmd.batchId])).rows;
      if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '导入批次不存在。');
      if (rows.some(r => r.review_status !== 'in_review')) throw orgStale();
      const at = await this.at(c), publishBatch = Number((await c.query("SELECT nextval('platform_org_publish_sequence') AS n")).rows[0].n);
      for (const row of rows) {
        signal?.throwIfAborted(); await this.source(c, row);
        const license = await this.license(c, orgId, row.license_id, ['retrieve', 'model_context'], at);
        if (row.valid_until.toISOString() <= at || row.valid_until.toISOString() > (license.validUntil as string)) throw orgDenied();
        const roles = (await c.query("SELECT r.user_id,r.role FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id WHERE r.org_id=$1 AND r.status='active' AND u.account_kind='staff' AND r.user_id=ANY($2::uuid[]) FOR SHARE OF r", [orgId, [row.editor_id, row.reviewer_id].filter(Boolean)])).rows;
        if (!row.editor_id || !row.reviewer_id || row.editor_id === row.reviewer_id || !roles.some(r => r.user_id === row.editor_id && r.role === 'content_editor') || !roles.some(r => r.user_id === row.reviewer_id && r.role === 'content_reviewer')) throw new ApiError(403, 'STAFF_ROLE_REQUIRED', '编辑或审核角色已变化，不能发布。');
        if (row.asset_class === 'question' && row.structured.rubric !== null && !roles.some(r => r.user_id === row.reviewer_id && r.role === 'mentor')) throw orgDenied();
        if (row.asset_class === 'method_card') {
          const author = (row.structured as any).author_id;
          if (!roles.some(r => r.user_id === row.reviewer_id && r.role === 'mentor') ||
              !(await c.query("SELECT 1 FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id WHERE r.org_id=$1 AND r.user_id=$2 AND r.role='mentor' AND r.status='active' AND u.account_kind='staff' FOR SHARE OF r", [orgId, careerRecordId(author)])).rowCount) throw orgDenied();
        }
        await c.query("UPDATE platform_org_knowledge_sources SET revision=revision+1,review_status='published',reviewed_at=$2,publish_batch=$3,updated_at=$2 WHERE id=$1", [row.id, at, publishBatch]);
        // Same content, new authenticated citation revision on publication.
        const parts = splitKnowledgePassages(row.id, row.revision + 1, row.body);
        await c.query('DELETE FROM platform_org_knowledge_passages WHERE source_id=$1', [row.id]);
        await c.query('INSERT INTO platform_org_knowledge_passages(source_id,revision,passage_id,passage_index,content) SELECT $1,$2,p.id,p.i,p.t FROM jsonb_to_recordset($3::jsonb) AS p(id text,i integer,t text)', [row.id, row.revision + 1, JSON.stringify(parts.map(p => ({ id: p.passageId, i: p.passageIndex, t: p.text })))]);
        await this.writeSourceProof(c, row.id);
      }
      return { batchId: cmd.batchId, publishBatch, sourceIds: rows.map(r => r.id) };
    }, signal);
  }
  async withdrawSource(session: FixedSessionContext, organizationId: string, sourceId: string, input: unknown, signal?: AbortSignal) {
    const v = careerRecordObject(input, ['operationId', 'expectedRevision', 'reason']), cmd = { operationId: careerRecordId(v.operationId), expectedRevision: orgInteger(v.expectedRevision, 1, 2147483646), reason: orgText(v.reason, 500), sourceId: careerRecordId(sourceId) }, orgId = careerRecordId(organizationId);
    return this.authorized(session, orgId, 'org_content_withdrawn', cmd, async c => {
      const row = (await c.query('SELECT * FROM platform_org_knowledge_sources WHERE id=$1 AND org_id=$2 FOR UPDATE', [cmd.sourceId, orgId])).rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', '来源不存在。');
      await this.source(c, row);
      if (row.revision !== cmd.expectedRevision || row.review_status === 'withdrawn') throw orgStale();
      const at = await this.at(c);
      await c.query("UPDATE platform_org_knowledge_sources SET revision=revision+1,review_status='withdrawn',withdrawn_at=$2,updated_at=$2,body='',structured='{}'::jsonb WHERE id=$1", [row.id, at]);
      await c.query('DELETE FROM platform_org_knowledge_passages WHERE source_id=$1', [row.id]);
      await this.writeSourceProof(c, row.id); return { sourceId: row.id, revision: row.revision + 1, withdrawn: true };
    }, signal);
  }
  private async entitlement(c: PoolClient, ownerId: string, orgId: string, row: any) {
    const p = careerRecordObject(this.open('org_entitlement', row.id, ownerId, row.revision, row.payload_ciphertext),
      ['id', 'ownerId', 'orgId', 'audienceGrants', 'grantedAt', 'expiresAt', 'revokedAt', 'revision']);
    if (p.id !== row.id || p.ownerId !== ownerId || p.orgId !== orgId || p.revision !== row.revision ||
        orgDigest(p.audienceGrants) !== orgDigest(row.audience_grants) || p.grantedAt !== row.granted_at.toISOString() ||
        p.expiresAt !== row.expires_at.toISOString() || p.revokedAt !== (row.revoked_at?.toISOString() ?? null)) throw orgUnavailable();
    await this.verify(c, orgId, 'entitlement', row.id, row.revision, p);
    orgArray(p.audienceGrants, x => orgChoice(x, ['cohort','entitled'] as const), 2, 1);
    return p;
  }
  /** Genuine access metadata for preparation. No task, tool or model permission. */
  async accessInTransaction(c: PoolClient, session: FixedSessionContext, organizationId: string | null, signal?: AbortSignal) {
    const s = fixed(session); await this.store.authorizeSession(c, s, signal);
    const sequence = (await c.query('SELECT last_value,is_called FROM platform_org_publish_sequence')).rows[0];
    const publishBatch = orgInteger(sequence.is_called ? Number(sequence.last_value) : 1, 1, 2147483647);
    const none = () => Object.freeze({ publishBatch, orgId: organizationId, entitlementId: null as string | null,
      entitlementRevision: null as number | null, audienceGrants: Object.freeze([] as string[]) });
    if (organizationId === null) return none();
    const orgId = careerRecordId(organizationId), org = (await c.query('SELECT id,status FROM platform_orgs WHERE id=$1 FOR SHARE',[orgId])).rows[0];
    if (!org || org.status !== 'active') return none();
    const row = (await c.query('SELECT * FROM platform_user_entitlements WHERE user_id=$1 AND org_id=$2 FOR SHARE',[s.userId,orgId])).rows[0];
    if (!row) return none();
    const p = await this.entitlement(c,s.userId,orgId,row), at = await this.at(c);
    if (p.revokedAt !== null || (p.expiresAt as string) <= at) return none();
    signal?.throwIfAborted(); await authorizeFixedSession(c,s,signal);
    return Object.freeze({publishBatch,orgId,entitlementId:row.id as string,entitlementRevision:row.revision as number,
      audienceGrants:Object.freeze([...(p.audienceGrants as string[])].sort())});
  }
  private async audience(c: PoolClient, ownerId: string, orgId: string, license: any, at: string) {
    const org = (await c.query("SELECT id FROM platform_orgs WHERE id=$1 AND status='active' FOR SHARE", [orgId])).rows[0];
    const row = (await c.query('SELECT * FROM platform_user_entitlements WHERE user_id=$1 AND org_id=$2 FOR SHARE', [ownerId, orgId])).rows[0];
    if (!org || !row) throw orgDenied();
    const p = await this.entitlement(c,ownerId,orgId,row);
    if (p.revokedAt !== null || (p.expiresAt as string) <= at || license.audience === 'staff_only' ||
        license.audience !== 'all_users' && !(p.audienceGrants as string[]).includes(license.audience)) throw orgDenied();
  }
  private async passage(c: PoolClient, session: FixedSessionContext, row: any, passageId: string, uses: readonly string[], speaker: string, purpose: string, signal?: AbortSignal): Promise<OrgPassage> {
    const at = await this.at(c), state = await this.source(c, row);
    const license = await this.license(c, row.org_id, row.license_id, uses, at);
    await this.audience(c, session.userId, row.org_id, license, at);
    if (row.asset_class === 'method_card' && (row.structured.effective_from > at || row.structured.superseded_by !== null)) throw orgStale();
    if (state.reviewStatus !== 'published' || state.validUntil <= at || state.reviewedAt === null || state.publishBatch === null) throw orgStale();
    const part = (await c.query('SELECT content,passage_index FROM platform_org_knowledge_passages WHERE source_id=$1 AND revision=$2 AND passage_id=$3 FOR SHARE', [row.id, row.revision, passageId])).rows[0];
    if (!part) throw orgStale();
    const actual = splitKnowledgePassages(row.id, row.revision, row.body)[part.passage_index];
    if (!actual || actual.passageId !== passageId || actual.text !== part.content) throw orgUnavailable();
    signal?.throwIfAborted();
    await c.query("INSERT INTO platform_knowledge_access_log(id,user_id,source_id,revision,passage_id,asset_class,speaker,purpose,created_at,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+interval '180 days')",
      [randomUUID(), session.userId, row.id, row.revision, passageId, row.asset_class, speaker, purpose, at]);
    return Object.freeze({ sourceId: row.id, revision: row.revision, passageId, title: row.title, text: part.content, updatedAt: state.updatedAt,
      scope: 'org', assetClass: row.asset_class, brand: this.brand, assetRevision: row.asset_class === 'method_card' ? row.structured.revision : null,
      provenanceLabel: row.asset_class === 'question' ? this.brand + '题库' : row.asset_class === 'method_card' ? this.brand + '方法 · v' + row.structured.revision : this.brand + '对话参考',
      provenance: 'untrusted_knowledge', deidentified: true, older: false });
  }
  async readPassage(session: FixedSessionContext, sourceId: string, revision: unknown, passageId: string, signal?: AbortSignal): Promise<OrgPassage> {
    const s = fixed(session), id = careerRecordId(sourceId), rev = orgInteger(revision, 1, 2147483647);
    if (!/^[1-9][0-9]*:[0-9]{1,3}$/.test(passageId) || !passageId.startsWith(String(rev) + ':')) throw orgInvalid();
    return this.db.withBoundedTransaction(async c => {
      await this.store.authorizeSession(c, s, signal);
      const coordinate = (await c.query('SELECT org_id FROM platform_org_knowledge_sources WHERE id=$1', [id])).rows[0];
      if (!coordinate) throw new ApiError(404, 'NOT_FOUND', '来源不存在。');
      await c.query('SELECT id FROM platform_orgs WHERE id=$1 FOR SHARE', [coordinate.org_id]);
      const row = (await c.query('SELECT * FROM platform_org_knowledge_sources WHERE id=$1 FOR SHARE', [id])).rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', '来源不存在。');
      if (row.asset_class === 'conversation_pattern') throw orgDenied();
      const license = await this.license(c, row.org_id, row.license_id, ['retrieve'], await this.at(c));
      if (!(license.allowedUses as string[]).some(u => u === 'display_excerpt' || u === 'display_full')) throw orgDenied();
      await this.audience(c, s.userId, row.org_id, license, await this.at(c));
      if (row.revision !== rev) throw orgStale();
      const result = await this.passage(c, s, row, passageId, ['retrieve'], 'user', 'view_source', signal);
      await authorizeFixedSession(c, s, signal); return result;
    });
  }
  /** Internal structured lookup only. Not registered as a student tool or engine
   * permission; callers must still bind actual run leases/admission before model use. */
  async search(session: FixedSessionContext, input: unknown, speaker: AgentSpeakerKey, signal?: AbortSignal) {
    return this.db.withBoundedTransaction(c => this.searchInTransaction(c,session,input,speaker,signal));
  }
  async searchInTransaction(c: PoolClient, session: FixedSessionContext, input: unknown, speaker: AgentSpeakerKey, signal?: AbortSignal,
    bounds?: Readonly<{orgId:string;publishBatch:number}>) {
    let query: ReturnType<typeof parseOrgSearch>; try { query = parseOrgSearch(input); } catch { throw orgInvalid(); }
    if (!['companion', 'guide', 'applier', 'interviewer'].includes(speaker)) throw orgDenied();
    const s = fixed(session);
    if (bounds) { careerRecordId(bounds.orgId); orgInteger(bounds.publishBatch,1,2147483647); }

    await this.store.authorizeSession(c, s, signal);
    const organizations = (await c.query("SELECT o.id FROM platform_orgs o WHERE o.status='active' AND EXISTS(SELECT 1 FROM platform_user_entitlements e WHERE e.org_id=o.id AND e.user_id=$1) AND ($2::uuid IS NULL OR o.id=$2) ORDER BY o.id FOR SHARE OF o", [s.userId,bounds?.orgId ?? null])).rows;
    if (!organizations.length) { await authorizeFixedSession(c, s, signal); return Object.freeze([]); }
    const rows = (await c.query("SELECT s.* FROM platform_org_knowledge_sources s JOIN platform_user_entitlements e ON e.org_id=s.org_id AND e.user_id=$1 JOIN platform_content_licenses l ON l.id=s.license_id AND l.org_id=s.org_id JOIN platform_orgs o ON o.id=s.org_id WHERE o.status='active' AND e.revoked_at IS NULL AND e.expires_at>clock_timestamp() AND l.revoked_at IS NULL AND l.valid_from<=clock_timestamp() AND l.valid_until>clock_timestamp() AND l.allowed_uses @> ARRAY['retrieve','model_context']::text[] AND l.audience<>'staff_only' AND (l.audience='all_users' OR l.audience=ANY(e.audience_grants)) AND s.valid_until>clock_timestamp() AND s.review_status='published' AND s.asset_class=$2 AND (s.asset_class='question' OR (s.asset_class='conversation_pattern' AND $8::text='companion') OR (s.asset_class='method_card' AND s.structured->'bound_speakers' ? $8::text AND (s.structured->>'effective_from')::timestamptz<=clock_timestamp() AND s.structured->'superseded_by'='null'::jsonb)) AND ($3::text IS NULL OR $3=ANY(s.role_families)) AND ($4::text IS NULL OR s.structured->>'type'=$4) AND ($5::integer IS NULL OR (s.structured->>'difficulty')::integer=$5) AND ((s.asset_class='question' AND COALESCE(s.structured->'topics','[]'::jsonb) ?& $6::text[]) OR (s.asset_class<>'question' AND s.tags @> $6::text[])) AND ($9::uuid IS NULL OR s.org_id=$9) AND ($10::integer IS NULL OR s.publish_batch<=$10) ORDER BY s.publish_batch DESC,s.id LIMIT $7 FOR SHARE OF s,e,l",
      [s.userId, query.assetClass, query.roleFamily, query.questionType, query.difficulty, query.topics, query.limit, speaker, bounds?.orgId ?? null, bounds?.publishBatch ?? null])).rows;
    const out: OrgPassage[] = [];
    for (const row of rows) {
      signal?.throwIfAborted();
      if (!orgAssetSpeakers(row.asset_class, parseOrgP0Asset(row.asset_class, row.structured)).includes(speaker)) continue;
      try {
        const first = String(row.revision) + ':0';
        out.push(await this.passage(c, s, row, first, ['retrieve', 'model_context'], speaker, 'preparation_lookup', signal));
      } catch (e) { if (e instanceof ApiError && ['NOT_ENTITLED', 'STALE_REVISION'].includes(e.code)) continue; throw e; }
    }
    if (Buffer.byteLength(JSON.stringify(out)) > 49152) throw orgUnavailable();
    await authorizeFixedSession(c, s, signal); return Object.freeze(out);
  }
}
