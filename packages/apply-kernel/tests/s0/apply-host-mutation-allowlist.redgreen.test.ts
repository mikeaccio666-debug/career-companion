import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../../src/engine';
import { runApplyPlan } from '../../src/runner';
import { createUndoJournal } from '../../src/undo';
import {
  ALLOWED_WRITE_PROPS,
  COMBOBOX_DISMISS_EVENTS,
  COMBOBOX_DISMISS_KEY,
  EVENT_PROFILES,
  HOST_EVENTS,
  TYPEAHEAD_SEARCH_EVENTS,
  TYPED_TAIL_EVENTS,
  SEARCH_PROMPT_SUBMIT_EVENTS,
} from '../../src/write/allowlist';
import { readApplyForm } from '../../src/registry';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';
import { installBundledApplyAdapters } from '../../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * S0 闸门：铁律 3 autofill 例外的**写入白名单**。
 *
 * ⚠️ 这个文件的来历必须写清楚：CLAUDE.md:52、docs/DESIGN-DECISIONS.md:129、
 * docs/AUTOFILL-DESIGN.md:441、docs/AUTOFILL-HANDOFF-2026-07-29.md:96 四处
 * 都声称"写入范围由本文件锁死"——但**本文件在 2026-07-29 之前根本不存在**
 * （架构评审实测：`ls tests/s0/` 14 个文件，零个 apply）。负责人是在
 * "范围被测试锁死"这个前提下批准写宿主表单控件的，而这个前提一直是空头支票。
 *
 * 铁律 3 例外允许的全集：
 *   写属性 —— value / selectedIndex / checked / files
 *   派事件 —— input / change / blur / focusout **+ keydown / keyup**
 * 除此之外一律禁止：不得增删或重排宿主节点、不得改写宿主属性 / 样式 / class、
 * 不得对宿主控件派发 submit。且每次写入必须先记录原值、可完整还原。
 *
 * ## 2026-09-15 两处显式扩权（都不是删测试，是改测试）
 *
 * **一、`HOST_EVENTS` 增加 `keydown` / `keyup`。**
 * 触发源：jobs.lever.co/palantir/ac978161-…/apply 的「Current location」。厂商脚本
 * 只在 input 的 keydown 处理器里（去抖 500ms）发起 `/searchLocations`；原生 setter
 * 加 `input` 事件 3.5s 内零建议、零请求，补一对 keydown/keyup 后 0.8s 出 5 条。
 * 没有这一对，这一栏只能永远报手动。
 * 收窄方式：唯一的派发口是 `write/allowlist.ts` 的 `dispatchTypeaheadSearchKey`，
 * 唯一的调用方是 `write/typeaheadCombobox.ts`，而那条路径只有规则数据
 * （`typeaheadComboboxes.triggerSelector`）指名的触发器才走得到。普通文本框
 * 一个键盘事件都收不到——本文件下面那条「一次完整填充观测到的事件」断言，
 * 以及 `tests/apply-typeahead-combobox.test.ts` 的同页对照，两边各锁一次。
 *
 * **二、已计划的单选/复选题改由一次原生 `click` 写入。**
 * 触发源：jobs.ashbyhq.com/notion/7793e862-…/application 的两道题。受控宿主的
 * onChange 只从 click 起，属性写入要么当场被刷回（`LATE_REVERTED`），要么更糟——
 * 报成功而答案根本没进去。详见 `tests/apply-choice-native-activation.test.ts`。
 * 收窄方式：唯一的出口是 `click/primitives.ts` 的 `activateReviewedChoiceGroup`，
 * 目标必须是已审阅计划里的那个 `<input type=radio|checkbox>` 本身（`choice-member`
 * 种类，整张静态 deny 表照跑），另需 `set-combobox` 能力位，关掉即回落属性写入。
 * 这是本仓唯一一处不预先 `preventDefault` 的宿主点击，因此激活窗口期间本组表单的
 * `submit` 会被捕获期当场否决。
 *
 * ## 2026-09-17 第三处：combobox 的 dismiss 键（**没有扩权**）
 *
 * 触发源：jobs.ashbyhq.com 的地点框。它的列表 portal 到 body，开着的时候宿主按
 * react-aria 的 `ariaHideOutside` 给弹层之外的每个 field entry 挂 `aria-hidden`
 * （实测当场 22 个）。而 `listboxCombobox` 的失败退出只把输入框里的字恢复回去、
 * 从不关它自己开的那个菜单，于是**隔壁**那个完全可写的简历上传框被判成
 * `TARGET_NOT_WRITABLE`——121 个 posting 的批测里栽了 14 条，与 `CHOICE_NO_DATA`
 * 一一对应，对角线之外零。
 *
 * **闭集一个字没改**：仍然是 `keydown` / `keyup` 两种，仍然只有
 * `write/allowlist.ts` 构造 `KeyboardEvent`。新增的只是第二个用途明确的出口
 * （`dispatchComboboxDismissKey`，键名写死 `Escape`、不接受调用方自带），
 * 唯一调用方 `write/listboxCombobox.ts`，且只在**失败退出**上跑。
 * 两个出口各自的调用方数量由下面那条结构性断言逐个锁住。
 *
 * ## 2026-09-24 第四处：搜索式多选的回车（**没有扩权**）
 *
 * 触发源：Workday My Experience 的 Field of Study 与「Type to Add Skills」（adobe.wd5 测试台实测）：
 * 往框里打字——原生 setter + input、再补一对最后一个字符的按键——一行结果都不出，回车才搜。
 * 闭集同样一个字没改：仍是 `keydown` / `keyup`、仍只有 `write/allowlist.ts` 构造 `KeyboardEvent`。
 * 新增第三个用途明确的出口 `dispatchSearchPromptSubmitKey`，键名写死 `Enter`，唯一调用方
 * `write/searchPrompt.ts`；那一条路只对规则声明的触发器开，且触发器属于任何 `<form>` 时一下都不按。
 *
 * 本文件的 greenhouse 夹具里既没有规则声明的 typeahead，也没有可计划的选择题，
 * 也没有会被打开的 listbox 菜单，所以下面每一条断言仍然逐字成立——
 * 三处扩权都没有放宽这张夹具上的任何一条。
 *
 * 核心判据刻意选了**宿主 DOM 的序列化形态在一次完整填充前后必须逐字节相同**。
 * 这一条比逐个 spy 更强也更难绕过：value / checked / selectedIndex / files 都是
 * **property**，不反射到属性上，所以合法写入天然不改变 outerHTML；而 classList
 * 增删、setAttribute、style 改写、插入或移除节点、重排子节点——全都会改变它。
 * 一条断言覆盖整张禁止清单，且不依赖我们记得去 spy 哪个 API。
 */

