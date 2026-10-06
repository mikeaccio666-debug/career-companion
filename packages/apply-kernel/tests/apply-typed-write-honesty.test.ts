import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { workableAdapter } from '../src/sites/workable/applyForm';

/**
 * `writeMode: 'typed'` 的行：宁可说填不了，也绝不把失败报成成功。
 *
 * ## 病根（2026-08-23 在真实 Workable 申请页实测，50-证据库 §F.6-s）
 *
 * Workable 经历行的控件**只接受逐字符增量输入**。整串写入（原生 setter + 完整
 * 事件信封 + React `_valueTracker` 重置，三种都试过）会被宿主的表单状态拒收，
 * 而 `element.value` **留着我们写进去的值**。
 *
 * 判据不是猜的：同一个 `title` 栏，整串写入后点 Update 报
 * 「This is a required field.」；一个字符不改、只逐字符重敲一遍，错误当场消失。
 *
 * **这是本仓最危险的失效形态**：C6 回读判决读的正是 `element.value`，
 * 它恰好是对的 ⇒ 判定成功 ⇒ 用户看到绿色「已填」，而宿主认为这一栏是空的，
 * 会在保存/提交时拒绝。比「填不上」糟得多。
 *
 * 而且它是个**毫无特征**的 `<input type="text">`——tag、type、role 一律看不出
 * 区别，只能由规则数据声明（铁律 3）。
 *
 * ## 在逐字符写入通路落地之前
 *
 * 这些控件一律按既有的 `WIDGET` 处理：如实报「这一栏我们填不了」。
 * `widgetNames` 的头注写的就是同一件事——「往里写字回读会把没成功报成成功
 * （Lever location）」——只是那张表是全局按 `name` 匹配的，
 * 而 Workable 的 `summary` 在同一张表单里出现两次（另一个是求职信），
 * 全局标记会误伤，所以本档挂在行作用域上。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const COLLECTIONS = parseApplyProfileCollections({
  experiences: [{ company: 'Acme', title: 'SWE', startDate: { year: 2021, month: 6 } }],
  educations: [{ school: 'MIT', fieldOfStudy: 'CS', degreeLevel: 'BACHELOR' }],
});

function plan() {
  document.body.innerHTML = `
    <form data-ui="application-form">
      <label>First name<input name="firstname" type="text" /></label>
      <div data-ui="experience"><ul><li>
        <label>Title<input name="title" type="text" /></label>
        <label>Company<input name="company" type="text" /></label>
        <label>Start date<input name="start_date" type="text" placeholder="MM/YYYY" /></label>
      </li></ul><button type="button" data-ui="add-section">+ Add</button></div>
      <div data-ui="education"><ul><li>
        <label>School<input name="school" type="text" /></label>
      </li></ul><button type="button" data-ui="add-section">+ Add</button></div>
    </form>`;
  const root = workableAdapter.resolveRoot(document)!;
  return buildApplyPlan(
    { vendor: 'workable', root, fields: [...workableAdapter.scan(root)] },
    { firstName: 'Mike' },
    { collections: COLLECTIONS },
  );
}

function skipOf(p: ReturnType<typeof plan>, name: string) {
  return p.skipped.find((s) => s.element?.getAttribute('name') === name);
}

describe('typed 行：普通格走逐字符，掩码格如实报填不了', () => {
  it('普通文本格进计划并带上 typed', () => {
    const p = plan();
    for (const name of ['title', 'company']) {
      const entry = p.entries.find((e) => e.element.getAttribute('name') === name);
      expect(entry, `${name} 没进计划`).toBeDefined();
      expect(entry?.writeMode, `${name} 会退回整串写入 —— 那会把失败报成成功`).toBe('typed');
    }
  });

  it('掩码格不进计划', () => {
    // 投影层给日期的首选是 `2021-06`，敲进 `MM/YYYY` 掩码会写出一个**错误的日期**，
    // 而回读判决的 valuesEquivalent('2021-06','20/2106') 恰好返回 true——
    // 写错了还判成功。等「预测写入后形态 + 严格相等」落地再放行（§F.6-w）。
    expect(
      plan().entries.find((e) => e.element.getAttribute('name') === 'start_date'),
    ).toBeUndefined();
  });

  it('落 UNSUPPORTED_CONTROL 而不是 LOW_CONFIDENCE / NO_VALUE', () => {
    // ⚠️ 这里其实想要一个 `WIDGET` 原因码：「值被厂商部件托管，这一栏得你自己填」
    // 与「这类控件我们还不支持」对用户的下一步动作意义不同——引擎自己在
    // `CHOICE_NO_DATA` 那一处就是这么论证的。但 `APPLY_ERROR_CODES` 是跨边界的
    // 稳定契约，加成员属 contract-class 变更（RULE-GLOBAL-ERROR-CONTRACT），
    // 不该由实现顺手定。记在 docs/T10-增删行执行循环-设计记录.md 的开放问题里。
    //
    // 现在锁住的是**它没有落进那两个更糟的码**：`LOW_CONFIDENCE`（我们没认出来）
    // 与 `NO_VALUE`（你档案里没这项）都会把原因说反。
    expect(skipOf(plan(), 'start_date')?.reason).toBe('UNSUPPORTED_CONTROL');
  });

  it('填不了的那一格也要说得出是什么——键必须保留', () => {
    // 「这是你的入职年月，但这一栏得你自己填」比「有个控件我们处理不了」有用得多。
    expect(skipOf(plan(), 'start_date')?.key).toBe('experience.startDate');
  });

  it('行外字段不受影响——writeMode 只管这一组行', () => {
    expect(plan().entries.find((e) => e.element.getAttribute('name') === 'firstname')?.value).toBe(
      'Mike',
    );
  });
});
