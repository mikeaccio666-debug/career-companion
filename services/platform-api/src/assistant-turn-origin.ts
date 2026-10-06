import type { PoolClient } from 'pg';
import { platformAccountId } from '@companion/platform-contracts';
import { ApiError, invalid, object } from './errors.ts';

/** Trusted handler closure only. Model/HTTP input never supplies this origin. */
export interface AssistantTurnOrigin { conversationId: string; messageId: string }
export function parseAssistantTurnOrigin(value:unknown):AssistantTurnOrigin {
  const origin=object(value);
  if(Object.keys(origin).some(key=>!['conversationId','messageId'].includes(key))||!platformAccountId(origin.conversationId)||!platformAccountId(origin.messageId))throw invalid('Invalid server assistant-turn origin.');
  return {conversationId:origin.conversationId.toLowerCase(),messageId:origin.messageId.toLowerCase()};
}
export const inactiveAssistantTurn=()=>new ApiError(409,'ASSISTANT_TURN_INACTIVE','This assistant response is no longer active. No draft or task was prepared.');

/** User serialization precedes this guard. KEY SHARE avoids reversing chat's conversation -> user locks. */
export async function authorizeAssistantTurn(client:PoolClient,userId:string,origin:AssistantTurnOrigin,signal?:AbortSignal,inactive=inactiveAssistantTurn):Promise<void>{
  signal?.throwIfAborted();
  const conversation=await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE',[origin.conversationId,userId]);
  signal?.throwIfAborted();if(!conversation.rowCount)throw inactive();
  const message=await client.query(`SELECT id FROM platform_messages WHERE id=$1 AND conversation_id=$2 AND role='assistant'
    AND status='streaming' AND lease_until>clock_timestamp() FOR NO KEY UPDATE`,[origin.messageId,origin.conversationId]);
  signal?.throwIfAborted();if(!message.rowCount)throw inactive();
  const lease=await client.query(`SELECT id FROM platform_runtime_leases WHERE id=$1 AND user_id=$2 AND kind='chat'
    AND expires_at>clock_timestamp() FOR KEY SHARE`,[origin.messageId,userId]);
  signal?.throwIfAborted();if(!lease.rowCount)throw inactive();
}
