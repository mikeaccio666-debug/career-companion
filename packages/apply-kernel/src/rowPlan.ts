/**
 * 增删行编排（CAP-AF-003 ①②⑤）。
 *
 * ## 它回答的问题
 *
 * 档案里有 3 段工作经历，页面上只渲染了 1 组控件——中间那两段怎么进去？
 * 答案是「按宿主的规矩点几次加一行」，而**每家的规矩不一样**：
 *
 *  · Greenhouse 点 `button.add-another-button`，新行插在按钮之前，点完就能填；
 *  · Workable 点 `button[data-ui="add-section"]` 加行，填完还必须点
 *    `button[data-ui="save-section"]` 才算这一段成立——不点的话整段丢掉；
 *  · iCIMS 的电话/地址行有行身份但档案里没有对应集合，**不参与编排**。
 *
 * 这些差异全部是厂商知识，写在 apply-rules 的 `rowScopes[].actions` 里
 * （铁律 3）；本模块只按声明排步骤，不认识任何选择器的含义。
 *
 * ## 为什么是「排步骤」而不是「直接干」
 *
 * 加一行是一次宿主点击，点完页面结构会变——行数、字段身份、可见性都得
 * **重新扫描**才知道。所以这里产出的是一份有序计划，由执行侧一步一步走，
 * 每走一步重新看一眼页面。计划本身是纯数据：可以展示给用户审阅，
 * 可以写进审计，可以在测试里逐条断言。
 *
 * ## 三条不肯让步的性质
 *
 * 1. **绝不自动删宿主原有的行。** 页面上比档案多出来的行只报告不动手——
 *    那一行里可能有用户自己刚敲进去的字。删行只用于撤销**本轮自己加的行**。
 * 2. **加不了就说加不了。** 厂商没声明 `add` 选择器时不猜一个出来，
 *    如实报 `NO_ADD_SELECTOR`，让上层告诉用户「这一家只能填前 N 段」。
 * 3. **有上限。** 执行侧每点一次加行都要复核行数真的涨了；本层再压一道
 *    静态上限，防止「点了没反应 → 继续点」变成无限点击宿主按钮。
 */

import type { RowScopeRule } from './contracts';
import { collectionRowCount } from './collectionProjection';
import type { ApplyProfileCollections } from './profileCollections';

export type RowCollection = 'education' | 'experience';

/**
 * 一次编排最多替用户点几次「加一行」。
 *
 * 12 是档案侧教育段的上限（后端持有真正的限额，见 profileCollections.ts）。
 * 这里再压一道是**防御执行侧的复核失效**：万一「点完复核行数」那一步出了
 * 差错，静态上限保证我们最多打扰宿主 12 次，而不是打到页面崩掉。
 */
export const MAX_ROW_ADDS = 12;

export type RowStep =
  /** 点宿主的「加一行」按钮，期望之后 `rowIndex` 这一行出现。 */
  | { readonly kind: 'addRow'; readonly collection: RowCollection; readonly selector: string; readonly rowIndex: number }
  /** 把档案第 `rowIndex` 段的值填进页面第 `rowIndex` 行。 */
  | { readonly kind: 'fillRow'; readonly collection: RowCollection; readonly rowIndex: number }
  /** 点行内的「保存本段」——这一下会把整段提交进宿主的数据结构。 */
  | { readonly kind: 'saveRow'; readonly collection: RowCollection; readonly rowIndex: number; readonly selector: string }
  /** 只用于撤销本轮自己加的行。 */
  | { readonly kind: 'removeRow'; readonly collection: RowCollection; readonly rowIndex: number; readonly selector: string };

export type RowUnreachableReason =
  /** 这一家没声明「加一行」按钮，页面上有几行就只能填几行。 */
  | 'NO_ADD_SELECTOR'
  /** 要加的行数超过了静态上限。 */
  | 'ROW_LIMIT';

export interface RowPlan {
  readonly steps: readonly RowStep[];
  /** 档案里有、但这一家落不下的段。上层据此如实告诉用户少填了什么。 */
  readonly unreachable: readonly {
    readonly collection: RowCollection;
    readonly count: number;
    readonly reason: RowUnreachableReason;
  }[];
  /** 页面上比档案多出来的行——只报告，绝不自动删。 */
  readonly extraRows: readonly { readonly collection: RowCollection; readonly count: number }[];
}

/** 页面当下每个集合各有几行。由执行侧活查 DOM 得出，本模块不自己去数。 */
export type PresentRowCounts = Readonly<Partial<Record<RowCollection, number>>>;

