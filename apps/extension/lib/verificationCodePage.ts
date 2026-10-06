import type { EmailCodePrompt, EmailVerificationMail } from '@edaix/apply-kernel/contracts';
import { normalizeEmailCode, writeEmailCode } from '@edaix/apply-kernel/emailCode';
import { resolveAuthorizedApplyGate } from '@edaix/apply-kernel/gate';
import { captureTrustedShadowGesture, consumeAuthority, mintAuthorityFromGesture, releaseAuthority } from '@edaix/apply-kernel/grant';
import { isApplyPolicyEnabled } from '@edaix/apply-kernel/policy';
import { declaresEmailCodePrompts, emailVerificationMailOf, probeEmailCodePrompt } from '@edaix/apply-kernel/registry';
import { readRuntimeEmailCodePrompt } from '@edaix/apply-kernel/runtimeRegistry';
import type { ApplyVendor } from '@edaix/apply-kernel/vendors';

import type { AutofillDockHandle, DockCodeHandlers, DockCodeOutcome, DockCodePrompt } from './autofillDock';
import type { ResolvedContentDiscoveryRuntimeAuthority } from './executionRuntimeAuthority';
import type { SubmitCodeMark } from './submitController';

/**
 * 网站把验证码发到申请人的邮箱、要他填进这一页（2026-10-04，负责人：验证码第 1 步）。内容脚本每挂一张手势路的脸建一套
 * （只在 showFace 里建：Assistant 构建里整段是死代码），三件事：
 *
 *  1. 看着这一页：规则声明的验证码提示出现了、网站说验证码不对或过期了、那一块不见了，浮层那张卡跟着换（只读探测，
 *     每秒一次，只在这一家的规则声明了验证码提示时）；
 *  2. 他在卡上那一格里输或粘贴、按「填进网站」：那一下点击当场取证，用这一页的只读授权与写策略（与填写同一条路）再认
 *     一次那几格，写进去（内核 `write/emailCode.ts`）。写完不提交——下一步照旧由他按（RULE-EXT-NEVER-SUBMIT）；
 *  3. 给提交控制器一个记号：按了提交之后网站要的是验证码（或说验证码不对），就别再等「提交成功」了。
 *
 * 插件不读邮件、不从任何别处取码：写进网站的只有他在我方浮层里输的那一串（RULE-GLOBAL-HUMAN-AUTHORIZATION）。验证码、
 * 收件邮箱都不出这一页：不进 worker、后端、日志与诊断（RULE-GLOBAL-DATA-L1）。
 */

export interface VerificationCodePageDeps {
  readonly doc: Document;
  /** 此刻的地址（单页应用会改）。 */
  readonly here: () => Readonly<{ hostname: string; pathname: string }>;
  /** 主机表认出的厂商（没认出就是 null：这一套什么都不做）。 */
  readonly vendor: ApplyVendor | null;
  readonly isTopFrame: boolean;
  readonly isVisible: (element: Element) => boolean;
  /** 这一页的只读运行时授权（与填写同一条路：worker 的 DISCOVERY 授权、本机已存的运行时包）；读不到是 null。 */
  readonly discovery: () => Promise<ResolvedContentDiscoveryRuntimeAuthority | null>;
  readonly dock: () => AutofillDockHandle | null;
  /** 浮层上怎么称呼这一家（「Discord 的 Greenhouse」）。 */
  readonly site: () => string;
  readonly setInterval?: (run: () => void, ms: number) => unknown;
  readonly clearInterval?: (id: unknown) => void;
}

export interface VerificationCodePage {
  readonly handlers: DockCodeHandlers;
  /** 此刻网站在不在要验证码（提交控制器在按之前、按之后问）。没有是 null。 */
  mark(): SubmitCodeMark | null;
  /** 马上看一次（提交控制器说网站要验证码之后：卡要立刻换上）。 */
  refresh(): void;
  /** 开始看着这一页（浮层挂上之后）。 */
  start(): void;
  /** 浮层拆了、换脸了：不再看。 */
  dispose(): void;
}

/** 看这一页的间隔：验证码提示是单页应用里冒出来的，没有别的信号可等。 */
export const CODE_PROMPT_WATCH_MS = 1_000;

function dockPromptOf(prompt: EmailCodePrompt, mail: EmailVerificationMail | null, site: string): DockCodePrompt {
  const error = prompt.error;
  return {
    site,
    recipient: prompt.recipient,
    mail: { from: mail?.from ?? [], subject: mail?.subject ?? null },
    length: prompt.length,
    charset: prompt.charset === 'digits' ? 'DIGITS' : 'ALPHANUMERIC',
    next: prompt.next === 'verify' ? 'VERIFY' : 'RESUBMIT',
    error: error === null ? null
      : error.kind === 'wrong' ? 'WRONG'
      : error.kind === 'expired' ? 'EXPIRED'
      : error.kind === 'tooMany' ? 'TOO_MANY'
      : 'OTHER',
    siteSays: error?.text ?? null,
    filled: prompt.filled,
  };
}

