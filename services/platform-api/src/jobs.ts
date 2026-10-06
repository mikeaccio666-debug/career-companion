import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Worker } from 'bullmq';
import type { CreateJobInput, Job, PlatformProviderRuntime, Artifact, ProviderAttachment, GeneratedArtifact } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import type { PlatformConfig } from './config.ts';
import { ApiError, attachments, invalid, notFound, object, string } from './errors.ts';
import { configuredModelRelayPolicy, createJobModelRelay, type ModelRelayOptions } from './model-relay.ts';
import { applyWorkflowCheckpoint, initializeWorkflowCheckpoint, loadWorkflowCheckpoint, markWorkflowInterrupted, normalizeWorkflowInput, readWorkflowArtifact, workflowCanResume, type WorkflowBinding } from './workflow-checkpoints.ts';
import { workflowDefinitionHash, workflowHash, validateMediaJobInput, parseExecutionTemplateBinding } from '@companion/ai-core';
import type { WorkflowCheckpoint, WorkflowStep, WorkflowStepCheckpoint } from '@companion/platform-contracts';
import { browserDefinitionHash, parseBrowserTaskOptions } from '@companion/ai-core';
import { applyBrowserCheckpoint, assertBrowserAuthorized, browserReviewRequired, getBrowserObservation, initializeBrowserCheckpoint, loadBrowserCheckpoint, markBrowserInterrupted, normalizeBrowserInput, validateBrowserResult, type BrowserBinding } from './browser-checkpoints.ts';
import { artifactReferenceAttachment, validateJobImageReferences } from './media-references.ts';
import { readArtifactText } from './artifact-text.ts';
import { assertExecutionTemplateApproval, bindExecutionTemplates, safeJobExecutionTemplate, validateExecutionTemplates } from './execution-templates.ts';
import { connectionFromUrl, ProducerQueue, QUEUE_DISPATCH_TIMEOUT_MS, QUEUE_RECONCILE_INTERVAL_MS } from './queue-connection.ts';
import { McpConnections, mcpApprovalMatches, mcpDefinitionHash, mcpJobInput, mcpSummary, parseMcpJob, type McpExecutionBinding } from './mcp-connections.ts';
import type { McpTransport } from './mcp-transport-port.ts';
export { connectionFromUrl } from './queue-connection.ts';

