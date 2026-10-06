/**
 * 增删行编排的执行侧接缝（P1-8b）：把 `rowPlan.ts` 排出来的「加一行」真正点下去。
 *
 * ## 这里是选择器唯一被解释的地方
 *
 * 「一行」是什么、「加一行」按哪里，都是 apply-rules 的 `rowScopes` 数据（铁律 3 /
 * RULE-KERNEL-RULE-DATA-SEPARATION）。它们随描述符（`ApplyFormDescriptor.rowScopes`）带进来，
 * 在本模块里解释成元素，出去的只有集合名、行序与稳定原因码——扩展侧不碰任何选择器。
 *
 * ## 一次只加一行，加完必须重扫
 *
 * 加一行是一次宿主点击，点完页面结构就变了：行数、字段身份、封存基线全部作废。所以本模块
 * 不提供「加满再填」，只提供几件事：数页面此刻有几行（`presentRowCounts`）、按档案说下一步
 * 是不是要加一行（`describeRowAdds`）、把那一下点出去（`clickAddRow`）。调用方每点一次就
 * 重新扫一遍页面，为新行另建计划、另铸票据；行数没涨就停。
 *
 * ## 每一段要单独保存的区（2026-09-24）
 *
 * 规则声明了 `actions.save` 的区（Workable 的「Update」）：一段加出来是一个编辑框，填完按它自己的保存钮
 * 才算留下，保存之前这个区加不了下一段。负责人 2026-09-24 定了「和 Jobright 一样全加全存」，于是多了三件事：
 * 找到新编辑框在哪一行（`entryEditorState`——Workable 把它插在**最前面**，不是行尾）、让那一行按资料里的
 * 第几段投影（`collectionsForRow`）、填完回读过之后把那一颗保存点出去（`clickSaveRow`）。保存成没成由调用方
 * 看 `entryEditorState`：编辑框收起、行数没少，才算这一段留下了。
 *
 * ## 行专用票
 *
 * `clickAddRow` 与 `clickSaveRow` 要的是 `mintRowActionAuthorityFromGesture` 铸的票，一张只许一种（加一行，
 * 或保存本段）；删行不从这条路出去。远程策略的 `manage-rows` 位由 `clickHostTarget` 按 policy 检查——
 * fail closed。
 */

import { collectClickFacts } from './click/facts';
import { clickHostTarget } from './click/primitives';
import { collectionRowCount, isCollectionFieldRole } from './collectionProjection';
import type {
  ApplyErrorCode,
  ApplyFormDescriptor,
  ApplyPlan,
  ApplyPlanEntry,
  Result,
  RowScopeRule,
} from './contracts';
import { fieldRowIndex } from './fieldIdentity';
import { consumeAuthority, releaseAuthority, type HostWriteAuthority } from './grant';
import type { ApplyPolicy } from './policy';
import type { ApplyProfileCollections, ProfileEducation, ProfileExperience } from './profileCollections';
import { MAX_ROW_ADDS, planRows, type PresentRowCounts, type RowCollection, type RowPlan } from './rowPlan';
import type { UndoJournal } from './undo';
import { runWithSubmitVeto } from './write/submitVeto';

export { MAX_ROW_ADDS };
export type { PresentRowCounts, RowCollection, RowPlan };

function scopeFor(descriptor: ApplyFormDescriptor, collection: RowCollection): RowScopeRule | undefined {
  // 与 planRows 同一条约定：同一集合声明了多条作用域时只认第一条。
  return (descriptor.rowScopes ?? []).find((rule) => rule.collection === collection);
}

function safeQuery(descriptor: ApplyFormDescriptor, selector: string): readonly Element[] {
  try {
    return descriptor.root.querySelectorAll(selector);
  } catch {
    return [];
  }
}

/**
 * 页面此刻每个集合各有几行——按规则声明的容器与行选择器活查 DOM。
 *
 * 只数**第一个**容器里的行（planRows 也只按第一条作用域排步骤）；`idPrefix` 模型没有行元素、
 * 也没有集合，不参与。查不到容器 = 0 行。
 */
export function presentRowCounts(descriptor: ApplyFormDescriptor): PresentRowCounts {
  const present: Partial<Record<RowCollection, number>> = {};
  for (const collection of ['education', 'experience'] as const) {
    const scope = scopeFor(descriptor, collection);
    if (scope === undefined || scope.kind !== 'contains') continue;
    const containers = safeQuery(descriptor, scope.container);
    const section = containers[0];
    if (section === undefined) {
      present[collection] = 0;
      continue;
    }
    present[collection] = safeQuery(descriptor, scope.row).filter((row) => section.contains(row)).length;
  }
  return Object.freeze(present);
}

