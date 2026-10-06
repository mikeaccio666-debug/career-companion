/**
 * T9 · 把简历作为**附件交付给雇主**。与 `resumePdf` 是两件事。
 *
 * `resumePdf` 那条路的头一行写着「never an ATS attachment release」，那句话是对的，
 * 而且必须继续对：它是**本人在自己屏幕上看自己的简历**，没有收件人、没有对外
 * 释出、不需要留痕。把它顺手拿来当附件源，等于让一次「查看」在审计上变成一次
 * 「投递」，事后谁也说不清这份文件去了哪家公司。
 *
 * 这条路是另一件事：**这一份简历，现在，交给这一个雇主的这一个岗位**。所以它比
 * 查看多要三样东西：
 *
 *  1. **收件人必须写明**（`target`）。没有目标就没有释出——释出总是释出给谁。
 *     目标同时让主机策略有地方落地：被拒的域名在这里就能拒，而不是等字节已经
 *     进了浏览器才后悔。
 *  2. **版本必须钉死**（`artifactId` + 两个 revision）。用户以为投的是 A 版，实际
 *     附上 B 版，这种错比不投更糟——投出去就收不回来了。三个值任一对不上就拒，
 *     不做「取最新」的好心补救。
 *  3. **留痕**。释出这件事本身要能被复述：哪一份、给了谁、什么时候。
 *
 * 插件那侧的占位是 CAP-AF-053：`kernelFiller.ts` 的 `resume` 接缝上写着
 * "Production has no byte source yet, so omission remains fail closed"。这份契约
 * 就是要把那个 yet 去掉。在它落地之前，真实批测里 `Attach` 那一栏是 0/63 ——
 * 单字段最大的一笔缺口。
 *
 * 提交仍然永远由用户本人点（RULE-EXT-NEVER-SUBMIT）。附上文件不是投递，
 * 只是把文件放进那一栏。
 */
import {
  parseIsoDateTime,
  parseUuid,
  type DecimalString,
  type IsoDateTime,
  type Uuid,
} from './common.ts';

/** 与 `RESUME_PDF_MAX_BYTES` 同值：同一份文件，换条路不该换上限。 */
export const RESUME_ATS_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 回执头。字节走 body，身份走头——让代理与日志在不碰 body 的前提下也能对账。
 *
 * `releaseId` 是这一次释出的名字：用户问「我给 Acme 投的是哪一版」时，能答上来的
 * 就是它。
 */
export const RESUME_ATS_ATTACHMENT_HEADERS = Object.freeze({
  releaseId: 'X-Resume-Release-Id',
  resumeVersionId: 'X-Resume-Version-Id',
  artifactId: 'X-Resume-Artifact-Id',
  contentRevision: 'X-Resume-Content-Revision',
  libraryRevision: 'X-Resume-Library-Revision',
});

/**
 * 收件人：这一次附件要交给哪一个申请页。
 *
 * 用**规范化 origin + 岗位 id**而不是整条 URL：URL 带查询串与片段，同一个岗位
 * 会有无数写法，留痕就对不上账；而且 URL 里常常挂着来源追踪参数，那是 Data-L1
 * 不该进这条路的东西。
 */
export interface ResumeAtsAttachmentTargetV1 {
  /** `https://job-boards.greenhouse.io` 这样的 origin，末尾不带斜杠。 */
  readonly canonicalOrigin: string;
  /** 厂商自己的岗位标识，取自申请页路径。 */
  readonly jobId: string;
}

/**
 * 问询也要带收件人。
 *
 * 不是为了限流，是为了让**验证发生在服务端**。插件那侧的 `targetVerified` 接缝
 * 上写着一句要紧的话：它「must never be inferred from hostname/DOM」。而手势填写
 * 这条路上的 origin 与 jobId 恰恰是从页面上读出来的——插件自己说「这个目标没问题」
 * 等于拿页面给的东西证明页面。
 *
 * 所以问询这一步就把收件人交给后端判一次：域名过得了运营清单，答复才回来。
 * 插件据此把 `targetVerified` 置真，那句话才立得住。
 */
export interface ResumeAtsAttachmentPlanRequestV1 {
  readonly resumeVersionId: Uuid;
  readonly target: ResumeAtsAttachmentTargetV1;
}

export interface ResumeAtsAttachmentReleaseRequestV1 {
  readonly resumeVersionId: Uuid;
  readonly artifactId: Uuid;
  readonly expectedContentRevision: DecimalString;
  readonly expectedLibraryRevision: DecimalString;
  readonly target: ResumeAtsAttachmentTargetV1;
}

