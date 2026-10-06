import type { DockCopy } from './copy';
import type { NeedKind } from './needs';
import type { DockRow } from './rows';

/**
 * 进度卡说此刻在做什么（2026-09-28 负责人：进度要说人话——「正在读表单」「正在匹配选项」「正在等 AI」「正在填工作经历 2/3」
 * 「正在为这个岗位写求职信」），底下一行实时的数：已填 · AI 写的 · 需要你 · 按规定不代填。不编百分比。
 */
export interface ActivityState {
  /** 还在读表、对资料（第一栏还没开写）。`prep`：0 读表，1 对资料。 */
  readonly preparing: boolean;
  readonly prep: 0 | 1;
  /** AI 在起草（规则那几遍写完了）。 */
  readonly ai: boolean;
  /** 求职信在写。 */
  readonly letter: boolean;
  /** 连填这一页那一行（第几页、这一步叫什么）；不是连填就是 null。 */
  readonly chain: string | null;
  readonly rows: readonly DockRow[];
}

/** 这一栏是不是一道要在选项里挑的题（下拉、单选组、组合框、ARIA 单选）：写它的时候说「正在匹配选项」。 */
export function isChoiceControl(element: Element | null): boolean {
  if (element === null) return false;
  const view = element.ownerDocument.defaultView;
  if (view !== null && element instanceof view.HTMLSelectElement) return true;
  const role = (element.getAttribute('role') ?? '').toLowerCase();
  if (role === 'combobox' || role === 'listbox' || role === 'radio' || role === 'radiogroup') return true;
  if ((element.getAttribute('aria-haspopup') ?? '').toLowerCase() === 'listbox' || element.hasAttribute('aria-autocomplete')) return true;
  if (view !== null && element instanceof view.HTMLInputElement) return element.type === 'radio';
  return element.tagName === 'BUTTON' && element.hasAttribute('aria-pressed');
}

/** 进度卡上那一行。 */
export function activityStatus(state: ActivityState, copy: DockCopy): string {
  if (state.chain !== null) return state.chain;
  if (state.ai) return copy.run.waitingAi;
  if (state.letter) return copy.run.writingLetter;
  if (state.preparing) return state.prep === 0 ? copy.run.readingForm : copy.run.matchingProfile;
  const current = state.rows.find((row) => row.st === 'writing');
  if (current === undefined) return state.rows.some((row) => row.st === 'written') ? copy.run.confirmingShort : copy.run.filling;
  const section = current.source.collection;
  if (section !== undefined) return copy.run.section(section.kind, section.number, section.total);
  return isChoiceControl(current.target) ? copy.run.matchingOptions : copy.run.filling;
}

export interface Tally {
  readonly filled: number;
  readonly ai: number;
  readonly needs: number;
  readonly kept: number;
}

/**
 * 实时的数：已填（我们写好、代填的，页面上本来就有的也算）、AI 写的、需要你（还没办好的必填）、按规定不代填（留给他本人的必填）。
 * `kindOf`：这一行在「需要你」里属于哪一组（不是要他处理的就是 null）；`resolved`：他已经办好了。
 */
export function tallyOf(rows: readonly DockRow[], kindOf: (row: DockRow) => NeedKind | null, resolved: (row: DockRow) => boolean): Tally {
  let filled = 0;
  let ai = 0;
  let needs = 0;
  let kept = 0;
  for (const row of rows) {
    if (row.st === 'ok' || row.st === 'signed') filled += 1;
    else if (row.st === 'ai') ai += 1;
    const kind = kindOf(row);
    if (kind === null || resolved(row)) continue;
    if (kind === 'decide') kept += 1;
    else needs += 1;
  }
  return { filled, ai, needs, kept };
}
