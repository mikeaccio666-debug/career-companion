import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAuditView,
  mergeAuditViews,
  overlayAuditView,
  type AuditOverlayPlacement,
  type AuditRow,
  type AuditView,
} from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { fieldSignature } from '../src/fieldIdentity';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { parseVendorRuleset } from '../src/rules/schema';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyPlan, ApplyWriteResult } from '../src/contracts';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 逐字段审计视图（CAP-AF-063 的地基）。
 *
 * 今天用户跑完一轮只看得见 confirmBar 的一行字：「已填 2/3 · 请核对后自行提交」。
 * 内核这边有 38 条逐字段原因码、一本 undo journal、每条目的置信度与元素引用——
 * **一样都没有出口**。「可审计」是这个产品对着竞品立的差异化，而在用户按下提交
 * 之前的最后一刻，屏幕上恰恰是空的。
 *
 * ## 为什么模型放在内核而不是面板里
 *
 * 铁律 3（RULE-EXTENSION-NEVER-SUBMIT）不许给宿主节点上样式，所以绿/黄标记
 * 画不到输入框上，只能在我方 Shadow 浮层里做成一份**表单的镜像列表**。
 * 那份列表怎么排、哪些行不许出现、哪一档算"还需要你动手"——全是纯判断，
 * 一行 DOM 都不需要。放在扩展里就只能靠 happy-dom 端到端间接测，
 * 而这几条恰恰是"错了会当着用户的面误导他"的判断。
 *
 * ## 两个绝对不许出现的行
 *
 * `HONEYPOT`：把蜜罐列出来等于把陷阱指给用户看，而列表里每一行天然带着
 * 「要不要处理一下」的暗示——那正是陷阱要的。
 * `SENSITIVE_OPT_OUT`：用户主动关掉了这一类，再摆回他眼前就是把他关掉的东西
 * 重新推回来。这两条不是排序问题，是**不得出现**。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  phone: '+1 555 0100',
};

function planFrom(html: string, suppressedKeys?: ReadonlySet<string>) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    PROFILE,
    suppressedKeys ? { suppressedKeys: suppressedKeys as ReadonlySet<never> } : undefined,
  );
}

/** 全部计划内条目都当作"写入并回读确认"，用来单独观察行的构成与顺序。 */
function allFilled(plan: ApplyPlan): ApplyWriteResult[] {
  return plan.entries.map((entry) => ({ key: entry.key, label: entry.label, ok: true as const }));
}

describe('审计行的构成', () => {
  it('计划内与被跳过的字段合成一份列表，按表单顺序排列', () => {
    // 交织顺序：填 → 跳 → 填。若实现把两个数组首尾相接，这里会变成 填,填,跳。
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="salary">Desired salary</label><input id="salary" type="text" />
       <label for="last_name">Last Name</label><input id="last_name" type="text" />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(
      view.rows.map((row) => row.label),
      '行没有按表单顺序排——面板是表单的镜像，顺序错了 [locate] 就在骗人',
    ).toEqual(['First Name', 'Desired salary', 'Last Name']);
  });

  it('每一行都带宿主元素引用，[locate] 才可能', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="salary">Desired salary</label><input id="salary" type="text" />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(view.rows).toHaveLength(2);
    for (const row of view.rows) {
      expect(row.element, `「${row.label}」行没有元素引用，滚不到宿主字段`).toBeInstanceOf(
        document.defaultView!.Element,
      );
    }
  });

  it('蜜罐行绝不出现——列出来等于把陷阱指给用户', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <input id="hp" name="honeypot_email" type="text" aria-label="Leave blank" />`,
    );
    expect(
      plan.skipped.some((skip) => skip.reason === 'HONEYPOT'),
      '前提不成立：这一版里蜜罐没被拦下，后面的断言就没有意义',
    ).toBe(true);
    const view = buildAuditView(plan, allFilled(plan));
    expect(
      view.rows.some((row) => row.reason === 'HONEYPOT'),
      '蜜罐被列进审计面板——每一行都带着「要不要处理一下」的暗示，那正是陷阱要的',
    ).toBe(false);
  });

  it('用户主动关掉的类别不出现——关掉了就不该再摆回他眼前', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="phone">Phone</label><input id="phone" type="tel" />`,
      new Set(['phone']),
    );
    expect(
      plan.skipped.some((skip) => skip.reason === 'SENSITIVE_OPT_OUT'),
      '前提不成立：suppressedKeys 没把 phone 判成 SENSITIVE_OPT_OUT',
    ).toBe(true);
    const view = buildAuditView(plan, allFilled(plan));
    expect(
      view.rows.some((row) => row.reason === 'SENSITIVE_OPT_OUT'),
      '用户关掉的类别又被摆回面板上',
    ).toBe(false);
  });

  it('反向探针：被隐藏的行不许悄悄改变分母', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" required />
       <input id="hp" name="honeypot_email" type="text" aria-label="Leave blank" required />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(view.requiredTotal, '蜜罐被算进必填分母——用户会以为还差一项永远填不完').toBe(1);
  });
});

