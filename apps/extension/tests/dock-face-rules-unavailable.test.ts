import { describe, expect, it } from 'vitest';
import { dockFaceForPage } from '../lib/autofillDockDecision';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

installBundledApplyAdapters();

/**
 * 取不到规则时，面板要说真话。
 *
 * 2026-09-18 生产事故：`/execution-runtime-bundle` 全员 503，插件装了一张空的
 * 适配器表，于是每一页都判成 DORMANT——面板说「这一页没有认出申请表」。
 *
 * 那是**假话**。那一页是一份规规矩矩的 Greenhouse 申请表，我们认得它；
 * 我们只是这一次没拿到规则。两件事对用户的下一步完全不同：
 *
 *   「这一页没有认出申请表」 → 他以为这家不支持，去别处，或者来投诉我们漏了一家
 *   「暂时取不到规则」       → 他知道等一会儿再试
 *
 * 而且第一句会把运维问题伪装成覆盖面问题：事故当天我自己就照着这句话去查了
 * 冷启动竞态和缓存，真正的原因（后端 503）藏在它后面。
 *
 * 闸不放松：取不到规则**照旧不提供 Autofill**（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED），
 * 这里改的只是那句话。
 */

const page = (over: Partial<Parameters<typeof dockFaceForPage>[0]> = {}) => dockFaceForPage({
  canonicalOrigin: 'https://boards.greenhouse.io',
  pathname: '/acme/jobs/123',
  connected: true,
  missionBound: true,
  reachableOnJobPages: true,
  ...over,
});

describe('取不到规则与认不出这一页，是两件事', () => {
  it('规则取不到：说「暂时取不到规则」，不是「没认出申请表」', () => {
    expect(page({ rulesAvailable: false })).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'RULES_UNAVAILABLE',
    });
  });

  it('规则在、但这一页确实不是申请表：照旧 DORMANT', () => {
    expect(page({ rulesAvailable: true, pathname: '/acme/about' }))
      .toEqual({ kind: 'DORMANT' });
  });

  it('规则在、这一页是申请表：照旧 READY', () => {
    expect(page({ rulesAvailable: true })).toEqual({ kind: 'READY' });
  });

  it('不传这个事实时按「规则在」算——旧调用方的行为不变', () => {
    expect(page()).toEqual({ kind: 'READY' });
  });

  it('取不到规则时不提供 Autofill——闸没放松', () => {
    const face = page({ rulesAvailable: false });
    expect(face.kind).not.toBe('READY');
  });

  it('没连接账号时，先说没连接——那是他能动手的那一步', () => {
    // 两件事都成立时，要说他能解决的那一件。
    expect(page({ rulesAvailable: false, connected: false }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });
});
