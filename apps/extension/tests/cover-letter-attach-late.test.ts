// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fillFromGesture } from '../lib/gestureFill';
import type { KernelFillAudit } from '../lib/kernelFiller';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { readApplyForm } from '@edaix/apply-kernel/registry';

installBundledApplyAdapters();

/**
 * 求职信晚到了（2026-09-27）：这一轮开填时还在写，写好的时候整轮已经结束。用一张点击凭证只写求职信那几栏——
 * 空的才写，别的栏一概不碰（kernelFiller 的 `attachCoverLetter`）。开填时就有信的，与别的栏一起写进去。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

function page(letterField: string) {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${letterField}
  </form>`;
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  return { descriptor: descriptor!, proof: proof as never };
}

function livePolicy(): ApplyPolicy {
  return { ...createBundledApplyPolicy(), notAfter: Date.now() + 60_000 };
}

const LETTER_TEXTAREA = '<label for="cl">Cover letter (optional)</label><textarea id="cl"></textarea>';
const LETTER = 'Dear hiring team,\nI would love to help Acme ship faster.';

async function run(letterField: string, coverLetter?: { text: string }) {
  const { descriptor, proof } = page(letterField);
  const audits: KernelFillAudit[] = [];
  await fillFromGesture({
    proof,
    scan: { descriptor } as never,
    profile: { firstName: 'Taylor' } as never,
    policy: livePolicy(),
    progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
    ...(coverLetter === undefined ? {} : { coverLetter }),
    onAudit: (audit: KernelFillAudit) => { audits.push(audit); },
  } as never);
  return { audit: audits[0]!, proof };
}

describe('求职信：开填时就有，与别的栏一起写', () => {
  it('可选的求职信文字框（「Cover letter (optional)」）也写上', async () => {
    await run(LETTER_TEXTAREA, { text: LETTER });
    expect((document.getElementById('cl') as HTMLTextAreaElement).value).toBe(LETTER);
    expect((document.getElementById('first_name') as HTMLInputElement).value).toBe('Taylor');
  });
});

describe('求职信晚到了：同一次点击之内只写求职信那几栏', () => {
  it('开填时没有信，那一栏空着；信到了用同一张凭证写上，单子上那一行变成已填', async () => {
    const { audit, proof } = await run(LETTER_TEXTAREA);
    const letter = document.getElementById('cl') as HTMLTextAreaElement;
    expect(letter.value).toBe('');
    const attached = await audit.attachCoverLetter!(proof, { text: LETTER });
    expect(attached).toMatchObject({ ok: true, written: 1 });
    expect(letter.value).toBe(LETTER);
    if (attached.ok) expect(attached.view.rows.find((row) => row.label.startsWith('Cover letter'))).toMatchObject({ status: 'FILLED' });
  });

  it('那一栏已经有字（用户自己写了）：一个字不写', async () => {
    const { audit, proof } = await run(LETTER_TEXTAREA);
    const letter = document.getElementById('cl') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(letter, 'My own letter');
    expect(await audit.attachCoverLetter!(proof, { text: LETTER })).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(letter.value).toBe('My own letter');
  });

  it('表上没有求职信栏：什么都不写', async () => {
    const { audit, proof } = await run('<label for="why">Why do you want to work here?</label><textarea id="why"></textarea>');
    expect(await audit.attachCoverLetter!(proof, { text: LETTER })).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect((document.getElementById('why') as HTMLTextAreaElement).value).toBe('');
  });
});
