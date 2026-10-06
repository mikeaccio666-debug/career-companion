import type { AuditView } from '@edaix/apply-kernel/audit';
import type { ApplyVendor } from '@edaix/apply-kernel/contracts';
import {
  ADVANCE_RUN_STEP_RESERVE_MS,
  abandonAdvanceRunStep,
  advanceRunState,
  beginAdvanceRunStep,
  closeAdvanceRun,
  completeAccountRunStep,
  completeAdvanceRunStep,
  endAdvanceRun,
  isAdvanceRunPage,
  openAdvanceRun,
  rebindAfterAccount,
  type AdvanceRun,
  type AdvanceRunPageProof,
  type AdvanceRunResult,
  type AdvanceRunScope,
  type AdvanceRunStep,
  type GestureRoot,
  type TrustedGestureProof,
} from '@edaix/apply-kernel/grant';
import type { ApplyPolicy } from '@edaix/apply-kernel/policy';
import type { HumanCheckpoint, WizardProgress } from '@edaix/apply-kernel/wizardAdvance';

import type { AutofillDockHandle, DockAdvanceOutcome, DockChainState, DockChainStop } from './autofillDock';
import { chainAllowed, type NextControlState } from './wizardAdvanceController';

/**
 * 按一下「自动填写」，一页一页填到检查页（2026-09-28 负责人决定）。
 *
 * 从前（PR #69）多页申请每一页都要他按一下：填完这一页，浮层摆「继续到下一页」，按了才翻、才接着填下一页。现在按一下
 * 「自动填写」：填这一页 → 没有要他处理的，就替他按网站的下一步 → 填下一页 → …… 直到检查页，或规则声明的最终提交所在的
 * 那一页。在那里停下，浮层一句话说都填好了、检查一遍再按「提交」。**最终提交照旧只在他按下浮层里的「提交」之后**
 * （RULE-EXT-NEVER-SUBMIT）：这一轮连填从头到尾碰不到它。
 *
 * ## 授权从哪来（内核 grant.ts 的 `openAdvanceRun`）
 *
 * 那一下点击开出**一轮有边界的连填**：同一个页面、同一张申请、同一家（origin + pathname + 厂商）；只按内核认出的那一颗
 * 翻页按钮；总时限与页数上限。每翻一页，内核发一张「这一页」的凭证（不是点击：不造假的点击），上一页的随之作废；用户按
 * 「停止」、开了新的一轮、离开这一页，整轮作废。这里只是编排：什么时候开、每页填完往不往下翻、为什么停——授权的边界全在内核。
 *
 * ## 什么时候停（`decideAfterPage`）
 *
 * 他按了「停止」；网站弹出只能本人处理的关卡（登录、验证码、人机验证）；这一页还有必填要他处理——浮层单子里的，加上页面
 * 上还空着、浮层没认出的（2026-10-04：Jobvite 上浮层只看自己认得的行，替他按了「Next」，网站当场把没认出的四道必填标红）；
 * 网站此刻在这一页上标着错（`aria-invalid`、表里显示着的报错提示）；到了最后一页（最终提交在这一页上、或这一页没有翻页按钮）；翻页按钮说不清是哪一颗；连填的开关此刻关着；页数或时间到上限了；页面换了地方。
 * 按了网站没翻（校验没过）也停。停下时「继续到下一页」照旧在（他处理完按一下，那一下是新的一次点击，开新的一轮接着往下填）。
 * AI 答案、求职信还在写的时候不判：`closeGestureRun` 等它们有了结局才问这里。
 */

/** 这一页还有几项必填要他处理：与浮层「需要你」同一个口径（必填、没填成；网页上本来就有的不算）。 */
export function requiredNeedsIn(view: AuditView | null | undefined): number {
  if (view === null || view === undefined) return 0;
  return view.rows.filter((row) => row.required && row.status !== 'FILLED' && row.status !== 'PREFILLED').length;
}

