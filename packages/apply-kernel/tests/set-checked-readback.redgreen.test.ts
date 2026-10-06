import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectAttestationCandidates, type AttestationCandidate } from '../src/attest';
import type { ScanRoot } from '../src/contracts';
import { setAttestationChecked } from '../src/write/setChecked';
import type { HostWriteAuthority } from '../src/grant';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';

// This file isolates the checked writer's DOM behaviour. The real grant path
// is exercised separately in attestation-capability-gate.test.ts, where both
// generic minters must refuse the reserved capability.
vi.mock('../src/grant', () => ({
  checkActiveCapability: () => ({ ok: true as const, value: undefined }),
}));

/**
 * 写完必须读回。
 *
 * 代码审查实测（2026-08-19）：宿主页若覆盖了原型上的 `checked` 访问器，
 * 走 `getPrototypeOf(element)` 拿到的就是**宿主自己的 setter**——
 * 调用它等于把写入交给宿主代码，而它可以什么都不做。
 * 原实现返回 `ok:true / changed:true`，而 **DOM 根本没变**：
 * 回执与 undo journal 会记下一个从未发生过的状态。
 *
 * 本仓其他写入原语都有读回（`runner.ts` 的 verificationFailure），
 * `dict/controls.ts:33` 还记着 2026-08-01 Greenhouse 的实测教训——
 * 「落早了**把一次什么都没填的写入报成成功**」。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function box(label: string): {
  candidate: AttestationCandidate;
  element: HTMLInputElement;
  label: HTMLLabelElement;
  root: ScanRoot;
} {
  document.body.innerHTML = `<form id="application-form">
    <label for="attestation">${label}</label>
    <input id="attestation" name="attestation" type="checkbox" />
  </form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单——writer 测试会空转').not.toBeNull();
  const picked = collectAttestationCandidates([...greenhouseAdapter.scan(root!)], root!);
  expect(picked, '声明没进候选——writer 测试会空转').toHaveLength(1);
  return {
    candidate: picked[0]!,
    element: document.querySelector('input')!,
    label: document.querySelector('label')!,
    root: root!,
  };
}

/**
 * 一份带 `set-attestation` 的活授权。
 *
 * 手势必须是 shadow 内的可信点击（`mintAuthority` 的前置）——
 * 与 `apply-grant.test.ts` 的 `trustedShadowClick` 同形。
 * 能力位本身在包内策略里是关的（C3 放行闸），这里是单测夹具。
 */
const authority = {} as HostWriteAuthority;
const TRUTHFULNESS_LABEL =
  'I certify that the application information I entered is accurate.';

describe('写完读回：宿主吞掉写入时必须报失败', () => {
  it('正常情况下写得进去', () => {
    const { candidate, element } = box(TRUTHFULNESS_LABEL);
    const r = setAttestationChecked({
      candidate,
      authority,
    });
    expect(r.ok, r.ok ? '' : `失败了：${r.error}`).toBe(true);
    expect(element.checked).toBe(true);
  });

  it('宿主在实例上装了吞掉写入的 checked 访问器 → WRITE_REVERTED，不许报成功', () => {
    const { candidate, element } = box(TRUTHFULNESS_LABEL);
    // 宿主页的典型做法：在元素实例上装自己的访问器。
    Object.defineProperty(element, 'checked', {
      get: () => false,
      set: () => {
        /* 吞掉 */
      },
      configurable: true,
    });

    const r = setAttestationChecked({
      candidate,
      authority,
    });

    expect(
      r.ok,
      '宿主吞掉了写入，我们却报成功——回执与 undo journal 会记下一个从未发生过的状态',
    ).toBe(false);
    expect(r.ok ? '' : r.error).toBe('WRITE_REVERTED');
  });

  it('宿主声明已变更：调用方即使注入旧 reader 也必须拒写', () => {
    const oldText = TRUTHFULNESS_LABEL;
    const { candidate, element, label, root } = box(oldText);
    expect(
      Reflect.set(root, 'labelTextFor', () => oldText),
      '可信 ScanRoot 没有冻结，调用方可在放行后替换 DOM reader',
    ).toBe(false);
    label.textContent = 'I certify that the information supplied is complete.';

    // 敌对探针：即使用运行时造型塞回旧 API 的三个注入点，
    // writer 也只能从 candidate 的私有 ScanRoot authority 重读 DOM。
    const r = setAttestationChecked({
      candidate,
      authority,
      releasedDigest: 'stale',
      readDeclarationText: () => oldText,
      digest: () => 'stale',
    } as unknown as Parameters<typeof setAttestationChecked>[0]);

    expect(r.ok, '调用方提供的旧 reader 绕过了写入前的实时 DOM 复核').toBe(false);
    expect(r.ok ? '' : r.error).toBe('ATTESTATION_TEXT_CHANGED');
    expect(element.checked).toBe(false);
  });

  it('候选生成后才出现蜜罐信号：写前必须重新分类并拒写', () => {
    const { candidate, element } = box(TRUTHFULNESS_LABEL);
    element.setAttribute('data-automation-id', 'beecatcher');

    const r = setAttestationChecked({ candidate, authority });

    expect(r).toEqual({ ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' });
    expect(element.checked).toBe(false);
  });

  it('结构上伪造的 candidate 不能触发写入', () => {
    const { candidate, element } = box(TRUTHFULNESS_LABEL);
    const forged = { ...candidate } as AttestationCandidate;

    const r = setAttestationChecked({ candidate: forged, authority });

    expect(r).toEqual({ ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' });
    expect(element.checked).toBe(false);
  });
});
