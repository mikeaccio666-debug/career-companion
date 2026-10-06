import type { AccountUsage, ModelCallEvent } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { ApiError, identifier } from './errors.ts';

const terminalStatuses = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}
function accountingError() { return new ApiError(503, 'USAGE_RECORD_UNCONFIRMED', 'The model call record could not be confirmed. Refresh the conversation before continuing.'); }
interface Binding { userId: string; conversationId: string; messageId: string; provider: string; model?: string; }

/** Only the trusted runtime receives this closure; it is never an HTTP signing or accounting endpoint. */
export function chatAccounting(db: Database, binding: Binding) {
  const startedCalls = new Set<string>();
  return async (event: ModelCallEvent) => {
    const callId = identifier(event.callId);
    if (event.type === 'started') {
      if (!Number.isInteger(event.index) || event.index < 1 || event.index > 6 || event.provider !== binding.provider ||
          typeof event.model !== 'string' || !event.model.length || event.model.length > 150 || /[\u0000-\u001f\u007f]/.test(event.model) ||
          binding.model !== undefined && event.model !== binding.model) throw accountingError();
      await db.transaction(async client => {
        const authorized = await client.query(`SELECT m.id FROM platform_messages m
          JOIN platform_conversations c ON c.id=m.conversation_id
          JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=c.user_id AND l.kind='chat'
          WHERE m.id=$1 AND c.id=$2 AND c.user_id=$3 AND m.status='streaming'
            AND m.provider=$4 AND m.lease_until > now() AND l.expires_at > now() FOR UPDATE OF m`,
        [binding.messageId, binding.conversationId, binding.userId, binding.provider]);
        if (!authorized.rowCount) throw accountingError();
        await client.query(`INSERT INTO platform_chat_calls(id,user_id,conversation_id,message_id,call_index,provider,model)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [callId, binding.userId, binding.conversationId, binding.messageId, event.index, event.provider, event.model]);
        const current = (await client.query('SELECT * FROM platform_chat_calls WHERE id=$1', [callId])).rows[0];
        if (!current || current.user_id !== binding.userId || current.conversation_id !== binding.conversationId ||
            current.message_id !== binding.messageId || current.call_index !== event.index || current.provider !== event.provider ||
            current.model !== event.model || current.status !== 'running') throw accountingError();
      });
      startedCalls.add(callId);
      return;
    }
    if (event.type !== 'finished' || !terminalStatuses.has(event.status) || !event.usage ||
        !['reported', 'missing', 'invalid'].includes(event.usage.status)) throw accountingError();
    const usage = event.usage, reported = usage.status === 'reported';
    const input = usage.status === 'reported' ? usage.inputTokens : null, output = usage.status === 'reported' ? usage.outputTokens : null;
    if (reported && (!validTokenCount(input) || !validTokenCount(output))) throw accountingError();
    await db.transaction(async client => {
      const row = (await client.query('SELECT * FROM platform_chat_calls WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [callId, binding.userId])).rows[0];
      if (!row || row.provider !== binding.provider ||
          row.message_id !== binding.messageId && !(row.message_id === null && startedCalls.has(callId)) ||
          row.conversation_id !== binding.conversationId && !(row.conversation_id === null && startedCalls.has(callId))) throw accountingError();
      if (row.status !== 'running') {
        if (row.status === event.status && row.usage_status === event.usage.status && row.input_tokens === input && row.output_tokens === output) return;
        // Recovery may have marked a live stream interrupted before its actual final report arrives.
        if (row.status !== 'interrupted' || !startedCalls.has(callId)) throw accountingError();
      }
      await client.query(`UPDATE platform_chat_calls SET status=$2,usage_status=$3,input_tokens=$4,output_tokens=$5,finished_at=now() WHERE id=$1`,
        [callId, event.status, event.usage.status, input, output]);
    });
  };
}

/** Preserve known counts; an abandoned call has no provider report to reconstruct. */
export async function recoverChatUsage(client: PoolClient, userId?: string) {
  await client.query(`UPDATE platform_chat_calls u SET status='interrupted',usage_status='missing',finished_at=now()
    WHERE u.status='running' AND ($1::uuid IS NULL OR u.user_id=$1) AND (
      u.message_id IS NULL OR NOT EXISTS (SELECT 1 FROM platform_messages m
        JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=u.user_id AND l.kind='chat'
        WHERE m.id=u.message_id AND m.status='streaming' AND m.lease_until > now() AND l.expires_at > now()))`, [userId ?? null]);
}
function count(value: unknown) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw accountingError();
  return result;
}
function add(left: number, right: number) { return count(left + right); }

export async function accountUsage(db: Database, userId: string, now = new Date()): Promise<AccountUsage> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return db.transaction(async client => {
    await recoverChatUsage(client, userId);
    const groups = await client.query(`SELECT provider,model,count(*) AS calls,
      count(*) FILTER(WHERE usage_status='reported') AS reported,
      count(*) FILTER(WHERE usage_status='missing') AS missing,
      count(*) FILTER(WHERE usage_status='invalid') AS invalid,
      count(*) FILTER(WHERE usage_status='pending') AS pending,
      sum(input_tokens) FILTER(WHERE usage_status='reported') AS input,
      sum(output_tokens) FILTER(WHERE usage_status='reported') AS output,
      count(*) FILTER(WHERE status='complete') AS complete,
      count(*) FILTER(WHERE status='failed') AS failed,
      count(*) FILTER(WHERE status='cancelled') AS cancelled,
      count(*) FILTER(WHERE status='interrupted') AS interrupted,
      count(*) FILTER(WHERE status='running') AS running
      FROM platform_chat_calls WHERE user_id=$1 AND created_at >= $2 AND created_at < $3
      GROUP BY provider,model ORDER BY provider,model`, [userId, from, to]);
    const legacy = (await client.query(`SELECT count(*) AS reports FROM platform_usage
      WHERE user_id=$1 AND capability='chat' AND created_at >= $2 AND created_at < $3`, [userId, from, to])).rows[0];
    const chat: AccountUsage['chat'] = {
      calls: 0, reportedCalls: 0, missingCalls: 0, invalidCalls: 0, pendingCalls: 0, inputTokens: null, outputTokens: null,
      coverage: 'none', outcomes: { complete: 0, failed: 0, cancelled: 0, interrupted: 0, running: 0 }, providers: [], legacyReports: count(legacy.reports),
    };
    let inputTokens = 0, outputTokens = 0;
    for (const row of groups.rows) {
      const calls = count(row.calls), reportedCalls = count(row.reported);
      chat.calls = add(chat.calls, calls); chat.reportedCalls = add(chat.reportedCalls, reportedCalls);
      chat.missingCalls = add(chat.missingCalls, count(row.missing)); chat.invalidCalls = add(chat.invalidCalls, count(row.invalid)); chat.pendingCalls = add(chat.pendingCalls, count(row.pending));
      for (const key of ['complete', 'failed', 'cancelled', 'interrupted', 'running'] as const) chat.outcomes[key] = add(chat.outcomes[key], count(row[key]));
      const input = row.input === null ? null : count(row.input), output = row.output === null ? null : count(row.output);
      inputTokens = add(inputTokens, input ?? 0); outputTokens = add(outputTokens, output ?? 0);
      chat.providers.push({ provider: row.provider, model: row.model, calls, reportedCalls, inputTokens: input, outputTokens: output });
    }
    if (chat.reportedCalls) { chat.inputTokens = inputTokens; chat.outputTokens = outputTokens; }
    chat.coverage = chat.reportedCalls === 0 ? 'none' : chat.reportedCalls === chat.calls ? 'complete' : 'partial';
    return { period: { from, to, timeZone: 'UTC' }, chat };
  });
}
