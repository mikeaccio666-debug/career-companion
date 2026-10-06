import { describe, expect, it } from 'vitest';

import {
  COLLECTION_FIELD_ROLES,
  collectionRowCount,
  isCollectionFieldRole,
  isCurrentRow,
  monthCandidates,
  projectCollectionField,
} from '../src/collectionProjection';
import { parseApplyProfileCollections } from '../src/profileCollections';

/**
 * 结构化档案 → 引擎字段值的投影层（CAP-AF-020）。
 *
 * 缺口原文：扫描侧已有「行标识 + 行内序号」的字段身份，档案侧没有对应物，
 * 引擎因此回答不了「把第 2 段经历填进页面第 2 组控件」。
 *
 * 本文件锁三件事：
 *  · 行序对齐（页面第 N 组 ↔ 档案第 N 段）；
 *  · 日期拆成年/月两路，且月份产出**有序候选**而不是写死某一种写法；
 *  · 厂商知识不进 kernel——本模块不认识任何选择器、任何 ATS。
 */

const COLLECTIONS = parseApplyProfileCollections({
  educations: [
    { school: 'MIT', degreeLevel: 'BACHELOR', fieldOfStudy: 'CS', gpa: '3.9/4.0',
      startDate: { year: 2018, month: 9 }, endDate: { year: 2022, month: 6 } },
    { school: 'Oxford', degreeLevel: 'MASTER', startDate: { year: 2022 }, isCurrent: true },
  ],
  experiences: [
    { company: 'Acme', title: 'SWE', employmentType: 'INTERNSHIP',
      startDate: { year: 2021, month: 6 }, endDate: { year: 2021, month: 8 } },
    { company: 'Globex', title: 'Senior SWE', isCurrent: true, startDate: { year: 2023, month: 1 } },
  ],
  skills: ['TypeScript', 'Rust', 'Go'],
});

describe('行序对齐：页面第 N 组 ↔ 档案第 N 段', () => {
  it('第 1 段与第 2 段各取各的', () => {
    expect(projectCollectionField(COLLECTIONS, 'experience.company', 0)).toEqual(['Acme']);
    expect(projectCollectionField(COLLECTIONS, 'experience.company', 1)).toEqual(['Globex']);
    expect(projectCollectionField(COLLECTIONS, 'education.school', 0)).toEqual(['MIT']);
    expect(projectCollectionField(COLLECTIONS, 'education.school', 1)).toEqual(['Oxford']);
  });

  it('页面比档案多一组时返回空，不抛错', () => {
    // 常态：宿主预渲染三组空行，用户只有两段经历。
    expect(projectCollectionField(COLLECTIONS, 'experience.company', 2)).toEqual([]);
    expect(() => projectCollectionField(COLLECTIONS, 'experience.company', 99)).not.toThrow();
  });

  it('非法行序返回空而不是崩', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(projectCollectionField(COLLECTIONS, 'education.school', bad)).toEqual([]);
    }
  });
});

describe('日期拆成年 / 月两路', () => {
  it('起止年月各走各的角色', () => {
    expect(projectCollectionField(COLLECTIONS, 'experience.startYear', 0)).toEqual(['2021']);
    expect(projectCollectionField(COLLECTIONS, 'experience.endYear', 0)).toEqual(['2021']);
    expect(projectCollectionField(COLLECTIONS, 'education.startYear', 0)).toEqual(['2018']);
  });

  it('只有年份时月份那一路为空——教育经历常常只给年', () => {
    expect(projectCollectionField(COLLECTIONS, 'education.startYear', 1)).toEqual(['2022']);
    expect(projectCollectionField(COLLECTIONS, 'education.startMonth', 1)).toEqual([]);
  });

  it('在读/在职：结束日期两路都空', () => {
    expect(projectCollectionField(COLLECTIONS, 'experience.endYear', 1)).toEqual([]);
    expect(projectCollectionField(COLLECTIONS, 'experience.endMonth', 1)).toEqual([]);
  });
});

