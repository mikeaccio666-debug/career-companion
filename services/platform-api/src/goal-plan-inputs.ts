import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ARTIFACT_TEXT_MIME_TYPES, GOAL_PLAN_RESULT_INDEX_MAX, type CreateJobInput, type GoalPlanInputSource, type GoalPlanStepInput, type GoalPlanTaskBindings, type GoalPlanTaskInput } from '@companion/platform-contracts';
import { validateMediaReferenceImages } from '@companion/ai-core';
import type { Database } from './database.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError, invalid, object } from './errors.ts';
import { readFullArtifactText } from './artifact-text.ts';
import { planBlocked } from './goal-plan-core.ts';
import { REFERENCE_IMAGE_BYTES } from './media-references.ts';

const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const textMimes = new Set<string>(ARTIFACT_TEXT_MIME_TYPES);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function fields(value: Record<string,unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('Unsupported goal-plan input binding field.'); }
function index(value: unknown, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid(`${name} must be a bounded zero-based index.`);
  return value;
}
export function parseGoalPlanTaskBindings(value: unknown): GoalPlanTaskBindings {
  const data = object(value); fields(data, ['prompt', 'referenceImages']);
  const result: GoalPlanTaskBindings = {};
  if (data.prompt !== undefined) {
    const prompt = object(data.prompt); fields(prompt, ['fromStep', 'source', 'artifactIndex', 'mode']);
    if (typeof prompt.source !== 'string' || !['analysis_text', 'artifact_text'].includes(prompt.source) || typeof prompt.mode !== 'string' || !['append', 'replace'].includes(prompt.mode)) throw invalid('Select full analysis or artifact text and append or replace mode.');
    if (prompt.source === 'analysis_text' && prompt.artifactIndex !== undefined) throw invalid('Analysis text does not have an artifact index.');
    result.prompt = { fromStep: index(prompt.fromStep, 7, 'fromStep'), source: prompt.source as 'analysis_text'|'artifact_text', mode: prompt.mode as 'append'|'replace',
      ...(prompt.artifactIndex === undefined ? {} : { artifactIndex: index(prompt.artifactIndex, GOAL_PLAN_RESULT_INDEX_MAX, 'artifactIndex') }) };
  }
  if (data.referenceImages !== undefined) {
    if (!Array.isArray(data.referenceImages) || !data.referenceImages.length || data.referenceImages.length > 4) throw invalid('Select between one and four previous-result reference images.');
    result.referenceImages = data.referenceImages.map(value => { const image = object(value); fields(image, ['fromStep', 'imageIndex']);
      return { fromStep: index(image.fromStep, 7, 'fromStep'), ...(image.imageIndex === undefined ? {} : { imageIndex: index(image.imageIndex, GOAL_PLAN_RESULT_INDEX_MAX, 'imageIndex') }) }; });
    if (new Set(result.referenceImages.map(item => `${item.fromStep}:${item.imageIndex ?? 0}`)).size !== result.referenceImages.length) throw invalid('Choose distinct previous-result reference images.');
  }
  if (!result.prompt && !result.referenceImages) throw invalid('Choose at least one explicit previous-result input binding.');
  return result;
}
export function validateGoalPlanBindings(steps: GoalPlanStepInput[]): void {
  for (const [stepIndex, step] of steps.entries()) {
    if (step.kind !== 'task' || !step.bindings) continue;
    const earlier = (fromStep: number) => { const source = steps[fromStep]; if (fromStep >= stepIndex || !source) throw invalid('Bind only an earlier step in this same plan.'); return source; };
    if (step.bindings.prompt) {
      const binding = step.bindings.prompt, source = earlier(binding.fromStep);
      if (!['image', 'video', 'speech', 'cli'].includes(step.task.kind)) throw invalid('Prompt bindings support image, video, speech and CLI tasks whose executor uses the reviewed outer prompt.');
      if (binding.source === 'analysis_text' ? source.kind !== 'agent_turn' : source.kind !== 'task' || ['browser','mcp'].includes(source.task.kind)) throw invalid('Choose an earlier analysis or an ordinary task text result; browser and MCP text require their dedicated readers.');
    }
    if (step.bindings.referenceImages) {
      if (!['image', 'video'].includes(step.task.kind)) throw invalid('Only image and video tasks accept previous-result reference images.');
      if ((step.task.attachmentIds?.length ?? 0) + step.bindings.referenceImages.length > 4) throw invalid('Static and previous-result references together may contain at most four images.');
      for (const binding of step.bindings.referenceImages) if (earlier(binding.fromStep).kind !== 'task') throw invalid('Reference images must come from an earlier task result.');
    }
  }
}
export function boundPrompt(base: string, source: string, mode: 'append'|'replace'): string {
  const prompt = mode === 'replace' ? source : `${base}\n\n${source}`;
  if (!prompt.trim() || prompt.length > 20_000) throw new ApiError(413, 'GOAL_PLAN_SOURCE_TOO_LARGE', 'The complete bound text exceeds this task’s prompt limit. Edit the plan or create a shorter source; text is never truncated.');
  return prompt;
}

