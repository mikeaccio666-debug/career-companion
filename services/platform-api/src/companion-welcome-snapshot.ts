import {isDeepStrictEqual as same} from 'node:util';
import type {PoolClient} from 'pg';
import {parseCompanionWelcomeObservation,parseCompanionWelcomeChoice} from '@companion/platform-contracts';
import type {DataCrypto} from './data-crypto.ts';
import {ApiError} from './errors.ts';
const unavailable=()=>new ApiError(503,'COMPANION_WELCOME_UNAVAILABLE','The saved introduction could not be confirmed.');
const iso=(value:Date)=>value.toISOString();
/** Fixed historical rendering version; future wording requires a new version. */
export const welcomeIntroV1=(name:string)=>`我是${name}，名字是你起的。我是 AI。我们先花三分钟认识一下，然后我给你写第一封信。`;
export interface WelcomeOperationProjection {id:string;welcomeId:string;companionId:string;expectedRevision:1;appliedRevision:2;choice:'begin'|'direct_letter';createdAt:string;}
export interface WelcomeRow {
    id: string;
    user_id: string;
    companion_id: string;
    conversation_id: string;
    birth_receipt_id: string;
    intro_message_id: string;
    intro_ciphertext: Buffer;
    revision: 1 | 2;
    step: 'C1' | 'C2' | 'C7';
    choice: 'begin' | 'direct_letter' | null;
    opened_at: Date;
    updated_at: Date;
}

/** Decode saved data only. Active companion, consent and write admission belong
 * to the caller. Archive capture uses its existing MVCC snapshot without locks. */
export async function readWelcomeSnapshot(client:PoolClient,crypto:DataCrypto|undefined,ownerId:string,row:WelcomeRow,lockRecords:boolean){
    try {
        if(row.user_id!==ownerId||!crypto)throw unavailable();
        // Intro remains at immutable cipher revision 1 when the journey advances.
        const original = parseCompanionWelcomeObservation(JSON.parse(crypto.openUtf8(row.intro_ciphertext, { table: 'platform_companion_welcome', column: 'intro_ciphertext', rowId: row.id, ownerId: ownerId, revision: 1 })));
        if (original.kind !== 'welcome' || original.revision !== 1 || original.step !== 'C1' || original.choice !== null
            || original.id !== row.id || original.companionId !== row.companion_id
            || original.conversationId !== row.conversation_id
            || original.intro.id !== row.intro_message_id || original.openedAt !== iso(row.opened_at) || original.updatedAt !== original.openedAt
            || original.intro.content !== welcomeIntroV1(original.intro.speaker.name))
            throw unavailable();
        const main = (await client.query('SELECT birth_receipt_id FROM platform_conversations WHERE id=$1 AND user_id=$2', [row.conversation_id, ownerId])).rows[0];
        if (!main || main.birth_receipt_id !== row.birth_receipt_id)
            throw unavailable();
        const m = (await client.query('SELECT * FROM platform_messages WHERE id=$1 AND user_id=$2'+(lockRecords?' FOR SHARE':''), [row.intro_message_id, ownerId])).rows[0];
        const speaker = { displayName: original.intro.speaker.name, roleLabel: 'AI 主理人', sealChar: original.intro.speaker.sealChar,
            ink_token: original.intro.speaker.inkToken, personaRevision: 1 };
        if (!m || m.conversation_id !== row.conversation_id || m.companion_id !== row.companion_id || m.room_kind !== 'main' || m.kind !== 'text'
            || m.role !== 'assistant' || m.speaker_kind !== 'companion' || m.speaker_key !== null || m.speaker_ref !== row.companion_id
            || !same(m.speaker_snapshot, speaker) || m.channel !== 'web' || m.birth_receipt_id !== null || m.content !== ''
            || m.status !== 'complete' || m.provider !== null || m.model !== null || m.lease_until !== null || !same(m.attachments, [])
            || iso(m.created_at) !== original.openedAt || !same(m.payload, { type: 'companion_intro', welcomeId: row.id, rendering: 'fixed_intro_v1' }))
            throw unavailable();
        const state = parseCompanionWelcomeObservation({ ...original, revision: row.revision, step: row.step, choice: row.choice, updatedAt: iso(row.updated_at) });
        if (state.kind !== 'welcome')
            throw unavailable();
        const operations = (await client.query('SELECT * FROM platform_companion_welcome_operations WHERE welcome_id=$1 AND user_id=$2'+(lockRecords?' FOR SHARE':''), [row.id, ownerId])).rows;
        let operation:WelcomeOperationProjection|null=null;
        if (operations.length !== (state.revision === 2 ? 1 : 0))throw unavailable();
        if (state.revision === 2) {
            const op = operations[0];
            const capture = JSON.parse(crypto.openUtf8(op.request_ciphertext, { table: 'platform_companion_welcome_operations', column: 'request_ciphertext', rowId: op.operation_id, ownerId: ownerId, revision: 1 }));
            const command = parseCompanionWelcomeChoice(capture.command);
            if (!same(capture, { welcomeId: row.id, companionId: row.companion_id, command, appliedAt: iso(row.updated_at), acceptedAuthVersion: String(op.accepted_auth_version) })
                || command.welcomeId !== row.id || command.operationId !== op.operation_id || command.choice !== state.choice || op.companion_id !== row.companion_id
                || op.applied_revision !== 2 || iso(op.created_at) !== iso(row.updated_at))
                throw unavailable();
            operation={id:command.operationId,welcomeId:row.id,companionId:row.companion_id,expectedRevision:command.expectedRevision,appliedRevision:2,choice:command.choice,createdAt:iso(op.created_at)};
        }
        return {state,operation};
    }
    catch {
        throw unavailable();
    }
}