describe('月份产出有序候选，而不是写死某一种写法', () => {
  it('首项是数字形态——纯文本框拿的就是它，最不容易出错', () => {
    expect(monthCandidates(3)[0]).toBe('3');
  });

  it('覆盖实测见过的四种写法：3 / March / 03 / Mar', () => {
    // Greenhouse 的 <select> 是 March，Workday 是 03。把某一种写死在 kernel 里
    // 就是把厂商知识搬进了 kernel——所以全给出来，由阶梯匹配挑宿主真有的那个。
    expect(monthCandidates(3)).toEqual(['3', 'March', '03', 'Mar']);
  });

  it('十二月的补零形态就是它本身，不重复也不出错', () => {
    expect(monthCandidates(12)).toEqual(['12', 'December', '12', 'Dec']);
  });

  it('越界月份返回空数组', () => {
    expect(monthCandidates(0)).toEqual([]);
    expect(monthCandidates(13)).toEqual([]);
  });

  it('投影出来的月份就是这套候选', () => {
    expect(projectCollectionField(COLLECTIONS, 'experience.startMonth', 0)).toEqual(
      ['6', 'June', '06', 'Jun'],
    );
  });
});

describe('枚举：闭集码在前，人读写法在后', () => {
  it('学位层级给出码 + 多种人读写法', () => {
    const candidates = projectCollectionField(COLLECTIONS, 'education.degreeLevel', 0);
    expect(candidates[0]).toBe('BACHELOR');
    expect(candidates).toContain("Bachelor's Degree");
    expect(candidates).toContain('BS');
  });

  it('雇佣类型同理，覆盖连字符与空格两种写法', () => {
    const candidates = projectCollectionField(COLLECTIONS, 'experience.employmentType', 1);
    // 第 2 段没有 employmentType
    expect(candidates).toEqual([]);
    const first = projectCollectionField(COLLECTIONS, 'experience.employmentType', 0);
    expect(first[0]).toBe('INTERNSHIP');
    expect(first).toContain('Intern');
  });
});

describe('技能与行数', () => {
  it('技能栏是逗号分隔的单值——多选标签控件自己迭代，不在本层展开', () => {
    expect(projectCollectionField(COLLECTIONS, 'skills.all', 0)).toEqual(['TypeScript, Rust, Go']);
  });

  it('行数供调用方决定要不要加一行（增删行编排属 CAP-AF-003）', () => {
    expect(collectionRowCount(COLLECTIONS, 'education')).toBe(2);
    expect(collectionRowCount(COLLECTIONS, 'experience')).toBe(2);
    expect(collectionRowCount(COLLECTIONS, 'skills')).toBe(3);
    expect(collectionRowCount({}, 'education')).toBe(0);
  });

  it('至今是事实不是角色——它驱动控件联动，不是往栏里写字符串', () => {
    expect(isCurrentRow(COLLECTIONS, 'experience', 1)).toBe(true);
    expect(isCurrentRow(COLLECTIONS, 'experience', 0)).toBe(false);
    expect(isCurrentRow(COLLECTIONS, 'education', 1)).toBe(true);
    expect(isCurrentRow(COLLECTIONS, 'education', 99)).toBe(false);
  });
});

describe('角色是闭集：认不得的整条拒收，不猜', () => {
  it('闭集成员逐一可判', () => {
    for (const role of COLLECTION_FIELD_ROLES) expect(isCollectionFieldRole(role)).toBe(true);
  });

  it('闭集外一律 false——猜错的后果是把公司名写进学校栏', () => {
    for (const bad of ['education.gpaNumber', 'experience.salary', '', null, 42]) {
      expect(isCollectionFieldRole(bad)).toBe(false);
    }
  });

  it('空档案对每个角色都返回空，不抛错', () => {
    for (const role of COLLECTION_FIELD_ROLES) {
      expect(() => projectCollectionField({}, role, 0)).not.toThrow();
      expect(projectCollectionField({}, role, 0)).toEqual([]);
    }
  });
});
