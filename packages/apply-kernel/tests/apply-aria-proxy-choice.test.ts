import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAuditView } from '../src/audit';
import { evaluateClickTarget, REQUIRED_FACTS_BY_KIND, type ClickTargetFacts } from '../src/click/policy';
import type { ApplyFieldDescriptor, ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { buildAnswerPlan, buildApplyPlan, summarizePlan, type BuildPlanOptions } from '../src/engine';
import { describeQuestion } from '../src/questions';
import { runApplyPlan } from '../src/runner';
import { sealScanRootMutationPolicy } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { workableAdapter } from '../src/sites/workable/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * ARIA 代理选择题（2026-09-23）。
 *
 * 两家真实页面上的同一件事，形状照当日只读实测（题目文字全部是合成的，不含任何真实 posting 的原文）：
 *
 *  · **Ashby 是非题**：`div.ashby-application-form-input-yesno` 里两颗 `button[aria-pressed]`
 *    （没有 type 属性、页面上没有 `<form>`，所以 IDL type 是 submit 而 `form === null`），外加一个
 *    `tabindex=-1`、CSS 里 `display:none` 的 checkbox，只镜像「Yes」。必填只画在题干的
 *    `::after { content: "*" }` 上，DOM 里没有任何 required / aria-required。点一下之后宿主**异步**
 *    把被点的那颗翻成 `aria-pressed="true"`、另一颗 `"false"`。
 *  · **Workable 单选题**：`fieldset[role=radiogroup][aria-labelledby]` 里每个选项是
 *    `div[role=radio][aria-checked]`（漫游 tabindex），里面包着 `aria-hidden="true"` + `tabindex=-1`
 *    的原生 radio。宿主只认那个隐藏 radio 上的 click（点代理本身没有任何反应），点完代理的
 *    `aria-checked` 当场翻、隐藏 radio 的 `checked` 要晚一拍。
 *
 * 过去两者在面板上都**不存在**：Ashby 那道题只剩一个被几何蜜罐层判成陷阱的 0×0 checkbox，
 * Workable 的隐藏 radio 被当成 react-select 的占位框整个丢掉。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// —— Ashby ————————————————————————————————————————————————————————————————

const SPONSORSHIP = 'Will you now or in the future require sponsorship for employment visa status?';
const AUTHORIZED = 'Are you legally authorized to work in the United States?';
const OVER_18 = 'Are you at least 18 years of age?';
const UNKNOWN = 'Do you have hands-on experience with the Example Widget framework?';

/** 题干上那个构建哈希 class 的替身：只有它挂着 `::after { content: "*" }`。 */
const REQUIRED_CLASS = 'hashed-required';

function yesNoEntry(path: string, question: string, options: { required?: boolean; pressed?: 'yes' | 'no' } = {}): string {
  const pressed = (option: 'yes' | 'no') => String(options.pressed === option);
  return `
    <div class="ashby-application-form-field-entry" data-field-path="${path}">
      <label class="${options.required === false ? '' : REQUIRED_CLASS} ashby-application-form-question-title" for="${path}">${question}</label>
      <div class="ashby-application-form-input-yesno">
        <button class="ashby-application-form-input-yesno-option" aria-pressed="${pressed('yes')}" data-option="yes">Yes</button>
        <button class="ashby-application-form-input-yesno-option" aria-pressed="${pressed('no')}" data-option="no">No</button>
        <input type="checkbox" tabindex="-1" name="${path}">
      </div>
    </div>`;
}

function mountAshby(entries: string, wrapper: (inner: string) => string = (inner) => inner): void {
  document.body.innerHTML = wrapper(`
    <div class="ashby-application-form-container">
      <div class="ashby-application-form-field-entry" data-field-path="_systemfield_name">
        <label class="${REQUIRED_CLASS} ashby-application-form-question-title" for="_systemfield_name">Name</label>
        <input id="_systemfield_name" name="_systemfield_name" type="text" required>
      </div>
      ${entries}
      <div class="ashby-application-form-field-entry" data-field-path="question_9009">
        <label class="ashby-application-form-question-title" for="question_9009">LinkedIn</label>
        <input id="question_9009" name="question_9009" type="text">
      </div>
    </div>`);
}

/** 生产里是 `getComputedStyle(el, pseudo).content`；happy-dom 不算伪元素，这里按那个 class 回答。 */
const SCAN_OPTIONS: ScanRootOptions = {
  readGeneratedContent: (element, pseudo) =>
    pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
};

function scanAshby(options: ScanRootOptions = SCAN_OPTIONS): ApplyFormDescriptor {
  const root = ashbyAdapter.resolveRoot(document, options);
  if (root === null) throw new Error('ashby root not found');
  return { vendor: 'ashby', root, fields: [...ashbyAdapter.scan(root, options)] };
}

function choiceFields(form: ApplyFormDescriptor): Extract<ApplyFieldDescriptor, { kind: 'choice' }>[] {
  return form.fields.filter((field): field is Extract<ApplyFieldDescriptor, { kind: 'choice' }> => field.kind === 'choice');
}

function optionsOf(field: ApplyFieldDescriptor): string[] {
  return field.kind === 'choice' ? field.choice.options.map((option) => option.label) : [];
}

function yesNoButtons(path: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`[data-field-path="${path}"] button`)];
}

