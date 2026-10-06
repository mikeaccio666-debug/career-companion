import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT, GOAL_PLAN_PROPOSAL_MAX_LIMIT, platformAccountId } from '@companion/platform-contracts';
import type { GoalPlanProposalList, GoalPlanProposalSummary, GoalPlanProposalResult } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError, invalid, notFound, object } from './errors.ts';
import { authorizeAssistantTurn, parseAssistantTurnOrigin, type AssistantTurnOrigin } from './assistant-turn-origin.ts';
import { GoalPlans, parseGoalPlanInput } from './goal-plans.ts';
import { goalPlanHash } from './goal-plan-core.ts';

export const inactiveProposal=()=>new ApiError(409,'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE','This assistant response is no longer active. No plan draft was saved.');
export function parseGoalProposalQuery(value:unknown):{limit:number;before?:string}{
  const data=object(value);if(Object.keys(data).some(key=>!['limit','before'].includes(key)))throw invalid('Unsupported goal-plan proposal query.');
  let limit=GOAL_PLAN_PROPOSAL_DEFAULT_LIMIT;
  if(data.limit!==undefined){if(typeof data.limit!=='string'||!/^[1-9][0-9]?$/.test(data.limit)||Number(data.limit)>GOAL_PLAN_PROPOSAL_MAX_LIMIT)throw invalid('Choose a proposal limit between one and fifty.');limit=Number(data.limit);}
  if(data.before!==undefined&&!platformAccountId(data.before))throw invalid('Use an owned proposal plan ID as the older-page cursor.');
  return {limit,...(data.before===undefined?{}:{before:(data.before as string).toLowerCase()})};
}
const summarySQL=`SELECT o.plan_id,o.conversation_id,o.message_id,o.created_at,p.revision,p.status,r.title,
  (SELECT count(*)::integer FROM platform_goal_plan_steps s WHERE s.plan_id=p.id AND s.revision=p.revision) AS step_count
  FROM platform_goal_plan_proposals o JOIN platform_goal_plans p ON p.id=o.plan_id AND p.user_id=o.user_id AND p.conversation_id=o.conversation_id
  JOIN platform_goal_plan_revisions r ON r.plan_id=p.id AND r.revision=p.revision`;
function summary(row:any):GoalPlanProposalSummary{return {planId:row.plan_id,conversationId:row.conversation_id,title:row.title,revision:row.revision,status:row.status,stepCount:row.step_count,messageId:row.message_id??null,createdAt:new Date(row.created_at).toISOString()};}

export class GoalPlanProposals{
  constructor(readonly db:Database,readonly plans:GoalPlans){}
  private async summary(client:PoolClient,userId:string,planId:string):Promise<GoalPlanProposalSummary>{
    const row=(await client.query(summarySQL+' WHERE o.plan_id=$1 AND o.user_id=$2',[planId,userId])).rows[0];if(!row)throw notFound();return summary(row);
  }
  async propose(userId:string,originValue:AssistantTurnOrigin,value:unknown,signal?:AbortSignal):Promise<GoalPlanProposalResult>{
    signal?.throwIfAborted();const origin=parseAssistantTurnOrigin(originValue),input=parseGoalPlanInput(value),inputHash=goalPlanHash(input);
    return this.db.transaction(async client=>{
      signal?.throwIfAborted();await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);signal?.throwIfAborted();
      await authorizeAssistantTurn(client,userId,origin,signal,inactiveProposal);
      const existing=(await client.query('SELECT plan_id,input_hash FROM platform_goal_plan_proposals WHERE message_id=$1 AND user_id=$2 AND conversation_id=$3',[origin.messageId,userId,origin.conversationId])).rows[0];
      signal?.throwIfAborted();
      if(existing){
        if(existing.input_hash!==inputHash)throw new ApiError(409,'GOAL_PLAN_PROPOSAL_EXISTS','This response already proposed a different plan. Edit its saved draft or ask for a new proposal in another response.');
        const proposal=await this.summary(client,userId,existing.plan_id);await authorizeAssistantTurn(client,userId,origin,signal,inactiveProposal);signal?.throwIfAborted();return {proposal};
      }
      const planId=randomUUID();await this.plans.createDraftInTransaction(client,userId,origin.conversationId,input,planId);
      signal?.throwIfAborted();
      // Recheck both clocks at the final origin write, even after waiting for FK or definition locks.
      const inserted=await client.query(`INSERT INTO platform_goal_plan_proposals(plan_id,user_id,conversation_id,message_id,input_hash)
        SELECT $1,$2,c.id,m.id,$5 FROM platform_conversations c JOIN platform_messages m ON m.conversation_id=c.id
          JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=c.user_id AND l.kind='chat'
        WHERE c.id=$3 AND c.user_id=$2 AND m.id=$4 AND m.role='assistant' AND m.status='streaming'
          AND m.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp() RETURNING plan_id`,[planId,userId,origin.conversationId,origin.messageId,inputHash]);
      signal?.throwIfAborted();if(!inserted.rowCount)throw inactiveProposal();
      const proposal=await this.summary(client,userId,planId);await authorizeAssistantTurn(client,userId,origin,signal,inactiveProposal);signal?.throwIfAborted();return {proposal};
    });
  }
  async list(userId:string,conversationId:string,value:unknown):Promise<GoalPlanProposalList>{
    const query=parseGoalProposalQuery(value);
    return this.db.transaction(async client=>{
      if(!(await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE',[conversationId,userId])).rowCount)throw notFound();
      let cursor:any;
      if(query.before){cursor=(await client.query('SELECT created_at::text AS created_at_cursor,plan_id FROM platform_goal_plan_proposals WHERE plan_id=$1 AND user_id=$2 AND conversation_id=$3',[query.before,userId,conversationId])).rows[0];if(!cursor)throw notFound();}
      const found=(await client.query(summarySQL+` WHERE o.user_id=$1 AND o.conversation_id=$2 AND
        ($3::timestamptz IS NULL OR (o.created_at,o.plan_id)<($3::timestamptz,$4::uuid))
        ORDER BY o.created_at DESC,o.plan_id DESC LIMIT $5`,[userId,conversationId,cursor?.created_at_cursor??null,cursor?.plan_id??null,query.limit+1])).rows;
      const rows=found.slice(0,query.limit);return {proposals:rows.map(summary),nextBefore:found.length>query.limit?rows.at(-1)!.plan_id:null,limit:query.limit};
    });
  }
}