export interface ChainPageFacts {
  /** 他按了「停止」。 */
  readonly stopped: boolean;
  /** 页面上只能本人处理的关卡；读页面时出错是 `UNREADABLE`（说不清就停）。 */
  readonly checkpoint: HumanCheckpoint | 'UNREADABLE' | null;
  /** 这一页还有几项必填要他处理：浮层单子里的，加上页面上还空着、浮层没认出的（`readPageGaps`）。 */
  readonly requiredNeeds: number;
  /**
   * 网站此刻在这一页上标着几处错：`aria-invalid="true"` 的栏、表里显示着的报错提示（`readPageGaps`）。
   * 不传按 0 算（旧调用方）。
   */
  readonly siteErrors?: number;
  /** 规则声明的最终提交就在这一页上。 */
  readonly finalSubmit: boolean;
  /** 这一页的翻页按钮：唯一一颗、没有、说不清（或控制器没 arm）。 */
  readonly next: NextControlState | 'UNARMED';
  /** 刚重读的写策略里，翻页与连填两位都开着、这一家开着。 */
  readonly chainOn: boolean;
  /** 这一轮此刻的样子（内核 `advanceRunState`）。 */
  readonly run: AdvanceRunResult<Readonly<{ page: number; maxPages: number; remainingMs: number }>>;
  /** 网站自己说的这一步（第几步、共几步）；说不出就不传。说还有下一步时，读不到翻页按钮也不算到了最后一页。 */
  readonly site?: WizardProgress | null;
}

export type ChainMove = Readonly<{ kind: 'ADVANCE' }> | Readonly<{ kind: 'STOP'; reason: DockChainStop }>;

/**
 * 一页填完、AI 与求职信都有了结局：往下翻，还是停下（为什么）。次序即优先级——先看他是不是按了停止、这一轮还在不在，
 * 再看要不要他本人出手（关卡、必填），再看是不是到头了，最后才是开关与上限。
 */
export function decideAfterPage(facts: ChainPageFacts): ChainMove {
  const stop = (reason: DockChainStop): ChainMove => Object.freeze({ kind: 'STOP', reason });
  if (facts.stopped) return stop('STOPPED');
  if (!facts.run.ok && facts.run.code === 'RUN_ENDED') return stop('STOPPED');
  if (!facts.run.ok && facts.run.code === 'RUN_SCOPE_CHANGED') return stop('MOVED');
  if (facts.checkpoint === 'UNREADABLE') return stop('UNAVAILABLE');
  if (facts.checkpoint !== null) return stop(facts.checkpoint);
  if (facts.requiredNeeds > 0) return stop('NEEDS_USER');
  // 网站自己标着错（填进去的格式不对、它的报错提示还挂着）：替他按「下一步」只会再被拦一次。
  if ((facts.siteErrors ?? 0) > 0) return stop('SITE_ERRORS');
  if (facts.finalSubmit) return stop('REVIEW');
  // 网站说还有下一步（第 2 步，共 5 步）却读不到翻页按钮：不是最后一页，是这一刻那一颗读不出来——不说「都填好了、去提交」。
  if (facts.next === 'NONE') return stop(siteSaysMoreSteps(facts.site ?? null) ? 'UNAVAILABLE' : 'REVIEW');
  if (facts.next !== 'ONE') return stop('UNAVAILABLE');
  if (!facts.chainOn) return stop('OFF');
  if (!facts.run.ok) return stop(facts.run.code === 'RUN_EXPIRED' ? 'TIME_CAP' : 'UNAVAILABLE');
  if (facts.run.value.page >= facts.run.value.maxPages) return stop('PAGE_CAP');
  if (facts.run.value.remainingMs < ADVANCE_RUN_STEP_RESERVE_MS) return stop('TIME_CAP');
  return Object.freeze({ kind: 'ADVANCE' });
}

/** 网站自己说后面还有几步：第几步、共几步都说得出，而且还没到最后一步。 */
export function siteSaysMoreSteps(site: WizardProgress | null): boolean {
  return site !== null && site.index !== null && site.total !== null && site.index < site.total;
}