describe('状态分档', () => {
  function rowsFor(
    fields: ReadonlyArray<{ label: string; required?: boolean }>,
    build: (elements: HTMLInputElement[]) => {
      entries: ApplyPlan['entries'];
      skipped: ApplyPlan['skipped'];
      results: ApplyWriteResult[];
    },
  ) {
    document.body.innerHTML = `<form>${fields
      .map((field, index) => `<input id="f${index}" type="text" />`)
      .join('')}</form>`;
    const elements = fields.map(
      (_, index) => document.querySelector<HTMLInputElement>(`#f${index}`)!,
    );
    const root = createScanRoot(document.body, []);
    const built = build(elements);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'audit-status',
      fillEmptyOnly: true,
      entries: built.entries,
      skipped: built.skipped,
    };
    void root;
    const view = buildAuditView(plan, built.results);
    return Object.fromEntries(view.rows.map((row) => [row.label, row])) as Record<
      string,
      ReturnType<typeof buildAuditView>['rows'][number]
    >;
  }

  function entry(
    element: HTMLInputElement,
    key: string,
    label: string,
    order: number,
  ): ApplyPlan['entries'][number] {
    return {
      kind: 'text',
      required: false,
      key: key as ApplyPlan['entries'][number]['key'],
      label,
      value: 'written',
      confidence: 1,
      order,
      element,
      signature: fieldSignature(element, createScanRoot(document.body, [])),
    };
  }

  it('读回确认的成功与「动作做了但读不回」必须分开显示', () => {
    const rows = rowsFor([{ label: 'A' }, { label: 'B' }], (elements) => ({
      entries: [entry(elements[0], 'firstName', 'A', 0), entry(elements[1], 'lastName', 'B', 1)],
      skipped: [],
      results: [
        { key: 'firstName', label: 'A', ok: true },
        { key: 'lastName', label: 'B', ok: true, unverified: true },
      ],
    }));
    expect(rows['A'].status).toBe('FILLED');
    expect(
      rows['B'].status,
      '「点了但没读回确认」和「确认填入」显示成同一档——屏幕上长得一模一样，用户就不会去核对',
    ).toBe('FILLED_UNVERIFIED');
  });

  it('宿主判无效（HOST_REJECTED）单独成档，不并进写入失败', () => {
    const rows = rowsFor([{ label: 'A' }, { label: 'B' }], (elements) => ({
      entries: [entry(elements[0], 'email', 'A', 0), entry(elements[1], 'phone', 'B', 1)],
      skipped: [],
      results: [
        { key: 'email', label: 'A', ok: false, reason: 'HOST_REJECTED' },
        { key: 'phone', label: 'B', ok: false, reason: 'WRITE_REVERTED' },
      ],
    }));
    // 下一步动作相反：一个是"值不对，你改"，一个是"没写进去，可以重试"。
    expect(rows['A'].status).toBe('REJECTED');
    expect(rows['B'].status).toBe('FAILED');
  });

  it('页面本来就填好的算 PREFILLED，不进"还需要你动手"', () => {
    const rows = rowsFor([{ label: 'A' }], (elements) => ({
      entries: [],
      skipped: [{ label: 'A', reason: 'NOT_EMPTY', required: true, key: null, element: elements[0], order: 0 }],
      results: [],
    }));
    expect(rows['A'].status).toBe('PREFILLED');
  });

  it('runner 的显式 no-write NOT_EMPTY 也显示为 PREFILLED，而不是 FILLED/FAILED', () => {
    const rows = rowsFor([{ label: 'A', required: true }], (elements) => ({
      entries: [{
        kind: 'combobox',
        required: false,
        key: 'location',
        label: 'A',
        value: 'written',
        confidence: 1,
        order: 0,
        element: elements[0],
        signature: fieldSignature(elements[0], createScanRoot(document.body, [])),
        comboboxCandidates: ['written'],
      }],
      skipped: [],
      results: [{ key: 'location', label: 'A', ok: false, reason: 'NOT_EMPTY' }],
    }));
    expect(rows['A'].status).toBe('PREFILLED');
    expect(rows['A'].reason).toBe('NOT_EMPTY');
  });

  it('非 combobox 的 NOT_EMPTY 保持 FAILED，不被 PREFILLED 口径外溢', () => {
    const rows = rowsFor([{ label: 'A' }], (elements) => ({
      entries: [entry(elements[0], 'firstName', 'A', 0)],
      skipped: [],
      results: [{ key: 'firstName', label: 'A', ok: false, reason: 'NOT_EMPTY' }],
    }));
    expect(rows['A'].status).toBe('FAILED');
    expect(rows['A'].reason).toBe('NOT_EMPTY');
  });

  it('「档案里没有」与「只能你自己答」是两档，下一步动作不同', () => {
    const rows = rowsFor([{ label: 'A' }, { label: 'B' }], (elements) => ({
      entries: [],
      skipped: [
        { label: 'A', reason: 'NO_VALUE', required: true, key: null, element: elements[0], order: 0 },
        { label: 'B', reason: 'JOB_DEPENDENT', required: true, key: null, element: elements[1], order: 1 },
      ],
      results: [],
    }));
    // 混成一档，用户就会跑去页面上枯等一个只有他自己知道答案的问题，
    // 或者反过来，以为"去补资料"能解决签证题。
    expect(rows['A'].status).toBe('MISSING_PROFILE');
    expect(rows['B'].status).toBe('NEEDS_MANUAL');
  });

  it('低置信行带着建议值，[仍然填] 才有东西可填', () => {
    const rows = rowsFor([{ label: 'A' }], (elements) => ({
      entries: [],
      skipped: [
        { label: 'A', reason: 'LOW_CONFIDENCE', required: false, key: null, element: elements[0], order: 0 },
      ],
      results: [],
    }));
    expect(rows['A'].status).toBe('LOW_CONFIDENCE');
  });

  it('工作授权题说得出是哪一国、用户在那一国没有记录：那一国跟着行走，面板才说得出原因', () => {
    const rows = rowsFor([{ label: 'A' }, { label: 'B' }], (elements) => ({
      entries: [],
      skipped: [
        { label: 'A', reason: 'JOB_DEPENDENT', required: true, key: null, regionWithoutRecord: 'EE', element: elements[0], order: 0 },
        { label: 'B', reason: 'JOB_DEPENDENT', required: true, key: null, element: elements[1], order: 1 },
      ],
      results: [],
    }));
    expect(rows['A']).toMatchObject({ status: 'NEEDS_MANUAL', reason: 'JOB_DEPENDENT', regionWithoutRecord: 'EE' });
    expect(rows['B'].regionWithoutRecord).toBeUndefined();
  });

  it('工作授权题按默认答的（2026-09-24 负责人决定）：那一国跟着写成的行走，面板才写得出依据', () => {
    const rows = rowsFor([{ label: 'A' }, { label: 'B' }], (elements) => ({
      entries: [
        { ...entry(elements[0], 'workAuthorization', 'A', 0), inferredRegionCode: 'EE', defaultedRegionCode: 'EE' },
        entry(elements[1], 'workSponsorship', 'B', 1),
      ],
      skipped: [],
      results: [
        { key: 'workAuthorization', label: 'A', ok: true },
        { key: 'workSponsorship', label: 'B', ok: true },
      ],
    }));
    expect(rows['A']).toMatchObject({ status: 'FILLED', inferredRegionCode: 'EE', defaultedRegionCode: 'EE' });
    expect(rows['B'].defaultedRegionCode).toBeUndefined();
  });

});

