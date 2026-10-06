import { randomUUID } from 'node:crypto';
import type { WorkflowStep, WorkflowTemplate, WorkflowTemplateInput } from '@companion/platform-contracts';
import { validateMediaReferenceBinding, parseExecutionTemplateBinding } from '@companion/ai-core';
import type { Database } from './database.ts';
import { ApiError, invalid, notFound, object, string } from './errors.ts';

export const WORKFLOW_TEMPLATE_BYTES = 128 * 1024;
const maxTemplates = 100;
const inputFields = new Set(['name', 'description', 'steps']);
const stepFields = new Set(['kind', 'provider', 'model', 'prompt', 'options', 'referenceImages', 'executionTemplate']);
const optionFields: Record<WorkflowStep['kind'], Set<string>> = {
  chat: new Set(), image: new Set(['aspectRatio', 'input', 'referenceMode', 'referenceField']),
  video: new Set(['aspectRatio', 'duration', 'seed', 'resolution', 'input', 'referenceMode', 'referenceField']), speech: new Set(['voice']),
};
const forbiddenKeys = new Set(['apikey', 'authorization', 'accesstoken', 'refreshtoken', 'token', 'secret', 'password', 'credentials', 'cookie', 'cookies', 'headers', 'baseurl', 'endpoint', 'webhookurl', 'callbackurl']);

function jsonOptions(value: unknown, depth = 0, counter = { count: 0 }): void {
  if (++counter.count > 2000 || depth > 6) throw invalid('Workflow options are too deeply nested or contain too many values.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid('Workflow options require finite numbers.'); return; }
  if (Array.isArray(value)) { for (const item of value) jsonOptions(item, depth + 1, counter); return; }
  if (!value || typeof value !== 'object') throw invalid('Workflow options must use JSON values.');
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['__proto__', 'prototype', 'constructor'].includes(key) || forbiddenKeys.has(normalized) || /(apikey|accesstoken|refreshtoken|password|secret|credentials)$/.test(normalized)) throw invalid('Workflow templates cannot contain credentials or server connection settings.');
    jsonOptions(item, depth + 1, counter);
  }
}

export function parseWorkflowTemplate(value: unknown, update = false): WorkflowTemplateInput & { revision?: number } {
  const data = object(value);
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > WORKFLOW_TEMPLATE_BYTES) throw new ApiError(413, 'WORKFLOW_TEMPLATE_TOO_LARGE', 'Workflow templates must be at most 128 KiB.');
  if (Object.keys(data).some(key => !inputFields.has(key) && !(update && key === 'revision'))) throw invalid('Unsupported workflow-template field.');
  if (update && (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1)) throw invalid('A current workflow-template revision is required.');
  const name = string(data.name, 'name', 100);
  const description = data.description === undefined || data.description === '' ? '' : string(data.description, 'description', 1000);
  if (!Array.isArray(data.steps) || !data.steps.length || data.steps.length > 8) throw invalid('Workflows require between one and eight explicit steps.');
  const rawSteps = data.steps;
  const steps: WorkflowStep[] = rawSteps.map((value, index) => {
    const step = object(value);
    if (Object.keys(step).some(key => !stepFields.has(key))) throw invalid('Unsupported workflow-step field.');
    if (typeof step.kind !== 'string' || !['chat', 'image', 'video', 'speech'].includes(step.kind)) throw invalid('Unsupported workflow-step kind.');
    const kind = step.kind as WorkflowStep['kind'];
    const provider = string(step.provider, 'provider', 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) throw invalid('Use a provider identifier rather than a URL or connection setting.');
    if(step.executionTemplate!==undefined&&provider!=='comfyui')throw invalid('Only ComfyUI steps use a server execution-template binding.');
    const executionTemplate=step.executionTemplate===undefined?undefined:parseExecutionTemplateBinding(step.executionTemplate);
    const model = string(step.model, 'model', 150, false) || undefined;
    if (model && /[\u0000-\u001f\u007f]/.test(model)) throw invalid('Invalid workflow model identifier.');
    const prompt = string(step.prompt, 'prompt', 20_000);
    let options: Record<string, unknown> | undefined;
    if (step.options !== undefined) {
      options = object(step.options); jsonOptions(options);
      if (Object.keys(options).some(key => !optionFields[kind].has(key))) throw invalid(`Unsupported ${kind} step option.`);
      if (options.aspectRatio !== undefined && (typeof options.aspectRatio !== 'string' || !['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', 'adaptive'].includes(options.aspectRatio))) throw invalid('Unsupported workflow aspect ratio.');
      if (options.duration !== undefined && (typeof options.duration !== 'number' || options.duration < 2 || options.duration > 15)) throw invalid('Video duration must be between 2 and 15 seconds.');
      if (options.seed !== undefined && (typeof options.seed !== 'number' || !Number.isInteger(options.seed) || options.seed < -1 || options.seed > 2 ** 32 - 1)) throw invalid('Invalid video seed.');
      if (options.resolution !== undefined && (typeof options.resolution !== 'string' || !['480p', '720p', '1080p'].includes(options.resolution))) throw invalid('Unsupported video resolution.');
      if (options.voice !== undefined) options.voice = string(options.voice, 'voice', 100);
      if (options.input !== undefined) object(options.input);
      if (options.referenceMode !== undefined && (typeof options.referenceMode !== 'string' || !['first_frame', 'first_last_frame', 'reference_image'].includes(options.referenceMode))) throw invalid('Unsupported video reference mode.');
      if (options.referenceField !== undefined && (typeof options.referenceField !== 'string' || !['image_url', 'image_urls'].includes(options.referenceField))) throw invalid('Unsupported image reference field.');
    }
    let referenceImages: WorkflowStep['referenceImages'];
    if (step.referenceImages !== undefined) {
      if (!['image', 'video'].includes(kind) || !Array.isArray(step.referenceImages) || !step.referenceImages.length || step.referenceImages.length > 4) throw invalid('Image/video steps may reference between one and four earlier image results.');
      const seenReferences = new Set<string>();
      referenceImages = step.referenceImages.map(value => {
        const ref = object(value);
        if (Object.keys(ref).some(key => !['fromStep', 'imageIndex'].includes(key)) || !Number.isSafeInteger(ref.fromStep) || Number(ref.fromStep) < 0 || Number(ref.fromStep) >= index || rawSteps[Number(ref.fromStep)]?.kind !== 'image') throw invalid('Image references must use an earlier image step.');
        if (ref.imageIndex !== undefined && (!Number.isSafeInteger(ref.imageIndex) || Number(ref.imageIndex) < 0 || Number(ref.imageIndex) > 7)) throw invalid('Invalid image result index.');
        const key=`${ref.fromStep}:${ref.imageIndex??0}`;
        if(seenReferences.has(key))throw invalid('The same workflow image cannot be selected twice.');seenReferences.add(key);
        return { fromStep: Number(ref.fromStep), ...(ref.imageIndex !== undefined ? { imageIndex: Number(ref.imageIndex) } : {}) };
      });
    }
    if(kind==='image'||kind==='video')validateMediaReferenceBinding(provider,kind,options??{},referenceImages?.length??0);
    return { kind, provider, prompt, ...(model ? { model } : {}), ...(options ? { options } : {}), ...(referenceImages ? { referenceImages } : {}), ...(executionTemplate?{executionTemplate}:{}) };
  });
  return { name, ...(description ? { description } : {}), steps, ...(update ? { revision: Number(data.revision) } : {}) };
}