/** 连填里的一页：属于哪一轮、第几页、前面填好了几页几项、网站说这一步叫什么。 */
export interface ChainPage {
  readonly run: AdvanceRun;
  readonly scope: AdvanceRunScope;
  readonly vendor: ApplyVendor;
  readonly number: number;
  readonly maxPages: number;
  readonly donePages: number;
  readonly doneFields: number;
  readonly site: WizardProgress | null;
}

/** 浮层上这一页的连填样子。 */
export function chainDockState(page: ChainPage, stop: DockChainStop | null): DockChainState {
  return Object.freeze({
    page: page.number,
    maxPages: page.maxPages,
    site: page.site,
    donePages: page.donePages,
    doneFields: page.doneFields,
    stop,
  });
}

export type FillToReviewDock = Pick<AutofillDockHandle, 'setChain' | 'autoAdvance'>;

export interface FillToReviewDeps {
  readonly now?: () => number;
  /** 往下翻之前重读一次写策略（与「继续到下一页」同一条路）；读不到就是 null——不翻（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。 */
  readonly resolvePolicy: () => Promise<ApplyPolicy | null>;
  /** 连填里的一次翻页（wizardAdvance.advanceInRun）。 */
  readonly advance: (step: AdvanceRunStep) => Promise<DockAdvanceOutcome>;
  /** 页面上有没有只能本人处理的关卡（内核 detectHumanCheckpoint）；抛了就当说不清。 */
  readonly checkpoint: () => HumanCheckpoint | null;
  /** 翻过去了：用新一页的凭证接着填（runGestureFill）。 */
  readonly fillNextPage: (page: AdvanceRunPageProof) => void;
  /** 此刻的浮层（它会换：换脸、让给助手），每次现取。 */
  readonly dock: () => FillToReviewDock | null;
}

export type ChainBegin =
  /** 这一页连着填：用这张「这一页」的凭证写。 */
  | Readonly<{ kind: 'CHAIN'; proof: AdvanceRunPageProof; page: ChainPage }>
  /** 这一页不连填（开关没开、单页申请表）：照旧用那一下点击的凭证写。 */
  | Readonly<{ kind: 'SINGLE'; proof: GestureRoot }>
  /** 连填翻到的这一页不能填（换了地方、这一轮已经收场）：一个字不写。 */
  | Readonly<{ kind: 'REFUSED'; stop: DockChainStop }>;

export interface ChainAfterPage {
  /** 这一页写成了几项（规则、AI、求职信合计）。 */
  readonly written: number;
  /** 此刻的页面范围（origin + pathname + 这一页扫描认出的厂商）。 */
  readonly scope: () => AdvanceRunScope;
  readonly stopped: () => boolean;
  /** 这一页还归这一轮管（没开新的一轮、没翻页、浮层没换）。 */
  readonly current: () => boolean;
  /** 这一页此刻还有几项必填要他处理（浮层单子里的，加上页面上还空着、浮层没认出的）。 */
  readonly requiredNeeds: () => number;
  /** 网站此刻在这一页上标着几处错（不给按 0 算）。 */
  readonly siteErrors?: () => number;
  readonly finalSubmit: () => boolean;
  readonly next: () => NextControlState | 'UNARMED';
  /** 网站那颗翻页按钮上的字（浮层写「正在按网站上的「Save and Continue」」）。 */
  readonly label: () => string | null;
}

