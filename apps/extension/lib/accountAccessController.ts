import { fillAccountFields, pressAccountControl, tickAccountTerms, type AccountActionError } from '@edaix/apply-kernel/accountAccess';
import type { AccountOutcomeReading, AccountStepKind, AccountWallStep, ApplyVendor } from '@edaix/apply-kernel/contracts';
import { ADVANCE_RUN_STEP_RESERVE_MS, type AdvanceRunPageProof, type AdvanceRunStep, type GestureRoot, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { isApplyPolicyEnabled, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import type { HumanCheckpoint } from '@edaix/apply-kernel/wizardAdvance';

import type { DockAccountAccessPayload, DockAccountAccessReply, VaultCredentialSource } from './accountAccessIntent';
import type { DockAccountPrompt, DockAccountStatus, DockMailHint } from './dock/types';
import type { ChainPage, FillToReview } from './fillToReview';

/**
 * 替用户在招聘网站上注册、登录，然后接着填（2026-09-28，负责人：像 Jobright 那样过 Workday／iCIMS 的账号墙）。
 *
 * 用户按下「注册并自动填写」「登录并自动填写」那一下是信任根：那一下点击开一轮（fillToReview 的 `openAccountRun`，与连填
 * 同一个内核口子，不另造授权），账号墙算这一轮的第一页。之后：
 *
 *  1. 「选怎么登录」就按「用邮箱登录」；该注册却停在登录（或反过来）就按规则声明的切换钮；
 *  2. 写邮箱、密码（注册页再写一遍），勾规则声明的注册条款，按规则声明的提交——每一下都经内核（accountAccess.ts），
 *     各自一张 `account-access` 票；
 *  3. 等网站说话：账号墙不见了 = 过去了，接着填申请表（这一轮发给下一页的凭证，`runGestureFill` 认得它，`advance-steps`
 *     开着就一页一页填到检查页）；账号已存在 → 停下请本人提供这一家的密码；密码不对 → 请他在浮层里输这一家的密码；要验证邮箱 →
 *     记为待验证并交给本人，回来后须重新可信点击，不复用未确认的随机密码登录；人机验证、验证码 → 他本人
 *     完成，完成之后网站自己往下走，我们接着填；
 *  4. 每一件替他做的事都在浮层上照实说（「已替你在 NVIDIA 的 Workday 注册账号」……）。
 *
 * 两把钥匙：运行时包的 `account-access`（这里按这一轮解出的 fillPolicy 判一次，内核的每一下写、每一下按还会再判），加上他
 * 同意着点名这一类的那一版代填授权（worker 在交出密码之前判；拿不到密码就走不到写那一步）。密码只在这一轮的内存里，写进
 * 规则声明的那几格就不再留；不进任何发往 worker 之外的消息，也不进日志。
 */

export type AccountRunResult =
  /** 账号墙过去了，下一页已经在接着填。 */
  | 'CONTINUED'
  /** 这一页没有规则声明的账号墙：调用方照旧走填写。 */
  | 'NO_WALL'
  /** 停下了，浮层已经照实说了要他做什么（或他按了「停止」）。 */
  | 'STOPPED';

export interface AccountRuntime {
  /** 这一轮用的写策略（与填写同一条路解出来的 fillPolicy）。 */
  readonly policy: ApplyPolicy;
  readonly vendor: ApplyVendor;
  /** 此刻页面上规则声明的账号墙（运行时授权那一侧解析）；没有就是 null。 */
  readonly wall: () => AccountWallStep | null;
  /** 网站此刻在账号墙上说了什么。 */
  readonly outcome: () => AccountOutcomeReading;
  /** 这一家的验证邮件从哪儿来（规则的 `emailVerification.mail`，2026-10-04）；没写就是 null。 */
  readonly mail?: () => DockMailHint | null;
}

export interface AccountAccessDock {
  /** 进度卡上那一句（正在替你注册……）。 */
  readonly status: (status: DockAccountStatus) => void;
  /** 停下来要他做一件事（输这一家的密码、去邮箱验证……）；null 收起。 */
  readonly prompt: (prompt: DockAccountPrompt | null) => void;
  /** 替他做成了一件事：浮层上照实记一句（并轻提示一次）。 */
  readonly note: (note: DockAccountStatus) => void;
  /** 账号墙过去了、接着填：进度卡回到「准备中」。 */
  readonly continuing: () => void;
}

export interface AccountAccessControllerDeps {
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly isVisible: (element: Element) => boolean;
  /** 解出这一轮的运行时（授权、策略、账号墙读法）；读不到就是 null。 */
  readonly resolve: () => Promise<AccountRuntime | null>;
  /** 问 worker（保险箱、同意、开关都在那边）。 */
  readonly ask: (payload: DockAccountAccessPayload) => Promise<DockAccountAccessReply | null>;
  /** Captured when showing a prompt, never replaced by a fresh owner lookup on click. */
  readonly onPasswordPrompt?: (context: AccountPasswordPromptContext | null) => void;
  /** 页面上只能本人处理的关卡（内核 detectHumanCheckpoint）；抛了当没有。 */
  readonly checkpoint: () => HumanCheckpoint | null;
  readonly chain: () => FillToReview;
  /** 此刻的 origin 与 pathname。 */
  readonly page: () => Readonly<{ origin: string; pathname: string }>;
  readonly dock: () => AccountAccessDock | null;
  /** 账号墙过去了：用这一轮发给下一页的凭证接着填（runGestureFill 的 AFTER_ADVANCE）。 */
  readonly continueFill: (root: GestureRoot) => void;
  /** 浮层上怎么称呼这一家（「NVIDIA 的 Workday」）。 */
  readonly site: () => string;
  /** 他回到这一页（标签页重新获得焦点）时叫一次；交回取消登记的函数。 */
  readonly onReturn: (listener: () => void) => () => void;
}
export interface AccountPasswordPromptContext { readonly operationId: string; readonly authEpoch: number }

/** 按了提交之后最多等网站多久（Workday 的登录、注册实测一两秒；留足网络慢的余量）。 */
export const ACCOUNT_SUBMIT_SETTLE_MS = 20_000;
/** 账号墙不见了要连着不见多久才算过去了（网站换视图时会有一瞬间没有墙）。 */
const GONE_FOR_MS = 1_200;
/** 提交之前那一句横幅要再挂多久才算这一次的回答（网站可能不清掉上一次的提示）。 */
const STALE_BANNER_MS = 2_500;
/** 按一次切换钮（用邮箱登录、切到注册／登录）之后等新视图多久。 */
const VIEW_SWITCH_MS = 5_000;
/** 「Next」勾上条款之后多久变成可按（iCIMS）。 */
const ENABLE_MS = 3_000;
const POLL_MS = 250;

/** 能不能替他注册、登录：策略整体开着、这一家开着、`account-access` 开着、没过期。 */
export function accountAccessAllowed(policy: ApplyPolicy | null, vendor: ApplyVendor, now = Date.now()): boolean {
  return policy !== null && policy.capabilities['account-access'] === true && isApplyPolicyEnabled(policy, vendor, now);
}

type Verdict = 'GONE' | 'NEXT_STEP' | 'ACCOUNT_EXISTS' | 'WRONG_PASSWORD' | 'VERIFY_EMAIL' | 'BLOCKED' | 'REJECTED' | 'NO_RESPONSE' | 'STOPPED' | 'FAILED';

interface Run {
  readonly runtime: AccountRuntime;
  readonly email: string;
  password: string;
  source: VaultCredentialSource;
  readonly purpose: 'register' | 'login';
  readonly operationId: string;
  readonly authEpoch: number;
  readonly generation: number;
  readonly generated: boolean;
  page: ChainPage;
  proof: AdvanceRunPageProof;
  readonly signal: AbortSignal;
  /** 这一轮替他勾过注册条款。 */
  tickedTerms: boolean;
}
interface CredentialRetrySource extends AccountPasswordPromptContext {
  readonly sourceStatusOp: string;
  readonly sourceStatusEpoch: number;
  readonly known: boolean;
}

export interface AccountAccessController {
  /** 用户按下了「注册并自动填写」「登录并自动填写」（或账号墙那一页上的「自动填写」）。必须在点击派发当中取好凭证。 */
  run(proof: TrustedGestureProof, signal: AbortSignal, displayedStatus?: Extract<DockAccountAccessReply, { kind: 'ACCOUNT_STATUS' }>): Promise<AccountRunResult>;
  /** Invalidate this controller's generation and any displayed password prompt. */
  dispose(): void;
}

export function createAccountAccessController(deps: AccountAccessControllerDeps): AccountAccessController {
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, ms); }));
  let stopWaitingForReturn: () => void = () => {};
  let generation = 0;
  // No email or password is retained here. A new trusted run must still derive
  // a fresh worker operation from this exact prior credential and displayed UI.
  let retrySource: CredentialRetrySource | null = null;

  const dock = (): AccountAccessDock | null => deps.dock();
  const say = (status: DockAccountStatus): void => { dock()?.status(status); };
  const prompt = (value: DockAccountPrompt | null): void => { dock()?.prompt(value); };
  const bindPasswordPrompt = (context: AccountPasswordPromptContext | null): void => {
    deps.onPasswordPrompt?.(context === null ? null : Object.freeze({ operationId: context.operationId, authEpoch: context.authEpoch }));
  };

  const scopeOf = (vendor: ApplyVendor) => ({ ...deps.page(), vendor });

  /** 在 `budgetMs` 之内等 `test` 成立；成立就交回 true。 */
  const until = async (test: () => boolean, budgetMs: number, signal: AbortSignal): Promise<boolean> => {
    const deadline = now() + budgetMs;
    for (;;) {
      try {
        if (test()) return true;
      } catch {
        // 读页面出错当没成立，接着等。
      }
      if (signal.aborted || now() >= deadline) return false;
      await wait(POLL_MS);
    }
  };

  const checkpoint = (): HumanCheckpoint | null => {
    try {
      return deps.checkpoint();
    } catch {
      return null;
    }
  };

  /** 这一轮这一页的凭证还够不够接着动手（总时限没到、还剩够一页用的）。 */
  const runAlive = (run: Run): boolean => {
    if (run.signal.aborted || run.generation !== generation) return false;
    const state = deps.chain().accountRunState(run.page, scopeOf(run.runtime.vendor));
    return state.ok && state.value.remainingMs >= ADVANCE_RUN_STEP_RESERVE_MS;
  };

  /** Each worker check uses the exact operation returned with this credential. */
  const currentOperation = async (run: Run): Promise<boolean> => {
    if (!runAlive(run)) return false;
    const reply = await deps.ask({ step: 'CHECK', operationId: run.operationId, expectedEpoch: run.authEpoch }).catch(() => null);
    if (!runAlive(run)) return false;
    if (reply?.kind === 'ACCOUNT_CURRENT') return true;
    prompt(refusalPrompt(reply));
    return false;
  };

  const recordOutcome = async (run: Run, outcome: 'CREATED' | 'SIGNED_IN' | 'EXISTS' | 'VERIFICATION_REQUIRED'): Promise<boolean> => {
    if (!runAlive(run)) return false;
    const reply = await deps.ask({ step: 'RECORD', outcome, operationId: run.operationId, expectedEpoch: run.authEpoch }).catch(() => null);
    if (!runAlive(run)) return false;
    if (outcome === 'EXISTS' || outcome === 'VERIFICATION_REQUIRED') {
      if (reply?.kind === 'ACCOUNT_PASSWORD_PROMPT') { retrySource = null; bindPasswordPrompt(reply); return true; }
    } else if (reply?.kind === 'ACCOUNT_SAVED') { retrySource = null; return true; }
    prompt(refusalPrompt(reply));
    return false;
  };

  const derivePasswordPrompt = async (run: Run): Promise<boolean> => {
    if (!runAlive(run)) return false;
    const reply = await deps.ask({ step: 'PASSWORD_PROMPT', operationId: run.operationId, expectedEpoch: run.authEpoch }).catch(() => null);
    if (!runAlive(run)) return false;
    if (reply?.kind === 'ACCOUNT_PASSWORD_PROMPT') { retrySource = null; bindPasswordPrompt(reply); return true; }
    prompt(refusalPrompt(reply));
    return false;
  };

  /** 按一颗切换钮（用邮箱登录、切到注册、切到登录），等账号墙换成另一步。 */
  const switchView = async (run: Run, wall: AccountWallStep, role: 'useEmail' | 'toSignIn' | 'toCreateAccount'): Promise<boolean> => {
    if (!(await currentOperation(run))) return false;
    const pressed = pressAccountControl({ step: wall, role, proof: run.proof, policy: run.runtime.policy, isVisible: deps.isVisible, now: now() });
    if (!pressed.ok) return false;
    return until(() => {
      const next = run.runtime.wall();
      return next === null || next.kind !== wall.kind;
    }, VIEW_SWITCH_MS, run.signal);
  };

  /** 按了提交之后等网站说话。 */
  const awaitVerdict = async (run: Run, wall: AccountWallStep, before: AccountOutcomeReading, pressedAt: number): Promise<Verdict> => {
    let deadline = pressedAt + ACCOUNT_SUBMIT_SETTLE_MS;
    let goneSince: number | null = null;
    let waitingForPerson: HumanCheckpoint | null = null;
    while (now() < deadline) {
      if (run.signal.aborted) return 'STOPPED';
      await wait(POLL_MS);
      let current: AccountWallStep | null;
      try {
        current = run.runtime.wall();
      } catch {
        return 'FAILED';
      }
      if (current === null) {
        goneSince ??= now();
        if (now() - goneSince >= GONE_FOR_MS) return 'GONE';
        continue;
      }
      goneSince = null;
      let reading: AccountOutcomeReading = null;
      try {
        reading = run.runtime.outcome();
      } catch {
        reading = null;
      }
      if (reading !== null && (reading !== before || now() - pressedAt >= STALE_BANNER_MS)) {
        if (reading === 'accountExists') return 'ACCOUNT_EXISTS';
        if (reading === 'wrongPassword') return 'WRONG_PASSWORD';
        if (reading === 'verifyEmail') return 'VERIFY_EMAIL';
        if (reading === 'blocked') return 'BLOCKED';
        return 'REJECTED';
      }
      if (current.kind !== wall.kind) return 'NEXT_STEP';
      // 人机验证、一次性验证码：由他本人完成。说一声，接着等——他过了，网站自己往下走，我们接着填。
      const wall2 = checkpoint();
      if ((wall2 === 'CAPTCHA' || wall2 === 'VERIFICATION') && waitingForPerson === null) {
        waitingForPerson = wall2;
        prompt({ kind: wall2, site: deps.site() });
        const state = deps.chain().accountRunState(run.page, scopeOf(run.runtime.vendor));
        if (state.ok) deadline = Math.max(deadline, now() + Math.max(0, state.value.remainingMs - ADVANCE_RUN_STEP_RESERVE_MS));
      }
    }
    return waitingForPerson === null ? 'NO_RESPONSE' : 'STOPPED';
  };

  /** 提交之后账号墙不见了：那一步（`completeAccountStep` 要它）。 */
  let pendingStep: AdvanceRunStep | null = null;

  /** 写、勾、按提交、等结论。 */
  const submit = async (run: Run, wall: AccountWallStep): Promise<Verdict | 'EXPIRED' | 'TERMS_NEED_USER' | 'FAILED'> => {
    const site = deps.site();
    say(wall.kind === 'createAccount' ? { kind: 'REGISTERING', site } : wall.kind === 'signIn' ? { kind: 'SIGNING_IN', site } : { kind: 'IDENTIFYING', site });
    if (!(await currentOperation(run))) return 'STOPPED';
    const filled = fillAccountFields({ step: wall, proof: run.proof, policy: run.runtime.policy, email: run.email, password: run.password, now: now() });
    if (!filled.ok) return filled.code === 'IDENTITY_CHANGED' ? 'NEXT_STEP' : failureOf(filled.code);
    // 让网站把刚写的值收进它自己的状态（受控表单在下一次渲染里才算数）。
    await wait(300);
    if (!(await currentOperation(run))) return 'STOPPED';
    const terms = tickAccountTerms({ step: wall, proof: run.proof, policy: run.runtime.policy, isVisible: deps.isVisible, now: now() });
    if (!terms.ok) return terms.code === 'CLICK_DENIED' ? 'TERMS_NEED_USER' : terms.code === 'IDENTITY_CHANGED' ? 'NEXT_STEP' : failureOf(terms.code);
    if (terms.value === 'TICKED') run.tickedTerms = true;
    const submitControl = wall.controls.submit;
    // iCIMS 的「Next」勾上条款才放开。
    if (submitControl !== undefined) {
      await until(() => !(submitControl as HTMLButtonElement).disabled && submitControl.getAttribute('aria-disabled') !== 'true', ENABLE_MS, run.signal);
    }
    if (!(await currentOperation(run))) return 'STOPPED';
    const before = run.runtime.outcome();
    const step = deps.chain().beginAccountStep(run.page, scopeOf(run.runtime.vendor));
    if (step === null) return 'EXPIRED';
    const pressedAt = now();
    const pressed = pressAccountControl({ step: wall, role: 'submit', proof: run.proof, policy: run.runtime.policy, isVisible: deps.isVisible, now: pressedAt });
    if (!pressed.ok) {
      deps.chain().abandonAccountStep(step);
      return pressed.code === 'IDENTITY_CHANGED' ? 'NEXT_STEP' : failureOf(pressed.code);
    }
    const verdict = await awaitVerdict(run, wall, before, pressedAt);
    if (verdict === 'GONE') {
      pendingStep = step;
      return 'GONE';
    }
    deps.chain().abandonAccountStep(step);
    return verdict;
  };
  const failureOf = (code: AccountActionError): 'EXPIRED' | 'FAILED' =>
    code === 'GESTURE_EXPIRED' || code === 'GESTURE_UNTRUSTED' ? 'EXPIRED' : 'FAILED';

  /** 账号墙过去了：记下这一家有账号、照实说替他做了什么，用下一页的凭证接着填。 */
  const succeed = async (run: Run, kind: AccountStepKind | null): Promise<AccountRunResult> => {
    const site = deps.site();
    if (kind === 'createAccount' || kind === 'signIn') {
      if (!(await recordOutcome(run, kind === 'createAccount' ? 'CREATED' : 'SIGNED_IN'))) return 'STOPPED';
    } else if (!(await currentOperation(run))) return 'STOPPED';
    if (kind === 'createAccount') dock()?.note({ kind: 'REGISTERED', site, email: run.email, generated: run.generated });
    else if (kind === 'signIn') dock()?.note({ kind: 'SIGNED_IN', site, email: run.email });
    if (run.tickedTerms) dock()?.note({ kind: 'TERMS_ACCEPTED', site });
    bindPasswordPrompt(null);
    prompt(null);
    const chain = deps.chain();
    const step = pendingStep ?? chain.beginAccountStep(run.page, scopeOf(run.runtime.vendor));
    pendingStep = null;
    if (step === null) {
      prompt({ kind: 'CONTINUE_BY_HAND', site });
      return 'STOPPED';
    }
    // 网站随后换了地址（Workday 建草稿：…/applyManually → …/apply）也接得上：那一页扫出申请表时跟着换一次（fillToReview）。
    const next = chain.completeAccountStep(step, run.page);
    if (next === null) {
      prompt({ kind: 'CONTINUE_BY_HAND', site });
      return 'STOPPED';
    }
    dock()?.continuing();
    deps.continueFill(next);
    return 'CONTINUED';
  };

  /** 停下来，照实说要他做什么。 */
  const stopWith = (run: Run | null, reason: Exclude<Verdict, 'GONE' | 'NEXT_STEP'> | 'EXPIRED' | 'TERMS_NEED_USER' | 'FAILED'): AccountRunResult => {
    const site = deps.site();
    switch (reason) {
      case 'STOPPED':
        break;
      case 'WRONG_PASSWORD':
        prompt({ kind: 'SITE_PASSWORD', site, email: run?.email ?? '', retry: run?.source === 'USER_SAVED' || run?.source === 'LEGACY_SITE' });
        break;
      case 'VERIFY_EMAIL': {
        let mail: DockMailHint | null = null;
        try {
          mail = run?.runtime.mail?.() ?? null;
        } catch {
          mail = null;
        }
        prompt({ kind: 'VERIFY_EMAIL', site, email: run?.email ?? '', ...(mail === null ? {} : { mail }) });
        break;
      }
      case 'BLOCKED':
      case 'REJECTED':
      case 'NO_RESPONSE':
      case 'TERMS_NEED_USER':
      case 'EXPIRED':
      case 'FAILED':
        prompt({ kind: reason, site });
        break;
      case 'ACCOUNT_EXISTS':
        prompt({ kind: 'REJECTED', site });
        break;
    }
    return 'STOPPED';
  };

  /** 在账号墙上一步一步走，直到过去了或要他处理。 */
  const drive = async (run: Run, initialWant: 'signIn' | 'createAccount'): Promise<AccountRunResult> => {
    const want = initialWant;
    const switched = new Set<string>();
    let lastKind: AccountStepKind | null = null;
    for (let guard = 0; guard < 12; guard += 1) {
      if (run.signal.aborted) return stopWith(run, 'STOPPED');
      if (!runAlive(run)) return stopWith(run, 'EXPIRED');
      let wall: AccountWallStep | null = null;
      let scanFailed = false;
      // 网站换视图、刚渲染：等一会儿墙出来。一直没有就是已经过去了（他自己登录了，或上一下提交刚成）。
      await until(() => {
        try { return (wall = run.runtime.wall()) !== null; }
        catch { scanFailed = true; return true; }
      }, 1_500, run.signal);
      if (scanFailed) return stopWith(run, 'FAILED');
      if (wall === null) return succeed(run, lastKind);
      const current: AccountWallStep = wall;
      if (current.kind === 'choice') {
        say({ kind: 'CHOOSING', site: deps.site() });
        if (switched.has('useEmail') || !(await switchView(run, current, 'useEmail'))) return stopWith(run, 'FAILED');
        switched.add('useEmail');
        continue;
      }
      if (current.kind === 'signIn' && want === 'createAccount' && current.controls.toCreateAccount !== undefined && !switched.has('toCreateAccount')) {
        switched.add('toCreateAccount');
        if (!(await switchView(run, current, 'toCreateAccount'))) return stopWith(run, 'FAILED');
        continue;
      }
      if (current.kind === 'createAccount' && want === 'signIn' && current.controls.toSignIn !== undefined && !switched.has('toSignIn')) {
        switched.add('toSignIn');
        if (!(await switchView(run, current, 'toSignIn'))) return stopWith(run, 'FAILED');
        continue;
      }
      // A credential reserved for registration is not proof that login is valid.
      if ((current.kind === 'signIn' && run.purpose !== 'login') || (current.kind === 'createAccount' && run.purpose !== 'register')) {
        if (!(await derivePasswordPrompt(run))) return 'STOPPED';
        return stopWith(run, 'WRONG_PASSWORD');
      }
      lastKind = current.kind;
      const verdict = await submit(run, current);
      if (verdict === 'GONE') return succeed(run, current.kind);
      if (verdict === 'NEXT_STEP') continue;
      if (verdict === 'ACCOUNT_EXISTS' && current.kind === 'createAccount') {
        // The newly generated password is not the existing account's password.
        if (!(await recordOutcome(run, 'EXISTS'))) return 'STOPPED';
        dock()?.note({ kind: 'ACCOUNT_EXISTS', site: deps.site() });
        return stopWith(run, 'WRONG_PASSWORD');
      }
      if (verdict === 'VERIFY_EMAIL') {
        // Only the registration reservation can be marked pending verification.
        if (run.purpose === 'register' && !(await recordOutcome(run, 'VERIFICATION_REQUIRED'))) return 'STOPPED';
        if (run.purpose === 'login' && !(await derivePasswordPrompt(run))) return 'STOPPED';
        if (run.tickedTerms) dock()?.note({ kind: 'TERMS_ACCEPTED', site: deps.site() });
      }
      if (verdict === 'WRONG_PASSWORD' && !(await derivePasswordPrompt(run))) return 'STOPPED';
      return stopWith(run, verdict);
    }
    return stopWith(run, 'NO_RESPONSE');
  };

  const refusalPrompt = (reply: DockAccountAccessReply | null): DockAccountPrompt => {
    const site = deps.site();
    if (reply?.kind === 'REFUSED') {
      if (reply.code === 'CONSENT_REQUIRED') return { kind: 'CONSENT', site };
      if (reply.code === 'DISABLED') return { kind: 'OFF', site };
      if (reply.code === 'NO_EMAIL') return { kind: 'NO_EMAIL', site };
      if (reply.code === 'NO_PASSWORD' && reply.operationId !== undefined && reply.authEpoch !== undefined) {
        bindPasswordPrompt({ operationId: reply.operationId, authEpoch: reply.authEpoch });
        return { kind: 'SITE_PASSWORD', site, email: '', retry: false };
      }
    }
    return { kind: 'UNAVAILABLE', site };
  };

  return Object.freeze({
    async run(proof: TrustedGestureProof, signal: AbortSignal, displayedStatus?: Extract<DockAccountAccessReply, { kind: 'ACCOUNT_STATUS' }>): Promise<AccountRunResult> {
      const initialStatus = displayedStatus === undefined ? undefined : Object.freeze({ ...displayedStatus });
      const attempt = ++generation;
      bindPasswordPrompt(null);
      stopWaitingForReturn();
      stopWaitingForReturn = () => {};
      pendingStep = null;
      const runtime = await deps.resolve().catch(() => null);
      if (signal.aborted || attempt !== generation) return 'STOPPED';
      if (runtime === null) return 'NO_WALL';
      let wall: AccountWallStep | null = null;
      try {
        wall = runtime.wall();
      } catch {
        prompt({ kind: 'FAILED', site: deps.site() });
        return 'STOPPED';
      }
      if (wall === null) return 'NO_WALL';
      if (!accountAccessAllowed(runtime.policy, runtime.vendor, now())) {
        prompt({ kind: 'OFF', site: deps.site() });
        return 'STOPPED';
      }
      say({ kind: 'PREPARING', site: deps.site() });
      const status = initialStatus ?? await deps.ask({ step: 'STATUS' }).catch(() => null);
      if (signal.aborted || attempt !== generation) return 'STOPPED';
      if (status?.kind !== 'ACCOUNT_STATUS') { prompt(refusalPrompt(status)); return 'STOPPED'; }
      if (!status.enabled) { prompt({ kind: 'OFF', site: deps.site() }); return 'STOPPED'; }
      if (!status.consent) { prompt({ kind: 'CONSENT', site: deps.site() }); return 'STOPPED'; }
      const old = retrySource;
      const retry = old !== null && old.sourceStatusOp === status.operationId && old.sourceStatusEpoch === status.authEpoch ? old : null;
      retrySource = null;
      let source: AccountPasswordPromptContext = status;
      if (retry !== null) {
        const derived = await deps.ask({ step: 'PASSWORD_PROMPT', operationId: retry.operationId, expectedEpoch: retry.authEpoch }).catch(() => null);
        if (signal.aborted || attempt !== generation) return 'STOPPED';
        if (derived?.kind !== 'ACCOUNT_PASSWORD_PROMPT' || derived.authEpoch !== status.authEpoch) { prompt(refusalPrompt(derived)); return 'STOPPED'; }
        source = derived;
      }
      const purpose = wall.kind === 'signIn' ? 'login' : (retry?.known ?? status.known) ? 'login' : 'register';
      const credential = await deps.ask({ step: 'CREDENTIAL', purpose, operationId: source.operationId, expectedEpoch: source.authEpoch }).catch(() => null);
      if (signal.aborted || attempt !== generation) return 'STOPPED';
      if (credential?.kind !== 'ACCOUNT_CREDENTIAL') {
        prompt(refusalPrompt(credential));
        return 'STOPPED';
      }
      if (credential.authEpoch !== status.authEpoch) { prompt({ kind: 'UNAVAILABLE', site: deps.site() }); return 'STOPPED'; }
      if (purpose === 'login' && !credential.known) { prompt({ kind: 'UNAVAILABLE', site: deps.site() }); return 'STOPPED'; }
      retrySource = Object.freeze({ operationId: credential.operationId, authEpoch: credential.authEpoch, known: credential.known,
        sourceStatusOp: status.operationId, sourceStatusEpoch: status.authEpoch });
      const opened = deps.chain().openAccountRun({ root: proof, scope: scopeOf(runtime.vendor), vendor: runtime.vendor });
      if (opened === null) return stopWith(null, 'EXPIRED');
      const run: Run = {
        runtime,
        email: credential.email,
        password: credential.password,
        source: credential.source,
        purpose,
        operationId: credential.operationId,
        authEpoch: credential.authEpoch,
        generation: attempt,
        generated: credential.generated,
        page: opened.page,
        proof: opened.proof,
        signal,
        tickedTerms: false,
      };
      try { return await drive(run, purpose === 'login' ? 'signIn' : 'createAccount'); }
      finally { run.password = ''; }
    },
    dispose(): void {
      generation++;
      retrySource = null;
      bindPasswordPrompt(null);
      stopWaitingForReturn();
      stopWaitingForReturn = () => {};
    },
  });
}
