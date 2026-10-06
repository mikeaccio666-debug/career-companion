import { describe, expect, it } from 'vitest';

import {
  dateCandidatesForShape,
  dateShapeOfInputType,
  toIsoDatePart,
} from '../src/dateFormat';

/**
 * 日期值的写入形态（CAP-AF-002）。
 *
 * 缺口原文：`input[type=date/month/number]` 一律 unsupported，零代码。
 * 且原设计的「日期四条路线（禁止合成 ArrowUp）」实测一条也用不上——
 * Workable 是纯文本框、Greenhouse 是 `input[type=number]` 的年、
 * Workday/Taleo 是月年两个 `<select>`。
 *
 * 本文件锁的是「这一个控件该收什么格式的字符串」。
 * 「一个起止日期拆成 month + year 两个控件」由 CAP-AF-020 的投影层负责，
 * 已有 apply-collection-projection.test.ts 覆盖。
 */

const JUNE_2022 = { year: 2022, month: 6 } as const;
const YEAR_ONLY = { year: 2022, month: null } as const;

describe('原生日期控件按 HTML 规范取值', () => {
  it('type=date 要 YYYY-MM-DD，日补 01', () => {
    // 我们的档案粒度到月——没有人记得自己哪一天入职。补 01 是唯一安全的选择：
    // 它在每个月都存在，而 31 会在二月变成非法日期、被浏览器直接丢弃。
    expect(dateCandidatesForShape(JUNE_2022, 'date')).toEqual(['2022-06-01']);
  });

  it('type=month 要 YYYY-MM', () => {
    expect(dateCandidatesForShape(JUNE_2022, 'month')).toEqual(['2022-06']);
  });

  it('月份补零：一月是 01 不是 1', () => {
    expect(dateCandidatesForShape({ year: 2024, month: 1 }, 'month')).toEqual(['2024-01']);
    expect(dateCandidatesForShape({ year: 2024, month: 1 }, 'date')).toEqual(['2024-01-01']);
  });

  it('只有年份时 date / month 都写不了——宁可不填，不补假月份', () => {
    // 补一个假月份会让用户在自己的申请表上看到一个他没填过的日期。
    expect(dateCandidatesForShape(YEAR_ONLY, 'date')).toEqual([]);
    expect(dateCandidatesForShape(YEAR_ONLY, 'month')).toEqual([]);
  });
});

describe('type=number 只用于年份栏', () => {
  it('产出裸年份', () => {
    // Greenhouse 实测：end-year--0，label「End date year*」。
    expect(dateCandidatesForShape(JUNE_2022, 'number')).toEqual(['2022']);
    expect(dateCandidatesForShape(YEAR_ONLY, 'number')).toEqual(['2022']);
  });
});

describe('自由文本框：有序候选，ISO 形态在前', () => {
  it('ISO 形态排第一——它是全世界唯一没有歧义的写法', () => {
    // 06/2022 与 2022/06 在不同 locale 下读法相反；宿主若有格式校验，
    // ISO 也最可能被接受。
    expect(dateCandidatesForShape(JUNE_2022, 'text')[0]).toBe('2022-06');
  });

  it('后备是实测见过的人读写法', () => {
    expect(dateCandidatesForShape(JUNE_2022, 'text')).toEqual(['2022-06', '06/2022', '6/2022']);
  });

  it('只有年份时就写年份', () => {
    expect(dateCandidatesForShape(YEAR_ONLY, 'text')).toEqual(['2022']);
  });
});

describe('形态识别与浏览器行为一致', () => {
  it('三种原生形态各自认出来', () => {
    expect(dateShapeOfInputType('date')).toBe('date');
    expect(dateShapeOfInputType('month')).toBe('month');
    expect(dateShapeOfInputType('number')).toBe('number');
  });

  it('未知 / 缺失 type 回落成 text——与 HTML 规范下浏览器的行为一致', () => {
    // 若我们判成「不可写」而浏览器判成「可写」，两边会不一致：
    // 我们跳过了一栏其实能填的字段，而用户不知道为什么。
    for (const unknown of ['datetime', 'week', '', null, undefined]) {
      expect(dateShapeOfInputType(unknown)).toBe('text');
    }
  });
});

describe('null 与归一化伴生值', () => {
  it('没有日期就是空数组，任何形态都不抛错', () => {
    for (const shape of ['date', 'month', 'number', 'text'] as const) {
      expect(() => dateCandidatesForShape(null, shape)).not.toThrow();
      expect(dateCandidatesForShape(null, shape)).toEqual([]);
    }
  });

  it('ISO 伴生值只用于显示与诊断，不参与写入', () => {
    // 档案里存的本来就是 {year, month|null}，已经是归一化形态——
    // 不需要像原设计那样再存一份 ISO 串然后写入期又拆一次。
    expect(toIsoDatePart(JUNE_2022)).toBe('2022-06');
    expect(toIsoDatePart(YEAR_ONLY)).toBe('2022');
    expect(toIsoDatePart(null)).toBeNull();
  });
});
