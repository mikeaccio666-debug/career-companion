import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  AGENT_ERROR_DEFINITIONS,
  parseResumeAtsAttachmentPlanRequestV1,
  parseResumeAtsAttachmentPlanV1,
  parseResumeAtsAttachmentPreparedRequestV1,
  parseResumeAtsAttachmentPreparedV1,
  parseResumeAtsAttachmentReceiptV1,
  parseResumeAtsAttachmentReleaseRequestV1,
  parseResumeAtsAttachmentTargetV1,
  RESUME_ATS_ATTACHMENT_HEADERS,
  RESUME_ATS_ATTACHMENT_MAX_BYTES,
} from '../src/index.ts';

/**
 * 把简历作为附件交给雇主（T9）。本仓是这份契约的**消费者**（RULE-EXT-CONTRACT-CONSUMER）：
 * `src/resumeAtsAttachment.ts` 逐字来自 argoland `src/career-team/contracts/resumeAtsAttachment.ts`
 * （#514），下面的解析用例也是那边 `resume-ats-attachment.spec.ts` 的同一份——两仓对同一个
 * 输入必须给同一个答案，否则插件会把后端要拒的东西当成能发的。
 *
 * 唯一有意的分叉（2026-09-28）：插件读的两份答复（prepared、plan）多出来的成员不拒、不往下传，
 * 见文末「答复里多出来的成员」。请求与回执照旧与那边逐字一致。
 *
 * 契约的价值全在**拒得住**。下面每一条拒绝都对应一个真会发生的错法。
 */

const UUID_A = '2f1c8f3e-2a5b-4a1e-9d0b-1a2b3c4d5e6f';
const UUID_B = '9c7d6e5f-4a3b-42c1-8e9f-0a1b2c3d4e5f';
const UUID_C = '11111111-2222-4333-8444-555555555555';

