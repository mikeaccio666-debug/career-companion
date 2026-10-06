/** Owner-scoped final ResumeVersion selection metadata from §4.8. */

import type {
  AgentHttpSchemaVersion,
  DecimalString,
  IsoDateTime,
  Uuid,
} from './common.ts';

export const RESUME_SELECTION_MAX_ACTIVE_TRACKS = 5 as const;

export const RESUME_SELECTION_CACHE_POLICY = Object.freeze({
  responseHeaders: Object.freeze({
    'Cache-Control': 'private, no-store, no-transform',
    Pragma: 'no-cache',
    Expires: '0',
  }),
  etag: 'forbidden',
} as const);

export interface ResumeSelectionOptionV1 {
  readonly trackId: Uuid;
  readonly trackName: string;
  readonly resumeVersionId: Uuid;
  readonly label: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly versionNumber: number;
  readonly contentRevision: DecimalString;
  readonly isDefault: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface ListResumeSelectionOptionsResponseV1 {
  readonly schemaVersion: AgentHttpSchemaVersion;
  readonly libraryRevision: DecimalString;
  readonly defaultResumeVersionId: Uuid | null;
  readonly items: readonly ResumeSelectionOptionV1[];
}

/**
 * Hostile-boundary decoder used by Portal consumers and the extension (dock, resume attachment).
 *
 * 2026-09-28：后端先发的加法（多一个字段）从前让旧包整份清单解不出——浮层说读不到简历，附件路也跟着停。
 * 现在顶层与每一条里多出来的成员不解释、不转发；认得的字段、条数上限、唯一性与默认版一致性照旧逐项校验，
 * 结果只用认得的字段重建。
 */
export function parseListResumeSelectionOptionsResponseV1(
  value: unknown,
): ListResumeSelectionOptionsResponseV1 | null {
  if (!requiredRecord(value, [
    'schemaVersion',
    'libraryRevision',
    'defaultResumeVersionId',
    'items',
  ])) return null;
  if (
    value.schemaVersion !== 1 ||
    !isDecimalString(value.libraryRevision, 9_223_372_036_854_775_807n) ||
    !(value.defaultResumeVersionId === null || isUuid(value.defaultResumeVersionId)) ||
    !Array.isArray(value.items) ||
    value.items.length > RESUME_SELECTION_MAX_ACTIVE_TRACKS
  ) return null;

  const items: ResumeSelectionOptionV1[] = [];
  for (const candidate of value.items) {
    const item = parseResumeSelectionOption(candidate);
    if (item === null) return null;
    items.push(item);
  }
  if (
    new Set(items.map((item) => item.trackId)).size !== items.length ||
    new Set(items.map((item) => item.resumeVersionId)).size !== items.length
  ) return null;
  const defaults = items.filter((item) => item.isDefault);
  if (value.defaultResumeVersionId === null) {
    if (defaults.length !== 0) return null;
  } else if (
    defaults.length !== 1 ||
    defaults[0]?.resumeVersionId !== value.defaultResumeVersionId ||
    items[0]?.resumeVersionId !== value.defaultResumeVersionId
  ) return null;

  return Object.freeze({
    schemaVersion: 1,
    libraryRevision: value.libraryRevision,
    defaultResumeVersionId: value.defaultResumeVersionId,
    items: Object.freeze(items),
  });
}

/** 一条可选的简历：认得的十二项逐项校验，多出来的成员不解释、不转发（2026-09-28），结果只用认得的重建。 */
function parseResumeSelectionOption(value: unknown): ResumeSelectionOptionV1 | null {
  if (
    !requiredRecord(value, [
      'trackId',
      'trackName',
      'resumeVersionId',
      'label',
      'fileName',
      'mimeType',
      'fileSize',
      'versionNumber',
      'contentRevision',
      'isDefault',
      'createdAt',
      'updatedAt',
    ]) ||
    !isUuid(value.trackId) ||
    !boundedText(value.trackName, 160, false) ||
    !isUuid(value.resumeVersionId) ||
    !(value.label === null || boundedText(value.label, 160, true)) ||
    !boundedText(value.fileName, 255, false) ||
    !boundedText(value.mimeType, 128, false) ||
    !boundedInteger(value.fileSize, 1, 2_147_483_647) ||
    !boundedInteger(value.versionNumber, 1, 2_147_483_647) ||
    !isDecimalString(value.contentRevision, 2_147_483_647n) ||
    typeof value.isDefault !== 'boolean' ||
    !isIsoDateTime(value.createdAt) ||
    !isIsoDateTime(value.updatedAt)
  ) return null;
  return Object.freeze({
    trackId: value.trackId,
    trackName: value.trackName,
    resumeVersionId: value.resumeVersionId,
    label: value.label,
    fileName: value.fileName,
    mimeType: value.mimeType,
    fileSize: value.fileSize,
    versionNumber: value.versionNumber,
    contentRevision: value.contentRevision,
    isDefault: value.isDefault,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

/**
 * 答复用（2026-09-28；这个文件只有答复，原先的 `exactRecord` 就此换掉）：普通 JSON 对象，认得的键一个都不能少、
 * 都得是它自己的；多出来的不拒，调用方只用认得的字段重建。`__proto__`、`constructor`、`prototype` 不是加法，一律拒。
 */
function requiredRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isIsoDateTime(value: unknown): value is IsoDateTime {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const instant = new Date(timestamp);
  return instant.getUTCFullYear() === Number(match[1]) &&
    instant.getUTCMonth() + 1 === Number(match[2]) &&
    instant.getUTCDate() === Number(match[3]) &&
    instant.getUTCHours() === Number(match[4]) &&
    instant.getUTCMinutes() === Number(match[5]) &&
    instant.getUTCSeconds() === Number(match[6]);
}

function isDecimalString(value: unknown, max: bigint): value is DecimalString {
  return typeof value === 'string' &&
    value.length <= max.toString().length &&
    /^(0|[1-9]\d*)$/.test(value) &&
    BigInt(value) <= max;
}

function boundedText(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maxLength &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
