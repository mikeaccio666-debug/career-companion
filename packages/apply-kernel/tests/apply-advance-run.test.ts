import { describe, expect, it } from 'vitest';

import {
  ADVANCE_RUN_MAX_PAGES,
  ADVANCE_RUN_STEP_RESERVE_MS,
  ADVANCE_RUN_TTL_MS,
  GESTURE_PROOF_TTL_MS,
  abandonAdvanceRunStep,
  advanceRunState,
  beginAdvanceRunStep,
  captureTrustedShadowGesture,
  checkActiveCapability,
  closeAdvanceRun,
  completeAdvanceRunStep,
  consumeAuthority,
  endAdvanceRun,
  gestureRootRemainingMs,
  isAdvanceRunPage,
  isAdvanceRunStepCurrent,
  mintAuthorityFromGesture,
  mintRowActionAuthorityFromGesture,
  openAdvanceRun,
  type AdvanceRun,
  type AdvanceRunPageProof,
  type AdvanceRunScope,
  type GestureRoot,
  type TrustedGestureProof,
  type WriteCapability,
} from '../src/grant';

/**
 * 一次「自动填写」连着往下填（2026-09-28 负责人决定：按一下，一页一页填到检查页，停在那里等他按「提交」）。
 *
 * 信任根仍是那一下真实点击。它开出一轮**有边界的**连填，这份文件钉的就是这几条边界：
 *  · 只从一次真实点击开（点击凭证、30 秒之内、一次点击只开一轮；连填自己发的「这一页」凭证开不出新的一轮）；
 *  · 同一个页面、同一张申请、同一家（origin + pathname + 厂商），换了就不再往下翻；
 *  · 总时限（从那一下点击算起）与页数上限；
 *  · 每翻一页只发一张「这一页」的凭证，上一页的随之作废；停止、换一轮就全部作废；
 *  · 它铸出来的写入票与点击铸的一样收窄：翻页、连填、提交这几位永远不在票上。
 */

const T0 = 1_000_000;
const SCOPE: AdvanceRunScope = Object.freeze({
  origin: 'https://acme.wd5.myworkdayjobs.com',
  pathname: '/en-US/External/job/Remote/Engineer_R1/apply/applyManually',
  vendor: 'workday',
});

function click(at = T0): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const event = new Event('click', { bubbles: true, composed: true });
  // happy-dom 的事件没有浏览器填的 isTrusted；只在测试替身上定义它。
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host] });
  const proof = captureTrustedShadowGesture(event, shadowRoot, at);
  if (proof === null) throw new Error('test click was not accepted');
  return proof;
}

function open(at = T0, overrides: Partial<Parameters<typeof openAdvanceRun>[0]> = {}) {
  const opened = openAdvanceRun({ proof: click(at), scope: SCOPE, now: at, ...overrides });
  if (!opened.ok) throw new Error(`run did not open: ${opened.code}`);
  return opened.value;
}

const mintsAt = (root: GestureRoot, now: number) =>
  mintAuthorityFromGesture({ proof: root, purpose: 'fill', fingerprint: 'plan-1', now });

/** 翻一页：开一步、（宿主真的翻过去了）、完成，交回新一页的凭证。 */
function turn(run: AdvanceRun, now: number): AdvanceRunPageProof {
  const step = beginAdvanceRunStep(run, SCOPE, now);
  if (!step.ok) throw new Error(`step refused: ${step.code}`);
  const page = completeAdvanceRunStep(step.value, now);
  if (!page.ok) throw new Error(`step not completed: ${page.code}`);
  return page.value;
}

