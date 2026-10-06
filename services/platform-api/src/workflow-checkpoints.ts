import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { CreateJobInput, JobExecutionResult, ProviderAttachment, WorkflowArtifactRef, WorkflowCheckpoint, WorkflowCheckpointEvent, WorkflowStep, WorkflowStepCheckpoint } from '@companion/platform-contracts';
import { validateMediaReferenceBinding, workflowDefinitionHash } from '@companion/ai-core';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, invalid, notFound } from './errors.ts';
import { parseWorkflowTemplate } from './workflow-templates.ts';
import { validateExecutionTemplates } from './execution-templates.ts';

export interface WorkflowBinding { jobId: string; userId: string; generation: number; leaseToken: string; definitionHash: string; signal: AbortSignal; }
const MAX_TEXT_BYTES = 512 * 1024, MAX_ARTIFACT_BYTES = 100 * 1024 * 1024, MAX_RESULT_BYTES = 200 * 1024 * 1024;
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function normalizeWorkflowInput(input: CreateJobInput, providers: ReturnType<import('@companion/platform-contracts').PlatformProviderRuntime['capabilities']>): CreateJobInput {
  if (input.provider !== 'workflow' || input.attachmentIds?.length) throw invalid('Workflows use explicit steps and references to their own completed image results.');
  if (Object.keys(input.options ?? {}).some(key => key !== 'steps')) throw invalid('Unsupported workflow task option.');
  const steps = parseWorkflowTemplate({ name: 'Execution plan', steps: input.options?.steps }).steps.map(step => {
    const provider = providers.find(provider => provider.id === step.provider);
    if (!provider || !provider.enabled || !provider.capabilities.includes(step.kind)) throw new ApiError(503, 'WORKFLOW_PROVIDER_UNAVAILABLE', `Configure the provider for the ${step.kind} step before creating this workflow task.`);
    const model = step.model || (provider.modelsByCapability ? provider.modelsByCapability[step.kind]?.[0] : provider.models[0]);
    if (!model && step.provider !== 'comfyui') throw invalid(`Select an explicit model for the ${step.kind} step.`);
    if(step.kind==='image'||step.kind==='video')validateMediaReferenceBinding(step.provider,step.kind,step.options??{},step.referenceImages?.length??0);
    return { ...step, ...(model ? { model } : {}) };
  });
  return { ...input, model: undefined, options: { steps } };
}

export async function initializeWorkflowCheckpoint(client: PoolClient, jobId: string, input: CreateJobInput) {
  await client.query('INSERT INTO platform_workflow_checkpoints(job_id,definition_hash) VALUES($1,$2)', [jobId, workflowDefinitionHash(input)]);
}
function snapshot(row: any): WorkflowCheckpoint { return { definitionHash: row.definition_hash, revision: row.revision, steps: row.steps }; }

async function authorize(client: PoolClient | Database, binding: WorkflowBinding, lock = false) {
  binding.signal.throwIfAborted();
  const result = await client.query(`SELECT j.*,c.definition_hash,c.revision,c.steps AS checkpoint_steps FROM platform_jobs j JOIN platform_workflow_checkpoints c ON c.job_id=j.id WHERE j.id=$1 AND j.user_id=$2 AND j.generation=$3 AND j.lease_token=$4 AND j.lease_until>now() AND j.status='running' AND j.kind='workflow' AND j.provider='workflow' AND j.requires_approval AND EXISTS(SELECT 1 FROM platform_approvals a WHERE a.job_id=j.id AND a.user_id=j.user_id AND a.generation=j.generation AND a.status='approved' AND a.args->>'workflowDefinitionHash'=c.definition_hash)${lock ? ' FOR UPDATE OF j,c' : ''}`, [binding.jobId, binding.userId, binding.generation, binding.leaseToken]);
  if (!result.rowCount) throw new ApiError(409, 'WORKFLOW_AUTH_REVOKED', 'This workflow is no longer authorized to execute.');
  const row = result.rows[0];
  const definitionHash = workflowDefinitionHash({ kind: 'workflow', provider: 'workflow', prompt: row.prompt, options: row.options });
  if (row.definition_hash !== binding.definitionHash || definitionHash !== binding.definitionHash) throw new ApiError(409, 'WORKFLOW_DEFINITION_CHANGED', 'The reviewed workflow definition changed. Create another reviewed task.');
  validateExecutionTemplates({kind:'workflow',provider:'workflow',prompt:row.prompt,options:row.options},row.execution_policy);
  return row;
}

export async function loadWorkflowCheckpoint(db: Database, binding: WorkflowBinding): Promise<WorkflowCheckpoint> {
  const row = await authorize(db, binding);
  return { definitionHash: row.definition_hash, revision: row.revision, steps: row.checkpoint_steps };
}
function eventInput(event: WorkflowCheckpointEvent, steps: WorkflowStep[]) {
  if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index >= steps.length || !Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0 || !hashValid(event.inputHash)) throw invalid('Invalid workflow checkpoint transition.');
  if (event.type === 'provider_task' && (typeof event.providerTaskId !== 'string' || !event.providerTaskId.length || event.providerTaskId.length > 4096 || /[\u0000-\u001f\u007f]/.test(event.providerTaskId))) throw invalid('Invalid workflow provider task identifier.');
  if(event.type==='provider_task'){
    const step=steps[event.index],resumable=step.kind==='video'&&step.provider==='ark'||['image','video'].includes(step.kind)&&['fal','comfyui'].includes(step.provider);
    if(!resumable)throw invalid('This workflow provider cannot resume an asynchronous step.');
  }
  if ((event.type === 'failed' || event.type === 'uncertain') && !/^[A-Z][A-Z0-9_]{0,99}$/.test(event.errorCode)) throw invalid('Invalid workflow checkpoint error code.');
}

