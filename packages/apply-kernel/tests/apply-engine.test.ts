import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { deriveProfile } from '../src/profileDraft';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { fieldSignature } from '../src/fieldIdentity';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyFieldDescriptor, ApplyFormDescriptor } from '../src/contracts';

/**
 * 引擎 + 执行器。引擎完全不认识任何 ATS，所以这里用手工构造的中立描述符，
 * 而不是某家厂商的 HTML —— 这正是 contracts.ts 那层边界存在的意义。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function input(value = ''): HTMLInputElement {
  const el = document.createElement('input');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

type FixtureField =
  | Omit<Extract<ApplyFieldDescriptor, { kind: 'text' }>, 'signature'>
  | Omit<Extract<ApplyFieldDescriptor, { kind: 'textarea' }>, 'signature'>
  | Omit<Extract<ApplyFieldDescriptor, { kind: 'select' }>, 'signature'>
  | Omit<Extract<ApplyFieldDescriptor, { kind: 'unsupported' }>, 'signature'>;

function form(fields: readonly FixtureField[]): ApplyFormDescriptor {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    root,
    fields: fields.map((field) => ({ ...field, signature: fieldSignature(field.element, root) })) as ApplyFieldDescriptor[],
  };
}

describe('deriveProfile', () => {
  it('从姓+名推出全名（Lever 只有一个 name 字段）', () => {
    expect(deriveProfile({ firstName: 'Ke', lastName: 'Chen' }).fullName).toBe('Ke Chen');
  });

  it('从全名拆出姓和名（Greenhouse 要拆开）', () => {
    const derived = deriveProfile({ fullName: 'Ke Chen' });
    expect(derived.firstName).toBe('Ke');
    expect(derived.lastName).toBe('Chen');
  });

  it('不覆盖用户已经填好的值', () => {
    const derived = deriveProfile({ fullName: 'Ke Chen', firstName: '柯' });
    expect(derived.firstName).toBe('柯');
  });
});

describe('buildApplyPlan', () => {
  it('把高置信度且有值的字段放进计划', () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{ key: 'email', kind: 'text', element: el, label: 'Email', required: true, confidence: 1 }]),
      { email: 'a@b.com' },
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].kind).toBe('text');
    expect(plan.entries[0].value).toBe('a@b.com');
    expect(plan.fingerprint).not.toContain('a@b.com');
  });

  it('默认只填空字段——绝不覆盖用户已手打的内容', () => {
    const el = input('已经手动填过');
    const plan = buildApplyPlan(
      form([{ key: 'email', kind: 'text', element: el, label: 'Email', required: true, confidence: 1 }]),
      { email: 'a@b.com' },
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('NOT_EMPTY');
  });

  it('显式关掉 fillEmptyOnly 时才允许覆盖', () => {
    const el = input('旧值');
    const plan = buildApplyPlan(
      form([{ key: 'email', kind: 'text', element: el, label: 'Email', required: true, confidence: 1 }]),
      { email: 'a@b.com' },
      { fillEmptyOnly: false },
    );
    expect(plan.entries).toHaveLength(1);
  });

  it('置信度不足就不写，只报 LOW_CONFIDENCE', () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{ key: 'phone', kind: 'text', element: el, label: '某个字段', required: false, confidence: 0.4 }]),
      { phone: '123' },
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('LOW_CONFIDENCE');
  });

  it('资料里没有的字段报 NO_VALUE，而不是填空字符串', () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{ key: 'githubUrl', kind: 'text', element: el, label: 'GitHub', required: false, confidence: 1 }]),
      {},
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('NO_VALUE');
  });

  it('不认识的字段一律不猜（key 为 null）', () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{ key: null, kind: 'text', element: el, label: '你为什么想加入我们？', required: false, confidence: 0 }]),
      { email: 'a@b.com' },
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('LOW_CONFIDENCE');
  });

  it('不支持的控件（下拉搜索框/文件）报 UNSUPPORTED_CONTROL —— v1 零点击', () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{
        key: null,
        kind: 'unsupported',
        element: el,
        label: 'Country',
        required: true,
        confidence: 0,
        unsupportedReason: 'CONTROL_TYPE',
      }]),
      {},
    );
    expect(plan.skipped[0].reason).toBe('UNSUPPORTED_CONTROL');
    expect(summarizePlan(plan).manual).toBe(1);
  });

  it('汇总把"待复核"和"需手动"分开计数', () => {
    const plan = buildApplyPlan(
      form([
        { key: 'email', kind: 'text', element: input(), label: 'Email', required: true, confidence: 1 },
        { key: null, kind: 'text', element: input(), label: '自定义问题', required: false, confidence: 0 },
        {
          key: null,
          kind: 'unsupported',
          element: input(),
          label: '国家下拉',
          required: true,
          confidence: 0,
          unsupportedReason: 'CONTROL_TYPE',
        },
      ]),
      { email: 'a@b.com' },
    );
    expect(summarizePlan(plan)).toEqual({
      willFill: 1,
      missingProfile: 0,
      needsReview: 1,
      jobDependent: 0,
      manual: 1,
      optedOut: 0,
      // 两个必填：email（我们会填）与"国家下拉"（控件类型不支持）。
      // 分母把填不了的那个也算上，正是它的意义所在——用户还差一项才能提交。
      requiredTotal: 2,
      requiredHandled: 1,
    });
  });

  /**
   * 首次使用（资料全空）时，每个认出来的字段都是 NO_VALUE。这必须报成
   * `missingProfile` 而不是 `needsReview`——否则 UI 显示"0 可填 · 8 待复核"，
   * 看起来像插件坏了，实际只是用户还没填资料（owner 截图 2026-07-29）。
   */
  it('资料为空时报 missingProfile，不混进待复核', () => {
    const plan = buildApplyPlan(
      form([
        { key: 'email', kind: 'text', element: input(), label: 'Email', required: true, confidence: 1 },
        { key: 'firstName', kind: 'text', element: input(), label: 'First Name', required: true, confidence: 1 },
        { key: null, kind: 'text', element: input(), label: '自定义问题', required: false, confidence: 0 },
      ]),
      {},
    );
    const summary = summarizePlan(plan);
    expect(summary.missingProfile).toBe(2);
    expect(summary.needsReview).toBe(1);
    expect(summary.willFill).toBe(0);
  });
});

