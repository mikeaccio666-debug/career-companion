import { createHash } from 'node:crypto';

import ashbyRules from '@edaix/apply-rules/ashby.json';
import bamboohrRules from '@edaix/apply-rules/bamboohr.json';
import doverRules from '@edaix/apply-rules/dover.json';
import genericRules from '@edaix/apply-rules/generic.json';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import icimsRules from '@edaix/apply-rules/icims.json';
import jobviteRules from '@edaix/apply-rules/jobvite.json';
import leverRules from '@edaix/apply-rules/lever.json';
import ripplingRules from '@edaix/apply-rules/rippling.json';
import releaseManifest from '@edaix/apply-rules/release-manifest.json';
import workableRules from '@edaix/apply-rules/workable.json';
import smartrecruitersRules from '@edaix/apply-rules/smartrecruiters.json';
import workdayRules from '@edaix/apply-rules/workday.json';
import { describe, expect, it } from 'vitest';

import {
  buildApplyRulesRelease,
  canonicalizeApplyRulesJson,
  createRuntimeApplyRegistry,
  createRuntimeApplyMetadataRegistry,
  resolveRuntimeApplyAdapter,
  type ApplyRulesReleaseV1,
} from '../src/runtimeRegistry';

/**
 * 后端发版不得立刻打断已经装在用户机器上的包。
 *
 * 2026-09-22 的教训：后端一发新 release，运行中的包每一页都填不了。产品上这是
 * 不可接受的——商店包的更新是异步的（审核 + 用户升级），后端与插件**永远**会有
 * 一段版本不一致的窗口。两种发布次序都必须安全：
 *
 *  · **后端先发**：包里出现这一版不认识的厂商 → 认得的那些照常工作，不认识的
 *    那家等商店包更新到位再说；
 *  · **插件先发**：这一版认得的厂商还没进 release → 那家暂时用不了，其余照常。
 *
 * 这与 RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 的「厂商准入清单外一律拒」不冲突，
 * 方向正相反：不认识的那家**永远装不上、永远解析不出授权**，拒得干干净净；
 * 被修掉的是「因为它在场，所以认得的那十家也一起停掉」。
 *
 * 容错的是「有没有」，不是「是什么」：形状不对（键多了、token 非法、digest 不符）
 * 仍然拒整份——与 contracts 里 `isTolerantBooleanRecord` 那段头注同一条口径。
 */

const SOURCES = {
  ashby: ashbyRules,
  bamboohr: bamboohrRules,
  dover: doverRules,
  generic: genericRules,
  greenhouse: greenhouseRules,
  icims: icimsRules,
  jobvite: jobviteRules,
  lever: leverRules,
  rippling: ripplingRules,
  smartrecruiters: smartrecruitersRules,
  workable: workableRules,
  workday: workdayRules,
} as const;

const MAPPING_SEPARATOR = '\u0000';

