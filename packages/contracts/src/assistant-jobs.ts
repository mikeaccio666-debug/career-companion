import { AGENT_HTTP_SCHEMA_VERSION, parseUuid, parseIsoDateTime, type AgentSchemaEnvelope, type IsoDateTime } from './common.ts';
import type { JobCardView } from './conversations.ts';
import { parseJobCardView } from './job-card.ts';
import { parseCommercialUsageResponse, type CommercialUsageView } from './commercial-usage.ts';

export const ASSISTANT_JOB_STATES = ['RECEIVED', 'SAVED', 'SKIPPED'] as const;
export type AssistantJobState = typeof ASSISTANT_JOB_STATES[number];
export interface AssistantJobsDeliveryRequest { readonly conversationId: string; readonly batchId: string }
export interface AssistantJobsQuery { readonly conversationId: string; readonly before?: string; readonly state?: AssistantJobState }
export interface AssistantJobDecisionRequest { readonly clientRequestId: string; readonly expectedRevision: number; readonly state: AssistantJobState }
export interface AssistantJobEntry {
  readonly id: string; readonly conversationId: string; readonly batchId: string; readonly itemId: string;
  readonly canonicalJobId: string; readonly revision: number; readonly state: AssistantJobState;
  readonly createdAt: IsoDateTime; readonly job: JobCardView;
}
export interface AssistantJobsResponse extends AgentSchemaEnvelope {
  readonly entries: readonly AssistantJobEntry[]; readonly nextCursor: string | null; readonly usage: CommercialUsageView;
}
export interface AssistantJobResponse extends AgentSchemaEnvelope { readonly entry: AssistantJobEntry }
export interface AssistantJobBatchesResponse extends AgentSchemaEnvelope {
  readonly batches: readonly { readonly id: string; readonly generatedAt: IsoDateTime; readonly expiresAt: IsoDateTime }[];
}
export function parseAssistantJobBatchesResponse(value: unknown): AssistantJobBatchesResponse | null {
  return exact(value,['schemaVersion','batches']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION && Array.isArray(value.batches) && value.batches.length <= 20 &&
    value.batches.every(row=>exact(row,['id','generatedAt','expiresAt']) && parseUuid(row.id) && parseIsoDateTime(row.generatedAt) && parseIsoDateTime(row.expiresAt) && String(row.expiresAt) > String(row.generatedAt)) &&
    new Set(value.batches.map(row=>row.id)).size === value.batches.length ? value as unknown as AssistantJobBatchesResponse : null;
}
export function parseAssistantJobsDeliveryRequest(value: unknown): AssistantJobsDeliveryRequest | null {
  return exact(value, ['conversationId', 'batchId']) && parseUuid(value.conversationId) && parseUuid(value.batchId)
    ? value as unknown as AssistantJobsDeliveryRequest : null;
}
export function parseAssistantJobsQuery(value: unknown): AssistantJobsQuery | null {
  return exact(value, ['conversationId'], ['before','state']) && parseUuid(value.conversationId) &&
    (value.before === undefined || parseUuid(value.before)) && (value.state === undefined || state(value.state)) ? value as unknown as AssistantJobsQuery : null;
}
export function parseAssistantJobDecisionRequest(value: unknown): AssistantJobDecisionRequest | null {
  return exact(value, ['clientRequestId','expectedRevision','state']) && parseUuid(value.clientRequestId) && positive(value.expectedRevision) && state(value.state)
    ? value as unknown as AssistantJobDecisionRequest : null;
}
export function parseAssistantJobEntry(value: unknown): AssistantJobEntry | null {
  return exact(value, ['id','conversationId','batchId','itemId','canonicalJobId','revision','state','createdAt','job']) &&
    ['id','conversationId','batchId','itemId','canonicalJobId'].every(key => parseUuid(value[key])) && positive(value.revision) &&
    state(value.state) && parseIsoDateTime(value.createdAt) && parseJobCardView(value.job) ? value as unknown as AssistantJobEntry : null;
}
export function parseAssistantJobsResponse(value: unknown): AssistantJobsResponse | null {
  if (!exact(value, ['schemaVersion','entries','nextCursor','usage']) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    !Array.isArray(value.entries) || value.entries.length > 50 || !value.entries.every(parseAssistantJobEntry) ||
    new Set(value.entries.map(entry => entry.id)).size !== value.entries.length ||
    (value.nextCursor !== null && (!parseUuid(value.nextCursor) || value.entries.at(-1)?.id !== value.nextCursor))) return null;
  const usage = parseCommercialUsageResponse({ schemaVersion: AGENT_HTTP_SCHEMA_VERSION, usage: [value.usage] })?.usage[0];
  return usage?.feature === 'jobs.delivered' ? value as unknown as AssistantJobsResponse : null;
}
export function parseAssistantJobResponse(value: unknown): AssistantJobResponse | null {
  return exact(value, ['schemaVersion','entry']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION && parseAssistantJobEntry(value.entry)
    ? value as unknown as AssistantJobResponse : null;
}
function state(value: unknown): value is AssistantJobState { return ASSISTANT_JOB_STATES.includes(value as AssistantJobState); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function exact(value: unknown, keys: string[], optional: string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && keys.every(key => Object.hasOwn(value,key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}