const SRC_DIR = resolve(process.cwd(), 'src');

const PROFILE = {
  firstName: 'Alex',
  lastName: 'Rivera',
  email: 'alex@example.com',
  phone: '(555) 555-0123',
  city: 'San Francisco',
  linkedinUrl: 'https://linkedin.com/in/alex',
  portfolioUrl: 'https://alex.example.com',
} as const;

let journal = createUndoJournal();

/** 真实 Greenhouse 结构 + 一个 select、一个 checkbox，覆盖三种写入原语。 */
function mountFixture(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="application-form" class="application--form">
      <label for="first_name">First Name*</label>
      <input id="first_name" type="text" autocomplete="given-name" required />

      <label for="last_name">Last Name*</label>
      <input id="last_name" type="text" autocomplete="family-name" required />

      <label for="email">Email*</label>
      <input id="email" type="text" autocomplete="email" required />

      <label for="phone">Phone</label>
      <input id="phone" type="tel" autocomplete="off" />

      <label for="question_14364081008">LinkedIn Profile</label>
      <input id="question_14364081008" type="text" />

      <label for="question_99">Website / Portfolio</label>
      <input id="question_99" type="text" />

      <label for="question_city">City</label>
      <textarea id="question_city"></textarea>

      <!-- 与上面的 question_city 同键（city）。2026-08-21 起引擎做同节同键仲裁
           （CAP-AF-045），会去重其一——而本夹具的目的恰恰是**两条写入原语都要
           锻炼到**（text 的 value setter 与 select 的 value setter）。
           套独立 fieldset = 不同节各留一个，仲裁语义与测试意图两不误。 -->
      <fieldset><legend>Address</legend>
      <label for="city">City</label>
      <select id="city">
        <option value="">Select…</option>
        <option value="sf">San Francisco</option>
      </select>
      </fieldset>

      <label for="resume">Attach</label>
      <input id="resume" type="file" />

      <label for="country">Country</label>
      <select id="country">
        <option value="">Select…</option>
        <option value="us">United States</option>
      </select>

      <label for="agree">I agree to the terms</label>
      <input id="agree" type="checkbox" />

      <button type="submit">Submit application</button>
      <textarea name="g-recaptcha-response"></textarea>
    </form>`;
  return document.querySelector('form')!;
}

afterEach(() => {
  document.body.innerHTML = '';
  journal = createUndoJournal();
  vi.restoreAllMocks();
});

/** 一次完整填充：读表单 → 生成计划 → 写入。返回写入结果与计划。 */
async function fullFill() {
  const form = readApplyForm('greenhouse');
  expect(form, '适配器读不到这个 fixture，闸门就形同虚设').not.toBeNull();
  const plan = buildApplyPlan(form!, PROFILE);
  expect(plan.entries.length, '计划里一个字段都没有，等于什么都没测').toBeGreaterThan(0);
  return {
    plan,
    run: await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: form!.root,
      policy: testApplyPolicy(),
    }),
  };
}

describe('S0 · 宿主写入白名单（铁律 3 例外）', () => {
  it('一次完整填充不改变宿主 DOM 的序列化形态', async () => {
    const form = mountFixture();
    const before = form.outerHTML;

    await fullFill();

    // 合法写入只碰 property，不反射到属性 —— outerHTML 必须逐字节相同。
    // 任何 classList / setAttribute / style / 插入 / 移除 / 重排都会破坏它。
    expect(form.outerHTML).toBe(before);
  });

  /**
   * 闭集本身逐字锁死，与 `ALLOWED_WRITE_PROPS` 同一纪律：**本行变红是这道闸门
   * 在正常工作**——扩事件权限必须是有人显式改过测试并写下理由（见文件头
   * 「2026-09-15 两处显式扩权」）。
   */
  it('宿主事件闭集逐字锁死，且键盘那一对只有一个派发口', () => {
    expect(HOST_EVENTS).toEqual(['input', 'change', 'blur', 'focusout', 'keydown', 'keyup']);
    expect(TYPEAHEAD_SEARCH_EVENTS).toEqual(['keydown', 'keyup']);
    // 2026-09-17 的 dismiss 信封**没有把闭集变宽**：仍然只有这两种键盘事件，
    // 只是多了一个用途明确、键名写死的出口。键名不接受调用方自带。
    expect(COMBOBOX_DISMISS_EVENTS).toEqual(['keydown', 'keyup']);
    expect(COMBOBOX_DISMISS_KEY).toBe('Escape');
    expect(SEARCH_PROMPT_SUBMIT_EVENTS).toEqual(['keydown', 'keyup']);
    // 键盘事件不属于任何一种控件的信封：`EVENT_PROFILES` 是按 ApplyControlKind
    // 的全量记录，普通文本框走的就是那张表。混进去等于给每个文本框发键盘事件。
    for (const [kind, profile] of Object.entries(EVENT_PROFILES)) {
      for (const type of [...TYPEAHEAD_SEARCH_EVENTS, ...COMBOBOX_DISMISS_EVENTS, ...SEARCH_PROMPT_SUBMIT_EVENTS]) {
        expect(profile as readonly string[], `${kind} 的事件信封里混进了 ${type}`).not.toContain(type);
      }
    }
    expect([...TYPED_TAIL_EVENTS]).toEqual(['change', 'blur', 'focusout']);

    // 结构性收窄：整个 src 树里只有一个地方构造 KeyboardEvent，只有一个地方
    // 构造不预先取消的 click。数到第二个就说明有人另开了一条私路。
    const sources = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(resolve(SRC_DIR, name), 'utf8')] as const);
    expect(
      sources.filter(([, text]) => text.includes('new KeyboardEvent(')).map(([name]) => name),
      '构造键盘事件的地方不止一处',
    ).toEqual(['write/allowlist.ts']);
    // 两个键盘出口各自只有一个调用方：搜索键仍只给规则声明的 typeahead 触发器，
    // dismiss 键只给「开过菜单的那条 listbox combobox 路径」收摊用。
    // 数到第二个就说明有人拿键盘事件去干别的了。
    const callersOf = (name: string) =>
      sources
        .filter(([file, text]) => file !== 'write/allowlist.ts' && text.includes(`${name}(`))
        .map(([file]) => file)
        .sort();
    expect(callersOf('dispatchTypeaheadSearchKey'), '搜索键的调用方不止一处').toEqual([
      'write/typeaheadCombobox.ts',
    ]);
    // 2026-09-28 显式扩一处：通用路上没有规则绑定的 ARIA 下拉（write/ariaComboboxGeneric.ts）同样是「菜单是我们
    // 开的，就由我们关上、并且核实关了」——与 listbox 那条同一个用途、同一个写死键名的出口，闭集没有变宽。
    expect(callersOf('dispatchComboboxDismissKey'), 'dismiss 键的调用方不止一处').toEqual([
      'write/ariaComboboxGeneric.ts',
      'write/listboxCombobox.ts',
    ]);
    expect(callersOf('dispatchSearchPromptSubmitKey'), '回车键的调用方不止一处').toEqual([
      'write/searchPrompt.ts',
    ]);
    expect(
      sources.filter(([, text]) => text.includes("new MouseEvent('click'")).map(([name]) => name).sort(),
      "构造 click 的地方不止 click/primitives.ts 这一个出口",
    ).toEqual(['click/primitives.ts']);
  });

  it('只派发 input / change / blur / focusout，绝不派发 click 或 submit', async () => {
    mountFixture();
    // 用真实的捕获期监听器而不是 spy dispatchEvent：我们要锁的是宿主页面
    // **观测得到**的行为，不是我们内部调用了哪个 API。捕获期能收到 blur /
    // focus 这些不冒泡的事件。
    const seen: string[] = [];
    const WATCHED = [
      'input', 'change', 'blur', 'focusout', 'focus', 'focusin',
      'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'submit', 'keydown', 'keyup', 'keypress', 'beforeinput',
    ];
    const record = (event: Event) => seen.push(event.type);
    for (const type of WATCHED) document.addEventListener(type, record, true);

    try {
      await fullFill();
    } finally {
      for (const type of WATCHED) document.removeEventListener(type, record, true);
    }

    const ALLOWED = new Set(['input', 'change', 'blur', 'focusout']);
    const forbidden = [...new Set(seen)].filter((type) => !ALLOWED.has(type));
    expect(forbidden, `派发了白名单外的事件：${forbidden.join(', ')}`).toEqual([]);
    // 正对照：真的派发过事件，不是因为什么都没跑才"没有违规"。
    expect(seen, '一个事件都没观测到 —— 这条断言等于没跑').toContain('input');
  });

  it('经具体控件原型写值，并严格使用每种控件的事件白名单', async () => {
    mountFixture();
    // happy-dom 的 dispatchEvent / property setter 都在具体元素原型上，不能
    // 只 spy EventTarget.prototype；后者会“观测 0 次却全绿”。
    const inputValue = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
    const textareaValue = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set');
    const selectValue = vi.spyOn(HTMLSelectElement.prototype, 'value', 'set');
    const selectIndex = vi.spyOn(HTMLSelectElement.prototype, 'selectedIndex', 'set');
    const checkboxChecked = vi.spyOn(HTMLInputElement.prototype, 'checked', 'set');
    const inputEvents = vi.spyOn(HTMLInputElement.prototype, 'dispatchEvent');
    const textareaEvents = vi.spyOn(HTMLTextAreaElement.prototype, 'dispatchEvent');
    const selectEvents = vi.spyOn(HTMLSelectElement.prototype, 'dispatchEvent');

    await fullFill();

    expect(ALLOWED_WRITE_PROPS).toEqual([
      'value',
      'selectedIndex',
      // 2026-08-18 显式扩权：铁律 4 原文一直允许这四项，此前只是没有功能用到
      // `checked`。唯一的写入方是 `write/setChecked.ts`（乙档「信息属实」声明），
      // 且它需要 `set-attestation` 能力位，而该位在包内策略里写死 false。
      // **本行变红是这道闸门在正常工作**——扩写入权限必须是有人显式改过测试。
      'checked',
      'files',
    ]);
    expect(inputValue, 'text input 必须走 native value setter').toHaveBeenCalled();
    expect(textareaValue, 'textarea 必须走 native value setter').toHaveBeenCalled();
    expect(selectValue, 'native select 必须走 native value setter').toHaveBeenCalled();
    expect(selectIndex, '正常填充不应退化为 selectedIndex 赋值').not.toHaveBeenCalled();
    expect(checkboxChecked, 'v1 未获批写 checked').not.toHaveBeenCalled();

    const eventTypes = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map(([event]) => (event as Event).type);
    const allEvents = [
      ...eventTypes(inputEvents),
      ...eventTypes(textareaEvents),
      ...eventTypes(selectEvents),
    ];
    expect(allEvents.length, '具体类 dispatchEvent 探针没有观测到任何事件').toBeGreaterThan(0);
    expect(allEvents.every((type) => HOST_EVENTS.includes(type as (typeof HOST_EVENTS)[number]))).toBe(true);
    expect(eventTypes(selectEvents)).toEqual(expect.arrayContaining([...EVENT_PROFILES.select]));
    expect(eventTypes(selectEvents)).not.toContain('blur');
    expect(eventTypes(inputEvents)).toEqual(expect.arrayContaining([...EVENT_PROFILES.text]));
    expect(eventTypes(textareaEvents)).toEqual(expect.arrayContaining([...EVENT_PROFILES.textarea]));
  });

  it('永不调用 click / submit / requestSubmit', async () => {
    mountFixture();
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');

    await fullFill();

    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('永不改写宿主节点的属性 / class / 样式', async () => {
    mountFixture();
    const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
    const removeAttribute = vi.spyOn(Element.prototype, 'removeAttribute');
    // happy-dom 不把 DOMTokenList 挂在全局上，从实例反查原型。
    const tokenListProto = Object.getPrototypeOf(document.body.classList);
    const classAdd = vi.spyOn(tokenListProto, 'add');
    const classRemove = vi.spyOn(tokenListProto, 'remove');
    const classToggle = vi.spyOn(tokenListProto, 'toggle');

    await fullFill();

    expect(setAttribute).not.toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();
    expect(classAdd).not.toHaveBeenCalled();
    expect(classRemove).not.toHaveBeenCalled();
    expect(classToggle).not.toHaveBeenCalled();

    // 反向探针：若这里的 prototype spy 因运行时差异没挂上，canary 会让本
    // 测试失败，而不会把“0 次调用”误当作安全。
    document.querySelector<HTMLInputElement>('#first_name')!.setAttribute('data-s0-canary', '1');
    expect(setAttribute, 'setAttribute canary 未被探针抓到').toHaveBeenCalledTimes(1);
  });

  it('永不增删或重排宿主节点', async () => {
    mountFixture();
    const appendChild = vi.spyOn(Node.prototype, 'appendChild');
    const insertBefore = vi.spyOn(Node.prototype, 'insertBefore');
    const removeChild = vi.spyOn(Node.prototype, 'removeChild');
    const remove = vi.spyOn(Element.prototype, 'remove');

    await fullFill();

    expect(appendChild).not.toHaveBeenCalled();
    expect(insertBefore).not.toHaveBeenCalled();
    expect(removeChild).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('MutationObserver 看到属性 canary，但合法填充不产生宿主结构变更', async () => {
    const form = mountFixture();
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(form, { attributes: true, characterData: true, childList: true, subtree: true });

    try {
      await fullFill();
      await Promise.resolve();
      expect(changes, '合法填充不应改动宿主的 attributes / text / 节点树').toEqual([]);

      document.querySelector<HTMLInputElement>('#first_name')!.setAttribute('data-s0-canary', '1');
      await Promise.resolve();
      expect(changes.some((change) => change.type === 'attributes'), 'MutationObserver canary 未被抓到').toBe(true);
    } finally {
      observer.disconnect();
    }
  });

  it('文件输入框永不被写入（v1 不碰 files）', async () => {
    mountFixture();
    const resume = document.querySelector<HTMLInputElement>('#resume')!;

    const { run } = await fullFill();

    expect(resume.value).toBe('');
    expect(run.results.some((r) => r.ok && r.label.toLowerCase().includes('attach'))).toBe(false);
  });

  it('每一个被写入的字段都可以完整还原（撤销是写入的前置条件）', async () => {
    mountFixture();
    // 预置一个用户已手打的值，验证撤销还原的是**原值**而不是空串。
    const phone = document.querySelector<HTMLInputElement>('#phone')!;
    phone.value = '我自己填的';

    const { run } = await fullFill();
    const written = run.results.filter((r) => r.ok);
    expect(written.length).toBeGreaterThan(0);
    expect(journal.canUndo(), '写入了却没有可撤销的记录 —— 违反铁律 3').toBe(true);

    const restored = journal.undoAll(testAuthority(null, 'undo'));
    expect(restored.restored).toBe(written.length);

    // fillEmptyOnly 默认开，所以用户手打的值本就不该被覆盖。
    expect(phone.value).toBe('我自己填的');
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type=text]')) {
      expect(input.value, `${input.id} 没有被还原`).toBe('');
    }
  });

  it('第二次填充没有可写字段时，不得清空上一轮的撤销记录', async () => {
    mountFixture();
    await fullFill();
    expect(journal.canUndo()).toBe(true);

    // fillEmptyOnly 默认开 ⇒ 字段已经有值 ⇒ 第二次 plan.entries 为空。
    const form = readApplyForm('greenhouse')!;
    const emptyPlan = buildApplyPlan(form, PROFILE);
    expect(emptyPlan.entries).toHaveLength(0);
    await runApplyPlan({
      plan: emptyPlan,
      auth: testAuthority(emptyPlan.fingerprint),
      journal,
      root: form.root,
      policy: testApplyPolicy(),
    });

    // 一个字节都没写，却把 12 条原值扔了 —— 撤销入口永久消失，是真实数据丢失。
    expect(journal.canUndo(), '空跑一轮就丢掉了上一轮的撤销记录').toBe(true);
    expect(journal.undoAll(testAuthority(null, 'undo')).restored).toBeGreaterThan(0);
  });
});
