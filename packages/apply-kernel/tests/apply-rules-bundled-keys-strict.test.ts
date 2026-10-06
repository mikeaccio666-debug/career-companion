import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 本仓是规则的作者。运行时对未知档案键是「跳过那一条」、对未知顶层键是「不解释」
 * （见 RulesParseOptions），那是给线上旧版内核的宽容；这里是发布侧，随包的每一份规则
 * 都按严格口径过一遍：一个拼错的键在这里就该红，而不是到线上静默失效。
 *
 * 路径用 node:url 的 fileURLToPath 拼：这套用例跑在 happy-dom 下，全局 URL 是
 * 浏览器那一套，直接把 `new URL(..., import.meta.url)` 交给 fs 会被拒。
 */
const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apply-rules', 'rules');

describe('随包规则：严格口径下零未知键', () => {
  const files = readdirSync(RULES_DIR).filter((name) => name.endsWith('.json')).sort();

  it('至少扫到了那几家', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)('%s 在 unknownFieldKeys=reject、unknownTopLevelKeys=reject 下解析通过', (name) => {
    const raw = JSON.parse(readFileSync(join(RULES_DIR, name), 'utf8')) as unknown;
    const skipped: string[] = [];
    const ignored: string[] = [];
    const parsed = parseVendorRuleset(raw, {
      unknownFieldKeys: 'reject',
      onUnknownFieldKey: (key) => skipped.push(key),
      unknownTopLevelKeys: 'reject',
      onUnknownTopLevelKey: (key) => ignored.push(key),
    });
    expect(parsed, name).toMatchObject({ ok: true });
    expect(skipped).toEqual([]);
    expect(ignored).toEqual([]);
  });
});