/**
 * 释出前的一次问询：这一份现在还能不能附、附出去的文件叫什么名字。
 *
 * 分成两步是有意的。插件要在**用户按下按钮之前**就知道文件名——面板上那一行
 * 「简历.pdf → Attach」得先写出来给他看；而字节只在真的要写入那一栏时才取。
 * 合成一步的话，每开一张申请页都会从存储里拉一份 PDF 出来，白花流量，也让
 * 「取了字节」和「用了字节」在留痕上分不开。
 */
export interface ResumeAtsAttachmentPlanV1 {
  readonly schemaVersion: 1;
  readonly resumeVersionId: Uuid;
  readonly artifactId: Uuid;
  readonly contentRevision: DecimalString;
  readonly libraryRevision: DecimalString;
  /** 写进 file input 的名字。不含路径分隔符，必须以 .pdf 结尾。 */
  readonly fileName: string;
  readonly mimeType: 'application/pdf';
  readonly size: number;
  readonly label: string | null;
  readonly createdAt: IsoDateTime;
}

/** 一次释出的回执。字节不在里面——回执是可以留存的，字节不是。 */
export interface ResumeAtsAttachmentReceiptV1 {
  readonly schemaVersion: 1;
  readonly releaseId: Uuid;
  readonly resumeVersionId: Uuid;
  readonly artifactId: Uuid;
  readonly target: ResumeAtsAttachmentTargetV1;
  readonly fileName: string;
  readonly size: number;
  readonly releasedAt: IsoDateTime;
}

export function parseResumeAtsAttachmentTargetV1(
  value: unknown,
): ResumeAtsAttachmentTargetV1 | null {
  if (!record(value, ['canonicalOrigin', 'jobId'])) return null;
  if (!canonicalOrigin(value.canonicalOrigin) || !text(value.jobId, 512)) return null;
  return value as unknown as ResumeAtsAttachmentTargetV1;
}

export function parseResumeAtsAttachmentPlanRequestV1(
  value: unknown,
): ResumeAtsAttachmentPlanRequestV1 | null {
  if (!record(value, ['resumeVersionId', 'target'])) return null;
  if (
    parseUuid(value.resumeVersionId) === null ||
    parseResumeAtsAttachmentTargetV1(value.target) === null
  ) return null;
  return value as unknown as ResumeAtsAttachmentPlanRequestV1;
}

/**
 * 「这一页有没有为它准备好的简历」——只交收件人。用户在 ArgoLand 里对这个岗位
 * Start applying 之后，「申请准备」会按岗位改出一版新简历；没有 mission 的手势路
 * 从前一律附默认版，就算那一版明明存在（2026-09-21）。答案是那一版的 id，或 null
 * （页面不在目录里、或没为它准备过）——插件据此退回默认版。
 */
export interface ResumeAtsAttachmentPreparedRequestV1 {
  readonly target: ResumeAtsAttachmentTargetV1;
}

export interface ResumeAtsAttachmentPreparedV1 {
  readonly schemaVersion: 1;
  readonly resumeVersionId: Uuid | null;
}

export function parseResumeAtsAttachmentPreparedRequestV1(
  value: unknown,
): ResumeAtsAttachmentPreparedRequestV1 | null {
  if (!record(value, ['target'])) return null;
  if (parseResumeAtsAttachmentTargetV1(value.target) === null) return null;
  return value as unknown as ResumeAtsAttachmentPreparedRequestV1;
}

/**
 * 2026-09-28：后端先发的加法（多一个字段）从前让这份答复整个解不出——插件于是悄悄退回简历库的默认版，
 * 附上的不是为这个岗位改过的那一份。现在多出来的成员不解释、不转发；认得的两项照旧逐项校验，结果只用它们重建。
 */
export function parseResumeAtsAttachmentPreparedV1(
  value: unknown,
): ResumeAtsAttachmentPreparedV1 | null {
  if (!requiredRecord(value, ['schemaVersion', 'resumeVersionId'])) return null;
  if (value.schemaVersion !== 1) return null;
  if (value.resumeVersionId === null) return Object.freeze({ schemaVersion: 1, resumeVersionId: null });
  const resumeVersionId = parseUuid(value.resumeVersionId);
  return resumeVersionId === null ? null : Object.freeze({ schemaVersion: 1, resumeVersionId });
}

