import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { ADAPTERS } from '../src/bundledAdapters';
import { mintIntentAuthority, type HostWriteAuthority } from '../src/grant';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { isApprovedResumeFileTarget } from '../src/write/setFile';
import { testApplyPolicy } from './helpers/applyTestAuthority';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 我们打开的菜单，必须由我们关上——**失败退出也一样**。
 *
 * 2026-09-17 批测（121 个 Ashby posting，110 条 resumeFile 行）暴露的真实损失：
 * 96 条写上，14 条报 `TARGET_NOT_WRITABLE`。列联表是**完全对角**的——
 *
 * ```
 *   有 CHOICE_NO_DATA ∧ resumeFile 失败   14
 *   无 CHOICE_NO_DATA ∧ resumeFile 写上   96
 *   对角线之外                             0
 * ```
 *
 * 零散点意味着这不是时序抖动（并发下的竞态会把两边抹匀），而是一条确定的因果链。
 * elevenlabs 整块板子 8/8 全失败，notion 8 个里恰好失败 1 个——就是那个 location
 * 没匹配上的 posting；其余 7 个 location 填上了，简历也就填上了。
 *
 * 因果链（2026-09-17 对 jobs.ashbyhq.com/elevenlabs/158034c9…/application 只读实测，
 * 未提交）：Ashby 的 location 是 typeahead listbox combobox，列表 **portal 到 body**、
 * 在 `.ashby-application-form-container` 之外。它一打开，宿主就按 react-aria 的
 * `ariaHideOutside` 给**弹层之外的每一个** `.ashby-application-form-field-entry`
 * 挂上 `aria-hidden="true"`（实测当场 20 个）。而 `_systemfield_resume` 的 field entry
 * 正是其中之一，于是：
 *
 *   isApprovedResumeFileTarget → hasVisibleFileTrigger → hasRenderedTriggerBox
 *     → hasHiddenPresentation 向上走到 field entry 撞见 aria-hidden → fail closed
 *
 * 关键的排除性证据：**几何自始至终没变**（实测 668×120，开与关都一样）。所以这
 * 与「布局没落定」「0/1px 几何」无关——那条假设被同一次测量否掉了。按 Escape 关掉
 * 菜单后 aria-hidden 归零、同一个控件立刻恢复可写。
 *
 * 而 `listboxCombobox.ts` 的成功路径**明确**等菜单关上
 * （`await waitFor(() => !isOpen(owner, listboxOf), waitMs)`），失败路径的 `leave()`
 * 却只把输入框里的字恢复回去、从不关它开的那个菜单。于是一个填不上的地点框，
 * 把它**隔壁那个完全可写的**简历框一起废掉——而给用户看的码是
 * `TARGET_NOT_WRITABLE`，指向一个根本没出问题的控件。
 *
 * 这里不碰 CHOICE_NO_DATA 本身：location 匹不匹配得上是规则／词典的事，另开一条。
 * 本文件只钉一件事——失败退出必须把菜单关上，隔壁字段不受连累。
 */

afterEach(() => {
  document.documentElement.innerHTML = '';
  vi.restoreAllMocks();
});

const PROFILE: ApplyProfileDraft = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.test',
  location: 'Seattle, Washington, United States',
};

const LISTBOX_ID = 'ashby-location-listbox';

interface Box {
  readonly width: number;
  readonly height: number;
  readonly top: number;
}