describe('开一轮连填：只认一次真实点击', () => {
  it('30 秒之内的点击凭证 → 开出一轮，第一页的凭证铸得出填写票', () => {
    const { run, page } = open();
    expect(isAdvanceRunPage(page)).toBe(true);
    expect(mintsAt(page, T0 + 1_000).ok).toBe(true);
    expect(advanceRunState(run, SCOPE, T0)).toEqual({ ok: true, value: { page: 1, maxPages: ADVANCE_RUN_MAX_PAGES, remainingMs: ADVANCE_RUN_TTL_MS } });
  });

  it('伪造的凭证（同形状的对象）→ 开不出', () => {
    const forged = Object.freeze({ capturedAt: T0 }) as unknown as TrustedGestureProof;
    expect(openAdvanceRun({ proof: forged, scope: SCOPE, now: T0 })).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
  });

  it('点击已经过了 30 秒 → 开不出', () => {
    const proof = click(T0);
    expect(openAdvanceRun({ proof, scope: SCOPE, now: T0 + GESTURE_PROOF_TTL_MS + 1 })).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('一次点击只开一轮', () => {
    const proof = click(T0);
    expect(openAdvanceRun({ proof, scope: SCOPE, now: T0 }).ok).toBe(true);
    expect(openAdvanceRun({ proof, scope: SCOPE, now: T0 })).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
  });

  it('连填发的「这一页」凭证不是点击：开不出新的一轮（不能自己续自己）', () => {
    const { page } = open();
    expect(openAdvanceRun({ proof: page as unknown as TrustedGestureProof, scope: SCOPE, now: T0 })).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
  });

  it('范围说不清（空的 origin / 路径 / 厂商）→ 开不出', () => {
    for (const scope of [{ ...SCOPE, origin: '' }, { ...SCOPE, pathname: '' }, { ...SCOPE, vendor: '' }]) {
      expect(openAdvanceRun({ proof: click(), scope, now: T0 })).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    }
  });

  it('调用方只能收紧上限，放不宽', () => {
    const wide = open(T0, { maxPages: 50, ttlMs: 60 * 60_000 });
    expect(advanceRunState(wide.run, SCOPE, T0)).toMatchObject({ ok: true, value: { maxPages: ADVANCE_RUN_MAX_PAGES, remainingMs: ADVANCE_RUN_TTL_MS } });
    const tight = open(T0, { maxPages: 3, ttlMs: 120_000 });
    expect(advanceRunState(tight.run, SCOPE, T0)).toMatchObject({ ok: true, value: { maxPages: 3, remainingMs: 120_000 } });
  });
});

describe('这一页的凭证', () => {
  it('活过 30 秒：这一轮还开着、还是这一页，它就一直铸得出（AI 答案晚到也写得上）', () => {
    const { page } = open();
    expect(mintsAt(page, T0 + GESTURE_PROOF_TTL_MS + 60_000).ok).toBe(true);
    expect(gestureRootRemainingMs(page, T0 + 60_000)).toBe(ADVANCE_RUN_TTL_MS - 60_000);
  });

  it('总时限从那一下点击算起：到点之后一张票都铸不出', () => {
    const { page } = open();
    expect(mintsAt(page, T0 + ADVANCE_RUN_TTL_MS)).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
    expect(gestureRootRemainingMs(page, T0 + ADVANCE_RUN_TTL_MS)).toBe(0);
  });

  it('行动作的专用票（加一行、保存本段）也认它，同样受这一轮的边界管', () => {
    const { run, page } = open();
    expect(mintRowActionAuthorityFromGesture({ proof: page, action: 'add', now: T0 + 45_000 }).ok).toBe(true);
    endAdvanceRun(run);
    expect(mintRowActionAuthorityFromGesture({ proof: page, action: 'save', now: T0 + 46_000 })).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('翻过一页：发新一页的凭证，上一页的作废（翻走的那一页不能再写）', () => {
    const { run, page: first } = open();
    const second = turn(run, T0 + 20_000);
    expect(mintsAt(second, T0 + 21_000).ok).toBe(true);
    expect(mintsAt(first, T0 + 21_000)).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
    expect(advanceRunState(run, SCOPE, T0 + 21_000)).toMatchObject({ ok: true, value: { page: 2 } });
  });

  it('伪造的「这一页」凭证 → 不认', () => {
    const forged = Object.freeze({ capturedAt: T0 }) as unknown as AdvanceRunPageProof;
    expect(mintsAt(forged, T0)).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(isAdvanceRunPage(forged)).toBe(false);
  });

  it('铸出来的票与点击铸的一样收窄：翻页、连填、提交、代填、行动作这几位永远不在票上', () => {
    const { page } = open();
    const reserved: WriteCapability[] = ['advance-step', 'advance-steps', 'submit-application', 'sign-on-behalf', 'manage-rows', 'set-attestation'];
    const minted = mintAuthorityFromGesture({
      proof: page,
      purpose: 'fill',
      fingerprint: 'plan-1',
      capabilities: new Set<WriteCapability>(['set-text', ...reserved]),
      now: T0,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(consumeAuthority(minted.value, T0).ok).toBe(true);
    expect(checkActiveCapability(minted.value, 'set-text', T0).ok).toBe(true);
    for (const capability of reserved) {
      expect(checkActiveCapability(minted.value, capability, T0), capability).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    }
  });
});

describe('往下翻一页：同一个页面、同一张申请、同一家', () => {
  it.each([
    ['换了 origin', { ...SCOPE, origin: 'https://evil.example' }],
    ['换了路径（另一个岗位的申请）', { ...SCOPE, pathname: '/en-US/External/job/Remote/Other_R2/apply/applyManually' }],
    ['换了厂商', { ...SCOPE, vendor: 'greenhouse' }],
  ])('%s → 不翻', (_name, scope) => {
    const { run } = open();
    expect(beginAdvanceRunStep(run, scope, T0 + 1_000)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    expect(advanceRunState(run, scope, T0 + 1_000)).toEqual({ ok: false, code: 'RUN_SCOPE_CHANGED' });
    // 这一步没开成：同一个范围里照旧能翻。
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 1_000).ok).toBe(true);
  });

  it('一次只翻一页：上一步还没结论，再开一步 → RUN_BUSY', () => {
    const { run } = open();
    const step = beginAdvanceRunStep(run, SCOPE, T0 + 1_000);
    expect(step.ok).toBe(true);
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 1_100)).toEqual({ ok: false, code: 'RUN_BUSY' });
  });

  it('宿主没翻过去（放弃这一步）→ 页数不涨、这一页的凭证照旧有效，可以再开一步', () => {
    const { run, page } = open();
    const step = beginAdvanceRunStep(run, SCOPE, T0 + 1_000);
    if (!step.ok) throw new Error(step.code);
    abandonAdvanceRunStep(step.value);
    expect(isAdvanceRunStepCurrent(step.value, T0 + 1_100)).toBe(false);
    expect(completeAdvanceRunStep(step.value, T0 + 1_200)).toEqual({ ok: false, code: 'RUN_STEP_STALE' });
    expect(mintsAt(page, T0 + 1_300).ok).toBe(true);
    expect(advanceRunState(run, SCOPE, T0 + 1_300)).toMatchObject({ ok: true, value: { page: 1 } });
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 1_400).ok).toBe(true);
  });

  it('一步只能完成一次', () => {
    const { run } = open();
    const step = beginAdvanceRunStep(run, SCOPE, T0 + 1_000);
    if (!step.ok) throw new Error(step.code);
    expect(completeAdvanceRunStep(step.value, T0 + 2_000).ok).toBe(true);
    expect(completeAdvanceRunStep(step.value, T0 + 2_100)).toEqual({ ok: false, code: 'RUN_STEP_STALE' });
  });

  it('页数上限（含第一页）：填满上限那一页之后不再往下翻', () => {
    const { run } = open(T0, { maxPages: 3 });
    turn(run, T0 + 10_000);
    turn(run, T0 + 20_000);
    expect(advanceRunState(run, SCOPE, T0 + 21_000)).toMatchObject({ ok: true, value: { page: 3, maxPages: 3 } });
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 30_000)).toEqual({ ok: false, code: 'RUN_PAGE_CAP' });
  });

  it('默认上限就是 10 页', () => {
    const { run } = open();
    for (let page = 2; page <= ADVANCE_RUN_MAX_PAGES; page += 1) turn(run, T0 + page * 1_000);
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 60_000)).toEqual({ ok: false, code: 'RUN_PAGE_CAP' });
  });

  it('剩下的时间不够下一页用（扫描、问资料、铸第一张票）→ 不再往下翻，免得翻过去只填一半', () => {
    const { run, page } = open();
    const late = T0 + ADVANCE_RUN_TTL_MS - ADVANCE_RUN_STEP_RESERVE_MS + 1;
    expect(beginAdvanceRunStep(run, SCOPE, late)).toEqual({ ok: false, code: 'RUN_EXPIRED' });
    // 这一页照旧写得进去：没翻，只是不再往下翻。
    expect(mintsAt(page, late).ok).toBe(true);
  });

  it('开了一步之后时限到了 → 这一步不再算数，也完成不了', () => {
    const { run } = open();
    const step = beginAdvanceRunStep(run, SCOPE, T0 + 1_000);
    if (!step.ok) throw new Error(step.code);
    expect(isAdvanceRunStepCurrent(step.value, T0 + ADVANCE_RUN_TTL_MS)).toBe(false);
    expect(completeAdvanceRunStep(step.value, T0 + ADVANCE_RUN_TTL_MS)).toEqual({ ok: false, code: 'RUN_EXPIRED' });
  });
});