function mapTemplate(row: any): WorkflowTemplate {
  return { id: row.id, name: row.name, ...(row.description ? { description: row.description } : {}), steps: row.steps, revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

export async function listWorkflowTemplates(db: Database, userId: string): Promise<WorkflowTemplate[]> {
  const rows = await db.query('SELECT * FROM platform_workflow_templates WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT $2', [userId, maxTemplates]);
  return rows.rows.map(mapTemplate);
}

export async function createWorkflowTemplate(db: Database, userId: string, value: unknown): Promise<WorkflowTemplate> {
  const input = parseWorkflowTemplate(value);
  return db.transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-workflow-templates:' || $1::text))", [userId]);
    const count = await client.query('SELECT count(*)::integer AS count FROM platform_workflow_templates WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
    if (count.rows[0].count >= maxTemplates) throw new ApiError(413, 'WORKFLOW_TEMPLATE_LIMIT', 'At most 100 active workflow templates may be saved per user.');
    const saved = await client.query('INSERT INTO platform_workflow_templates(id,user_id,name,description,steps) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), userId, input.name, input.description ?? '', JSON.stringify(input.steps)]);
    return mapTemplate(saved.rows[0]);
  });
}

export async function updateWorkflowTemplate(db: Database, userId: string, id: string, value: unknown): Promise<WorkflowTemplate> {
  const input = parseWorkflowTemplate(value, true);
  return db.transaction(async client => {
    const current = await client.query('SELECT * FROM platform_workflow_templates WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, userId]);
    if (!current.rowCount) throw notFound();
    if (current.rows[0].revision !== input.revision) throw new ApiError(409, 'WORKFLOW_TEMPLATE_REVISION_CONFLICT', 'This template changed in another editor. Reload it before saving.');
    const saved = await client.query('UPDATE platform_workflow_templates SET name=$3,description=$4,steps=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [id, userId, input.name, input.description ?? '', JSON.stringify(input.steps)]);
    return mapTemplate(saved.rows[0]);
  });
}

export async function deleteWorkflowTemplate(db: Database, userId: string, id: string) {
  const deleted = await db.query('UPDATE platform_workflow_templates SET deleted_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id', [id, userId]);
  if (!deleted.rowCount) throw notFound();
}