export interface RowAddDescription {
  readonly plan: RowPlan;
  readonly present: PresentRowCounts;
  /**
   * 下一步要加的那一行；null = 不需要再加。`rowIndex`：接在最后的区里加完之后它的行序（= 已有几行）。
   * `entryIndex`：这一行填资料里的第几段（0 基）——接在最后的区就是 `rowIndex`；插在最前面的区
   * （`insertsAt: 'top'`）从资料的最后一段加起，页面上最后从上到下才是资料的顺序。
   */
  readonly next: Readonly<{ collection: RowCollection; rowIndex: number; entryIndex: number }> | null;
}

/** 这个区的新行插在最前面（规则声明 `insertsAt: 'top'`）：资料里的各段从最后一段加起。 */
function insertsAtTop(descriptor: ApplyFormDescriptor, collection: RowCollection): boolean {
  return scopeFor(descriptor, collection)?.insertsAt === 'top';
}

/**
 * 资料里还没加进这个区的那几段（0 基，含两端）；都加了就是 null。
 *
 * 按段数算（与 `planRows` 同一个假设：页面上已有的行对应资料里已经加过的那几段）：接在最后的区，已有 k 行就是第 k 段
 * 以后的；插在最前面的区从最后一段加起，已有 k 行就是前面 n−k 段。他把没加上的补齐之后再点一次自动填写，会接着加。
 */
export function remainingEntries(
  descriptor: ApplyFormDescriptor,
  collections: ApplyProfileCollections,
  collection: RowCollection,
): Readonly<{ from: number; to: number }> | null {
  const wanted = collectionRowCount(collections, collection);
  const present = presentRowCounts(descriptor)[collection] ?? 0;
  if (present >= wanted) return null;
  return Object.freeze(insertsAtTop(descriptor, collection)
    ? { from: 0, to: wanted - present - 1 }
    : { from: present, to: wanted - 1 });
}

/**
 * 按档案段数与页面行数说下一步：要不要加一行、加给哪个集合。纯函数，不点任何东西。
 *
 * `skip` 里的集合这一轮不再加行（2026-09-24）：每一段要单独保存的区（Workable），有一段没能保存下来
 * （缺必填、没回读成、网站没收下），那个编辑框还开着，这个区就加不了下一段。跳过它，下一步去看另一个区。
 */
export function describeRowAdds(
  descriptor: ApplyFormDescriptor,
  collections: ApplyProfileCollections,
  skip: ReadonlySet<RowCollection> = new Set(),
): RowAddDescription {
  const present = presentRowCounts(descriptor);
  const plan = planRows({ collections, scopes: descriptor.rowScopes ?? [], present });
  // 这一页上根本没有这个区（skroutz 只有经历区，没有教育区）：不给它加行——没有它自己的「加一行」可点。
  const onPage = (collection: RowCollection): boolean => {
    const scope = scopeFor(descriptor, collection);
    return scope?.kind !== 'contains' || safeQuery(descriptor, scope.container).length > 0;
  };
  const step = plan.steps.find((candidate) =>
    candidate.kind === 'addRow' && !skip.has(candidate.collection) && onPage(candidate.collection));
  const entryIndex = (collection: RowCollection, rowIndex: number): number =>
    insertsAtTop(descriptor, collection) ? collectionRowCount(collections, collection) - 1 - rowIndex : rowIndex;
  return Object.freeze({
    plan,
    present,
    next: step === undefined
      ? null
      : Object.freeze({ collection: step.collection, rowIndex: step.rowIndex, entryIndex: entryIndex(step.collection, step.rowIndex) }),
  });
}

/**
 * 这个集合的每一段要不要单独保存（规则声明了 `actions.save`，Workable 的「Update」）。
 *
 * 保存会把一整段提交进宿主的表单状态（撤销只能靠删行，见 grant.ts 的 `manage-rows`），保存之前这个区加不了
 * 下一段。2026-09-24 起这种区也逐段加满：加一段、填好、回读过，再用保存票按那一段自己的保存钮（`clickSaveRow`）。
 */
export function rowNeedsSave(descriptor: ApplyFormDescriptor, collection: RowCollection): boolean {
  return scopeFor(descriptor, collection)?.actions?.save !== undefined;
}

