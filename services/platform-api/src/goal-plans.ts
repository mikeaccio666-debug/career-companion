import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { GOAL_PLAN_GOAL_CHARACTERS, GOAL_PLAN_INSTRUCTION_CHARACTERS, GOAL_PLAN_LIMIT, GOAL_PLAN_MAX_BYTES, GOAL_PLAN_MAX_STEPS } from '@companion/platform-contracts';
import type { GoalPlan, GoalPlanContinuation, GoalPlanContinueResult, GoalPlanInput, GoalPlanList, GoalPlanStep, GoalPlanStepInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { ApiError, identifier, invalid, notFound, object, string } from './errors.ts';
import { JobService, mapApproval, mapJob, parseJob, providerAvailable, type JobAdmission } from './jobs.ts';
import { parseMcpJob } from './mcp-connections.ts';
import { assertGoalPlanDependencies, GOAL_PLAN_ROWS_SQL, lockGoalPlan } from './goal-plan-bindings.ts';
import { goalPlanCheckpoint, goalPlanHash, goalPlanStepState, parseGoalPlanContinuation, planBlocked, planChanged, planRevision, planStepIndex } from './goal-plan-core.ts';
import { parseGoalPlanTaskBindings, validateGoalPlanBindings } from './goal-plan-inputs.ts';
import { bindingInputDiagnostic, goalPlanInputObject, goalPlanInputString, semanticBindingDiagnostic, taskInputDiagnostic, withGoalPlanDiagnostic } from './goal-plan-input-diagnostics.ts';
import { assertLegacyConversation, assertLegacyConversationRow } from './companion-room-boundary.ts';

function fields(data: Record<string,unknown>, allowed: string[], path?:string) {
  const check=()=>{if (Object.keys(data).some(key => !allowed.includes(key))) throw invalid('Unsupported goal-plan field.');};
  if(path)withGoalPlanDiagnostic(check,{path,reason:'unsupported_field',expected:'allowed_fields_only'});else check();
}
export function parseGoalPlanInput(value: unknown): GoalPlanInput {
  const data=goalPlanInputObject(value,'$');fields(data,['title','goal','steps'],'$');
  if(Buffer.byteLength(JSON.stringify(data),'utf8')>GOAL_PLAN_MAX_BYTES)throw new ApiError(413,'GOAL_PLAN_INPUT_LIMIT','This goal-plan definition exceeds its byte limit.');
  withGoalPlanDiagnostic(()=>{if(!Array.isArray(data.steps)||data.steps.length<1||data.steps.length>GOAL_PLAN_MAX_STEPS)throw invalid('Choose between one and eight sequential goal-plan steps.');},
    {path:'steps',reason:data.steps===undefined?'missing':!Array.isArray(data.steps)?'type':!data.steps.length?'empty':'too_many',expected:'array_1_8_steps'});
  const steps:GoalPlanStepInput[]=(data.steps as unknown[]).map((value,index)=>{
    const path=`steps[${index}]`,step=goalPlanInputObject(value,path),title=goalPlanInputString(step.title,'step title',120,`${path}.title`);
    if(step.kind==='task'){
      fields(step,['kind','title','task','bindings'],path);
      const task=withGoalPlanDiagnostic(()=>{const task=parseJob(step.task);if(task.kind==='mcp')parseMcpJob(task);return task;},()=>taskInputDiagnostic(step.task,`${path}.task`));
      return {kind:'task',title,task,...(step.bindings===undefined?{}:{bindings:withGoalPlanDiagnostic(()=>parseGoalPlanTaskBindings(step.bindings),()=>bindingInputDiagnostic(step.bindings,`${path}.bindings`))})};
    }
    if(step.kind==='agent_turn'){
      fields(step,['kind','title','instruction','provider','model'],path);
      return {kind:'agent_turn',title,instruction:goalPlanInputString(step.instruction,'analysis instruction',GOAL_PLAN_INSTRUCTION_CHARACTERS,`${path}.instruction`),provider:goalPlanInputString(step.provider,'provider',80,`${path}.provider`),...(step.model===undefined?{}:{model:goalPlanInputString(step.model,'model',150,`${path}.model`)})};
    }
    return withGoalPlanDiagnostic(()=>{throw invalid('Choose a task or an Agent analysis step.');},{path:`${path}.kind`,reason:step.kind===undefined?'missing':typeof step.kind!=='string'?'type':'invalid_value',expected:'task_or_agent_turn'});
  });
  withGoalPlanDiagnostic(()=>validateGoalPlanBindings(steps),()=>semanticBindingDiagnostic(steps));
  return {title:goalPlanInputString(data.title,'title',120,'title'),goal:goalPlanInputString(data.goal,'goal',GOAL_PLAN_GOAL_CHARACTERS,'goal'),steps};
}
export interface GoalPlanAgentPreparation {
  continuation: GoalPlanContinuation;
  content: string;
  provider: string;
  model: string;
  sourceRows: any[];
  analysisMessageIds: string[];
}

export class GoalPlans {
  constructor(readonly db:Database, readonly jobs:JobService, readonly runtime:PlatformProviderRuntime) {}
  private async owner(client:PoolClient, userId:string, conversationId:string) {
    const owned=await client.query('SELECT id,kind FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE',[conversationId,userId]);
    if(!owned.rowCount)throw notFound();assertLegacyConversationRow(owned.rows[0]);
    await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
  }
  private async revisionRow(client:PoolClient,userId:string,planId:string,revision:number) {
    await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
    const row=(await client.query('SELECT * FROM platform_goal_plans WHERE id=$1 AND user_id=$2 FOR UPDATE',[planId,userId])).rows[0];
    if(!row)throw notFound();await assertLegacyConversation(client,userId,row.conversation_id);if(row.revision!==revision)throw planChanged();return row;
  }
  private async writeDefinition(client:PoolClient,planId:string,revision:number,input:GoalPlanInput) {
    await client.query('INSERT INTO platform_goal_plan_revisions(plan_id,revision,title,goal,definition_hash) VALUES($1,$2,$3,$4,$5)',[planId,revision,input.title,input.goal,goalPlanHash(input)]);
    for(const [index,step] of input.steps.entries())await client.query('INSERT INTO platform_goal_plan_steps(plan_id,revision,step_index,input,input_hash) VALUES($1,$2,$3,$4,$5)',[planId,revision,index,JSON.stringify(step),goalPlanHash(step)]);
  }
  async list(userId:string,conversationId:string):Promise<GoalPlanList> {
    await assertLegacyConversation(this.db,userId,conversationId);
    const ids=(await this.db.query('SELECT id FROM platform_goal_plans WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',[userId,conversationId,GOAL_PLAN_LIMIT])).rows;
    return {plans:await Promise.all(ids.map(row=>this.get(userId,row.id))),limit:GOAL_PLAN_LIMIT};
  }
  async create(userId:string,conversationId:string,value:unknown):Promise<GoalPlan> {
    const input=parseGoalPlanInput(value),id=randomUUID();
    await this.db.transaction(async client=>{
      await this.owner(client,userId,conversationId);
      await this.createDraftInTransaction(client,userId,conversationId,input,id);
    });return this.get(userId,id);
  }
  /** Internal creation after the caller's user serialization and owned-conversation/turn locks. */
  async createDraftInTransaction(client:PoolClient,userId:string,conversationId:string,input:GoalPlanInput,id:string):Promise<void>{
    await assertLegacyConversation(client,userId,conversationId);
    const count=(await client.query('SELECT count(*)::integer AS count FROM platform_goal_plans WHERE user_id=$1 AND conversation_id=$2',[userId,conversationId])).rows[0].count;
    if(count>=GOAL_PLAN_LIMIT)throw new ApiError(409,'GOAL_PLAN_LIMIT','This conversation already contains fifty saved goal plans. Use a new conversation for another plan.');
    await client.query('INSERT INTO platform_goal_plans(id,user_id,conversation_id) VALUES($1,$2,$3)',[id,userId,conversationId]);
    await this.writeDefinition(client,id,1,input);
  }
  async update(userId:string,planId:string,value:unknown):Promise<GoalPlan> {
    const data=object(value),revision=planRevision(data.revision),{revision:_,...definition}=data,input=parseGoalPlanInput(definition);
    await this.db.transaction(async client=>{
      const row=await this.revisionRow(client,userId,planId,revision);
      if(row.status!=='draft')throw new ApiError(409,'GOAL_PLAN_FROZEN','Confirmed plan inputs are immutable. Save a separate draft for a changed plan.');
      if(revision>=1_000_000)throw invalid('This plan reached its revision limit. Save a new draft.');
      await this.writeDefinition(client,planId,revision+1,input);
      await client.query('UPDATE platform_goal_plans SET revision=revision+1,updated_at=now() WHERE id=$1',[planId]);
    });return this.get(userId,planId);
  }
  async confirm(userId:string,planId:string,value:unknown):Promise<GoalPlan> {
    const data=object(value);fields(data,['revision']);const revision=planRevision(data.revision),current=await this.get(userId,planId);
    if(current.revision!==revision)throw planChanged();
    if(current.status!=='draft')return current;
    await this.db.transaction(async client=>{
      const row=await this.revisionRow(client,userId,planId,revision);if(row.status!=='draft')return;
      const stored=(await client.query(GOAL_PLAN_ROWS_SQL,[planId,userId])).rows;
      const definition=parseGoalPlanInput({title:stored[0].title,goal:stored[0].goal,steps:stored.map(item=>item.input)}),steps:GoalPlanStepInput[]=[];
      for(const step of definition.steps){
        if(step.kind==='task')steps.push({...step,task:await this.jobs.freezePlanInput(userId,step.task,client,step.bindings?.referenceImages?.length??0)});
        else{
          providerAvailable(this.runtime,step.provider,'agent');
          const provider=this.runtime.capabilities().find(item=>item.id===step.provider),model=step.model??provider?.modelsByCapability?.agent?.[0]??provider?.models[0];
          if(!model||!(provider?.modelsByCapability?.agent??provider?.models??[]).includes(model))throw invalid('Select an available fixed Agent model for this analysis step.');steps.push({...step,model});
        }
      }
      // Defaults and execution-template snapshots may enlarge an otherwise valid draft.
      // Validate the whole frozen definition before any revision or step is written.
      parseGoalPlanInput({...definition,steps});
      for(const [index,step] of steps.entries()){
        if(step.kind==='task'&&step.task.kind==='mcp')await this.jobs.mcp.normalize(client,userId,step.task);
        await client.query('UPDATE platform_goal_plan_steps SET input=$4,input_hash=$5 WHERE plan_id=$1 AND revision=$2 AND step_index=$3 AND bound_at IS NULL',[planId,revision,index,JSON.stringify(step),goalPlanHash(step)]);
      }
      await client.query('UPDATE platform_goal_plan_revisions SET definition_hash=$3,confirmed_at=now() WHERE plan_id=$1 AND revision=$2',[planId,revision,goalPlanHash({...definition,steps})]);
      await client.query("UPDATE platform_goal_plans SET status='active',updated_at=now() WHERE id=$1",[planId]);
    });return this.get(userId,planId);
  }
  async state(userId:string,planId:string,value:unknown):Promise<GoalPlan> {
    const data=object(value);fields(data,['revision','status']);const revision=planRevision(data.revision);
    if(typeof data.status!=='string'||!['active','paused','cancelled'].includes(data.status))throw invalid('Choose resume, pause, or end for the goal plan.');
    await this.db.transaction(async client=>{
      const row=await this.revisionRow(client,userId,planId,revision);
      if(row.status===data.status)return;
      if(row.status==='cancelled'||data.status!=='cancelled'&&!['active','paused'].includes(row.status))throw planBlocked('This plan cannot be resumed or paused. Confirm its draft or prepare a new plan.');
      await client.query('UPDATE platform_goal_plans SET status=$2,updated_at=now() WHERE id=$1',[planId,data.status]);
    });return this.get(userId,planId);
  }
  async get(userId:string,planId:string):Promise<GoalPlan> {
    const rows=(await this.db.query(GOAL_PLAN_ROWS_SQL,[planId,userId])).rows;if(!rows.length)throw notFound();
    await assertLegacyConversation(this.db,userId,rows[0].conversation_id);
    for(const row of rows)if(row.job?.kind==='mcp'){
      try{await this.jobs.mcp.validateBinding(this.db,row.job);}catch(error){if(!(error instanceof ApiError))throw error;row.mcpInvalid=true;}
    }
    const first=rows[0];let priorSucceeded=true;
    const steps:GoalPlanStep[]=rows.map(row=>{
      let {state,blockReason}=goalPlanStepState(row);
      if(state==='succeeded'&&row.receipt?.kind==='task'&&row.artifacts.length!==row.receipt.artifactIds.length){state='blocked';blockReason='An exact saved result is unavailable.';}
      const ready=first.status==='active'&&state==='pending'&&priorSucceeded;
      if(['pending','needs_approval'].includes(state)&&!priorSucceeded){state='blocked';blockReason='A preceding step has not confirmed success in its bound version.';}
      const result:GoalPlanStep={index:row.step_index,input:row.input,state,ready,artifacts:row.artifacts,...(blockReason?{blockReason}:{}),
        ...(row.job?{job:mapJob({...row.job,workflow_step_states:row.workflow_step_states,workflow_definition_hash:row.workflow_definition_hash,workflow_checkpoint_revision:row.workflow_checkpoint_revision,browser_checkpoint_state:row.browser_checkpoint_state,browser_checkpoint_revision:row.browser_checkpoint_revision,browser_next_index:row.browser_next_index},row.artifacts)}:{}),
        ...(row.job_generation?{generation:row.job_generation}:{}),
        ...(row.resolved_task?{resolvedTask:row.resolved_task,inputSources:row.input_sources}:{}),
        ...(state==='needs_approval'&&row.approval&&row.job.generation===row.job_generation?{approval:mapApproval(row.approval)}:{}),...(row.message_id?{messageId:row.message_id}:{}),...(row.receipt?{receipt:row.receipt}:{} )};
      priorSucceeded=priorSucceeded&&state==='succeeded';return result;
    });
    return {id:first.id,conversationId:first.conversation_id,revision:first.revision,title:first.title,goal:first.goal,definitionHash:first.definition_hash,
      status:first.status==='active'&&priorSucceeded?'completed':first.status,steps,createdAt:new Date(first.created_at).toISOString(),updatedAt:new Date(first.updated_at).toISOString(),...(first.confirmed_at?{confirmedAt:new Date(first.confirmed_at).toISOString()}:{} )};
  }
  async continue(userId:string,planId:string,value:unknown,signal?:AbortSignal,admission?:JobAdmission):Promise<GoalPlanContinueResult> {
    const data=object(value);fields(data,['revision','stepIndex']);const revision=planRevision(data.revision),stepIndex=planStepIndex(data.stepIndex),plan=await this.get(userId,planId);
    signal?.throwIfAborted();if(plan.revision!==revision)throw planChanged();const step=plan.steps[stepIndex];if(!step)throw planBlocked();
    if(step.job||step.messageId||step.receipt)return {kind:'existing',plan,stepIndex};
    if(!step.ready)throw planBlocked();
    if(step.input.kind==='agent_turn'){
      const continuation={planId,revision,stepIndex,conversationId:plan.conversationId};await this.prepareAgent(userId,continuation);
      return {kind:'agent_turn',plan,stepIndex,continuation};
    }
    await this.jobs.create(userId,step.input.task,undefined,signal,{planId,revision,stepIndex},admission);
    const next=await this.get(userId,planId),bound=next.steps[stepIndex];
    if(!bound.job)throw planBlocked();return {kind:'task',plan:next,stepIndex,job:bound.job,...(bound.approval?{approval:bound.approval}:{} )};
  }
  private async agentSnapshot(client:PoolClient,userId:string,continuation:GoalPlanContinuation,expectedMessageId?:string):Promise<GoalPlanAgentPreparation> {
    const {rows,step,plan}=await lockGoalPlan(client,userId,continuation);
    if(plan.conversation_id!==continuation.conversationId||step.input.kind!=='agent_turn')throw planBlocked('This analysis belongs to a different plan step or conversation.');
    if(step.bound_at&&step.message_id!==expectedMessageId)throw new ApiError(409,'GOAL_PLAN_STEP_ALREADY_STARTED','This analysis already has a saved message. Review it instead of running it again.');
    if(expectedMessageId&&(step.message?.status!=='streaming'||!step.message.lease_until||new Date(step.message.lease_until).getTime()<=Date.now()))throw planBlocked('This analysis no longer has an active server message. Review its saved outcome before making another plan.');
    await assertGoalPlanDependencies(client,rows,continuation.stepIndex,row=>this.jobs.mcp.validateBinding(client,row));
    providerAvailable(this.runtime,step.input.provider,'agent');if(!step.input.model)throw planBlocked('This analysis has no confirmed model snapshot.');
    const provider=this.runtime.capabilities().find(item=>item.id===step.input.provider);if(!(provider?.modelsByCapability?.agent??provider?.models??[]).includes(step.input.model))throw planBlocked('The confirmed Agent model is no longer available. Prepare a new plan.');
    const sources=rows.slice(0,continuation.stepIndex);
    return {continuation,provider:step.input.provider,model:step.input.model,content:goalPlanCheckpoint(rows[0].title,rows[0].goal,step.input.instruction,sources),sourceRows:sources,analysisMessageIds:sources.filter(row=>row.receipt.kind==='agent_turn').map(row=>row.receipt.messageId)};
  }
  async prepareAgent(userId:string,continuation:GoalPlanContinuation):Promise<GoalPlanAgentPreparation> {
    return this.db.transaction(async client=>{await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);return this.agentSnapshot(client,userId,continuation);});
  }
  async bindAgent(client:PoolClient,userId:string,continuation:GoalPlanContinuation,messageId:string):Promise<GoalPlanAgentPreparation> {
    const prepared=await this.agentSnapshot(client,userId,continuation);
    const result=await client.query('UPDATE platform_goal_plan_steps SET message_id=$4,bound_at=now() WHERE plan_id=$1 AND revision=$2 AND step_index=$3 AND bound_at IS NULL RETURNING plan_id',[continuation.planId,continuation.revision,continuation.stepIndex,messageId]);
    if(!result.rowCount)throw planBlocked();return prepared;
  }
  async assertAgentSources(userId:string,preparation:GoalPlanAgentPreparation,messageId:string,name?:string,args?:Record<string,unknown>):Promise<void> {
    await this.db.transaction(async client=>{
      const current=await this.agentSnapshot(client,userId,preparation.continuation,messageId);
      if(name==='get_browser_observation'||name==='read_mcp_result'){
        const kind=name==='get_browser_observation'?'browser':'mcp';if(!current.sourceRows.some(row=>row.input.kind==='task'&&row.input.task.kind===kind&&row.receipt.jobId===args?.jobId))throw new ApiError(403,'GOAL_PLAN_SOURCE_REQUIRED','Read only exact successful task references supplied by this goal plan.');
      }else if(name==='read_artifact_text'||name==='get_artifact_reference'){
        if(!current.sourceRows.some(row=>row.receipt.kind==='task'&&!['browser','mcp'].includes(row.input.task.kind)&&row.receipt.artifactIds.includes(args?.artifactId)))throw new ApiError(403,'GOAL_PLAN_SOURCE_REQUIRED','Read only exact successful artifacts supplied by this goal plan.');
      }
    });
  }
  async completeAgent(client:PoolClient,userId:string,preparation:GoalPlanAgentPreparation,messageId:string,signal?:AbortSignal):Promise<void> {
    // Every analysis transition owns plan -> message. Next-step preparation
    // holds this plan before reading the preceding message under SHARE.
    await lockGoalPlan(client,userId,preparation.continuation);
    signal?.throwIfAborted();
    const active=await client.query("SELECT m.id FROM platform_messages m JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=$3 AND l.kind='chat' WHERE m.id=$1 AND m.conversation_id=$2 AND m.status='streaming' AND m.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp() FOR NO KEY UPDATE OF m",[messageId,preparation.continuation.conversationId,userId]);
    if(!active.rowCount)throw planBlocked('This analysis lost its active server lease. Review its saved result before making another plan.');
    signal?.throwIfAborted();
    await this.agentSnapshot(client,userId,preparation.continuation,messageId);
    signal?.throwIfAborted();
    await client.query('UPDATE platform_goal_plan_steps SET receipt=$4 WHERE plan_id=$1 AND revision=$2 AND step_index=$3 AND message_id=$5 AND receipt IS NULL',[preparation.continuation.planId,preparation.continuation.revision,preparation.continuation.stepIndex,JSON.stringify({kind:'agent_turn',messageId,completedAt:new Date().toISOString()}),messageId]);
    signal?.throwIfAborted();
  }
}
export { parseGoalPlanContinuation };
