import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 闭集码只对**有选项集的控件**有意义，绝不能写进自由文本框。
 *
 * ## 病根
 *
 * `projectCollectionField` 对枚举角色产出的有序候选是「码在前、人读写法在后」
 * （`['BACHELOR', "Bachelor's Degree", 'BS', …]`）——那是**为选项匹配设计的**：
 * `<select>` 与 combobox 会拿候选逐个去撞宿主真有的选项，码最精确所以排第一。
 *
 * 但 `buildApplyPlan` 对非 select 控件只取 `candidatesFor(...)[0]`，于是一个
 * **自由文本**的学位栏会被写进 `BACHELOR`。而回读判决读到的正是 `BACHELOR`，
 * `expected === actual` ⇒ **判成功**。用户的申请表上留下一个机器码，
 * 而面板显示绿色「已填」。
 *
 * ## 为什么今天没炸
 *
 * Workable 的 `degree` 栏现在标了 `writeMode: 'typed'`（走 WIDGET 不写），
 * Greenhouse 的是 react-select（走 combobox 的阶梯匹配，码撞不中会退到人读写法）。
 * 也就是说**它是靠运气没炸的**——只要有一家把学位做成自由文本框就当场发生。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const COLLECTIONS = parseApplyProfileCollections({
  educations: [{ school: 'MIT', degreeLevel: 'BACHELOR' }],
  experiences: [{ company: 'Acme', title: 'SWE', employmentType: 'INTERNSHIP' }],
});

function rules(cells: Record<string, string>, collection: 'education' | 'experience') {
  return {
    schemaVersion: 2, vendor: 'greenhouse', finalSubmitControl: null, anchors: ['#main'], applyPath: { source: '.*' },
    excludeWithin: [], denyLabels: [], denyNameSubstrings: [], widgetNames: [],
    rowScopes: [{ kind: 'contains', container: 'div.rows', row: 'div.row', collection, fieldMap: cells }],
    keySteps: [],
  };
}

function planFor(html: string, cells: Record<string, string>, collection: 'education' | 'experience') {
  document.body.innerHTML = `<div id="main"><div class="rows"><div class="row">${html}</div></div></div>`;
  const parsed = parseVendorRuleset(rules(cells, collection));
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.code}`);
  const adapter = compileRuleAdapter(parsed.value);
  const root = adapter.resolveRoot(document)!;
  return buildApplyPlan({ vendor: 'greenhouse', root, fields: [...adapter.scan(root)] }, {}, { collections: COLLECTIONS });
}

function valueOf(plan: ReturnType<typeof planFor>, name: string) {
  return plan.entries.find((e) => e.element.getAttribute('name') === name)?.value;
}

describe('自由文本框拿人读写法，不是闭集码', () => {
  it('学位：文本框里不许出现 BACHELOR', () => {
    const v = valueOf(
      planFor('<label>Degree<input name="degree" type="text" /></label>', { degree: 'degreeLevel' }, 'education'),
      'degree',
    );
    expect(v, '把机器码写进了用户的申请表').not.toBe('BACHELOR');
    expect(v).toBe("Bachelor's Degree");
  });

  it('雇佣类型同理', () => {
    const v = valueOf(
      planFor('<label>Type<input name="etype" type="text" /></label>', { etype: 'employmentType' }, 'experience'),
      'etype',
    );
    expect(v).not.toBe('INTERNSHIP');
    expect(v).toBe('Internship');
  });

  it('textarea 也算自由文本', () => {
    const v = valueOf(
      planFor('<label>Degree<textarea name="degree"></textarea></label>', { degree: 'degreeLevel' }, 'education'),
      'degree',
    );
    expect(v).not.toBe('BACHELOR');
  });
});

describe('有选项集的控件仍然码在前 —— 那是它的用途', () => {
  it('select：码能撞中就用码，它最精确', () => {
    const plan = planFor(
      `<label>Degree<select name="degree">
         <option value=""></option><option value="BACHELOR">Bachelor</option>
       </select></label>`,
      { degree: 'degreeLevel' }, 'education',
    );
    expect(valueOf(plan, 'degree')).toBe('BACHELOR');
  });

  it('select：码只是用来撞选项的，真正落下去的是宿主自己的选项', () => {
    // `entry.value` 是「拿哪个候选撞中的」，`resolvedOptionText` 才是
    // 「宿主上真正被选中的那一项」——审计面板显示的是后者，
    // 所以用户看到的永远是宿主自己的文案，不会是机器码。
    const plan = planFor(
      `<label>Degree<select name="degree">
         <option value=""></option><option>Bachelor's Degree</option>
       </select></label>`,
      { degree: 'degreeLevel' }, 'education',
    );
    const entry = plan.entries.find((e) => e.element.getAttribute('name') === 'degree');
    expect(entry?.resolvedOptionText).toBe("Bachelor's Degree");
  });
});
