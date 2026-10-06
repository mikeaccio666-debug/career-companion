import { parseNormalStagingReference } from './deployment-staging-publishing.ts';
import type { StagingCutoverReference } from './deployment-cutover.ts';

export type SingleAdminHostOperation = Readonly<{
  schemaVersion: 1;
  purpose: 'staging-single-admin-operation';
  operationId: string;
  grantSha256: string;
  scopeSha256: string;
  authSchemaRelation: 'equal-to-current';
  parameterVersion: number;
  previous: StagingCutoverReference;
  candidate: StagingCutoverReference;
  approvedAt: string;
  expiresAt: string;
}>;
const fields = ['schemaVersion', 'purpose', 'operationId', 'grantSha256', 'scopeSha256', 'authSchemaRelation', 'parameterVersion',
  'previous', 'candidate', 'approvedAt', 'expiresAt'];

/** Written by the original protected operator after concrete DEP and independent Auth approvals. */
export function parseSingleAdminHostOperation(value: unknown, now = Date.now()): SingleAdminHostOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(now)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.length || !fields.every(key => Object.hasOwn(item, key))
    || item.schemaVersion !== 1 || item.purpose !== 'staging-single-admin-operation'
    || typeof item.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item.operationId)
    || item.authSchemaRelation !== 'equal-to-current'
    || !['grantSha256', 'scopeSha256'].every(key => typeof item[key] === 'string' && /^[a-f0-9]{64}$/u.test(item[key]))
    || typeof item.parameterVersion !== 'number' || !Number.isSafeInteger(item.parameterVersion) || item.parameterVersion < 1
    || typeof item.approvedAt !== 'string' || typeof item.expiresAt !== 'string') return null;
  const start = Date.parse(item.approvedAt), end = Date.parse(item.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || now >= end || end - start > 300_000
    || new Date(start).toISOString() !== item.approvedAt || new Date(end).toISOString() !== item.expiresAt) return null;
  const previous = parseNormalStagingReference(item.previous), candidate = parseNormalStagingReference(item.candidate);
  if (!previous || !candidate || previous.configurationId !== candidate.configurationId
    || previous.configurationSha256 !== candidate.configurationSha256) return null;
  return Object.freeze({ ...item, previous, candidate }) as SingleAdminHostOperation;
}
