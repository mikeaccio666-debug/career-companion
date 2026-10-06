import { resolveAuthorizedAccountGate } from '@edaix/apply-kernel/gate';
import { captureTrustedShadowGesture, type GestureRoot, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { declaresAccountSteps, probeAccountWall } from '@edaix/apply-kernel/registry';
import { readRuntimeAccountOutcome, readRuntimeAccountWall, readRuntimeEmailVerificationMail } from '@edaix/apply-kernel/runtimeRegistry';
import type { ScanRootOptions } from '@edaix/apply-kernel/contracts';
import type { ApplyVendor } from '@edaix/apply-kernel/vendors';
import { detectHumanCheckpoint } from '@edaix/apply-kernel/wizardAdvance';

import { createAccountAccessController, type AccountRunResult } from './accountAccessController';
import {
  createDockAccountAccessIntent,
  parseDockAccountAccessReply,
  type DockAccountAccessPayload,
  type DockAccountAccessReply,
} from './accountAccessIntent';
import { sharedPasswordProblem } from './accountPassword';
import type { AutofillDockHandle, DockAccountHandlers, DockAccountSettings } from './autofillDock';
import { withDocumentPath } from './documentPath';
import type { ResolvedContentDiscoveryRuntimeAuthority } from './executionRuntimeAuthority';
import type { FillToReview } from './fillToReview';

/**
 * 申请页上的招聘网站账号（2026-09-28，负责人：替用户在 Workday／iCIMS 上注册、登录）。内容脚本每挂一张手势路的脸建一套
 * （只在 showFace 里建：Assistant 构建里整段是死代码），三件事：
 *
 *  1. 看着这一页：规则声明的账号墙出现了，问 worker 能不能替他注册、登录（两把钥匙）、这一家有没有他的账号，浮层主按钮
 *     据此写成「注册并自动填写」或「登录并自动填写」。只读探测，每秒一次，只在这一家的规则声明了账号墙时；两把钥匙缺一把，
 *     主按钮照旧是「自动填写」；
 *  2. 他按了主按钮（或卡上的「用这个密码登录」「我已验证，继续」）：账号墙上一步一步走（accountAccessController.ts），
 *     过去了就用那一轮发给下一页的凭证接着填（连填开着就一页一页填到检查页）；
 *  3. 账户菜单「招聘网站账号」：读、看、复制、改，都问 worker——保险箱只在那边；这里只在按下之后拿一次邮箱与密码，
 *     写进规则声明的那几格就不再留，也不发往 worker 之外的任何地方。
 */

export interface AccountAccessPageDeps {
  readonly doc: Document;
  /** 此刻的地址（单页应用会改）。 */
  readonly here: () => Readonly<{ origin: string; pathname: string; hostname: string }>;
  /** 主机表认出的厂商（没认出就是 null：这一套什么都不做）。 */
  readonly vendor: ApplyVendor | null;
  readonly isTopFrame: boolean;
  readonly isVisible: (element: Element) => boolean;
  readonly openShadowRoot: NonNullable<ScanRootOptions['openShadowRoot']>;
  /** 发给自己的 worker（`runtime.sendMessage`）。 */
  readonly send: (message: unknown) => Promise<unknown>;
  /** 这一页的只读运行时授权（与填写同一条路：worker 的 DISCOVERY 授权、本机已存的运行时包）；读不到是 null。 */
  readonly discovery: () => Promise<ResolvedContentDiscoveryRuntimeAuthority | null>;
  readonly dock: () => AutofillDockHandle | null;
  readonly chain: () => FillToReview;
  /** 填这一页（runGestureFill）；`AFTER_ADVANCE` = 账号墙过去之后那一页。 */
  readonly fillPage: (root: GestureRoot, mode?: 'AFTER_ADVANCE') => Promise<void>;
  /** 新的一轮：作废上一轮的「停止」，交回这一轮的（与手势填写同一颗）。 */
  readonly restart: () => AbortController;
  /** 浮层上怎么称呼这一家（「NVIDIA 的 Workday」）。 */
  readonly site: () => string;
  /** 他回到这一页（标签页重新获得焦点）；交回取消登记的函数。 */
  readonly onReturn: (listener: () => void) => () => void;
  readonly setInterval?: (run: () => void, ms: number) => unknown;
  readonly clearInterval?: (id: unknown) => void;
}

export interface AccountAccessPage {
  /** 浮层上「招聘网站账号」那一块与账号墙上那两种输入。 */
  readonly handlers: DockAccountHandlers;
  /** 这一页此刻有规则声明的账号墙：主按钮那一下交给账号墙那一路。 */
  wallOnPage(): boolean;
  /** 用这一下点击在账号墙上走；墙已经不在了就照旧填这一页。 */
  run(proof: TrustedGestureProof): Promise<void>;
  /** 开始看着这一页（浮层挂上之后）。 */
  start(): void;
  /** 浮层拆了、换脸了：不再看、不再等他回来。 */
  dispose(): void;
}

/** 看这一页的间隔：账号墙是单页应用里点出来的，没有别的信号可等。 */
export const ACCOUNT_WALL_WATCH_MS = 1_000;

export function createAccountAccessPage(deps: AccountAccessPageDeps): AccountAccessPage {
  const { vendor } = deps;
  const scanOptions: ScanRootOptions = { openShadowRoot: deps.openShadowRoot };
  const every = deps.setInterval ?? ((run: () => void, ms: number) => globalThis.setInterval(run, ms));
  const stopEvery = deps.clearInterval ?? ((id: unknown) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));

  const ask = async (payload: DockAccountAccessPayload): Promise<DockAccountAccessReply | null> => {
    const here = deps.here();
    const intent = withDocumentPath(createDockAccountAccessIntent(here.origin, here.pathname, payload), deps.doc);
    if (intent === null) return null;
    try {
      return parseDockAccountAccessReply(await deps.send(intent));
    } catch {
      return null;
    }
  };

  const wallHere = () => {
    if (vendor === null) return null;
    try {
      return probeAccountWall(vendor, deps.doc, scanOptions);
    } catch {
      return null;
    }
  };

  const controller = createAccountAccessController({
    isVisible: deps.isVisible,
    // 与填写同一张只读授权；再过一遍与填写相同的否决（远程否决名单、帧让位、挑战页），只有「页面上有密码框」在这里不算拒绝。
    resolve: async () => {
      const runtime = await deps.discovery();
      if (runtime === null) return null;
      const here = deps.here();
      const gate = resolveAuthorizedAccountGate({
        doc: deps.doc,
        hostname: here.hostname,
        pathname: here.pathname,
        policy: runtime.hostPolicy,
        vendor: runtime.mapping.vendor,
        isTopFrame: deps.isTopFrame,
      });
      if (!gate.attach) return null;
      return {
        policy: runtime.fillPolicy,
        vendor: runtime.mapping.vendor,
        wall: () => readRuntimeAccountWall(runtime.mapping, deps.doc, scanOptions),
        outcome: () => readRuntimeAccountOutcome(runtime.mapping, deps.doc, deps.isVisible),
        // 这一家的验证邮件从哪儿来（2026-10-04，规则的 emailVerification.mail）：卡上一并说，好在收件箱里找。
        mail: () => {
          const mail = readRuntimeEmailVerificationMail(runtime.mapping);
          return mail === null ? null : { from: mail.from, subject: mail.subject };
        },
      };
    },
    ask,
    // 密码框就是账号墙本身：只看验证码与人机验证。
    checkpoint: () => detectHumanCheckpoint({ document: deps.doc, isVisible: deps.isVisible, ignoreLogin: true }),
    chain: deps.chain,
    page: () => {
      const here = deps.here();
      return { origin: here.origin, pathname: here.pathname };
    },
    dock: () => {
      const dock = deps.dock();
      return dock === null ? null : {
        status: (status) => dock.accountStatus(status),
        prompt: (prompt) => dock.accountPrompt(prompt),
        note: (note) => dock.accountStatus(note),
        continuing: () => dock.accountContinuing(),
      };
    },
    continueFill: (root) => { void deps.fillPage(root, 'AFTER_ADVANCE'); },
    site: deps.site,
    onReturn: deps.onReturn,
  });

  const run = async (proof: TrustedGestureProof): Promise<void> => {
    const stopper = deps.restart();
    const result: AccountRunResult = await controller.run(proof, stopper.signal);
    if (result === 'NO_WALL' && !stopper.signal.aborted) await deps.fillPage(proof);
  };

  /** 按下之后当场取证（派发一结束 composedPath 就空了）。 */
  const proofOf = (event: MouseEvent, shadowRoot: ShadowRoot): TrustedGestureProof | null => {
    const proof = captureTrustedShadowGesture(event, shadowRoot);
    if (proof === null) deps.dock()?.reportBlocked('GESTURE_UNTRUSTED');
    return proof;
  };

  const settingsOf = (reply: DockAccountAccessReply | null): DockAccountSettings | null =>
    reply?.kind === 'ACCOUNT_SETTINGS'
      ? { email: reply.email, defaultEmail: reply.defaultEmail, hasPassword: reply.hasPassword, sites: reply.sites }
      : null;

  const handlers: DockAccountHandlers = {
    onSitePassword: (password, event, shadowRoot) => {
      const proof = proofOf(event, shadowRoot);
      if (proof === null) return;
      void ask({ step: 'SITE_PASSWORD', password }).then((saved) => {
        if (saved?.kind === 'ACCOUNT_SAVED') return run(proof);
        deps.dock()?.accountPrompt({ kind: 'UNAVAILABLE', site: deps.site() });
        return undefined;
      });
    },
    onResume: (event, shadowRoot) => {
      const proof = proofOf(event, shadowRoot);
      if (proof !== null) void run(proof);
    },
    load: async () => settingsOf(await ask({ step: 'SETTINGS_GET' })),
    reveal: async () => {
      const reply = await ask({ step: 'REVEAL' });
      return reply?.kind === 'ACCOUNT_PASSWORD' ? reply.password : null;
    },
    setEmail: async (email) => {
      const here = deps.here();
      if (email !== null && createDockAccountAccessIntent(here.origin, here.pathname, { step: 'SETTINGS_SET_EMAIL', email }) === null) {
        return 'INVALID';
      }
      return settingsOf(await ask({ step: 'SETTINGS_SET_EMAIL', email }));
    },
    setPassword: async (password) => {
      if (sharedPasswordProblem(password) !== null) return 'WEAK';
      const reply = await ask({ step: 'SETTINGS_SET_PASSWORD', password });
      return reply?.kind === 'REFUSED' && reply.code === 'WEAK_PASSWORD' ? 'WEAK' : settingsOf(reply);
    },
  };

  // 看着这一页：账号墙出现、换了一步、不见了，主按钮跟着换。
  let seen = '';
  const watch = (): void => {
    const dock = deps.dock();
    if (dock === null || vendor === null || !declaresAccountSteps(vendor)) return;
    const wall = wallHere();
    const key = wall?.kind ?? '';
    if (key === seen) return;
    seen = key;
    if (wall === null) {
      dock.setAccountWall(null);
      return;
    }
    void ask({ step: 'STATUS' }).then((status) => {
      if (seen !== key || deps.dock() !== dock) return;
      if (status?.kind !== 'ACCOUNT_STATUS' || !status.enabled || !status.consent) {
        dock.setAccountWall(null);
        return;
      }
      const register = key === 'createAccount' || (key !== 'signIn' && !status.known);
      dock.setAccountWall({ action: register ? 'REGISTER' : 'SIGN_IN', site: deps.site() });
    });
  };

  let timer: unknown = null;
  return Object.freeze({
    handlers,
    wallOnPage: () => wallHere() !== null,
    run,
    start: () => {
      // 规则是异步装上的：这里只看认不认得这一家，声明没声明账号墙每一次现看。
      if (timer !== null || vendor === null) return;
      watch();
      timer = every(watch, ACCOUNT_WALL_WATCH_MS);
    },
    dispose: () => {
      if (timer !== null) stopEvery(timer);
      timer = null;
      controller.dispose();
    },
  });
}
