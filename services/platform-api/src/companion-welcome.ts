import {readWelcomeSnapshot,welcomeIntroV1,type WelcomeRow as Row} from './companion-welcome-snapshot.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { parseCompanionWelcomeOpen, parseCompanionWelcomeChoice, parseCompanionWelcomeObservation, type CompanionWelcome, type CompanionWelcomeChoice, type CompanionWelcomeObservation, type CompanionWelcomeChoiceResult, type PublicActiveCompanion } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { BirthOriginStore } from './companion-birth-types.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
import type { CompanionPrebirthSafety } from './companion-prebirth-safety.ts';
const unavailable = () => new ApiError(503, 'COMPANION_WELCOME_UNAVAILABLE', 'The saved introduction could not be confirmed.');
const conflict = () => new ApiError(409, 'COMPANION_WELCOME_CONFLICT', 'Read the saved introduction before choosing its next path.');
const fixed = (s: FixedSessionContext) => Object.freeze({ userId: s.userId, tokenHash: s.tokenHash });
const iso = (v: Date) => v.toISOString();
const same = isDeepStrictEqual;
/** Account-serialized C1 publication. Uses the actual birth origin and real
 * main room. Rendering is explicitly fixed_intro_v1: no model, first letter,
 * lease, consent grant, external action or synthetic conversation is created. */
