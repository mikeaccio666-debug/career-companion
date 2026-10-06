import {
  COVER_LETTER_ATTACHMENT_PDF_FILE_NAME,
  MISSION_COVER_LETTER_MAX_TEXT_BYTES,
  MISSION_MATERIAL_MAX_BYTES,
  parseCoverLetterPageJobV1,
  parseUuid,
  type CoverLetterPageJobV1,
} from '@edaix/contracts';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';

/**
 * 内容脚本 → worker：这一页要一封求职信（2026-09-27，负责人：申请表上有求职信栏就附上）。
 *
 * 三步，与简历附件同一个道理（`resumeAttachmentIntent.ts`）：
 * - `PREPARE`：这一页有没有可以附的信，没有就写一封。答的是那一封的 id，不带正文。页面不在岗位库里时，写信用的是
 *   内容脚本从这一页读到的职位描述（`pageJob`，纯文本、有上限；服务端只把它当写作素材）。
 * - `TEXT`：把那一封的正文交给这一页的求职信文字框。
 * - `PDF`：把那一封的 PDF 交给这一页的求职信上传栏。字节只在内核真走到那一栏时才要。
 *
 * 收件人不由内容脚本报：worker 拿 sender.url 核对过的 origin 与 pathname 自己组（页面给的东西不能证明页面）。
 * 信的正文、PDF 与职位描述只在内存里，不进日志、不进遥测、不进回执（RULE-GLOBAL-DATA-L1）。
 */
export type CoverLetterStep = 'PREPARE' | 'TEXT' | 'PDF';

export interface DockCoverLetterIntent {
  readonly kind: 'dock/cover-letter-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
  readonly step: CoverLetterStep;
  /** 只在 PREPARE：这一页写着的岗位。页面在岗位库里时服务端不读它。 */
  readonly pageJob?: CoverLetterPageJobV1;
  /** 只在 TEXT / PDF：PREPARE 答的那一封。 */
  readonly artifactId?: string;
}

const BASE_KEYS = ['kind', 'version', 'origin', 'pathname', 'step'] as const;

export function parseDockCoverLetterIntent(value: unknown): DockCoverLetterIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const step = candidate.step;
  if (step !== 'PREPARE' && step !== 'TEXT' && step !== 'PDF') return null;
  // 精确键集：每一步多一个、少一个字段都是没约定过的形状，而这条消息会走到一次带凭据的读。
  const extra = step === 'PREPARE' ? (Object.hasOwn(candidate, 'pageJob') ? ['pageJob'] : []) : ['artifactId'];
  const expected: readonly string[] = [...BASE_KEYS, ...extra];
  const keys = keysBesidesDocumentPath(value);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return null;
  if (
    candidate.kind !== 'dock/cover-letter-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  let pageJob: CoverLetterPageJobV1 | undefined;
  if (step === 'PREPARE' && Object.hasOwn(candidate, 'pageJob')) {
    const parsed = parseCoverLetterPageJobV1(candidate.pageJob);
    if (parsed === null) return null;
    pageJob = parsed;
  }
  let artifactId: string | undefined;
  if (step !== 'PREPARE') {
    const parsed = parseUuid(candidate.artifactId);
    if (parsed === null) return null;
    artifactId = parsed;
  }
  return Object.freeze({
    kind: 'dock/cover-letter-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
    step,
    ...(pageJob === undefined ? {} : { pageJob }),
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

export function createDockCoverLetterIntent(
  origin: string,
  pathname: string,
  request: Readonly<{ step: 'PREPARE'; pageJob?: CoverLetterPageJobV1 }> | Readonly<{ step: 'TEXT' | 'PDF'; artifactId: string }>,
): DockCoverLetterIntent | null {
  return parseDockCoverLetterIntent({
    kind: 'dock/cover-letter-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    ...request,
  });
}

/**
 * worker 拒绝的稳定原因。每一档在浮层上对应一句不同的话，所以不许塌缩：
 *
 * - `NEEDS_PAGE_JOB`：这一页不在岗位库里，又没读到这一页的职位描述——写不了，交还本人。
 * - `JOB_TEXT_UNUSABLE`：读到的职位描述服务端用不了（太长、像是夹带了指令……）。
 * - `PROFILE_UNAVAILABLE`：资料还不够写一封（没有保存过的资料、没有可以引用的经历）。
 * - `PAYWALL_REQUIRED` / `USAGE_EXHAUSTED`：没有写信的额度 / 这个月的次数用完了。
 * - `TARGET_NOT_ALLOWED`：运营清单不许把信交给这个网站。
 * - `NOT_FOUND`：那一封此刻不能交给这一页。
 * - `BUSY`：同一封还在写。
 */
export const COVER_LETTER_REFUSALS = [
  'NEEDS_PAGE_JOB',
  'JOB_TEXT_UNUSABLE',
  'PROFILE_UNAVAILABLE',
  'AUTH_REQUIRED',
  'PAYWALL_REQUIRED',
  'USAGE_EXHAUSTED',
  'TARGET_NOT_ALLOWED',
  'NOT_FOUND',
  'BUSY',
  'UNAVAILABLE',
] as const;
export type CoverLetterRefusal = (typeof COVER_LETTER_REFUSALS)[number];

export type DockCoverLetterReply =
  /** `generated`：这一次新写的（扣了一次）；false 是原来就有、原样交回。 */
  | Readonly<{ kind: 'COVER_LETTER_READY'; artifactId: string; generated: boolean }>
  | Readonly<{ kind: 'COVER_LETTER_TEXT'; artifactId: string; text: string }>
  | Readonly<{ kind: 'COVER_LETTER_FILE'; artifactId: string; fileName: string; size: number; bytesBase64: string }>
  | Readonly<{ kind: 'REFUSED'; code: CoverLetterRefusal }>;

const MAX_BASE64_LENGTH = Math.ceil(MISSION_MATERIAL_MAX_BYTES / 3) * 4;

export function parseDockCoverLetterReply(value: unknown): DockCoverLetterReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'REFUSED') {
    return typeof candidate.code === 'string' && (COVER_LETTER_REFUSALS as readonly string[]).includes(candidate.code)
      ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code as CoverLetterRefusal })
      : null;
  }
  const artifactId = parseUuid(candidate.artifactId);
  if (artifactId === null) return null;
  if (candidate.kind === 'COVER_LETTER_READY') {
    return typeof candidate.generated === 'boolean'
      ? Object.freeze({ kind: 'COVER_LETTER_READY' as const, artifactId, generated: candidate.generated })
      : null;
  }
  if (candidate.kind === 'COVER_LETTER_TEXT') {
    const text = candidate.text;
    return typeof text === 'string' && text.trim() !== '' && new TextEncoder().encode(text).byteLength <= MISSION_COVER_LETTER_MAX_TEXT_BYTES
      ? Object.freeze({ kind: 'COVER_LETTER_TEXT' as const, artifactId, text })
      : null;
  }
  if (candidate.kind !== 'COVER_LETTER_FILE') return null;
  const { fileName, size, bytesBase64 } = candidate;
  if (
    fileName !== COVER_LETTER_ATTACHMENT_PDF_FILE_NAME ||
    typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MISSION_MATERIAL_MAX_BYTES ||
    typeof bytesBase64 !== 'string' || bytesBase64 === '' || bytesBase64.length > MAX_BASE64_LENGTH
  ) return null;
  return Object.freeze({ kind: 'COVER_LETTER_FILE' as const, artifactId, fileName, size, bytesBase64 });
}
