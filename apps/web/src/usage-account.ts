import { createElement as h, type ReactElement } from 'react';
import type { AccountUsage, PublicAccountUsage } from '@companion/platform-contracts';

export type UsageRead = (path: string, init: RequestInit) => Promise<unknown>;
export type UsageAccountState =
  | { accountId: string | null; status: 'idle' | 'loading' }
  | { accountId: string; status: 'ready'; usage: AccountUsage | PublicAccountUsage }
  | { accountId: string; status: 'failed'; error: string };
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const tokenCount = (value: unknown): value is number | null => value === null || count(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Count data only. Reject malformed responses instead of rendering invented zeroes. */
export function accountUsageResponse(value: unknown): AccountUsage;
export function accountUsageResponse(value: unknown, aggregate: true): PublicAccountUsage;
export function accountUsageResponse(value: unknown, aggregate = false): AccountUsage | PublicAccountUsage {
  if (!object(value) || !object(value.usage)) throw new Error('用量服务没有返回有效统计。');
  const usage = value.usage, period = usage.period, chat = usage.chat;
  if (!object(period) || period.timeZone !== 'UTC' || typeof period.from !== 'string' || typeof period.to !== 'string' ||
    !Number.isFinite(Date.parse(period.from)) || !Number.isFinite(Date.parse(period.to)) || Date.parse(period.from) >= Date.parse(period.to) ||
    !object(chat) || !['none', 'partial', 'complete'].includes(String(chat.coverage)) ||
    !['calls', 'reportedCalls', 'missingCalls', 'invalidCalls', 'pendingCalls', 'legacyReports'].every((key) => count(chat[key])) ||
    !tokenCount(chat.inputTokens) || !tokenCount(chat.outputTokens) || !object(chat.outcomes) ||
    !['complete', 'failed', 'cancelled', 'interrupted', 'running'].every((key) => count((chat.outcomes as Record<string, unknown>)[key])) ||
    !aggregate && (!Array.isArray(chat.providers) || !chat.providers.every((row) => object(row) &&
      typeof row.provider === 'string' && typeof row.model === 'string' && count(row.calls) && count(row.reportedCalls) &&
      tokenCount(row.inputTokens) && tokenCount(row.outputTokens)))) throw new Error('用量服务没有返回有效统计。');
  if (!aggregate) return usage as unknown as AccountUsage;
  return { period: { from: period.from, to: period.to, timeZone: 'UTC' }, chat: {
    calls: chat.calls as number, reportedCalls: chat.reportedCalls as number, missingCalls: chat.missingCalls as number, invalidCalls: chat.invalidCalls as number, pendingCalls: chat.pendingCalls as number,
    inputTokens: chat.inputTokens as number | null, outputTokens: chat.outputTokens as number | null, coverage: chat.coverage as PublicAccountUsage['chat']['coverage'],
    outcomes: { complete: chat.outcomes.complete as number, failed: chat.outcomes.failed as number, cancelled: chat.outcomes.cancelled as number, interrupted: chat.outcomes.interrupted as number, running: chat.outcomes.running as number }, legacyReports: chat.legacyReports as number } };
}

/** One private request lane: account transitions, retry and unmount invalidate both success and failure. */
export class UsageAccountController {
  private accountId: string | null = null;
  private generation = 0;
  private live = false;
  private pending: AbortController | null = null;
  private read: UsageRead;
  private publish: (state: UsageAccountState) => void;
  private aggregate: boolean;
  constructor(read: UsageRead, publish: (state: UsageAccountState) => void, options: { aggregate?: boolean } = {}) { this.read = read; this.publish = publish; this.aggregate = options.aggregate === true; }
  activate(accountId: string): Promise<'applied' | 'failed' | 'discarded'> {
    this.invalidate(); this.accountId = accountId; this.live = true;
    return this.refresh();
  }
  private invalidate() { ++this.generation; this.pending?.abort(); this.pending = null; }
  dispose() { this.live = false; this.accountId = null; this.invalidate(); }
  async refresh(): Promise<'applied' | 'failed' | 'discarded'> {
    if (!this.live || !this.accountId) return 'discarded';
    this.invalidate();
    const accountId = this.accountId, generation = this.generation, controller = new AbortController();
    this.pending = controller;
    const current = () => this.live && this.accountId === accountId && this.generation === generation && !controller.signal.aborted;
    this.publish({ accountId, status: 'loading' });
    try {
      const response = await this.read('/usage', { signal: controller.signal });
      if (!current()) return 'discarded';
      const usage = this.aggregate ? accountUsageResponse(response, true) : accountUsageResponse(response);
      this.publish({ accountId, status: 'ready', usage });
      return 'applied';
    } catch (error) {
      if (!current()) return 'discarded';
      const unauthorized = object(error) && error.status === 401;
      this.publish({ accountId, status: 'failed', error: unauthorized ? '无法读取本月用量，请重新登录后再试。' : '暂时无法读取本月用量，请重试。' });
      return 'failed';
    } finally { if (current()) this.pending = null; }
  }
}

export function visibleAccountUsage(state: UsageAccountState, userId: string): UsageAccountState {
  return state.accountId === userId ? state : { accountId: userId, status: 'loading' };
}
export function usageCountText(value: number | null): string { return value === null ? '未提供' : value.toLocaleString('zh-CN'); }
export function usagePeriodText(period: AccountUsage['period']): string {
  const utcDate = (value: string) => new Date(value).toISOString().slice(0, 10);
  return `${utcDate(period.from)} 至 ${utcDate(period.to)}（不含结束日期），UTC`;
}
export function usageCoverageText(chat: PublicAccountUsage['chat']): string {
  if (!chat.calls) return '暂无调用';
  return { none: '尚无完整上报', partial: '部分上报', complete: '完整上报' }[chat.coverage];
}

/** Shared production view is plain React so its exact markup can be checked by the existing Node test runner. */
export function UsageAccountView({ state, onRefresh, details = true }: { state: UsageAccountState; onRefresh: () => void; details?: boolean }): ReactElement {
  const metric = (title: string, value: number | null) => h('div', { className: 'usage-metric', key: title }, h('dt', null, title), h('dd', null, usageCountText(value)));
  const usage = state.status === 'ready' ? state.usage : null;
  const providers: AccountUsage['chat']['providers'] = details && usage && 'providers' in usage.chat && Array.isArray(usage.chat.providers) ? usage.chat.providers : [];
  return h('section', { className: 'usage-card', 'aria-label': '本月文字对话用量', 'aria-busy': state.status === 'loading' },
    h('div', { className: 'usage-heading' }, h('div', null, h('h3', null, '本月文字对话用量'), h('p', null, usage ? usagePeriodText(usage.period) : '当前 UTC 月份')), h('button', { type: 'button', className: 'text-button', onClick: onRefresh, disabled: state.status === 'loading' }, state.status === 'loading' ? '读取中…' : state.status === 'failed' ? '重试' : '刷新用量')),
    state.status === 'failed' ? h('p', { role: 'alert', className: 'usage-error' }, state.error) : null,
    state.status === 'idle' || state.status === 'loading' ? h('p', { role: 'status', className: 'usage-loading' }, '正在读取当前账号的统计…') : null,
    usage ? h('div', null,
      h('dl', { className: 'usage-metrics' }, metric('对话调用', usage.chat.calls), metric('已上报输入 token', usage.chat.inputTokens), metric('已上报输出 token', usage.chat.outputTokens)),
      h('div', { className: 'usage-coverage' }, h('span', { className: `usage-coverage-badge coverage-${usage.chat.coverage}` }, usageCoverageText(usage.chat)), h('span', null, `${usageCountText(usage.chat.reportedCalls)} / ${usageCountText(usage.chat.calls)} 次完整上报`)),
      h('dl', { className: 'usage-report-counts' }, metric('缺失上报', usage.chat.missingCalls), metric('无效上报', usage.chat.invalidCalls), metric('待结束', usage.chat.pendingCalls)),
      h('p', { className: 'usage-explanation' }, 'Token 仅合计完整上报的数据；未提供不代表零消耗。调用数包含失败、取消和中断；一次对话可能调用多次。'),
      usage.chat.legacyReports > 0 ? h('p', { className: 'usage-legacy' }, `本月另有 ${usageCountText(usage.chat.legacyReports)} 条旧版用量记录，尚未回填完整的新统计，未纳入上述调用与 token。`) : null,
      providers.length ? h('details', { className: 'usage-provider-details' }, h('summary', null, '查看供应商与模型明细'), h('div', { className: 'usage-table-scroll' }, h('table', null, h('caption', { className: 'usage-table-caption' }, '本月文字调用供应商上报明细'), h('thead', null, h('tr', null, ...['供应商 / 模型', '调用', '完整上报', '输入 token', '输出 token'].map((title) => h('th', { key: title, scope: 'col' }, title)))), h('tbody', null, ...providers.map((row, index) => h('tr', { key: `${row.provider}:${row.model}:${index}` }, h('th', { scope: 'row' }, h('strong', null, row.provider), h('span', null, row.model)), ...[row.calls, row.reportedCalls, row.inputTokens, row.outputTokens].map((value, position) => h('td', { key: position }, usageCountText(value))))))))) : null,
    ) : null,
    h('p', { className: 'usage-scope' }, '仅统计已接入的文字调用；语音、生成、工作流和代码任务另计。此处不是费用账单。'),
  );
}
