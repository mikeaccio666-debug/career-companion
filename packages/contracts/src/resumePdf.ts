/** T9 owner viewing/downloading a saved PDF; never an ATS attachment release. */
import {
  parseIsoDateTime,
  parseUuid,
  type DecimalString,
  type IsoDateTime,
  type Uuid,
} from './common.ts';

export const RESUME_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_PDF_IDENTITY_HEADERS = Object.freeze({
  resumeVersionId: 'X-Resume-Version-Id',
  artifactId: 'X-Resume-Artifact-Id',
  contentRevision: 'X-Resume-Content-Revision',
  libraryRevision: 'X-Resume-Library-Revision',
});

export interface ResumePdfParamsV1 {
  readonly resumeVersionId: Uuid;
}

export interface ResumePdfReadRequestV1 {
  readonly artifactId: Uuid;
  readonly expectedContentRevision: DecimalString;
  readonly expectedLibraryRevision: DecimalString;
}

export interface ResumePdfMetadataV1 {
  readonly schemaVersion: 1;
  readonly resumeVersionId: Uuid;
  readonly trackId: Uuid;
  readonly artifactId: Uuid;
  readonly contentRevision: DecimalString;
  readonly libraryRevision: DecimalString;
  readonly lifecycleStatus: 'READY';
  readonly versionNumber: number;
  readonly label: string | null;
  readonly fileName: string;
  readonly mimeType: 'application/pdf';
  readonly size: number;
  readonly createdAt: IsoDateTime;
}

export function parseResumePdfReadRequestV1(value: unknown): ResumePdfReadRequestV1 | null {
  if (!record(value, ['artifactId', 'expectedContentRevision', 'expectedLibraryRevision']) ||
    parseUuid(value.artifactId) === null || !revision(value.expectedContentRevision) ||
    !revision(value.expectedLibraryRevision)) return null;
  return value as unknown as ResumePdfReadRequestV1;
}

export function parseResumePdfMetadataV1(value: unknown): ResumePdfMetadataV1 | null {
  if (!record(value, [
    'schemaVersion', 'resumeVersionId', 'trackId', 'artifactId', 'contentRevision',
    'libraryRevision', 'lifecycleStatus', 'versionNumber', 'label', 'fileName',
    'mimeType', 'size', 'createdAt',
  ]) || value.schemaVersion !== 1 || parseUuid(value.resumeVersionId) === null ||
    parseUuid(value.trackId) === null || parseUuid(value.artifactId) === null ||
    !revision(value.contentRevision) || !revision(value.libraryRevision) ||
    value.lifecycleStatus !== 'READY' || !integer(value.versionNumber, 1, 2_147_483_647) ||
    !(value.label === null || text(value.label, 160)) || !text(value.fileName, 255) ||
    /[/\\]/.test(value.fileName) || !value.fileName.toLowerCase().endsWith('.pdf') ||
    value.mimeType !== 'application/pdf' || !integer(value.size, 12, RESUME_PDF_MAX_BYTES) ||
    parseIsoDateTime(value.createdAt) === null) return null;
  return value as unknown as ResumePdfMetadataV1;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function revision(value: unknown): boolean {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function integer(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
