import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 扫描期选项收割与计划期判决（CAP-AF-044 的可落地半条）。
 *
 * 现状：下拉的判决只在写入时发生——用户在预览里看到「City → 下拉」，却看不到
 * 我们打算选什么；NO_OPTION_MATCH / AMBIGUOUS_OPTION 要写完才暴露。预览的信任
 * 价值被砍掉一半，「回读判决 + 可审计」在下拉这一大类控件上兑现不了。
 *
 * 本条把**原生 select** 的判决前移到计划期：读 `element.options` 是纯被动
 * 动作，零 DOM 修改、零事件派发。匹配语义与写入期完全同源（同一个函数），
 * 写入期仍然重匹配一次——计划与写入之间页面可能变，那道保护不动。
 *
 * ## 刻意不做的两半（写明理由，不是漏掉）
 *
 * · **combobox 预开收割**：扫描发生在用户点 Fill **之前**，预开要向宿主派发
 *   合成 mousedown/click——那正是 GESTURE_* 纪律要防的形态（无授权的合成
 *   手势）。写入期的 1500ms 交互预算路径已在管 combobox，此处不越界。
 * · **196 国兜底表**：档案今天没有 country 键（11 键上限，扩键归 T3 的
 *   CAP-AF-018/021/023），表做出来**零消费方**——本仓已为"写好了、单测全绿、
 *   没有调用方"栽过四次，不再造第五个。键落地时随 country 写入链一起做。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = { email: 'ada@example.test', city: 'Seattle' };

function plan(selectHtml: string) {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label><input id="email" type="email" />
      <label for="city_sel">City</label>
      <select id="city_sel">${selectHtml}</select>
    </form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    PROFILE,
  );
}

const cityEntry = (built: ReturnType<typeof plan>) =>
  built.entries.find((entry) => entry.key === 'city');
const citySkip = (built: ReturnType<typeof plan>) =>
  built.skipped.find((item) => item.label.toLowerCase().includes('city'));

describe('select 的计划期判决', () => {
  it('有唯一匹配：进计划，且预览能看到将选中的那一项', () => {
    const built = plan(
      `<option value="">Select…</option>
       <option value="pdx">Portland</option>
       <option value="sea">Seattle</option>`,
    );
    const entry = cityEntry(built);
    expect(entry, 'City select 没进计划').toBeTruthy();
    expect(
      entry!.resolvedOptionText,
      '预览看不到我们打算选什么——用户只能填完才发现选错',
    ).toBe('Seattle');
  });

  it('没有匹配选项：计划期就报 NO_OPTION_MATCH，不进计划', () => {
    const built = plan(
      `<option value="">Select…</option>
       <option value="pdx">Portland</option>
       <option value="aus">Austin</option>`,
    );
    expect(cityEntry(built), '注定写不上的条目仍然进了计划——预览在撒谎').toBeUndefined();
    expect(citySkip(built)?.reason).toBe('NO_OPTION_MATCH');
  });

  it('多个候选歧义：计划期就报 AMBIGUOUS_OPTION，绝不猜', () => {
    // "seattle" 前缀同时命中两项——收起的下拉里猜错一个城市用户根本看不见。
    const built = plan(
      `<option value="">Select…</option>
       <option value="s1">Seattle (WA)</option>
       <option value="s2">Seattle (OR)</option>`,
    );
    expect(cityEntry(built)).toBeUndefined();
    expect(citySkip(built)?.reason).toBe('AMBIGUOUS_OPTION');
  });

  it('按 option 的 DOM value 精确匹配同样成立', () => {
    const built = plan(
      `<option value="">Select…</option>
       <option value="Seattle">Emerald City</option>`,
    );
    const entry = cityEntry(built);
    expect(entry).toBeTruthy();
    // 预览显示用户会看到的文字，不是 DOM value。
    expect(entry!.resolvedOptionText).toBe('Emerald City');
  });

  it('反向探针：文本框条目不携带 resolvedOptionText', () => {
    const built = plan(`<option value="sea">Seattle</option>`);
    const email = built.entries.find((entry) => entry.key === 'email');
    expect(email).toBeTruthy();
    expect(email!.resolvedOptionText, '非 select 条目冒出了选项判决').toBeUndefined();
  });

  it('反向探针：计划期判决是纯读——不改选中项、不派发任何事件', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="city_sel">City</label>
        <select id="city_sel">
          <option value="">Select…</option><option value="sea">Seattle</option>
        </select>
      </form>`;
    const select = document.querySelector<HTMLSelectElement>('#city_sel')!;
    const events: string[] = [];
    for (const type of ['input', 'change', 'mousedown', 'mouseup', 'click', 'focus']) {
      select.addEventListener(type, () => events.push(type));
    }
    const root = greenhouseAdapter.resolveRoot(document)!;
    buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      PROFILE,
    );
    expect(select.selectedIndex, '计划期把选中项改了——预览之前页面就被动过').toBe(0);
    expect(events, '计划期向宿主派发了事件——扫描必须是纯读').toEqual([]);
  });
});
