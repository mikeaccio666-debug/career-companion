import { afterEach, describe, expect, it } from 'vitest';

import { collectAttestationCandidates } from '../src/attest';
import {
  checkActiveCapability,
  consumeAuthority,
  mintAuthority,
  mintIntentAuthority,
  narrowAuthority,
} from '../src/grant';
import { createBundledApplyPolicy, tighten } from '../src/policy';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { setAttestationChecked } from '../src/write/setChecked';

/** 与 `apply-policy.test.ts` 同形的远程策略造型器（本文件自足，不跨文件依赖）。 */
const NOW = Date.now();
function remote(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 'remote-v1',
    minExtensionVersion: '1.0.0',
    enabled: true,
    vendors: { greenhouse: true, lever: false, ashby: false, workable: false },
    capabilities: { 'set-text': true, 'set-select': true },
    minConfidence: 0.7,
    inferredRequiresConfirm: true,
    notAfter: NOW + 10 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

function attestationCandidate() {
  document.body.innerHTML = `<form id="application-form">
    <label for="truth">I certify that the application information I entered is accurate.</label>
    <input id="truth" name="truth" type="checkbox" />
  </form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单——writer capability 探针会空转').not.toBeNull();
  const candidates = collectAttestationCandidates([...greenhouseAdapter.scan(root!)], root!);
  expect(candidates, '声明没进候选——writer capability 探针会空转').toHaveLength(1);
  return {
    candidate: candidates[0]!,
    element: document.querySelector<HTMLInputElement>('#truth')!,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});
/**
 * C3 放行闸。
 *
 * `PD-2026-08-18-IRONCLAD-5-SPLIT` 只定义了未来行为；源契约、
 * durable release authority、T21 条款、确认 UI 与正式接线落定前，
 * 通用写入授权必须无法获得 `set-attestation`。
 *
 * 实现是三重失败关闭：包内策略 `false`，远程只能收紧，
 * 且 gesture / execution-lease 两条通用 mint 都删掉这个保留能力。
 *
 * 未来放行不是「改一行」：必须新建只接受服务端 release 绑定的
 * 专用 mint 路径，并单独通过变异门禁与三人复审。
 */
describe('C3 放行闸：乙档代勾不能由通用授权打开', () => {
  it('包内策略里 set-attestation 必须是 false', () => {
    expect(
      createBundledApplyPolicy().capabilities['set-attestation'],
      '包内策略放开了 set-attestation——' +
        '源契约/release/T21/UI 与正式接线尚未落定',
    ).toBe(false);
  });

  it('通用手势授权即使申请 set-attestation 也不得铸出', () => {
    const gesture = trustedShadowClick();
    const result = mintAuthority({
      ...gesture,
      purpose: 'fill',
      fingerprint: 'reserved-capability-probe',
      capabilities: new Set(['set-attestation']),
      now: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(narrowAuthority(result.value, new Set(['set-attestation']), 1_001).ok).toBe(true);
    expect(Reflect.set(result.value, 'capabilities', new Set(['set-attestation']))).toBe(false);
    expect(result.value).not.toHaveProperty('capabilities');
    expect(consumeAuthority(result.value, 1_001).ok).toBe(true);
    expect(checkActiveCapability(result.value, 'set-attestation', 1_001)).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
  });

  it('通用 execution lease 授权即使申请 set-attestation 也不得铸出', () => {
    const result = mintIntentAuthority({
      lease: { executionLease: 'lease-reserved-capability-probe', expiresAtMs: 10_000 },
      purpose: 'fill',
      fingerprint: 'reserved-capability-probe',
      capabilities: new Set(['set-attestation']),
      now: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('capabilities');
    expect(consumeAuthority(result.value, 1_001).ok).toBe(true);
    expect(checkActiveCapability(result.value, 'set-attestation', 1_001)).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
  });

  it('writer 必须在真实调用点拒绝通用 authority，不得只靠上游检查', () => {
    const minted = mintAuthority({
      ...trustedShadowClick(),
      purpose: 'fill',
      fingerprint: 'writer-callpoint-probe',
      capabilities: new Set(['set-attestation']),
      now: 1_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(consumeAuthority(minted.value, 1_001).ok).toBe(true);
    const { candidate, element } = attestationCandidate();

    expect(setAttestationChecked({ candidate, authority: minted.value })).toEqual({
      ok: false,
      error: 'CAPABILITY_DISABLED',
    });
    expect(element.checked).toBe(false);
  });

  it('其余能力位不受影响（这条防的是"顺手把整张表关掉"）', () => {
    const caps = createBundledApplyPolicy().capabilities;
    expect(caps['set-text'], 'set-text 被关掉了——普通字段填写会整体失效').toBe(true);
  });
});

/**
 * ⚠️ 上面那一组只断言 `createBundledApplyPolicy()`，**从不走远程合并路径**。
 *
 * 审查实测（2026-08-19）：`WRITE_CAPABILITIES` 当时漏了 `set-attestation`，
 * 而 `satisfies` 不校验穷尽——`tsc` 干净，但 `tighten()` 用
 * `WRITE_CAPABILITIES.map(...)` 重建 capabilities，那一位**被整个丢掉**：
 *
 *   bundled  → `set-attestation: false`
 *   resolved → 键不存在，值 `undefined`
 *
 * 两个方向都坏：包内那个 `false` 没参与合并（今天仍 fail-closed 纯属侥幸——
 * `undefined` 是 falsy 而调用方恰好按真值筛，任何一处改成 `!== false` 就开洞），
 * 而且「把包内改成 `true` 就是放行动作本身」在远程路径上**不成立**。
 *
 * 本组走真实合并路径。
 */
describe('C3 放行闸在**远程合并之后**仍然存在', () => {
  it('tighten 之后 set-attestation 这个键必须还在，且是 false', () => {
    const bundled = createBundledApplyPolicy();
    const resolved = tighten(bundled, remote({ minConfidence: 0.5 }));

    expect(
      Object.keys(resolved.capabilities),
      'set-attestation 在远程合并后消失了——包内那个 false 根本没参与合并，' +
        '「改一行就是放行」也不成立',
    ).toContain('set-attestation');
    expect(resolved.capabilities['set-attestation']).toBe(false);
  });

  it('远程即便显式说 true 也打不开（只能收紧）', () => {
    const bundled = createBundledApplyPolicy();
    const resolved = tighten(
      bundled,
      remote({ capabilities: { 'set-attestation': true, 'set-text': true } }),
    );
    expect(
      resolved.capabilities['set-attestation'],
      '远程策略把 C3 放行闸打开了——远程只能收紧不能放开这条不成立',
    ).toBe(false);
  });
});