export function parseJob(value: unknown): CreateJobInput {
  const data = object(value);
  if(Object.keys(data).some(key=>!['kind','provider','prompt','model','options','attachmentIds','executionTemplate'].includes(key)))throw invalid('Unsupported task field.');
  const kind = string(data.kind, 'kind', 30) as CreateJobInput['kind'];
  if (!['image','video','speech','browser','cli','workflow','mcp'].includes(kind)) throw invalid('Unsupported job kind.');
  if(kind==='mcp'&&['model','attachmentIds','executionTemplate'].some(key=>Object.hasOwn(data,key)))throw invalid('MCP tasks do not accept models, attachments or execution templates.');
  const options = data.options === undefined ? {} : object(data.options);
  if (kind==='workflow'?Buffer.byteLength(JSON.stringify(options),'utf8')>128*1024:JSON.stringify(options).length>20_000) throw invalid('Job options are too large.');
  const attachmentIds=attachments(data.attachmentIds);
  if(new Set(attachmentIds).size!==attachmentIds.length)throw invalid('Choose distinct task attachments.');
  if((kind==='image'||kind==='video')&&attachmentIds.length>4)throw invalid('Choose at most four distinct reference images.');
  return { kind, provider: string(data.provider, 'provider', 80), prompt: string(data.prompt,'prompt',20_000),
    model: string(data.model,'model',150,false) || undefined, options, ...(kind==='mcp'?{}:{attachmentIds}),
    ...(data.executionTemplate!==undefined?{executionTemplate:parseExecutionTemplateBinding(data.executionTemplate)}:{}) };
}
export function providerAvailable(runtime: PlatformProviderRuntime, provider: string, capability: string) {
  const status = runtime.capabilities().find(item => item.id === provider);
  if (!status || !status.enabled || !status.capabilities.includes(capability as never)) throw new ApiError(503,'PROVIDER_UNAVAILABLE','This provider is not configured or enabled for this capability.');
}
export function mapJob(row: any, artifacts: Artifact[] = []): Job {
  const browserActions=row.kind==='browser'&&Array.isArray(row.options?.actions)?row.options.actions.length:0;
  return { id: row.id, kind: row.kind, provider: row.provider, model: row.model ?? undefined, prompt: row.prompt,
    ...(row.provider==='comfyui'&&safeJobExecutionTemplate(row.execution_policy)?{executionTemplate:safeJobExecutionTemplate(row.execution_policy)}:{}),
    options: row.options, attachmentIds: row.attachment_ids, status: row.status, progress: row.progress,
    artifacts, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.kind==='mcp'&&row.execution_policy?.mcp?{mcp:mcpSummary(row.execution_policy.mcp)}:{}),
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'Task failed.' } : row.status==='cancelled'&&row.lease_token ? {code:'CANCELLATION_PENDING',message:'Cancellation requested; waiting for execution shutdown to be confirmed.'} : undefined,
    providerTaskId: row.provider_task_id ?? undefined, attempt: row.attempt_count,
    ...(browserActions?{browserExecution:{completedActions:row.browser_next_index??0,totalActions:browserActions,state:row.browser_checkpoint_state??'uncertain',reviewRequired:row.browser_checkpoint_state==='uncertain'||['failed','cancelled','uncertain'].includes(row.status)&&browserReviewRequired(row.browser_checkpoint_revision===undefined?undefined:{state:row.browser_checkpoint_state,revision:row.browser_checkpoint_revision,next_index:row.browser_next_index})}}:{}),
    ...(row.kind==='workflow'&&Array.isArray(row.options?.steps)?{workflowResumeAvailable:workflowCanResume(Array.isArray(row.workflow_step_states)?{definitionHash:row.workflow_definition_hash,revision:row.workflow_checkpoint_revision,steps:row.workflow_step_states}:undefined),workflowSteps:row.options.steps.map((step:WorkflowStep,index:number)=>{const saved=(row.workflow_step_states??[]).find((item:WorkflowStepCheckpoint)=>item.index===index);return {index,kind:step.kind,provider:step.provider,model:step.model,state:saved?.state??'pending',...(saved?.errorCode?{errorCode:saved.errorCode}:{})};})}: {}) };
}
function jobInput(row:any):CreateJobInput{return {kind:row.kind,provider:row.provider,prompt:row.prompt,model:row.model??undefined,options:row.options,attachmentIds:row.attachment_ids,...(row.provider==='comfyui'&&safeJobExecutionTemplate(row.execution_policy)?{executionTemplate:safeJobExecutionTemplate(row.execution_policy)}:{})};}
function inputHash(input: CreateJobInput) {
  return workflowHash({kind:input.kind,provider:input.provider,prompt:input.prompt,model:input.model??null,options:input.options??{},attachmentIds:input.attachmentIds??[],executionTemplate:input.executionTemplate??null});
}
/** Bind the database identity, generation, reviewed input and safe resume handle, never raw content in Redis. */
export function jobDefinitionHash(row:any):string {
  return workflowHash({version:1,jobId:row.id,userId:row.user_id,generation:row.generation,inputHash:inputHash(jobInput(row)),previousProviderTaskId:row.provider_task_id??null,modelRelay:row.execution_policy?.modelRelay??null,...(row.kind==='mcp'?{mcp:row.execution_policy?.mcp??null}:{})});
}
function approvalMatches(row:any,args:any):boolean {
  try {
    if(!args||typeof args!=='object'||Array.isArray(args))return false;
    const options={...(args.options??{})};
    // These true flags describe a server-created retry review; they are not execution options.
    for(const name of ['previousAttemptUncertain','newProviderRequest','mayIncurAdditionalCharge','resumeExistingProviderTask'])
      if(!(name in (row.options??{}))&&options[name]===true)delete options[name];
    if(inputHash({kind:args.kind,provider:args.provider,prompt:args.prompt,model:args.model??undefined,options,attachmentIds:args.attachmentIds??[],executionTemplate:args.executionTemplate})!==inputHash(jobInput(row)))return false;
    if(row.execution_policy?.modelRelay&&(args.modelProvider!=='openai'||workflowHash(args.modelRelayLimits)!==workflowHash(row.execution_policy.modelRelay)))return false;
    if(row.kind==='workflow'&&args.workflowDefinitionHash!==workflowDefinitionHash(jobInput(row)))return false;
    if(row.kind==='browser'&&args.browserDefinitionHash!==browserDefinitionHash(jobInput(row)))return false;
    if(row.kind==='mcp'&&!mcpApprovalMatches(row,args))return false;
    return true;
  }catch{return false;}
}
async function enqueueJob(client:PoolClient,id:string,generation:number) {
  const row=(await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND generation=$2 FOR UPDATE',[id,generation])).rows[0];
  if(!row)throw new ApiError(409,'JOB_GENERATION_CHANGED','The task attempt changed before it could be queued.');
  await client.query('INSERT INTO platform_job_outbox(job_id,generation,definition_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,generation,jobDefinitionHash(row)]);
}
async function deliveryPreflight(client:PoolClient,row:any,reconcile=false,mcp?:McpConnections):Promise<string> {
  const review=()=>new ApiError(409,'QUEUE_REVIEW_REQUIRED','This task has execution evidence that requires review before queue recovery.');
  if(row.status!=='queued'||row.lease_token||row.lease_until)throw review();
  if((await client.query(`SELECT 1 FROM platform_job_attempts WHERE job_id=$1 AND generation=$2
    UNION ALL SELECT 1 FROM platform_model_relay_requests WHERE job_id=$1 AND generation=$2
    UNION ALL SELECT 1 FROM platform_workflow_step_ledger WHERE job_id=$1 AND generation=$2
    UNION ALL SELECT 1 FROM platform_browser_action_ledger WHERE job_id=$1 AND generation=$2 LIMIT 1`,[row.id,row.generation])).rowCount)throw review();
  if(row.requires_approval){
    const approvals=await client.query("SELECT args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved'",[row.id,row.user_id,row.generation]);
    if(!approvals.rows.some(approval=>approvalMatches(row,approval.args)))throw new ApiError(409,'JOB_APPROVAL_REVOKED','The current task input is not covered by its generation approval.');
  }
  validateExecutionTemplates(jobInput(row),row.execution_policy);
  if(row.kind==='mcp'){
    if(!mcp)throw review();
    await mcp.validateBinding(client,row);
    if(await mcp.started(client,row.id))throw review();
  }
  if(row.kind==='workflow'){
    const saved=(await client.query('SELECT * FROM platform_workflow_checkpoints WHERE job_id=$1',[row.id])).rows[0];
    if(!saved||saved.definition_hash!==workflowDefinitionHash(jobInput(row))||!workflowCanResume({definitionHash:saved.definition_hash,revision:saved.revision,steps:saved.steps}))throw review();
  }
  if(row.kind==='browser'&&parseBrowserTaskOptions(row.options).actions?.length){
    const saved=(await client.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1',[row.id])).rows[0];
    if(!saved||saved.definition_hash!==browserDefinitionHash(jobInput(row))||browserReviewRequired(saved))throw review();
  }
  if(reconcile&&row.provider_task_id){
    const pollable=['ark','fal','comfyui'].includes(row.provider)&&(row.kind==='video'||row.kind==='image'&&row.provider!=='ark');
    const known=await client.query('SELECT id FROM platform_job_attempts WHERE job_id=$1 AND generation<$2 AND provider_task_id=$3 LIMIT 1',[row.id,row.generation,row.provider_task_id]);
    if(!pollable||!known.rowCount)throw review();
  }
  const hash=jobDefinitionHash(row),outbox=(await client.query('SELECT definition_hash FROM platform_job_outbox WHERE job_id=$1 AND generation=$2 FOR UPDATE',[row.id,row.generation])).rows[0];
  if(!outbox)throw review();
  if(outbox.definition_hash&&outbox.definition_hash!==hash)throw new ApiError(409,'JOB_DEFINITION_CHANGED','The saved task input changed after its execution notification was prepared.');
  // Legacy rows have no original digest. Only a currently authorized, unstarted generation may acquire one.
  if(!outbox.definition_hash)await client.query('UPDATE platform_job_outbox SET definition_hash=$3 WHERE job_id=$1 AND generation=$2 AND definition_hash IS NULL',[row.id,row.generation,hash]);
  return hash;
}
async function holdDelivery(client:PoolClient,row:any,error:unknown) {
  const safe=error instanceof ApiError?error:new ApiError(409,'QUEUE_REVIEW_REQUIRED','The saved task cannot be safely recovered. Review it before preparing another attempt.');
  const status=safe.code==='JOB_APPROVAL_REVOKED'?'needs_approval':safe.code.startsWith('COMFYUI_TEMPLATE_')?'failed':'uncertain';
  await client.query("UPDATE platform_jobs SET status=$3,error_code=$4,error_message=$5,updated_at=now() WHERE id=$1 AND generation=$2 AND status='queued'",[row.id,row.generation,status,safe.code,safe.publicMessage]);
}
export async function verifyAttachments(client: PoolClient | Database, userId: string, ids: string[]) {
  if (!ids.length) return;
  const result = await client.query('SELECT id FROM platform_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])', [userId, ids]);
  if (result.rowCount !== new Set(ids).size) throw notFound();
}

export class JobService {
  readonly mcp: McpConnections;
  constructor(readonly db: Database, readonly config: PlatformConfig, readonly runtime: PlatformProviderRuntime, readonly storage: BlobStorage, readonly relayOptions?:ModelRelayOptions, mcpTransport?:McpTransport) {
    this.mcp=new McpConnections(db,config.mcp,mcpTransport,storage);
  }
  async create(userId: string, input: CreateJobInput): Promise<{ job: Job; approval?: any }> {
    if(input.kind==='mcp')input=mcpJobInput(parseMcpJob(input));else providerAvailable(this.runtime,input.provider,input.kind);
    if(input.kind==='workflow')input=normalizeWorkflowInput(input,this.runtime.capabilities());
    if(input.kind==='browser')input=normalizeBrowserInput(input,this.runtime);
    if(input.kind==='image'||input.kind==='video'){
      const defaultModel=this.runtime.capabilities().find(provider=>provider.id===input.provider)?.modelsByCapability?.[input.kind]?.[0];
      if(!input.model&&input.provider!=='comfyui'&&defaultModel)input={...input,model:defaultModel};
      validateMediaJobInput(input);
    }
    await validateJobImageReferences(this.db,this.storage,this.runtime,userId,input);
    const templateBinding=bindExecutionTemplates(input,this.runtime);input=templateBinding.input;
    const relayPolicy=input.kind==='cli'&&input.provider==='cli'?configuredModelRelayPolicy(this.relayOptions?.env):undefined;
    if(relayPolicy){if(input.model&&input.model!==relayPolicy.model)throw invalid('The CLI model is fixed by the server.');input={...input,model:relayPolicy.model};}
    return this.db.transaction(async client => {
      await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
      const mcpPolicy=input.kind==='mcp'?await this.mcp.normalize(client,userId,input):undefined;
      const active = await client.query("SELECT count(*)::integer AS count FROM platform_jobs WHERE user_id=$1 AND status IN ('needs_approval','queued','running')",[userId]);
      if (active.rows[0].count >= this.config.maxActiveJobs) throw new ApiError(429,'ACTIVE_JOB_LIMIT','Finish or cancel an active task before creating another.');
      await verifyAttachments(client,userId,input.attachmentIds ?? []);
      const approvalRequired = ['cli','browser','workflow','mcp'].includes(input.kind);
      const id = randomUUID();
      const result = await client.query('INSERT INTO platform_jobs(id,user_id,kind,provider,model,prompt,options,attachment_ids,status,requires_approval,execution_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [id,userId,input.kind,input.provider,input.model ?? null,input.prompt,JSON.stringify(input.options ?? {}),JSON.stringify(input.attachmentIds ?? []),approvalRequired?'needs_approval':'queued',approvalRequired,JSON.stringify({...(relayPolicy?{modelRelay:relayPolicy}:{}),...(templateBinding.comfyui?{comfyui:templateBinding.comfyui}:{}),...(mcpPolicy?{mcp:mcpPolicy}:{})})]);
      if(input.kind==='workflow'){await initializeWorkflowCheckpoint(client,id,input);Object.assign(result.rows[0],{workflow_step_states:[],workflow_definition_hash:workflowDefinitionHash(input),workflow_checkpoint_revision:0});}
      if(input.kind==='browser'){await initializeBrowserCheckpoint(client,id,input);Object.assign(result.rows[0],{browser_checkpoint_state:'ready',browser_checkpoint_revision:0,browser_next_index:0});}
      let approval;
      if (approvalRequired) approval = await this.addApproval(client,userId,id,input,1);
      else await enqueueJob(client,id,1);
      return { job: mapJob(result.rows[0]), approval };
    });
  }
  async addApproval(client: PoolClient, userId: string, jobId: string, input: CreateJobInput, generation:number) {
    const relayPolicy=input.kind==='cli'&&input.provider==='cli'?(await client.query('SELECT execution_policy FROM platform_jobs WHERE id=$1',[jobId])).rows[0]?.execution_policy?.modelRelay:undefined;
    const mcpPolicy=input.kind==='mcp'?(await client.query('SELECT execution_policy FROM platform_jobs WHERE id=$1 AND user_id=$2',[jobId,userId])).rows[0]?.execution_policy?.mcp:undefined;
    const result = await client.query('INSERT INTO platform_approvals(id,user_id,job_id,tool_name,args,generation) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(),userId,jobId,input.kind,JSON.stringify({...input,...(relayPolicy?{modelProvider:'openai',modelRelayLimits:relayPolicy}: {}),...(input.kind==='workflow'?{workflowDefinitionHash:workflowDefinitionHash(input)}:{}),...(input.kind==='browser'?{browserDefinitionHash:browserDefinitionHash(input)}:{}),...(mcpPolicy?{mcp:mcpSummary(mcpPolicy),mcpDefinitionHash:mcpDefinitionHash(input,mcpPolicy)}:{})}),generation]);
    return mapApproval(result.rows[0]);
  }
  async list(userId: string): Promise<Job[]> {
    const result = await this.db.query('SELECT j.*,c.steps AS workflow_step_states,c.definition_hash AS workflow_definition_hash,c.revision AS workflow_checkpoint_revision,b.state AS browser_checkpoint_state,b.revision AS browser_checkpoint_revision,b.next_index AS browser_next_index FROM platform_jobs j LEFT JOIN platform_workflow_checkpoints c ON c.job_id=j.id LEFT JOIN platform_browser_checkpoints b ON b.job_id=j.id WHERE j.user_id=$1 ORDER BY j.created_at DESC LIMIT 100',[userId]);
    return Promise.all(result.rows.map(async row => mapJob(row,await this.artifacts(userId,row.id))));
  }
  async get(userId: string, id: string): Promise<Job> {
    const result = await this.db.query('SELECT j.*,c.steps AS workflow_step_states,c.definition_hash AS workflow_definition_hash,c.revision AS workflow_checkpoint_revision,b.state AS browser_checkpoint_state,b.revision AS browser_checkpoint_revision,b.next_index AS browser_next_index FROM platform_jobs j LEFT JOIN platform_workflow_checkpoints c ON c.job_id=j.id LEFT JOIN platform_browser_checkpoints b ON b.job_id=j.id WHERE j.user_id=$1 AND j.id=$2',[userId,id]);
    if (!result.rowCount) throw notFound();
    return mapJob(result.rows[0],await this.artifacts(userId,id));
  }
  async artifacts(userId: string, id: string): Promise<Artifact[]> {
    const result = await this.db.query('SELECT a.*,u.byte_size FROM platform_artifacts a LEFT JOIN platform_uploads u ON u.id=a.upload_id WHERE a.user_id=$1 AND a.job_id=$2 ORDER BY a.created_at',[userId,id]);
    return result.rows.map(row => ({ id:row.id,name:row.filename ?? 'artifact',mime:row.mime ?? 'application/octet-stream',url:`/api/platform/artifacts/${row.id}`,size:row.byte_size===null||row.byte_size===undefined?undefined:Number(row.byte_size) }));
  }
  async cancel(userId: string, id: string): Promise<Job> {
    await this.db.transaction(async client => {
      const result = await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
      if (!result.rowCount) throw notFound();
      if (!['succeeded','failed','cancelled','uncertain'].includes(result.rows[0].status)) {
        // Keep an in-flight lease until the worker confirms cleanup. An accepted cancellation is not proof of shutdown.
        await client.query("UPDATE platform_jobs SET status='cancelled',lease_token=CASE WHEN status='running' THEN lease_token ELSE NULL END,lease_until=CASE WHEN status='running' THEN lease_until ELSE NULL END,updated_at=now() WHERE id=$1",[id]);
        await client.query("UPDATE platform_approvals SET status='rejected',decided_at=now() WHERE job_id=$1 AND status='pending'",[id]);
        if(result.rows[0].kind==='browser')await markBrowserInterrupted(client,id,result.rows[0].generation);
      }
    });
    return this.get(userId,id);
  }
  async retry(userId: string, id: string): Promise<Job> {
    await this.db.transaction(async client => {
      await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[userId]);
      const result = await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
      if (!result.rowCount) throw notFound();
      const row = result.rows[0];
      if (!['failed','cancelled','uncertain'].includes(row.status)) throw new ApiError(409,'JOB_NOT_RETRYABLE','Only failed or cancelled tasks can be retried.');
      if(row.kind==='mcp'){
        if(await this.mcp.started(client,id))throw new ApiError(409,'MCP_REVIEW_REQUIRED','This MCP call already started and cannot be replayed by retry.');
        await this.mcp.validateBinding(client,row);
      }
      if(row.error_code==='CLI_CLEANUP_UNCONFIRMED')throw new ApiError(409,'OPERATOR_REVIEW_REQUIRED','A local operator must confirm the previous container stopped before retrying.');
      if(row.kind==='browser'&&parseBrowserTaskOptions(row.options).actions?.length){const saved=await client.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1',[id]);if(browserReviewRequired(saved.rows[0]))throw new ApiError(409,'BROWSER_REVIEW_REQUIRED','Browser actions cannot be replayed after execution began. Inspect the saved observations and prepare a new reviewed task.');}
      if(row.lease_token)throw new ApiError(409,'JOB_CANCELLING','Wait for the previous execution to stop before retrying.');
      if(row.kind==='workflow'){
        const saved=await client.query('SELECT definition_hash,revision,steps FROM platform_workflow_checkpoints WHERE job_id=$1',[id]);
        const checkpoint:WorkflowCheckpoint|undefined=saved.rowCount?{definitionHash:saved.rows[0].definition_hash,revision:saved.rows[0].revision,steps:saved.rows[0].steps}:undefined;
        if(!workflowCanResume(checkpoint))throw new ApiError(409,'WORKFLOW_REVIEW_REQUIRED','A workflow step has an unknown external result. Reconcile it before starting another model call.');
      }
      const completedSteps=row.kind==='workflow'?new Set<number>(((await client.query('SELECT steps FROM platform_workflow_checkpoints WHERE job_id=$1',[id])).rows[0]?.steps??[]).filter((step:WorkflowStepCheckpoint)=>step.state==='completed').map((step:WorkflowStepCheckpoint)=>step.index)):new Set<number>();
      validateExecutionTemplates(jobInput(row),row.execution_policy,this.runtime,completedSteps);
      if(row.provider==='comfyui'&&row.status==='uncertain'&&!row.provider_task_id)throw new ApiError(409,'COMFYUI_REVIEW_REQUIRED','The previous server-template submission has an unknown result. Reconcile it before preparing another request.');
      if(row.kind!=='mcp')providerAvailable(this.runtime,row.provider,row.kind);
      const active = await client.query("SELECT count(*)::integer AS count FROM platform_jobs WHERE user_id=$1 AND status IN ('needs_approval','queued','running')",[userId]);
      if (active.rows[0].count >= this.config.maxActiveJobs) throw new ApiError(429,'ACTIVE_JOB_LIMIT','Finish or cancel an active task before retrying.');
      const terminalProviderTask = ['VIDEO_GENERATION_FAILED','MEDIA_GENERATION_FAILED','COMFYUI_FAILED','COMFYUI_NO_OUTPUT','COMFYUI_REJECTED'].includes(row.error_code);
      const approvalRequired = row.requires_approval || row.status==='uncertain' || terminalProviderTask;
      await client.query('UPDATE platform_jobs SET status=$2,generation=generation+1,requires_approval=$3,provider_task_id=$4,progress=0,error_code=NULL,error_message=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1', [id,approvalRequired?'needs_approval':'queued',approvalRequired,terminalProviderTask?null:row.provider_task_id]);
      if (approvalRequired) await this.addApproval(client,userId,id,{...jobInput(row),options:['browser','mcp'].includes(row.kind)?row.options:{...row.options,...(row.status==='uncertain'?{previousAttemptUncertain:true}:{}),...(terminalProviderTask?{newProviderRequest:true,mayIncurAdditionalCharge:true}:{})}},row.generation+1);
      else await enqueueJob(client,id,row.generation+1);
    });
    return this.get(userId,id);
  }
  async decide(userId: string, id: string, decision: 'approved'|'rejected') {
    return this.db.transaction(async client => {
      const reference = await client.query('SELECT job_id FROM platform_approvals WHERE id=$1 AND user_id=$2',[id,userId]);
      if(!reference.rowCount)throw notFound();
      if(!reference.rows[0].job_id)throw new ApiError(409,'APPROVAL_NOT_EXECUTABLE','This action is not executable as a job.');
      // Lock order matches cancellation: job first, then approval.
      const job = await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',[reference.rows[0].job_id,userId]);
      const result = await client.query('SELECT * FROM platform_approvals WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
      if (!result.rowCount) throw notFound();
      const approval = result.rows[0];
      if(!job.rowCount||job.rows[0].generation!==approval.generation)throw new ApiError(409,'APPROVAL_STALE','This approval belongs to an earlier task attempt.');
      if (approval.status!== 'pending') {
        if (approval.status===decision) return mapApproval(approval);
        throw new ApiError(409,'APPROVAL_DECIDED','This approval has already been decided.');
      }
      if (!approval.job_id) throw new ApiError(409,'APPROVAL_NOT_EXECUTABLE','This action is not executable as a job.');
      if (!job.rowCount || job.rows[0].status!=='needs_approval') throw new ApiError(409,'JOB_NOT_AWAITING_APPROVAL','This task no longer awaits approval.');
      if(decision==='approved'){const input=jobInput(job.rows[0]);if(input.kind==='mcp')await this.mcp.validateBinding(client,job.rows[0]);validateExecutionTemplates(input,job.rows[0].execution_policy);assertExecutionTemplateApproval(input,approval.args);if(!approvalMatches(job.rows[0],approval.args))throw new ApiError(409,'JOB_DEFINITION_CHANGED','The task no longer matches the input submitted for review.');}
      const updated = await client.query('UPDATE platform_approvals SET status=$2,decided_at=now() WHERE id=$1 RETURNING *',[id,decision]);
      await client.query('UPDATE platform_jobs SET status=$2,updated_at=now() WHERE id=$1',[approval.job_id,decision==='approved'?'queued':'cancelled']);
      if (decision==='approved') await enqueueJob(client,approval.job_id,job.rows[0].generation);
      return mapApproval(updated.rows[0]);
    });
  }
  async readAttachment(userId: string,id: string): Promise<ProviderAttachment> {
    const result = await this.db.query('SELECT * FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,userId]);
    if (!result.rowCount) throw notFound();
    const row=result.rows[0]; return {name:row.filename,mime:row.mime,bytes:await this.storage.get(row.storage_key)};
  }
  async browserObservation(userId:string,id:string){return getBrowserObservation(this.db,this.storage,userId,id);}
  async referenceAttachment(userId:string,id:string){return artifactReferenceAttachment(this.db,this.storage,userId,id);}
  async artifactText(userId:string,input:unknown,signal?:AbortSignal){return readArtifactText(this.db,this.storage,userId,input,signal);}
}
export function mapApproval(row: any) { return {id:row.id,jobId:row.job_id,toolName:row.tool_name,args:row.args,status:row.status,generation:row.generation,createdAt:new Date(row.created_at).toISOString()}; }

export class TaskQueue {
  private producer?:ProducerQueue;private timer?:NodeJS.Timeout;private inFlight?:Promise<void>;private closed=false;
  constructor(private jobs:JobService) {}
  get queue():ProducerQueue {
    if(this.closed)throw new ApiError(503,'QUEUE_CLOSED','The execution-notification producer has stopped.');
    return this.producer??=new ProducerQueue(this.jobs.config.queueName,this.jobs.config.redisUrl);
  }
  dispatch():Promise<void> {
    if(this.closed)return Promise.reject(new ApiError(503,'QUEUE_CLOSED','The execution-notification producer has stopped.'));
    if(this.inFlight)return this.inFlight;
    const running=this.runDispatch();this.inFlight=running;
    void running.then(()=>{if(this.inFlight===running)this.inFlight=undefined;},()=>{if(this.inFlight===running)this.inFlight=undefined;});
    return running;
  }
  private async runDispatch() {
    const queue=this.queue;let expired=false,closing:Promise<void>|undefined;
    const stop=()=>{expired=true;closing??=queue.close();void closing.catch(()=>{});};
    const deadline=setTimeout(stop,QUEUE_DISPATCH_TIMEOUT_MS);deadline.unref();
    const assertOpen=()=>{if(expired||this.closed)throw new ApiError(503,'QUEUE_UNAVAILABLE','Execution notifications could not be confirmed before the queue deadline.');};
    try {
      await this.jobs.db.transaction(async client=>{
        await client.query("SET LOCAL statement_timeout='2000ms'");
        await client.query("SET LOCAL lock_timeout='250ms'");
        assertOpen();
        // One bounded dispatcher per queue across API replicas; don't wait and consume a pool slot.
        const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",[`platform-outbox:${this.jobs.config.queueName}`]);
        if(!lock.rows[0].acquired)return;
        const result=await client.query(`SELECT j.*,o.dispatched_at AS delivery_dispatched_at FROM platform_job_outbox o
          JOIN platform_jobs j ON j.id=o.job_id WHERE j.status='queued' AND j.generation=o.generation
          AND (o.dispatched_at IS NULL OR o.dispatched_at<now()-$1::integer*interval '1 millisecond')
          ORDER BY o.dispatched_at ASC NULLS FIRST,o.created_at,j.id LIMIT 25 FOR UPDATE OF j SKIP LOCKED`,[QUEUE_RECONCILE_INTERVAL_MS]);
        for(const row of result.rows){
          assertOpen();let definitionHash:string;
          try {definitionHash=await deliveryPreflight(client,row,false,this.jobs.mcp);}
          catch(error){if(error instanceof ApiError){await holdDelivery(client,row,error);continue;}throw error;}
          assertOpen();
          const id=`${row.id}-${row.generation}`,existing=await queue.getJob(id);assertOpen();
          if(existing){
            if(existing.data?.jobId!==row.id||existing.data?.generation!==row.generation||(existing.data?.definitionHash!==undefined&&existing.data.definitionHash!==definitionHash)){
              await holdDelivery(client,row,new ApiError(409,'QUEUE_RECORD_INVALID','The saved queue notification does not match its database task.'));continue;
            }
            const state=await existing.getState();assertOpen();
            if(['completed','failed','unknown'].includes(state)){
              // A terminal notification with no DB attempt may have failed before claiming. Never steal active work.
              try {await deliveryPreflight(client,row,row.delivery_dispatched_at!==null,this.jobs.mcp);}
              catch(error){if(error instanceof ApiError){await holdDelivery(client,row,error);continue;}throw error;}
              await existing.remove();assertOpen();
              await queue.add('execute',{jobId:row.id,generation:row.generation,definitionHash},{jobId:id,attempts:1,removeOnComplete:{age:86400},removeOnFail:{age:604800}});
            }else if(!['waiting','active','delayed','prioritized','waiting-children','paused'].includes(state))throw new ApiError(503,'QUEUE_UNAVAILABLE','The queue notification state could not be confirmed.');
          }else{
            try {await deliveryPreflight(client,row,row.delivery_dispatched_at!==null,this.jobs.mcp);}
            catch(error){if(error instanceof ApiError){await holdDelivery(client,row,error);continue;}throw error;}
            assertOpen();
            await queue.add('execute',{jobId:row.id,generation:row.generation,definitionHash},{jobId:id,attempts:1,removeOnComplete:{age:86400},removeOnFail:{age:604800}});
          }
          assertOpen();
          await client.query('UPDATE platform_job_outbox SET dispatched_at=now() WHERE job_id=$1 AND generation=$2',[row.id,row.generation]);
        }
        assertOpen();
      });
    }catch(error){
      // Close the actual producer socket and await the in-flight command's rejection; no detached publish/replay.
      stop();await closing;
      if(this.producer===queue)this.producer=undefined;
      throw error instanceof ApiError?error:new ApiError(503,'QUEUE_UNAVAILABLE','Execution notifications are unavailable. Saved tasks will be checked again after the queue recovers.');
    }finally {clearTimeout(deadline);if(closing)await closing;}
  }
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.dispatch().catch(()=>{}),1000);this.timer.unref();}
  async close(){
    this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;
    await this.producer?.close();await this.inFlight?.catch(()=>{});await this.producer?.close();
  }
}

export async function processJob(jobs: JobService, id: string, generation: number, expectedDefinitionHash?:string) {
  const token = randomUUID();
  const row = await jobs.db.transaction(async client => {
    const result=await client.query('SELECT * FROM platform_jobs WHERE id=$1 FOR UPDATE',[id]);
    const current=result.rows[0];
    if (!current || current.generation!==generation || current.status!=='queued') return undefined;
    try {
      const definitionHash=await deliveryPreflight(client,current,false,jobs.mcp);
      if(expectedDefinitionHash!==undefined&&expectedDefinitionHash!==definitionHash)throw new ApiError(409,'JOB_DEFINITION_CHANGED','The execution notification does not match the current frozen task.');
    }catch(error){if(error instanceof ApiError){await holdDelivery(client,current,error);return undefined;}throw error;}
    const update=await client.query("UPDATE platform_jobs SET status='running',attempt_count=attempt_count+1,lease_token=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1 RETURNING *",[id,token]);
    const claimed=update.rows[0];
    await client.query("INSERT INTO platform_job_attempts(id,job_id,generation,attempt,status,provider_task_id) VALUES($1,$2,$3,$4,'running',$5)",[randomUUID(),id,generation,claimed.attempt_count,claimed.provider_task_id]);
    return claimed;
  });
  if(!row)return;
  const abort=new AbortController();
  const heartbeat=setInterval(()=>void jobs.db.query("UPDATE platform_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id",[id,token]).then(result=>{if(!result.rowCount)abort.abort();}).catch(()=>abort.abort()),10_000);
  heartbeat.unref();
  const workspaceDirectory=path.join(jobs.config.storageDir,'workspaces',row.user_id,id);
  const storedKeys:string[]=[];
  const mcpBinding:McpExecutionBinding|undefined=row.kind==='mcp'?{jobId:id,userId:row.user_id,generation,leaseToken:token,input:jobInput(row),policy:row.execution_policy?.mcp,signal:abort.signal}:undefined;
  let mcpToolError=false;
  try {
    await fs.mkdir(workspaceDirectory,{recursive:true,mode:0o700});
    const input=jobInput(row);
    const workflowBinding:WorkflowBinding|undefined=row.kind==='workflow'?{jobId:id,userId:row.user_id,generation,leaseToken:token,definitionHash:workflowDefinitionHash(input),signal:abort.signal}:undefined;
    const workflowCheckpoint=workflowBinding?await loadWorkflowCheckpoint(jobs.db,workflowBinding):undefined;
    const templatePolicy=validateExecutionTemplates(input,row.execution_policy,jobs.runtime,new Set((workflowCheckpoint?.steps??[]).filter(step=>step.state==='completed').map(step=>step.index)));
    if(row.requires_approval&&row.provider==='comfyui'){const approval=(await jobs.db.query("SELECT args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved' ORDER BY decided_at DESC LIMIT 1",[id,row.user_id,generation])).rows[0];assertExecutionTemplateApproval(input,approval?.args);}
    const browserBinding:BrowserBinding|undefined=row.kind==='browser'?{jobId:id,userId:row.user_id,generation,leaseToken:token,definitionHash:browserDefinitionHash(input),signal:abort.signal}:undefined;
    const browserCheckpoint=browserBinding?await loadBrowserCheckpoint(jobs.db,browserBinding):undefined;
    const mcpResult=mcpBinding?await jobs.mcp.execute(mcpBinding):undefined;
    mcpToolError=mcpResult?.mcpToolError===true;
    const result=mcpResult??await jobs.runtime.executeJob(input,{jobId:id,userId:row.user_id,signal:abort.signal,workspaceDirectory,previousProviderTaskId:row.provider_task_id ?? undefined,
      ...(templatePolicy?.job?{comfyuiTemplate:templatePolicy.job}:{}),...(templatePolicy?.steps?{workflowComfyUITemplates:templatePolicy.steps}:{}),
      ...(workflowBinding?{workflowCheckpoint,onWorkflowCheckpoint:event=>applyWorkflowCheckpoint(jobs.db,jobs.storage,workflowBinding,event),readWorkflowArtifact:attachmentId=>readWorkflowArtifact(jobs.db,jobs.storage,workflowBinding,attachmentId)}:{}),
      ...(browserBinding?{browserCheckpoint,onBrowserCheckpoint:event=>applyBrowserCheckpoint(jobs.db,jobs.storage,browserBinding,event),assertBrowserAuthorized:async()=>{providerAvailable(jobs.runtime,row.provider,'browser');if(browserCheckpoint&&!jobs.runtime.capabilities().find(provider=>provider.id===row.provider)?.browserActionsEnabled)throw new ApiError(503,'BROWSER_ACTIONS_DISABLED','Browser actions are disabled on this server.');await assertBrowserAuthorized(jobs.db,browserBinding);}}:{}),
      requestModel:row.kind==='cli'?createJobModelRelay(jobs.db,{jobId:id,userId:row.user_id,generation,leaseToken:token,signal:abort.signal},jobs.relayOptions):undefined,
      readAttachment:attachmentId=>jobs.readAttachment(row.user_id,attachmentId),
      onProgress:async progress=>{await jobs.db.query("UPDATE platform_jobs SET progress=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'",[id,token,Math.max(0,Math.min(99,Math.round(progress)))]);},
      onProviderTask:async taskId=>{await jobs.db.transaction(async client=>{
        const persisted=await client.query("UPDATE platform_jobs SET provider_task_id=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",[id,token,taskId]);
        if(!persisted.rowCount)throw new ApiError(409,'JOB_CANCELLED','Task cancelled.');
        await client.query("UPDATE platform_job_attempts SET provider_task_id=$3 WHERE job_id=$1 AND generation=$2 AND status='running'",[id,generation,taskId]);
      });}});
    if(browserBinding&&!browserCheckpoint)validateBrowserResult(result,input,0);
    if(browserCheckpoint&&result.artifacts.length)throw new ApiError(502,'BROWSER_RESULT_INVALID','Action results must be published only through the browser journal.');
    const generated=[...result.artifacts];
    if(!browserCheckpoint&&result.text && !generated.some(artifact=>artifact.mime.startsWith('text/') && new TextDecoder().decode(artifact.bytes)===result.text))generated.push({name:'result.txt',mime:'text/plain',bytes:new TextEncoder().encode(result.text)});
    const prepared:{uploadId:string;artifactId:string;key:string;artifact:GeneratedArtifact}[]=[];
    for(const artifact of generated){
      if(artifact.bytes.byteLength>200*1024*1024)throw new ApiError(413,'ARTIFACT_TOO_LARGE','Generated artifact exceeds the storage limit.');
      const uploadId=randomUUID(), artifactId=randomUUID(),key=randomUUID();
      await jobs.storage.put(key,artifact.bytes,artifact.mime);storedKeys.push(key);
      prepared.push({uploadId,artifactId,key,artifact});
    }
    await jobs.db.transaction(async client=>{
      const locked=await client.query("SELECT *,lease_until>now() AS lease_active FROM platform_jobs WHERE id=$1 AND generation=$3 AND lease_token=$2 AND user_id=$4 FOR UPDATE",[id,token,generation,row.user_id]);
      if(locked.rows[0]?.status==='cancelled')throw new ApiError(409,'JOB_CANCELLED','Task cancelled.');
      if(!locked.rowCount||locked.rows[0].status!=='running'||!locked.rows[0].lease_active)throw new ApiError(409,'JOB_LEASE_EXPIRED','The execution lease is no longer current. Review the task before retrying.');
      if(locked.rows[0].requires_approval&&!(await client.query("SELECT id FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved' LIMIT 1",[id,row.user_id,generation])).rowCount)throw new ApiError(409,'JOB_APPROVAL_REVOKED','The current task attempt is no longer approved.');
      if(mcpBinding)await jobs.mcp.assertPublication(client,mcpBinding);
      validateExecutionTemplates(input,locked.rows[0].execution_policy);
      if(locked.rows[0].requires_approval&&row.provider==='comfyui'){const approval=(await client.query("SELECT args FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved' ORDER BY decided_at DESC LIMIT 1",[id,row.user_id,generation])).rows[0];assertExecutionTemplateApproval(input,approval?.args);}
      if(row.kind==='cli'&&(await client.query("SELECT id FROM platform_model_relay_requests WHERE job_id=$1 AND generation=$2 AND status IN ('reserved','uncertain') LIMIT 1",[id,generation])).rowCount)
        throw new ApiError(502,'MODEL_RELAY_UNCERTAIN','The model result has not been confirmed. Review before retrying.');
      if(row.kind==='workflow'){
        const checkpoint=await client.query('SELECT definition_hash,steps FROM platform_workflow_checkpoints WHERE job_id=$1',[id]);
        const definitionHash=workflowDefinitionHash(input),currentHash=workflowDefinitionHash({kind:'workflow',provider:'workflow',prompt:locked.rows[0].prompt,options:locked.rows[0].options});
        if(!checkpoint.rowCount||checkpoint.rows[0].definition_hash!==definitionHash||currentHash!==definitionHash||!(await client.query("SELECT id FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved' AND args->>'workflowDefinitionHash'=$4 LIMIT 1",[id,row.user_id,generation,definitionHash])).rowCount)throw new ApiError(409,'WORKFLOW_DEFINITION_CHANGED','The current reviewed workflow definition no longer matches its checkpoint.');
        if(checkpoint.rows[0].steps.length!==row.options.steps.length||checkpoint.rows[0].steps.some((step:WorkflowStepCheckpoint)=>step.state!=='completed'))throw new ApiError(502,'WORKFLOW_STEP_UNCERTAIN','The workflow has not confirmed every step result. Reconcile the checkpoints before retrying.');
      }
      if(browserBinding){
        const currentHash=browserDefinitionHash({kind:'browser',provider:locked.rows[0].provider,prompt:locked.rows[0].prompt,options:locked.rows[0].options});
        if(currentHash!==browserBinding.definitionHash||!(await client.query("SELECT id FROM platform_approvals WHERE job_id=$1 AND user_id=$2 AND generation=$3 AND status='approved' AND args->>'browserDefinitionHash'=$4 LIMIT 1",[id,row.user_id,generation,browserBinding.definitionHash])).rowCount)throw new ApiError(409,'BROWSER_DEFINITION_CHANGED','The final browser result does not match the current reviewed plan.');
        if(browserCheckpoint){const saved=await client.query('SELECT * FROM platform_browser_checkpoints WHERE job_id=$1',[id]);const cp=saved.rows[0];if(!cp||cp.definition_hash!==browserBinding.definitionHash||cp.state!=='completed'||cp.next_index!==cp.total_actions||cp.total_actions!==parseBrowserTaskOptions(input.options).actions?.length)throw new ApiError(409,'BROWSER_REVIEW_REQUIRED','The browser journal did not confirm all reviewed actions.');}
      }
      for(const entry of prepared){
        await client.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[entry.uploadId,row.user_id,entry.artifact.name,entry.artifact.mime,entry.artifact.bytes.byteLength,entry.key]);
        await client.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[entry.artifactId,row.user_id,id,row.kind,entry.artifact.mime,entry.artifact.name,entry.uploadId,JSON.stringify(mcpBinding?{mcpGeneration:generation,mcpDefinitionHash:mcpDefinitionHash(input,mcpBinding.policy),mcp:mcpSummary(mcpBinding.policy)}:browserBinding?{browserGeneration:generation,definitionHash:browserBinding.definitionHash,browserObservation:entry.artifact.name==='browser-observation.json'}:{})]);
      }
      if(mcpBinding){if(prepared.length!==1)throw new ApiError(502,'MCP_RESULT_INVALID','The MCP result did not contain one private JSON artifact.');await jobs.mcp.complete(client,mcpBinding,prepared[0].artifactId,prepared[0].artifact.bytes,mcpToolError);}
      await client.query("UPDATE platform_jobs SET status=$4,progress=100,provider_task_id=coalesce($3,provider_task_id),error_code=$5,error_message=$6,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[id,token,result.providerTaskId??null,mcpToolError?'failed':'succeeded',mcpToolError?'MCP_TOOL_ERROR':null,mcpToolError?'The MCP tool returned an error. Its private response is available for review.':null]);
      await client.query("UPDATE platform_job_attempts SET status=$3,error_code=$4,finished_at=now() WHERE job_id=$1 AND generation=$2 AND status='running'",[id,generation,mcpToolError?'failed':'succeeded',mcpToolError?'MCP_TOOL_ERROR':null]);
    });
  } catch(error) {
    // A lost COMMIT acknowledgement must not delete blobs that PostgreSQL already published.
    const published=storedKeys.length?await jobs.db.query('SELECT storage_key FROM platform_uploads WHERE storage_key=ANY($1::text[])',[storedKeys]).catch(()=>undefined):undefined;
    if(published){const retained=new Set(published.rows.map(entry=>entry.storage_key));for(const key of storedKeys)if(!retained.has(key))await jobs.storage.delete(key).catch(()=>{});}
    const safe=publicError(error);
    await jobs.db.transaction(async client=>{
      const current=await client.query('SELECT status,provider_task_id FROM platform_jobs WHERE id=$1 AND generation=$2 AND lease_token=$3 FOR UPDATE',[id,generation,token]);
      const mcpUncertain=row.kind==='mcp'&&await jobs.mcp.interrupt(client,id,generation,safe.code);
      if(!current.rowCount)return;
      const cleanupUnknown=safe.code==='CLI_CLEANUP_UNCONFIRMED';
      const relayUncertain=row.kind==='cli'&&(safe.code==='MODEL_RELAY_UNCERTAIN'||Boolean((await client.query("SELECT id FROM platform_model_relay_requests WHERE job_id=$1 AND generation=$2 AND status IN ('reserved','uncertain') LIMIT 1",[id,generation])).rowCount));
      const checkpoint=row.kind==='workflow'?(await client.query('SELECT definition_hash,revision,steps FROM platform_workflow_checkpoints WHERE job_id=$1',[id])).rows[0]:undefined;
      const workflowUncertain=row.kind==='workflow'&&(['WORKFLOW_STEP_UNCERTAIN','WORKFLOW_AUTH_REVOKED','WORKFLOW_CHECKPOINT_CONFLICT'].includes(safe.code)||!workflowCanResume(checkpoint?{definitionHash:checkpoint.definition_hash,revision:checkpoint.revision,steps:checkpoint.steps}:undefined));
      const browserUncertain=row.kind==='browser'&&await markBrowserInterrupted(client,id,generation);
      const browserHeld=row.kind==='browser'&&Boolean((await client.query("SELECT job_id FROM platform_browser_checkpoints WHERE job_id=$1 AND state='uncertain'",[id])).rowCount);
      const externallyUncertain=mcpUncertain||relayUncertain||workflowUncertain||browserUncertain||browserHeld||safe.code==='COMFYUI_SUBMISSION_UNCERTAIN'||(['PROVIDER_INTERRUPTED','PROVIDER_UNREACHABLE','JOB_LEASE_EXPIRED','JOB_APPROVAL_REVOKED'].includes(safe.code) && !current.rows[0].provider_task_id && ['openai','ark','fal','openrouter','workflow','cli','comfyui'].includes(row.provider));
      const status=cleanupUnknown||externallyUncertain?'uncertain':current.rows[0].status==='cancelled'?'cancelled':'failed';
      await client.query('UPDATE platform_jobs SET status=$3,error_code=$4,error_message=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2',[id,token,status,status==='cancelled'?null:safe.code,status==='cancelled'?null:safe.message]);
      await client.query("UPDATE platform_job_attempts SET status=$3,error_code=$4,finished_at=now() WHERE job_id=$1 AND generation=$2 AND status='running'",[id,generation,status,status==='cancelled'?null:safe.code]);
    });
  } finally { clearInterval(heartbeat); }
}
export function publicError(error: unknown): { code:string;message:string;status:number } {
  if(error && typeof error==='object' && 'publicMessage' in error && 'code' in error && 'status' in error)return {code:String(error.code),message:String(error.publicMessage),status:Number(error.status)};
  return {code:'PROVIDER_FAILED',message:'The task failed. Check provider configuration and retry when ready.',status:502};
}
export async function recoverInterrupted(jobs:JobService) {
  // Never blindly replay a call whose externally visible result is unknown.
  await jobs.db.transaction(async client=>{
    const result=await client.query("SELECT * FROM platform_jobs WHERE status IN ('running','cancelled') AND lease_token IS NOT NULL AND lease_until < now() FOR UPDATE SKIP LOCKED");
    for(const row of result.rows){
      if(row.kind==='workflow')await markWorkflowInterrupted(client,row.id,row.generation);
      if(row.kind==='browser')await markBrowserInterrupted(client,row.id,row.generation);
      if(row.kind==='mcp')await jobs.mcp.interrupt(client,row.id,row.generation,'EXECUTION_INTERRUPTED');
      let templateReady=true;
      try{validateExecutionTemplates(jobInput(row),row.execution_policy,jobs.runtime);}catch{templateReady=false;}
      const recoverable=templateReady && row.status==='running' && Boolean(row.provider_task_id) && (row.kind==='video'||(row.kind==='image'&&['fal','comfyui'].includes(row.provider)));
      const errorCode=row.kind==='cli'?'CLI_CLEANUP_UNCONFIRMED':'EXECUTION_UNCERTAIN';
      const errorMessage=row.kind==='cli'?'Execution was interrupted and container shutdown is unconfirmed. A local operator must verify cleanup.':'Execution was interrupted. Review the external result before approving a retry.';
      const renewedApproval=recoverable && row.requires_approval;
      await client.query('UPDATE platform_jobs SET status=$2,lease_token=NULL,lease_until=NULL,error_code=$3,error_message=$4,updated_at=now() WHERE id=$1',[row.id,recoverable?(renewedApproval?'needs_approval':'queued'):'uncertain',recoverable?null:errorCode,recoverable?null:errorMessage]);
      await client.query("UPDATE platform_job_attempts SET status='uncertain',error_code='EXECUTION_INTERRUPTED',finished_at=now() WHERE job_id=$1 AND status='running'",[row.id]);
      if(recoverable){
        await client.query('UPDATE platform_jobs SET generation=generation+1 WHERE id=$1',[row.id]);
        if(renewedApproval){
          await jobs.addApproval(client,row.user_id,row.id,{...jobInput(row),options:{...row.options,resumeExistingProviderTask:true}},row.generation+1);
        }else await enqueueJob(client,row.id,row.generation+1);
      }
    }
  });
}
export function createWorker(jobs:JobService) {
  return new Worker(jobs.config.queueName,async job=>{await processJob(jobs,job.data.jobId,job.data.generation,job.data.definitionHash);},
    {connection:connectionFromUrl(jobs.config.redisUrl,'worker'),concurrency:3,lockDuration:90_000,maxStalledCount:0});
}