const target = (over: Record<string, unknown> = {}) => ({
  canonicalOrigin: 'https://job-boards.greenhouse.io',
  jobId: '8586863002',
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  resumeVersionId: UUID_A,
  artifactId: UUID_B,
  expectedContentRevision: '7',
  expectedLibraryRevision: '12',
  target: target(),
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  resumeVersionId: UUID_A,
  artifactId: UUID_B,
  contentRevision: '7',
  libraryRevision: '12',
  fileName: 'Mike Chen.pdf',
  mimeType: 'application/pdf',
  size: 120_000,
  label: '后端方向',
  createdAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  releaseId: UUID_C,
  resumeVersionId: UUID_A,
  artifactId: UUID_B,
  target: target(),
  fileName: 'Mike Chen.pdf',
  size: 120_000,
  releasedAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

describe('端点登记：与 argoland 的 http.ts 同形', () => {
  it('问询是 JSON、释出是二进制，都在 §4.13、都要 bearer', () => {
    expect(AGENT_ENDPOINTS.getResumeAtsAttachmentPlan).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/resume-attachments/plan',
      sourceSection: '4.13',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer+exact-ready-version',
      successStatuses: [200],
    });
    expect(AGENT_ENDPOINTS.releaseResumeAtsAttachment).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/resume-attachments',
      sourceSection: '4.13',
      auth: 'bearer',
      responseKind: 'binary',
      callerConstraint: 'owner-bearer+exact-artifact-revision-snapshot',
      successStatuses: [200],
    });
  });

  it('失败集：与本人查看同一套版本围栏，另加收件人被运营清单拒的那一条', () => {
    expect(AGENT_ENDPOINT_ERROR_CODES.getResumeAtsAttachmentPlan).toEqual([
      'VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED',
      'AGENT_UNAVAILABLE', 'INTERNAL_ERROR',
      'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE',
      'ATTACHMENT_TARGET_NOT_ALLOWED',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.releaseResumeAtsAttachment).toEqual([
      'VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED',
      'AGENT_UNAVAILABLE', 'INTERNAL_ERROR',
      'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE',
      'LIBRARY_REVISION_MISMATCH', 'ATTACHMENT_TARGET_NOT_ALLOWED',
    ]);
  });

  // 与 ACCESS_DENIED 分开：账号完全有权，是这个收件人不许收。403 让插件能把它和
  // 付费墙／权限那一档区分开——真正该改的是清单，不是用户的权限。
  it('ATTACHMENT_TARGET_NOT_ALLOWED 是 403、不可重试、找运营', () => {
    expect(AGENT_ERROR_DEFINITIONS.ATTACHMENT_TARGET_NOT_ALLOWED).toMatchObject({
      statusCode: 403,
      retryable: false,
      requiresUserAction: true,
      recommendedAction: 'CONTACT_SUPPORT',
    });
  });

  it('回执头：身份走头、字节走 body', () => {
    expect(RESUME_ATS_ATTACHMENT_HEADERS).toEqual({
      releaseId: 'X-Resume-Release-Id',
      resumeVersionId: 'X-Resume-Version-Id',
      artifactId: 'X-Resume-Artifact-Id',
      contentRevision: 'X-Resume-Content-Revision',
      libraryRevision: 'X-Resume-Library-Revision',
    });
    expect(RESUME_ATS_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('收件人（target）', () => {
  it('规规矩矩的 origin + 岗位 id 收下', () => {
    expect(parseResumeAtsAttachmentTargetV1(target())).not.toBeNull();
  });

  // 整条 URL 进来就等于让查询串进留痕。来源追踪参数是 Data-L1 里不该走这条路的东西，
  // 而且同一个岗位会有无数写法，事后对不上账。
  it.each([
    ['带路径', 'https://job-boards.greenhouse.io/airtable/jobs/1'],
    ['带查询串', 'https://job-boards.greenhouse.io/?gh_src=abc'],
    ['带片段', 'https://job-boards.greenhouse.io/#apply'],
    ['末尾带斜杠', 'https://job-boards.greenhouse.io/'],
    ['带用户名口令', 'https://user:pw@job-boards.greenhouse.io'],
    ['明文 http', 'http://job-boards.greenhouse.io'],
    ['根本不是 URL', 'job-boards.greenhouse.io'],
  ])('%s 的 origin 一律拒', (_why, canonicalOrigin) => {
    expect(parseResumeAtsAttachmentTargetV1(target({ canonicalOrigin }))).toBeNull();
  });

  it('多一个字段就拒——多出来的形状不是我们约定过的', () => {
    expect(parseResumeAtsAttachmentTargetV1({ ...target(), extra: 1 })).toBeNull();
  });

  // 插件手势路把申请页 pathname 当岗位 id（kernelScanner 的 jobId 就是它）。
  it('岗位 id 可以是一段路径，但不能空、不能超过 512', () => {
    expect(parseResumeAtsAttachmentTargetV1(target({ jobId: '/airtable/jobs/8586863002' }))).not.toBeNull();
    expect(parseResumeAtsAttachmentTargetV1(target({ jobId: '' }))).toBeNull();
    expect(parseResumeAtsAttachmentTargetV1(target({ jobId: 'x'.repeat(513) }))).toBeNull();
  });
});

describe('问询请求（plan request）', () => {
  it('版本 + 收件人齐了才收下', () => {
    expect(parseResumeAtsAttachmentPlanRequestV1({ resumeVersionId: UUID_A, target: target() })).not.toBeNull();
  });

  it('没有收件人就拒——验证要发生在服务端，没有收件人就没东西可验', () => {
    expect(parseResumeAtsAttachmentPlanRequestV1({ resumeVersionId: UUID_A })).toBeNull();
    expect(parseResumeAtsAttachmentPlanRequestV1({ resumeVersionId: 'latest', target: target() })).toBeNull();
  });
});

describe('释出请求', () => {
  it('三个钉版本的值齐了才收下', () => {
    expect(parseResumeAtsAttachmentReleaseRequestV1(request())).not.toBeNull();
  });

  // 用户以为投的是 A 版、实际附上 B 版，比不投更糟——投出去收不回来。
  // 所以三个值任一缺失或不成形就拒，不做「取最新」的好心补救。
  it.each([
    ['缺 artifactId', { artifactId: undefined }],
    ['revision 不是十进制串', { expectedContentRevision: '0x7' }],
    ['revision 带前导零', { expectedLibraryRevision: '007' }],
    ['revision 是数字不是串', { expectedContentRevision: 7 }],
    ['resumeVersionId 不是 uuid', { resumeVersionId: 'latest' }],
  ])('%s 就拒', (_why, over) => {
    const value = request(over);
    if ((over as Record<string, unknown>).artifactId === undefined) delete (value as Record<string, unknown>).artifactId;
    expect(parseResumeAtsAttachmentReleaseRequestV1(value)).toBeNull();
  });

  // 没有目标就没有释出：释出总是释出给谁。
  it('没有收件人就拒', () => {
    const value = request();
    delete (value as Record<string, unknown>).target;
    expect(parseResumeAtsAttachmentReleaseRequestV1(value)).toBeNull();
  });

  it('收件人本身不合格，整个请求就不合格', () => {
    expect(parseResumeAtsAttachmentReleaseRequestV1(
      request({ target: target({ canonicalOrigin: 'http://x.example' }) }),
    )).toBeNull();
  });
});

describe('释出前的问询（plan）', () => {
  it('完整的收下', () => {
    expect(parseResumeAtsAttachmentPlanV1(plan())).not.toBeNull();
  });

  it('label 可以是 null', () => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ label: null }))).not.toBeNull();
  });

  // 这个名字要原样写进别人的 file input。`../` 在那边会变成什么取决于他们怎么处理
  // 上传，我们管不着，所以不发出去。
  it.each([
    ['带正斜杠', 'a/b.pdf'],
    ['带反斜杠', 'a\\b.pdf'],
    ['穿目录', '../../etc/passwd.pdf'],
    ['不是 pdf', 'resume.docx'],
    ['空名字', ''],
  ])('文件名 %s 就拒', (_why, fileName) => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ fileName }))).toBeNull();
  });

  it('大写扩展名照收——宿主不在乎大小写，我们也不该在这里卡人', () => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ fileName: 'Mike Chen.PDF' }))).not.toBeNull();
  });

  it.each([
    ['超过上限', RESUME_ATS_ATTACHMENT_MAX_BYTES + 1],
    ['小到不可能是 PDF', 11],
    ['不是整数', 1.5],
  ])('size %s 就拒', (_why, size) => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ size }))).toBeNull();
  });

  it('mimeType 只认 application/pdf', () => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ mimeType: 'application/octet-stream' }))).toBeNull();
  });

  it('schemaVersion 不是 1 就拒', () => {
    expect(parseResumeAtsAttachmentPlanV1(plan({ schemaVersion: 2 }))).toBeNull();
  });
});

