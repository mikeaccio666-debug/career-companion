import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  parseCompanionBirthCommand, parseCompanionBirthViewerState,
  type CompanionBirthCommand, type CompanionBirthViewerState, type PublicCompanionBirthReceipt,
} from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { BirthCapture, BirthOriginStore } from './companion-birth-types.ts';
import type { CompanionSealRendered } from './companion-seal-rendering.ts';
import { openCompanionBirthAssets, sealCompanionBirthAssets } from './companion-birth-assets.ts';
import {
  birthFields, birthUUID, companionBirthStorageUnavailable, openCompanionBirthOrigin,
  parseBirthCapture, sealCompanionBirthOrigin, type CompanionBirthOriginSnapshot,
} from './companion-birth-origin-codec.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';

export const BIRTH_EXPORT_TABLES=Object.freeze(['platform_companion_birth_receipts'] as const);
export type BirthExportSection='companionBirthReceipts'|'companionBirthAssetMetadata';
const unavailable = companionBirthStorageUnavailable;
const exists = () => new ApiError(409, 'COMPANION_EXISTS', 'This account already has a companion.');
const notReady = () => new ApiError(400, 'PERSONA_NOT_ACCEPTED', 'Accept the companion preview before birth.');
const UNBORN_NULLS = ['name', 'name_origin', 'seal_char', 'seal_candidates', 'seal_changed_at', 'ink_token', 'relationship_stage',
  'stage_changed_at', 'birth_receipt_id', 'birth_idempotency_key', 'born_at', 'retired_at', 'seal_asset_id'] as const;
const systemSnapshot = Object.freeze({ displayName: '系统', roleLabel: '系统', sealChar: null, ink_token: null, personaRevision: null });

function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw unavailable();
  const text = Date.prototype.toISOString.call(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) throw unavailable();
  return text;
}
function assertColumns(row: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value !== value) throw unavailable();
  }
}
function exactJson(value: unknown, expected: Record<string, unknown>): boolean {
  try {
    const parsed = birthFields(value, Object.keys(expected));
    return Object.entries(expected).every(([key, item]) => parsed[key] === item);
  } catch { return false; }
}
function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length === 0 && Reflect.ownKeys(value).length === 1;
}
function originColumns(snapshot: Readonly<CompanionBirthOriginSnapshot>): Record<string, unknown> {
  const { ownerId, command, capture, receipt } = snapshot, { task, identity, prefix, inventory } = capture;
  return {
    id: receipt.id, user_id: ownerId, companion_id: identity.companionId, idempotency_key: command.idempotencyKey,
    snapshot_schema_version: 1, accepted_auth_version: capture.acceptedAuthVersion,
    terms_version: capture.terms.version, terms_content_digest: capture.terms.contentDigest,
    task_id: task.id, generation: task.generation, answers_id: task.answersId, source_draft_id: task.sourceDraftId,
    source_revision: task.sourceRevision, preview_revision: 1, source_prefix_id: prefix?.id ?? null,
    source_prefix_version: prefix?.version ?? null, source_prefix_digest: prefix?.digest ?? null,
    inventory_tip_id: inventory.tipId, inventory_revision: inventory.revision, inventory_tip_digest: inventory.tipDigest,
    identity_draft_id: identity.identityDraftId, identity_revision: identity.identityRevision,
    name_application_operation_id: identity.nameApplicationOperationId, name_submission_id: identity.nameSubmissionId,
    name_generation: identity.nameGeneration, selection_id: identity.selectionId, selection_operation_id: identity.selectionOperationId,
    selection_revision: identity.selectionRevision, bundle_revision: identity.bundleRevision, content_digest: identity.contentDigest,
    review_digest: identity.reviewDigest, born_name: identity.name, name_origin: identity.nameOrigin,
    seal_char: identity.sealChar, ink_token: identity.inkToken, main_conversation_id: receipt.main.id,
    event_message_id: receipt.event.id, seal_asset_id: receipt.identity.sealAssetId,
  };
}
async function one(client: PoolClient, sql: string, values: unknown[]): Promise<Record<string, any>> {
  const result = await client.query(sql, values);
  if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
  return result.rows[0];
}

