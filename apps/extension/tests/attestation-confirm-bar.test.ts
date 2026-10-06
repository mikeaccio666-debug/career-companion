// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showAttestationConfirmBar, type AttestationItem } from '../lib/attestationConfirmBar';

/**
 * 乙档放行确认条的特征测试。
 *
 * 本文件锁的四件事，每一件都配了变异探针（见各 describe 的头注）：
 *  1. **不点就不写**——任何非「显式放行」的收场都必须是 declined；
 *  2. **原文逐条完整呈现**——不摘要、不合并计数（法律含义在措辞里）；
 *  3. **只放行用户当时勾着的那几条**——取消勾选的不许混进去；
 *  4. **Data-L1**：原文绝不进 console。
 */

const ITEMS: readonly AttestationItem[] = [
  { id: 'a', declarationText: 'I certify that the information provided is accurate and complete.' },
  { id: 'b', declarationText: 'I confirm the above to the best of my knowledge.' },
  { id: 'c', declarationText: '本人声明以上信息属实。' },
];

afterEach(() => {
  document.getElementById('edaix-attestation-confirm-bar')?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** closed shadow root 外部取不到；用返回的 root 句柄查（宿主页拿不到本模块）。 */
function boxes(root: ShadowRoot): HTMLInputElement[] {
  return [...root.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
}
function button(root: ShadowRoot, text: string): HTMLButtonElement {
  const hit = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  expect(hit, `找不到按钮「${text}」——测试选错元素就成了空转`).toBeTruthy();
  return hit as HTMLButtonElement;
}

describe('不点就不写（fail-closed）', () => {
  /**
   * 探针：把 `let outcome: AttestationDecision = { kind: 'declined' }` 的初值
   * 改成 `{ kind: 'released', releasedIds: [] }`，或把 pagehide 监听摘掉——
   * 下面这几条会红。
   */
  it('页面卸载 → declined，一条都不放行', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    window.dispatchEvent(new Event('pagehide'));
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  it('在面板内按 Esc → declined', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    prompt.root.querySelector('input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  /**
   * 反向：**宿主页的 Esc 不算用户拒绝。**
   *
   * 原实现把 keydown 挂在 `document` 上且 capture=true——审查实测：
   * 用户回到宿主表单按 Esc 关掉一个原生 select 下拉 / 日期选择器 /
   * 自动补全，我们**先于宿主任何 handler** 触发，直接拆条，
   * 而且没有重新弹出的路径。用户从未想拒绝。
   * 对照 `auditPanel.ts`：它刻意一个文档级监听都不挂。
   */
  it('宿主页按 Esc **不**收口——确认条照常开着', async () => {
    document.body.innerHTML = '<form><select id="host-select"></select></form>';
    const prompt = showAttestationConfirmBar(ITEMS);

    document.getElementById('host-select')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(
      document.getElementById('edaix-attestation-confirm-bar'),
      '宿主页的 Esc 把确认条拆了——用户从未想拒绝',
    ).not.toBeNull();

    // 确认它真的还活着：现在正常放行仍然可用。
    button(prompt.root, '勾选这').click();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'released' });
  });

  it('点「不勾选」→ declined', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    button(prompt.root, '不勾选').click();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  it('点「不再自动处理这类声明」→ tier-disabled，且本次也不放行', async () => {
    // 关档是「以后别做」，不是「这次照做、以后别做」。
    const prompt = showAttestationConfirmBar(ITEMS);
    button(prompt.root, '不再自动处理').click();
    const decision = await prompt.decision;
    expect(decision).toMatchObject({ kind: 'tier-disabled' });
    expect(decision).not.toHaveProperty('releasedIds');
  });

  it('外部 dismiss() → declined', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    prompt.dismiss();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  it('一条声明都没有时不弹条，直接 declined', async () => {
    const prompt = showAttestationConfirmBar([]);
    expect(document.getElementById('edaix-attestation-confirm-bar')).toBeNull();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });
});

describe('原文逐条完整呈现（不摘要、不合并计数）', () => {
  /**
   * 探针：把 `label.textContent = item.declarationText` 改成
   * `label.textContent = '第 N 条声明'`——下面第一条会红。
   * 这正是本产品裁决的核心：摘要成「已勾选 3 项」等于让用户看不见内容就签字。
   */
  it('每一条的原文都逐字出现在面板里', () => {
    const { root } = showAttestationConfirmBar(ITEMS);
    const text = root.textContent ?? '';
    for (const item of ITEMS) {
      expect(text, `原文「${item.declarationText}」没有完整出现——摘要化就是本条要防的事`).toContain(
        item.declarationText,
      );
    }
  });

  it('三条声明就渲染三个复选框，不合并', () => {
    const { root } = showAttestationConfirmBar(ITEMS);
    expect(boxes(root)).toHaveLength(3);
  });

  it('原文一律走 textContent——宿主页的尖括号不许变成节点', () => {
    // 宿主页面的声明文案是不可信输入。这条锁 XSS 面。
    const nasty = '<img src=x onerror="globalThis.__pwned=1">I certify this is true.';
    const { root } = showAttestationConfirmBar([{ id: 'x', declarationText: nasty }]);
    expect(root.querySelector('img'), '原文被当成 HTML 解析了').toBeNull();
    expect(root.textContent).toContain(nasty);
  });
});

describe('只放行用户当时勾着的那几条', () => {
  /**
   * 探针：把 `checkedIds()` 里的 `.filter(([, box]) => box.checked)` 删掉
   * （改成放行全部）——第二条会红。
   */
  it('默认全部勾上（§4.5.2 默认开 = 预填 + 强制复核）', () => {
    const { root } = showAttestationConfirmBar(ITEMS);
    expect(boxes(root).every((b) => b.checked)).toBe(true);
  });

  it('取消勾选的那条不许混进放行清单', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    const [first] = boxes(prompt.root);
    first!.checked = false;
    first!.dispatchEvent(new Event('change'));

    button(prompt.root, '勾选这').click();
    await expect(prompt.decision).resolves.toEqual({ kind: 'released', releasedIds: ['b', 'c'] });
  });

  it('全部取消后主按钮禁用，点它也不放行', async () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    for (const box of boxes(prompt.root)) {
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    }
    const primary = button(prompt.root, '未选任何一条');
    expect(primary.disabled).toBe(true);
    primary.click();

    prompt.dismiss();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  it('按钮上写的是实时条数——用户看得见自己在放行几条', () => {
    const prompt = showAttestationConfirmBar(ITEMS);
    expect(button(prompt.root, '勾选这').textContent).toBe('勾选这 3 条');
    const [first] = boxes(prompt.root);
    first!.checked = false;
    first!.dispatchEvent(new Event('change'));
    expect(button(prompt.root, '勾选这').textContent).toBe('勾选这 2 条');
  });
});

describe('宿主与 Data-L1 边界', () => {
  it('只新增一个自有容器，宿主 body 原样', () => {
    document.body.innerHTML = '<form id="host-form"><input id="email" /></form>';
    const before = document.body.innerHTML;
    showAttestationConfirmBar(ITEMS);
    expect(document.body.innerHTML).toBe(before);
    expect(document.getElementById('edaix-attestation-confirm-bar')).not.toBeNull();
  });

  it('shadow root 是 closed——宿主页遍历 DOM 取不到内容', () => {
    showAttestationConfirmBar(ITEMS);
    const host = document.getElementById('edaix-attestation-confirm-bar');
    expect(host?.shadowRoot, 'shadow root 不是 closed，宿主页能读到声明原文').toBeNull();
  });

  it('单实例：再弹一次替换旧条', () => {
    showAttestationConfirmBar(ITEMS);
    showAttestationConfirmBar(ITEMS);
    expect(document.querySelectorAll('#edaix-attestation-confirm-bar')).toHaveLength(1);
  });

  it('旧条被替换时也 settle 成 declined（不留悬空 Promise）', async () => {
    const first = showAttestationConfirmBar(ITEMS);
    showAttestationConfirmBar(ITEMS);
    await expect(first.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  /**
   * 铁律 1 的行为测试。探针：在渲染循环里加一行
   * `console.log(item.declarationText)`——本条会红。
   */
  it('整个生命周期里，声明原文一个字都不进 console', async () => {
    const spy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };

    const prompt = showAttestationConfirmBar(ITEMS);
    boxes(prompt.root)[0]!.dispatchEvent(new Event('change'));
    button(prompt.root, '勾选这').click();
    await prompt.decision;

    const said = Object.values(spy)
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    for (const item of ITEMS) {
      expect(said, `声明原文进了 console——铁律 1`).not.toContain(item.declarationText);
    }
  });
});

/**
 * 输入边界：整批校验，不静默去重。
 *
 * Yiwen 与 Vivian **各自独立**做 hostile probe 抓到同一个洞
 * （2026-08-18 审 PR #21），两条都实测复现过。
 *
 * ⚠️ 关键在于**不渲染**——不是「渲染了但返回 declined」。
 * 渲染出来用户就会看到一个可点的确认条，点了却什么都不发生，
 * 那是另一种失败（用户以为放行了）。
 */
describe('输入边界：整批不合法就连界面都不渲染', () => {
  const REAL = 'I certify that the information provided is accurate and complete.';

  it.each([
    [
      '重复 id：用户取消第一条、保留第二条，绝不能返回合并后的那一个',
      [
        { id: 'same', declarationText: `${REAL} (one)` },
        { id: 'same', declarationText: `${REAL} (two)` },
      ],
    ],
    ['空白 id', [{ id: '   ', declarationText: REAL }]],
    ['空 id', [{ id: '', declarationText: REAL }]],
    ['空白原文：用户没看到任何声明，不许产生放行结果', [{ id: 'blank', declarationText: '   ' }]],
    ['空原文', [{ id: 'empty', declarationText: '' }]],
    ['一条合法一条空白：整批拒，不许只放行合法那条', [
      { id: 'ok', declarationText: REAL },
      { id: 'bad', declarationText: '  ' },
    ]],
  ])('%s', async (_name, items) => {
    const prompt = showAttestationConfirmBar(items as AttestationItem[]);
    expect(
      document.getElementById('edaix-attestation-confirm-bar'),
      '不合法的批次仍然渲染了——用户会看到一个点了不起作用的确认条',
    ).toBeNull();
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  /**
   * 正向对照：防止校验写得太严把正常批次也拒了。
   * 没有这一组，把 `batchRejection` 改成 `return 'ALWAYS'` 上面全绿，
   * 而整个功能当场失效。
   */
  it('合法的多条批次照常渲染并可放行', async () => {
    const prompt = showAttestationConfirmBar([
      { id: 'a', declarationText: `${REAL} (a)` },
      { id: 'b', declarationText: `${REAL} (b)` },
    ]);
    expect(document.getElementById('edaix-attestation-confirm-bar')).not.toBeNull();
    button(prompt.root, '勾选这').click();
    await expect(prompt.decision).resolves.toEqual({
      kind: 'released',
      releasedIds: ['a', 'b'],
    });
  });
});

/**
 * 生命周期：一定要收口。
 *
 * Vivian 审查（2026-08-18）的 hostile lifecycle probe——宿主 ATS 的 SPA 清理
 * 或 DOM sanitizer 直接 `host.remove()`：确认条从屏幕上消失，
 * 但 `decision` **永远不 settle**，调用方 `await` 它就是**永久卡住**。
 *
 * 这是本模块最坏的失败形态：不是写错东西，是**什么都不发生且没人知道**。
 * 阻塞式设计必须保证「一定会收口」，否则阻塞就变成挂死。
 */
describe('生命周期：宿主拆掉我们的节点也必须收口', () => {
  const REAL = 'I certify that the information provided is accurate and complete.';

  it('宿主移除 host → declined，不悬空', async () => {
    const prompt = showAttestationConfirmBar([{ id: 'a', declarationText: REAL }]);
    const host = document.getElementById('edaix-attestation-confirm-bar');
    expect(host, '容器没挂上，这条测的不是同一件事').not.toBeNull();

    host!.remove(); // 模拟宿主 SPA 清理
    await new Promise((r) => setTimeout(r, 0)); // 等 MutationObserver 派发

    await expect(prompt.decision).resolves.toMatchObject({ kind: 'declined' });
  });

  it('宿主先把 host 移出自有挂载点、再删除 → declined，不失去追踪', async () => {
    const prompt = showAttestationConfirmBar([{ id: 'a', declarationText: REAL }]);
    const host = document.getElementById('edaix-attestation-confirm-bar');
    expect(host, '容器没挂上，这条测的不是同一件事').not.toBeNull();

    document.body.append(host!); // ATS sanitizer 先 reparent，observer 此时仍能看到 removal
    await new Promise((r) => setTimeout(r, 0)); // 让 documentElement observer 先处理 reparent
    host!.remove(); // 后续删除发生在 body；旧 observer 已经看不到
    await new Promise((r) => setTimeout(r, 0));

    const pending = Symbol('decision-still-pending');
    const decision = await Promise.race([prompt.decision, Promise.resolve(pending)]);
    if (decision === pending) prompt.dismiss(); // 失败时也清掉模块级 lifecycle，避免污染后续用例

    expect(decision, 'reparent 后 observer 丢失 host，decision 永久悬空').toEqual({
      kind: 'declined',
      reason: 'HOST_REMOVED',
    });
  });

  it('被别人摘掉不算用户放行——即便当时所有条目都勾着', async () => {
    // 默认全勾（§4.5.2 默认开）。摘掉节点绝不能被读成「用户确认了」。
    const prompt = showAttestationConfirmBar([
      { id: 'a', declarationText: `${REAL} (a)` },
      { id: 'b', declarationText: `${REAL} (b)` },
    ]);
    document.getElementById('edaix-attestation-confirm-bar')!.remove();
    await new Promise((r) => setTimeout(r, 0));

    const decision = await prompt.decision;
    expect(decision.kind, '宿主摘掉节点却返回了 released').toBe('declined');
    expect(decision).not.toHaveProperty('releasedIds');
  });

  it('正常路径不受影响：观察器不会把自己的拆除误判成宿主拆除', async () => {
    // dismiss() 自己也会 host.remove()。没有这条，观察器可能二次 settle
    // 或把用户的 released 覆盖成 declined。
    const prompt = showAttestationConfirmBar([{ id: 'a', declarationText: REAL }]);
    button(prompt.root, '勾选这').click();
    await new Promise((r) => setTimeout(r, 0));
    await expect(prompt.decision).resolves.toEqual({ kind: 'released', releasedIds: ['a'] });
  });
});

/**
 * 形状校验：items 将来由宿主 DOM 抽取器产生，是**不可信输入**。
 *
 * Vivian 实测：传 `[null]` 时 `item.id?.trim()` **同步抛 TypeError**——
 * 异常从 content-script 的安全边界逃逸，而不是整批 fail-closed。
 * 安全边界不该靠调用方守类型。
 */
describe('形状校验：畸形输入整批 declined，不许抛异常', () => {
  it.each([
    ['null 元素', [null]],
    ['undefined 元素', [undefined]],
    ['字符串而不是对象', ['I certify…']],
    ['id 不是字符串', [{ id: 123, declarationText: 'I certify that this is accurate.' }]],
    ['declarationText 不是字符串', [{ id: 'a', declarationText: null }]],
    ['整个 items 不是数组', 'not-an-array'],
  ])('%s', async (_name, bad) => {
    let prompt: ReturnType<typeof showAttestationConfirmBar> | undefined;
    expect(() => {
      prompt = showAttestationConfirmBar(bad as never);
    }, '畸形输入抛异常了——异常从安全边界逃逸，而不是 fail-closed').not.toThrow();
    expect(document.getElementById('edaix-attestation-confirm-bar')).toBeNull();
    await expect(prompt!.decision).resolves.toMatchObject({ kind: 'declined' });
  });
});