describe('回执', () => {
  it('完整的收下', () => {
    expect(parseResumeAtsAttachmentReceiptV1(receipt())).not.toBeNull();
  });

  it('回执里必须写明收件人——不写明就复述不出「这份给了谁」', () => {
    const value = receipt();
    delete (value as Record<string, unknown>).target;
    expect(parseResumeAtsAttachmentReceiptV1(value)).toBeNull();
  });

  it('releaseId 不是 uuid 就拒', () => {
    expect(parseResumeAtsAttachmentReceiptV1(receipt({ releaseId: '1' }))).toBeNull();
  });

  // 回执是可以长期留存的，字节不是。任何把字节塞进回执的尝试都该被形状拒掉。
  it('回执里夹带字节就拒', () => {
    expect(parseResumeAtsAttachmentReceiptV1({ ...receipt(), bytes: 'JVBERi0=' })).toBeNull();
  });
});

/**
 * 后端先发的加法（2026-09-28）：答复多一个字段，从前旧包整份答复解不出——prepared 解不出时插件悄悄
 * 退回简历库的默认版，附上的不是为这个岗位改过的那份；plan 解不出时简历干脆附不上。现在多出来的
 * 成员不解释、不往下传；认得的字段照旧逐项校验。
 */
describe('答复里多出来的成员', () => {
  it('prepared：多一个字段照样认出为这个岗位准备的那一版，多出来的不往下传', () => {
    const prepared = parseResumeAtsAttachmentPreparedV1({
      schemaVersion: 1, resumeVersionId: UUID_A, futureField: { preparedAt: '2026-09-28T00:00:00.000Z' },
    });
    expect(prepared).toEqual({ schemaVersion: 1, resumeVersionId: UUID_A });
    expect(JSON.stringify(prepared)).not.toContain('futureField');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(parseResumeAtsAttachmentPreparedV1({ schemaVersion: 1, resumeVersionId: null, futureField: 1 }))
      .toEqual({ schemaVersion: 1, resumeVersionId: null });
  });

  it('prepared：认得的字段照旧逐项校验', () => {
    for (const bad of [
      { schemaVersion: 2, resumeVersionId: UUID_A },
      { schemaVersion: '1', resumeVersionId: UUID_A },
      { schemaVersion: 1 },
      { resumeVersionId: UUID_A },
      { schemaVersion: 1, resumeVersionId: 'latest' },
      { schemaVersion: 1, resumeVersionId: UUID_A.toUpperCase() },
      { schemaVersion: 1, resumeVersionId: 7 },
      null,
      [{ schemaVersion: 1, resumeVersionId: UUID_A }],
      'prepared',
    ]) {
      expect(parseResumeAtsAttachmentPreparedV1(bad)).toBeNull();
    }
  });

  it('plan：多一个字段照样收下，交出去的只有认得的十项', () => {
    const parsed = parseResumeAtsAttachmentPlanV1({ ...plan(), futureField: 'x', previewUrl: 'https://cdn.example/p.png' });
    expect(parsed).toEqual(plan());
    expect(JSON.stringify(parsed)).not.toContain('futureField');
    expect(JSON.stringify(parsed)).not.toContain('previewUrl');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseResumeAtsAttachmentPlanV1({ ...plan({ label: null }), futureField: 1 })).toEqual(plan({ label: null }));
  });

  it('plan：少了任何一个认得的字段照旧拒', () => {
    for (const key of Object.keys(plan())) {
      const value: Record<string, unknown> = plan();
      delete value[key];
      expect(parseResumeAtsAttachmentPlanV1({ ...value, futureField: 1 }), key).toBeNull();
    }
  });

  it('plan：认得的字段照旧逐项校验', () => {
    for (const over of [
      { schemaVersion: 2 },
      { resumeVersionId: 'latest' },
      { artifactId: UUID_A.toUpperCase() },
      { contentRevision: '07' },
      { libraryRevision: 12 },
      { fileName: '../x.pdf' },
      { mimeType: 'application/octet-stream' },
      { mimeType: 'APPLICATION/PDF' },
      { size: RESUME_ATS_ATTACHMENT_MAX_BYTES + 1 },
      { label: '' },
      { label: 'x'.repeat(161) },
      { createdAt: '2026-09-18' },
    ]) {
      expect(parseResumeAtsAttachmentPlanV1({ ...plan(over), futureField: 1 }), JSON.stringify(over)).toBeNull();
    }
  });

  it('答复仍须是普通 JSON 对象；原型链上的名字当成员一律拒', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(parseResumeAtsAttachmentPreparedV1(JSON.parse(`{"schemaVersion":1,"resumeVersionId":null,"${key}":{}}`))).toBeNull();
      expect(parseResumeAtsAttachmentPlanV1(JSON.parse(`{${JSON.stringify(plan()).slice(1, -1)},"${key}":{}}`))).toBeNull();
    }
    expect(parseResumeAtsAttachmentPlanV1(Object.assign(Object.create({ inherited: true }), plan()))).toBeNull();
    expect(parseResumeAtsAttachmentPlanV1(Object.assign(Object.create(null), plan()))).toEqual(plan());
  });

  // 放宽的只是插件读的答复；插件发出去的请求与回执照旧多一个字段就拒。
  it('请求与回执不放宽', () => {
    expect(parseResumeAtsAttachmentPlanRequestV1({ resumeVersionId: UUID_A, target: target(), extra: 1 })).toBeNull();
    expect(parseResumeAtsAttachmentPreparedRequestV1({ target: target(), extra: 1 })).toBeNull();
    expect(parseResumeAtsAttachmentReleaseRequestV1({ ...request(), extra: 1 })).toBeNull();
    expect(parseResumeAtsAttachmentReceiptV1({ ...receipt(), extra: 1 })).toBeNull();
  });
});
