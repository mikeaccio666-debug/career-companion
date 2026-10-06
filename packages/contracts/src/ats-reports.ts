import { AGENT_HTTP_SCHEMA_VERSION, parseUuid, parseIsoDateTime, type AgentSchemaEnvelope, type IsoDateTime } from './common.ts';
export const ATS_DIMENSION_KEYS = ['A','B','C','D','E','F'] as const;
export type AtsDimensionKey = typeof ATS_DIMENSION_KEYS[number];
export interface AtsDimension { readonly label: string; readonly score: number; readonly max: number; readonly problems: readonly string[] }
export interface AtsReport {
  readonly total: number; readonly max: 100; readonly dimensions: Readonly<Record<AtsDimensionKey, AtsDimension | null>>;
  readonly problems: readonly string[]; readonly suggestions: readonly string[]; readonly missingKeywords: readonly string[];
  readonly rubricVersion: string; readonly measuredAt: IsoDateTime;
}
export const ATS_REPORT_FAILURES = ['SOURCE_CHANGED','SESSION_UNAVAILABLE','USAGE_EXHAUSTED','PROVIDER_UNAVAILABLE','QUEUE_EXPIRED','RATE_LIMITED'] as const;
export type AtsReportFailure = typeof ATS_REPORT_FAILURES[number];
export interface AtsReportRequest { readonly entryId: string; readonly resumeVersionId: string }
export interface AtsReportSource {
  readonly resumeHash: string; readonly resumeRevision: number; readonly canonicalJobId: string; readonly canonicalJobRevision: string;
  readonly listingGenerationKey: string; readonly descriptionDigest: string; readonly providerIdentity: string;
}
export interface AtsReportResponse extends AgentSchemaEnvelope {
  readonly source: AtsReportSource;
  readonly id: string; readonly entryId: string; readonly resumeVersionId: string;
  readonly status: 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  readonly failureCode: AtsReportFailure | null; readonly report: AtsReport | null;
}
export interface AtsReportQuery { readonly entryId: string }
export function parseAtsReportQuery(value: unknown): AtsReportQuery | null {
  return exact(value,['entryId']) && parseUuid(value.entryId) ? value as unknown as AtsReportQuery : null;
}
export interface AtsReportLookupResponse extends AgentSchemaEnvelope {readonly report:AtsReportResponse|null}
export function parseAtsReportLookupResponse(value:unknown):AtsReportLookupResponse|null {
  return exact(value,['schemaVersion','report']) && value.schemaVersion===AGENT_HTTP_SCHEMA_VERSION && (value.report===null||parseAtsReportResponse(value.report))
    ? value as unknown as AtsReportLookupResponse:null;
}
export function parseAtsReportRequest(value: unknown): AtsReportRequest | null {
  return exact(value,['entryId','resumeVersionId']) && parseUuid(value.entryId) && parseUuid(value.resumeVersionId) ? value as unknown as AtsReportRequest : null;
}
export function parseAtsReport(value: unknown): AtsReport | null {
  if (!exact(value,['total','max','dimensions','problems','suggestions','missingKeywords','rubricVersion','measuredAt']) ||
    !score(value.total,100) || value.max !== 100 || !exact(value.dimensions,[...ATS_DIMENSION_KEYS]) ||
    !text(value.rubricVersion,64) || !/^[a-zA-Z0-9._:-]+$/.test(value.rubricVersion) || !parseIsoDateTime(value.measuredAt) ||
    !texts(value.problems) || !texts(value.suggestions) || !texts(value.missingKeywords,64,100)) return null;
  for (const key of ATS_DIMENSION_KEYS) {
    const dim = value.dimensions[key];
    if (dim !== null && (!exact(dim,['label','score','max','problems']) || !text(dim.label,120) ||
      typeof dim.max !== 'number' || !Number.isFinite(dim.max) || dim.max <= 0 || dim.max > 100 || !score(dim.score,dim.max) || !texts(dim.problems))) return null;
  }
  return value as unknown as AtsReport;
}
export function parseAtsReportResponse(value: unknown): AtsReportResponse | null {
  if (!exact(value,['schemaVersion','id','entryId','resumeVersionId','status','failureCode','report','source']) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    !parseUuid(value.id) || !parseUuid(value.entryId) || !parseUuid(value.resumeVersionId) || !parseAtsReportSource(value.source)) return null;
  if (value.status === 'SUCCEEDED') return value.failureCode === null && parseAtsReport(value.report) ? value as unknown as AtsReportResponse : null;
  if (value.report !== null) return null;
  if (value.status === 'FAILED') return ATS_REPORT_FAILURES.includes(value.failureCode as AtsReportFailure) ? value as unknown as AtsReportResponse : null;
  return (value.status === 'QUEUED' || value.status === 'PROCESSING') && value.failureCode === null ? value as unknown as AtsReportResponse : null;
}
export function parseAtsReportSource(value: unknown): AtsReportSource | null {
  return exact(value,['resumeHash','resumeRevision','canonicalJobId','canonicalJobRevision','listingGenerationKey','descriptionDigest','providerIdentity']) &&
    typeof value.resumeHash === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(value.resumeHash) && Number.isSafeInteger(value.resumeRevision) && Number(value.resumeRevision)>0 &&
    parseUuid(value.canonicalJobId) && typeof value.canonicalJobRevision === 'string' && /^[1-9][0-9]{0,18}$/.test(value.canonicalJobRevision) &&
    text(value.listingGenerationKey,256) && typeof value.descriptionDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.descriptionDigest) &&
    typeof value.providerIdentity === 'string' && /^[a-f0-9]{64}$/.test(value.providerIdentity) ? value as unknown as AtsReportSource : null;
}
function score(value: unknown,max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max; }
function text(value: unknown,max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value); }
function texts(value: unknown,maxLength = 2000,maxItems = 30): boolean { return Array.isArray(value) && value.length <= maxItems && value.every(item=>text(item,maxLength)); }
function exact(value: unknown,keys: string[]): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
}