export function createVerificationCodePage(deps: VerificationCodePageDeps): VerificationCodePage {
  const { vendor } = deps;
  const every = deps.setInterval ?? ((run: () => void, ms: number) => globalThis.setInterval(run, ms));
  const stopEvery = deps.clearInterval ?? ((id: unknown) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));

  const probe = (): EmailCodePrompt | null => {
    if (vendor === null || !declaresEmailCodePrompts(vendor)) return null;
    try {
      return probeEmailCodePrompt(vendor, deps.doc, deps.isVisible);
    } catch {
      return null;
    }
  };

  let shown = '';
  const watch = (): void => {
    const dock = deps.dock();
    if (dock === null) return;
    const prompt = probe();
    const next = prompt === null || vendor === null ? null : dockPromptOf(prompt, emailVerificationMailOf(vendor), deps.site());
    const key = next === null ? '' : JSON.stringify(next);
    if (key === shown) return;
    shown = key;
    dock.codePrompt(next);
  };

  const enter = (code: string, event: MouseEvent, shadowRoot: ShadowRoot): Promise<DockCodeOutcome> => {
    // 当场取证：`composedPath()` 派发一结束就空了。
    const proof = captureTrustedShadowGesture(event, shadowRoot);
    if (proof === null) return Promise.resolve('UNTRUSTED');
    if (vendor === null) return Promise.resolve('OFF');
    return (async (): Promise<DockCodeOutcome> => {
      const runtime = await deps.discovery().catch(() => null);
      if (runtime === null || runtime.mapping.vendor !== vendor) return 'OFF';
      const policy = runtime.fillPolicy;
      // 与填写同一套闸：远程写策略整体开着、这一家开着、文本这一位开着（读不到就当关，RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。
      if (!isApplyPolicyEnabled(policy, vendor) || policy.capabilities['set-text'] !== true) return 'OFF';
      const here = deps.here();
      const gate = resolveAuthorizedApplyGate({
        doc: deps.doc,
        hostname: here.hostname,
        pathname: here.pathname,
        policy: runtime.hostPolicy,
        vendor,
        isTopFrame: deps.isTopFrame,
      });
      if (!gate.attach) return 'OFF';
      const prompt = readRuntimeEmailCodePrompt(runtime.mapping, deps.doc, deps.isVisible);
      if (prompt === null) return 'GONE';
      if (normalizeEmailCode(code, prompt.length, prompt.charset) === null) return 'FORMAT';
      const minted = mintAuthorityFromGesture({ proof, purpose: 'fill', fingerprint: null, capabilities: new Set(['set-text']) });
      if (!minted.ok) return 'UNTRUSTED';
      const consumed = consumeAuthority(minted.value);
      if (!consumed.ok) return 'UNTRUSTED';
      try {
        const written = writeEmailCode({ prompt, code, authority: consumed.value, policy });
        if (written.ok) return 'FILLED';
        switch (written.code) {
          case 'CODE_FORMAT': return 'FORMAT';
          case 'PROMPT_GONE': return 'GONE';
          case 'POLICY_DISABLED':
          case 'CAPABILITY_DISABLED': return 'OFF';
          case 'GESTURE_UNTRUSTED':
          case 'GESTURE_EXPIRED': return 'UNTRUSTED';
          default: return 'FAILED';
        }
      } finally {
        releaseAuthority(consumed.value);
        // 网站多半马上换了样子（8 格满了、按钮可以按了）：卡跟着换。
        watch();
      }
    })();
  };

  let timer: unknown = null;
  return Object.freeze({
    handlers: { enter },
    mark: (): SubmitCodeMark | null => {
      const prompt = probe();
      if (prompt === null) return null;
      return { filled: prompt.filled, error: prompt.error === null ? null : { node: prompt.error.node, text: prompt.error.text } };
    },
    refresh: watch,
    start: () => {
      // 规则是异步装上的：这里只看认不认得这一家，声明没声明验证码提示每一次现看。
      if (timer !== null || vendor === null) return;
      watch();
      timer = every(watch, CODE_PROMPT_WATCH_MS);
    },
    dispose: () => {
      if (timer !== null) stopEvery(timer);
      timer = null;
      shown = '';
    },
  });
}
