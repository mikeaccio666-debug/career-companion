import { captureTrustedShadowGesture, gestureRootRemainingMs, type TrustedGestureProof } from '@edaix/apply-kernel/grant';

import type { DockAdvanceOutcome } from './autofillDock';

/**
 * 「继续到下一页」= 翻过去，然后接着填下一页。
 *
 * 2026-09-22 负责人：「应该是点击到下一页，就是自动开始填下一页了」。从前翻过去之后浮层回到
 * 可以点 Autofill 的样子，用户每一页都要多按一下。
 *
 * ## 信任根还是那一次点击
 *
 * 手势填写的授权从来都是「用户在我们浮层里的真实点击」（isTrusted + 来自我方 shadow，
 * 见 grant.ts）。「继续到下一页」那一下同样是这样一次点击，按钮下面写明了它会翻页并接着填——
 * 所以在点击的当下取一张凭证，翻过去之后拿它填下一页，判据一个字没变。凭证的年龄上限
 * （GESTURE_PROOF_TTL_MS）也照旧：翻页花的时间太长、剩下的不够下一页扫描与铸票，就不自动填，
 * 交还用户点 Autofill——不让一张快过期的凭证半路失效、只填一半。
 *
 * 用户自己在网站上按的「下一步」**不**接着填：那一下不是我们浮层里的点击，没有凭证。只凭
 * 「页面换了一步」就写用户的资料，等于任何页面伪造一次换页都能让我们把资料写进它的表单。
 */

/** 留给下一页的时间：等页面出来、扫描、问后台要授权与档案、铸票，都得在凭证过期之前。 */
export const NEXT_PAGE_RESERVE_MS = 15_000;

/** 翻过去之后最多等新一页多久（在上面那份余量之内）。 */
export const NEXT_PAGE_SCAN_BUDGET_MS = 8_000;

export interface AdvanceThenFillInput {
  /** 翻页本身（wizardAdvanceController.advance）。必须在点击的派发过程中同步调用。 */
  readonly advance: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAdvanceOutcome>;
  /** 翻过去之后填下一页，带着点击当下取到的那张凭证。 */
  readonly fillNextPage: (proof: TrustedGestureProof) => void;
  readonly now?: () => number;
  readonly reserveMs?: number;
}

export function createAdvanceThenFill(
  input: AdvanceThenFillInput,
): (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAdvanceOutcome> {
  const now = input.now ?? (() => Date.now());
  const reserveMs = input.reserveMs ?? NEXT_PAGE_RESERVE_MS;
  return (event, shadowRoot) => {
    // 当场取：`composedPath()` 派发一结束就空了，await 之后再取必然判否。
    const proof = captureTrustedShadowGesture(event, shadowRoot, now());
    return input.advance(event, shadowRoot).then((outcome): DockAdvanceOutcome => {
      if (outcome !== 'ADVANCED' || proof === null) return outcome;
      if (gestureRootRemainingMs(proof, now()) < reserveMs) return 'ADVANCED';
      input.fillNextPage(proof);
      return 'ADVANCED_FILLING';
    });
  };
}

/** 新一页还没渲染出来时，扫描会停在这几种上——再等等，不是这一页没有表。 */
const NOT_READY_STOPS: ReadonlySet<string> = new Set([
  'ROOT_NOT_FOUND',
  'NO_KEYED_FIELD',
  'RULES_MATCHED_NOTHING',
  'NO_FORM_FOUND',
]);

interface ScanAttempt {
  readonly scan: Readonly<{ descriptor: Readonly<{ fields: readonly unknown[] }> }> | null;
  readonly stop?: string;
}

export interface ScanWhenReadyInput<T extends ScanAttempt> {
  readonly scanOnce: () => Promise<T>;
  /** 最多等多久。 */
  readonly budgetMs: number;
  /** 没扫到时隔多久再扫。 */
  readonly pollMs?: number;
  /** 扫到之后再等多久复扫一次，字段数不变才算这一页渲染完了。 */
  readonly settleMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * 另外几种「还没出来」的停因（2026-10-04，D8）：替他点开 BambooHR 的「Apply for This Job」之后，表单要渲染一下才出来，
   * 那之前扫描照旧停在 APPLY_FORM_NOT_OPENED（按钮还在、锚点还没有）。缺省 = 没有。
   */
  readonly alsoNotReady?: ReadonlySet<string>;
}

/**
 * 翻页之后，等新的一页真的出来了再扫。
 *
 * 宿主换步是一串渲染：先是步骤容器，再是一批批字段。扫早了要么扫不到（停在上面那几种上，
 * 或者这一代 DOM 封不住），要么只扫到前半张表——那样填完的审计会把后半张表说成不存在。
 * 所以：扫不到就隔一会儿再扫；扫到了再等一会儿复扫，字段数不变才用它。预算用完就把最后
 * 一次的结果交出去，由调用方照实说。每一次扫描都是新的一代根，早扫不会把这一页扫坏。
 */
export async function scanWhenReady<T extends ScanAttempt>(input: ScanWhenReadyInput<T>): Promise<T> {
  const now = input.now ?? (() => Date.now());
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, ms); }));
  const pollMs = input.pollMs ?? 400;
  const settleMs = input.settleMs ?? 600;
  const deadline = now() + input.budgetMs;
  let outcome = await input.scanOnce();
  for (;;) {
    if (outcome.scan === null) {
      const stop = outcome.stop ?? '';
      const retry = NOT_READY_STOPS.has(stop) || stop.startsWith('NOT_SEALABLE') || input.alsoNotReady?.has(stop) === true;
      if (!retry || now() + pollMs > deadline) return outcome;
      await wait(pollMs);
      outcome = await input.scanOnce();
      continue;
    }
    if (now() + settleMs > deadline) return outcome;
    await wait(settleMs);
    const again = await input.scanOnce();
    if (again.scan === null) {
      outcome = again;
      continue;
    }
    // 两次扫出来一样多：这一页渲染完了。用后一次——它离写入更近。
    if (again.scan.descriptor.fields.length === outcome.scan.descriptor.fields.length) return again;
    outcome = again;
  }
}
