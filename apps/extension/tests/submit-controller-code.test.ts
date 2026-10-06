// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplyFormDescriptor, FinalSubmitControlDescriptor } from '@edaix/apply-kernel/contracts';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { createScanRoot } from '@edaix/apply-kernel/scanRoot';

import { createSubmitController, type SubmitCodeMark } from '../lib/submitController';

/**
 * 提交控制器遇到「网站要邮件里的验证码」（2026-10-04，Greenhouse 的 Security code）。钉住：
 *  · 验证码提示在、那几格没填满：不按网站的提交（网站也不会收），也不告诉 worker「刚按了提交」，直接交回 CODE_REQUIRED；
 *  · 按了之后提示冒出来、或网站新说了一句「验证码不对」：不再干等，交回 CODE_REQUIRED；
 *  · 网站一直挂着上一次的那一句（同一个节点、同一句话）不算新的回答；读提示抛了当没有。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
afterEach(() => { document.body.innerHTML = ''; });

function page() {
  document.body.innerHTML = `
    <form id="application">
      <label for="fn">First Name</label><input id="fn" type="text" value="Ada" />
      <button id="final" type="submit">Submit application</button>
    </form>`;
  const form = document.querySelector<HTMLFormElement>('#application')!;
  const button = document.querySelector<HTMLButtonElement>('#final')!;
  const clicks = vi.fn();
  button.addEventListener('click', (event) => { event.preventDefault(); clicks(); });
  const root = createScanRoot(form, []);
  const fields = [{ kind: 'text', key: null, label: 'First Name', required: true, confidence: 1, element: document.getElementById('fn')!, signature: {} as never }];
  const finalSubmitControl: FinalSubmitControlDescriptor = {
    activation: 'native-submit', element: button, form, isCurrent: () => button.isConnected && button.form === form,
  };
  return { descriptor: { vendor: 'greenhouse', root, fields, finalSubmitControl } as unknown as ApplyFormDescriptor, clicks };
}

function policy(): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return { ...base, enabled: true, vendors: { ...base.vendors, greenhouse: true }, capabilities: { ...base.capabilities, 'submit-application': true }, notAfter: Date.now() + 60_000 };
}

function send(submitter: ReturnType<typeof createSubmitController>): Promise<unknown> {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let pending: Promise<unknown> = Promise.resolve();
  button.addEventListener('click', (event) => { pending = submitter.send(event, shadowRoot, Promise.resolve()); });
  button.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
  host.remove();
  return pending;
}

function controller(codePrompt: () => SubmitCodeMark | null, onPressing = vi.fn()) {
  return createSubmitController({
    document, isVisible: () => true, resolvePolicy: async () => policy(), codePrompt, onPressing,
    pollMs: 5, settleMs: 300, rejectAfterMs: 40,
  });
}

describe('网站正在要验证码', () => {
  it('那几格没填满：不按、不告诉 worker，交回 CODE_REQUIRED', async () => {
    const { descriptor, clicks } = page();
    const onPressing = vi.fn();
    const submitter = controller(() => ({ filled: false, error: null }), onPressing);
    submitter.arm({ descriptor, policy: policy() });
    expect(await send(submitter)).toBe('CODE_REQUIRED');
    expect(clicks).not.toHaveBeenCalled();
    expect(onPressing).not.toHaveBeenCalled();
  });

  it('填满了：照常按；网站新说了一句「验证码不对」（新节点）→ CODE_REQUIRED', async () => {
    const { descriptor, clicks } = page();
    const old = document.createElement('p');
    let mark: SubmitCodeMark = { filled: true, error: { node: old, text: 'The security code you entered is invalid.' } };
    const submitter = controller(() => mark);
    submitter.arm({ descriptor, policy: policy() });
    const pending = send(submitter);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    mark = { filled: true, error: { node: document.createElement('p'), text: 'The security code you entered is invalid.' } };
    expect(await pending).toBe('CODE_REQUIRED');
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('网站一直挂着上一次那一句（同一个节点、同一句话）：不算新的回答，照旧等到底', async () => {
    const { descriptor, clicks } = page();
    const old = document.createElement('p');
    const mark: SubmitCodeMark = { filled: true, error: { node: old, text: 'The security code you entered is invalid.' } };
    const submitter = controller(() => mark);
    submitter.arm({ descriptor, policy: policy() });
    expect(await send(submitter)).toBe('UNCONFIRMED');
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});

describe('按之前网站没在要验证码', () => {
  it('按了之后提示冒出来：不等满，交回 CODE_REQUIRED', async () => {
    const { descriptor, clicks } = page();
    let mark: SubmitCodeMark | null = null;
    descriptor.finalSubmitControl!.element.addEventListener('click', () => { mark = { filled: false, error: null }; });
    const submitter = createSubmitController({
      document, isVisible: () => true, resolvePolicy: async () => policy(), codePrompt: () => mark,
      pollMs: 5, settleMs: 5_000, rejectAfterMs: 40,
    });
    submitter.arm({ descriptor, policy: policy() });
    const started = Date.now();
    expect(await send(submitter)).toBe('CODE_REQUIRED');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('读提示抛了：当没有（照旧按、照旧判）', async () => {
    const { descriptor, clicks } = page();
    const submitter = controller(() => { throw new Error('boom'); });
    submitter.arm({ descriptor, policy: policy() });
    expect(await send(submitter)).toBe('UNCONFIRMED');
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