/** 这个集合在页面上的行（第一个容器里的，DOM 顺序）；区不在这一页、或不是 `contains` 模型就是空的。 */
function sectionRows(descriptor: ApplyFormDescriptor, scope: RowScopeRule | undefined): readonly Element[] {
  if (scope === undefined || scope.kind !== 'contains') return [];
  const section = safeQuery(descriptor, scope.container)[0];
  if (section === undefined) return [];
  return safeQuery(descriptor, scope.row).filter((candidate) => section.contains(candidate));
}

/** 这个集合第 `rowIndex` 行里规则声明的保存控件（恰好一个才算）；没有就 null。 */
export function rowSaveControl(
  descriptor: ApplyFormDescriptor,
  collection: RowCollection,
  rowIndex: number,
): Element | null {
  const scope = scopeFor(descriptor, collection);
  const selector = scope?.actions?.save;
  if (selector === undefined) return null;
  const row = sectionRows(descriptor, scope)[rowIndex];
  if (row === undefined) return null;
  const controls = safeQuery(descriptor, selector).filter((control) => row.contains(control));
  return controls.length === 1 ? controls[0]! : null;
}

/** 这个集合第 `rowIndex` 行的行元素（定位用：一段保存之后，浮层上那一行滚到它）。 */
export function rowElementAt(
  descriptor: ApplyFormDescriptor,
  collection: RowCollection,
  rowIndex: number,
): Element | null {
  return sectionRows(descriptor, scopeFor(descriptor, collection))[rowIndex] ?? null;
}

/**
 * 这个集合的区里规则声明的「加一行」控件（恰好一个才算），找不到就退回区容器本身；区不在这一页就是 null。
 * 只拿来定位：没加上的那几段在浮层上的那一行，滚到这里。
 */
export function rowAddAnchor(descriptor: ApplyFormDescriptor, collection: RowCollection): Element | null {
  const scope = scopeFor(descriptor, collection);
  if (scope === undefined || scope.kind !== 'contains') return null;
  const section = safeQuery(descriptor, scope.container)[0];
  if (section === undefined) return null;
  const selector = scope.actions?.add;
  const controls = selector === undefined ? [] : safeQuery(descriptor, selector).filter((control) => section.contains(control));
  return controls.length === 1 ? controls[0]! : section;
}

export interface EntryEditorState {
  /** 这个区此刻有几行（已保存的段与开着的编辑框都算）。 */
  readonly rows: number;
  /** 里面有规则声明的保存控件的那几行的行序——也就是开着、还没保存的编辑框。 */
  readonly open: readonly number[];
}

/**
 * 每一段要单独保存的区此刻的样子：几行、哪几行是开着的编辑框。
 *
 * 两处用它（2026-09-24）：加完一段，新编辑框在哪一行——Workable 把它插在**最前面**，已保存的卡片往后挪，
 * 所以不能按「行尾那一行」去找；按了保存之后，这一段留下了没有——编辑框收起（`open` 空了）、行数没少，
 * 才算留下。没声明保存控件的区永远 `open: []`。
 */
export function entryEditorState(descriptor: ApplyFormDescriptor, collection: RowCollection): EntryEditorState {
  const scope = scopeFor(descriptor, collection);
  const rows = sectionRows(descriptor, scope);
  const selector = scope?.actions?.save;
  const controls = selector === undefined ? [] : safeQuery(descriptor, selector);
  const open = rows.flatMap((row, index) => (controls.some((control) => row.contains(control)) ? [index] : []));
  return Object.freeze({ rows: rows.length, open: Object.freeze(open) });
}

/**
 * 一份只让第 `rowIndex` 行投影资料里第 `entryIndex` 段的集合视图（2026-09-24）。
 *
 * 投影层按「页面第 N 行拿资料第 N 段」取值（collectionProjection.ts）。Workable 把每一段新编辑框都插在最前面，
 * 于是第 2、第 3 段的编辑框也在第 0 行——照老规矩投影，每一段都会填成资料里的第 1 段。这里把要填的那一段
 * 放到编辑框所在的行上，其余行一概没有值（稀疏数组的空位就是「这一行没有对应的段」）；另一个集合整个留空。
 * 只拿来为这一行建计划、再按行切片（`rowPlanSlice`），不拿来数段数。
 */
