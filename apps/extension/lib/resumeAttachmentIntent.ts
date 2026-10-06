import { RESUME_ATS_ATTACHMENT_MAX_BYTES } from '@edaix/contracts';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * 手势填写路要把简历挂进这一页的 file input，向 worker 要附件（P1-4）。
 *
 * ## 为什么是两步（PLAN / RELEASE）
 *
 * 契约把「问询」和「释出」分成两个端点，理由写在 `resumeAtsAttachment.ts` 头注里：
 * 文件名要在写入前就知道（内核计划期就要 `resumeFileName`），而**字节只在真的
 * 要写那一栏时才取**——每开一张申请页就拉一份 PDF 既白花流量，也让「取了字节」
 * 与「用了字节」在留痕上分不开。所以内容脚本先 PLAN 拿到文件名与大小，把
 * `resolve` 接缝交给内核；内核走到简历栏时才 RELEASE。
 *
 * ## 这条消息不带任何值
 *
 * 与 `dock/apply-materials-intent` 同一条边界：内容脚本手上不该有 token
 * （RULE-GLOBAL-HUMAN-AUTHORIZATION、RULE-GLOBAL-DATA-L1），凭据只在 worker。
 * 收件人（`canonicalOrigin` + `jobId`）也**不由内容脚本报**：worker 拿 sender.url
 * 核对过的 origin 与 pathname 自己组——页面给的东西不能证明页面。
 * `jobId` 取 pathname，与 `kernelScanner` 的 `KernelPageScan.jobId` 同一个约定。
 *
 * ## 答复里回来的是什么
 *
 * PLAN 只回文件名与大小；RELEASE 回 base64 的字节（runtime 消息只走 JSON），
 * 内容脚本在自己的进程里拼回 `File`。字节不进任何存储、不进日志、不进回执。
 */
export type ResumeAttachmentStep = 'PLAN' | 'RELEASE';

export interface DockResumeAttachmentIntent {
  readonly kind: 'dock/resume-attachment-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
  readonly step: ResumeAttachmentStep;
}

const KEYS = ['kind', 'version', 'origin', 'pathname', 'step'] as const;

export function parseDockResumeAttachmentIntent(value: unknown): DockResumeAttachmentIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  // 精确键集：多一个字段就是一种我们没约定过的形状，而这条消息会走到一次带凭据的读。
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/resume-attachment-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string' ||
    (candidate.step !== 'PLAN' && candidate.step !== 'RELEASE')
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    kind: 'dock/resume-attachment-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
    step: candidate.step,
  });
}

export function createDockResumeAttachmentIntent(
  origin: string,
  pathname: string,
  step: ResumeAttachmentStep,
): DockResumeAttachmentIntent | null {
  return parseDockResumeAttachmentIntent({
    kind: 'dock/resume-attachment-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    step,
  });
}

/**
 * worker 拒绝的稳定原因。每一档在浮层上对应一句不同的话，所以不许塌缩：
 *
 * - `NO_RESUME`：账号里一份简历都没有——请他去上传。
 * - `RESUME_CHOICE_REQUIRED`：有好几份、没有默认——请他在门户设一份默认。
 *   宁可不附也不替他挑：附错版本比不附更糟，投出去收不回来。
 * - `TARGET_NOT_ALLOWED`：后端运营清单不许把简历交给这个域名。
 * - `RESUME_UNAVAILABLE`：这一份此刻给不出（还在渲染／版本过期／找不到）。
 */
export type ResumeAttachmentRefusal =
  | 'AUTH_REQUIRED'
  | 'PAYWALL_REQUIRED'
  | 'NO_RESUME'
  | 'RESUME_CHOICE_REQUIRED'
  | 'TARGET_NOT_ALLOWED'
  | 'RESUME_UNAVAILABLE'
  | 'UNAVAILABLE';

const REFUSALS: Readonly<Record<ResumeAttachmentRefusal, true>> = Object.freeze({
  AUTH_REQUIRED: true,
  PAYWALL_REQUIRED: true,
  NO_RESUME: true,
  RESUME_CHOICE_REQUIRED: true,
  TARGET_NOT_ALLOWED: true,
  RESUME_UNAVAILABLE: true,
  UNAVAILABLE: true,
});

export type DockResumeAttachmentReply =
  | Readonly<{ kind: 'RESUME_ATTACHMENT_PLAN'; fileName: string; size: number }>
  | Readonly<{ kind: 'RESUME_ATTACHMENT_FILE'; fileName: string; size: number; bytesBase64: string }>
  | Readonly<{ kind: 'REFUSED'; code: ResumeAttachmentRefusal }>;

const MAX_FILE_NAME_LENGTH = 255;
// base64 每 3 字节成 4 字符；上限之外的字符串根本不该拼回来。
const MAX_BASE64_LENGTH = Math.ceil(RESUME_ATS_ATTACHMENT_MAX_BYTES / 3) * 4;

/** 与契约 `attachmentFileName` 同一条判据：要能原样写进宿主的 file input。 */
function attachmentFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILE_NAME_LENGTH &&
    !/[/\\\x00-\x1f\x7f]/.test(value) && value.toLowerCase().endsWith('.pdf');
}

function attachmentSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 &&
    value <= RESUME_ATS_ATTACHMENT_MAX_BYTES;
}

export function parseDockResumeAttachmentReply(value: unknown): DockResumeAttachmentReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'REFUSED') {
    return typeof candidate.code === 'string' && Object.prototype.hasOwnProperty.call(REFUSALS, candidate.code)
      ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code as ResumeAttachmentRefusal })
      : null;
  }
  if (!attachmentFileName(candidate.fileName) || !attachmentSize(candidate.size)) return null;
  if (candidate.kind === 'RESUME_ATTACHMENT_PLAN') {
    return Object.freeze({ kind: 'RESUME_ATTACHMENT_PLAN' as const, fileName: candidate.fileName, size: candidate.size });
  }
  if (candidate.kind !== 'RESUME_ATTACHMENT_FILE') return null;
  const bytesBase64 = candidate.bytesBase64;
  if (typeof bytesBase64 !== 'string' || bytesBase64 === '' || bytesBase64.length > MAX_BASE64_LENGTH) return null;
  return Object.freeze({
    kind: 'RESUME_ATTACHMENT_FILE' as const,
    fileName: candidate.fileName,
    size: candidate.size,
    bytesBase64,
  });
}