describe('收场', () => {
  it('停止（用户按了「停止」、换了一轮、离开了这一页）→ 全部作废：不能再翻，这一页也不能再写', () => {
    const { run, page } = open();
    const step = beginAdvanceRunStep(run, SCOPE, T0 + 1_000);
    if (!step.ok) throw new Error(step.code);
    endAdvanceRun(run);
    expect(isAdvanceRunStepCurrent(step.value, T0 + 1_100)).toBe(false);
    expect(completeAdvanceRunStep(step.value, T0 + 1_200)).toEqual({ ok: false, code: 'RUN_ENDED' });
    expect(mintsAt(page, T0 + 1_300)).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 1_400)).toEqual({ ok: false, code: 'RUN_ENDED' });
    expect(advanceRunState(run, SCOPE, T0 + 1_400)).toEqual({ ok: false, code: 'RUN_ENDED' });
  });

  it('自己停在检查页、或停下来等用户（收起这一轮）→ 不再往下翻；这一页的凭证最多再活一次点击那么久', () => {
    const { run } = open();
    const page = turn(run, T0 + 60_000);
    closeAdvanceRun(run, T0 + 90_000);
    expect(beginAdvanceRunStep(run, SCOPE, T0 + 90_001)).toEqual({ ok: false, code: 'RUN_ENDED' });
    // 网站在整轮之后清空了一栏：同一次之内重填一次还来得及（与一次点击的 30 秒同一个口径）。
    expect(mintsAt(page, T0 + 90_000 + GESTURE_PROOF_TTL_MS - 1).ok).toBe(true);
    expect(mintsAt(page, T0 + 90_000 + GESTURE_PROOF_TTL_MS)).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('收起时离总时限已不到 30 秒：以总时限为准，不因收起而延长', () => {
    const { run, page } = open();
    closeAdvanceRun(run, T0 + ADVANCE_RUN_TTL_MS - 5_000);
    expect(mintsAt(page, T0 + ADVANCE_RUN_TTL_MS - 1).ok).toBe(true);
    expect(mintsAt(page, T0 + ADVANCE_RUN_TTL_MS)).toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('伪造的一轮（同形状的对象）→ 什么都做不了', () => {
    const forged = Object.freeze({}) as unknown as AdvanceRun;
    expect(beginAdvanceRunStep(forged, SCOPE, T0)).toEqual({ ok: false, code: 'RUN_ENDED' });
    expect(advanceRunState(forged, SCOPE, T0)).toEqual({ ok: false, code: 'RUN_ENDED' });
    expect(() => { endAdvanceRun(forged); closeAdvanceRun(forged, T0); }).not.toThrow();
  });
});

describe('剩多少时间', () => {
  it('点击凭证：30 秒减去已经过去的', () => {
    const proof = click(T0);
    expect(gestureRootRemainingMs(proof, T0 + 10_000)).toBe(GESTURE_PROOF_TTL_MS - 10_000);
    expect(gestureRootRemainingMs(proof, T0 + GESTURE_PROOF_TTL_MS + 5)).toBe(0);
  });

  it('不认得的东西：0', () => {
    expect(gestureRootRemainingMs(Object.freeze({ capturedAt: T0 }) as unknown as GestureRoot, T0)).toBe(0);
  });
});
