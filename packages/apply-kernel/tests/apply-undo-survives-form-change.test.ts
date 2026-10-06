import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApplySession, type ApplySession } from '../src/session.svelte';
import { createBundledApplyPolicy } from '../src/policy';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';

/**
 * Undo 必须挺过"宿主给表单增删了控件"。
 *
 * 对抗式评审 2026-08-01 发现，`sameForm()` 把两件不同的事混成了一件：
 *
 *   previous.fields.length !== next.fields.length   → 字段增删
 *   field.element !== next.fields[i].element        → 元素被整体替换
 *
 * 只有后者会让撤销日志失效（旧引用指向已脱离文档的节点）。前者不会——原来那些
 * 元素全都还连着，原值完全可还原。`undo.ts` 的条目持的是 element 直接引用，
 * `undoAll()` 只校验 `isConnected`，表单多一个控件对已记录的条目毫无影响。
 *
 * 实测的失效（本文件第一条用例就是它）：
 *
 * | 情形             | 填充后        | reconcile 后        | 表单里的值 |
 * |------------------|---------------|---------------------|-----------|
 * | 静态表单         | undo=2 run=有 | undo=2 run=有       | 还在      |
 * | 宿主新增一个控件 | undo=2 run=有 | **undo=0 run=null** | **还在**  |
 *
 * 用户看到的是"填好了，然后撤销按钮自己没了"，而值原样留在页面上。这直接违反
 * 铁律 3 与决策 13 的 "Undo restores the form completely"。
 *
 * 触发面并不窄：选了"需要签证吗 → 是"之后冒出三道新题，是申请表最常见的交互。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountForm(extra = ''): void {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    <label for="email">Email</label><input id="email" type="text" />
    ${extra}</form>`;
}

function scan() {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, 'fixture 没被适配器认出来').not.toBeNull();
  return { vendor: 'greenhouse' as const, root: root!, fields: [...greenhouseAdapter.scan(root!)] };
}

function makeSession(): ApplySession {
  return createApplySession({
    vendor: 'greenhouse',
    readProfile: async () => ({
      ok: true,
      value: { draft: { firstName: 'Ada', email: 'ada@example.test' }, readOnly: false },
    }),
    writeProfile: async () => ({ ok: true, value: undefined }),
    // This suite exercises form reconciliation, not the production fallback
    // timestamp. Inject a test-owned current build instant so the fixture does
    // not silently become a policy-expiry test as wall clock time advances.
    loadPolicy: async () => createBundledApplyPolicy(Date.now()),
    rescanForm: () => scan(),
  });
}

/** A trusted click whose composedPath is rooted in our own Shadow UI. */
function shadowGesture(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

async function filledSession(): Promise<ApplySession> {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  mountForm();
  const session = makeSession();
  session.setForm(scan());
  session.setOpen(true);
  await session.ready();
  const { event, shadowRoot } = shadowGesture();
  await session.fill(event, shadowRoot);
  expect(session.snapshot().undoCount, '前置条件不成立：这一轮根本没写入').toBeGreaterThan(0);
  return session;
}

describe('Undo 挺过表单结构变化', () => {
  it('宿主新增一个条件控件后，撤销仍然可用且能真的还原', async () => {
    const session = await filledSession();
    const before = session.snapshot().undoCount;

    // 最常见的交互：选了某一项后页面冒出新题。
    document
      .querySelector('form')!
      .insertAdjacentHTML(
        'beforeend',
        '<label for="visa">Do you require sponsorship?</label><input id="visa" type="text" />',
      );
    session.setForm(scan());

    expect(
      session.snapshot().undoCount,
      '表单多了一个控件就把撤销日志扔了 —— 但原来那些元素全都还连着，原值本来可还原',
    ).toBe(before);

    session.undo(...Object.values(shadowGesture()) as [Event, ShadowRoot]);
    expect(
      (document.querySelector('#first_name') as HTMLInputElement).value,
      '撤销没有真的还原',
    ).toBe('');
    session.dispose();
  });

  it('宿主删除一个控件后同样保留撤销', async () => {
    mountForm('<label for="extra">Extra</label><input id="extra" type="text" />');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const session = makeSession();
    session.setForm(scan());
    session.setOpen(true);
    await session.ready();
    const { event, shadowRoot } = shadowGesture();
    await session.fill(event, shadowRoot);
    const before = session.snapshot().undoCount;
    expect(before).toBeGreaterThan(0);

    document.querySelector('#extra')!.remove();
    session.setForm(scan());
    expect(session.snapshot().undoCount).toBe(before);
    session.dispose();
  });

  /**
   * 反向探针。没有这一条，把 sameForm 写成"永远相等"也会让上面全绿——
   * 而那才是真正危险的：已经脱离文档的元素必须停止承诺可还原。
   */
  it('元素被整体替换时**必须**清掉撤销日志', async () => {
    const session = await filledSession();
    expect(session.snapshot().undoCount).toBeGreaterThan(0);

    // 宿主重建整个表单：旧节点脱离文档，旧引用再也还原不了任何东西。
    document.querySelector('form')!.remove();
    mountForm();
    session.setForm(scan());

    expect(
      session.snapshot().undoCount,
      '旧元素已脱离文档，却仍然向用户承诺可以撤销',
    ).toBe(0);
    session.dispose();
  });

  it('静态表单上重复 reconcile 不影响撤销（回归基线）', async () => {
    const session = await filledSession();
    const before = session.snapshot().undoCount;
    session.setForm(scan());
    session.setForm(scan());
    expect(session.snapshot().undoCount).toBe(before);
    session.dispose();
  });
});