/** Concrete origin storage. The caller supplies its genuine authenticated,
 * owner-locked transaction and owns COMMIT. These methods do not mint identity,
 * consent, source authority, a generation lease, C1 or an execution grant. */
export class CompanionBirthOriginStore implements BirthOriginStore {
  constructor(private readonly crypto: DataCrypto | undefined) {}

  private async decodeWithAssets(client: PoolClient, ownerId: string, row: Record<string, any>, savedAsset?: Record<string, any>, lockRecords=true): Promise<Readonly<{
    snapshot: Readonly<CompanionBirthOriginSnapshot>; rendered: Readonly<CompanionSealRendered>;
  }>> {
    const snapshot = openCompanionBirthOrigin(this.crypto, ownerId, row.id,
      row.request_ciphertext, row.snapshot_ciphertext, row.request_digest);
    assertColumns(row, originColumns(snapshot));
    if (timestamp(row.born_at) !== snapshot.receipt.bornAt) throw unavailable();
    const { receipt, capture } = snapshot, companionId = receipt.identity.companionId;
    const companion = await one(client, 'SELECT * FROM platform_companions WHERE id=$1 AND user_id=$2 '+(lockRecords?'FOR SHARE':''), [companionId, ownerId]);
    assertColumns(companion, { id: companionId, user_id: ownerId, birth_receipt_id: receipt.id,
      birth_idempotency_key: receipt.idempotencyKey, current_revision: 1 });
    if (!['active', 'retired'].includes(companion.status) || timestamp(companion.born_at) !== receipt.bornAt) throw unavailable();
    // Current spelling, relationship stage and seal are mutable projections;
    // their later values cannot alter this authenticated original identity.
    const main = await one(client, 'SELECT * FROM platform_conversations WHERE id=$1 AND user_id=$2 '+(lockRecords?'FOR SHARE':''), [receipt.main.id, ownerId]);
    assertColumns(main, { id: receipt.main.id, user_id: ownerId, kind: 'main', companion_id: companionId,
      birth_receipt_id: receipt.id, mode: 'companion', persona: null });
    if (timestamp(main.created_at) !== receipt.bornAt) throw unavailable();
    const event = await one(client, 'SELECT * FROM platform_messages WHERE id=$1 AND user_id=$2 '+(lockRecords?'FOR SHARE':''), [receipt.event.id, ownerId]);
    assertColumns(event, { id: receipt.event.id, conversation_id: receipt.main.id, user_id: ownerId, companion_id: companionId,
      room_kind: 'main', birth_receipt_id: receipt.id, role: 'system', kind: 'event', content: '', status: 'complete',
      provider: null, model: null, lease_until: null, speaker_kind: 'system', speaker_key: null, speaker_ref: null, channel: 'system' });
    if (timestamp(event.created_at) !== receipt.bornAt || !emptyArray(event.attachments)
      || !exactJson(event.speaker_snapshot, systemSnapshot)
      || !exactJson(event.payload, { event: 'companion_born', birthReceiptId: receipt.id, companionId })) throw unavailable();
    const assets = savedAsset ?? await one(client, 'SELECT * FROM platform_companion_birth_assets WHERE id=$1 AND user_id=$2 '+(lockRecords?'FOR SHARE':''),
      [receipt.identity.sealAssetId, ownerId]);
    const rendered = openCompanionBirthAssets(this.crypto, assets, snapshot.asset);
    if (capture.ownerId !== ownerId) throw unavailable();
    return Object.freeze({ snapshot, rendered });
  }

  private async decode(client: PoolClient, ownerId: string, row: Record<string, any>): Promise<Readonly<CompanionBirthOriginSnapshot>> {
    return (await this.decodeWithAssets(client, ownerId, row)).snapshot;
  }