export interface FillToReview {
  /**
   * 这一页开始填（扫描认出了表之后）。一次真实点击：上一轮到此为止；开关开着、这一页是向导的一步（有唯一一颗翻页按钮）
   * 就开新的一轮。连填翻到的这一页：还得是同一轮、同一个页面、同一张申请、同一家。
   */
  begin(input: Readonly<{
    root: GestureRoot;
    scope: AdvanceRunScope;
    vendor: ApplyVendor;
    policy: ApplyPolicy;
    /** 这一页的翻页按钮（只在要开一轮时才看）。 */
    next: () => NextControlState;
    /** 网站说的这一步（只在连填时才读）。 */
    site: () => WizardProgress | null;
  }>): ChainBegin;
  /** 这一页填完、AI 与求职信都有了结局：往下翻（交回 true，浮层交给 autoAdvance）还是停下（false，调用方照常收尾）。 */
  afterPage(page: ChainPage, facts: ChainAfterPage): Promise<boolean>;
  /**
   * 连填翻过去之后新一页扫不出表：到了检查页（REVIEW）、网站要他本人过的关卡、一页我们认不出要填的（后面还有）、
   * 页面换了地方。这一轮到此为止。不是连填翻到的页就是 null（照旧的处理）。
   */
  noForm(root: GestureRoot, input: Readonly<{ origin: string; pathname: string; next: NextControlState }>): Readonly<{ stop: DockChainStop; page: ChainPage }> | null;
  /** 这一张凭证是不是连填翻到的某一页的。 */
  pageOf(root: GestureRoot): ChainPage | null;
  /** 全部作废：他按了「停止」、开了新的一轮、离开了这一页、浮层换了。 */
  end(): void;
  /**
   * 账号墙（2026-09-28，负责人：像 Jobright 那样替用户注册、登录）：那一下点击开一轮，账号墙算这一轮的第一页。
   * 与连填同一个口子（内核 `openAdvanceRun`：同一个页面、同一张申请、同一家，总时限与页数上限），不另造授权——
   * 邮箱验证、人机验证之后接着登录、登录之后接着填，靠的都是这一轮发给这一页的凭证。开不了（点击过期、说不清）就是 null。
   */
  openAccountRun(input: Readonly<{ root: TrustedGestureProof; scope: AdvanceRunScope; vendor: ApplyVendor }>): Readonly<{ proof: AdvanceRunPageProof; page: ChainPage }> | null;
  /** 账号墙上那一下提交（注册、登录）开始：这一轮此后不开第二步。这一轮已经收场、到点、换了地方就是 null。 */
  beginAccountStep(page: ChainPage, scope: AdvanceRunScope): AdvanceRunStep | null;
  /**
   * 账号墙过去了：发新一页的凭证，接着填（`runGestureFill` 认得它是这一轮的一页）。网站随后若把 …/applyManually 换成
   * …/apply（Workday 建草稿），那一页开始填时 `begin` 跟着换一次（内核只许这一次、只许账号墙之后的第一页）。
   */
  completeAccountStep(step: AdvanceRunStep, page: ChainPage): AdvanceRunPageProof | null;
  /** 那一下提交没过去（网站没收、要他处理）：放下这一步，这一页的凭证照旧。 */
  abandonAccountStep(step: AdvanceRunStep): void;
  /** 账号墙这一页的凭证还算不算数、还剩多久（邮箱验证回来时判能不能接着登录）。 */
  accountRunState(page: ChainPage, scope: AdvanceRunScope): AdvanceRunResult<Readonly<{ page: number; maxPages: number; remainingMs: number }>>;
}