describe('行动号召的计数', () => {
  it('needsAttention 只数真正等用户动手的行', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" required />
       <label for="email">Email</label><input id="email" type="email" value="ada@example.test" required />
       <label for="salary">Desired salary</label><input id="salary" type="text" required />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    // First Name 已填、Email 页面本来就有 → 都不用管；Desired salary 只能用户自己答。
    expect(view.needsAttention, 'needsAttention 把已填或本来就有的行也数进去了').toBe(1);
    expect(view.requiredTotal).toBe(3);
    expect(view.requiredHandled, '页面本来就填好的必填项没算进"已经不用操心"').toBe(2);
  });
});

describe('「我们的问题」与「轮到你了」必须分开数', () => {
  /**
   * 这两件事混成一个 needsAttention，会让自动推进的闸门永远合不上：
   * 「只能用户本人答」的行**永远不会归零**（工签、EEO、法律勾选在真实 ATS 表上
   * 几乎必现），拿它当停止条件等于每一岗都停。
   *
   * 而「我们没做好」那一类是**该**归零的——2026-08-21 实测 5 份夹具 14 条跳过里
   * 13 条属这一类（9 条 LOW_CONFIDENCE 全因档案只有 11 个键，归 T3 的 CAP-AF-018）。
   * 它归零了，自动推进才谈得上；它没归零，停下来是对的，因为那是 bug。
   *
   * 所以分档的判据是**这一行该由谁去解决**，不是「有没有填成」。
   */
  it('等用户本人答的行不算进「我们的问题」', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" required />
       <label for="salary">Desired salary</label><input id="salary" type="text" required />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(
      view.blockedByUs,
      '「只能你自己答」被算成我们的问题——这个数永远不会归零，自动推进的闸门就永远合不上',
    ).toBe(0);
    expect(view.awaitingUser, '等用户的行没被数出来').toBe(1);
  });

  it('我们没做好的行进 blockedByUs，不进 awaitingUser', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" required />`,
    );
    const view = buildAuditView(plan, [
      { key: 'firstName', label: 'First Name', ok: false, reason: 'HOST_REJECTED' },
    ]);
    expect(view.blockedByUs, '宿主判我们写的值无效——这是我们的问题').toBe(1);
    expect(view.awaitingUser, '我们的问题被算成等用户，用户根本无从下手').toBe(0);
  });

  it('档案里没有这一项算我们的问题——补档案是我们的事', () => {
    // 今天 9 条 LOW_CONFIDENCE 与 NO_VALUE 都是这一类：11 键档案装不下这些字段。
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="linkedin">LinkedIn Profile</label><input id="linkedin" type="text" required />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    const row = view.rows.find((item) => item.label === 'LinkedIn Profile');
    expect(row?.status).toBe('MISSING_PROFILE');
    expect(view.blockedByUs).toBe(1);
    expect(view.awaitingUser).toBe(0);
  });

  it('两个数不重叠，且合起来正好是 needsAttention', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" />
       <label for="salary">Desired salary</label><input id="salary" type="text" />
       <label for="linkedin">LinkedIn</label><input id="linkedin" type="text" />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(view.blockedByUs + view.awaitingUser).toBe(view.needsAttention);
  });

  it('反向探针：全填成时两个数都是 0', () => {
    const plan = planFrom(
      `<label for="first_name">First Name</label><input id="first_name" type="text" required />
       <label for="email">Email</label><input id="email" type="email" required />`,
    );
    const view = buildAuditView(plan, allFilled(plan));
    expect(view.blockedByUs).toBe(0);
    expect(view.awaitingUser).toBe(0);
  });
});