/** Strong-version whole image read. The exact bytes returned, not only metadata, are pinned. */
export async function readGoalPlanImage(db: Pick<Database,'query'>, storage: BlobStorage, userId: string, attachmentId: string, signal?: AbortSignal): Promise<{name:string;mime:string;bytes:Buffer}> {
  signal?.throwIfAborted();
  const row = (await db.query('SELECT * FROM platform_uploads WHERE id=$1 AND user_id=$2', [attachmentId,userId])).rows[0];
  const size = Number(row?.byte_size);
  if (!row || !imageMimes.has(row.mime) || !Number.isSafeInteger(size) || size <= 0 || size > REFERENCE_IMAGE_BYTES) throw planBlocked('The exact saved reference image is unavailable or exceeds its byte limit.');
  const stat = await storage.stat(row.storage_key,signal);
  if (stat.size !== size || typeof stat.etag !== 'string' || !/^"[\x21\x23-\x7e]{0,200}"$/.test(stat.etag)) throw planBlocked('The saved reference image has no consistent immutable version.');
  const opened = await storage.openRead(row.storage_key,{expected:stat,signal}),stream = opened.stream;
  let cleanupError:unknown,failed=false;
  const onError=(error:unknown)=>{cleanupError=error;};stream.on('error',onError);
  const closed=stream.closed?Promise.resolve():new Promise<void>(resolve=>stream.once('close',resolve));
  try {
    if (opened.length !== size) throw planBlocked('The saved image could not be read consistently.');
    const chunks:Buffer[]=[];let total=0;
    for await (const chunk of stream) { signal?.throwIfAborted();if(!(chunk instanceof Uint8Array)||(total+=chunk.byteLength)>size)throw planBlocked('The saved image bytes no longer match their metadata.');chunks.push(Buffer.from(chunk)); }
    signal?.throwIfAborted();if(total!==size)throw planBlocked('The saved image response ended early.');
    const bytes=Buffer.concat(chunks,total);try{validateMediaReferenceImages([{name:row.filename,mime:row.mime,bytes}]);}catch{throw planBlocked('The saved image bytes no longer match their media type.');}
    return {name:row.filename,mime:row.mime,bytes};
  } catch(error) { failed=true;throw error; }
  finally { stream.destroy();await closed;stream.removeListener('error',onError);signal?.throwIfAborted();if(!failed&&cleanupError)throw planBlocked('The saved image could not be read consistently.'); }
}

