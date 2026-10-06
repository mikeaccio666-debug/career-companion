import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_SELECTOR,
  createScanRoot,
  resolveScanRootMutationPolicy,
  sealScanRootMutationPolicy,
} from '../src/scanRoot';

/**
 * Shadow DOM 穿透扫描（CAP-AF-047）。
 *
 * 今天扫描全靠 `container.querySelectorAll`，它**不穿 shadow root**。四家 ATS
 * 现在不用 web component 所以不痛，但任何一家改版换成 web component、或者接入
 * 一个用 shadow 封装表单的新站点，我们就是**零字段、零报错、静默失效**——
 * 最难被发现的那种失败：用户点了 Fill，什么都没发生，也没有任何原因码。
 *
 * 这条能力是广度扩张必须先垫上的一层。
 *
 * 边界：kernel 不碰浏览器 API（RULE-KERNEL-DETERMINISTIC-BOUNDARY）。缺省只
 * 看 open root（`element.shadowRoot`）；**闭合根**要靠内容脚本注入
 * `chrome.dom.openOrClosedShadowRoot`——那是内容脚本无需额外权限就能用的
 * API，宿主页面看不到我们在看。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** 把一个控件塞进 web component 的 shadow root 里，返回宿主元素。 */
function mountShadowField(
  host: Element,
  html: string,
  mode: 'open' | 'closed' = 'open',
): ShadowRoot {
  const shadow = host.attachShadow({ mode });
  shadow.innerHTML = html;
  return shadow;
}

