/**
 * 文本框上的日期：档案存 ISO，宿主的掩码要别的写法。
 *
 * 2026-09-22 真实批测（BambooHR 八页，走过「Apply for This Job」那道门之后）：
 * `Date Available` 六次落 `VALUE_COERCED`——我们写进去了，宿主把它改写了，回读
 * 对不上，于是整条判失败。那一栏是 `input[type=text]`，没有 name，只有
 * `placeholder="mm/dd/yyyy"`。
 *
 * ISO 本身没错：`type=date` 只接受它。错的是**把控件形态一概当成 date**——
 * 自由文本框收什么格式，是那一栏自己用 placeholder 说出来的。
 *
 * 集合里的起止日期早就有这套阶梯（dateFormat.ts 的 freeTextCandidates）；
 * 扁平键（earliestStartDate）走的是另一条路，从来只发一个 ISO 串。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFormDescriptor } from '../src/contracts';

/** 一个带 placeholder 的文本框，键已经由规则认到 earliestStartDate。 */
function form(placeholder: string | null, type = 'text'): ApplyFormDescriptor {
  document.body.innerHTML = `<form>
    <label for="d">Date Available</label>
    <input id="d" type="${type}"${placeholder === null ? '' : ` placeholder="${placeholder}"`}>
  </form>`;
  const element = document.querySelector('#d') as HTMLInputElement;
  return {
    vendor: 'bamboohr',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{
      kind: 'text',
      element, key: 'earliestStartDate', label: 'Date Available', required: true, confidence: 1,
      signature: { core: 'form/input:0', labelHint: 'd' },
    }],
  } as never;
}

const written = (placeholder: string | null, type?: string): string | undefined =>
  buildApplyPlan(form(placeholder, type), { earliestStartDate: '2026-11-03' } as never, {
    fillEmptyOnly: false,
  } as never).entries[0]?.value;

afterEach(() => { document.body.innerHTML = ''; });

describe('文本框按它自己说的格式写', () => {
  it('placeholder 是 mm/dd/yyyy → 写 11/03/2026', () => {
    expect(written('mm/dd/yyyy')).toBe('11/03/2026');
  });

  it('大小写与空白不影响判读', () => {
    expect(written('MM / DD / YYYY')).toBe('11/03/2026');
  });

  it('placeholder 是 dd/mm/yyyy → 写 03/11/2026，不写成美式', () => {
    expect(written('dd/mm/yyyy')).toBe('03/11/2026');
  });

  it('placeholder 用短横 → 跟着用短横', () => {
    expect(written('mm-dd-yyyy')).toBe('11-03-2026');
  });
});

describe('没说就不猜', () => {
  // ISO 是唯一无歧义的写法：06/11 在两种 locale 下读法相反。没有掩码提示时，
  // 宁可写那个全世界只有一种读法的串。
  it('没有 placeholder → 照旧 ISO', () => {
    expect(written(null)).toBe('2026-11-03');
  });

  it('placeholder 与日期无关 → 照旧 ISO', () => {
    expect(written('e.g. next Monday')).toBe('2026-11-03');
  });

  // HTML 规范：type=date 只接受 YYYY-MM-DD，写别的会被浏览器静默丢弃。
  // 那一栏就算带了 placeholder 也不能听它的。
  it('type=date 一律 ISO，placeholder 说什么都不听', () => {
    expect(written('mm/dd/yyyy', 'date')).toBe('2026-11-03');
  });
});
