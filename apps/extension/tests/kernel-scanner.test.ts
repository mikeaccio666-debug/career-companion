// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveScanRootMutationPolicy } from '@edaix/apply-kernel/scanRoot';
import { scanCurrentPage } from '../lib/kernelScanner';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * 刀五前半特征测试：scanner 从桩变真——真实调用 apply-kernel 的
 * readApplyForm（Greenhouse 适配 + JSON 规则整条链），产出 claim 输入。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const GH_LOC = {
  hostname: 'job-boards.greenhouse.io',
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/12345',
};

function mountGreenhouseForm(extraField = ''): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="last_name">Last name*</label>
      <input id="last_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      ${extraField}
    </form>`;
}

/**
 * 白标／雇主自建域名（CAP-AF-006 第③件：接线）。
 *
 * 门控的四件判断早就写完了、各自有测试，但生产路径上**从来没有人调用过**——
 * 第一道判断至今是那张 8 个精确主机名的表。这一组锁的不是判断本身（那在
 * apply-kernel/tests/apply-gate-resolution.test.ts 里），而是**执行链真的走了它**。
 *
 * 这是本仓第五次同一形状：写完了、有测试、没有调用方。前四次的实测代价分别是
 * Workday 的 beecatcher 蜜罐被真写入且 UI 显示"已填"、推荐人字段被填成申请人本人、
 * JOB_DEPENDENT 整条守卫从未被调用、createApplySession 只被测试 import。
 */
describe('白标域名覆盖', () => {
  const ACME = {
    hostname: 'careers.acme-corp.test',
    origin: 'https://careers.acme-corp.test',
    pathname: '/jobs/senior-engineer',
  };

  it('公司自建域名上的 Greenhouse embed 能扫出来', async () => {
    mountGreenhouseForm();
    // 官方 embed 的固有产物，公司自建页上原样保留。
    document.body.innerHTML = `<div id="grnhse_app">${document.body.innerHTML}</div>`;

    const { scan } = await scanCurrentPage(document, ACME);
    expect(
      scan,
      '自建域名上的 Greenhouse 申请页扫不出来——用户从公司官网进来的那类流量我们全看不见',
    ).not.toBeNull();
    expect(scan!.fieldKeys).toEqual(['email', 'firstName', 'lastName']);
    expect(scan!.canonicalOrigin, '白标页的 origin 记成了厂商主机').toBe(ACME.origin);
  });

  it('指纹只给提示：认出了厂商但解析不出表单，仍然返回 null', async () => {
    // embed 标记在、表单不在（例如岗位列表页而不是申请页）。指纹会说 greenhouse，
    // 但 readApplyForm 拿不到表单锚点——归属的终点是那道解析，不是指纹。
    document.body.innerHTML = '<div id="grnhse_app"><p>Open roles</p></div>';
    const outcome = await scanCurrentPage(document, ACME);
    expect(outcome).toMatchObject({ scan: null, refusal: null, vendor: 'greenhouse' });
  });

  it('雇主后台绝不扫——哪怕 embed 产物在、表单也在', async () => {
    mountGreenhouseForm();
    document.body.innerHTML = `<div id="grnhse_app">${document.body.innerHTML}</div>`;
    const outcome = await scanCurrentPage(document, {
      hostname: 'app.greenhouse.io',
      origin: 'https://app.greenhouse.io',
      pathname: '/people/1',
    });
    expect(
      outcome.scan,
      '扫了雇主后台——HR 正在录入某个候选人，我们会把扩展使用者本人的资料写进别人的记录',
    ).toBeNull();
    expect(outcome.refusal).toBe('EMPLOYER_CONSOLE');
  });

  it('登录页绝不扫——哪怕指纹命中', async () => {
    document.body.innerHTML =
      '<div id="grnhse_app"><form id="application-form">' +
      '<label for="first_name">First name</label><input id="first_name" />' +
      '<input type="password" id="pw" /></form></div>';
    const outcome = await scanCurrentPage(document, ACME);
    expect(outcome).toMatchObject({
      scan: null,
      refusal: 'CREDENTIAL_PAGE',
      vendor: 'greenhouse',
    });
  });

  it('反向探针：普通网页照旧什么都不扫', async () => {
    document.body.innerHTML = '<article><h1>Blog post</h1><p>text</p></article>';
    expect((await scanCurrentPage(document, ACME)).scan).toBeNull();
  });
});

describe('kernel scanner（真实内核扫描）', () => {
  it('Greenhouse 页面：产出 canonical fieldKeys + 稳定 scanDigest', async () => {
    mountGreenhouseForm();
    const { scan } = await scanCurrentPage(document, GH_LOC);
    expect(scan).not.toBeNull();
    expect(scan!.fieldKeys).toEqual(['email', 'firstName', 'lastName']);
    expect(scan!.jobId).toBe('/acme/jobs/12345');
    expect(scan!.canonicalOrigin).toBe(GH_LOC.origin);
    // §1.2 digest 约定：sha256: 前缀 + 64 位小写 hex。
    expect(scan!.scanDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 同一 DOM 重扫，摘要必须稳定（claim 比对的前提）。
    const { scan: again } = await scanCurrentPage(document, GH_LOC);
    expect(again!.scanDigest).toBe(scan!.scanDigest);
  });

  it('页面多出一个可填字段 → 摘要变化（服务端比对能看见页面变样）', async () => {
    mountGreenhouseForm();
    const { scan: before } = await scanCurrentPage(document, GH_LOC);
    mountGreenhouseForm('<label for="phone">Phone*</label><input id="phone" type="tel" required />');
    const { scan: after } = await scanCurrentPage(document, GH_LOC);
    expect(after!.fieldKeys).toContain('phone');
    expect(after!.scanDigest).not.toBe(before!.scanDigest);
  });

  it('descriptor 同步 seal 并在 digest await 前 arm；期间 DOM 变化使 scan fail closed', async () => {
    mountGreenhouseForm();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest!: () => void;
    const digestBarrier = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await digestBarrier;
      return originalDigest(...args);
    });
    let armed = false;
    const pending = scanCurrentPage(document, GH_LOC, {
      armMutationGuard: (policy) => {
        armed = true;
        return { isCurrent: policy.isCurrent, dispose: vi.fn() };
      },
    });

    expect(armed).toBe(true);
    document.querySelector('#application-form')!.append(document.createElement('input'));
    releaseDigest();
    await expect(pending).resolves.toMatchObject({ scan: null, refusal: null });
  });

  it('semantic parity covers aria-haspopup, tabindex and label characterData without selector guesses', async () => {
    mountGreenhouseForm('<label for="location">Location</label><input id="location" type="text">');
    const first = (await scanCurrentPage(document, GH_LOC)).scan!;
    const firstPolicy = resolveScanRootMutationPolicy(first.descriptor.root)!;
    const location = document.querySelector('#location')!;
    location.setAttribute('aria-haspopup', 'listbox');
    expect(firstPolicy.isRelevant([{
      type: 'attributes',
      target: location,
      attributeName: 'aria-haspopup',
    } as unknown as MutationRecord])).toBe(true);

    mountGreenhouseForm();
    const second = (await scanCurrentPage(document, GH_LOC)).scan!;
    const secondPolicy = resolveScanRootMutationPolicy(second.descriptor.root)!;
    const email = document.querySelector('#email')!;
    email.setAttribute('aria-hidden', 'true');
    email.setAttribute('tabindex', '-1');
    expect(secondPolicy.isRelevant([
      { type: 'attributes', target: email, attributeName: 'aria-hidden' },
      { type: 'attributes', target: email, attributeName: 'tabindex' },
    ] as unknown as MutationRecord[])).toBe(true);

    mountGreenhouseForm();
    const third = (await scanCurrentPage(document, GH_LOC)).scan!;
    const thirdPolicy = resolveScanRootMutationPolicy(third.descriptor.root)!;
    const labelText = document.querySelector('label[for="first_name"]')!.firstChild!;
    labelText.textContent = 'Preferred name*';
    expect(thirdPolicy.isRelevant([{
      type: 'characterData',
      target: labelText,
    } as unknown as MutationRecord])).toBe(true);
  });

  it('厂商认不出 / 表单锚点缺失 → null（协调器据此停）', async () => {
    mountGreenhouseForm();
    expect(
      (await scanCurrentPage(document, { ...GH_LOC, hostname: 'evil.example.test' })).scan,
    ).toBeNull();
    document.body.innerHTML = '<form><input id="email" /></form>'; // 无厂商锚点
    expect((await scanCurrentPage(document, GH_LOC)).scan).toBeNull();
  });

  it('Data-L1：扫描产出序列化后不含字段值与标签文案', async () => {
    mountGreenhouseForm();
    document.querySelector<HTMLInputElement>('#email')!.value = 'alex@example.test';
    const { scan } = await scanCurrentPage(document, GH_LOC);
    const { descriptor: _live, ...wire } = scan!;
    expect(JSON.stringify(wire)).not.toMatch(/alex@example\.test|First name/);
  });
});

/**
 * Shadow DOM 穿透在**真实扫描路径**上的接线证明（CAP-AF-047）。
 *
 * kernel 侧 `createScanRoot` 已能穿透，但它不碰扩展 API——闭合根要靠
 * `kernelScanner.ts` 注入 `chrome.dom.openOrClosedShadowRoot`。这条锁那根线：
 * 忘了传，用 web component 封装表单的站点上我们就是零字段、零报错、静默失效。
 */
describe('Shadow DOM 穿透接进了真实扫描路径', () => {
  it('闭合 shadow root 里的字段被扫到（经 chrome.dom 打开器）', async () => {
    mountGreenhouseForm('<x-field id="host"></x-field>');
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<label for="phone">Phone</label><input id="phone" name="phone" type="tel" />';

    // 内容脚本环境里由浏览器提供；这里桩一个等价物。
    const g = globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: unknown } } };
    const previous = g.chrome;
    g.chrome = {
      ...(previous ?? {}),
      dom: { openOrClosedShadowRoot: (el: Element) => (el === host ? shadow : el.shadowRoot) },
    };
    try {
      const { scan } = await scanCurrentPage(document, GH_LOC);
      expect(
        scan?.fieldKeys,
        '闭合根里的 phone 没被扫到——用 web component 封装表单的站点上我们静默失效',
      ).toContain('phone');
    } finally {
      if (previous === undefined) delete g.chrome;
      else g.chrome = previous;
    }
  });

  it('反向探针：没有 chrome.dom 时退回只看 open root，不崩', async () => {
    mountGreenhouseForm('<x-field id="host"></x-field>');
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<label for="phone">Phone</label><input id="phone" name="phone" type="tel" />';

    const g = globalThis as unknown as { chrome?: unknown };
    const previous = g.chrome;
    delete g.chrome;
    try {
      const { scan } = await scanCurrentPage(document, GH_LOC);
      expect(scan, '没有 chrome.dom 就整轮崩了').not.toBeNull();
      expect(scan?.fieldKeys, 'open root 是标准 DOM，无论如何都该看得见').toContain('phone');
    } finally {
      if (previous !== undefined) g.chrome = previous;
    }
  });
});