export class CompanionWelcomeService {
    private readonly storage: OnboardingStorage;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null, private readonly origins: BirthOriginStore, private readonly safety: CompanionPrebirthSafety) { this.storage = new OnboardingStorage(config, legal); }
    private async current(client: PoolClient, s: FixedSessionContext, signal?: AbortSignal): Promise<PublicActiveCompanion | null> {
        await authorizeFixedSession(client, s, signal);
        const owner = (await client.query('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0];
        if (!owner || owner.account_kind !== 'student')
            throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
        if (!this.storage.crypto)
            throw unavailable();
        const state = await this.origins.readCurrent(client, s.userId);
        return state.kind === 'active' ? state.companion : null;
    }
    private async row(client: PoolClient, s: FixedSessionContext, c: PublicActiveCompanion) {
        return (await client.query<Row>('SELECT * FROM platform_companion_welcome WHERE user_id=$1 AND companion_id=$2 FOR UPDATE', [s.userId, c.companionId])).rows[0];
    }
    private async decode(client:PoolClient,s:FixedSessionContext,c:PublicActiveCompanion,row:Row):Promise<CompanionWelcome>{
        if(row.companion_id!==c.companionId||row.conversation_id!==c.main.id)throw unavailable();
        return (await readWelcomeSnapshot(client,this.storage.crypto,s.userId,row,true)).state;
    }
    async read(context: FixedSessionContext, signal?: AbortSignal): Promise<CompanionWelcomeObservation> {
        const s = fixed(context);
        return this.db.withBoundedTransaction(async (client) => {
            const c = await this.current(client, s, signal), row = c ? await this.row(client, s, c) : null;
            const result = c && row ? await this.decode(client, s, c, row) : { kind: 'not_opened' as const };
            await authorizeFixedSession(client, s, signal);
            signal?.throwIfAborted();
            return result;
        });
    }
    async open(context: FixedSessionContext, body: unknown, signal?: AbortSignal): Promise<CompanionWelcome> {
        let expectedCompanionId: string;
        try {
            expectedCompanionId = parseCompanionWelcomeOpen(body).expectedCompanionId;
        }
        catch {
            throw new ApiError(400, 'INVALID_INPUT', 'Use the companion from your saved birth.');
        }
        const s = fixed(context);
        return this.db.withBoundedTransaction(async (client) => {
            const c = await this.current(client, s, signal);
            if (!c)
                throw new ApiError(409, 'COMPANION_BIRTH_REQUIRED', 'Complete companion birth first.');
            if (c.companionId !== expectedCompanionId)
                throw conflict();
            const saved = await this.row(client, s, c);
            if (saved) {
                const result = await this.decode(client, s, c, saved);
                await authorizeFixedSession(client, s, signal);
                signal?.throwIfAborted();
                return result;
            }
            await this.safety.assertCurrentSafetyInTransaction(client, s, signal);
            const birth = (await client.query('SELECT birth_receipt_id FROM platform_conversations WHERE id=$1 AND user_id=$2', [c.main.id, s.userId])).rows[0];
            if (!birth)
                throw unavailable();
            const now = (await client.query<{
                now: Date;
            }>('SELECT clock_timestamp() AS now')).rows[0].now, id = randomUUID(), messageId = randomUUID();
            const state = parseCompanionWelcomeObservation({ kind: 'welcome', id, companionId: c.companionId, conversationId: c.main.id, revision: 1, step: 'C1', choice: null,
                openedAt: iso(now), updatedAt: iso(now), intro: { id: messageId, kind: 'text', rendering: 'fixed_intro_v1', content: welcomeIntroV1(c.identity.name), createdAt: iso(now),
                    speaker: { name: c.identity.name, sealChar: c.identity.sealChar, inkToken: c.identity.inkToken, personaRevision: c.currentRevision } } });
            if (state.kind !== 'welcome')
                throw unavailable();
            const ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(state), { table: 'platform_companion_welcome', column: 'intro_ciphertext', rowId: id, ownerId: s.userId, revision: 1 });
            await client.query(`INSERT INTO platform_messages(id,conversation_id,role,content,status,room_kind,user_id,companion_id,kind,speaker_kind,
        speaker_ref,speaker_snapshot,payload,channel,created_at) VALUES($1,$2,'assistant','','complete','main',$3,$4,'text','companion',$4,$5,$6,'web',$7)`, [messageId, c.main.id, s.userId, c.companionId, { displayName: c.identity.name, roleLabel: 'AI 主理人', sealChar: c.identity.sealChar, ink_token: c.identity.inkToken, personaRevision: 1 },
                { type: 'companion_intro', welcomeId: id, rendering: 'fixed_intro_v1' }, now]);
            await client.query(`INSERT INTO platform_companion_welcome(id,user_id,companion_id,conversation_id,birth_receipt_id,intro_message_id,intro_ciphertext,
        revision,step,choice,opened_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,'C1',NULL,$8,$8)`, [id, s.userId, c.companionId, c.main.id, birth.birth_receipt_id, messageId, ciphertext, now]);
            await authorizeFixedSession(client, s, signal);
            signal?.throwIfAborted();
            return state;
        });
    }
    async choose(context: FixedSessionContext, body: unknown, signal?: AbortSignal): Promise<CompanionWelcomeChoiceResult> {
        const s=fixed(context);
        let command:Readonly<CompanionWelcomeChoice>;
        try{command=parseCompanionWelcomeChoice(body);}catch{throw new ApiError(400,'INVALID_INPUT','Choose a documented next path.');}
        return this.db.withBoundedTransaction(client=>this.chooseInTransaction(client,s,command,signal));
    }
    /** Caller keeps the same transaction for dependent first-letter intent. */
    async chooseInTransaction(client:PoolClient,context:FixedSessionContext,body:unknown,signal?:AbortSignal):Promise<CompanionWelcomeChoiceResult>{
        let command: Readonly<CompanionWelcomeChoice>;
        try {
            command = parseCompanionWelcomeChoice(body);
        }
        catch {
            throw new ApiError(400, 'INVALID_INPUT', 'Choose a documented next path.');
        }
        const s = fixed(context);
            const c = await this.current(client, s, signal);
            if (!c)
                throw new ApiError(409, 'COMPANION_BIRTH_REQUIRED', 'Complete companion birth first.');
            const row = await this.row(client, s, c);
            if (!row || row.id !== command.welcomeId)
                throw conflict();
            let state = await this.decode(client, s, c, row);
            const old = (await client.query('SELECT * FROM platform_companion_welcome_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, command.operationId])).rows[0];
            if (old) {
                let original;
                try {
                    original = JSON.parse(this.storage.crypto!.openUtf8(old.request_ciphertext, { table: 'platform_companion_welcome_operations', column: 'request_ciphertext', rowId: command.operationId, ownerId: s.userId, revision: 1 }));
                }
                catch {
                    throw unavailable();
                }
                if (!same(original, { welcomeId: row.id, companionId: c.companionId, command, appliedAt: iso(row.updated_at), acceptedAuthVersion: String(old.accepted_auth_version) }) || old.welcome_id !== row.id || old.companion_id !== c.companionId || old.applied_revision !== 2 || state.revision !== 2)
                    throw conflict();
                await authorizeFixedSession(client, s, signal);
                signal?.throwIfAborted();
                return { state, operation: { id: command.operationId, appliedRevision: 2, replayed: true } };
            }
            await this.safety.assertCurrentSafetyInTransaction(client, s, signal);
            const authVersion = await this.storage.authorizeSession(client, s, signal);
            if (state.revision !== command.expectedRevision || state.step !== 'C1')
                throw conflict();
            const changed = (await client.query<Row>(`UPDATE platform_companion_welcome SET revision=2,step=$3,choice=$4,updated_at=date_trunc('milliseconds',clock_timestamp())
        WHERE id=$1 AND user_id=$2 RETURNING *`, [row.id, s.userId, command.choice === 'begin' ? 'C2' : 'C7', command.choice])).rows[0];
            const ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify({ welcomeId: row.id, companionId: c.companionId, command, appliedAt: iso(changed.updated_at), acceptedAuthVersion: authVersion }), { table: 'platform_companion_welcome_operations', column: 'request_ciphertext', rowId: command.operationId, ownerId: s.userId, revision: 1 });
            await client.query(`INSERT INTO platform_companion_welcome_operations(user_id,operation_id,welcome_id,companion_id,request_ciphertext,applied_revision,accepted_auth_version,created_at)
        VALUES($1,$2,$3,$4,$5,2,$6,$7)`, [s.userId, command.operationId, row.id, c.companionId, ciphertext, authVersion, changed.updated_at]);
            state = await this.decode(client, s, c, changed);
            await authorizeFixedSession(client, s, signal);
            signal?.throwIfAborted();
            return { state, operation: { id: command.operationId, appliedRevision: 2, replayed: false } };
    }

}