function form(): Element {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label>
      <input id="email" type="email" />
      <x-field id="host"></x-field>
    </form>`;
  return document.querySelector('#application-form')!;
}

describe('Shadow DOM 穿透扫描', () => {
  it('open shadow root 里的控件被扫到', () => {
    const container = form();
    mountShadowField(
      container.querySelector('#host')!,
      '<label for="phone">Phone</label><input id="phone" type="tel" />',
    );

    const root = createScanRoot(container, []);
    const controls = root.querySelectorAll('input');
    expect(
      controls.map((element) => element.id).sort(),
      'shadow root 里的控件没被扫到——用户点 Fill 什么都不会发生，也没有原因码',
    ).toEqual(['email', 'phone']);
  });

  it('shadow root 里的标签能解析出来', () => {
    const container = form();
    const shadow = mountShadowField(
      container.querySelector('#host')!,
      '<label for="phone">Phone number</label><input id="phone" type="tel" />',
    );

    const root = createScanRoot(container, []);
    const phone = shadow.querySelector('#phone')!;
    expect(
      root.labelTextFor(phone),
      '穿透扫到了控件却读不出标签，等于扫到了也不知道那是什么字段',
    ).toBe('Phone number');
  });

  it('闭合 shadow root 要靠注入的打开器——不注入就看不见', () => {
    const container = form();
    const host = container.querySelector('#host')!;
    const shadow = mountShadowField(host, '<input id="phone" type="tel" />', 'closed');

    // 缺省：只看 open root。闭合根对 kernel 不可见，保守失败。
    const plain = createScanRoot(container, []);
    expect(plain.querySelectorAll('input').map((element) => element.id)).toEqual(['email']);

    // 内容脚本注入 chrome.dom.openOrClosedShadowRoot 的等价物。
    const piercing = createScanRoot(container, [], [], {
      openShadowRoot: (element) => (element === host ? shadow : element.shadowRoot),
    });
    expect(
      piercing.querySelectorAll('input').map((element) => element.id).sort(),
      '注入了打开器仍然穿不进闭合根',
    ).toEqual(['email', 'phone']);
  });

  it('嵌套 shadow root 也能穿到底', () => {
    const container = form();
    const outer = mountShadowField(container.querySelector('#host')!, '<x-inner id="inner"></x-inner>');
    const inner = mountShadowField(outer.querySelector('#inner')!, '<input id="deep" type="text" />');

    const root = createScanRoot(container, []);
    expect(root.querySelectorAll('input').map((element) => element.id).sort()).toEqual([
      'deep',
      'email',
    ]);
    expect(sealScanRootMutationPolicy(root)).not.toBeNull();
    expect(
      resolveScanRootMutationPolicy(root)?.targets,
      'mutation observer 只看 light DOM 会漏掉已扫描的 shadow tree',
    ).toEqual([container, outer, inner]);
  });

  it('只有 kernel 创建的 verified root 能解析 mutation targets', () => {
    const fakeRoot = {
      querySelectorAll: () => [],
      labelTextFor: () => '',
      isExcluded: () => false,
      identityScope: () => ({ scopeKey: '', controls: [] }),
    };
    expect(resolveScanRootMutationPolicy(fakeRoot)).toBeNull();
  });

  it('mutation policy owns remote-rule attributes and ignores combobox option churn', () => {
    const container = form();
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    expect(sealScanRootMutationPolicy(root)).not.toBeNull();
    const policy = resolveScanRootMutationPolicy(root)!;
    const email = container.querySelector('#email')!;
    expect(policy.observerOptions).toEqual({
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    expect(policy.isRelevant([{
      type: 'childList',
      target: container,
      addedNodes: [option],
      removedNodes: [],
    } as unknown as MutationRecord])).toBe(false);

    email.setAttribute('data-testid', 'changed-field-hook');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: email,
      attributeName: 'data-testid',
    } as unknown as MutationRecord])).toBe(true);

    const secondRoot = createScanRoot(container, []);
    const secondPolicy = sealScanRootMutationPolicy(secondRoot)!;
    const addedControl = document.createElement('input');
    container.append(addedControl);
    expect(secondPolicy.isRelevant([{
      type: 'childList',
      target: container,
      addedNodes: [addedControl],
      removedNodes: [],
    } as unknown as MutationRecord])).toBe(true);
    expect(secondPolicy.isRelevant([{
      type: 'childList',
      target: container,
      addedNodes: [],
      removedNodes: [email],
    } as unknown as MutationRecord])).toBe(true);
  });

  it('seals the descriptor-era baseline and refuses to rebaseline a later control', () => {
    const container = form();
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    const sealed = sealScanRootMutationPolicy(root);
    expect(sealed).not.toBeNull();

    const late = document.createElement('input');
    late.id = 'arrived-during-digest';
    container.append(late);

    expect(sealed?.isCurrent()).toBe(false);
    expect(resolveScanRootMutationPolicy(root)).toBeNull();
  });

  it('uses semantic rule parity: data-ui invalidates row identity but unrelated class churn does not', () => {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <div data-ui="experience"><ul><li><input name="title" /></li></ul></div>
        <div class="react-select-shell"><input id="location" role="combobox" /></div>
      </form>`;
    const container = document.querySelector('form')!;
    const root = createScanRoot(
      container,
      ['[role="search"]'],
      [{
        kind: 'contains',
        container: 'div[data-ui="experience"]',
        row: 'ul > li',
        collection: 'experience',
      }],
      {},
      { page: document, anchors: ['form[data-ui="application-form"]'] },
    );
    const policy = sealScanRootMutationPolicy(root)!;
    const experience = container.querySelector('[data-ui="experience"]')!;
    const shell = container.querySelector('.react-select-shell')!;

    shell.className = 'react-select-shell focused menu-open';
    expect(policy.isRelevant([{
      type: 'attributes',
      target: shell,
      attributeName: 'class',
      oldValue: 'react-select-shell',
    } as unknown as MutationRecord])).toBe(false);
    expect(policy.isCurrent()).toBe(true);

    experience.setAttribute('data-ui', 'not-experience');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: experience,
      attributeName: 'data-ui',
      oldValue: 'experience',
    } as unknown as MutationRecord])).toBe(true);
    expect(policy.isCurrent()).toBe(false);
  });

  it('quick-filter invalidates selector class, ARIA, tabindex, file kind, and label text semantics', () => {
    const fresh = () => {
      document.body.innerHTML = `
        <form>
          <div class="semantic-row"><label for="resume">Resume</label><input id="resume" type="file" /></div>
        </form>`;
      const container = document.querySelector('form')!;
      const root = createScanRoot(container, [], [{
        kind: 'contains',
        container: '.semantic-row',
        row: '.semantic-row',
      }]);
      return {
        container,
        policy: sealScanRootMutationPolicy(root)!,
        resume: container.querySelector<HTMLInputElement>('#resume')!,
      };
    };

    {
      const { container, policy } = fresh();
      const row = container.querySelector('.semantic-row')!;
      row.className = 'different-row';
      expect(policy.isRelevant([{
        type: 'attributes', target: row, attributeName: 'class',
      } as unknown as MutationRecord])).toBe(true);
    }
    {
      const { policy, resume } = fresh();
      resume.setAttribute('aria-label', 'CV');
      expect(policy.isRelevant([{
        type: 'attributes', target: resume, attributeName: 'aria-label',
      } as unknown as MutationRecord])).toBe(true);
    }
    {
      const { policy, resume } = fresh();
      resume.setAttribute('tabindex', '-1');
      expect(policy.isRelevant([{
        type: 'attributes', target: resume, attributeName: 'tabindex',
      } as unknown as MutationRecord])).toBe(true);
    }
    {
      const { policy, resume } = fresh();
      resume.type = 'text';
      expect(policy.isRelevant([{
        type: 'attributes', target: resume, attributeName: 'type',
      } as unknown as MutationRecord])).toBe(true);
    }
    {
      const { container, policy } = fresh();
      const text = container.querySelector('label')!.firstChild!;
      text.textContent = 'Curriculum vitae';
      expect(policy.isRelevant([{
        type: 'characterData', target: text,
      } as unknown as MutationRecord])).toBe(true);
    }
  });

  it('invalidates a host that gains a shadow root after an earlier execution checkpoint', () => {
    document.body.innerHTML = '<form id="application"><x-existing></x-existing><input id="email" /></form>';
    const container = document.querySelector('form')!;
    const existing = container.querySelector('x-existing')!;
    const root = createScanRoot(container, []);
    const policy = sealScanRootMutationPolicy(root)!;

    expect(policy.isExecutionCurrent()).toBe(true);
    existing.attachShadow({ mode: 'open' });
    expect(policy.isCurrent()).toBe(false);
    expect(policy.isExecutionCurrent()).toBe(false);

    const freshRoot = createScanRoot(container, []);
    const freshPolicy = sealScanRootMutationPolicy(freshRoot)!;
    const added = document.createElement('x-added');
    added.attachShadow({ mode: 'open' });
    container.append(added);
    expect(freshPolicy.isRelevant([{
      type: 'childList',
      target: container,
      addedNodes: [added],
      removedNodes: [],
    } as unknown as MutationRecord])).toBe(true);
  });

  it('compares the complete host topology during the one exact semantic freshness check', () => {
    document.body.innerHTML = '<form><x-empty></x-empty><input id="email" /></form>';
    const container = document.querySelector('form')!;
    const emptyHost = container.querySelector('x-empty')!;
    const root = createScanRoot(container, []);
    const rescan = vi.fn(() => []);
    const policy = sealScanRootMutationPolicy(root, { fields: [], rescan })!;

    emptyHost.remove();

    expect(policy.isCurrent()).toBe(false);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it('semantic freshness is sealed once; mutation filtering and execution fences never rescan the table', () => {
    document.body.innerHTML = `
      <form>
        <x-empty></x-empty>
        <input id="email" data-testid="email" />
        <div role="listbox"></div>
      </form>`;
    const container = document.querySelector('form')!;
    const openShadowRoot = vi.fn((element: Element) => element.shadowRoot);
    const root = createScanRoot(container, [], [], { openShadowRoot });
    const fields = [{
      confidence: 1,
      element: container.querySelector<HTMLInputElement>('#email')!,
      key: 'email',
      kind: 'text',
      label: 'Email',
      required: false,
      signature: { core: 'root/input:0', labelHint: 'email' },
    }] as const;
    const rescan = vi.fn(() => fields);
    const policy = sealScanRootMutationPolicy(root, { fields, rescan })!;

    expect(resolveScanRootMutationPolicy(root)).toBe(policy);
    expect(rescan).not.toHaveBeenCalled();
    expect(policy.isCurrent()).toBe(true);
    expect(rescan).toHaveBeenCalledTimes(1);
    openShadowRoot.mockClear();

    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    for (let index = 0; index < 25; index += 1) {
      expect(policy.isRelevant([{
        type: 'childList',
        target: container.querySelector('[role="listbox"]')!,
        addedNodes: [option],
        removedNodes: [],
      } as unknown as MutationRecord])).toBe(false);
      expect(policy.isExecutionCurrent()).toBe(true);
      expect(policy.isCurrent()).toBe(true);
    }
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(
      openShadowRoot,
      '25 batches × (one direct execution fence + one isCurrent fence) × 4 baseline hosts',
    ).toHaveBeenCalledTimes(25 * 2 * 4);

    const email = container.querySelector('#email')!;
    email.setAttribute('tabindex', '-1');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: email,
      attributeName: 'tabindex',
    } as unknown as MutationRecord])).toBe(true);
    expect(policy.isCurrent()).toBe(false);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it('invalidates when an earlier ordered anchor becomes the new rule winner', () => {
    document.body.innerHTML = '<form class="fallback"><input id="email" /></form>';
    const container = document.querySelector('form')!;
    const root = createScanRoot(
      container,
      [],
      [],
      {},
      { page: document, anchors: ['form.preferred', 'form.fallback'] },
    );
    const policy = sealScanRootMutationPolicy(root)!;
    const preferred = document.createElement('form');
    preferred.className = 'preferred';
    document.body.prepend(preferred);
    expect(policy.isCurrent()).toBe(false);
  });

  it('fails closed when the shadow traversal completeness budget is exhausted', () => {
    const container = document.createElement('form');
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 20_001; index += 1) {
      fragment.append(document.createElement('span'));
    }
    container.append(fragment);
    document.body.append(container);
    const root = createScanRoot(container, []);
    expect(sealScanRootMutationPolicy(root)).toBeNull();
  });

  it('isExcluded 对 shadow 里的控件仍然生效——穿透不等于绕过排除', () => {
    const container = form();
    const shadow = mountShadowField(
      container.querySelector('#host')!,
      '<div class="hidden-section"><input id="phone" type="tel" /></div>',
    );

    const root = createScanRoot(container, ['.hidden-section']);
    expect(
      root.isExcluded(shadow.querySelector('#phone')!),
      '穿透进去的控件绕过了排除规则——排除规则是安全边界，不能因为换了个树就失效',
    ).toBe(true);
  });

  /**
   * 反向探针：没有 shadow root 的普通表单必须逐字保持原行为。
   * 这条能力的风险在于它改的是**所有扫描**的公共路径——四家适配器全靠它。
   */
  it('反向探针：无 shadow 的普通表单行为不变', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label><input id="email" type="email" />
        <label for="name">Name</label><input id="name" type="text" />
      </form>`;
    const container = document.querySelector('#application-form')!;
    const root = createScanRoot(container, []);

    expect(root.querySelectorAll('input').map((element) => element.id)).toEqual(['email', 'name']);
    expect(root.labelTextFor(container.querySelector('#email')!)).toBe('Email');
    expect(root.isExcluded(container.querySelector('#email')!)).toBe(false);
  });
});
