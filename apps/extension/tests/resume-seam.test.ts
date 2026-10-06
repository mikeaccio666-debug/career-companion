// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '../lib/binaryEncoding';
import { resumeSeamFromWorker } from '../lib/resumeSeam';
import type { DockResumeAttachmentReply } from '../lib/resumeAttachmentIntent';

/**
 * 内容脚本侧的简历接缝（P1-4）。
 *
 * 钉两件事：`targetVerified` 只在 PLAN 答了之后才为真（被拒就整个不给接缝）；
 * 字节只在内核真走到简历栏、调 `resolve` 时才过桥。
 */

const PDF = new Uint8Array(new TextEncoder().encode('%PDF-1.4 fixture'));
const PLAN: DockResumeAttachmentReply = { kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'Taylor Kim.pdf', size: PDF.byteLength };
const FILE: DockResumeAttachmentReply = {
  kind: 'RESUME_ATTACHMENT_FILE', fileName: 'Taylor Kim.pdf', size: PDF.byteLength, bytesBase64: encodeBase64(PDF),
};

function asker(replies: Partial<Record<'PLAN' | 'RELEASE', DockResumeAttachmentReply | null>>) {
  const ask = vi.fn(async (step: 'PLAN' | 'RELEASE') => replies[step] ?? null);
  return ask;
}

describe('接缝只在问询成功后才存在', () => {
  it('PLAN 被拒 → 没有接缝，也不去要字节', async () => {
    const ask = asker({ PLAN: { kind: 'REFUSED', code: 'NO_RESUME' } });
    expect(await resumeSeamFromWorker(ask)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalledWith('RELEASE');
  });

  it('PLAN 没答（worker 没在）→ 没有接缝', async () => {
    expect(await resumeSeamFromWorker(asker({}))).toBeUndefined();
  });

  it('PLAN 答了 → 文件名与 targetVerified 就位，字节还没过桥', async () => {
    const ask = asker({ PLAN, RELEASE: FILE });
    const seam = await resumeSeamFromWorker(ask);
    expect(seam).toMatchObject({ fileName: 'Taylor Kim.pdf', targetVerified: true });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('resolve 才取字节', () => {
  it('RELEASE 答了 → 拼回同名、同大小的 PDF File', async () => {
    const ask = asker({ PLAN, RELEASE: FILE });
    const seam = await resumeSeamFromWorker(ask);
    const file = await seam!.resolve();
    expect(ask).toHaveBeenLastCalledWith('RELEASE');
    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe('Taylor Kim.pdf');
    expect(file?.type).toBe('application/pdf');
    expect(file?.size).toBe(PDF.byteLength);
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(PDF);
  });

  it.each([
    ['被拒', { kind: 'REFUSED', code: 'RESUME_UNAVAILABLE' } as const],
    ['没答', null],
    ['名字对不上', { ...FILE, fileName: 'Other.pdf' }],
    ['大小对不上', { ...FILE, size: PDF.byteLength + 1 }],
    ['字节数与报的大小不符', { ...FILE, bytesBase64: encodeBase64(PDF.subarray(0, 12)) }],
    ['不是 base64', { ...FILE, bytesBase64: '***' }],
  ])('RELEASE %s → 不挂（null），其余字段照常', async (_why, release) => {
    const ask = asker({ PLAN, RELEASE: release as DockResumeAttachmentReply | null });
    const seam = await resumeSeamFromWorker(ask);
    expect(await seam!.resolve()).toBeNull();
  });
});
