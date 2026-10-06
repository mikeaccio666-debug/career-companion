/**
 * 学校 typeahead：分隔符不同就整条对不上。
 *
 * 2026-09-22 在 Greenhouse（Discord 8571766002）逐个把档案里的学校打进 School 组合框，
 * 记下它自己 `aria-controls` 那个 listbox 真的回了什么：
 *
 * | 打进去 | 回来的选项 |
 * |---|---|
 * | `University of Illinois at Urbana-Champaign` | `No options` |
 * | `University of Illinois`（去掉 ` at …`） | `University of Illinois - Chicago` / `- Springfield` / `- Urbana-Champaign` |
 * | `University of Washington, Bothell` | `No options` |
 * | `University of Washington`（去掉 `, …`） | `University of Washington` |
 *
 * 两件事同时不成立，所以三段教育里只有一段填得上：
 *
 *  1. **检索词**只会去掉逗号后缀，不会去掉 ` at ` 后缀——而 Greenhouse 那份名单
 *     用的是 `学校 - 校区`，档案里是 `学校 at 校区`。
 *  2. **判定**仍然拿完整候选去比：即使打短了让名单回了 `University of Illinois -
 *     Urbana-Champaign`，`samePlace` 按逗号切段比较，`at Urbana-Champaign` 那一段
 *     对不上，整条判 NO_OPTION_MATCH → 用户看到「这个选项需要你来选」。
 *
 * 面板上那句话是冤枉的：名单里就有他那所学校，只是我们写成了另一种分隔符。
 *
 * 母校兜底（`University of Washington, Bothell` → `University of Washington`）单独
 * 要求「只回了一个选项」且「选项是候选的严格前缀」：名单里没有分校时，母校是唯一
 * 诚实的那一项；名单里同时有母校与分校时，前面两道精确匹配先赢，走不到这里。
 */

import { describe, expect, it } from 'vitest';

import { matchOption, typeaheadQueries } from '../src/write/listboxCombobox';

/** 用真实选项文案造出 `matchOption` 要的 Element 列表。 */
function options(texts: readonly string[]): readonly Element[] {
  const host = document.createElement('div');
  for (const text of texts) {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.textContent = text;
    host.append(row);
  }
  return [...host.children];
}

const pickedText = (match: ReturnType<typeof matchOption>): string | null =>
  match.kind === 'MATCH' ? (match.option.textContent ?? '') : null;

describe('检索词：长名字要能打短', () => {
  it('去掉 ` at 校区` 那一段——Greenhouse 名单用的是「-」', () => {
    expect(typeaheadQueries(['University of Illinois at Urbana-Champaign']))
      .toContain('University of Illinois');
  });

  it('逗号后缀照旧去掉', () => {
    expect(typeaheadQueries(['University of Washington, Bothell']))
      .toContain('University of Washington');
  });

  // 完整候选永远排第一：名单里就有原样那一条时，一次就中，不该先打短的。
  it('完整候选仍然排在最前', () => {
    expect(typeaheadQueries(['University of Chicago'])[0]).toBe('University of Chicago');
  });

  // 地点 typeahead 与学校共用这个函数；「城市, 州」的既有两段不能变。
  it('地点的两段写法不受影响', () => {
    expect(typeaheadQueries(['Birmingham, Alabama'])).toEqual(['Birmingham, Alabama', 'Birmingham']);
  });
});

describe('判定：分隔符不同算同一所学校', () => {
  it('`at Urbana-Champaign` 对上 `- Urbana-Champaign`', () => {
    expect(pickedText(matchOption(
      ['University of Illinois at Urbana-Champaign'],
      options([
        'University of Illinois - Chicago',
        'University of Illinois - Springfield',
        'University of Illinois - Urbana-Champaign',
      ]),
    ))).toBe('University of Illinois - Urbana-Champaign');
  });

  it('名单里只剩母校时，退到母校', () => {
    expect(pickedText(matchOption(
      ['University of Washington, Bothell'],
      options(['University of Washington']),
    ))).toBe('University of Washington');
  });

  it('原样那一条在名单里时照旧一次就中', () => {
    expect(pickedText(matchOption(['University of Chicago'], options(['University of Chicago']))))
      .toBe('University of Chicago');
  });
});

describe('放宽到此为止', () => {
  // 母校兜底只在「恰好一个选项是候选的前缀」时成立。两条都是前缀 → 不猜。
  it('两条都是候选的前缀：不猜', () => {
    expect(matchOption(
      ['University of California, Berkeley, School of Law'],
      options(['University of California', 'University of California - Berkeley']),
    ).kind).toBe('AMBIGUOUS_OPTION');
  });

  // 另一个校区不是前缀，所以它不参与；剩下母校一条，照旧命中。
  it('别的分校在名单里不影响退到母校', () => {
    expect(pickedText(matchOption(
      ['University of Washington, Bothell'],
      options(['University of Washington', 'University of Washington - Tacoma']),
    ))).toBe('University of Washington');
  });

  // 前缀必须是**整词序列**前缀。`University of Washington` 不是
  // `Washington State University` 的答案——那是另一所学校。
  it('词序不同不算前缀', () => {
    expect(matchOption(
      ['University of Washington'],
      options(['Washington State University']),
    ).kind).toBe('NO_OPTION_MATCH');
  });

  it('完全不相干的名单仍然不中', () => {
    expect(matchOption(
      ['University of Chicago'],
      options(['Afghanistan', 'Albania', 'Algeria']),
    ).kind).toBe('NO_OPTION_MATCH');
  });
});