/**
 * 一个像 Ashby 那样的受控宿主：状态只在按钮的 click 里改，**下一个微任务**才把它公布到
 * `aria-pressed` 上（实测同步读仍是旧值），镜像 checkbox 只在答 Yes 时勾上。
 * `flips = false` = 宿主不认这一下（被拒、或者还没水合），公布的状态一动不动。
 */
function ashbyHost(path: string, flips = true) {
  const buttons = yesNoButtons(path);
  const mirror = document.querySelector<HTMLInputElement>(`[data-field-path="${path}"] input[type=checkbox]`)!;
  const hostWrites: string[] = [];
  const clicks: string[] = [];
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      clicks.push(button.textContent ?? '');
      if (!flips) return;
      queueMicrotask(() => {
        buttons.forEach((other, otherIndex) => {
          hostWrites.push(other.textContent ?? '');
          other.setAttribute('aria-pressed', String(otherIndex === index));
        });
        mirror.checked = index === 0;
      });
    });
  });
  return { buttons, mirror, hostWrites, clicks };
}

const AUTHORIZATIONS = [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }] as const;

function planOptions(extra: Partial<BuildPlanOptions> = {}): BuildPlanOptions {
  return {
    capabilities: { 'set-work-authorization': true },
    workAuthorizations: AUTHORIZATIONS,
    jobRegionCode: 'US',
    ...extra,
  };
}

async function run(form: ApplyFormDescriptor, plan: ReturnType<typeof buildApplyPlan>, lateRecheckMs = 5) {
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: form.root,
    policy: testApplyPolicy(),
    readHostValidation: () => ({}),
    lateRecheckMs,
  });
}

