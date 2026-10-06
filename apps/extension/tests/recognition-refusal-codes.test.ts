import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { canonicalizeApplyRulesJson } from '@edaix/apply-kernel/runtimeRegistry';
import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';

import { installApplyAdaptersFromRules } from '../lib/executionRuntimeAuthority';

/**
 * 认不出这一页时，**为什么**认不出必须留下一个稳定码。
 *
 * 2026-09-22 生产故障：后端换了一版 release，运行中的 worker 装入表变成空的，
 * 此后每一页都拒。对外那个 `UNAVAILABLE` 是对的（浮层不需要知道分别），但
 * worker 的诊断环**一个码都没有**——四种完全不同的拒绝走的是同一条 return，
 * 于是只能靠生产测试台一步步反推：先证明页面有表单、再证明规则本身能编译、
 * 再从隔离世界发探针、最后重载扩展对照。有码的话第一分钟就定位了。
 *
 * 四种拒绝的处置完全不同：
 *  · `DISCOVERY_VENDOR_UNKNOWN`  —— 覆盖面问题，要加厂商；
 *  · `DISCOVERY_ADAPTER_MISSING` —— 运维故障，规则没装上（就是这一次）；
 *  · `DISCOVERY_NOT_APPLY_PATH`  —— 规则问题，路径规则没覆盖这条 URL；
 *  · `DISCOVERY_AUTHORITY_*`     —— 授权问题，映射或策略把这家关着。
 *
 * 只记码：不记 origin、不记 pathname、不记厂商名（RULE-GLOBAL-DATA-L1）。
 */

describe('装不上规则时带出内核自己的拒绝码', () => {
  it('release 验不过 → 记 APPLY_RULES_INSTALL_REJECTED_<内核码>，并且装空表', async () => {
    const codes: string[] = [];
    // `null` 走的是和「后端发了这个包不认识的厂商」同一条路：整份 release 拒。
    expect(await installApplyAdaptersFromRules(null, (code) => codes.push(code))).toBe(0);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^APPLY_RULES_INSTALL_REJECTED_RUNTIME_RULES_/u);
  });

  it('不传 onDiagnostic 也不炸——内容脚本那一侧没有诊断环', async () => {
    await expect(installApplyAdaptersFromRules(null)).resolves.toBe(0);
  });

  it('码里不带规则内容', async () => {
    const codes: string[] = [];
    await installApplyAdaptersFromRules(
      { mappings: [{ atsProvider: 'GREENHOUSE', pathRuleId: 'secret-rule-id' }] },
      (code) => codes.push(code),
    );
    expect(codes.join(' ')).not.toContain('secret-rule-id');
    expect(codes.every((code) => /^[A-Z0-9_]+$/u.test(code))).toBe(true);
  });
});

/**
 * 后端先发、这个包还不认识的规则改动（2026-09-28）。
 *
 * 2026-09-24：一份规则多了一个顶层键，旧包整份拒收，所有厂商约 5 分钟内一起停。现在那一份照常装上，
 * 读不了的只停它自己那一家；两种情形各记一个稳定码——只有码，没有厂商名、键名与规则内容。
 */
