import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import type { ComfyUITemplateSnapshot, ExecutionTemplateBinding } from '@companion/platform-contracts';
import { ProviderError } from './errors.ts';
import { workflowHash } from './json-hash.ts';

const MAX_TEMPLATE_BYTES = 256 * 1024;
export type ComfyUIOutputKind = 'image' | 'video';
type ReviewedComfyUITemplate = ComfyUITemplateSnapshot & { outputKind: ComfyUIOutputKind };
export function configuredComfyUIOutputKind(env: NodeJS.ProcessEnv): ComfyUIOutputKind | undefined {
  return env.COMFYUI_OUTPUT_KIND === 'image' || env.COMFYUI_OUTPUT_KIND === 'video' ? env.COMFYUI_OUTPUT_KIND : undefined;
}
const invalidTemplate = () => new ProviderError('INVALID_COMFYUI_TEMPLATE', 'Configure a valid server-reviewed ComfyUI API workflow, output kind and prompt input, then restart the services.', 503);
const invalidSnapshot = () => new ProviderError('COMFYUI_TEMPLATE_SNAPSHOT_INVALID', 'The saved generation template does not match its reviewed version. Prepare a new task.', 409);
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function parseExecutionTemplateBinding(value: unknown): ExecutionTemplateBinding {
  if (!plain(value) || Object.keys(value).some(key => !['version', 'hash'].includes(key)) || value.version !== 1 || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash))
    throw new ProviderError('COMFYUI_TEMPLATE_BINDING_INVALID', 'Use the generation template version supplied by the server.', 400);
  return { version: 1, hash: value.hash };
}
function baseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 2048) throw invalidSnapshot();
  let url: URL; try { url = new URL(value); } catch { throw invalidSnapshot(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalidSnapshot();
  return url.toString().replace(/\/$/, '');
}
function body(value: unknown, allowHistoricalWithoutOutputKind = false): Omit<ComfyUITemplateSnapshot, 'hash'> {
  if (!plain(value) || Object.keys(value).some(key => !['version', 'hash', 'baseUrl', 'promptNode', 'promptField', 'graph', 'outputKind'].includes(key)) || value.version !== 1 || !plain(value.graph) ||
      value.outputKind !== 'image' && value.outputKind !== 'video' && !(allowHistoricalWithoutOutputKind && !Object.hasOwn(value, 'outputKind'))) throw invalidSnapshot();
  const promptNode = value.promptNode, promptField = value.promptField;
  if (typeof promptNode !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(promptNode) || typeof promptField !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(promptField) || ['__proto__', 'constructor', 'prototype'].includes(promptNode) || ['__proto__', 'constructor', 'prototype'].includes(promptField)) throw invalidSnapshot();
  const graph = value.graph, nodes = Object.entries(graph);
  if (!nodes.length || nodes.length > 1000) throw invalidSnapshot();
  for (const [id, node] of nodes) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !plain(node) || typeof node.class_type !== 'string' || !node.class_type.length || node.class_type.length > 200 || !plain(node.inputs)) throw invalidSnapshot();
  }
  const node = graph[promptNode] as Record<string, unknown>;
  if (!node || !Object.hasOwn(node.inputs as object, promptField) || typeof (node.inputs as Record<string, unknown>)[promptField] !== 'string') throw invalidSnapshot();
  // Validate bounded JSON values before cloning; no private graph or connection data is returned to a client.
  workflowHash(graph);
  if (Buffer.byteLength(JSON.stringify(graph), 'utf8') > MAX_TEMPLATE_BYTES) throw invalidSnapshot();
  return { version: 1, baseUrl: baseUrl(value.baseUrl), promptNode, promptField, ...(Object.hasOwn(value, 'outputKind') ? { outputKind: value.outputKind as ComfyUIOutputKind } : {}), graph: structuredClone(graph) };
}
export function validateComfyUITemplateSnapshot(value: unknown, binding?: ExecutionTemplateBinding): ReviewedComfyUITemplate;
export function validateComfyUITemplateSnapshot(value: unknown, binding: ExecutionTemplateBinding | undefined, options: { allowHistoricalWithoutOutputKind?: boolean }): ComfyUITemplateSnapshot;
/** Historical opt-in only checks an already completed record; runtime execution always uses the default strict form. */
export function validateComfyUITemplateSnapshot(value: unknown, binding?: ExecutionTemplateBinding, options: { allowHistoricalWithoutOutputKind?: boolean } = {}): ComfyUITemplateSnapshot {
  try {
    const checked = body(value, options.allowHistoricalWithoutOutputKind === true), actual = parseExecutionTemplateBinding(value && typeof value === 'object' ? { version: (value as any).version, hash: (value as any).hash } : value);
    const hash = workflowHash(checked);
    if (actual.hash !== hash || binding && parseExecutionTemplateBinding(binding).hash !== hash) throw invalidSnapshot();
    return { ...checked, hash };
  } catch { throw invalidSnapshot(); }
}

/** Captured once per runtime startup; executing queued jobs never rereads a mutable file. */
export function captureComfyUITemplate(env: NodeJS.ProcessEnv): ReviewedComfyUITemplate {
  let fd: number | undefined;
  try {
    if (!env.COMFYUI_BASE_URL || !env.COMFYUI_WORKFLOW_TEMPLATE || !env.COMFYUI_PROMPT_NODE || !configuredComfyUIOutputKind(env)) throw invalidTemplate();
    fd = openSync(env.COMFYUI_WORKFLOW_TEMPLATE, 'r');
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TEMPLATE_BYTES) throw invalidTemplate();
    const bytes = Buffer.alloc(MAX_TEMPLATE_BYTES + 1); let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    if (!count || count > MAX_TEMPLATE_BYTES) throw invalidTemplate();
    const graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
    const checked = body({ version: 1, baseUrl: env.COMFYUI_BASE_URL, promptNode: env.COMFYUI_PROMPT_NODE, promptField: env.COMFYUI_PROMPT_FIELD || 'text', outputKind: configuredComfyUIOutputKind(env), graph });
    return { ...checked, outputKind: configuredComfyUIOutputKind(env)!, hash: workflowHash(checked) };
  } catch { throw invalidTemplate(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function checkComfyUIServer(snapshot: ComfyUITemplateSnapshot, env: NodeJS.ProcessEnv): void {
  let current: string; try { current = baseUrl(env.COMFYUI_BASE_URL); } catch { throw new ProviderError('COMFYUI_SERVER_CHANGED', 'The generation server changed. Prepare a new reviewed task for the current server.', 409); }
  if (snapshot.baseUrl !== current) throw new ProviderError('COMFYUI_SERVER_CHANGED', 'The generation server changed. Prepare a new reviewed task for the current server.', 409);
}