export function collectionsForRow(
  collections: ApplyProfileCollections,
  collection: RowCollection,
  rowIndex: number,
  entryIndex: number,
): ApplyProfileCollections {
  const only = <T>(list: readonly T[] | undefined): readonly T[] => {
    const placed: T[] = [];
    const entry = list?.[entryIndex];
    if (entry !== undefined && Number.isInteger(rowIndex) && rowIndex >= 0) placed[rowIndex] = entry;
    return placed;
  };
  return collection === 'experience'
    ? { educations: [] as readonly ProfileEducation[], experiences: only<ProfileExperience>(collections.experiences) }
    : { educations: only<ProfileEducation>(collections.educations), experiences: [] as readonly ProfileExperience[] };
}

export interface ClickAddRowInput {
  readonly descriptor: ApplyFormDescriptor;
  readonly collection: RowCollection;
  /** 必须是 `mintRowAddAuthorityFromGesture` 铸的票；这里消费它，点完即释放。 */
  readonly authority: HostWriteAuthority;
  readonly journal: UndoJournal;
  readonly policy: ApplyPolicy;
  readonly now?: number;
}

/**
 * 点这一家声明的「加一行」。
 *
 * 控件必须**恰好一个**：一个都没有是页面与规则对不上，两个以上是规则要更新——两种都不猜，
 * 如实 CLICK_DENIED。点击本身走 `clickHostTarget`：policy 的 `manage-rows` 位、票据的能力与
 * 烙印、facts 的 `declaredRowAction === 'add'`、隐藏 / 禁用 / 提交类控件的否决，一条不少。
 */
export function clickAddRow(input: ClickAddRowInput): Result<void, ApplyErrorCode> {
  const scope = scopeFor(input.descriptor, input.collection);
  const selector = scope?.actions?.add;
  if (selector === undefined) return { ok: false, code: 'CLICK_DENIED' };
  // 只认这个区**自己**的那一颗（2026-09-24）：Workable 的经历区、教育区各有一颗同样的「+ Add」
  // （`button[data-ui="add-section"]`）。从前在整张表里数：两个区都在时两颗、判歧义不点；只有经历区时
  // 恰好一颗——于是要给**教育**加行的那一下点在了经历区的按钮上（skroutz 实测：编辑框开在经历区、里面空着、
  // 我们还以为教育区没反应）。区不在这一页上就不加；区里恰好一颗才点。
  const section = scope?.kind === 'contains' ? safeQuery(input.descriptor, scope.container)[0] : undefined;
  if (section === undefined) return { ok: false, code: 'CLICK_DENIED' };
  const candidates = safeQuery(input.descriptor, selector).filter((candidate) => section.contains(candidate));
  if (candidates.length !== 1) return { ok: false, code: 'CLICK_DENIED' };
  const element = candidates[0]!;

  const consumed = consumeAuthority(input.authority, input.now);
  if (!consumed.ok) return consumed;
  try {
    const facts = collectClickFacts({
      element,
      root: input.descriptor.root,
      kind: 'row-add',
      planned: true,
      declaredRowAction: 'add',
    });
    return clickHostTarget({
      element,
      facts,
      root: input.descriptor.root,
      authority: consumed.value,
      ticket: input.journal.recordStructuralAction(),
      policy: input.policy,
    });
  } catch {
    return { ok: false, code: 'CLICK_DENIED' };
  } finally {
    releaseAuthority(consumed.value);
  }
}

export interface ClickSaveRowInput {
  readonly descriptor: ApplyFormDescriptor;
  readonly collection: RowCollection;
  /** 那一段所在的行（`entryEditorState(...).open` 里的那一个）。 */
  readonly rowIndex: number;
  /** 必须是 `mintRowActionAuthorityFromGesture({ action: 'save' })` 铸的票；这里消费它，点完即释放。 */
  readonly authority: HostWriteAuthority;
  readonly journal: UndoJournal;
  readonly policy: ApplyPolicy;
  readonly now?: number;
}

/**
 * 点这一段自己的「保存本段」（规则声明的 `actions.save`，Workable 的「Update」；2026-09-24 负责人决定放行）。
 *
 * 控件必须是**这一行里恰好一个**规则声明的保存控件，否则如实 CLICK_DENIED、一下都不点。点击走
 * `clickHostTarget`：policy 的 `manage-rows` 位、保存票的动作烙印、facts 的 `declaredRowAction === 'save'`、
 * 隐藏／禁用／提交类控件的否决，一条不少——type=submit、表单里省略 type 的按钮、名字像提交的（「Save and
 * continue」）一律点不了，click 的默认动作照旧预先取消。再加一层：这一下派发期间宿主若想提交或重置整张表
 * （监听器里调 `requestSubmit()`），当场取消，这一下作废（ABORTED）。
 *
 * 点没点成只看这一下；这一段留下了没有，由调用方随后看 `entryEditorState`（编辑框收起、行数没少）。
 */
