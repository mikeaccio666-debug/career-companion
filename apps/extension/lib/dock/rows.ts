import { COPY, type DockCopy } from './copy';
import type { AutofillDockFieldRow, DockRowState } from './types';

/**
 * 一栏在浮层上的样子（设计原型里的 `st`）。
 *
 * `aborted` 与 `failed` 分开：前者是这一轮没跑到（停止、翻页），后者是试了没填上。
 * `unverified` 是写了但网站没确认。四者都算「需要你」。
 * `ai` 是 AI 代答写成的（2026-09-23）：算已填好，但单列一组、网页上挂标记，提交前要他核对。
 */
export type RowStatus = 'pending' | 'writing' | 'written' | 'ok' | 'signed' | 'ai' | 'manual' | 'failed' | 'aborted' | 'unverified';

export interface DockRow {
  /** 同一轮里稳定：行的次序在整轮里不变（中段屏与终局屏是同一张单子）。 */
  readonly key: string;
  readonly q: string;
  readonly req: boolean;
  readonly st: RowStatus;
  readonly reason: string | null;
  readonly value: string | null;
  readonly hint: string | null;
  /** 推出来的答案的依据（稳定码）；不是推出来的是 null。 */
  readonly basis: NonNullable<AutofillDockFieldRow['historyBasis']> | null;
  readonly signed: NonNullable<AutofillDockFieldRow['signedOnBehalf']> | null;
  /** AI 代答写的（写成了，不论网站确认没有）：网页上那一栏挂标记 D。 */
  readonly ai: boolean;
  readonly checkbox: boolean;
  readonly attachment: boolean;
  /** 网页上原有内容、我们没动（仍算「已填好」）。 */
  readonly preserved: boolean;
  /** 网站在我们附上简历之后自己从简历里读出来填的（仍算「已填好」，但照实写来源）。 */
  readonly fromResume: boolean;
  /** 这一轮要写的一格：收尾那一刻的样子不算用户补的（见 AutofillDockFieldRow.planned）。 */
  readonly planned: boolean;
  readonly target: Element | null;
  readonly source: AutofillDockFieldRow;
}

export const NEED_STATUSES: ReadonlySet<RowStatus> = new Set<RowStatus>(['manual', 'failed', 'aborted', 'unverified']);

export function rowStateOf(row: AutofillDockFieldRow): DockRowState {
  return row.state ?? (row.done ? 'CONFIRMED' : row.needsUser === true ? 'MANUAL' : 'PENDING');
}

export function toDockRow(row: AutofillDockFieldRow, index: number, copy: DockCopy = COPY): DockRow {
  const state = rowStateOf(row);
  const st: RowStatus =
    state === 'PENDING' ? 'pending'
    : state === 'WRITING' ? 'writing'
    : state === 'WRITTEN' ? 'written'
    : state === 'CONFIRMED' ? (row.signedOnBehalf !== undefined ? 'signed' : row.aiAnswered === true ? 'ai' : 'ok')
    : state === 'PRESERVED' ? 'ok'
    : state === 'UNVERIFIED' ? 'unverified'
    : state === 'MANUAL' ? 'manual'
    : row.reason === 'ABORTED' ? 'aborted' : 'failed';
  return Object.freeze({
    key: `${index}:${row.label}`,
    // 一段经历／教育（保存了的、没存上的、没加上的）：这一行说的是「第几段」，不是保存钮或「加一行」上的字。
    q: row.unsavedEntry !== undefined
      ? copy.unsavedEntry.question(row.unsavedEntry.collection, row.unsavedEntry.number)
      : row.savedEntry !== undefined
        ? copy.unsavedEntry.question(row.savedEntry.collection, row.savedEntry.number)
        : row.unaddedEntries !== undefined
          ? copy.unsavedEntry.range(row.unaddedEntries.collection, row.unaddedEntries.from, row.unaddedEntries.to)
          : row.label,
    req: row.required,
    st,
    reason: row.reason ?? (st === 'unverified' ? 'HOST_UNCONFIRMED' : null),
    value: row.value ?? null,
    hint: row.hint ?? null,
    basis: row.historyBasis ?? null,
    signed: row.signedOnBehalf ?? null,
    ai: row.aiAnswered === true && (state === 'CONFIRMED' || state === 'UNVERIFIED'),
    checkbox: row.checkbox === true,
    attachment: row.attachment === true,
    preserved: state === 'PRESERVED',
    fromResume: state === 'PRESERVED' && row.fromResume === true,
    planned: row.planned === true,
    target: row.target ?? null,
    source: row,
  });
}

/**
 * 「需要你」只列必填（设计：总结里的数、列表里的行、进度条上橙色与珊瑚色的段，三者要对得上）。
 * 选填里没填上的不催用户：不进列表，进度条上也画成中性色。
 */
export function isNeed(row: DockRow): boolean {
  return row.req && NEED_STATUSES.has(row.st);
}