describe('runApplyPlan', () => {
  it('写入计划内的字段并汇报成功数', async () => {
    const email = input();
    const plan = buildApplyPlan(
      form([{ key: 'email', kind: 'text', element: email, label: 'Email', required: true, confidence: 1 }]),
      { email: 'a@b.com' },
    );
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(summary.filled).toBe(1);
    expect(email.value).toBe('a@b.com');
  });

  it('单项失败不中断整轮，并给出可区分的原因', async () => {
    const good = input();
    const select = document.createElement('select');
    // 占位项在前：无占位项的 select 会自动选中第一项，被 fillEmptyOnly 判成
    // NOT_EMPTY——真实表单（含本仓 greenhouse 夹具）都有 value="" 的占位项。
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.text = 'Select…';
    const option = document.createElement('option');
    option.value = 'sea';
    option.text = 'Seattle';
    select.append(placeholder, option);
    document.body.appendChild(select);
    const plan = buildApplyPlan(
      form([
        { key: 'email', kind: 'text', element: good, label: 'Email', required: true, confidence: 1 },
        { key: 'city', kind: 'select', element: select, label: 'City', required: true, confidence: 1 },
      ]),
      { email: 'a@b.com', city: 'Seattle' },
    );
    // 2026-08-21 起 select 的判决前移到计划期（CAP-AF-044）：一个空 select
    // 现在根本进不了计划，本测试原来的形态（无 option）测不到 runner 了。
    // 改成**计划后页面变了**：计划期解析成功，写入前把选项删掉——写入期的
    // 重匹配保护必须接住它。这同时锁住"写入期仍重匹配"这道防线本身。
    select.removeChild(option);
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(summary.filled).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r) => !r.ok)?.reason).toBe('NO_OPTION_MATCH');
    expect(good.value).toBe('a@b.com');
  });

  it('宿主在确认前重渲染掉的字段报 DETACHED，不抛错', async () => {
    const el = input();
    const plan = buildApplyPlan(
      form([{ key: 'email', kind: 'text', element: el, label: 'Email', required: true, confidence: 1 }]),
      { email: 'a@b.com' },
    );
    el.remove();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'DETACHED' });
  });

  it('整轮之后 Undo 能完整还原', async () => {
    const first = input('原本的名字');
    const plan = buildApplyPlan(
      form([{ key: 'firstName', kind: 'text', element: first, label: 'First', required: true, confidence: 1 }]),
      { firstName: 'Ke' },
      { fillEmptyOnly: false },
    );
    const journal = createUndoJournal();
    await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(first.value).toBe('Ke');
    expect(journal.undoAll(testAuthority(null, 'undo')).restored).toBe(1);
    expect(first.value).toBe('原本的名字');
  });

  it('select 按显示文本匹配时，Undo 以控件实际 value 判断用户后续编辑', async () => {
    const country = document.createElement('select');
    country.innerHTML = `
      <option value="">Select…</option>
      <option value="us">United States</option>
    `;
    document.body.appendChild(country);
    const plan = buildApplyPlan(
      form([{ key: 'city', kind: 'select', element: country, label: 'Country', required: true, confidence: 1 }]),
      { city: 'United States' },
    );
    const journal = createUndoJournal();

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(run.filled).toBe(1);
    expect(country.value).toBe('us');

    const restored = journal.undoAll(testAuthority(null, 'undo'));
    expect(restored).toMatchObject({ restored: 1, skippedUserEdited: 0 });
    expect(country.value).toBe('');
  });
});