/**
 * 一个 key 多个条目：行内字段的常态（2026-08-22）。
 *
 * `buildAuditView` 原本按 **key** 把写入结果对回条目，靠的是「一份计划里
 * 一个 key 只出现一次」——这在 11 个扁平键的年代成立（重复仲裁会把多余的
 * 挑掉）。行内角色接进来之后不再成立：两段经历就是两个 `experience.company`，
 * 而且它们**应该**同时在计划里。
 *
 * 按 key 对回的后果是：第 1 行的结果会被贴到每一行上。第 2 行明明写失败了，
 * 面板显示绿色「已填」——审计面板撒谎，比没有审计面板更糟。
 *
 * 结果数组与 `plan.entries` 是**按下标对齐**的（runner 里 `results[index] = …`），
 * 所以对回也按下标。
 */
describe('一个 key 多个条目（行内字段）', () => {
  /**
   * 本地夹具规则，不依赖任何厂商数据：这个 bug 是引擎/审计层的，
   * 拿 greenhouse.json 当地基会让测试随那份数据的演进而漂。
   */
  const ROW_RULES = {
    schemaVersion: 2,
    finalSubmitControl: null,
    vendor: 'greenhouse',
    anchors: ['#application-form'],
    applyPath: { source: '.*' },
    excludeWithin: [],
    denyLabels: [],
    denyNameSubstrings: [],
    widgetNames: [],
    rowScopes: [
      {
        kind: 'contains',
        container: 'div.education--container',
        row: 'div.education--form',
        collection: 'education',
      },
    ],
    keySteps: [
      { type: 'attrMap', attr: 'name', confidence: 1, map: { school: 'education.school' } },
    ],
  };

  /** 三行教育，每行一个 school —— rowScopes 让三行各自成域。 */
  function threeRowPlan(): ApplyPlan {
    document.body.innerHTML = `
      <form id="application-form">
        <div class="education--container">
          ${[0, 1, 2]
            .map(
              (index) => `<div class="education--form">
                 <label for="school--${index}">School</label>
                 <input id="school--${index}" name="school" type="text" />
               </div>`,
            )
            .join('')}
        </div>
      </form>`;
    const parsed = parseVendorRuleset(ROW_RULES);
    if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.code}`);
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document)!;
    return buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] },
      PROFILE,
      {
        collections: parseApplyProfileCollections({
          educations: [{ school: 'MIT' }, { school: 'Oxford' }, { school: 'ETH' }],
        }),
      },
    );
  }

  it('前置：三行确实各自成一条计划条目，键相同', () => {
    const plan = threeRowPlan();
    const rows = plan.entries.filter((entry) => entry.key === 'education.school');
    expect(rows.map((entry) => entry.value)).toEqual(['MIT', 'Oxford', 'ETH']);
  });

  it('每一行拿自己的结果，不是第一行的', () => {
    const plan = threeRowPlan();
    const results = plan.entries.map((entry, index): ApplyWriteResult =>
      index === 1
        ? { key: entry.key, label: entry.label, ok: false, reason: 'VERIFY_TIMEOUT' }
        : { key: entry.key, label: entry.label, ok: true },
    );
    const view = buildAuditView(plan, results);
    const statuses = view.rows
      .filter((row) => row.key === 'education.school')
      .map((row) => row.status);
    expect(statuses).toEqual(['FILLED', 'FAILED', 'FILLED']);
  });

  it('结果与计划对不上号时报 ABORTED，绝不把别人的结果显示成这一行的结局', () => {
    // 按下标对齐的前提是"这份结果就是这份计划跑出来的"。调用方传错了
    // （不同一次运行、被过滤过、顺序被动过），下标就会指到别人身上。
    // 键一致性是这个前提的**廉价校验**：不一致就整行报没跑到。
    const plan = threeRowPlan();
    const results = plan.entries.map((entry, index): ApplyWriteResult => ({
      key: index === 1 ? 'firstName' : entry.key,
      label: entry.label,
      ok: true,
    }));
    const rows = buildAuditView(plan, results).rows.filter(
      (row) => row.key === 'education.school',
    );
    expect(rows.map((row) => row.status)).toEqual(['FILLED', 'FAILED', 'FILLED']);
    expect(rows[1].reason).toBe('ABORTED');
  });

  it('结果比条目少（整轮被中止）时，没跑到的几行报 ABORTED，不套用别人的结果', () => {
    const plan = threeRowPlan();
    const first = plan.entries[0];
    const view = buildAuditView(plan, [
      { key: first.key, label: first.label, ok: true } satisfies ApplyWriteResult,
    ]);
    const rows = view.rows.filter((row) => row.key === 'education.school');
    expect(rows.map((row) => row.status)).toEqual(['FILLED', 'FAILED', 'FAILED']);
    expect(rows.slice(1).map((row) => row.reason)).toEqual(['ABORTED', 'ABORTED']);
  });
});

/**
 * 第二遍叠到第一遍上（2026-09-23，`overlayAuditView`）。
 *
 * 同一次点击里「重扫、补填」的第二遍说的多半是第一遍已经有一行的**同一栏**。拼接
 * （`mergeAuditViews`）会让一栏出现两行——一行红、一行绿；这里锁的是：同一栏只剩一行、
 * 第二遍写成了的顶替第一遍没写成的、第二遍「已经有值」不许把第一遍的「已填」降级、
 * 新出现的题插在它在页面上的位置、计数跟着行走。
 */
describe('第二遍叠到第一遍上', () => {
  const element = (id: string) => Object.assign(document.createElement('input'), { id });
  const WRITE_STATUSES = new Set(['FILLED', 'FILLED_UNVERIFIED', 'FAILED', 'REJECTED']);
  const row = (over: Partial<AuditRow> & Pick<AuditRow, 'label' | 'status' | 'element'>): AuditRow => ({
    // 计划条目的行才带键（跳过的行一律 null）；这里默认按「写过」的档位给键。
    key: WRITE_STATUSES.has(over.status) ? 'firstName' : null,
    required: true,
    reason: over.status === 'FILLED' || over.status === 'FILLED_UNVERIFIED' ? null : 'IDENTITY_CHANGED',
    attemptedValue: null,
    resolvedOptionText: null,
    confidence: null,
    order: 0,
    ...over,
  });
  const view = (rows: readonly AuditRow[]): AuditView => mergeAuditViews([{
    rows, filled: 0, requiredTotal: 0, requiredHandled: 0, needsAttention: 0, blockedByUs: 0, awaitingUser: 0,
  }]);
  const same = (sameAs: Element) => ({ sameAs });

  it('第二遍写成了：顶替第一遍那一行没写成的，同一栏只剩一行，计数跟着走', () => {
    const first = element('first');
    const veteran = element('veteran');
    const base = view([
      row({ label: 'First Name', status: 'FILLED', element: first }),
      row({ label: 'Veteran Status', status: 'FAILED', reason: 'IDENTITY_CHANGED', element: veteran }),
    ]);
    expect(base).toMatchObject({ filled: 1, requiredHandled: 1, blockedByUs: 1 });
    const second = view([row({ label: 'Veteran Status', status: 'FILLED', element: veteran })]);

    const merged = overlayAuditView(base, second, (r) => same(r.element));

    expect(merged.rows.map((r) => [r.label, r.status])).toEqual([
      ['First Name', 'FILLED'],
      ['Veteran Status', 'FILLED'],
    ]);
    expect(merged).toMatchObject({ filled: 2, requiredTotal: 2, requiredHandled: 2, blockedByUs: 0, needsAttention: 0 });
  });

  it('第二遍看到「已经有值」（NOT_EMPTY / 已预填）不许把第一遍的「已填」降级', () => {
    const phone = element('phone');
    const gender = element('gender');
    const base = view([
      row({ label: 'Phone', status: 'FILLED', element: phone }),
      row({ label: 'Gender', status: 'FILLED', element: gender }),
    ]);
    const second = view([
      // 文本控件写前重读到非空：带键的 FAILED / NOT_EMPTY。
      row({ label: 'Phone', status: 'FAILED', reason: 'NOT_EMPTY', element: phone }),
      // 组合框语义已匹配：PREFILLED。
      row({ label: 'Gender', status: 'PREFILLED', reason: 'NOT_EMPTY', element: gender }),
    ]);

    const merged = overlayAuditView(base, second, (r) => same(r.element));

    expect(merged.rows.map((r) => r.status)).toEqual(['FILLED', 'FILLED']);
    expect(merged.filled).toBe(2);
  });

  it('第二遍写了没写成：只换掉第一遍同样失败的那一行的诊断；已填、待核、要你答的行都不动', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(element);
    const base = view([
      row({ label: 'A', status: 'FAILED', reason: 'IDENTITY_CHANGED', element: a! }),
      row({ label: 'B', status: 'FILLED_UNVERIFIED', element: b! }),
      row({ label: 'C', status: 'NEEDS_MANUAL', reason: 'MANUAL_ONLY', element: c! }),
      row({ label: 'D', status: 'FILLED', element: d! }),
    ]);
    const second = view(['A', 'B', 'C', 'D'].map((label, index) =>
      row({ label, status: 'FAILED', reason: 'VALUE_COERCED', element: [a, b, c, d][index]! })));

    const merged = overlayAuditView(base, second, (r) => same(r.element));

    expect(merged.rows.map((r) => [r.label, r.status, r.reason])).toEqual([
      ['A', 'FAILED', 'VALUE_COERCED'],
      ['B', 'FILLED_UNVERIFIED', null],
      ['C', 'NEEDS_MANUAL', 'MANUAL_ONLY'],
      ['D', 'FILLED', null],
    ]);
  });

  it('第二遍跳过的行（没写）不顶替第一遍的任何一行', () => {
    const a = element('a');
    const base = view([row({ label: 'A', status: 'FAILED', reason: 'IDENTITY_CHANGED', element: a })]);
    const second = view([row({ label: 'A', status: 'NEEDS_MANUAL', reason: 'MANUAL_ONLY', element: a })]);

    const merged = overlayAuditView(base, second, (r) => same(r.element));

    expect(merged.rows.map((r) => [r.status, r.reason])).toEqual([['FAILED', 'IDENTITY_CHANGED']]);
  });

  it('新出现的题插在它在页面上前一栏的后面；排在最前的放最前；认不出位置的接在最后', () => {
    const [hispanic, veteran, resume, race, intro, trailing] =
      ['hispanic', 'veteran', 'resume', 'race', 'intro', 'trailing'].map(element);
    const base = view([
      row({ label: 'Are you Hispanic/Latino?', status: 'FILLED', element: hispanic! }),
      row({ label: 'Veteran Status', status: 'FAILED', reason: 'IDENTITY_CHANGED', element: veteran! }),
      row({ label: 'Resume/CV', status: 'FILLED', element: resume! }),
    ]);
    const second = view([
      row({ label: 'Intro', status: 'NEEDS_MANUAL', reason: 'USER_ONLY', element: intro! }),
      row({ label: 'Please identify your race', status: 'FILLED', element: race! }),
      row({ label: 'Veteran Status', status: 'FILLED', element: veteran! }),
      row({ label: 'Trailing', status: 'MISSING_PROFILE', reason: 'NO_VALUE', element: trailing! }),
    ]);
    const placement = new Map<Element, AuditOverlayPlacement>([
      [intro!, { after: null }],
      [race!, { after: hispanic! }],
      [veteran!, { sameAs: veteran! }],
      [trailing!, { after: element('not-in-base') }],
    ]);

    const merged = overlayAuditView(base, second, (r) => placement.get(r.element)!);

    expect(merged.rows.map((r) => [r.label, r.status])).toEqual([
      ['Intro', 'NEEDS_MANUAL'],
      ['Are you Hispanic/Latino?', 'FILLED'],
      ['Please identify your race', 'FILLED'],
      ['Veteran Status', 'FILLED'],
      ['Resume/CV', 'FILLED'],
      ['Trailing', 'MISSING_PROFILE'],
    ]);
    expect(merged).toMatchObject({ filled: 4, requiredTotal: 6, requiredHandled: 4, blockedByUs: 1, awaitingUser: 1 });
  });
});
