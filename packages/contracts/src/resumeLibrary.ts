/** T9 owner-scoped Resume Library metadata and category state from §4.9. */

import type {
  AgentHttpSchemaVersion,
  DecimalString,
  IsoDateTime,
  Uuid,
} from './common.ts';

export const RESUME_LIBRARY_MAX_ACTIVE_TRACKS = 5 as const;
export const RESUME_LIBRARY_MAX_TRACKS = 50 as const;
/** 100 history rows plus an older current version when it falls outside the page. */
export const RESUME_LIBRARY_MAX_VERSIONS_PER_TRACK = 101 as const;

export const RESUME_LIBRARY_CACHE_POLICY = Object.freeze({
  responseHeaders: Object.freeze({
    'Cache-Control': 'private, no-store, no-transform',
    Pragma: 'no-cache',
    Expires: '0',
  }),
  etag: 'forbidden',
} as const);

export const RESUME_LIBRARY_LIFECYCLE_STATUSES = [
  'UPLOAD_PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'ARCHIVED',
] as const;
export type ResumeLibraryLifecycleStatus =
  (typeof RESUME_LIBRARY_LIFECYCLE_STATUSES)[number];

export const RESUME_LIBRARY_VERSION_ORIGINS = [
  'UPLOAD',
  'OPTIMIZATION',
  'REWRITE',
  'CLONED',
  'MANUAL_EDIT',
] as const;
export type ResumeLibraryVersionOrigin =
  (typeof RESUME_LIBRARY_VERSION_ORIGINS)[number];

