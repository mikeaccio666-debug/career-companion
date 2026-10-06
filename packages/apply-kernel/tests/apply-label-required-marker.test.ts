import { describe, expect, it } from 'vitest';

import greenhouse from '@edaix/apply-rules/greenhouse.json';
import lever from '@edaix/apply-rules/lever.json';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 标签末尾的必填标记不该让一整条规则落空。
 *
 * 296 条标签规则里绝大多数以 `$` 收尾——`^country$`、`…attend?$`、`^summary$`。
 * 宿主把必填标记渲染进可访问名时（`Country *`、`…attend? ✱`、`Email (required)`），
 * 这些规则**一条都不中**。2026-09-22 量过语料里能被认出的 62 个 (厂商, 标签) 组合：
 * 末尾加一个标记，**46 个（74%）当场认不出**。
 *
 * ## 为什么改解释器，不改 296 条正则
 *
 * 逐条给正则加尾巴要动 296 处，每一处都可能把别的写法改坏，而且下一条新规则又会
 * 忘记加。剥标记是**一处**的事，对已有规则与未来规则同时生效。
 *
 * ## 这不是「已经在丢字段」，是「随时会丢」
 *
 * 诚实记在这里：今天的语料里真正带标记的标签只有 2 个（工作授权那两句，走的是
 * 另一条字典路，不受影响）。所以这一刀**不会立刻抬高填写率**——它买的是「宿主
 * 换一下标记的渲染方式，我们不会整片失明」。ATS 改前端是常事。
 *
 * ## 剥什么，不剥什么
 *
 * 只剥**尾部**的星号类符号与括号里的 required/optional/if applicable（含中文全角）。
 * 光秃秃的 `required` 一词不剥——「Salary required」是一条真标签，剥掉就变成
 * 「Salary」，那是另一个意思。
 */

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

const keyOf = (ruleset: unknown, label: string): string | null => {
  document.body.innerHTML = `<form id="application-form">
    <label for="probe">${label}</label><input id="probe" type="text">
  </form>`;
  const adapter = compileBundledAdapter(ruleset as Ruleset);
  const root = adapter.resolveRoot(document);
  if (root === null) return null;
  return [...adapter.scan(root)].find((field) => field.element.id === 'probe')?.key ?? null;
};

/** 每一条都是 2026-09-22 语料里真实出现过的标签，只是补上宿主可能渲染的标记。 */
const CASES = [
  ['First name', 'firstName'],
  ['Last name', 'lastName'],
  ['Email', 'email'],
  ['Phone', 'phone'],
  ['Country', 'addressCountry'],
  ['How did you hear about this job?', 'heardAboutSource'],
] as const;

const MARKERS = [' *', ' ✱', ' ✳', '*', ' (required)', ' (Required)', ' (optional)', '（必填）'];

describe('必填标记不该让规则落空', () => {
  it.each(CASES)('«%s» 光秃秃时认得出 %s', (label, key) => {
    expect(keyOf(greenhouse, label)).toBe(key);
  });

  it.each(CASES)('«%s» 带上各种必填标记仍认得出 %s', (label, key) => {
    for (const marker of MARKERS) {
      expect(keyOf(greenhouse, `${label}${marker}`), `«${label}${marker}»`).toBe(key);
    }
  });

  it('问句形态也一样——`?` 之后的标记不该把整条锚死', () => {
    // #40 那批问句规则全是 `[^?]{0,80}\??$` 收尾，`?` 后面多一个字符就整条落空。
    const label = 'Which university are you currently attending or did you last attend?';
    expect(keyOf(lever, label)).toBe('education.school');
    for (const marker of MARKERS) {
      expect(keyOf(lever, `${label}${marker}`), marker).toBe('education.school');
    }
  });

  it('反向探针：光秃秃的 required 一词不剥——那是标签的一部分', () => {
    // 「Salary required」剥成「Salary」就是另一个意思了。这里只要求它不被当成
    // 期望薪资那一键；认不出是诚实的答案。
    expect(['expectedSalaryAmount']).not.toContain(keyOf(greenhouse, 'Salary required'));
  });

  it('反向探针：标记出现在中间不剥', () => {
    // 「Name * as it appears on your ID」——星号不在末尾，剥它会改变句意。
    expect(keyOf(greenhouse, 'Email * confirm below')).toBeNull();
  });

  it('反向探针：整条只有一个标记时不认成任何键', () => {
    for (const marker of MARKERS) expect(keyOf(greenhouse, marker), marker).toBeNull();
  });

  it('反向探针：剥标记不会让本来不中的标签突然中', () => {
    for (const label of ['reference company', 'employment status', 'have you heard of us before?']) {
      const bare = keyOf(greenhouse, label);
      for (const marker of MARKERS) {
        expect(keyOf(greenhouse, `${label}${marker}`), `${label}${marker}`).toBe(bare);
      }
    }
  });
});