/** Caller already owns user -> plan -> previous jobs/messages locks. No latest-result fallback. */
export async function resolveGoalPlanInputs(client: PoolClient, storage: BlobStorage, userId: string, step: GoalPlanTaskInput, rows: any[], signal?: AbortSignal): Promise<{input:CreateJobInput;inputSources:GoalPlanInputSource[]}> {
  let input:CreateJobInput={...step.task,...(step.task.attachmentIds===undefined?{}:{attachmentIds:[...step.task.attachmentIds]})};const inputSources:GoalPlanInputSource[]=[];
  const bindings=step.bindings;if(!bindings)return {input,inputSources};
  if(bindings.prompt){
    const binding=bindings.prompt,row=rows[binding.fromStep];let text:string;
    if(binding.source==='analysis_text'){
      if(row?.receipt?.kind!=='agent_turn'||row.message?.id!==row.receipt.messageId||row.message?.status!=='complete'||typeof row.message.content!=='string')throw planBlocked('The exact successful analysis text is unavailable.');
      text=row.message.content;inputSources.push({source:'analysis_text',fromStep:binding.fromStep,mode:binding.mode,messageId:row.message.id,sha256:digest(text),byteSize:Buffer.byteLength(text,'utf8')});
    }else{
      const artifactIndex=binding.artifactIndex??0,artifact=receiptArtifacts(row).filter(file=>textMimes.has(file.mime))[artifactIndex];
      if(!artifact)throw planBlocked('No text artifact exists at this exact receipt index.');
      await client.query('SELECT a.id FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1 AND a.user_id=$2 AND u.user_id=$2 FOR SHARE OF a,u',[artifact.id,userId]);
      const result=await readFullArtifactText(client,storage,userId,artifact.id,signal);text=result.text;
      if(result.source.jobId!==row.receipt.jobId)throw planBlocked('The saved text no longer belongs to this exact task receipt.');
      inputSources.push({source:'artifact_text',fromStep:binding.fromStep,mode:binding.mode,artifactIndex,jobId:row.receipt.jobId,generation:row.receipt.generation,artifactId:artifact.id,mime:result.source.mime,sha256:result.sha256,byteSize:result.source.size});
    }
    input.prompt=boundPrompt(input.prompt,text,binding.mode);
  }
  for(const binding of bindings.referenceImages??[]){
    const row=rows[binding.fromStep],imageIndex=binding.imageIndex??0,artifact=receiptArtifacts(row).filter(file=>imageMimes.has(file.mime))[imageIndex];
    if(!artifact)throw planBlocked('No PNG, JPEG or WebP image exists at this exact receipt index.');
    const saved=(await client.query('SELECT a.job_id,a.mime,a.upload_id,u.mime AS upload_mime FROM platform_artifacts a JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1 AND a.user_id=$2 AND u.user_id=$2 FOR SHARE OF a,u',[artifact.id,userId])).rows[0];
    if(!saved||saved.job_id!==row.receipt.jobId||saved.mime!==saved.upload_mime)throw planBlocked('The exact receipt image metadata is unavailable.');
    const image=await readGoalPlanImage(client,storage,userId,saved.upload_id,signal);(input.attachmentIds??=[]).push(saved.upload_id);
    inputSources.push({source:'reference_image',fromStep:binding.fromStep,imageIndex,jobId:row.receipt.jobId,generation:row.receipt.generation,artifactId:artifact.id,attachmentId:saved.upload_id,mime:image.mime,sha256:digest(image.bytes),byteSize:image.bytes.byteLength});
  }
  if(new Set(input.attachmentIds??[]).size!==(input.attachmentIds??[]).length)throw invalid('A static and bound image must not refer to the same private upload.');
  signal?.throwIfAborted();return {input,inputSources};
}
function receiptArtifacts(row:any):any[]{
  if(row?.receipt?.kind!=='task')throw planBlocked('This source has no exact successful task receipt.');
  const byId=new Map((row.artifacts??[]).map((file:any)=>[file.id,file]));return row.receipt.artifactIds.map((id:string)=>byId.get(id)).filter(Boolean);
}
export function assertGoalPlanImageBytes(source: Extract<GoalPlanInputSource,{source:'reference_image'}>, image:{mime:string;bytes:Uint8Array}):void{
  if(image.mime!==source.mime||image.bytes.byteLength!==source.byteSize||digest(image.bytes)!==source.sha256)throw new ApiError(409,'GOAL_PLAN_INPUT_CHANGED','The reference image bytes changed after preparation. The frozen task cannot execute with different content.');
}
export async function verifyGoalPlanImageSources(db:Pick<Database,'query'>,storage:BlobStorage,row:any,signal?:AbortSignal):Promise<void>{
  for(const source of row.execution_policy?.goalPlanInput?.inputSources??[])if(source.source==='reference_image'){
    if(!(row.attachment_ids??[]).includes(source.attachmentId))throw new ApiError(409,'GOAL_PLAN_INPUT_CHANGED','The frozen image is no longer part of this reviewed task.');
    assertGoalPlanImageBytes(source,await readGoalPlanImage(db,storage,row.user_id,source.attachmentId,signal));
  }
}