export interface ResumeLibraryVersionMetadataV1 {
  readonly resumeVersionId: Uuid;
  readonly trackId: Uuid;
  readonly label: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly versionNumber: number;
  /**
   * 已知值见 `RESUME_LIBRARY_LIFECYCLE_STATUSES`。读侧（插件）可能遇到更新的服务端加的状态
   * （2026-09-28 起不再整份拒收）：消费方只拿已知值比对，陌生状态永远不是 `READY`。
   */
  readonly lifecycleStatus: ResumeLibraryLifecycleStatus | string;
  /** 已知值见 `RESUME_LIBRARY_VERSION_ORIGINS`；读侧同上（例如将来为某个岗位改写出来的那一种）。 */
  readonly origin: ResumeLibraryVersionOrigin | string;
  /** Lineage only. Job-specific generation remains a later producer slice. */
  readonly parentVersionId: Uuid | null;
  readonly contentRevision: DecimalString;
  readonly isCurrent: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface ResumeLibraryTrackV1 {
  readonly trackId: Uuid;
  readonly name: string;
  readonly archivedAt: IsoDateTime | null;
  readonly isDefault: boolean;
  readonly currentVersionId: Uuid | null;
  readonly hasMoreVersions: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly versions: readonly ResumeLibraryVersionMetadataV1[];
}

export interface ResumeLibrarySnapshotV1 {
  readonly schemaVersion: AgentHttpSchemaVersion;
  readonly libraryRevision: DecimalString;
  readonly defaultTrackId: Uuid | null;
  readonly tracks: readonly ResumeLibraryTrackV1[];
}

export interface ResumeLibraryRevisionRequestV1 {
  readonly expectedLibraryRevision: DecimalString;
}

export interface CreateResumeTrackRequestV1 extends ResumeLibraryRevisionRequestV1 {
  readonly name: string;
}

export type RenameResumeTrackRequestV1 = CreateResumeTrackRequestV1;

export interface ArchiveResumeTrackRequestV1 extends ResumeLibraryRevisionRequestV1 {
  readonly replacementDefaultTrackId?: Uuid;
}

export interface ResumeTrackParamsV1 {
  readonly trackId: Uuid;
}

export interface ResumeTrackVersionParamsV1 extends ResumeTrackParamsV1 {
  readonly resumeVersionId: Uuid;
}

/**
 * Hostile-boundary decoder (Portal and the extension's 「我的资料」).
 *
 * 2026-09-28 起对后端先发的加法容错：任何一层多出来的成员不拒、不解释、不转发（结果从认得的字段
 * 重建）；长得像枚举的陌生来源与生命周期状态原样留着（见字段注释）。认得的字段、条数上限、唯一性、
 * 「当前版本必须 READY」「默认简历恰好一份」这些不变量一条不放松。
 */
export function parseResumeLibrarySnapshotV1(
  value: unknown,
): ResumeLibrarySnapshotV1 | null {
  if (!requiredRecord(value, [
    'schemaVersion',
    'libraryRevision',
    'defaultTrackId',
    'tracks',
  ])) return null;
  if (
    value.schemaVersion !== 1 ||
    !isDecimalString(value.libraryRevision, 9_223_372_036_854_775_807n) ||
    !(value.defaultTrackId === null || isUuid(value.defaultTrackId)) ||
    !Array.isArray(value.tracks) ||
    value.tracks.length > RESUME_LIBRARY_MAX_TRACKS ||
    !value.tracks.every(isTrack)
  ) return null;

  const tracks = value.tracks as readonly ResumeLibraryTrackV1[];
  if (new Set(tracks.map((track) => track.trackId)).size !== tracks.length) return null;
  const activeTracks = tracks.filter((track) => track.archivedAt === null);
  if (activeTracks.length > RESUME_LIBRARY_MAX_ACTIVE_TRACKS) return null;
  if ((value.defaultTrackId === null) !== (activeTracks.length === 0)) return null;
  const defaults = tracks.filter((track) => track.isDefault);
  if (value.defaultTrackId === null) {
    if (defaults.length !== 0) return null;
  } else if (
    defaults.length !== 1 ||
    defaults[0]?.trackId !== value.defaultTrackId ||
    defaults[0]?.archivedAt !== null ||
    tracks[0]?.trackId !== value.defaultTrackId
  ) return null;

  return Object.freeze({
    schemaVersion: 1,
    libraryRevision: value.libraryRevision as DecimalString,
    defaultTrackId: value.defaultTrackId as Uuid | null,
    tracks: Object.freeze(tracks.map(rebuildTrack)),
  });
}

function rebuildTrack(track: ResumeLibraryTrackV1): ResumeLibraryTrackV1 {
  return Object.freeze({
    trackId: track.trackId,
    name: track.name,
    archivedAt: track.archivedAt,
    isDefault: track.isDefault,
    currentVersionId: track.currentVersionId,
    hasMoreVersions: track.hasMoreVersions,
    createdAt: track.createdAt,
    updatedAt: track.updatedAt,
    versions: Object.freeze(track.versions.map((version) => Object.freeze({
      resumeVersionId: version.resumeVersionId,
      trackId: version.trackId,
      label: version.label,
      fileName: version.fileName,
      mimeType: version.mimeType,
      fileSize: version.fileSize,
      versionNumber: version.versionNumber,
      lifecycleStatus: version.lifecycleStatus,
      origin: version.origin,
      parentVersionId: version.parentVersionId,
      contentRevision: version.contentRevision,
      isCurrent: version.isCurrent,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    }))),
  });
}

function isTrack(value: unknown): value is ResumeLibraryTrackV1 {
  if (!requiredRecord(value, [
    'trackId',
    'name',
    'archivedAt',
    'isDefault',
    'currentVersionId',
    'hasMoreVersions',
    'createdAt',
    'updatedAt',
    'versions',
  ])) return false;
  if (
    !isUuid(value.trackId) ||
    !boundedText(value.name, 160, false) ||
    !(value.archivedAt === null || isIsoDateTime(value.archivedAt)) ||
    typeof value.isDefault !== 'boolean' ||
    !(value.currentVersionId === null || isUuid(value.currentVersionId)) ||
    typeof value.hasMoreVersions !== 'boolean' ||
    !isIsoDateTime(value.createdAt) ||
    !isIsoDateTime(value.updatedAt) ||
    !Array.isArray(value.versions) ||
    value.versions.length > RESUME_LIBRARY_MAX_VERSIONS_PER_TRACK ||
    !value.versions.every(isVersion)
  ) return false;

  const versions = value.versions as readonly ResumeLibraryVersionMetadataV1[];
  if (
    versions.some((version) => version.trackId !== value.trackId) ||
    new Set(versions.map((version) => version.resumeVersionId)).size !== versions.length ||
    (versions.length === RESUME_LIBRARY_MAX_VERSIONS_PER_TRACK &&
      !value.hasMoreVersions)
  ) return false;
  const currents = versions.filter((version) => version.isCurrent);
  return value.currentVersionId === null
    ? currents.length === 0
    : currents.length === 1 &&
        currents[0]?.resumeVersionId === value.currentVersionId &&
        currents[0]?.lifecycleStatus === 'READY';
}

function isVersion(value: unknown): value is ResumeLibraryVersionMetadataV1 {
  return requiredRecord(value, [
    'resumeVersionId',
    'trackId',
    'label',
    'fileName',
    'mimeType',
    'fileSize',
    'versionNumber',
    'lifecycleStatus',
    'origin',
    'parentVersionId',
    'contentRevision',
    'isCurrent',
    'createdAt',
    'updatedAt',
  ]) &&
    isUuid(value.resumeVersionId) &&
    isUuid(value.trackId) &&
    (value.label === null || boundedText(value.label, 160, true)) &&
    boundedText(value.fileName, 255, false) &&
    boundedText(value.mimeType, 128, false) &&
    boundedInteger(value.fileSize, 1, 2_147_483_647) &&
    boundedInteger(value.versionNumber, 1, 2_147_483_647) &&
    isEnumToken(value.lifecycleStatus) &&
    isEnumToken(value.origin) &&
    (value.parentVersionId === null || isUuid(value.parentVersionId)) &&
    !(value.parentVersionId !== null && value.parentVersionId === value.resumeVersionId) &&
    isDecimalString(value.contentRevision, 2_147_483_647n) &&
    typeof value.isCurrent === 'boolean' &&
    isIsoDateTime(value.createdAt) &&
    isIsoDateTime(value.updatedAt);
}

/** 认得的键一个都不能少；多出来的不拒（2026-09-28），也不会被转发（结果按认得的字段重建）。 */
function requiredRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return keys.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

/** 已知的枚举值，或长得像枚举（大写 token）的陌生值——后者是更新的服务端加的一种，不是坏数据。 */
function isEnumToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
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
