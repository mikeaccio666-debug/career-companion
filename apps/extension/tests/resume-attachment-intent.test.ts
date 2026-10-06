import { describe, expect, it } from 'vitest';
import { RESUME_ATS_ATTACHMENT_MAX_BYTES } from '@edaix/contracts';
import {
  createDockResumeAttachmentIntent,
  parseDockResumeAttachmentIntent,
  parseDockResumeAttachmentReply,
} from '../lib/resumeAttachmentIntent';

/**
 * 手势填写路向 worker 要简历附件的那条消息（P1-4）。
 *
 * 它存在的理由与 apply-materials 那条相同：**内容脚本手上不该有 token**。消息不带
 * 凭据、不带任何值、不报收件人——只说事情发生在哪一页、要的是问询还是字节。
 */

const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;

describe('这条消息只说「在哪一页」和「要哪一步」', () => {
  it('PLAN 与 RELEASE 两步都收', () => {
    expect(createDockResumeAttachmentIntent(...PAGE, 'PLAN')).toMatchObject({
      kind: 'dock/resume-attachment-intent', origin: PAGE[0], pathname: PAGE[1], step: 'PLAN',
    });
    expect(createDockResumeAttachmentIntent(...PAGE, 'RELEASE')?.step).toBe('RELEASE');
  });

  it('精确键集：多一个字段就拒——收件人尤其不许由内容脚本另报', () => {
    const intent = createDockResumeAttachmentIntent(...PAGE, 'PLAN');
    expect(parseDockResumeAttachmentIntent({ ...intent, extra: 1 })).toBeNull();
    expect(parseDockResumeAttachmentIntent({ ...intent, canonicalOrigin: 'https://evil.example' })).toBeNull();
    expect(parseDockResumeAttachmentIntent({ ...intent, resumeVersionId: 'x' })).toBeNull();
  });

  it('少一个字段也拒', () => {
    expect(parseDockResumeAttachmentIntent({
      kind: 'dock/resume-attachment-intent', version: 1, origin: PAGE[0], pathname: PAGE[1],
    })).toBeNull();
  });

  it('不是这两步、不是这条消息，都拒', () => {
    const intent = createDockResumeAttachmentIntent(...PAGE, 'PLAN');
    expect(parseDockResumeAttachmentIntent({ ...intent, step: 'FETCH' })).toBeNull();
    expect(parseDockResumeAttachmentIntent({ ...intent, kind: 'dock/apply-materials-intent' })).toBeNull();
  });

  it('页面标识过不了 page-ready 的判据就拒（非 https 起手）', () => {
    expect(createDockResumeAttachmentIntent('http://boards.greenhouse.io', PAGE[1], 'PLAN')).toBeNull();
  });
});

describe('worker 的答复', () => {
  it('PLAN：只有文件名与大小', () => {
    expect(parseDockResumeAttachmentReply({ kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'Taylor Kim.pdf', size: 120_000 }))
      .toEqual({ kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'Taylor Kim.pdf', size: 120_000 });
  });

  it('RELEASE：文件名、大小、base64 字节三样齐了才收', () => {
    const reply = parseDockResumeAttachmentReply({
      kind: 'RESUME_ATTACHMENT_FILE', fileName: 'Taylor Kim.pdf', size: 16, bytesBase64: 'JVBERi0xLjQgZml4dHVyZQ==',
    });
    expect(reply?.kind).toBe('RESUME_ATTACHMENT_FILE');
    expect(parseDockResumeAttachmentReply({ kind: 'RESUME_ATTACHMENT_FILE', fileName: 'a.pdf', size: 16 })).toBeNull();
    expect(parseDockResumeAttachmentReply({ kind: 'RESUME_ATTACHMENT_FILE', fileName: 'a.pdf', size: 16, bytesBase64: '' })).toBeNull();
  });

  // 这个名字要原样写进宿主的 file input：与契约同一条判据。
  it.each([
    ['带路径分隔符', 'a/b.pdf'],
    ['带反斜杠', 'a\\b.pdf'],
    ['不是 pdf', 'resume.docx'],
    ['空', ''],
  ])('文件名 %s 就拒', (_why, fileName) => {
    expect(parseDockResumeAttachmentReply({ kind: 'RESUME_ATTACHMENT_PLAN', fileName, size: 16 })).toBeNull();
  });

  it.each([
    ['零', 0],
    ['超过契约上限', RESUME_ATS_ATTACHMENT_MAX_BYTES + 1],
    ['不是整数', 1.5],
  ])('大小 %s 就拒', (_why, size) => {
    expect(parseDockResumeAttachmentReply({ kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'a.pdf', size })).toBeNull();
  });

  it('REFUSED 只认那几个稳定码', () => {
    for (const code of [
      'AUTH_REQUIRED', 'PAYWALL_REQUIRED', 'NO_RESUME', 'RESUME_CHOICE_REQUIRED',
      'TARGET_NOT_ALLOWED', 'RESUME_UNAVAILABLE', 'UNAVAILABLE',
    ]) {
      expect(parseDockResumeAttachmentReply({ kind: 'REFUSED', code })).toEqual({ kind: 'REFUSED', code });
    }
    expect(parseDockResumeAttachmentReply({ kind: 'REFUSED', code: 'SOMETHING_ELSE' })).toBeNull();
    expect(parseDockResumeAttachmentReply({ kind: 'REFUSED', code: 'toString' })).toBeNull();
  });

  it('不成形的一律 null', () => {
    expect(parseDockResumeAttachmentReply(null)).toBeNull();
    expect(parseDockResumeAttachmentReply([])).toBeNull();
    expect(parseDockResumeAttachmentReply({ kind: 'RESUMES', options: [] })).toBeNull();
  });
});