/** happy-dom 没有布局引擎；只给真实页面上确实可见的那几个元素喂几何。 */
function stubLayout(boxes: ReadonlyMap<Element, Box>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { width: 0, height: 0, top: 0 };
    return {
      width: box.width,
      height: box.height,
      top: box.top,
      left: 0,
      right: box.width,
      bottom: box.top + box.height,
      x: 0,
      y: box.top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/**
 * Ashby 申请表的最小仿制件，结构照 2026-09-16 的真实 DOM 抓取：
 * location 与 resume 是**相邻的两个** `.ashby-application-form-field-entry`。
 *
 * `geocoded` 是这家地理编码接口会回的候选；给空数组就是实测里那 14 行的条件
 * ——列表开了、一个选项都没有。
 */
function mountAshbyForm(geocoded: readonly string[]): void {
  document.documentElement.innerHTML = `
    <body>
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_name">
          <label class="ashby-application-form-question-title" for="_systemfield_name">Name</label>
          <input id="_systemfield_name" name="_systemfield_name" type="text" required />
        </div>
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_email">
          <label class="ashby-application-form-question-title" for="_systemfield_email">Email</label>
          <input id="_systemfield_email" name="_systemfield_email" type="email" required />
        </div>
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_location">
          <label class="ashby-application-form-question-title" for="_systemfield_location">Location</label>
          <div class="_inputContainer_d7ago_28">
            <input class="_input_d7ago_28 ashby-application-form-input-autocomplete"
              placeholder="Start typing..." role="combobox" aria-autocomplete="list"
              aria-haspopup="listbox" aria-expanded="false" />
          </div>
        </div>
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_resume">
          <label class="ashby-application-form-question-title" for="_systemfield_resume">Resume</label>
          <div role="presentation" class="ashby-application-form-input-file">
            <input type="file" id="_systemfield_resume" accept=".pdf,.doc,.docx" required />
            <div class="ashby-application-form-input-file-instructions">Upload File or drag and drop here</div>
          </div>
        </div>
      </div>
    </body>`;

  const trigger = document.querySelector<HTMLInputElement>('input.ashby-application-form-input-autocomplete')!;
  const entries = [...document.querySelectorAll('.ashby-application-form-field-entry')];

  /**
   * react-aria 的 `ariaHideOutside`：列表一开，弹层之外的每个 field entry 都被
   * 标成 aria-hidden，关上再摘掉。这是 2026-09-17 在真实页面上量到的宿主行为，
   * 不是为了造失败编出来的——量到的是 20 个 entry 同时被挂上。
   */
  const hideOutside = (hidden: boolean) => {
    for (const entry of entries) {
      if (hidden) entry.setAttribute('aria-hidden', 'true');
      else entry.removeAttribute('aria-hidden');
    }
  };

  const close = () => {
    document.getElementById(LISTBOX_ID)?.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    hideOutside(false);
  };

  const open = (typed: string) => {
    document.getElementById(LISTBOX_ID)?.remove();
    const listbox = document.createElement('div');
    listbox.id = LISTBOX_ID;
    listbox.setAttribute('role', 'listbox');
    for (const text of geocoded.filter((candidate) => candidate.toLowerCase().includes(typed.toLowerCase()))) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        trigger.value = text;
        close();
      });
      listbox.append(option);
    }
    // 实测：列表 portal 到 body，落在申请容器之外。
    document.body.append(listbox);
    trigger.setAttribute('aria-controls', LISTBOX_ID);
    trigger.setAttribute('aria-expanded', 'true');
    hideOutside(true);
  };

  /**
   * 实测：点击不开列表，输入 1 个字符即开。
   *
   * **把字清空并不关列表**——2026-09-17 在真实页面上照 `typeIntoTrigger` 原样
   * 复现过一次（原生 setter + `deleteContentBackward` 的 InputEvent）：
   * 清空前 aria-expanded=true / 1 个 listbox / 22 个 aria-hidden，清空后
   * **三个数一个没变**。所以 `leave()` 把字恢复回去，并不顺带把菜单收掉；
   * 仿制件如果在这里自己关掉，就把要测的那个缺陷盖住了。
   */
  trigger.addEventListener('input', () => {
    open(trigger.value);
  });
  trigger.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') close();
  });
}

function fileTargetState() {
  const adapter = ADAPTERS['ashby']!;
  const root = adapter.resolveRoot(document)!;
  const resume = document.querySelector<HTMLInputElement>('#_systemfield_resume')!;
  return {
    menuOpen: document.querySelector<HTMLInputElement>('input.ashby-application-form-input-autocomplete')!
      .getAttribute('aria-expanded'),
    listboxes: document.querySelectorAll('[role="listbox"]').length,
    writable: isApprovedResumeFileTarget(resume, root),
  };
}

/**
 * lease 路径的写入票据（`ExecutionIntent → claim → lease`，与线上批测同一条）。
 *
 * 不用手势票据：`AUTHORITY_TTL_MS` 是 5s，而「一个选项都匹配不上」这条路本身就要
 * 走满 widget 预算（1.5s 开 + 2×3s 判空 ≈ 7.5s）。手势票据会先一步过期，
 * resumeFile 就报成 `GESTURE_EXPIRED`——那是测试环境自己的时钟问题，会把要钉的
 * 那个缺陷盖掉。lease 的窗口由服务端时长决定，这里给足。
 */
function leaseAuthority(fingerprint: string | null): HostWriteAuthority {
  const minted = mintIntentAuthority({
    lease: { executionLease: 'test-lease', expiresAtMs: Date.now() + 120_000 },
    purpose: 'fill',
    fingerprint,
    capabilities: new Set(['set-text', 'set-select', 'set-combobox', 'set-file'] as const),
  });
  if (!minted.ok) throw new Error(`test lease authority rejected: ${minted.code}`);
  return minted.value;
}