export function parseResumeAtsAttachmentReleaseRequestV1(
  value: unknown,
): ResumeAtsAttachmentReleaseRequestV1 | null {
  if (!record(value, [
    'resumeVersionId', 'artifactId', 'expectedContentRevision',
    'expectedLibraryRevision', 'target',
  ])) return null;
  if (
    parseUuid(value.resumeVersionId) === null ||
    parseUuid(value.artifactId) === null ||
    !revision(value.expectedContentRevision) ||
    !revision(value.expectedLibraryRevision) ||
    parseResumeAtsAttachmentTargetV1(value.target) === null
  ) return null;
  return value as unknown as ResumeAtsAttachmentReleaseRequestV1;
}

/**
 * 2026-09-28：后端先发的加法（多一个字段）从前让问询整个解不出，简历附不上；现在多出来的成员不解释、不转发。
 * 认得的十项照旧逐项校验（文件名、`application/pdf`、大小上限一样不放宽），结果只用它们重建。
 */
export function parseResumeAtsAttachmentPlanV1(
  value: unknown,
): ResumeAtsAttachmentPlanV1 | null {
  if (!requiredRecord(value, [
    'schemaVersion', 'resumeVersionId', 'artifactId', 'contentRevision',
    'libraryRevision', 'fileName', 'mimeType', 'size', 'label', 'createdAt',
  ])) return null;
  const resumeVersionId = parseUuid(value.resumeVersionId);
  const artifactId = parseUuid(value.artifactId);
  const createdAt = parseIsoDateTime(value.createdAt);
  if (
    value.schemaVersion !== 1 ||
    resumeVersionId === null ||
    artifactId === null ||
    !revision(value.contentRevision) ||
    !revision(value.libraryRevision) ||
    !attachmentFileName(value.fileName) ||
    value.mimeType !== 'application/pdf' ||
    !integer(value.size, 12, RESUME_ATS_ATTACHMENT_MAX_BYTES) ||
    !(value.label === null || text(value.label, 160)) ||
    createdAt === null
  ) return null;
  return Object.freeze({
    schemaVersion: 1,
    resumeVersionId,
    artifactId,
    contentRevision: value.contentRevision,
    libraryRevision: value.libraryRevision,
    fileName: value.fileName,
    mimeType: 'application/pdf',
    size: value.size,
    label: value.label,
    createdAt,
  });
}

export function parseResumeAtsAttachmentReceiptV1(
  value: unknown,
): ResumeAtsAttachmentReceiptV1 | null {
  if (!record(value, [
    'schemaVersion', 'releaseId', 'resumeVersionId', 'artifactId', 'target',
    'fileName', 'size', 'releasedAt',
  ])) return null;
  if (
    value.schemaVersion !== 1 ||
    parseUuid(value.releaseId) === null ||
    parseUuid(value.resumeVersionId) === null ||
    parseUuid(value.artifactId) === null ||
    parseResumeAtsAttachmentTargetV1(value.target) === null ||
    !attachmentFileName(value.fileName) ||
    !integer(value.size, 12, RESUME_ATS_ATTACHMENT_MAX_BYTES) ||
    parseIsoDateTime(value.releasedAt) === null
  ) return null;
  return value as unknown as ResumeAtsAttachmentReceiptV1;
}

/**
 * 文件名要能原样写进宿主站点的 file input。
 *
 * 路径分隔符一律拒：`../` 这类东西在别人的表单里会变成什么，取决于那个站点怎么
 * 处理上传，我们管不着，所以不发出去。
 */
function attachmentFileName(value: unknown): value is string {
  return text(value, 255) && !/[/\\]/.test(value) && value.toLowerCase().endsWith('.pdf');
}

/**
 * 只认 https 的 origin，且**不带路径、查询、片段、用户名口令**。
 *
 * 用 URL 解析再逐项比对，而不是写正则：正则版本在这类判断上历来是漏的那一个，
 * 而这条值要被当成留痕里的收件人名字长期保存。
 */
function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' &&
    url.username === '' && url.password === '' &&
    url.pathname === '/' && url.search === '' && url.hash === '' &&
    url.origin === value;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * 插件读的答复用（2026-09-28）：普通 JSON 对象，认得的键一个都不能少、都得是它自己的；多出来的不拒，
 * 调用方只用认得的字段重建结果。`__proto__`、`constructor`、`prototype` 不是加法，一律拒。
 * 请求、收件人与回执照旧用 `record`（多一个就拒）。
 */
function requiredRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function revision(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
}