export function clickSaveRow(input: ClickSaveRowInput): Result<void, ApplyErrorCode> {
  const element = rowSaveControl(input.descriptor, input.collection, input.rowIndex);
  if (element === null) return { ok: false, code: 'CLICK_DENIED' };

  const consumed = consumeAuthority(input.authority, input.now);
  if (!consumed.ok) return consumed;
  try {
    const facts = collectClickFacts({
      element,
      root: input.descriptor.root,
      kind: 'row-save',
      planned: true,
      declaredRowAction: 'save',
    });
    let outcome: Result<void, ApplyErrorCode> | null = null;
    const unvetoed = runWithSubmitVeto(element.ownerDocument, element.getRootNode(), () => {
      outcome = clickHostTarget({
        element,
        facts,
        root: input.descriptor.root,
        authority: consumed.value,
        ticket: input.journal.recordStructuralAction(),
        policy: input.policy,
      });
    });
    // 这一下期间有人试图提交或重置整张表：拦下了，但这一下就此作废（与代理题同一个码）。
    if (!unvetoed) return { ok: false, code: 'ABORTED' };
    return outcome ?? { ok: false, code: 'ABORTED' };
  } catch {
    return { ok: false, code: 'CLICK_DENIED' };
  } finally {
    releaseAuthority(consumed.value);
  }
}

/** 一份计划里落在第 `rowIndex` 行的行内条目——加完行、重扫之后，只填新加的那一行。 */
export function rowEntries(
  plan: ApplyPlan,
  descriptor: ApplyFormDescriptor,
  rowIndex: number,
): readonly ApplyPlanEntry[] {
  return plan.entries.filter(
    (entry) => isCollectionFieldRole(entry.key) && fieldRowIndex(entry.element, descriptor.root) === rowIndex,
  );
}

/**
 * 新加那一行的计划切片：条目与跳过项都只留这一行的。
 *
 * 跳过项也要切——重扫后的整份计划把第 1 行已经填好的格记成 NOT_EMPTY（「已预填」），
 * 那是上一轮的账，不能再记一遍；新行里没有值的格（NO_VALUE）则该如实出现在这一行的单子上。
 *
 * `collection`：只留这个区的格。行序在每个区里各数各的，经历第 N 行与教育第 N 行行序相同——不给区，另一个区
 * 同一行序的格也会切进来：再走一遍、在单子上再记一遍（2026-09-28 Workday 第 2 页：教育后 3 段缺学位，浮层列出
 * 6 个「Degree 资料里没有」）。加行的调用方都该给。
 */
export function rowPlanSlice(
  plan: ApplyPlan,
  descriptor: ApplyFormDescriptor,
  rowIndex: number,
  collection?: RowCollection,
): ApplyPlan {
  const inRow = (element: Element) => fieldRowIndex(element, descriptor.root) === rowIndex;
  const inCollection = (key: string | null) =>
    isCollectionFieldRole(key) && (collection === undefined || key.startsWith(`${collection}.`));
  return {
    ...plan,
    entries: plan.entries.filter((entry) => inCollection(entry.key) && inRow(entry.element)),
    skipped: plan.skipped.filter((skip) => inCollection(skip.key) && inRow(skip.element)),
  };
}

/**
 * 一段编辑框的计划切片（2026-09-24）：只留**这个集合**第 `rowIndex` 行里的行内条目与跳过项。
 *
 * 与 `rowPlanSlice` 的差别是认行靠行元素的包含关系，不只靠行序：行序在每个区里各数各的，Workable 的经历区与
 * 教育区都有「第 0 行」——教育那一段没存上、编辑框还开着时，再给经历加一段，只按行序切会把教育编辑框里的格
 * 也切进来。行不在页面上就是空切片。
 */
export function entryPlanSlice(
  plan: ApplyPlan,
  descriptor: ApplyFormDescriptor,
  collection: RowCollection,
  rowIndex: number,
): ApplyPlan {
  const row = rowElementAt(descriptor, collection, rowIndex);
  const inRow = (element: Element) => row !== null && row.contains(element);
  return {
    ...plan,
    entries: plan.entries.filter((entry) => isCollectionFieldRole(entry.key) && inRow(entry.element)),
    skipped: plan.skipped.filter((skip) => isCollectionFieldRole(skip.key) && inRow(skip.element)),
  };
}