describe('Ashby 是非题 · 扫描', () => {
  it('两颗 aria-pressed 按钮是一道单选题：选项 Yes/No，题干来自规则声明的 question scope', () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP) + yesNoEntry('question_1002', UNKNOWN, { required: false }));
    const form = scanAshby();
    const choices = choiceFields(form);
    expect(choices.map((field) => [field.label, optionsOf(field)])).toEqual([
      [SPONSORSHIP, ['Yes', 'No']],
      [UNKNOWN, ['Yes', 'No']],
    ]);
    const [first] = choices;
    expect(first!.choice).toMatchObject({ control: 'proxy', proxy: 'toggle', multiple: false });
    expect(first!.element).toBe(yesNoButtons('question_1001')[0]);
    // 镜像 checkbox 带着这道题的表单名，规则里读属性的那几步读它。
    if (first!.choice.control === 'proxy') expect(first!.choice.nameSource?.getAttribute('name')).toBe('question_1001');
  });

  it('镜像 checkbox 不再是第二个字段，也不挪动别人的序号', () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP));
    const form = scanAshby();
    // 字段：Name、那道是非题、LinkedIn——没有第四个「YesNo」。
    expect(form.fields.map((field) => field.kind)).toEqual(['text', 'choice', 'text']);
    expect(form.fields.some((field) => field.element.localName === 'input' && (field.element as HTMLInputElement).type === 'checkbox')).toBe(false);
    // 镜像仍在身份计数里（它一直都在）：LinkedIn 前面是 Name 与镜像，序号 2。
    expect(form.fields[2]!.signature.core.endsWith('|2')).toBe(true);
    // 代理题有自己的、唯一的序号，不是「被排除」的 -1。
    expect(form.fields[1]!.signature.core).toMatch(/\|0$/);
  });

  it('两道是非题的签名互不相同，点一下之后签名不变', async () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP) + yesNoEntry('question_1002', UNKNOWN));
    const [a, b] = choiceFields(scanAshby());
    expect(a!.signature.core).not.toBe(b!.signature.core);
    yesNoButtons('question_1001')[1]!.setAttribute('aria-pressed', 'true');
    const [again] = choiceFields(scanAshby());
    expect(again!.signature).toEqual(a!.signature);
  });

  it('必填只画在题干的 ::after 上：注入读法时认得出，没有星号的那道照实是选填', () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP) + yesNoEntry('question_1002', UNKNOWN, { required: false }));
    expect(choiceFields(scanAshby()).map((field) => field.required)).toEqual([true, false]);
    // 不注入读法：DOM 里没有任何必填声明，就不假装必填。
    expect(choiceFields(scanAshby({})).map((field) => field.required)).toEqual([false, false]);
  });

  it('按钮在一张表单里、没写 type（点它会提交）：照样列出来，但标成部件托管、绝不写', () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP), (inner) => `<form id="outer">${inner}</form>`);
    const field = scanAshby().fields.find((candidate) => candidate.label === SPONSORSHIP)!;
    expect(field).toMatchObject({ kind: 'unsupported', unsupportedReason: 'WIDGET', required: true });
    const plan = buildApplyPlan(scanAshby(), {}, planOptions());
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped.find((skip) => skip.label === SPONSORSHIP)?.reason).not.toBeUndefined();
  });
});

describe('Ashby 是非题 · 与原生是/否单选同一条键映射', () => {
  it('担保（按岗位国家推断）→ No；工作授权（点名美国）→ Yes；年满 18（档案 over18）→ Yes', () => {
    mountAshby(
      yesNoEntry('question_1001', SPONSORSHIP) +
      yesNoEntry('question_1002', AUTHORIZED) +
      yesNoEntry('question_1003', OVER_18),
    );
    const plan = buildApplyPlan(scanAshby(), { over18: 'true' }, planOptions());
    const byLabel = new Map(plan.entries.map((entry) => [entry.label, entry]));
    expect(byLabel.get(SPONSORSHIP)).toMatchObject({ kind: 'choice', key: 'workSponsorship', value: 'No', inferredRegionCode: 'US' });
    expect(byLabel.get(AUTHORIZED)).toMatchObject({ kind: 'choice', key: 'workAuthorization', value: 'Yes' });
    expect(byLabel.get(OVER_18)).toMatchObject({ kind: 'choice', key: 'over18', value: 'Yes' });
  });

  it('已经按下的（用户或宿主默认）按 fill-first 不覆盖：NOT_EMPTY', () => {
    mountAshby(yesNoEntry('question_1003', OVER_18, { pressed: 'no' }));
    const plan = buildApplyPlan(scanAshby(), { over18: 'true' }, planOptions());
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped.find((skip) => skip.label === OVER_18)).toMatchObject({ reason: 'NOT_EMPTY', required: true });
  });

  it('档案答不了的岗位题：诚实地挂成「需要你」的必填行，问题可在面板里作答', () => {
    mountAshby(yesNoEntry('question_1004', UNKNOWN));
    const form = scanAshby();
    const plan = buildApplyPlan(form, {}, planOptions());
    const skip = plan.skipped.find((item) => item.label === UNKNOWN);
    expect(skip).toMatchObject({ reason: 'CHOICE_NO_DATA', required: true });
    const view = buildAuditView(plan, []);
    expect(view.rows.find((row) => row.label === UNKNOWN)).toMatchObject({ status: 'NEEDS_MANUAL', required: true });
    expect(summarizePlan(plan).requiredTotal).toBe(2); // Name + 这道题
    const field = form.fields.find((candidate) => candidate.label === UNKNOWN)!;
    expect(describeQuestion(field, 'q1')).toMatchObject({
      text: UNKNOWN,
      controlType: 'SINGLE_CHOICE',
      required: true,
      fieldName: 'question_1004',
      options: [{ optionId: 'o0', text: 'Yes' }, { optionId: 'o1', text: 'No' }],
    });
  });
});

