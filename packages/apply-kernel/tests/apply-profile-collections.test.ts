import { describe, expect, it } from 'vitest';

import {
  DEGREE_LEVELS,
  EMPLOYMENT_TYPES,
  parseApplyProfileCollections,
  parseConfirmedDatePart,
  parseProfileEducation,
  parseProfileExperience,
} from '../src/profileCollections';

/**
 * 结构化档案集合（CAP-AF-019）。
 *
 * 缺口原文：`experiences[]` / `educations[]` / `skills[]` 三个数组在扩展侧完全不存在，
 * contracts 包里也没有对应类型；结构化简历通道回来的 facts 只把 contacts + links
 * 摊平成 11 键。后果：Greenhouse 的 educations[]、Workable 的 education_entries[]、
 * Workday 的 My Experience 整组全填不了——恰好是用户最耗时的那块
 * （每段经历 6 个字段 × 3 段）。
 *
 * 本文件锁的是**形状与有界读**，不是写入编排（那是 CAP-AF-020 的投影层与
 * CAP-AF-003 的增删行）。
 */

describe('闭集逐字对应设计原文', () => {
  it('学位层级九项，顺序与 @IsIn 列表一致', () => {
    expect(DEGREE_LEVELS).toEqual([
      'HIGH_SCHOOL', 'ASSOCIATE', 'BACHELOR', 'MASTER', 'MBA', 'JD', 'MD', 'PHD', 'OTHER',
    ]);
  });

  it('雇佣类型六项', () => {
    expect(EMPLOYMENT_TYPES).toEqual([
      'FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT', 'FREELANCE', 'VOLUNTEER',
    ]);
  });
});

describe('日期是 {year, month|null}，不是 ISO 串', () => {
  it('年月都在时原样收下', () => {
    expect(parseConfirmedDatePart({ year: 2024, month: 3 })).toEqual({ year: 2024, month: 3 });
  });

  it('只有年份是合法的——教育经历常常只给年', () => {
    expect(parseConfirmedDatePart({ year: 2021 })).toEqual({ year: 2021, month: null });
  });

  it('月份按人读的 1–12，不是 Date 的 0 基', () => {
    // 0 基会在写入期把「一月」错成「十二月」——静默错一格是最难查的那种。
    expect(parseConfirmedDatePart({ year: 2024, month: 0 })?.month).toBeNull();
    expect(parseConfirmedDatePart({ year: 2024, month: 12 })?.month).toBe(12);
    expect(parseConfirmedDatePart({ year: 2024, month: 13 })?.month).toBeNull();
  });

  it('没有年份整条作废：两个 <select> 上无从落笔', () => {
    expect(parseConfirmedDatePart({ month: 6 })).toBeNull();
  });

  it('拒收 "Present" 被误解析成的 9999，以及非整数', () => {
    // 实测：结构化解析会把 Present 写成 9999。
    expect(parseConfirmedDatePart({ year: 9999, month: null })).toBeNull();
    expect(parseConfirmedDatePart({ year: 1899 })).toBeNull();
    expect(parseConfirmedDatePart({ year: 2024.5 })).toBeNull();
  });

  it('不是对象时返回 null 而不是抛错', () => {
    for (const bad of ['2024-03', 2024, null, undefined, []]) {
      expect(() => parseConfirmedDatePart(bad)).not.toThrow();
      expect(parseConfirmedDatePart(bad)).toBeNull();
    }
  });
});

describe('教育经历的有界读', () => {
  it('GPA 是字符串：3.8/4.0、First Class Honours、85/100 都要能存', () => {
    for (const gpa of ['3.8/4.0', 'First Class Honours', '85/100']) {
      expect(parseProfileEducation({ school: 'MIT', gpa })?.gpa).toBe(gpa);
    }
  });

  it('没有学校名整条丢弃——填不进任何表', () => {
    expect(parseProfileEducation({ degreeLevel: 'BACHELOR', gpa: '3.9' })).toBeNull();
  });

  it('单个字段超长只丢那个字段，不丢整段经历', () => {
    // 200 字符是明确超长；边界值（正好等于上限）由下一条用例守。
    const parsed = parseProfileEducation({ school: 'MIT', gpa: 'x'.repeat(200), fieldOfStudy: 'CS' });
    expect(parsed?.school).toBe('MIT');
    expect(parsed?.fieldOfStudy).toBe('CS');
    expect(parsed?.gpa).toBeNull();
  });

  it('GPA 上限覆盖英联邦学位分类——设计原文的 ≤16 装不下它自己举的例子', () => {
    // AUTOFILL-DESIGN §5.2 B1 写 ≤16，却把 19 字符的 First Class Honours 列为必须支持。
    // 更长的还有 Upper Second Class Honours（26）。规范自相矛盾，此处按真实取值。
    expect(parseProfileEducation({ school: 'Oxford', gpa: 'Upper Second Class Honours' })?.gpa)
      .toBe('Upper Second Class Honours');
  });

  it('闭集外的学位层级降级为 null，不抛错也不透传', () => {
    expect(parseProfileEducation({ school: 'MIT', degreeLevel: 'POSTDOC' })?.degreeLevel).toBeNull();
  });

  it('isCurrent 只认 true，其余一律 false', () => {
    expect(parseProfileEducation({ school: 'MIT', isCurrent: true })?.isCurrent).toBe(true);
    expect(parseProfileEducation({ school: 'MIT', isCurrent: 'yes' })?.isCurrent).toBe(false);
    expect(parseProfileEducation({ school: 'MIT' })?.isCurrent).toBe(false);
  });
});

describe('工作经历的有界读', () => {
  it('没有公司名整条丢弃', () => {
    expect(parseProfileExperience({ title: 'SWE' })).toBeNull();
  });

  it('闭集外的雇佣类型降级为 null', () => {
    expect(parseProfileExperience({ company: 'Acme', employmentType: 'SEASONAL' })?.employmentType).toBeNull();
    expect(parseProfileExperience({ company: 'Acme', employmentType: 'INTERNSHIP' })?.employmentType).toBe('INTERNSHIP');
  });
});

describe('整组集合：坏条目单独丢弃，好条目照常保留', () => {
  it('三段经历里坏一段，另外两段仍然可填', () => {
    // 这条是本模块最重要的取舍：整组作废在填表场景里永远是错的——
    // 用户宁可少填一段，也不愿一段都没填还得自己排查为什么。
    const parsed = parseApplyProfileCollections({
      experiences: [
        { company: 'Acme' },
        { title: 'SWE' }, // 没有 company，坏条目
        { company: 'Globex', isCurrent: true },
      ],
    });
    expect(parsed.experiences?.map((entry) => entry.company)).toEqual(['Acme', 'Globex']);
  });

  it('空集合不出现在结果里——缺省与空数组语义相同（后端是全量替换）', () => {
    expect(parseApplyProfileCollections({ educations: [], skills: [] })).toEqual({});
    expect(parseApplyProfileCollections({})).toEqual({});
  });

  it('技能表逐项有界，坏项丢弃', () => {
    const parsed = parseApplyProfileCollections({ skills: ['TypeScript', '', 'y'.repeat(400), 'Rust'] });
    expect(parsed.skills).toEqual(['TypeScript', 'Rust']);
  });

  it('非对象、非数组一律不抛错', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(() => parseApplyProfileCollections(bad)).not.toThrow();
    }
    expect(parseApplyProfileCollections({ educations: 'nope' })).toEqual({});
  });
});
