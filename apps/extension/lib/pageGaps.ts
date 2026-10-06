import type { PageGap, PageGaps } from '@edaix/apply-kernel/pageGaps';

import type { AutofillDockFieldRow, AutofillDockProgress } from './dock/types';

/**
 * 页面上还空着、浮层没认出的必填，变成浮层「需要你」里的几行（2026-10-04，bench-1003 第七节第 2 条）。
 *
 * 浮层从前只数自己认出的那几行：Jobvite 上四道自己画的是非题、Rippling 的「Select」下拉从不进单子，于是总结说
 * 「这一页填好了」，连填接着替他按了网站的「Next」。读法在内核（`@edaix/apply-kernel/pageGaps`，只认公开的说法）；
 * 这里只把读出来的那几题接到单子末尾：必填、轮到他、原因写明「这一题还空着，请在网页上填」，「去这一栏」滚到那个控件。
 * 它们不进回执、不进遥测——原因码只在浮层里用（`PAGE_GAP_REASON` 不是内核的错误码，不跨任何边界）。
 */

/** 浮层上那一行的原因码（`COPY.reasons` 的键）：只在浮层里用。 */
export const PAGE_GAP_REASON = 'STILL_EMPTY';

/**
 * 一题一行：必填、轮到他、「去这一栏」滚到那个控件（只滚，不聚焦——聚焦会触发网站自己的校验）。读不出题目的用 `unnamed`
 * （「一道必填题」）当标题。
 */
export function pageGapRows(gaps: readonly PageGap[], unnamed = ''): AutofillDockFieldRow[] {
  return gaps.map((gap) => {
    const element = gap.element as Element & { scrollIntoView?: (options: { block: 'center' }) => void };
    return Object.freeze({
      label: gap.label === '' ? unnamed : gap.label,
      required: true,
      done: false,
      state: 'MANUAL' as const,
      needsUser: true,
      reason: PAGE_GAP_REASON,
      target: gap.element,
      ...(typeof element.scrollIntoView === 'function'
        ? { locate: () => { element.scrollIntoView?.({ block: 'center' }); } }
        : {}),
      ...((gap.element as { type?: unknown }).type === 'checkbox' ? { checkbox: true } : {}),
    });
  });
}

/**
 * 这一页的单子加上页面上还空着的必填。
 *
 * 已经是单子里某一行的那一栏不再加一行（同一个控件只列一次）：那一行是扫描当选填列的、网站却标了必填（Ashby 用 CSS 画的
 * 星号），就把那一行改成必填——它照它自己的原因（「我们没认出这道题」「你的资料里还没有这一项」……）进「需要你」。
 * 一题都没有就原样交回。
 */
export function withPageGaps(progress: AutofillDockProgress, gaps: PageGaps | readonly PageGap[], unnamed = ''): AutofillDockProgress {
  const list = Array.isArray(gaps) ? gaps as readonly PageGap[] : (gaps as PageGaps).unplanned;
  if (list.length === 0) return progress;
  const gapTargets = new Set(list.map((gap) => gap.element));
  let upgraded = 0;
  const rows = progress.rows.map((row) => {
    if (row.required || row.target === undefined || !gapTargets.has(row.target)) return row;
    upgraded += 1;
    return Object.freeze({ ...row, required: true });
  });
  const targets = new Set(progress.rows.flatMap((row) => (row.target === undefined ? [] : [row.target])));
  const extra = pageGapRows(list.filter((gap) => !targets.has(gap.element)), unnamed);
  if (extra.length === 0 && upgraded === 0) return progress;
  return Object.freeze({
    ...progress,
    requiredQuestions: progress.requiredQuestions + extra.length + upgraded,
    rows: Object.freeze([...rows, ...extra]),
  });
}