export function workflowCanResume(checkpoint: WorkflowCheckpoint | undefined): boolean {
  return !!checkpoint && !checkpoint.steps.some(step => (step.state === 'started' || step.state === 'uncertain') && !step.providerTaskId);
}

export async function markWorkflowInterrupted(client: PoolClient, jobId: string, generation: number) {
  const found=await client.query('SELECT * FROM platform_workflow_checkpoints WHERE job_id=$1 FOR UPDATE',[jobId]);
  if(!found.rowCount)return;
  const row=found.rows[0],steps:WorkflowStepCheckpoint[]=row.steps;let revision=row.revision;
  for(const step of steps){
    if(step.state!=='started'||step.providerTaskId)continue;
    step.state='uncertain';step.errorCode='EXECUTION_INTERRUPTED';revision++;
    await client.query("INSERT INTO platform_workflow_step_ledger(job_id,revision,generation,step_index,input_hash,event_type,error_code) VALUES($1,$2,$3,$4,$5,'uncertain','EXECUTION_INTERRUPTED')",[jobId,revision,generation,step.index,step.inputHash]);
  }
  if(revision!==row.revision)await client.query('UPDATE platform_workflow_checkpoints SET steps=$2,revision=$3,updated_at=now() WHERE job_id=$1',[jobId,JSON.stringify(steps),revision]);
}

async function persistMaterials(db: Database, storage: BlobStorage, binding: WorkflowBinding, result: JobExecutionResult) {
  const text = result.text ?? '';
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new ApiError(413, 'WORKFLOW_RESULT_TOO_LARGE', 'The workflow text result exceeds its checkpoint limit.');
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 8) throw invalid('At most eight artifacts may be saved for one workflow step.');
  let total = 0;
  const files: { key: string; uploadId: string; artifactId: string; name: string; mime: string; bytes: Uint8Array }[] = [];
  try {
    for (const artifact of result.artifacts) {
      if (!(artifact.bytes instanceof Uint8Array) || !artifact.bytes.length || artifact.bytes.byteLength > MAX_ARTIFACT_BYTES || (total += artifact.bytes.byteLength) > MAX_RESULT_BYTES) throw new ApiError(413, 'WORKFLOW_RESULT_TOO_LARGE', 'The workflow artifacts exceed their checkpoint limits.');
      const name = path.basename(String(artifact.name).replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'workflow-result';
      const mime = String(artifact.mime).split(';')[0].trim();
      if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime)) throw invalid('Invalid workflow artifact media type.');
      binding.signal.throwIfAborted();
      const file = { key: randomUUID(), uploadId: randomUUID(), artifactId: randomUUID(), name, mime, bytes: artifact.bytes };
      files.push(file); await storage.put(file.key, file.bytes, file.mime);
    }
    return { text, hasText: result.text!==undefined, files };
  } catch (error) { await discardUnpublished(db, storage, files.map(file => file.key)); throw error; }
}
async function discardUnpublished(db: Database, storage: BlobStorage, keys: string[]) {
  if (!keys.length) return;
  const retained = await db.query('SELECT storage_key FROM platform_uploads WHERE storage_key=ANY($1::text[])', [keys]).catch(() => undefined);
  if (!retained) return; // An unknown COMMIT result is not permission to delete a published file.
  const published = new Set(retained.rows.map(row => row.storage_key));
  for (const key of keys) if (!published.has(key)) await storage.delete(key).catch(() => {});
}