async function builtRelease(): Promise<ApplyRulesReleaseV1> {
  const built = await buildApplyRulesRelease(releaseManifest, SOURCES);
  if (!built.ok) throw new Error(built.code);
  return built.value;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalizeApplyRulesJson(value), 'utf8').digest('hex')}`;
}

function resealed(release: ApplyRulesReleaseV1): ApplyRulesReleaseV1 {
  return {
    ...release,
    releaseDigest: sha256({
      releaseVersion: release.releaseVersion,
      mappings: release.mappings,
      rulesets: release.rulesets,
    }),
  } as ApplyRulesReleaseV1;
}

function mappingKey(mapping: { atsProvider: string; pathRuleId: string }): string {
  return `${mapping.atsProvider}${MAPPING_SEPARATOR}${mapping.pathRuleId}`;
}

/**
 * 后端下一版放行的那家，这个包还不认识。
 *
 * `PARADOX` / `paradox` 在两张排序表里都正好落在 LEVER 与 RIPPLING 之间，
 * 所以插进去不破坏「严格升序且唯一」那两条既有闸——那两条必须仍然有效。
 */
function withUnknownVendor(release: ApplyRulesReleaseV1): ApplyRulesReleaseV1 {
  const ruleset = { schemaVersion: 2, vendor: 'paradox', pathRules: [], fields: [] };
  const rulesets = [...release.rulesets, {
    version: 'paradox-rules-v1',
    digest: sha256(ruleset),
    ruleset,
  }].sort((a, b) => (a.version < b.version ? -1 : 1));
  const mappings = [...release.mappings, {
    atsProvider: 'PARADOX',
    pathRuleId: 'paradox-application-v1',
    vendor: 'paradox',
    rulesetVersion: 'paradox-rules-v1',
    rulesetDigest: sha256(ruleset),
  }].sort((a, b) => (mappingKey(a) < mappingKey(b) ? -1 : 1));
  return resealed({ ...release, mappings, rulesets } as ApplyRulesReleaseV1);
}

/** 这一版认得、但 release 里还没有的那家（插件先发的次序）。 */
function withoutVendor(release: ApplyRulesReleaseV1, vendor: string): ApplyRulesReleaseV1 {
  const mappings = release.mappings.filter((mapping) => mapping.vendor !== vendor);
  const versions = new Set(mappings.map(({ rulesetVersion }) => rulesetVersion));
  const rulesets = release.rulesets.filter(({ version }) => versions.has(version));
  return resealed({ ...release, mappings, rulesets } as ApplyRulesReleaseV1);
}

describe('后端先发：包里多出这一版不认识的厂商', () => {
  it('认得的那些照常装上，整份不被拖垮', async () => {
    const registry = await createRuntimeApplyRegistry(withUnknownVendor(await builtRelease()));
    expect(registry.ok, registry.ok ? '' : `整份被拒了：${registry.code}`).toBe(true);
    if (!registry.ok) return;
    expect(new Set(registry.value.mappings.map(({ vendor }) => vendor))).toContain('greenhouse');
    // 2026-09-28 起留一个稳定码（此前这一种容错一声不响）；码里没有厂商名。
    expect(registry.value.notices).toEqual(['RUNTIME_RULES_UNKNOWN_VENDOR_SKIPPED']);
  });

  it('不认识的那家一条映射都解析不出来——清单外照旧一律拒', async () => {
    const registry = await createRuntimeApplyRegistry(withUnknownVendor(await builtRelease()));
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.mappings.some(({ vendor }) => (vendor as string) === 'paradox')).toBe(false);
    expect(
      resolveRuntimeApplyAdapter(registry.value, {
        atsProvider: 'PARADOX' as never,
        pathRuleId: 'paradox-application-v1',
      }).ok,
    ).toBe(false);
  });

  it('只问身份的那条路（wizard / 授权）也一样', async () => {
    const metadata = await createRuntimeApplyMetadataRegistry(withUnknownVendor(await builtRelease()));
    expect(metadata.ok, metadata.ok ? '' : `整份被拒了：${metadata.code}`).toBe(true);
    if (!metadata.ok) return;
    expect(metadata.value.mappings.some(({ vendor }) => (vendor as string) === 'paradox')).toBe(false);
  });

  it('形状不对仍然拒整份——容错的是「有没有」，不是「是什么」', async () => {
    const release = withUnknownVendor(await builtRelease());
    const tampered = structuredClone(release) as ApplyRulesReleaseV1;
    // 把那家不认识的厂商的 digest 改坏：它仍然不该被装上，但整份必须拒——
    // 不认识不等于不校验。
    (tampered.mappings.find((m) => (m.vendor as string) === 'paradox') as { rulesetDigest: string })
      .rulesetDigest = `sha256:${'0'.repeat(64)}`;
    expect((await createRuntimeApplyRegistry(resealed(tampered))).ok).toBe(false);
  });
});

describe('插件先发：这一版认得的厂商还没进 release', () => {
  it('那家用不了，其余照常装上', async () => {
    const registry = await createRuntimeApplyRegistry(withoutVendor(await builtRelease(), 'dover'));
    expect(registry.ok, registry.ok ? '' : `整份被拒了：${registry.code}`).toBe(true);
    if (!registry.ok) return;
    const vendors = new Set(registry.value.mappings.map(({ vendor }) => vendor));
    expect(vendors.has('dover' as never)).toBe(false);
    expect(vendors.has('greenhouse')).toBe(true);
  });
});

/**
 * 后端给**认得的那家**的规则加了这一版不认识的东西（2026-09-28）。
 *
 * 2026-09-24 那一次：Workday 的规则加了顶层键 `searchPromptComboboxes`，旧包的顶层白名单
 * 不认识它 → 那一份 `RULES_MALFORMED` → 整份 release `RUNTIME_RULESET_REJECTED` →
 * 装入表空 → 所有厂商约 5 分钟内一起停（worker 最多 5 分钟复查一次）。
 *
 * 现在的口径分两层：
 *  · **顶层**多出来的键：不解释、不保留，这份规则按没有它照常装上——顶层键是互相独立的
 *    一项能力，不认识它 = 不用它 = 旧包读旧规则时本来的样子；
 *  · 已知结构**里面**的陌生东西（条目里多一个键、认不得的 step 类型、比内核新的
 *    schemaVersion）：这一份规则这一版读不了，**只停这一家**，别家照常。
 *    条目之间不独立（掩码格、插在哪一头、部件绑定替掉 widgetNames），丢一条或忽略一个
 *    属性都可能让旧包多写或写错地方，所以单位是整份规则，不是一条。
 *
 * 不变的：digest 照算照验（按送达的原样，陌生键也在摘要里），改坏的 payload 仍拒整份；
 * 发布侧（`buildApplyRulesRelease`）照旧严格。
 */
function withRulesetChange(
  release: ApplyRulesReleaseV1,
  vendor: string,
  mutate: (ruleset: Record<string, unknown>) => void,
): ApplyRulesReleaseV1 {
  const clone = structuredClone(release) as unknown as {
    mappings: Array<{ rulesetVersion: string; rulesetDigest: string }>;
    rulesets: Array<{ version: string; digest: string; ruleset: Record<string, unknown> }>;
  };
  const entry = clone.rulesets.find(({ ruleset }) => ruleset['vendor'] === vendor);
  if (entry === undefined) throw new Error(`release 里没有 ${vendor}`);
  mutate(entry.ruleset);
  entry.digest = sha256(entry.ruleset);
  for (const mapping of clone.mappings) {
    if (mapping.rulesetVersion === entry.version) mapping.rulesetDigest = entry.digest;
  }
  return resealed(clone as unknown as ApplyRulesReleaseV1);
}

function vendorsOf(registry: { mappings: readonly { vendor: string }[] }): Set<string> {
  return new Set(registry.mappings.map(({ vendor }) => vendor));
}

describe('后端先发：认得的那家的规则多了顶层键', () => {
  const futureKey = (ruleset: Record<string, unknown>) => {
    ruleset['futureWidgetBindings'] = [{ triggerSelector: 'input.future', mode: 'next' }];
  };

  it('整份照常装上，那一家也在，诊断只报一个稳定码', async () => {
    const plain = await createRuntimeApplyRegistry(await builtRelease());
    const release = withRulesetChange(await builtRelease(), 'workday', futureKey);
    const registry = await createRuntimeApplyRegistry(release);
    expect(registry.ok, registry.ok ? '' : `整份被拒了：${registry.code}`).toBe(true);
    if (!registry.ok || !plain.ok) return;
    expect(vendorsOf(registry.value)).toEqual(vendorsOf(plain.value));
    expect(plain.value.notices).toEqual([]);
    expect(registry.value.notices).toEqual(['RUNTIME_RULESET_UNKNOWN_KEY_IGNORED']);
    // 码里没有键名、没有厂商名、没有规则内容。
    expect(JSON.stringify(registry.value.notices)).not.toMatch(/future|workday|input\.future/iu);
  });

  it('多出来的键不进解释器：编译出来的那一份与没有它时逐项相同', async () => {
    const plain = await createRuntimeApplyRegistry(await builtRelease());
    const extended = await createRuntimeApplyRegistry(withRulesetChange(await builtRelease(), 'workday', futureKey));
    expect(plain.ok && extended.ok).toBe(true);
    if (!plain.ok || !extended.ok) return;
    const target = { atsProvider: 'WORKDAY', pathRuleId: 'workday-application-v1' };
    const before = resolveRuntimeApplyAdapter(plain.value, target);
    const after = resolveRuntimeApplyAdapter(extended.value, target);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.value.rulesetVersion).toBe(before.value.rulesetVersion);
    expect(Object.keys(after.value.adapter).sort()).toEqual(Object.keys(before.value.adapter).sort());
  });

  it('只问身份的那条路也一样', async () => {
    const metadata = await createRuntimeApplyMetadataRegistry(
      withRulesetChange(await builtRelease(), 'workday', futureKey),
    );
    expect(metadata.ok, metadata.ok ? '' : `整份被拒了：${metadata.code}`).toBe(true);
    if (!metadata.ok) return;
    expect(vendorsOf(metadata.value).has('workday')).toBe(true);
  });

  it('陌生键也在摘要里：送达后被改过，照旧拒整份', async () => {
    const release = withRulesetChange(await builtRelease(), 'workday', futureKey);
    const tampered = structuredClone(release) as unknown as {
      rulesets: Array<{ ruleset: Record<string, unknown> }>;
    };
    const workday = tampered.rulesets.find(({ ruleset }) => ruleset['vendor'] === 'workday')!;
    workday.ruleset['futureWidgetBindings'] = [];
    expect(await createRuntimeApplyRegistry(tampered)).toEqual({
      ok: false,
      code: 'RUNTIME_RULESET_DIGEST_MISMATCH',
    });
  });

  it('长得不像 schema 键的「新键」不是新版本，是坏数据：只停这一家', async () => {
    const release = withRulesetChange(await builtRelease(), 'workday', (ruleset) => {
      ruleset['has space'] = true;
    });
    const registry = await createRuntimeApplyRegistry(release);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(vendorsOf(registry.value).has('workday')).toBe(false);
    expect(registry.value.notices).toEqual(['RUNTIME_RULESET_SKIPPED_RULES_MALFORMED']);
  });
});

describe('后端先发：认得的那家的规则里，已知结构多了这一版读不了的东西', () => {
  const cases: ReadonlyArray<readonly [string, string, string, (ruleset: Record<string, unknown>) => void]> = [
    [
      '部件绑定条目多一个键',
      'workday',
      'RUNTIME_RULESET_SKIPPED_RULES_MALFORMED',
      (ruleset) => {
        (ruleset['listboxComboboxes'] as Array<Record<string, unknown>>)[0]!['clearSelector'] = 'button.clear';
      },
    ],
    [
      '行作用域条目多一个键（2026-09-24 的 insertsAt 就是这一类）',
      'greenhouse',
      'RUNTIME_RULESET_SKIPPED_RULES_MALFORMED',
      (ruleset) => {
        (ruleset['rowScopes'] as Array<Record<string, unknown>>)[0]!['insertsBetween'] = 'middle';
      },
    ],
    [
      '最终提交控件多一个键',
      'workable',
      'RUNTIME_RULESET_SKIPPED_RULES_MALFORMED',
      (ruleset) => {
        (ruleset['finalSubmitControl'] as Record<string, unknown>)['confirmText'] = 'Submit application';
      },
    ],
    [
      '认不得的 step 类型',
      'ashby',
      'RUNTIME_RULESET_SKIPPED_RULES_MALFORMED',
      (ruleset) => {
        (ruleset['keySteps'] as unknown[]).push({ type: 'xpathMap', map: {} });
      },
    ],
    [
      '比内核新的 schemaVersion',
      'lever',
      'RUNTIME_RULESET_SKIPPED_RULES_SCHEMA_TOO_NEW',
      (ruleset) => {
        ruleset['schemaVersion'] = 4;
      },
    ],
  ];

  it.each(cases)('%s：只停 %s，别家照常，报 %s', async (_label, vendor, notice, mutate) => {
    const release = withRulesetChange(await builtRelease(), vendor, mutate);
    const registry = await createRuntimeApplyRegistry(release);
    expect(registry.ok, registry.ok ? '' : `整份被拒了：${registry.code}`).toBe(true);
    if (!registry.ok) return;
    const vendors = vendorsOf(registry.value);
    expect(vendors.has(vendor)).toBe(false);
    for (const other of ['ashby', 'greenhouse', 'lever', 'workable', 'workday'].filter((name) => name !== vendor)) {
      expect(vendors.has(other), other).toBe(true);
    }
    expect(registry.value.notices).toEqual([notice]);

    // 停掉的那家一条映射都解析不出来——授权那条路同样拿不到它。
    const stopped = release.mappings.find((mapping) => mapping.vendor === vendor)!;
    expect(resolveRuntimeApplyAdapter(registry.value, stopped).ok).toBe(false);
    const metadata = await createRuntimeApplyMetadataRegistry(release);
    expect(metadata.ok).toBe(true);
    if (metadata.ok) expect(vendorsOf(metadata.value).has(vendor)).toBe(false);
  });
});

describe('读不了内容的那一份，路由表的完整性照旧整份把关', () => {
  it('停掉的那份规则自称是别家的：不是版本窗口，是映射对不上——整份拒', async () => {
    const release = withRulesetChange(await builtRelease(), 'workday', (ruleset) => {
      ruleset['vendor'] = 'lever';
      (ruleset['keySteps'] as unknown[]).push({ type: 'xpathMap', map: {} });
    });
    expect(await createRuntimeApplyRegistry(release)).toEqual({ ok: false, code: 'RUNTIME_RULES_MAPPING_MISMATCH' });
  });
});

describe('发布侧照旧严格：本仓签进去的规则读不了是构建错误', () => {
  it('随包规则多一个顶层键 → 整份 RUNTIME_RULESET_REJECTED', async () => {
    const sources = { ...SOURCES, workday: { ...(workdayRules as Record<string, unknown>), futureWidgetBindings: [] } };
    expect(await buildApplyRulesRelease(releaseManifest, sources)).toEqual({
      ok: false,
      code: 'RUNTIME_RULESET_REJECTED',
    });
  });
});
