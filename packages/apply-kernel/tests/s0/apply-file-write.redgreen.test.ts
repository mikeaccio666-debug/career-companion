import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachHostFile } from '../../src/write/setFile';
import { consumeAuthority } from '../../src/grant';
import { createBundledApplyPolicy } from '../../src/policy';
import { createUndoJournal } from '../../src/undo';
import { createScanRoot } from '../../src/scanRoot';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

/**
 * S0 · 简历文件写入的边界。
 *
 * 为什么做这个而不是原计划的单选/复选/日期：2026-08-01 在两张真实申请表上数过——
 * Greenhouse 那张**零单选、零复选、零日期**；Lever 那张的 11 个复选框全是
 * `name="pronouns"`（代词）、3 个单选是 EEO 人口统计（Female/Male/Prefer not to answer）。
 * 这两类控件的范围见 16 号裁决授权卡 A 栏。排在简历文件后面纯粹是因为我们的 11 键
 * 档案里没有对应数据，支持了也填不上任何东西——那会是这个项目第四次"守卫写好了
 * 没有调用方"。EEO 的**作答内容**另属未决项，见授权卡 E 栏。
 * （2026-08-03 更正过此处的旧表述。）
 *
 * 唯一有真实价值的是**简历文件**：它在几乎每张表上都是必填或准必填，
 * 也是用户唯一必须手动做的事。实测两家都接受标准的 `DataTransfer` 写入
 * （`input.files = dt.files` + `change`），宿主自己的 UI 会渲染出文件名——
 * **不需要 `chrome.debugger`**（Simplify 为此申请了那个权限，至少在这两家上是多余的）。
 *
 * 本文件锁死的边界：
 *   1. 绝不覆盖用户已经挂上的文件；
 *   2. `set-file` 是独立能力，可被远程策略单独关掉；
 *   3. 不符合 `accept` 的文件不写（宿主会当场拒绝，写了等于制造一个假"已填"）；
 *   4. 撤销必须真的能清空。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function fileInput(attrs = ''): HTMLInputElement {
  document.body.innerHTML = `<form id="application-form"><input id="resume" type="file" ${attrs} /></form>`;
  const input = document.getElementById('resume') as HTMLInputElement;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    width: 230,
    height: 40,
    top: 300,
    left: 0,
    right: 230,
    bottom: 340,
    x: 0,
    y: 300,
    toJSON: () => ({}),
  } as DOMRect);
  return input;
}

function pdf(name = 'resume.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });
}

function activeAuthority(capabilities: readonly string[] = ['set-file']) {
  const authority = testAuthority('file-plan', 'fill', capabilities as never);
  expect(consumeAuthority(authority).ok, '测试前置：授权没能进入运行态').toBe(true);
  return authority;
}

describe('S0 · 简历文件写入', () => {
  it('空的文件控件可以写入，并派发 change', () => {
    const input = fileInput();
    const seen: string[] = [];
    for (const type of ['input', 'change']) input.addEventListener(type, () => seen.push(type));

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok, `写入失败：${result.ok ? '' : result.code}`).toBe(true);
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0]?.name).toBe('resume.pdf');
    expect(seen, '宿主没有收到 change —— 很多站点靠它才认这个文件').toContain('change');
  });

  /**
   * **绝不覆盖用户已经挂上的文件。** 这是本模块最重要的一条：用户可能刚传了一份
   * 为这个岗位改过的简历，被我们用"当前默认简历"覆盖掉，而且**文件覆盖没有撤销可言**
   * ——原来那个 File 对象在页面里已经没有引用了。
   */
  it('已经有文件时绝不覆盖', () => {
    const input = fileInput();
    const existing = new DataTransfer();
    existing.items.add(pdf('user-tailored.pdf'));
    input.files = existing.files;

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf('ours.pdf'),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('NOT_EMPTY');
    expect(input.files?.[0]?.name, '用户自己传的文件被覆盖了').toBe('user-tailored.pdf');
  });

  /**
   * `accept` 不匹配时不写。宿主会当场拒绝这个文件，而我们的面板会显示"已填"——
   * 制造一个假的成功比不填更糟。实测 Greenhouse 的 accept 是
   * `.pdf,.doc,.docx,.txt,.rtf`。
   */
  it('不符合 accept 的文件不写', () => {
    const input = fileInput('accept=".pdf,.doc,.docx"');
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: new File(['x'], 'resume.png', { type: 'image/png' }),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('VALUE_COERCED');
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('accept 匹配（含 MIME 通配）时正常写入', () => {
    for (const [accept, name, type] of [
      ['.pdf,.doc,.docx', 'r.pdf', 'application/pdf'],
      ['application/pdf', 'r.pdf', 'application/pdf'],
      ['application/*', 'r.pdf', 'application/pdf'],
      ['', 'r.pdf', 'application/pdf'],
    ] as const) {
      const input = fileInput(accept ? `accept="${accept}"` : '');
      const result = attachHostFile({
        element: input,
        root: createScanRoot(input.closest('form')!, []),
        file: new File(['x'], name, { type }),
        authority: activeAuthority(),
        ticket: createUndoJournal().record(input),
        policy: testApplyPolicy(),
      });
      expect(result.ok, `accept="${accept}" 被误拒`).toBe(true);
    }
  });

  it('宿主 change 处理器清掉文件时不冒充成功', () => {
    const input = fileInput();
    input.addEventListener(
      'change',
      () => {
        input.files = new DataTransfer().files;
      },
      { once: true },
    );
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('VALUE_COERCED');
    expect(input.files).toHaveLength(0);
  });

  it('宿主在 change 处理器里卸掉控件即视为已收下文件（Greenhouse 实测形状）', () => {
    const input = fileInput();
    const root = createScanRoot(input.closest('form')!, []);
    let received = 0;
    input.addEventListener(
      'change',
      () => {
        received = input.files?.length ?? 0;
        input.remove();
      },
      { once: true },
    );

    const result = attachHostFile({
      element: input,
      root,
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(received, '宿主在 change 里已经拿到了文件').toBe(1);
    expect(result.ok, '宿主换掉控件是收下文件的正常形状，不是丢失').toBe(true);
  });

  it('宿主 change 处理器替换 FileList 时失败并回滚到原 empty', () => {
    const input = fileInput();
    input.addEventListener(
      'change',
      () => {
        const replacement = new DataTransfer();
        replacement.items.add(pdf('host-replacement.pdf'));
        input.files = replacement.files;
      },
      { once: true },
    );

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('VALUE_COERCED');
    expect(input.files, '失败后留下了无 Undo 的宿主替换文件').toHaveLength(0);
  });

  it('宿主 change 处理器向 FileList 追加文件时失败并回滚到原 empty', () => {
    const input = fileInput();
    input.addEventListener(
      'change',
      () => {
        const ours = input.files?.[0];
        if (!ours) return;
        const appended = new DataTransfer();
        appended.items.add(ours);
        appended.items.add(pdf('host-appended.pdf'));
        input.files = appended.files;
      },
      { once: true },
    );

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('VALUE_COERCED');
    expect(input.files, '失败后留下了无 Undo 的自身文件').toHaveLength(0);
  });

  it('宿主 change 后移除 Attach 触发器不回滚已经成功挂上的文件', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="field">
          <label class="attach" for="upload-control-17">Resume/CV · Attach</label>
          <input id="upload-control-17" type="file" />
        </div>
      </form>`;
    const input = document.getElementById('upload-control-17') as HTMLInputElement;
    const trigger = document.querySelector('label.attach') as HTMLLabelElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      width: 1, height: 1, top: 300, left: 0, right: 1, bottom: 301, x: 0, y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      width: 230, height: 40, top: 300, left: 0, right: 230, bottom: 340, x: 0, y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    input.addEventListener('change', () => trigger.remove(), { once: true });

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(true);
    expect(input.files?.[0]?.name).toBe('resume.pdf');
  });

  it('宿主 change 后把控件改成非简历身份时失败并回滚', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="upload-control-18">Resume/CV</label>
        <input id="upload-control-18" type="file" />
      </form>`;
    const input = document.getElementById('upload-control-18') as HTMLInputElement;
    const label = document.querySelector('label') as HTMLLabelElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      width: 1, height: 1, top: 300, left: 0, right: 1, bottom: 301, x: 0, y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      width: 230, height: 40, top: 300, left: 0, right: 230, bottom: 340, x: 0, y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    input.addEventListener('change', () => {
      label.textContent = 'Upload transcript';
    }, { once: true });

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('IDENTITY_CHANGED');
    expect(input.files).toHaveLength(0);
  });

  it('宿主 change 后把 accept 改成不兼容类型时失败并回滚', () => {
    const input = fileInput();
    input.addEventListener('change', () => input.setAttribute('accept', 'image/png'), { once: true });

    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('VALUE_COERCED');
    expect(input.files).toHaveLength(0);
  });

  it('撤销派发 change 后宿主同步回填文件时不冒充已还原', () => {
    const input = fileInput();
    const journal = createUndoJournal();
    const ours = pdf('ours.pdf');
    const recorded = journal.record(input);
    const attached = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: ours,
      authority: activeAuthority(),
      ticket: recorded,
      policy: testApplyPolicy(),
    });
    expect(attached.ok).toBe(true);
    if (!recorded.ok) throw new Error('测试前置：未能记录文件写入');
    journal.commitFile(recorded.value, ours);

    input.addEventListener(
      'change',
      () => {
        const refilled = new DataTransfer();
        refilled.items.add(ours);
        input.files = refilled.files;
      },
      { once: true },
    );

    const outcome = journal.undoAll(testAuthority(null, 'undo', ['set-file']));

    expect(input.files?.[0]).toBe(ours);
    expect(outcome).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
  });

  /** `set-file` 是独立能力位：远程策略可以只关掉传简历、保留纯文本填充。 */
  it('没有 set-file 能力时拒绝', () => {
    const input = fileInput();
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(['set-text', 'set-select']),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('CAPABILITY_DISABLED');
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('策略关闭时拒绝', () => {
    const input = fileInput();
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: { ...createBundledApplyPolicy(), enabled: false },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('POLICY_DISABLED');
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('拿不到撤销凭据时一个字节都不写', () => {
    const input = fileInput();
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: { ok: false, code: 'JOURNAL_UNAVAILABLE' },
      policy: testApplyPolicy(),
    });
    expect(result.ok).toBe(false);
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('元素已经离开 DOM 时拒绝', () => {
    const input = fileInput();
    const ticket = createUndoJournal().record(input);
    input.remove();
    const result = attachHostFile({
      element: input,
      root: createScanRoot(document.querySelector('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket,
      policy: testApplyPolicy(),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('DETACHED');
  });

  it.each(['disabled', 'hidden', 'aria-hidden="true"'])('最终写点拒绝 %s 文件控件', (attrs) => {
    const input = fileInput(attrs);
    const result = attachHostFile({
      element: input,
      root: createScanRoot(input.closest('form')!, []),
      file: pdf(),
      authority: activeAuthority(),
      ticket: createUndoJournal().record(input),
      policy: testApplyPolicy(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : null).toBe('IDENTITY_CHANGED');
    expect(input.files).toHaveLength(0);
  });
});