export async function applyWorkflowCheckpoint(db: Database, storage: BlobStorage, binding: WorkflowBinding, event: WorkflowCheckpointEvent): Promise<WorkflowCheckpoint> {
  const authorized = await authorize(db, binding);
  const plan: WorkflowStep[] = authorized.options.steps;
  eventInput(event, plan);
  // Validate lease/revision again after storing private bytes, before publishing their references.
  const materials = event.type === 'completed' ? await persistMaterials(db, storage, binding, event.result) : undefined;
  try {
    return await db.transaction(async client => {
      const row = await authorize(client, binding, true);
      if (row.revision !== event.expectedRevision) throw new ApiError(409, 'WORKFLOW_CHECKPOINT_CONFLICT', 'The workflow checkpoint advanced in another execution.');
      const checkpoints: WorkflowStepCheckpoint[] = row.checkpoint_steps;
      const current = checkpoints.find(step => step.index === event.index);
      if (current && current.inputHash !== event.inputHash) throw new ApiError(409, 'WORKFLOW_INPUT_CHANGED', 'This step no longer matches its recorded inputs.');
      if (checkpoints.some(step => step.index < event.index && step.state !== 'completed') || event.index > 0 && !checkpoints.some(step => step.index === event.index - 1 && step.state === 'completed')) throw new ApiError(409, 'WORKFLOW_STEP_ORDER', 'Complete earlier workflow steps before starting this step.');
      if (current?.state === 'completed') throw new ApiError(409, 'WORKFLOW_STEP_COMPLETE', 'A completed workflow step cannot be executed again.');
      if (event.type === 'started') {
        if (current && current.state !== 'failed') throw new ApiError(409, 'WORKFLOW_REVIEW_REQUIRED', 'This step already started; reconcile its existing result before another model call.');
        if (current) {
          const prior = await client.query("SELECT max(generation)::integer AS generation FROM platform_workflow_step_ledger WHERE job_id=$1 AND step_index=$2 AND event_type='started'", [binding.jobId, event.index]);
          if (Number(prior.rows[0].generation) >= binding.generation) throw new ApiError(409, 'WORKFLOW_REVIEW_REQUIRED', 'A failed workflow step requires a new reviewed task attempt.');
        }
      } else if (!current || !(['started', 'provider_task'].includes(current.state) || current.state==='uncertain' && current.providerTaskId && ['provider_task','completed','failed'].includes(event.type))) throw new ApiError(409, 'WORKFLOW_TRANSITION_INVALID', 'The workflow step has no matching active checkpoint.');
      if (event.type === 'provider_task' && current?.providerTaskId && current.providerTaskId !== event.providerTaskId) throw new ApiError(409, 'WORKFLOW_PROVIDER_TASK_CHANGED', 'The existing provider task cannot be silently replaced.');
      const refs: WorkflowArtifactRef[] = [];
      if (materials) for (const file of materials.files) {
        await client.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [file.uploadId, binding.userId, file.name, file.mime, file.bytes.byteLength, file.key]);
        await client.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [file.artifactId, binding.userId, binding.jobId, plan[event.index].kind, file.mime, file.name, file.uploadId, JSON.stringify({ workflowStep: event.index, definitionHash: binding.definitionHash, partialCompleted: true })]);
        refs.push({ attachmentId: file.uploadId, name: file.name, mime: file.mime, size: file.bytes.byteLength });
      }
      const next: WorkflowStepCheckpoint = { index: event.index, inputHash: event.inputHash, state: event.type === 'completed' ? 'completed' : event.type === 'provider_task' ? 'provider_task' : event.type,
        ...(event.type === 'started' ? {} : { ...(current?.providerTaskId ? { providerTaskId: current.providerTaskId } : {}) }),
        ...(event.type === 'provider_task' ? { providerTaskId: event.providerTaskId } : {}), ...(materials ? { ...(materials.hasText ? { text: materials.text } : {}), artifacts: refs } : {}),
        ...(event.type === 'failed' || event.type === 'uncertain' ? { errorCode: event.errorCode } : {}) };
      const steps = checkpoints.filter(step => step.index !== event.index).concat(next).sort((a, b) => a.index - b.index);
      const revision = row.revision + 1;
      const saved = await client.query('UPDATE platform_workflow_checkpoints SET steps=$2,revision=$3,updated_at=now() WHERE job_id=$1 AND revision=$4 RETURNING *', [binding.jobId, JSON.stringify(steps), revision, event.expectedRevision]);
      if (!saved.rowCount) throw new ApiError(409, 'WORKFLOW_CHECKPOINT_CONFLICT', 'The workflow checkpoint advanced in another execution.');
      await client.query('INSERT INTO platform_workflow_step_ledger(job_id,revision,generation,step_index,input_hash,event_type,provider_task_id,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [binding.jobId, revision, binding.generation, event.index, event.inputHash, event.type, next.providerTaskId ?? current?.providerTaskId ?? null, next.errorCode ?? null]);
      await client.query('UPDATE platform_jobs SET progress=$2,updated_at=now() WHERE id=$1', [binding.jobId, Math.round(steps.filter(step => step.state === 'completed').length / plan.length * 95)]);
      return snapshot(saved.rows[0]);
    });
  } catch (error) { if (materials) await discardUnpublished(db, storage, materials.files.map(file => file.key)); throw error; }
}

export async function readWorkflowArtifact(db: Database, storage: BlobStorage, binding: WorkflowBinding, attachmentId: string): Promise<ProviderAttachment> {
  const row = await authorize(db, binding);
  if (!row.checkpoint_steps.some((step: WorkflowStepCheckpoint) => step.state === 'completed' && step.artifacts?.some(artifact => artifact.attachmentId === attachmentId))) throw notFound();
  const upload = await db.query('SELECT u.* FROM platform_uploads u JOIN platform_artifacts a ON a.upload_id=u.id WHERE u.id=$1 AND u.user_id=$2 AND a.user_id=$2 AND a.job_id=$3', [attachmentId, binding.userId, binding.jobId]);
  if (!upload.rowCount) throw notFound();
  const file = upload.rows[0]; return { name: file.filename, mime: file.mime, bytes: await storage.get(file.storage_key) };
}
