import type { ConsentGateReading } from '@edaix/apply-kernel/contracts';
import { consentGateResidenceIndex } from '@edaix/apply-kernel/dict/consentGate';

/**
 * 替他过数据同意页（2026-10-04，负责人 D7）。
 *
 * Jobvite 8 页里 4 页先到「Data Consent」：申请表之前先在「Location of Residence and Language」里选一项，每一项是一份隐私
 * 条款。选中之后网站去取那一份：默认的那一份它当场自己提交、整页跳到申请表；别的把条款摆出来，下面一颗「Accept」。
 * 负责人决定：在代填授权之下（资料页单独同意过当前版本 ∧ 运行时包放行 `sign-on-behalf`）可以替他选——选他资料里的居住国
 * 那一项（内核 `consentGateResidenceIndex`），写入走内核（`chooseConsentGateResidence`：一次真实点击铸的专用票、每次重读能力位）。
 * 网站把条款摆出来、要人点「Accept」的那几份，这一版交还本人：插件不按任何提交控件（RULE-EXT-NEVER-SUBMIT）。
 *
 * 结局：
 *  · `NAVIGATING` —— 选完网站整页跳走了（默认的那一份）：新一页的浮层照实说「已替你过了数据同意页」；
 *  · `ACCEPT_BY_USER` —— 选完网站把条款与「Accept」摆出来了：请他看完点同意；
 *  · `NOT_ALLOWED` —— 没有代填授权（或他按了停止）：照旧请他自己过这一页；
 *  · `NO_CHOICE` —— 读不到下拉、或说不准他该选哪一项（列表里没有他的国家、几种语言挑不出英文那一份……）：交还本人；
 *  · `FAILED` —— 写不进去（能力位关了、页面换了、读回不对）：交还本人；
 *  · `STILL_HERE` —— 选上了，网站一直没有动静：交还本人。
 */
export type ConsentGatePassOutcome = 'NAVIGATING' | 'ACCEPT_BY_USER' | 'NOT_ALLOWED' | 'NO_CHOICE' | 'FAILED' | 'STILL_HERE';

export interface ConsentGatePassInput {
  /** 代填授权此刻成立：运行时包放行 `sign-on-behalf` ∧ worker 读到他同意着当前版本。 */
  readonly allowed: () => boolean;
  /** 内核交出的同意页（`readRuntimeConsentGate`）。 */
  readonly read: () => ConsentGateReading | null;
  /** 他资料里的居住国（`addressCountry`）；没有就是 null。 */
  readonly residence: string | null;
  /** 写那一项（内核 `chooseConsentGateResidence`，绑好点击凭证与此刻的策略）；写成了才是 true。 */
  readonly choose: (reading: ConsentGateReading, index: number) => boolean;
  /** 这一页正在离开（pagehide／beforeunload 已经来了）。 */
  readonly leaving: () => boolean;
  /** 生产的可见性。 */
  readonly isVisible: (element: Element) => boolean;
  /** 选上了（还没等到结局）：调用方告诉 worker，好让下一页的浮层照实说一句。 */
  readonly onChosen?: () => void;
  readonly signal: AbortSignal;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** 选完最多等多久（网站取那一份条款、再提交，实测一两秒）。 */
  readonly budgetMs?: number;
  readonly pollMs?: number;
}

const DEFAULT_BUDGET_MS = 8_000;
const DEFAULT_POLL_MS = 200;

export async function passConsentGate(input: ConsentGatePassInput): Promise<ConsentGatePassOutcome> {
  if (input.signal.aborted) return 'NOT_ALLOWED';
  try {
    if (!input.allowed()) return 'NOT_ALLOWED';
  } catch {
    return 'NOT_ALLOWED';
  }
  let reading: ConsentGateReading | null;
  try {
    reading = input.read();
  } catch {
    reading = null;
  }
  const residence = reading?.residence ?? null;
  if (reading === null || residence === null) return 'NO_CHOICE';
  // 占位那一项（value 为空）与停用的不算选项：交进去是空字，内核不会选它们。
  const options = Array.from(residence.options).map((option, index) => ({
    index,
    text: option.value === '' || option.disabled ? '' : option.text,
  }));
  const index = consentGateResidenceIndex(options, input.residence);
  if (index === null) return 'NO_CHOICE';
  if (residence.selectedIndex !== index) {
    let written = false;
    try {
      written = input.choose(reading, index);
    } catch {
      written = false;
    }
    if (!written) return 'FAILED';
  }
  input.onChosen?.();
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = input.now ?? (() => Date.now());
  const deadline = now() + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const termsShown = (): boolean => {
    try {
      return reading.submitControls().some((control) => input.isVisible(control));
    } catch {
      return false;
    }
  };
  for (;;) {
    if (input.leaving()) return 'NAVIGATING';
    if (termsShown()) return 'ACCEPT_BY_USER';
    if (input.signal.aborted || now() >= deadline) return 'STILL_HERE';
    await wait(input.pollMs ?? DEFAULT_POLL_MS);
  }
}