describe('这一版读不了的规则改动：装得上的照装，各记一个稳定码', () => {
  function sha256(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonicalizeApplyRulesJson(value), 'utf8').digest('hex')}`;
  }

  /** 改一家的规则，并按改后的内容把两层摘要重新封好（后端发版就是这个形状）。 */
  function withRulesetChange(vendor: string, mutate: (ruleset: Record<string, unknown>) => void): unknown {
    const release = structuredClone(APPLY_RULES_RUNTIME_RELEASE_V1) as unknown as {
      releaseVersion: string;
      releaseDigest: string;
      mappings: Array<{ vendor: string; rulesetVersion: string; rulesetDigest: string }>;
      rulesets: Array<{ version: string; digest: string; ruleset: Record<string, unknown> }>;
    };
    const entry = release.rulesets.find(({ ruleset }) => ruleset['vendor'] === vendor)!;
    mutate(entry.ruleset);
    entry.digest = sha256(entry.ruleset);
    for (const mapping of release.mappings) {
      if (mapping.rulesetVersion === entry.version) mapping.rulesetDigest = entry.digest;
    }
    release.releaseDigest = sha256({
      releaseVersion: release.releaseVersion,
      mappings: release.mappings,
      rulesets: release.rulesets,
    });
    return release;
  }

  const everyVendor = new Set(APPLY_RULES_RUNTIME_RELEASE_V1.mappings.map(({ vendor }) => vendor)).size;

  it('一份规则多了顶层键：整份照常装上，记 APPLY_RULES_INSTALL_RUNTIME_RULESET_UNKNOWN_KEY_IGNORED', async () => {
    const codes: string[] = [];
    const installed = await installApplyAdaptersFromRules(
      withRulesetChange('workday', (ruleset) => { ruleset['futureWidgetBindings'] = []; }),
      (code) => codes.push(code),
    );
    expect(installed).toBe(everyVendor);
    expect(codes).toEqual(['APPLY_RULES_INSTALL_RUNTIME_RULESET_UNKNOWN_KEY_IGNORED']);
  });

  it('一份规则的已知结构里多了东西：只停那一家，记 APPLY_RULES_INSTALL_RUNTIME_RULESET_SKIPPED_<内核码>', async () => {
    const codes: string[] = [];
    const installed = await installApplyAdaptersFromRules(
      withRulesetChange('workday', (ruleset) => {
        (ruleset['listboxComboboxes'] as Array<Record<string, unknown>>)[0]!['clearSelector'] = 'button.clear';
      }),
      (code) => codes.push(code),
    );
    expect(installed).toBe(everyVendor - 1);
    expect(codes).toEqual(['APPLY_RULES_INSTALL_RUNTIME_RULESET_SKIPPED_RULES_MALFORMED']);
    expect(codes.join(' ')).not.toMatch(/workday|clear/iu);
  });

  it('整份一字不落地读懂了：一个码都不记', async () => {
    const codes: string[] = [];
    expect(await installApplyAdaptersFromRules(APPLY_RULES_RUNTIME_RELEASE_V1, (code) => codes.push(code)))
      .toBe(everyVendor);
    expect(codes).toEqual([]);
  });
});

/**
 * 这一段是源码形状闸，与 `dock-face-awaits-rules` 同一个路数：background 的
 * 消息接线没有别的办法在单测里摆出「worker 持有一张空装入表」这个状态，而它
 * 恰恰是出问题的那一刻。闸守的是「四条拒绝路径各自有码、而且分得开」。
 */
const background = readFileSync(
  resolve(__dirname, '..', 'entrypoints', 'background.ts'),
  'utf8',
);

/** DISCOVERY_AUTHORITY 那一支的正文。 */
function discoveryBranch(): string {
  const start = background.indexOf("if (intent.want === 'DISCOVERY_AUTHORITY') {");
  expect(start, '找不到 DISCOVERY_AUTHORITY 分支；这条闸要跟着改').toBeGreaterThan(-1);
  const end = background.indexOf("if (intent.want === 'PROFILE') {", start);
  expect(end, '找不到下一个分支的边界').toBeGreaterThan(start);
  return background.slice(start, end);
}

describe('四种拒绝各记各的码', () => {
  const body = discoveryBranch();

  it.each([
    ['认不出是哪家', 'DISCOVERY_VENDOR_UNKNOWN'],
    ['认得这家但适配器没装上', 'DISCOVERY_ADAPTER_MISSING'],
    // 2026-09-22：谁都认不出时退通用路，而通用路这一版没放行（包里没有 GENERIC
    // 映射或策略位关着）。它与上一条症状一样、原因完全不同——上一条是运维故障，
    // 这一条是「这条路还没开」，混成一个码线上只能靠反推。
    ['谁都认不出且通用路没放行', 'DISCOVERY_GENERIC_UNAVAILABLE'],
    ['这条路径不是申请路径', 'DISCOVERY_NOT_APPLY_PATH'],
    ['授权那一关拒了', 'DISCOVERY_AUTHORITY_'],
  ])('%s → %s', (_why, code) => {
    expect(body).toContain(code);
  });

  it('「适配器没装上」是单独一条闸，不再和路径判断挤在一个 if 里', () => {
    // 2026-09-22 之前这两件事折在同一个 `||` 里，于是「表是空的」和「这条 URL
    // 不是申请页」给出完全一样的结果——那正是这次查不动的原因。
    expect(body).toMatch(/hasApplyAdapter\(vendor\)/u);
    const adapter = body.search(/hasApplyAdapter\(vendor\)/u);
    const path = body.search(/isApplyFormPath\(vendor,/u);
    expect(adapter).toBeGreaterThan(-1);
    expect(path).toBeGreaterThan(-1);
    // 先判装入表，再判路径：表是空的时候，路径判断说什么都没有意义。
    expect(adapter).toBeLessThan(path);
  });

  it('对外仍然只有一个 UNAVAILABLE——分别是记给 worker 的，不是给页面的', () => {
    expect(body).not.toMatch(/code:\s*'DISCOVERY_/u);
    for (const match of body.matchAll(/kind:\s*'REFUSED',\s*code:\s*'(\w+)'/gu)) {
      expect(match[1]).toBe('UNAVAILABLE');
    }
  });
});