export interface RowPlanInput {
  readonly collections: ApplyProfileCollections;
  readonly scopes: readonly RowScopeRule[];
  readonly present: PresentRowCounts;
}

function nonNegativeInt(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/**
 * 一个集合的行计划。
 *
 * 步骤顺序刻意是「加一行 → 填这一行 → 存这一行」逐行推进，而不是
 * 「先加满所有行，再一起填」：Workable 上后者会把三段都填进最后一行——
 * 未保存的行在它那里共用同一组 `name`，靠行容器区分，而连点三次加行之后
 * 前两行早已被 save-section 之外的东西收走。逐行推进还有一个好处：
 * 中途任何一步失败，前面已保存的段都是完整的。
 */
function planCollection(
  collection: RowCollection,
  scope: RowScopeRule | undefined,
  wanted: number,
  present: number,
): { steps: RowStep[]; unreachable: RowPlan['unreachable'][number] | null; extra: number } {
  const steps: RowStep[] = [];
  const addSelector = scope?.actions?.add;
  const saveSelector = scope?.actions?.save;

  // 加得了多少行：先受「有没有 add 选择器」限制，再受静态上限限制。
  const shortfall = Math.max(0, wanted - present);
  const addable = addSelector === undefined ? 0 : Math.min(shortfall, MAX_ROW_ADDS);
  const reachable = present + addable;

  for (let rowIndex = 0; rowIndex < Math.min(wanted, reachable); rowIndex += 1) {
    if (rowIndex >= present && addSelector !== undefined) {
      steps.push({ kind: 'addRow', collection, selector: addSelector, rowIndex });
    }
    steps.push({ kind: 'fillRow', collection, rowIndex });
    if (saveSelector !== undefined) {
      steps.push({ kind: 'saveRow', collection, rowIndex, selector: saveSelector });
    }
  }

  const missed = wanted - Math.min(wanted, reachable);
  const unreachable =
    missed > 0
      ? {
          collection,
          count: missed,
          reason: (addSelector === undefined ? 'NO_ADD_SELECTOR' : 'ROW_LIMIT') as RowUnreachableReason,
        }
      : null;

  return { steps, unreachable, extra: Math.max(0, present - wanted) };
}

/**
 * 把「档案里有几段 + 页面上有几行 + 这一家的行动作」排成一份有序计划。
 *
 * 纯函数：不查 DOM、不点任何东西。行数由调用方活查后传进来，因为只有
 * 调用方知道当下页面长什么样，而页面每走一步都会变。
 */
export function planRows(input: RowPlanInput): RowPlan {
  const { collections, scopes, present } = input;
  const steps: RowStep[] = [];
  const unreachable: RowPlan['unreachable'][number][] = [];
  const extraRows: RowPlan['extraRows'][number][] = [];

  // 教育在前、经历在后是**确定的顺序**，不是任意选的：计划要能展示给用户
  // 审阅，同一份档案在同一个页面上必须每次排出同一份计划。
  for (const collection of ['education', 'experience'] as const) {
    // 同一集合声明了多条行作用域时取第一条：多条通常意味着一个集合被拆成
    // 几个 DOM 区（少见），编排只认第一条并如实按它的行数走，好过在几条
    // 之间猜一个合并规则。
    const scope = scopes.find((rule) => rule.collection === collection);
    const wanted = collectionRowCount(collections, collection);
    const result = planCollection(collection, scope, wanted, nonNegativeInt(present[collection]));
    steps.push(...result.steps);
    if (result.unreachable) unreachable.push(result.unreachable);
    if (result.extra > 0) extraRows.push({ collection, count: result.extra });
  }

  return { steps, unreachable, extraRows };
}

/**
 * 撤销：把本轮自己加的行删掉。
 *
 * **倒序删**，与行身份的模型是同一个道理：从末尾删不改动任何还留着的行的
 * 序号；从中间删会让它后面每一行的行标识全部前移，而那些行的值是用户的，
 * 我们刚承诺过不动它们。
 *
 * 只接受**本轮自己加的**行序号。宿主原有的行不在这里出现，也不该出现——
 * 那一行里可能有用户自己敲进去的字。
 */
export function planAddedRowRemoval(
  collection: RowCollection,
  scope: RowScopeRule | undefined,
  addedRowIndexes: readonly number[],
): readonly RowStep[] {
  const selector = scope?.actions?.remove;
  if (selector === undefined) return [];
  return [...addedRowIndexes]
    .filter((rowIndex) => Number.isInteger(rowIndex) && rowIndex >= 0)
    .sort((left, right) => right - left)
    .map((rowIndex) => ({ kind: 'removeRow', collection, rowIndex, selector }) as const);
}
