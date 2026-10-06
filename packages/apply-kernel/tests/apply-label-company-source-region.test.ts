import { describe, expect, it } from 'vitest';

import ashby from '@edaix/apply-rules/ashby.json';
import bamboohr from '@edaix/apply-rules/bamboohr.json';
import dover from '@edaix/apply-rules/dover.json';
import greenhouse from '@edaix/apply-rules/greenhouse.json';
import icims from '@edaix/apply-rules/icims.json';
import jobvite from '@edaix/apply-rules/jobvite.json';
import lever from '@edaix/apply-rules/lever.json';
import rippling from '@edaix/apply-rules/rippling.json';
import smartrecruiters from '@edaix/apply-rules/smartrecruiters.json';
import workable from '@edaix/apply-rules/workable.json';

/**
 * 现任公司、来源题、国家、州省：四个**档案里有值、策略也放行**的键，规则却只写在
 * 两三家上。
 *
 * 2026-09-22 用生产包与真实账号跑的 48 页里，这四类一共 15 行落在「没把握，没敢填」
 * ——而那句话在内核里的含义是 `!field.key`，也就是**我们压根没认出这一栏**
 * （见 engine.ts 的 `if (!field.key)`）。它读起来像「我们没把握」，其实是「我们没认出来」。
 *
 * 实测到的原话：
 *  · rippling 「Current company」            ——rippling 没有这条规则
 *  · jobvite  「Country」「State」            ——jobvite 没有；`addressRegion` 十家一条都没有
 *  · jobvite  「How did you hear this job?」 ——现有正则要求句中有 "about"，这一句没有
 *
 * 这四个键都在后端下发的 35 键放行名单里，档案里也有值：认出来就能填上。
 *
 * ## 为什么不是降置信门槛
 *
 * 同一个桶里还有 rippling 的「Search」搜索框（6 行）。门槛从 0.7 降下去，那一栏会收到
 * 一串电话号码。真正该填的那些，问题从来不在门槛，在**认不认得出**。
 */

const RULESETS = {
  ashby, bamboohr, dover, greenhouse, icims, jobvite, lever, rippling, smartrecruiters, workable,
} as const;

type Vendor = keyof typeof RULESETS;

const patternsOf = (vendor: Vendor): readonly { key: string; re: RegExp }[] => {
  const out: { key: string; re: RegExp }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'labelPatterns') {
      for (const entry of record['patterns'] as { key: string; regex: { source: string; flags: string } }[]) {
        out.push({ key: entry.key, re: new RegExp(entry.regex.source, entry.regex.flags) });
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(RULESETS[vendor]);
  return out;
};

/** 与解释器一致：数组顺序，第一个命中即返回。 */
const keyFor = (vendor: Vendor, label: string): string | null =>
  patternsOf(vendor).find((entry) => entry.re.test(label.toLowerCase()))?.key ?? null;

/** 有 labelPatterns 段可加宽的那几家（workday 没有，靠 automation-id）。 */
const VENDORS = Object.keys(RULESETS) as Vendor[];

describe('现任公司：一张申请表上最常见的经历字段', () => {
  // 2026-09-22 实测原话：rippling 与 lever 都问这一句。
  const LABELS = [
    'current company',
    'current employer',
    'current or most recent company',
    'most recent employer',
    'company',
    'employer name',
  ];

  it.each(VENDORS)('%s 认得出现任公司', (vendor) => {
    for (const label of LABELS) {
      expect(keyFor(vendor, label), `${vendor} «${label}»`).toBe('currentCompany');
    }
  });

  it('反向探针：不是在问现任公司的那些，一条都不许中', () => {
    for (const vendor of VENDORS) {
      // 推荐人的公司、以及「你申请的是哪家公司」，都不是现任公司。
      expect(keyFor(vendor, 'reference company'), vendor).not.toBe('currentCompany');
      expect(keyFor(vendor, 'which company are you applying to?'), vendor).not.toBe('currentCompany');
    }
  });
});

describe('来源题：问法里不一定有 about', () => {
  const LABELS = [
    'how did you hear about us?',
    'how did you hear about this job?',
    // 2026-09-22 jobvite 实测原话：句中没有 "about"，现有正则整条落空。
    'how did you hear this job?',
    'how did you hear about this opportunity?',
    'where did you hear about us?',
  ];

  it.each(VENDORS)('%s 认得出来源题', (vendor) => {
    for (const label of LABELS) {
      expect(keyFor(vendor, label), `${vendor} «${label}»`).toBe('heardAboutSource');
    }
  });

  it('反向探针：听说过我们 ≠ 你从哪听说的', () => {
    for (const vendor of VENDORS) {
      expect(keyFor(vendor, 'have you heard of us before?'), vendor).not.toBe('heardAboutSource');
    }
  });
});

describe('国家与州省：地址三件套之外那两栏', () => {
  it.each(VENDORS)('%s 认得出国家', (vendor) => {
    for (const label of ['country', 'country of residence', 'what country are you based in?']) {
      expect(keyFor(vendor, label), `${vendor} «${label}»`).toBe('addressCountry');
    }
  });

  // 2026-09-22 jobvite 实测原话就是光秃秃的「State」。`addressRegion` 在放行名单里，
  // 档案里也有值，而十家规则一条对应的正则都没有。
  it.each(VENDORS)('%s 认得出州省', (vendor) => {
    for (const label of ['state', 'province', 'state / province', 'state or province', 'region']) {
      expect(keyFor(vendor, label), `${vendor} «${label}»`).toBe('addressRegion');
    }
  });

  it('反向探针：别的「state」不许中', () => {
    for (const vendor of VENDORS) {
      // 雇佣状态、婚姻状况、以及「请说明」——都不是行政区。
      expect(keyFor(vendor, 'employment status'), vendor).not.toBe('addressRegion');
      expect(keyFor(vendor, 'visa status'), vendor).not.toBe('addressRegion');
      expect(keyFor(vendor, 'please state your reason'), vendor).not.toBe('addressRegion');
    }
  });
});