async function run() {
  const adapter = ADAPTERS['ashby']!;
  const root = adapter.resolveRoot(document);
  expect(root, '适配器没认出 Ashby 申请容器').not.toBeNull();
  const plan = buildApplyPlan(
    { vendor: 'ashby', root: root!, fields: [...adapter.scan(root!)] },
    PROFILE,
    { resumeFileName: 'resume.pdf', resumeHostConfirmed: true },
  );
  const summary = await runApplyPlan({
    plan,
    auth: leaseAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root: root!,
    policy: testApplyPolicy(),
    resolveResumeFile: async () =>
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'resume.pdf', { type: 'application/pdf' }),
    lateRecheckMs: 5,
  });
  return {
    summary,
    byKey: Object.fromEntries(
      summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]),
    ) as Record<string, string>,
  };
}

/**
 * 真实页面上确实渲染出来的那几个盒子（2026-09-17 在 1440×900 下量的）。
 *
 * 简历那栏的**可见触发器就是那个 `<label>Resume</label>`**：原生 input 自己是
 * 1×1（藏在 dropzone 后面），而 dropzone 是 `role="presentation"`、里面没有按钮，
 * 所以 `canUseNativeFileAsOwnTrigger` 与 `isDropzoneSurface` 都不作数——
 * 唯一够得着的证据是那个 label。它被 aria-hidden 压住，这一栏就没有触发器了。
 */
function stubAshbyLayout(): void {
  const boxes = new Map<Element, Box>();
  const q = (selector: string) => document.querySelector(selector)!;
  boxes.set(q('label[for="_systemfield_resume"]'), { width: 668, height: 24, top: 707 });
  boxes.set(q('.ashby-application-form-input-file'), { width: 668, height: 120, top: 739 });
  boxes.set(q('.ashby-application-form-input-file-instructions'), { width: 600, height: 52, top: 773 });
  boxes.set(q('input.ashby-application-form-input-autocomplete'), { width: 668, height: 54, top: 631 });
  stubLayout(boxes);
}

/** 无匹配那条路要把 widget 的等待预算走满（1.5s × 数轮），给足余量。 */
const NO_MATCH_BUDGET_MS = 20_000;

describe('失败退出必须关掉自己开的下拉菜单', () => {
  it('地点匹配得上时，菜单自己关上，隔壁简历框照常可写（对照组）', async () => {
    mountAshbyForm(['Seattle, Washington, United States', 'Portland, Oregon, United States']);
    stubAshbyLayout();
    const { byKey } = await run();

    expect(byKey['location'], '对照组的地点本该填上').toBe('ok');
    expect(byKey['resumeFile'], '对照组的简历本该填上').toBe('ok');
    expect(fileTargetState()).toMatchObject({ menuOpen: 'false', listboxes: 0, writable: true });
  });

  it('地点一个选项都匹配不上时，菜单不许留在开着的状态', async () => {
    mountAshbyForm([]);
    stubAshbyLayout();
    const { byKey } = await run();

    expect(byKey['location'], '这一栏如实报 CHOICE_NO_DATA 是对的，本条不改它').toBe('CHOICE_NO_DATA');
    expect(
      fileTargetState(),
      '我们开的菜单没关上，宿主的 ariaHideOutside 就一直压着整张表',
    ).toMatchObject({ menuOpen: 'false', listboxes: 0 });
  }, NO_MATCH_BUDGET_MS);

  it('地点填不上，不许把隔壁那个完全可写的简历框一起废成 TARGET_NOT_WRITABLE', async () => {
    mountAshbyForm([]);
    stubAshbyLayout();
    const { byKey } = await run();

    expect(byKey['location']).toBe('CHOICE_NO_DATA');
    expect(
      byKey['resumeFile'],
      '2026-09-17 批测那 14 行就是这么来的：简历框自己没有任何毛病，' +
        '是隔壁没关的下拉把它盖成了 aria-hidden',
    ).not.toBe('TARGET_NOT_WRITABLE');
    expect(byKey['resumeFile'], '关掉菜单后它本来就写得进去').toBe('ok');
  }, NO_MATCH_BUDGET_MS);

  it('菜单关上后，同一个简历控件立刻恢复可写——几何从头到尾没变过', async () => {
    mountAshbyForm([]);
    stubAshbyLayout();
    await run();

    const resume = document.querySelector<HTMLInputElement>('#_systemfield_resume')!;
    const dropzone = document.querySelector('.ashby-application-form-input-file')!;
    expect(
      dropzone.getBoundingClientRect().width,
      '几何不是变量：真实页面上开关菜单都是 668×120',
    ).toBe(668);
    expect(resume.closest('.ashby-application-form-field-entry')!.getAttribute('aria-hidden')).toBeNull();
    expect(fileTargetState().writable).toBe(true);
  }, NO_MATCH_BUDGET_MS);
});
