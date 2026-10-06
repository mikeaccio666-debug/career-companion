import { describe, expect, it } from 'vitest';

import ashby from '@edaix/apply-rules/ashby.json';
import dover from '@edaix/apply-rules/dover.json';
import greenhouse from '@edaix/apply-rules/greenhouse.json';
import jobvite from '@edaix/apply-rules/jobvite.json';
import lever from '@edaix/apply-rules/lever.json';
import rippling from '@edaix/apply-rules/rippling.json';
import smartrecruiters from '@edaix/apply-rules/smartrecruiters.json';
import workable from '@edaix/apply-rules/workable.json';

/**
 * 学校那道问句后面常常跟着一句填写说明。
 *
 * 2026-09-22 在 jobs.lever.co/palantir 的真实申请页上读到的完整题干：
 *
 *   Which university are you currently attending or did you last attend?
 *   Please select "Other (School Not Listed)" if your school is not listed.✱
 *
 * #40 加的那条规则在 `?` 处就用 `$` 锚死了（`[^?]{0,80}\??$`），于是后面那一整句
 * 说明让它整条落空——六页全落「没把握，没敢填」，而那句话在内核里的含义是
 * `!field.key`：**我们压根没认出这一栏**。
 *
 * 这件事我们之前一直没看见：跑批脚本把标签截到 60 字，那句说明从来没出现在语料里。
 *
 * ## 为什么放宽 `?` 之后是安全的
 *
 * 规则在**开头**锚得很死——必须以 which/what university/college（或 which school
 * did/do/are）起头。以这句话起头的标签就是在问学校；`?` 之后跟什么只是说明。
 * 尾巴限长 240，与期望薪资那条（#45）同一口径。
 */

const RULESETS = { ashby, dover, greenhouse, jobvite, lever, rippling, smartrecruiters, workable } as const;
type Vendor = keyof typeof RULESETS;

const keyFor = (vendor: Vendor, label: string): string | null => {
  const patterns: { key: string; re: RegExp }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'labelPatterns') {
      for (const entry of record['patterns'] as { key: string; regex: { source: string; flags: string } }[]) {
        patterns.push({ key: entry.key, re: new RegExp(entry.regex.source, entry.regex.flags) });
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(RULESETS[vendor]);
  return patterns.find((entry) => entry.re.test(label.toLowerCase()))?.key ?? null;
};

const VENDORS = Object.keys(RULESETS) as Vendor[];

describe('学校问句后面跟着填写说明', () => {
  // 2026-09-22 palantir 真实题干（末尾的 ✱ 由 #59 剥掉；这里验的是说明句本身）。
  const WITH_GUIDANCE =
    'Which university are you currently attending or did you last attend? ' +
    'Please select "Other (School Not Listed)" if your school is not listed.';

  it.each(VENDORS)('%s 认得带说明句的学校问句', (vendor) => {
    expect(keyFor(vendor, WITH_GUIDANCE), vendor).toBe('education.school');
  });

  it.each(VENDORS)('%s 光秃秃的问句照旧认得', (vendor) => {
    expect(keyFor(vendor, 'Which university are you currently attending or did you last attend?'))
      .toBe('education.school');
    expect(keyFor(vendor, 'What college did you attend?')).toBe('education.school');
  });

  it('反向探针：不是以问学校起头的，后面再像也不中', () => {
    for (const vendor of VENDORS) {
      // 说明句里提到 university，但题干问的是别的。
      expect(keyFor(vendor, 'Are you currently enrolled? Please list your university below.'), vendor)
        .not.toBe('education.school');
      // 学位与专业是另外两道题。
      expect(keyFor(vendor, 'What degree did you earn at university?'), vendor).not.toBe('education.school');
    }
  });

  it('反向探针：说明句不许无限长——那是一段正文，不是一道题', () => {
    const essay = `Which university did you attend? ${'Tell us everything about it. '.repeat(20)}`;
    for (const vendor of VENDORS) expect(keyFor(vendor, essay), vendor).not.toBe('education.school');
  });
});
