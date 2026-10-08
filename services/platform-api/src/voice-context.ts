import type { PoolClient } from 'pg';
import { VOICE_CONTEXT_LIMITS, type VoiceContextSnapshot } from '@companion/platform-contracts';
import { notFound } from './errors.ts';
import { assertLegacyConversationRow } from './companion-room-boundary.ts';

// Match String.trim(), including non-ASCII whitespace. PostgreSQL's locale-dependent
// [:space:] does not consistently cover the same characters as the web client.
const blankCharacters = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/** Legacy workbench handoff only; this does not assemble student-group memory or instructions. */
export async function assertVoiceConversation(client: PoolClient, userId: string, conversationId: string): Promise<void> {
  // Chat takes a conversation NO KEY UPDATE lock before its user lock. KEY SHARE
  // protects deletion without creating the opposite user -> conversation wait cycle.
  // Conversation ownership is immutable through the public API.
  const owned = await client.query('SELECT id,kind FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE', [conversationId, userId]);
  if (!owned.rowCount) throw notFound();
  assertLegacyConversationRow(owned.rows[0]);
}

/** Call inside the same transaction as the owned runtime lease, before contacting an issuer. */
export async function readVoiceContext(client: PoolClient, userId: string, conversationId: string): Promise<VoiceContextSnapshot> {
  await assertVoiceConversation(client, userId, conversationId);
  // Fetch one extra ID to disclose omitted older text. Oversized rows never materialize their
  // content in the API process; audio references, files, tools and memories are not selected.
  const result = await client.query(`SELECT id,role,
    CASE WHEN char_length(content)<=$2 AND octet_length(content)<=$3 THEN content ELSE NULL END AS text
    FROM platform_messages WHERE conversation_id=$1 AND status='complete'
      AND role IN ('user','assistant') AND btrim(content,$5)<>''
      AND attachments='[]'::jsonb AND audio_transcripts='[]'::jsonb
    ORDER BY ordinal DESC LIMIT $4`, [conversationId, VOICE_CONTEXT_LIMITS.messageCharacters, VOICE_CONTEXT_LIMITS.textBytes, VOICE_CONTEXT_LIMITS.messages + 1, blankCharacters]);
  const excluded = await client.query(`SELECT EXISTS(SELECT 1 FROM platform_messages
    WHERE conversation_id=$1 AND status='complete' AND role IN ('user','assistant')
      AND btrim(content,$2)<>'' AND (attachments<>'[]'::jsonb OR audio_transcripts<>'[]'::jsonb)) AS omitted`, [conversationId, blankCharacters]);
  const items: VoiceContextSnapshot['items'] = [];
  let textBytes = 0, truncated = excluded.rows[0].omitted || result.rows.length > VOICE_CONTEXT_LIMITS.messages;
  for (const row of result.rows.slice(0, VOICE_CONTEXT_LIMITS.messages)) {
    if (typeof row.text !== 'string' || Array.from(row.text).length > VOICE_CONTEXT_LIMITS.messageCharacters) { truncated = true; continue; }
    const bytes = Buffer.byteLength(row.text, 'utf8');
    if (textBytes + bytes > VOICE_CONTEXT_LIMITS.textBytes) { truncated = true; continue; }
    items.push(Object.freeze({ messageId: row.id, role: row.role, text: row.text })); textBytes += bytes;
  }
  items.reverse(); Object.freeze(items);
  return Object.freeze({ source: 'server_conversation', conversationId, items, truncated });
}
