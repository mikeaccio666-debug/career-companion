import { CONVERSATION_TASK_TOOLS, platformAccountId } from '@companion/platform-contracts';
import type { ConversationTaskOrigin, ConversationTaskTool } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { ApiError, invalid, notFound, object } from './errors.ts';

/** Supplied only by the authenticated chat handler, never a model or HTTP body. */
export type ConversationTaskCreationOrigin = Pick<ConversationTaskOrigin, 'conversationId' | 'messageId' | 'tool'>;
export interface ConversationTaskQuery { limit: number; before?: string; }

export function parseConversationTaskQuery(value: unknown): ConversationTaskQuery {
  const query = object(value);
  if (Object.keys(query).some(key => !['limit', 'before'].includes(key))) throw invalid('Unsupported conversation-task query.');
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/.test(query.limit) || Number(query.limit) > 50) throw invalid('Conversation task limit must be an integer between 1 and 50.');
    limit = Number(query.limit);
  }
  if (query.before !== undefined && !platformAccountId(query.before)) throw invalid('Use an owned conversation-task job ID as the older-page cursor.');
  return { limit, ...(query.before === undefined ? {} : { before: query.before.toLowerCase() }) };
}

export function parseConversationTaskOrigin(value: unknown): ConversationTaskCreationOrigin {
  const origin = object(value);
  if (Object.keys(origin).some(key => !['conversationId', 'messageId', 'tool'].includes(key)) ||
      !platformAccountId(origin.conversationId) || !platformAccountId(origin.messageId) ||
      !CONVERSATION_TASK_TOOLS.includes(origin.tool as ConversationTaskTool)) throw invalid('Invalid server conversation-task origin.');
  return { conversationId: origin.conversationId.toLowerCase(), messageId: origin.messageId.toLowerCase(), tool: origin.tool as ConversationTaskTool };
}

const inactiveOrigin = () => new ApiError(409, 'CONVERSATION_TASK_ORIGIN_INACTIVE', 'This assistant response is no longer active. No task was prepared.');

/** Called after the user's job-creation serialization lock, before creating any job. */
export async function authorizeConversationTaskOrigin(client: PoolClient, userId: string, origin: ConversationTaskCreationOrigin): Promise<void> {
  // KEY SHARE is compatible with chat's NO KEY UPDATE conversation lock. A
  // stronger lock here would reverse conversation -> user chat lease locking.
  const conversation = await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE', [origin.conversationId, userId]);
  if (!conversation.rowCount) throw inactiveOrigin();
  // Lock the assistant turn so completion/recovery cannot race this transaction.
  const message = await client.query(`SELECT id FROM platform_messages
    WHERE id=$1 AND conversation_id=$2 AND role='assistant' AND status='streaming' AND lease_until>clock_timestamp()
    FOR NO KEY UPDATE`, [origin.messageId, origin.conversationId]);
  if (!message.rowCount) throw inactiveOrigin();
  const lease = await client.query(`SELECT id FROM platform_runtime_leases
    WHERE id=$1 AND user_id=$2 AND kind='chat' AND expires_at>clock_timestamp() FOR KEY SHARE`, [origin.messageId, userId]);
  if (!lease.rowCount) throw inactiveOrigin();
}

export async function saveConversationTaskOrigin(client: PoolClient, userId: string, jobId: string, generation: number, origin: ConversationTaskCreationOrigin): Promise<void> {
  // Time can pass while creating the job/approval. Recheck the live turn at the
  // final write; failure rolls back job, approval, outbox and this reference.
  const saved = await client.query(`INSERT INTO platform_conversation_tasks(job_id,user_id,conversation_id,message_id,tool,created_generation)
    SELECT $1,$2,c.id,m.id,$5,$6 FROM platform_conversations c
      JOIN platform_messages m ON m.conversation_id=c.id
      JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=c.user_id AND l.kind='chat'
    WHERE c.id=$3 AND c.user_id=$2 AND m.id=$4 AND m.role='assistant' AND m.status='streaming'
      AND m.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp() RETURNING job_id`,
  [jobId, userId, origin.conversationId, origin.messageId, origin.tool, generation]);
  if (!saved.rowCount) throw inactiveOrigin();
}

/** All rows and their current generation's approval are read in one SQL snapshot. */
export async function conversationTaskRows(db: Database, userId: string, conversationId: string, value: unknown): Promise<{ rows: any[]; nextBefore: string | null }> {
  const query = parseConversationTaskQuery(value);
  return db.transaction(async client => {
    const owner = await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE', [conversationId, userId]);
    if (!owner.rowCount) throw notFound();
    let cursor: { created_at_cursor: string; job_id: string } | undefined;
    if (query.before) {
      // Keep PostgreSQL's microseconds; converting the cursor to a JS Date
      // would silently skip tasks created within the same millisecond.
      const found = await client.query('SELECT created_at::text AS created_at_cursor,job_id FROM platform_conversation_tasks WHERE user_id=$1 AND conversation_id=$2 AND job_id=$3', [userId, conversationId, query.before]);
      if (!found.rowCount) throw notFound();
      cursor = found.rows[0];
    }
    const result = await client.query(`SELECT j.*,t.conversation_id AS origin_conversation_id,t.message_id AS origin_message_id,
        t.tool AS origin_tool,t.created_generation AS origin_generation,t.created_at AS origin_created_at,
        w.steps AS workflow_step_states,w.definition_hash AS workflow_definition_hash,w.revision AS workflow_checkpoint_revision,
        b.state AS browser_checkpoint_state,b.revision AS browser_checkpoint_revision,b.next_index AS browser_next_index,
        (SELECT row_to_json(a) FROM platform_approvals a WHERE a.job_id=j.id AND a.user_id=j.user_id
          AND j.status='needs_approval' AND a.generation=j.generation AND a.status='pending' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS current_approval,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',coalesce(a.filename,'artifact'),
          'mime',coalesce(a.mime,'application/octet-stream'),'url','/api/platform/artifacts/'||a.id,'size',u.byte_size)
          ORDER BY a.created_at,a.id) FROM platform_artifacts a LEFT JOIN platform_uploads u ON u.id=a.upload_id AND u.user_id=j.user_id
          WHERE a.job_id=j.id AND a.user_id=j.user_id),'[]'::jsonb) AS task_artifacts
      FROM platform_conversation_tasks t JOIN platform_jobs j ON j.id=t.job_id AND j.user_id=t.user_id
      LEFT JOIN platform_workflow_checkpoints w ON w.job_id=j.id LEFT JOIN platform_browser_checkpoints b ON b.job_id=j.id
      WHERE t.user_id=$1 AND t.conversation_id=$2 AND ($3::timestamptz IS NULL OR (t.created_at,t.job_id)<($3::timestamptz,$4::uuid))
      ORDER BY t.created_at DESC,t.job_id DESC LIMIT $5`, [userId, conversationId, cursor?.created_at_cursor ?? null, cursor?.job_id ?? null, query.limit + 1]);
    const rows = result.rows.slice(0, query.limit);
    return { rows, nextBefore: result.rows.length > query.limit ? rows.at(-1)!.id : null };
  });
}