describe('Ashby 是非题 · 写入：点那一颗、按宿主公布的状态验', () => {
  it('点被选中的那颗恰好一次，宿主翻了 aria-pressed 才算成功；我们自己一个属性都不写', async () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    const host = ashbyHost('question_1003');
    const setAttribute = vi.spyOn(Element.prototype, 'setAttribute');
    const form = scanAshby();
    const plan = buildApplyPlan(form, { over18: 'true' }, planOptions());
    const summary = await run(form, plan);
    expect(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason])).toEqual([['over18', 'ok']]);
    expect(host.clicks).toEqual(['Yes']);
    expect(host.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    // 每一次 setAttribute 都是宿主替身自己做的（它翻两颗按钮）。
    expect(setAttribute.mock.calls.every(([name]) => name === 'aria-pressed')).toBe(true);
    expect(setAttribute).toHaveBeenCalledTimes(host.hostWrites.length);
  });

  it('答 No：点的是 No 那颗，镜像 checkbox 照宿主的规矩不勾，结果仍按公布的状态判成功', async () => {
    mountAshby(yesNoEntry('question_1001', SPONSORSHIP));
    const host = ashbyHost('question_1001');
    const form = scanAshby();
    const summary = await run(form, buildApplyPlan(form, {}, planOptions()));
    expect(summary.results[0]).toMatchObject({ key: 'workSponsorship', ok: true });
    expect(host.clicks).toEqual(['No']);
    expect(host.mirror.checked).toBe(false);
  });

  it('宿主不翻：如实失败，绝不报成功', async () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    const host = ashbyHost('question_1003', false);
    const form = scanAshby();
    const summary = await run(form, buildApplyPlan(form, { over18: 'true' }, planOptions()));
    expect(host.clicks).toEqual(['Yes']);
    expect(summary.results[0]!.ok).toBe(false);
    expect(summary.filled).toBe(0);
  });

  it('计划之后用户自己先按了一颗：写入期照样 NOT_EMPTY，不点', async () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    const host = ashbyHost('question_1003');
    const form = scanAshby();
    const plan = buildApplyPlan(form, { over18: 'true' }, planOptions());
    host.buttons[1]!.setAttribute('aria-pressed', 'true');
    const summary = await run(form, plan);
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(host.clicks).toEqual([]);
  });

  it('计划之后按钮被挂到一张表单上（会提交）：一下都不点', async () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    document.body.insertAdjacentHTML('beforeend', '<form id="elsewhere"></form>');
    const host = ashbyHost('question_1003');
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.addEventListener('submit', submitted, true);
    const form = scanAshby();
    const plan = buildApplyPlan(form, { over18: 'true' }, planOptions());
    for (const button of host.buttons) button.setAttribute('form', 'elsewhere');
    const summary = await run(form, plan);
    expect(summary.results[0]!.ok).toBe(false);
    expect(host.clicks).toEqual([]);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('计划之后组里多出一颗选项：成员对不上，不点', async () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    const host = ashbyHost('question_1003');
    const form = scanAshby();
    const plan = buildApplyPlan(form, { over18: 'true' }, planOptions());
    host.buttons[1]!.insertAdjacentHTML('afterend', '<button aria-pressed="false">Maybe</button>');
    const summary = await run(form, plan);
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'IDENTITY_CHANGED' });
    expect(host.clicks).toEqual([]);
  });

  it('选项文字像提交／下一步的，点击策略当场拒绝', async () => {
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry" data-field-path="question_2001">
          <label class="ashby-application-form-question-title" for="question_2001">Pick a direction</label>
          <div class="ashby-application-form-input-yesno">
            <button aria-pressed="false">Next</button>
            <button aria-pressed="false">Back</button>
          </div>
        </div>
      </div>`;
    const clicks: string[] = [];
    document.addEventListener('click', (event) => clicks.push((event.target as Element).textContent ?? ''), true);
    const form = scanAshby();
    const field = choiceFields(form)[0]!;
    const plan = buildAnswerPlan(form, [{ questionId: 'dir', element: field.element, value: 'Next' }]);
    const summary = await run(form, plan);
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'CLICK_DENIED' });
    expect(clicks).toEqual([]);
  });

  it('面板里用户亲手作答的答案走同一条路', async () => {
    mountAshby(yesNoEntry('question_1004', UNKNOWN));
    const host = ashbyHost('question_1004');
    const form = scanAshby();
    const field = choiceFields(form)[0]!;
    const plan = buildAnswerPlan(form, [{ questionId: 'exp', element: field.element, value: 'No' }]);
    const summary = await run(form, plan);
    expect(summary.results[0]).toMatchObject({ key: 'question:exp', ok: true });
    expect(host.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });
});

describe('Ashby 是非题 · 扫描封存不把宿主公布状态当结构变化', () => {
  it('aria-pressed 在 true/false 之间翻：不相关；按钮不再是切换按钮：相关', () => {
    mountAshby(yesNoEntry('question_1003', OVER_18));
    const form = scanAshby();
    const policy = sealScanRootMutationPolicy(form.root, { fields: form.fields, rescan: () => ashbyAdapter.scan(form.root, SCAN_OPTIONS) })!;
    expect(policy).not.toBeNull();
    const [yes] = yesNoButtons('question_1003');
    const record = (attributeName: string) => ({ type: 'attributes', target: yes, attributeName } as unknown as MutationRecord);
    yes!.setAttribute('aria-pressed', 'true');
    expect(policy.isRelevant([record('aria-pressed')])).toBe(false);
    expect(policy.isCurrent()).toBe(true);
    yes!.removeAttribute('aria-pressed');
    expect(policy.isRelevant([record('aria-pressed')])).toBe(true);
  });
});

// —— Workable ——————————————————————————————————————————————————————————————

function radioQuestion(id: string, question: string, options: { ariaRequired?: boolean; star?: boolean; checked?: 0 | 1 } = {}): string {
  const aria = options.ariaRequired === true ? 'true' : 'false';
  const option = (index: 0 | 1, text: string, value: string) => `
        <div data-ui="option" role="radio" aria-checked="${options.checked === index}" aria-labelledby="${id}_label radio_label_${id}${index}" tabindex="${index === 0 ? 0 : -1}" id="wrapper_${id}${index}"${options.ariaRequired === true ? ' aria-required="true"' : ''}>
          <label><input type="radio" name="QA_${id}" value="${value}" aria-hidden="true" tabindex="-1" aria-required="${aria}" id="${id}${index}"><div><div><span id="radio_label_${id}${index}">${text}</span></div></div></label>
        </div>`;
  return `
    <div>
      <span>${options.star === false ? '' : '<span><strong>*</strong></span>'}<span><span id="${id}_label"><strong>${question}</strong></span></span></span>
      <div>
        <fieldset role="radiogroup" data-ui="QA_${id}" aria-labelledby="${id}_label">
          ${option(0, 'YES', 'true')}${option(1, 'NO', 'false')}
        </fieldset>
      </div>
    </div>`;
}

const GDPR = 'I have read and accept the Privacy Notice and consent to the processing of my data.';

function mountWorkable(questions: string): void {
  document.body.innerHTML = `
    <main>
      <form data-ui="application-form">
        <label for="firstname"><span><span><strong>*</strong></span><span><span id="firstname_label"><strong>First name</strong></span></span></span></label>
        <input id="firstname" name="firstname" aria-labelledby="firstname_label" required>
        ${questions}
        <div data-ui="gdpr"><label><label data-ui="gdpr"><div aria-labelledby="checkbox_label_g" role="checkbox" aria-checked="false" tabindex="0" id="g"><input tabindex="-1" aria-hidden="true" type="checkbox" name="gdpr"></div><span id="checkbox_label_g"><span>${GDPR}</span></span></label></label></div>
        <button data-ui="apply-button" type="submit">Submit application</button>
      </form>
    </main>`;
}

function scanWorkable(): ApplyFormDescriptor {
  const root = workableAdapter.resolveRoot(document);
  if (root === null) throw new Error('workable root not found');
  return { vendor: 'workable', root, fields: [...workableAdapter.scan(root)] };
}

/**
 * 像 Workable 那样的受控宿主：只在隐藏 radio 的 click 上改状态（并取消它的默认动作），
 * 同步把 `aria-checked` 与漫游 tabindex 公布到代理上，隐藏 radio 的 `checked` 晚一拍才跟上。
 */
function workableHost(id: string) {
  const proxies = [...document.querySelectorAll<HTMLElement>(`fieldset[data-ui="QA_${id}"] [role="radio"]`)];
  const carriers = proxies.map((proxy) => proxy.querySelector('input')!);
  const clicks: string[] = [];
  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (proxies.some((proxy) => proxy === target || proxy.contains(target))) clicks.push(target.localName);
  }, true);
  carriers.forEach((carrier, index) => {
    carrier.addEventListener('click', (event) => {
      event.preventDefault();
      proxies.forEach((proxy, other) => {
        proxy.setAttribute('aria-checked', String(other === index));
        proxy.setAttribute('tabindex', other === index ? '0' : '-1');
      });
      setTimeout(() => carriers.forEach((input, other) => { input.checked = other === index; }), 30);
    });
  });
  return { proxies, carriers, clicks };
}

describe('Workable 单选题（role=radio 代理 + 隐藏原生 radio）', () => {
  it('扫描：隐藏 radio 不再被当成占位框丢掉——整道题以代理出现，题干来自 aria-labelledby', () => {
    mountWorkable(radioQuestion('q1', AUTHORIZED, { ariaRequired: true }));
    const form = scanWorkable();
    const choices = choiceFields(form);
    expect(choices.map((field) => [field.label, optionsOf(field), field.required])).toEqual([
      [AUTHORIZED, ['YES', 'NO'], true],
      [GDPR, [GDPR], false],
    ]);
    const [radio] = choices;
    expect(radio!.choice).toMatchObject({ control: 'proxy', proxy: 'radio', multiple: false });
    if (radio!.choice.control === 'proxy') {
      expect(radio!.choice.options.map((option) => option.carrier?.getAttribute('name'))).toEqual(['QA_q1', 'QA_q1']);
      expect(radio!.choice.nameSource?.name).toBe('QA_q1');
    }
    // 隐藏 radio 自己不是字段。
    expect(form.fields.filter((field) => field.element.localName === 'input' && (field.element as HTMLInputElement).type === 'radio')).toEqual([]);
  });

  it('必填：宿主在代理上声明了 aria-required 就认；都写着 false 时认题干那一行的星号', () => {
    mountWorkable(
      radioQuestion('q1', AUTHORIZED, { ariaRequired: true, star: false }) +
      radioQuestion('q2', UNKNOWN) +
      radioQuestion('q3', OVER_18, { star: false }),
    );
    const required = new Map(choiceFields(scanWorkable()).map((field) => [field.label, field.required]));
    expect(required.get(AUTHORIZED)).toBe(true);
    expect(required.get(UNKNOWN)).toBe(true);
    expect(required.get(OVER_18)).toBe(false);
  });

  it('写入：点的是承载答案的隐藏 radio（宿主只认它），按代理的 aria-checked 验', async () => {
    mountWorkable(radioQuestion('q1', AUTHORIZED, { ariaRequired: true }));
    const host = workableHost('q1');
    const form = scanWorkable();
    const plan = buildApplyPlan(form, {}, planOptions());
    const entry = plan.entries.find((candidate) => candidate.label === AUTHORIZED);
    expect(entry).toMatchObject({ kind: 'choice', key: 'workAuthorization', value: 'YES' });
    const summary = await run(form, { ...plan, entries: plan.entries.filter((candidate) => candidate === entry) });
    expect(summary.results[0]).toMatchObject({ key: 'workAuthorization', ok: true });
    expect(host.clicks).toEqual(['input']);
    expect(host.proxies.map((proxy) => proxy.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('同意隐私条款的单个 checkbox 代理：列出来交还本人，绝不代勾', () => {
    mountWorkable(radioQuestion('q1', AUTHORIZED, { ariaRequired: true }));
    const plan = buildApplyPlan(scanWorkable(), {}, planOptions({ capabilities: { 'set-work-authorization': true, 'sign-on-behalf': true } }));
    expect(plan.entries.some((entry) => entry.label === GDPR)).toBe(false);
    expect(plan.skipped.find((skip) => skip.label === GDPR)?.reason).toBe('MANUAL_ONLY');
  });
});

// —— 点击策略：proxy-option ——————————————————————————————————————————————————

function proxyFacts(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: false,
    kind: 'proxy-option',
    planned: true,
    openedByTransaction: false,
    tagName: 'BUTTON',
    role: undefined,
    inputType: undefined,
    buttonType: '',
    accessibleName: 'YesNo',
    labelText: 'Yes',
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    hrefNavigates: false,
    proxyState: 'aria-pressed',
    formSubmitCapable: false,
    proxyCarrier: 'none',
    ...overrides,
  };
}

describe('点击策略 · proxy-option', () => {
  it('齐全的切换按钮放行；缺任何一项必备事实都拒', () => {
    expect(evaluateClickTarget(proxyFacts())).toEqual({ allowed: true });
    for (const fact of REQUIRED_FACTS_BY_KIND['proxy-option']) {
      const facts = { ...proxyFacts() };
      delete (facts as unknown as Record<string, unknown>)[fact];
      expect(evaluateClickTarget(facts), `漏掉 ${String(fact)} 却放行了`).toEqual({ allowed: false, reason: 'INCOMPLETE_FACTS' });
    }
  });

  it('有表单归属、点了会提交／重置的按钮：一律拒', () => {
    expect(evaluateClickTarget(proxyFacts({ formSubmitCapable: true }))).toEqual({ allowed: false, reason: 'SUBMIT_CONTROL' });
    expect(evaluateClickTarget(proxyFacts({ insideHtmlForm: true }))).toEqual({ allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' });
  });

  it('提交／下一步样子的文字、看不见、禁用：照旧拒', () => {
    expect(evaluateClickTarget(proxyFacts({ labelText: 'Next' }))).toMatchObject({ allowed: false, reason: 'SUBMIT_NAME' });
    expect(evaluateClickTarget(proxyFacts({ labelText: 'Submit' }))).toMatchObject({ allowed: false, reason: 'SUBMIT_NAME' });
    expect(evaluateClickTarget(proxyFacts({ isHidden: true }))).toMatchObject({ allowed: false, reason: 'HIDDEN_CONTROL' });
    expect(evaluateClickTarget(proxyFacts({ isDisabled: true }))).toMatchObject({ allowed: false, reason: 'HIDDEN_CONTROL' });
  });

  it('可读名里带着题干（Workable 的 aria-labelledby 连题带选项）：按题干口径读，「legally」不是法律声明', () => {
    const radio = proxyFacts({
      tagName: 'DIV', role: 'radio', buttonType: null, proxyState: 'aria-checked', proxyCarrier: 'radio',
      accessibleName: `${AUTHORIZED} YES`, labelText: 'YES',
    });
    expect(evaluateClickTarget(radio)).toEqual({ allowed: true });
    // 同意类照旧拒：「consent」「agree」在题干里也算。
    expect(evaluateClickTarget({ ...radio, accessibleName: 'Do you consent to a background check? YES' }))
      .toMatchObject({ allowed: false });
  });

  it('形状对不上：状态属性与标签/角色不一致、承载与角色不一致、原生控件冒充代理，都拒', () => {
    expect(evaluateClickTarget(proxyFacts({ proxyState: null }))).toMatchObject({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(proxyFacts({ tagName: 'DIV' }))).toMatchObject({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(proxyFacts({ proxyCarrier: 'radio' }))).toMatchObject({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(proxyFacts({ tagName: 'DIV', role: 'radio', buttonType: null, proxyState: 'aria-checked', proxyCarrier: 'checkbox' })))
      .toMatchObject({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget(proxyFacts({ tagName: 'INPUT', inputType: 'radio', role: 'radio', buttonType: null, proxyState: 'aria-checked' })))
      .toMatchObject({ allowed: false });
  });
});
