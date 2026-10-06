import { COPY, type DockCopy } from './copy';
import type { DockJobFacts, DockJobSalary } from './types';

/**
 * 首页岗位卡上几样东西怎么写（2026-09-24 负责人要首页的岗位卡照设计展开）。
 *
 * 只做格式：数据由调用方从页面的 JobPosting 读来（`lib/jobCardFromPage.ts`），这里一样都不猜。
 * 办公方式与雇佣类型照设计写英文（Remote / Full-time），与招聘网站上的说法一致；别的字都在 `copy.ts`（中英两套，
 * 调用方传进来是哪一套就写哪一套，不传是中文）。
 */

/** 地点、办公方式、雇佣类型三颗胶囊，缺哪样就少哪颗。 */
export function jobChips(facts: DockJobFacts, copy: DockCopy = COPY): string[] {
  return [
    (facts.location ?? '').trim(),
    facts.workMode == null ? '' : copy.jobCard.workMode[facts.workMode],
    facts.employment == null ? '' : copy.jobCard.employment[facts.employment],
  ].filter((chip) => chip !== '');
}

/**
 * 薪资：金额一行（「$140k – $175k」），旁边一行小字写币种与周期（「USD / 年」）。按年、按月写成 k；
 * 按小时、按天写原数。读不出（币种不是三个字母、金额不是正数）就是 null，卡片上不摆这一行。
 */
export function salaryText(salary: DockJobSalary | null | undefined, copy: DockCopy = COPY): { amount: string; unit: string } | null {
  if (salary == null) return null;
  const { min, max, currency, unit } = salary;
  if (!/^[A-Z]{3}$/u.test(currency) || !(min > 0) || !(max > 0) || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  const symbol = currencySymbol(currency);
  const short = unit !== 'HOUR' && unit !== 'DAY';
  const one = (value: number): string => `${symbol}${short ? shortAmount(value) : plainAmount(value)}`;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const amount = one(low) === one(high) ? one(low) : `${one(low)} – ${one(high)}`;
  return { amount, unit: unit == null ? currency : copy.jobCard.per(currency, unit) };
}

function shortAmount(value: number): string {
  if (value >= 1_000_000) return `${oneDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${oneDecimal(value / 1_000)}k`;
  return plainAmount(value);
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function plainAmount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}

/** 币种的符号（USD → $、EUR → €）；认不出就不写符号，币种代码照样写在旁边那行小字里。 */
function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((piece) => piece.type === 'currency')?.value;
    return part !== undefined && part !== currency ? part : '';
  } catch {
    return '';
  }
}

/** 发布了多久（按用户本地的日历日算）：今天、N 天前；一个月以上写 N 个月前、一年以上写 N 年前。日期不对或在将来就是 null。 */
export function postedAgo(date: string | null | undefined, now: Date, copy: DockCopy = COPY): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date ?? '');
  if (match === null) return null;
  const posted = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - posted.getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return copy.jobCard.today;
  if (days < 30) return copy.jobCard.daysAgo(days);
  if (days < 365) return copy.jobCard.monthsAgo(Math.floor(days / 30));
  return copy.jobCard.yearsAgo(Math.floor(days / 365));
}

/** 「查看完整岗位详情」只开 http(s) 的地址。 */
export function safeDetailUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
