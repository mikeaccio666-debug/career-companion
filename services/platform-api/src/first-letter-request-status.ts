import type {PoolClient} from 'pg';
import type {PlatformConfig} from './config.ts';
import type {FirstLetterTaskSnapshot} from './first-letter-tasks.ts';
import {decodeFirstLetterRequest,firstLetterRequestUnavailable,type FirstLetterRequestRow} from './first-letter-request.ts';
/** Caller already authenticated the owner and decoded the retained task.
 * This read does not grant, renew or execute the accepted session. */
export async function readFirstLetterRequestStatus(c:PoolClient,crypto:PlatformConfig['dataCrypto'],task:FirstLetterTaskSnapshot){
 const rows=(await c.query<FirstLetterRequestRow>('SELECT * FROM platform_first_letter_requests WHERE user_id=$1 AND task_id=$2',
  [task.ownerId,task.taskId])).rows;
 if(!rows.length)return null;
 if(rows.length!==1)throw firstLetterRequestUnavailable();
 const request=decodeFirstLetterRequest(rows[0],crypto);
 if(request.preparationId!==task.preparationId||request.sourceId!==task.sourceId||request.companionId!==task.companionId
  ||request.welcomeId!==task.welcomeId||JSON.stringify(request.settings)!==JSON.stringify(task.settings))throw firstLetterRequestUnavailable();
 const outbox=(await c.query('SELECT * FROM platform_first_letter_outbox WHERE request_id=$1 AND user_id=$2 AND task_id=$3',
  [request.requestId,task.ownerId,task.taskId])).rows[0];
 if(!outbox||!(outbox.created_at instanceof Date)||outbox.created_at.toISOString()!==request.acceptedAt
  ||outbox.dispatched_at!==null&&(!(outbox.dispatched_at instanceof Date)||!Number.isFinite(outbox.dispatched_at.getTime()))
  ||outbox.held_reason!==null&&!['authorization','configuration','source_changed','storage','terminal'].includes(outbox.held_reason))throw firstLetterRequestUnavailable();
 return {request,outbox:Object.freeze({requestId:request.requestId,taskId:task.taskId,createdAt:request.acceptedAt,
  dispatchedAt:outbox.dispatched_at?.toISOString()??null,hold:outbox.held_reason as null|'authorization'|'configuration'|'source_changed'|'storage'|'terminal'})};
}