  /** Capture historical origins in the caller's reauthenticated account snapshot.
   * No active-companion lookup, consent check, model call, render or file delivery.
   * Asset bytes are authenticated but only metadata is projected here; the file
   * table remains outstanding until the archive packs those private bytes. */
  async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:BirthExportSection;record:unknown}>{
    const input=birthFields(value,['userId','tokenHash']),ownerId=birthUUID(input.userId);
    if(typeof input.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(input.tokenHash))throw unavailable();
    const who=Object.freeze({userId:ownerId,tokenHash:input.tokenHash});
    await authorizeFixedSession(client,who,signal);let after:string|null=null;
    try{
      for(;;){
        signal?.throwIfAborted();
        const rows:Record<string,any>[]=(await client.query(`SELECT * FROM platform_companion_birth_receipts WHERE user_id=$1
          AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[ownerId,after])).rows;
        for(const row of rows){
          signal?.throwIfAborted();const {snapshot}=await this.decodeWithAssets(client,ownerId,row,undefined,false);signal?.throwIfAborted();
          const {receipt,capture,asset}=snapshot,identity=capture.identity;
          yield {section:'companionBirthReceipts',record:{receipt,
            source:{terms:{version:capture.terms.version,contentDigest:capture.terms.contentDigest},
              generation:{taskId:capture.task.id,generation:capture.task.generation,answersId:capture.task.answersId,
                sourceDraftId:capture.task.sourceDraftId,sourceRevision:capture.task.sourceRevision,sourceReceiptVersion:capture.task.sourceReceiptVersion},
              prefix:capture.prefix?{id:capture.prefix.id,version:capture.prefix.version}:null,
              inventory:{tipId:capture.inventory.tipId,revision:capture.inventory.revision},
              identity:{draftId:identity.identityDraftId,revision:identity.identityRevision,nameSubmissionId:identity.nameSubmissionId,
                nameGeneration:identity.nameGeneration,nameApplicationOperationId:identity.nameApplicationOperationId,
                selectionId:identity.selectionId,selectionRevision:identity.selectionRevision,selectionOperationId:identity.selectionOperationId,
                bundleRevision:identity.bundleRevision,sealCandidates:identity.sealCandidates}}}};
          yield {section:'companionBirthAssetMetadata',record:{id:asset.id,companionId:asset.companionId,birthReceiptId:asset.birthReceiptId,
            bornAt:asset.bornAt,sealChar:asset.sealChar,inkToken:asset.inkToken,rendererVersion:asset.rendererVersion,templateVersion:asset.templateVersion,
            paletteVersion:asset.paletteVersion,glyphSourceDigest:asset.glyphSourceDigest,pathDigest:asset.pathDigest,
            svgDigest:asset.svgDigest,pngDigest:asset.pngDigest,svgSizeBytes:asset.svgSizeBytes,pngSizeBytes:asset.pngSizeBytes,
            width:asset.width,height:asset.height,bytesVerified:true,bytesIncluded:false}};
        }
        if(rows.length<100)break;after=birthUUID(rows.at(-1)!.id);
      }
      await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
    }catch(error){if(signal?.aborted)throw error;throw unavailable();}
  }

  /** An opaque id only locates an owned saved asset. The authenticated original
   * receipt supplies every expected byte/coordinate; the clear asset row cannot
   * declare its own expected digest. Reads survive later retirement or changes
   * to name, review, model and glyph configuration and never repair storage. */
  async readSealAsset(client: PoolClient, ownerId: string, assetId: string): Promise<Readonly<CompanionSealRendered> | null> {
    try {
      birthUUID(ownerId); birthUUID(assetId);
      const result = await client.query('SELECT * FROM platform_companion_birth_assets WHERE id=$1 AND user_id=$2 FOR SHARE', [assetId, ownerId]);
      if (result.rowCount === 0 && result.rows.length === 0) return null;
      if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
      const asset = result.rows[0];
      assertColumns(asset, { id: assetId, user_id: ownerId });
      birthUUID(asset.birth_receipt_id);
      const receipt = await one(client, 'SELECT * FROM platform_companion_birth_receipts WHERE id=$1 AND user_id=$2 FOR SHARE',
        [asset.birth_receipt_id, ownerId]);
      const { snapshot, rendered } = await this.decodeWithAssets(client, ownerId, receipt, asset);
      if (snapshot.receipt.identity.sealAssetId !== assetId) throw unavailable();
      // Buffers are mutable even inside Object.freeze. Each delivery owns its
      // copies; a caller cannot alter saved ciphertext or another later read.
      return Object.freeze({ ...rendered, svg: Buffer.from(rendered.svg), png: Buffer.from(rendered.png) });
    } catch { throw unavailable(); }
  }

  async findOwn(client: PoolClient, ownerId: string, key: string): Promise<null | Readonly<{
    request: Readonly<CompanionBirthCommand>; receipt: Readonly<PublicCompanionBirthReceipt>;
  }>> {
    try {
      birthUUID(ownerId); birthUUID(key);
      const result = await client.query('SELECT * FROM platform_companion_birth_receipts WHERE user_id=$1 AND idempotency_key=$2 FOR SHARE', [ownerId, key]);
      if (result.rowCount === 0 && result.rows.length === 0) return null;
      if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
      const snapshot = await this.decode(client, ownerId, result.rows[0]);
      if (snapshot.command.idempotencyKey !== key) throw unavailable();
      return Object.freeze({ request: snapshot.command, receipt: snapshot.receipt });
    } catch { throw unavailable(); }
  }

  async assertUnborn(client: PoolClient, ownerId: string): Promise<void> {
    birthUUID(ownerId);
    const result = await client.query(`SELECT * FROM platform_companions WHERE user_id=$1
      AND status IN ('drafting','awaiting_name','active') ORDER BY id FOR UPDATE`, [ownerId]);
    if (result.rowCount === 0 && result.rows.length === 0) throw notReady();
    if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
    const row = result.rows[0];
    if (row.user_id !== ownerId) throw unavailable();
    birthUUID(row.id);
    if (row.status === 'active') {
      // Verify that "already born" refers to a real origin, not damaged state.
      birthUUID(row.birth_idempotency_key);
      const saved = await this.findOwn(client, ownerId, row.birth_idempotency_key);
      if (!saved || saved.receipt.identity.companionId !== row.id || saved.receipt.id !== row.birth_receipt_id
        || timestamp(row.born_at) !== saved.receipt.bornAt) throw unavailable();
      throw exists();
    }
    if (UNBORN_NULLS.some(key => row[key] !== null)) throw unavailable();
    if (row.status === 'drafting' && row.current_revision === 0) throw notReady();
    if (row.status !== 'awaiting_name' || row.current_revision !== 1) throw unavailable();
  }

  async writeAtomic(client: PoolClient, context: FixedSessionContext, input: Readonly<CompanionBirthCommand>,
    source: Readonly<BirthCapture>, rendered: Readonly<CompanionSealRendered>, signal?: AbortSignal): Promise<Readonly<PublicCompanionBirthReceipt>> {
    signal?.throwIfAborted();
    if (!this.crypto) throw unavailable();
    const command = parseCompanionBirthCommand(input.request, input.idempotencyKey), capture = parseBirthCapture(source);
    if (birthUUID(context.userId) !== capture.ownerId || input.request.name !== command.request.name
      || command.request.name !== capture.identity.name || command.request.sealChar !== capture.identity.sealChar) throw unavailable();
    const receiptId = randomUUID(), mainId = randomUUID(), eventId = randomUUID(), assetId = randomUUID();
    const ownerId = capture.ownerId, companionId = capture.identity.companionId;
    const time = await one(client, "SELECT date_trunc('milliseconds',clock_timestamp()) AS born_at", []);
    signal?.throwIfAborted();
    const bornAt = timestamp(time.born_at), bornDate = new Date(bornAt);
    const asset = sealCompanionBirthAssets(this.crypto, { id: assetId, ownerId, companionId, birthReceiptId: receiptId,
      bornAt, sealChar: capture.identity.sealChar, inkToken: capture.identity.inkToken }, rendered);
    const sealed = sealCompanionBirthOrigin(this.crypto, { schemaVersion: 1, ownerId, command, capture, asset: asset.snapshot,
      receipt: { kind: 'birth_receipt', id: receiptId, idempotencyKey: command.idempotencyKey, bornAt,
        identity: { companionId, name: capture.identity.name, nameOrigin: capture.identity.nameOrigin,
          sealChar: capture.identity.sealChar, inkToken: capture.identity.inkToken, personaRevision: 1,
          identityRevision: capture.identity.identityRevision, selectionRevision: capture.identity.selectionRevision, sealAssetId: assetId },
        main: { id: mainId, kind: 'main', companionId }, event: { id: eventId, conversationId: mainId, companionId,
          kind: 'event', event: 'companion_born', speakerKind: 'system', createdAt: bornAt,
          speakerSnapshot: { displayName: '系统', roleLabel: '系统', sealChar: null, inkToken: null, personaRevision: null } } } });
    signal?.throwIfAborted();
    await client.query(`INSERT INTO platform_conversations(id,user_id,title,mode,persona,kind,companion_id,birth_receipt_id,created_at,updated_at)
      VALUES($1,$2,$3,'companion',NULL,'main',$4,$5,$6,$6)`, [mainId, ownerId, capture.identity.name + ' · AI', companionId, receiptId, bornDate]);
    await client.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status,provider,model,attachments,lease_until,created_at,
      room_kind,user_id,companion_id,kind,speaker_kind,speaker_key,speaker_ref,speaker_snapshot,payload,channel,birth_receipt_id)
      VALUES($1,$2,'system','','complete',NULL,NULL,'[]'::jsonb,NULL,$3,'main',$4,$5,'event','system',NULL,NULL,$6::jsonb,$7::jsonb,'system',$8)`,
    [eventId, mainId, bornDate, ownerId, companionId, JSON.stringify(systemSnapshot),
      JSON.stringify({ event: 'companion_born', birthReceiptId: receiptId, companionId }), receiptId]);
    // Fixed server-owned column list; no supplied body key becomes SQL.
    const assetColumns = ['id', 'user_id', 'companion_id', 'birth_receipt_id', 'seal_char', 'ink_token', 'renderer_version', 'glyph_source_digest',
      'svg_digest', 'png_digest', 'assets_schema_version', 'svg_size_bytes', 'png_size_bytes', 'svg_ciphertext', 'png_base64_ciphertext', 'created_at'] as const;
    await client.query(`INSERT INTO platform_companion_birth_assets(${assetColumns.join(',')})
      VALUES(${assetColumns.map((_, index) => '$' + (index + 1)).join(',')})`, assetColumns.map(key => asset.row[key]));
    const columns = originColumns(sealed.snapshot);
    const receiptColumns = [...Object.keys(columns), 'request_digest', 'request_ciphertext', 'snapshot_ciphertext', 'born_at'];
    await client.query(`INSERT INTO platform_companion_birth_receipts(${receiptColumns.join(',')})
      VALUES(${receiptColumns.map((_, index) => '$' + (index + 1)).join(',')})`,
    [...Object.values(columns), sealed.requestDigest, sealed.requestCiphertext, sealed.snapshotCiphertext, bornDate]);
    signal?.throwIfAborted();
    const active = await client.query(`UPDATE platform_companions SET status='active',name=$3,name_origin='user_typed',seal_char=$4,
      seal_candidates=$5::jsonb,seal_changed_at=NULL,ink_token=$6,relationship_stage='acquainting',stage_changed_at=$7,
      birth_receipt_id=$8,birth_idempotency_key=$9,born_at=$7,seal_asset_id=$10,updated_at=$7
      WHERE id=$1 AND user_id=$2 AND status='awaiting_name' AND current_revision=1
        AND birth_receipt_id IS NULL AND birth_idempotency_key IS NULL AND born_at IS NULL RETURNING id`,
    [companionId, ownerId, capture.identity.name, capture.identity.sealChar, JSON.stringify(capture.identity.sealCandidates),
      capture.identity.inkToken, bornDate, receiptId, command.idempotencyKey, assetId]);
    signal?.throwIfAborted();
    if (active.rowCount !== 1 || active.rows.length !== 1 || active.rows[0].id !== companionId) throw unavailable();
    // overlays remains the actual source projection (including NULL/pending).
    // Final session authorization and actual COMMIT belong to the caller.
    return sealed.snapshot.receipt;
  }

  /** Internal source projection, not a new birth/admission grant or public HTTP response.
   * Only the immutable origin supplies identity and generation coordinates.
   * A future rename/relationship revision requires its own authenticated source. */
  async readActiveContextOrigin(client: PoolClient, ownerId: string): Promise<null | Readonly<{
    snapshot: Readonly<CompanionBirthOriginSnapshot>; originalRelationship: 'acquainting' | null;
  }>> {
    try {
      const current = await this.readCurrent(client, ownerId);
      if (current.kind !== 'active') return null;
      const companion = current.companion;
      const row = await one(client, 'SELECT * FROM platform_companion_birth_receipts WHERE companion_id=$1 AND user_id=$2 FOR SHARE', [companion.companionId, ownerId]);
      const original = await this.decode(client, ownerId, row), receipt = original.receipt;
      if (receipt.identity.companionId !== companion.companionId || receipt.main.id !== companion.main.id
        || receipt.bornAt !== companion.bornAt || receipt.identity.name !== companion.identity.name || companion.currentRevision !== 1) throw unavailable();
      const projection = await one(client, 'SELECT * FROM platform_companions WHERE id=$1 AND user_id=$2 FOR SHARE', [companion.companionId, ownerId]);
      const originalRelationship = projection.relationship_stage === 'acquainting' && timestamp(projection.stage_changed_at) === receipt.bornAt ? 'acquainting' as const : null;
      return Object.freeze({ snapshot: original, originalRelationship });
    } catch { throw unavailable(); }
  }

  async readCurrent(client: PoolClient, ownerId: string): Promise<CompanionBirthViewerState> {
    try {
      birthUUID(ownerId);
      const result = await client.query(`SELECT * FROM platform_companions WHERE user_id=$1
        AND status IN ('drafting','awaiting_name','active') ORDER BY id FOR SHARE`, [ownerId]);
      if (result.rowCount === 0 && result.rows.length === 0) return Object.freeze({ kind: 'not_born' });
      if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
      const row = result.rows[0];
      if (row.user_id !== ownerId) throw unavailable();
      if (row.status === 'drafting' || row.status === 'awaiting_name') {
        birthUUID(row.id);
        if (UNBORN_NULLS.some(key => row[key] !== null) || row.current_revision !== (row.status === 'drafting' ? 0 : 1)) throw unavailable();
        return Object.freeze({ kind: 'not_born' });
      }
      if (row.status !== 'active' || row.retired_at !== null) throw unavailable();
      const saved = await this.findOwn(client, ownerId, row.birth_idempotency_key);
      if (!saved || saved.receipt.identity.companionId !== row.id || row.birth_receipt_id !== saved.receipt.id
        || timestamp(row.born_at) !== saved.receipt.bornAt || timestamp(row.stage_changed_at) < saved.receipt.bornAt
        || row.seal_asset_id !== saved.receipt.identity.sealAssetId) throw unavailable();
      // Asset bytes are validated above. A future reseal needs its own immutable
      // operation/codec; do not manufacture an expected hash from mutable rows.
      if (row.seal_char !== saved.receipt.identity.sealChar || row.ink_token !== saved.receipt.identity.inkToken) throw unavailable();
      return parseCompanionBirthViewerState({ kind: 'active', companion: { kind: 'active_companion', companionId: row.id,
        status: 'active', bornAt: timestamp(row.born_at), currentRevision: row.current_revision,
        identity: { name: row.name, nameOrigin: row.name_origin, sealChar: row.seal_char, inkToken: row.ink_token, sealAssetId: row.seal_asset_id },
        relationshipStage: row.relationship_stage, main: saved.receipt.main } });
    } catch { throw unavailable(); }
  }
}
