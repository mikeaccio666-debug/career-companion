import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../../src/engine';
import { createApplySession } from '../../src/session.svelte';
import { greenhouseAdapter } from '../../src/sites/greenhouse/applyForm';
import { testApplyPolicy } from '../helpers/applyTestAuthority';

/**
 * S0 · 简历文件的域名门槛（2026-08-03 对抗评审确认项 2）。
 *
 * 攻击链是完整的，每一环我都单独验过：
 *   ① 内容脚本的注入范围是「全部 https 主机 + 全部子帧」；
 *   ② 厂商识别**刻意不认域名**（A2b 的目的：白标 ATS 与公司自建页），信号全是
 *      DOM 特征，而任何页面对自己的 DOM 有完全控制权，伪造是零成本的；
 *   ③ 跨源子帧读顶层窗口会抛，代码据此把自己当顶层，于是**子帧从不让位**；
 *   ④ 后台的取件端口只检查 https 与 tab id，不看帧、不看来源。
 *
 * 于是：用户信任的网站里嵌一个恶意 iframe，伪装成 Greenhouse 表单，我们的浮层就在
 * 那个 iframe 里挂出来；用户点 Fill，简历挂到攻击者的表单上，那个页面直接读
 * `input.files[0]`。
 *
 * 这个风险负责人**早就接受过**——针对的是 11 个文本键。A3 之后同一条链拿到的变成
 * 整份简历 PDF：完整履历、住址。量级不同，所以门槛只加在简历这一栏：**既保住 A2b
 * 的覆盖面，又不让最值钱的那一件东西只靠一次 Fill 点击就送出去。**
 *
 * 缺省必须是 fail-closed。这条测试存在的意义就是让"顺手把默认改成 true"变红。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountResumeForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label><input id="email" type="email" />
      <label for="resume">Resume/CV</label>
      <input id="resume" type="file" accept=".pdf,.docx" />
    </form>`;
}

function plan(options: { resumeHostConfirmed?: boolean }) {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，后面的断言就是空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    { email: 'ada@example.test' },
    { resumeFileName: 'Ada_Lovelace.pdf', ...options },
  );
}

function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
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

/**
 * 页面脚本能做到的极限：路径完全正确的一次 `click`，唯独 `isTrusted` 是 false。
 * 浏览器不允许页面把它改成 true —— 这条门槛的锚点就在这里，所以要单独锁住。
 */
function forgedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  // 构造出来的事件不可能是可信的，也不允许再改写这个属性。
  // 注意实测差异：happy-dom 给的是 `undefined` 而真实浏览器给 `false`——所以守卫
  // 必须写成 `=== true` 而不是 `!== false`，这里也只断言"不为 true"。
  expect(event.isTrusted, '这个环境里合成事件竟然是可信的，本条断言失去意义').not.toBe(true);
  return { event, shadowRoot };
}

function createSession(overrides: Record<string, unknown> = {}) {
  mountResumeForm();
  const root = greenhouseAdapter.resolveRoot(document)!;
  const descriptor = {
    vendor: 'greenhouse' as const,
    root,
    fields: [...greenhouseAdapter.scan(root)],
  };
  const session = createApplySession({
    vendor: 'greenhouse',
    readProfile: async () => ({
      ok: true as const,
      value: { draft: { email: 'ada@example.test' }, readOnly: false },
    }),
    loadPolicy: async () => testApplyPolicy(),
    rescanForm: () => descriptor,
    readResumeFileName: async () => 'Ada_Lovelace.pdf',
    ...overrides,
  });
  session.setForm(descriptor);
  return session;
}

describe('S0 · 简历文件的域名门槛', () => {
  it('缺省是 fail-closed —— 没表态就等于没确认', () => {
    mountResumeForm();
    const built = plan({});
    expect(
      built.entries.some((entry) => entry.kind === 'file'),
      '调用方没表态，简历却进了计划 —— 默认值不再是 fail-closed',
    ).toBe(false);
    expect(built.skipped.find((item) => item.label.includes('Resume'))?.reason).toBe(
      'HOST_UNCONFIRMED',
    );
  });

  it('确认后简历才进计划', () => {
    mountResumeForm();
    const built = plan({ resumeHostConfirmed: true });
    expect(
      built.entries.some((entry) => entry.kind === 'file'),
      '确认了却仍然不填 —— 那这道门槛是死路，不是门槛',
    ).toBe(true);
  });

  /** 门槛只加在简历上。加宽到文本字段会白白吃掉 A2b 的全部覆盖面。 */
  it('文本字段不受这道门槛影响', () => {
    mountResumeForm();
    const built = plan({});
    expect(built.entries.map((entry) => entry.key)).toContain('email');
  });

  it('已知 ATS 域名视同已确认，不打扰用户', async () => {
    const session = createSession({ hostIsKnownAts: true });
    session.setOpen(true);
    await session.ready();
    await vi.waitFor(() =>
      expect(session.snapshot().plan?.entries.some((entry) => entry.kind === 'file')).toBe(true),
    );
    expect(session.snapshot().resumeHostConfirmed).toBe(true);
    session.dispose();
  });

  it('纯指纹页面上，用户在浮层里确认之后简历才可填', async () => {
    const session = createSession();
    session.setOpen(true);
    await session.ready();
    await vi.waitFor(() =>
      expect(
        session.snapshot().plan?.skipped.some((item) => item.reason === 'HOST_UNCONFIRMED'),
      ).toBe(true),
    );
    expect(session.snapshot().resumeHostConfirmed).toBe(false);

    const click = trustedShadowClick();
    session.confirmResumeHost(click.event, click.shadowRoot);

    expect(session.snapshot().resumeHostConfirmed).toBe(true);
    expect(
      session.snapshot().plan?.entries.some((entry) => entry.kind === 'file'),
      '确认后计划没有重建 —— 用户点了按钮却什么都没发生',
    ).toBe(true);
    session.dispose();
  });

  /**
   * 伪造事件不能替用户做这个决定。宿主页面能派发任意 `click`，但它做不出
   * `isTrusted === true` —— 这正是这条门槛唯一的锚点。
   */
  it('伪造的点击确认不了', async () => {
    const session = createSession();
    session.setOpen(true);
    await session.ready();

    const forged = forgedShadowClick();
    session.confirmResumeHost(forged.event, forged.shadowRoot);

    expect(
      session.snapshot().resumeHostConfirmed,
      '页面派发一个假 click 就替用户同意了交出简历',
    ).toBe(false);
    session.dispose();
  });

  /** 我们自己浮层之外的真实点击同样不算——否则页面上任何按钮都成了同意按钮。 */
  it('我方浮层之外的真实点击确认不了', async () => {
    const session = createSession();
    session.setOpen(true);
    await session.ready();

    const outside = new Event('click', { bubbles: true, composed: true });
    Object.defineProperty(outside, 'isTrusted', { value: true });
    const strangerHost = document.createElement('div');
    const strangerRoot = strangerHost.attachShadow({ mode: 'open' });
    Object.defineProperty(outside, 'composedPath', { value: () => [document.body, document] });

    session.confirmResumeHost(outside, strangerRoot);

    expect(session.snapshot().resumeHostConfirmed).toBe(false);
    session.dispose();
  });
});