export function createFillToReview(deps: FillToReviewDeps): FillToReview {
  const now = deps.now ?? (() => Date.now());
  /** 此刻还在跑的那一轮。 */
  let active: AdvanceRun | null = null;
  const pages = new WeakMap<object, ChainPage>();

  const pageOf = (root: GestureRoot): ChainPage | null => (isAdvanceRunPage(root) ? pages.get(root) ?? null : null);

  const end = (): void => {
    if (active !== null) endAdvanceRun(active);
    active = null;
  };

  /** 翻页有了结论：翻过去了就接着填下一页；没翻成就停在这一页，照实说为什么。 */
  const afterAdvance = (step: AdvanceRunStep, page: ChainPage, next: ChainPage, outcome: DockAdvanceOutcome): DockAdvanceOutcome => {
    if (outcome === 'ADVANCED') {
      const proof = completeAdvanceRunStep(step, now());
      // 翻过去了，但这一轮在翻页的那几秒里收场了（他按了「停止」）：不接着填，浮层回到可以点「自动填写」的样子。
      if (!proof.ok) return 'ADVANCED';
      pages.set(proof.value, next);
      deps.dock()?.setChain(chainDockState(next, null));
      deps.fillNextPage(proof.value);
      return 'ADVANCED_FILLING';
    }
    abandonAdvanceRunStep(step);
    const stoppedByUser = active !== page.run;
    closeAdvanceRun(page.run, now());
    let reason: DockChainStop = stoppedByUser ? 'STOPPED' : outcome === 'NOT_ADVANCED' ? 'NOT_ADVANCED' : 'UNAVAILABLE';
    if (!stoppedByUser && outcome === 'NOT_ADVANCED') {
      // 按下去之后网站弹出了只能本人处理的关卡（人机验证、登录）：照实说那一件事，而不是「网站没有翻页」。
      try {
        reason = deps.checkpoint() ?? reason;
      } catch {
        reason = 'NOT_ADVANCED';
      }
    }
    deps.dock()?.setChain(chainDockState(page, reason));
    return outcome;
  };

  const driver: FillToReview = {
    pageOf,
    end,

    begin(input): ChainBegin {
      if (isAdvanceRunPage(input.root)) {
        const page = pages.get(input.root);
        if (page === undefined) return Object.freeze({ kind: 'REFUSED', stop: 'STOPPED' });
        let state = advanceRunState(page.run, input.scope, now());
        // 账号墙之后的第一页换了地址（Workday 建草稿：…/applyManually → …/apply）：这一页上已经按这一家的规则扫出了申请表，
        // 这一轮跟着换一次。别的页、第二次换，内核都不许。
        if (!state.ok && state.code === 'RUN_SCOPE_CHANGED' && input.vendor === page.vendor &&
            rebindAfterAccount(input.root, input.scope, now()).ok) {
          state = advanceRunState(page.run, input.scope, now());
        }
        if (!state.ok || input.vendor !== page.vendor) {
          closeAdvanceRun(page.run, now());
          const stop: DockChainStop = !state.ok && state.code === 'RUN_ENDED' ? 'STOPPED'
            : !state.ok && state.code === 'RUN_EXPIRED' ? 'TIME_CAP' : 'MOVED';
          return Object.freeze({ kind: 'REFUSED', stop });
        }
        const withSite: ChainPage = Object.freeze({ ...page, scope: input.scope, site: input.site() });
        pages.set(input.root, withSite);
        return Object.freeze({ kind: 'CHAIN', proof: input.root, page: withSite });
      }
      // 一次真实点击（自动填写、继续到下一页、再试一次、重新填写这一页）：上一轮到此为止。
      end();
      if (!chainAllowed(input.policy, input.vendor, now()) || input.next() !== 'ONE') {
        return Object.freeze({ kind: 'SINGLE', proof: input.root });
      }
      const opened = openAdvanceRun({ proof: input.root, scope: input.scope, now: now() });
      if (!opened.ok) return Object.freeze({ kind: 'SINGLE', proof: input.root });
      const state = advanceRunState(opened.value.run, input.scope, now());
      active = opened.value.run;
      const page: ChainPage = Object.freeze({
        run: opened.value.run,
        scope: input.scope,
        vendor: input.vendor,
        number: 1,
        maxPages: state.ok ? state.value.maxPages : 1,
        donePages: 0,
        doneFields: 0,
        site: input.site(),
      });
      pages.set(opened.value.page, page);
      return Object.freeze({ kind: 'CHAIN', proof: opened.value.page, page });
    },

    async afterPage(page, facts): Promise<boolean> {
      const stopWith = (reason: DockChainStop): false => {
        closeAdvanceRun(page.run, now());
        if (facts.current()) deps.dock()?.setChain(chainDockState(page, reason));
        return false;
      };
      if (!facts.current()) return false;
      let policy: ApplyPolicy | null;
      try {
        policy = await deps.resolvePolicy();
      } catch {
        // 读不到写策略：当关（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED），下面判成「开关关着」停下。
        policy = null;
      }
      if (!facts.current()) return false;
      let checkpoint: HumanCheckpoint | 'UNREADABLE' | null;
      try {
        checkpoint = deps.checkpoint();
      } catch {
        checkpoint = 'UNREADABLE';
      }
      const scope = facts.scope();
      const move = decideAfterPage({
        stopped: facts.stopped(),
        checkpoint,
        requiredNeeds: facts.requiredNeeds(),
        siteErrors: facts.siteErrors?.() ?? 0,
        finalSubmit: facts.finalSubmit(),
        next: facts.next(),
        chainOn: chainAllowed(policy, page.vendor, now()),
        run: advanceRunState(page.run, scope, now()),
        site: page.site,
      });
      if (move.kind === 'STOP') return stopWith(move.reason);
      const step = beginAdvanceRunStep(page.run, scope, now());
      if (!step.ok) {
        return stopWith(step.code === 'RUN_PAGE_CAP' ? 'PAGE_CAP'
          : step.code === 'RUN_EXPIRED' ? 'TIME_CAP'
          : step.code === 'RUN_SCOPE_CHANGED' ? 'MOVED'
          : step.code === 'RUN_ENDED' ? 'STOPPED' : 'UNAVAILABLE');
      }
      const next: ChainPage = Object.freeze({
        ...page,
        number: page.number + 1,
        donePages: page.donePages + 1,
        doneFields: page.doneFields + Math.max(0, facts.written),
        site: null,
      });
      const pending = deps.advance(step.value).then(
        (outcome) => afterAdvance(step.value, page, next, outcome),
        () => afterAdvance(step.value, page, next, 'UNAVAILABLE'),
      );
      deps.dock()?.autoAdvance(pending, facts.label());
      return true;
    },

    openAccountRun(input) {
      // 一次真实点击：上一轮到此为止。
      end();
      const opened = openAdvanceRun({ proof: input.root, scope: input.scope, now: now() });
      if (!opened.ok) return null;
      const state = advanceRunState(opened.value.run, input.scope, now());
      active = opened.value.run;
      const page: ChainPage = Object.freeze({
        run: opened.value.run,
        scope: input.scope,
        vendor: input.vendor,
        number: 1,
        maxPages: state.ok ? state.value.maxPages : 1,
        donePages: 0,
        doneFields: 0,
        site: null,
      });
      pages.set(opened.value.page, page);
      return Object.freeze({ proof: opened.value.page, page });
    },

    beginAccountStep(page, scope) {
      const step = beginAdvanceRunStep(page.run, scope, now());
      return step.ok ? step.value : null;
    },

    completeAccountStep(step, page) {
      const proof = completeAccountRunStep(step, now());
      if (!proof.ok) return null;
      // 账号墙这一页不算「填好的一页」：浮层上的页数从申请表的第一页算起（内核那一侧的页数上限照旧把它算进去）。
      pages.set(proof.value, Object.freeze({ ...page, number: 1, donePages: 0, doneFields: 0, site: null }));
      return proof.value;
    },

    abandonAccountStep(step) {
      abandonAdvanceRunStep(step);
    },

    accountRunState(page, scope) {
      return advanceRunState(page.run, scope, now());
    },

    noForm(root, input) {
      const page = pageOf(root);
      if (page === null) return null;
      closeAdvanceRun(page.run, now());
      const answer = (stop: DockChainStop) => Object.freeze({ stop, page });
      if (input.origin !== page.scope.origin || input.pathname !== page.scope.pathname) return answer('MOVED');
      let wall: HumanCheckpoint | null;
      try {
        wall = deps.checkpoint();
      } catch {
        return answer('UNAVAILABLE');
      }
      if (wall !== null) return answer(wall);
      // 这一页没有我们认得的表，却还有一颗「下一步」：不是检查页，是一页我们填不了的（后面还有）。
      return answer(input.next === 'NONE' ? 'REVIEW' : 'UNKNOWN_PAGE');
    },
  };
  return Object.freeze(driver);
}
