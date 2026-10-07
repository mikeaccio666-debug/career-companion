import type { AuditView } from '@edaix/apply-kernel/audit';
import type { AutofillAffordance } from '../../product-panel/affordance';
import { launcherTopPx, launcherTopRatio as ratioOfTop } from '../../product-panel/launcherPosition';
import { dockRunSummary, type DockRunProgress } from '../../product-panel/runProgress';
import { dockProgressFromAudit } from '../autofillDockProgress';
import { dockCopy, NETWORK_CODES } from './copy';
import { DOCK_CSS, EASE, EASE_OUT, SPRING } from './css';
import { animate, el, setDockHandlerErrorSink, trusted, wait } from './dom';
import { arriveEnvelope, flyHome, startEnvelope, type EnvelopeRun, type HomeFlight } from './envelope';
import { activityStatus, tallyOf } from './activity';
import { AI_FIELD_CSS, aiFailedText, badgeKindOf, createAiFieldLayer, type AiFieldSpec } from './aiField';
import { logo } from './logo';
import { createFieldFlash, FIELD_FLASH_CSS } from './fieldFlash';
import { hostFieldHasValue, hostFieldState, scrollHostFieldIntoView } from './hostField';
import { icon } from './icons';
import { jobChips, postedAgo, safeDetailUrl, salaryText } from './jobFacts';
import { createLiveFeed, type FeedLine } from './liveFeed';
import { NEED_KINDS, needKindOf, optionChips, rememberable, type NeedKind } from './needs';
import { createNeedsView, type NeedAct, type NeedItem } from './needsView';
import { createDockProfileEditor, type DockProfileEditor } from './profileEditor';
import { createDockVaultList } from './vaultList';
import { isNeed, NEED_STATUSES, toDockRow, type DockRow, type RowStatus } from './rows';
import type {
  AutofillDockEntry,
  AutofillDockFieldRow,
  DockAccountPrompt,
  DockAccountStatus,
  DockAccountWall,
  AutofillDockHandle,
  AutofillDockHandlers,
  AutofillDockProgress,
  DockAdvanceOutcome,
  DockAiAnswersState,
  DockAiGenerateOutcome,
  DockAnswerOutcome,
  DockAnswers,
  DockQuestion,
  DockCoverLetterState,
  DockAiTools,
  DockAuditHandle,
  DockAuditHandlers,
  DockBlockedAction,
  DockChainState,
  DockCodeOutcome,
  DockCodePrompt,
  DockJobFacts,
  DockRetireReason,
  DockRunOutcome,
  DockRunState,
  DockRunStep,
  DockScene,
  DockSubmitOutcome,
} from './types';

/**
 * ArgoLand.AI 的自动填写浮层（2026-09-23 按设计交接 `ArgoAI Autofill.dc.html` 重做）。
 *
 * 一个关着的 shadow root 里放我们自己的一棵树：收起时的圆按钮、贴右侧撑满的面板、网页上的 AI 标记、
 * 「去那一栏」之后亮一下的那一圈、Toast。宿主页上除了我们这一个宿主节点，什么都不加、不挪、不改样式；
 * 亮的那一圈是 shadow 里一个 `position:fixed` 的元素，只在滚动停下后量一次（fieldFlash.ts）。每一颗按钮只认 `isTrusted`。
 *
 * 画法：节点是常驻的，状态变了就在原节点上改——主卡在「自动填写」→ 进度卡 → 总结卡之间是**同一个
 * 元素**连续变形（高度先量再过渡，底色与阴影过渡），进度条上的每一段从头到尾不重新挂载，列表按行
 * 复用节点，新出现的行才依次入场。
 */

const HOST_ID = 'edaix-autofill-dock';
/**
 * 「换一个说法」说给 AI 的那句要求（不给用户看）：写成英文、明说保持原来的意思、事实、语言与长短——申请表多半是英文，
 * 用中文界面的人按下去也不该换成中文。
 */
const REPHRASE_INSTRUCTION = 'Say this differently: keep the meaning, the facts, the language and about the same length.';
/** 填写途中那一条列表至少这么高（面板很矮时也看得见几行）。 */
const FEED_MIN_HEIGHT = 132;
/** 收尾时那一条列表收进「其余已填好」要多久（与 css.ts 的 `.fold-rest` 过渡一致）。 */
const FEED_FOLD_MS = 520;
/** 填写途中列在那一条列表里的几种：我们填的（写上的、确认了的、网页上原有的）、代填的、AI 写的。 */
const FEED_STATUSES: ReadonlySet<RowStatus> = new Set<RowStatus>(['written', 'ok', 'signed', 'ai']);

let dismissCurrent: (() => void) | null = null;

type Phase = 'idle' | 'preparing' | 'filling' | 'done' | 'advancing' | 'review' | 'failed';
type FaceKind = 'ready' | 'unlinked' | 'linking' | 'dormant' | 'noForm' | 'rules' | 'signin' | 'closed';
type HeroMode = 'button' | 'activity' | 'summary' | 'face' | 'failed' | 'account' | 'updated' | 'code';

const NOOP: AutofillDockHandle = /* @__PURE__ */ Object.freeze({
  face: () => 'HIDDEN' as const, faceKey: () => 'HIDDEN', autofillEnabled: () => false, autofillButton: () => null, dismiss: () => {},
  sheetState: () => 'ABSENT' as const, summaryText: () => null, toggleSheet: () => {},
  fieldRows: () => [], update: () => {}, beginRun: () => {},
  isOpen: () => false, hasFocus: () => false, launcherButton: () => null, addJobButton: () => null, entryButtons: () => [],
  openPanel: () => {}, closePanel: () => {}, setNotice: () => {}, sheetFace: () => 'ABSENT' as const,
  attentionCount: () => 0, rowValues: () => [], reviewButtons: () => ({ edit: null, fill: null }),
  scene: () => 'HOME' as const, runState: () => 'IDLE' as const, beginPreparing: () => {}, setStep: () => {},
  finishRun: () => {}, reportBlocked: () => {}, openProfile: () => {}, backHome: () => {},
  profileRoot: () => null, sceneRoot: () => null, toast: () => {},
  retireRun: () => {}, nextStepButton: () => null, primaryButton: () => null, refreshAccount: () => {}, forgetUser: () => {}, revalidateProfile: () => {}, refreshJob: () => {},
  setAiAnswers: () => {}, setAiTools: () => {}, setAiNoEvidence: () => {}, setAiUnanswered: () => {}, noteRemembered: () => {},
  setCoverLetter: () => {}, setChain: () => {}, autoAdvance: () => {},
  setAccountWall: () => {}, accountStatus: () => {}, accountPrompt: () => {}, accountContinuing: () => {},
  extensionUpdated: () => {},
  codePrompt: () => {},
});

const NOOP_AUDIT: DockAuditHandle = /* @__PURE__ */ Object.freeze({ dismiss: () => {}, update: () => {}, shadowRoot: null });

/** 脸的完整身份：kind 加上 UNAVAILABLE 的 reason。 */
export function affordanceFaceKey(affordance: AutofillAffordance): string {
  return affordance.kind === 'UNAVAILABLE' ? `${affordance.kind}:${affordance.reason}` : affordance.kind;
}

function faceKindOf(affordance: AutofillAffordance): FaceKind {
  if (affordance.kind === 'READY') return 'ready';
  if (affordance.kind === 'DORMANT') return 'dormant';
  if (affordance.kind === 'GUIDANCE') return affordance.guidance === 'SIGN_IN_FIRST' ? 'signin' : 'noForm';
  if (affordance.kind === 'UNAVAILABLE') {
    if (affordance.reason === 'PORTAL_UNLINKED') return 'unlinked';
    if (affordance.reason === 'RULES_UNAVAILABLE') return 'rules';
    if (affordance.reason === 'VENDOR_CLOSED') return 'closed';
    return 'ready';
  }
  return 'dormant';
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  if (/[\u3400-\u9fff]/u.test(trimmed[0] ?? '')) return trimmed[0] ?? '';
  // 头尾两个词的首字母；括号、标点不算（「Yuxin (Yuchen) Lou」→ YL）。
  const words = trimmed.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}]/gu, '')).filter((word) => word !== '');
  if (words.length === 0) return '';
  const first = words[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1] ?? '' : '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

function localStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function mountDock(
  affordance: AutofillAffordance,
  handlers: AutofillDockHandlers,
  doc: Document = document,
  progress?: AutofillDockProgress,
): AutofillDockHandle {
  if (affordance.kind === 'HIDDEN') return NOOP;
  dismissCurrent?.();
  // 浮层里的按钮抛了：交一个稳定码（只有类名），dom.ts 照旧把错抛出去（2026-10-04 体检 11-2）。
  setDockHandlerErrorSink((kind, error) => handlers.onError?.(kind === 'THREW' ? 'DOCK_HANDLER_THREW' : 'DOCK_HANDLER_REJECTED', error));
  const win = doc.defaultView;
  const reduced = (): boolean => {
    try {
      return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  };
  const vp = (): { w: number; h: number } => ({ w: win?.innerWidth || 1200, h: win?.innerHeight || 760 });
  /**
   * 嵌在公司官网里的那一帧（2026-10-04，bench-1003 第七节第 4 条：Brex、Datadog、Databricks、MongoDB 嵌 Greenhouse）：这一帧的
   * 视口就是整个 iframe——几千像素高——`position:fixed` 钉的是 iframe 的顶端；外层页面一往下滚，浮层就跟着申请表的顶端滚出了
   * 屏幕，用户看不见那一个能填的浮层。这里量「这一帧此刻看得见的那一段」（`band`，这一帧自己的坐标；IntersectionObserver
   * 只看我们 shadow 里的一个占位元素，不碰宿主的节点），收起按钮、面板、提示都摆在那一段里。还没量到（或这一帧此刻一点都
   * 看不见）就用上一次量到的；一次都没量到就是这一帧的顶端那一屏。不是嵌入帧就是整个视口，与从前逐字相同。
   */
  let band: { top: number; h: number } | null = null;
  const EMBED_DEFAULT_H = 900;
  const viewBand = (): { top: number; h: number } => {
    const { h } = vp();
    if (handlers.embeddedFrame !== true) return { top: 0, h };
    if (band !== null && band.h >= 1) return { top: Math.max(0, band.top), h: band.h };
    return { top: 0, h: Math.min(h, EMBED_DEFAULT_H) };
  };
  const sheetAllowed = affordance.kind !== 'GUIDANCE';
  // 这个浮层说哪一种话（2026-09-25）：调用方按浏览器的界面语言挑，不传是中文。下面每一个字都从这一套里取。
  const locale = handlers.locale ?? 'zh';
  const COPY = dockCopy(locale);
  const vendor = handlers.vendorLabel ?? COPY.vendorFallback;
  const envelopeWords = { submit: COPY.bar.submit, submitted: COPY.submitted, autofill: COPY.autofill };

  // ── 状态（与设计原型的 state 一一对应）─────────────────────────────
  let open = false;
  let hidden = false;
  let hover = false;
  let route: 'main' | 'profile' = 'main';
  let face: FaceKind = faceKindOf(affordance);
  let checking = false;
  let phase: Phase = 'idle';
  let prep: 0 | 1 = 0;
  let prepLabel: string | null = null;
  let stopped = false;
  let stopRequested = false;
  let failCode: string | null = null;
  let failAction: DockBlockedAction | null = null;
  let failDiagnostics: readonly string[] = [];
  let techOpen = false;
  let restOpen = false;
  let notAdv: null | { needsAtClick: number } = null;
  let submitNote: null | 'NOT_SUBMITTED' | 'UNCONFIRMED' = null;
  let menu: '' | 'account' | 'more' = '';
  let rows: DockRow[] = [];
  let current: AutofillDockProgress | undefined;
  let runKey: string | null = null;
  const userDid = new Map<string, boolean>();
  /**
   * 这一轮要写的那几格，在收尾那一刻（或之后第一次成为「需要你」那一刻）的样子（hostFieldState）。
   * 它们之后又变了样才算用户补的；样子本身只在这里比一比，不显示、不外传。
   */
  const settledState = new Map<string, string | null>();
  /**
   * 这一轮开始以后，用户在网站上动过手没有（点击、按键、输入、粘贴、拖放；只认浏览器认定的真事件，我们浮层里的
   * 不算）。一次都没有，一格里新冒出来的值就不可能是他补的：Lever 附上简历十几秒后才把解析结果写回来
   * （2026-09-24 实测），从前会被算成「你补上了」。只看整页有没有动过手，不去逐个控件对应——自订下拉里用户点的
   * 是里层元素，对不上行的目标，逐个对应反而会漏记他真补上的那一格。
   */
  let userActedOnHost = false;
  let tickerKey = '';
  let submitted = false;
  let submitting = false;
  /** 旧接口 toggleSheet 的「这一轮收起到按钮上」：收起就是把面板收成右侧那颗圆按钮。 */
  let sheetCollapsed = false;
  /** worker 说「剩下的要你来」而没有交来逐栏的行（mission 那条路）。 */
  let handBack = false;
  /** 收尾时读到的诊断码换成的人话（简历附的是哪一版、为什么没附上、EEO 读不到）。 */
  /** 附上的是哪一版简历（诊断码，`COPY.resumeVersion` 的键）；没说就是 null。写在「其余已填好」里简历那一行上。 */
  let resumeVersion: string | null = null;
  let audit: { handlers: DockAuditHandlers; dismiss: () => void } | null = null;
  let runSerial = 0;
  const retiredRunIds = new Set<string>();
  let topRatio = handlers.launcherTopRatio ?? (handlers.embeddedFrame === true ? 0.12 : 0.42);
  // AI 代答（2026-09-23）与「用 AI 写 / AI 改写」（2026-09-24）。
  let aiState: DockAiAnswersState = { kind: 'IDLE' };
  let aiTools: DockAiTools | null = null;
  /** 开关此刻的状态；null = 还没读到（缺省是开）。 */
  let aiOn: boolean | null = null;
  /** 「记住我的回答」此刻的状态；null = 还没读到（没设过就是开，2026-09-28）。 */
  let memoryOn: boolean | null = null;
  let aiApplying = false;
  /** AI 看过、在资料里没找到依据的那几栏。 */
  let aiNoEvidence: ReadonlySet<Element> = new Set();
  /** 送给了 AI、这一轮却没拿到答案的那几栏。 */
  let aiUnanswered: ReadonlySet<Element> = new Set();
  // 求职信（2026-09-27）：它的状态画在表上那几个求职信栏的行上，晚到了摆一颗「附上求职信」。
  let letterState: DockCoverLetterState = { kind: 'IDLE' };
  let letterApplying = false;
  // 代填授权的一键同意（2026-09-28）：正在存；这一页已经同意或暂不过（卡片不再出现）。
  let consentSaving = false;
  let consentSettled = false;
  /**
   * 规则那几遍写完了、AI 代答还在起草（`AI_DRAFTING`，2026-09-24 负责人：「ai 如果在启用的话，那个黑色的进度框应该
   * 还显示着」）：这一轮还没完。这期间收到的终局单子与审计只换进度条，进度卡留着、写明 AI 在填；finishRun /
   * reportBlocked 才收尾，新的一轮、翻页、撤销一并放下。
   */
  let aiStep = false;
  /**
   * 连填（2026-09-28 负责人：按一下「自动填写」，一页一页填到检查页）：这一页是第几页、停没停下、为什么；null = 不是连填。
   * 连填还在往下填时（`chainHold`），这一页的终局单子与 AI 起草那一段同样不收尾：进度卡留着，等往下翻（`autoAdvance`）
   * 或停下（调用方说 finishRun / reportBlocked）。
   */
  let chain: DockChainState | null = null;
  let chainHold = false;
  /** 连填正在替他按网站的下一步（没有点击）：进度卡留着，写明正在翻到下一页。 */
  let autoAdvancing = false;
  let autoAdvanceLabel: string | null = null;
  // 「需要你」在浮层里就能办完（2026-09-28）：当场答的口子（随审计交来）、正在写的与已经答上的那几行。
  let answersPort: DockAnswers | null = null;
  /** 正在写的那几行：行 → 写的值（那个选项上转圈）。 */
  const answering = new Map<string, string>();
  /** 在浮层里答上了的那几行（调用方交回新单子之前，先当它办好了——前提是那一栏此刻有值）。 */
  const answeredHere = new Map<string, string>();
  /** 「AI 帮我写」正在写的那几行；写好了但那一下点击过期、要再点一下的那几行。 */
  const aiWriting = new Set<string>();
  const aiConfirm = new Map<string, (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAiGenerateOutcome>>();
  /** 按过「AI 帮我写」之后这一行换的那一句（没找到依据、次数用完）。 */
  const rowNotes = new Map<string, string>();
  /** 「换一个说法」正在换的那几行；换好了但那一下点击过期、要再点一下的那几行。 */
  const rephrasing = new Set<string>();
  const rephraseConfirm = new Map<string, (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAiGenerateOutcome>>();
  /** 「去第一项 / 下一处」此刻停在哪一行；还没去过就是 null（主按钮写「去第一项」）。 */
  let cursor: string | null = null;
  /** 收尾时读到的诊断码里认得的那几条（码 → 人话）：挂到它说的那几行上（简历、自我认同），挂不上的才留在总结下面。 */
  let diagHints: ReadonlyArray<Readonly<{ key: string; text: string }>> = [];
  /**
   * 填写途中进度卡下面那一条列表（2026-09-28，liveFeed.ts）：`live` 在填；`folding` 刚收尾、列表正收进「其余已填好 N 项」
   * （那半秒里行不动）；`off` 就是平常的「其余已填好」。`feedOrder`：这一轮各栏填上的先后（新填上的接在最后）。
   */
  let feedMode: 'off' | 'live' | 'folding' = 'off';
  /** 那一条列表此刻列着几行没有（一行都没有就不必「收」）。 */
  let feedShown = false;
  let feedTimer: ReturnType<typeof setTimeout> | null = null;
  const feedOrder: string[] = [];
  const feedSeen = new Set<string>();
  /**
   * 招聘网站账号（2026-09-28，负责人：替用户注册、登录 Workday／iCIMS）。`accountWall`：这一页上认出了
   * 账号墙，主按钮换成「注册并自动填写」或「登录并自动填写」；`accountAsk`：账号墙上停下来要他做的那一件事（画成主卡的
   * 一种样子）；`accountDone`：这一次替他做成的那几件事，一直留到他下一次自己按主按钮，总结里逐条列出。
   */
  let accountWall: DockAccountWall | null = null;
  let accountAsk: DockAccountPrompt | null = null;
  /**
   * 网站在要邮件里的验证码（2026-10-04）：那张卡画成主卡的一种样子。`codeFilledHere`：他在卡上按了「填进网站」、写上了
   * （网站又说了新的一句、或那一块不见了就作废）；`codeNote`：按了之后没写上的那一行；`codeDraft`：卡重画时他输到一半的那一串
   * （只在这个闭包里，不进任何回报）。
   */
  let codeAsk: DockCodePrompt | null = null;
  let codeFilledHere = false;
  let codeNote: string | null = null;
  let codeBusy = false;
  let codeDraft = '';
  let accountDone: string[] = [];
  /** 账户菜单只保留隐藏的站点列表；密码在插件设置页查看。 */
  let acctMenuOpen = false;
  /**
   * 这一页和插件断了线（2026-10-03 体检 3e：插件更新、重载或停用之后，开着的页面上旧的内容脚本还在跑）。调用方一发现就说
   * （`extensionUpdated`），从此主卡是一张卡、一颗「刷新页面」。
   */
  let orphaned = false;

  // ── 宿主节点与 shadow ───────────────────────────────────────────
  const host = doc.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = DOCK_CSS + AI_FIELD_CSS + FIELD_FLASH_CSS;
  const root = el(doc, 'div', 'root');
  if (handlers.embeddedFrame === true) root.dataset.embedded = 'true';
  shadow.append(style, root);
  // 嵌入帧：量这一帧此刻看得见的那一段（见 `band` 的头注）。量法是一把「尺子」：我们自己 shadow 里一摞 100 像素高的占位
  // 元素，从这一帧的顶端铺到底，不接事件、不可见。IntersectionObserver 只在「看得见的比例」跨过阈值时才回调——只用一整条
  // 占位元素时，iframe 比视口高、外层页面在中段滚动，比例一直是同一个数（Databricks：3142 像素高的 iframe，比例停在 0.318），
  // 回调一次都不来，浮层留在旧位置、出了屏幕（2026-10-04 测试台实测）。一摞短的：滚过 10 像素就有一块跨过阈值，看得见的
  // 那一段 = 此刻看得见的那几块拼起来。摆位置只改我们自己的节点。
  let bandWatch: { stop: () => void } | null = null;
  const BAND_SLICE_PX = 100;
  const watchBand = (onBand: () => void): void => {
    const IO = (win as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | null)?.IntersectionObserver;
    if (handlers.embeddedFrame !== true || win === null || IO === undefined) return;
    const ruler = doc.createElement('div');
    ruler.setAttribute('aria-hidden', 'true');
    ruler.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:0;pointer-events:none;visibility:hidden';
    shadow.append(ruler);
    // 每一块最近一次看得见的那一截（这一帧自己的坐标）；看不见的不在里面。
    const seen = new Map<Element, { top: number; bottom: number }>();
    let observer: IntersectionObserver;
    try {
      observer = new IO((entries) => {
        for (const entry of entries) {
          const rect = entry.intersectionRect;
          if (entry.isIntersecting && rect.height >= 1) seen.set(entry.target, { top: rect.top, bottom: rect.top + rect.height });
          else seen.delete(entry.target);
        }
        if (seen.size === 0) return;
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const slice of seen.values()) {
          top = Math.min(top, slice.top);
          bottom = Math.max(bottom, slice.bottom);
        }
        band = { top: Math.max(0, top), h: bottom - top };
        onBand();
      }, { threshold: Array.from({ length: 11 }, (_, index) => index / 10) });
    } catch {
      ruler.remove();
      return;
    }
    let slices = 0;
    // 文档高了或矮了（申请表加行、展开一节）：重铺尺子。
    const size = (): void => {
      const height = Math.max(doc.documentElement?.scrollHeight ?? 0, win.innerHeight || 0);
      const wanted = Math.max(1, Math.ceil(height / BAND_SLICE_PX));
      if (wanted === slices) return;
      if (slices > 0) {
        observer.disconnect();
        seen.clear();
        ruler.replaceChildren();
      }
      for (let index = 0; index < wanted; index += 1) {
        const slice = doc.createElement('div');
        slice.style.cssText = `position:absolute;left:0;top:${index * BAND_SLICE_PX}px;width:1px;height:${BAND_SLICE_PX}px`;
        ruler.append(slice);
        observer.observe(slice);
      }
      slices = wanted;
    };
    size();
    const resize = win.ResizeObserver === undefined ? null : new win.ResizeObserver(() => { size(); });
    if (resize !== null && doc.documentElement !== null) resize.observe(doc.documentElement);
    bandWatch = {
      stop: () => {
        observer.disconnect();
        resize?.disconnect();
        ruler.remove();
      },
    };
  };

  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => el(doc, tag, cls, text);
  const tb = (cls: string, onSelect: (event: MouseEvent) => void, text?: string) => trusted(doc, cls, onSelect, text);
  const svg = (name: Parameters<typeof icon>[1], size: number, options?: Parameters<typeof icon>[3]) => icon(doc, name, size, options);
  const markIn = <T extends HTMLElement>(node: T): T => { node.dataset.in = '1'; return node; };

  // ── 收起时的按钮 ────────────────────────────────────────────────
  const launcher = h('div', 'launcher');
  const lBtn = tb('l-btn', () => {
    if (dragMoved) { dragMoved = false; return; }
    const wasOpen = open;
    openPanel();
    if (!wasOpen) handlers.onLauncherOpen?.();
  });
  lBtn.setAttribute('aria-label', COPY.launcher);
  const lIcon = h('span', 'l-icon');
  const lRing = h('span', 'l-ring');
  const lBadge = h('span', 'l-badge');
  lBadge.dataset.badge = '1';
  // 数字已经写进按钮的读屏名字里（「打开 ArgoLand.AI，还有 N 项需要你」），角标本身只给眼睛看。
  lBadge.setAttribute('aria-hidden', 'true');
  lIcon.append(logo(doc, 24));
  const lLabel = h('span', 'l-label');
  lBtn.append(lIcon, lLabel);
  const lHide = tb('l-hide', () => {
    hidden = true;
    hover = false;
    toast(COPY.hidden);
    paint();
  });
  lHide.setAttribute('aria-label', COPY.hideLauncher);
  lHide.append(svg('x', 10, { stroke: 3 }));
  launcher.append(lBtn, lHide);
  launcher.addEventListener('pointerenter', () => { hover = true; paintLauncher(); });
  launcher.addEventListener('pointerleave', () => { hover = false; paintLauncher(); });

  // ── 面板 ───────────────────────────────────────────────────────
  const panel = h('section', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', COPY.product);
  panel.tabIndex = -1;
  const pbody = h('div', 'pbody');

  // 页头
  const head = h('div', 'head');
  const brand = markIn(h('div', 'brand'));
  const brandMark = h('span', 'brand-mark');
  brandMark.append(logo(doc, 22));
  brand.append(brandMark, h('b', 'brand-name', COPY.product));
  const headBack = markIn(h('div', 'head-back'));
  const backBtn = tb('back', () => leaveProfile());
  backBtn.setAttribute('aria-label', COPY.back);
  backBtn.append(svg('chevronLeft', 20), doc.createTextNode(COPY.back));
  headBack.append(backBtn, h('b', 'head-title', COPY.profileTitle));
  const avatar = tb('avatar', () => {
    menu = menu === 'account' ? '' : 'account';
    if (menu === 'account') { loadAiSwitch(); loadMemorySwitch(); }
    paintPops();
  });
  avatar.dataset.act = 'menu-account';
  avatar.setAttribute('aria-label', COPY.account);
  const collapseBtn = tb('collapse', () => collapse());
  collapseBtn.setAttribute('aria-label', COPY.collapse);
  collapseBtn.title = COPY.collapse;
  collapseBtn.append(svg('collapseRight', 16));
  head.append(brand, headBack, avatar, collapseBtn);

  // 两条路由
  const routes = h('div', 'routes');
  const main = h('div', 'route-main');
  main.dataset.scroll = '1';
  const profileRoute = h('div', 'route-profile');
  routes.append(main, profileRoute);

  // 岗位卡：收起时一行（首字母方块、岗位名、「公司 · 厂商」）；首页读到了 JobPosting 就展开成摘要卡
  // （2026-09-24 设计：公司与「厂商 · N 天前」、20px 的岗位名、地点与办公方式的胶囊、薪资、一段简介、
  // 匹配要点、「查看完整岗位详情」）。两种样子是同一个元素，按 data-size 换。
  const job = markIn(h('div', 'job'));
  job.dataset.size = 'compact';
  const jobRow = h('div', 'job-row');
  const jobMark = h('span', 'job-mark');
  const jobText = h('span', 'job-text');
  const jobTitle = h('b', 'job-title');
  const jobSub = h('span', 'job-sub');
  jobText.append(jobTitle, jobSub);
  const jobId = h('span', 'job-id');
  const jobCo = h('b', 'job-co');
  const jobMeta = h('span', 'job-meta');
  jobId.append(jobCo, jobMeta);
  jobRow.append(jobMark, jobText, jobId);
  const jobTitleLg = h('div', 'job-title-lg');
  const jobMore = h('div', 'job-more');
  const jobChipRow = h('div', 'job-chips');
  const jobPay = h('div', 'job-pay');
  const jobPayAmount = h('b', 'job-pay-amount');
  const jobPayUnit = h('span', 'job-pay-unit');
  jobPay.append(jobPayAmount, jobPayUnit);
  const jobDesc = h('p', 'job-desc');
  const jobHighlights = h('ul', 'job-hl');
  jobHighlights.setAttribute('aria-label', COPY.jobCard.highlightsAria);
  const jobLink = h('a', 'job-link', COPY.jobCard.detail);
  jobLink.target = '_blank';
  jobLink.rel = 'noopener noreferrer';
  jobMore.append(jobChipRow, jobPay, jobDesc, jobHighlights, jobLink);
  job.append(jobRow, jobTitleLg, jobMore);
  let jobChipsKey = '';
  let jobHighlightsKey = '';

  // 主卡
  const hero = h('div', 'hero');
  hero.dataset.hero = '1';
  hero.dataset.deck = '1';
  let heroMode: HeroMode | null = null;
  let heroModeKey = '';
  let heroTop: HTMLElement | null = null;
  let heroBar: HTMLElement | null = null;
  let heroBarKind: 'shimmer' | 'segs' | null = null;
  let heroSegs: HTMLElement | null = null;
  const segNodes = new Map<string, HTMLElement>();
  let heroBottom: HTMLElement | null = null;
  let autofillButton: HTMLButtonElement | null = null;
  const heroRefs: {
    status?: HTMLElement; count?: HTMLElement; tickerQ?: HTMLElement; tickerV?: HTMLElement; ticker?: HTMLElement;
    legend?: HTMLElement; tally?: HTMLElement; sumTitle?: HTMLElement; sumSub?: HTMLElement; sumNotes?: HTMLElement; techCode?: HTMLElement; tech?: HTMLElement;
    faceSecondary?: HTMLButtonElement; autoIn?: HTMLElement; subDone?: HTMLElement;
  } = {};
  hero.addEventListener('pointerdown', () => {
    if (hero.dataset.press !== '1' || reduced()) return;
    hero.style.transform = 'scale(.975)';
    const up = (): void => { hero.style.transform = ''; win?.removeEventListener('pointerup', up); };
    win?.addEventListener('pointerup', up);
  });

  // 横幅
  const banner = markIn(h('div', 'banner'));
  banner.dataset.deckFade = '1';
  const bannerMark = h('span', 'banner-mark');
  const bannerText = h('span', '');
  const bannerTitle = h('b', 'banner-title');
  const bannerBody = h('span', 'banner-text');
  bannerText.append(bannerTitle, bannerBody);
  banner.append(bannerMark, bannerText);

  // 需要你（2026-09-28）：按要做的事分组，每一行一个明摆着的动作（`needsView.ts`）。
  const needsFold = h('div', 'fold');
  const needsClip = h('div', 'clip');
  needsClip.dataset.clip = '1';
  const needsView = createNeedsView({
    doc,
    copy: COPY,
    reduced,
    onGo: (row) => goToRow(row),
    onAnswer: (row, value, event, remember) => answerRow(row, value, event, remember),
    onAi: (row, event) => aiWriteRow(row, event),
  });
  needsClip.append(needsView.element);
  needsFold.append(needsClip);

  // 提交前核对（2026-09-28）：填好了、但值得他看一眼的那几栏（按默认答的工作授权、没加全的技能）。从前是总结下面的
  // 一行说明，现在挂在它说的那一行上；这一组在首次画的时候放到「已按你的授权代填」后面。
  const reviewGrp = markIn(h('div', 'grp'));
  reviewGrp.dataset.review = 'group';
  const reviewHead = h('div', 'grp-head');
  reviewHead.dataset.deckFade = '1';
  const reviewCount = h('span', 'grp-count');
  reviewHead.append(h('span', '', COPY.needs.groups.review), reviewCount);
  const reviewCard = h('div', 'card');
  reviewCard.dataset.deck = '1';
  reviewGrp.append(reviewHead, reviewCard);
  const reviewNodes = new Map<string, { row: HTMLButtonElement; value: HTMLElement; why: HTMLElement }>();

  // 已按你的授权代填
  const signedGrp = markIn(h('div', 'grp'));
  const signedHead = h('div', 'grp-head');
  signedHead.dataset.deckFade = '1';
  const signedCount = h('span', 'grp-count');
  signedHead.append(h('span', '', COPY.lists.signed), signedCount);
  const signedCard = h('div', 'card');
  signedCard.dataset.deck = '1';
  const signedNote = h('div', 'foot-note', COPY.lists.signedNote);
  signedNote.dataset.deckFade = '1';
  signedGrp.append(signedHead, signedCard, signedNote);
  const signedNodes = new Map<string, HTMLButtonElement>();

  // AI 代答（2026-09-23）：按他自己的资料起草、已经写进网页的那几栏，单列一组，提交前要他核对。
  const aiGrp = markIn(h('div', 'grp'));
  aiGrp.dataset.ai = 'group';
  const aiHead = h('div', 'grp-head');
  aiHead.dataset.deckFade = '1';
  const aiCount = h('span', 'grp-count');
  aiHead.append(h('span', '', COPY.ai.group), aiCount);
  const aiCard = h('div', 'card');
  aiCard.dataset.deck = '1';
  const aiNote = h('div', 'foot-note', COPY.ai.groupNote);
  aiNote.dataset.deckFade = '1';
  aiGrp.append(aiHead, aiCard, aiNote);
  const aiNodes = new Map<string, { item: HTMLElement; row: HTMLButtonElement; value: HTMLElement; act: HTMLElement; again: HTMLButtonElement }>();

  // 答案回来晚了（过了那一下点击的 30 秒）：一个字没写，这里摆一颗「填入 AI 答案」。
  const aiOffer = markIn(h('div', 'ai-offer'));
  aiOffer.dataset.ai = 'offer';
  const aiOfferTitle = h('b', 'ai-offer-title');
  const aiOfferText = h('span', 'ai-offer-text', COPY.ai.readyText);
  const aiOfferButton = tb('btn-secondary ai-offer-btn', (event) => aiApply(event));
  aiOfferButton.dataset.action = 'ai-apply';
  aiOffer.append(aiOfferTitle, aiOfferText, aiOfferButton);
  // 求职信写好的时候那一下点击已经过了 30 秒：一个字没写，这里摆一颗「附上求职信」（与上面那张同一个样子）。
  const letterOffer = markIn(h('div', 'ai-offer'));
  letterOffer.dataset.letter = 'offer';
  const letterOfferTitle = h('b', 'ai-offer-title', COPY.letter.readyTitle);
  const letterOfferText = h('span', 'ai-offer-text', COPY.letter.readyText);
  const letterOfferButton = tb('btn-secondary ai-offer-btn', (event) => letterApply(event));
  letterOfferButton.dataset.action = 'letter-attach';
  letterOffer.append(letterOfferTitle, letterOfferText, letterOfferButton);

  // 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人（同意过旧版本的也在内），一张卡照登那一句（与资料页
  // 那一格逐字相同），「隐私政策」点开就是写明范围的那一节；「同意」一键记到 argoland，「暂不」什么都不改。
  const consentOffer = markIn(h('div', 'consent-offer'));
  consentOffer.dataset.consent = 'offer';
  const consentOfferText = h('p', 'consent-offer-text');
  {
    const sentence = COPY.profile.consentLabel;
    const linkText = COPY.profile.consentLinkText;
    const at = sentence.lastIndexOf(linkText);
    if (at < 0) {
      consentOfferText.textContent = sentence;
    } else {
      const scope = COPY.profile.consentScopePage;
      const link = tb('consent-offer-link', () => { handlers.onOpenPortal?.(scope); }, linkText);
      link.dataset.portal = scope;
      consentOfferText.append(doc.createTextNode(sentence.slice(0, at)), link, doc.createTextNode(sentence.slice(at + linkText.length)));
    }
  }
  const consentOfferActions = h('div', 'consent-offer-actions');
  const consentLater = tb('btn-secondary', () => consentDecline(), COPY.reconsent.later);
  consentLater.dataset.action = 'consent-later';
  const consentAgree = tb('btn-primary', (event) => consentAccept(event));
  consentAgree.dataset.action = 'consent-agree';
  consentOfferActions.append(consentLater, consentAgree);
  consentOffer.append(
    h('b', 'consent-offer-title', COPY.reconsent.title),
    h('span', 'consent-offer-lead', COPY.reconsent.lead),
    consentOfferText,
    consentOfferActions,
  );

  // 其余已填好
  const restGrp = markIn(h('div', 'grp'));
  const restToggle = tb('rest-toggle', () => { restOpen = !restOpen; paint(); });
  restToggle.dataset.deckFade = '1';
  const restCount = h('span', 'grp-count');
  const restChev = h('span', 'rest-chev');
  restChev.append(svg('chevronDown', 14));
  restToggle.append(doc.createTextNode(COPY.lists.rest), restCount, restChev);
  const restFold = h('div', 'fold-rest');
  const restClip = h('div', 'clip');
  restClip.dataset.clip = '1';
  const restCard = h('div', 'card');
  restCard.dataset.deck = '1';
  restClip.append(restCard);
  restFold.append(restClip);
  restGrp.append(restToggle, restFold);
  const restNodes = new Map<string, { row: HTMLElement; q: HTMLElement; v: HTMLElement; opt: HTMLElement }>();
  // 填写途中这张卡就是那一条列表：放得下多高就多高（量一次卡顶到面板底），放不下它自己滚、停在最新那一行。
  const feed = createLiveFeed({
    doc,
    list: restCard,
    reduced,
    maxHeight: () => Math.max(FEED_MIN_HEIGHT, panel.getBoundingClientRect().bottom - restCard.getBoundingClientRect().top - 18),
  });

  // 你的资料
  const dataFold = h('div', 'fold');
  const dataClip = h('div', 'clip');
  const dataGrp = h('div', 'grp');
  const dataHead = h('div', 'grp-head', COPY.lists.yourData);
  dataHead.dataset.homeItem = '1';
  const dataCard = h('div', 'card');
  dataCard.dataset.homeItem = '1';
  const entryButtons: HTMLButtonElement[] = [];
  const entrySubs = new Map<AutofillDockEntry, HTMLElement>();
  const ENTRY_ICONS: Record<AutofillDockEntry, Parameters<typeof icon>[1]> = { AUTOFILL_INFORMATION: 'person', RESUME: 'doc', COVER_LETTER: 'mail' };
  for (const target of ['AUTOFILL_INFORMATION', 'RESUME', 'COVER_LETTER'] as const) {
    const row = tb('drow', () => {
      if (target === 'AUTOFILL_INFORMATION') openProfile();
      handlers.onOpenEntry(target);
    });
    row.dataset.entry = target;
    row.dataset.homeItem = '1';
    const tile = h('span', 'dicon');
    tile.append(svg(ENTRY_ICONS[target], 16, { stroke: 1.8 }));
    const text = h('span', 'dtext');
    const sub = h('span', 'dsub');
    text.append(h('b', 'dtitle', COPY.entries[target].title), sub);
    const end = h('span', 'dend');
    end.append(target === 'AUTOFILL_INFORMATION' ? svg('chevronRight', 14, { color: '#A5AFC0' }) : svg('external', 13, { color: '#A5AFC0' }));
    row.append(tile, text, end);
    dataCard.append(row);
    entryButtons.push(row);
    entrySubs.set(target, sub);
  }
  dataGrp.append(dataHead, dataCard);
  dataClip.append(dataGrp);
  dataFold.append(dataClip);

  // 账号墙（2026-09-28）：主按钮下面一行，说这一家要先有账号、我们会怎么做。
  const acctNote = markIn(h('div', 'acct-note'));
  acctNote.dataset.account = 'wall-note';
  main.append(job, hero, acctNote, banner, consentOffer, aiOffer, letterOffer, needsFold, aiGrp, signedGrp, restGrp, dataFold);

  // 底栏
  const bar = markIn(h('div', 'bar'));
  const barCaption = h('div', 'bar-caption');
  const barRow = h('div', 'bar-row');
  const barSecondary = tb('btn-secondary', (event) => barAct(barSecondary.dataset.act ?? '', event));
  const barPrimary = tb('btn-primary', (event) => barAct(barPrimary.dataset.act ?? '', event));
  barPrimary.dataset.barPrimary = '1';
  const moreBtn = tb('more-btn', () => { menu = menu === 'more' ? '' : 'more'; paintPops(); });
  moreBtn.setAttribute('aria-label', COPY.more);
  moreBtn.dataset.act = 'menu-more';
  moreBtn.append(svg('more', 18));
  barRow.append(barSecondary, barPrimary, moreBtn);
  bar.append(barCaption, barRow);

  // 弹出菜单
  const popAccount = h('div', 'pop pop-account');
  popAccount.dataset.pop = 'account';
  const popHead = h('div', 'pop-head');
  const popName = h('b', 'pop-name');
  const popMail = h('span', 'pop-mail');
  popHead.append(popName, popMail);
  const openPortalItem = tb('pop-item', () => { menu = ''; paintPops(); handlers.onOpenPortal?.('PROFILE'); }, COPY.menu.openPortal);
  const ext = h('span', 'pop-ext');
  ext.append(svg('external', 12, { color: '#8A94A8' }));
  openPortalItem.append(ext);
  const signOutItem = tb('pop-item', (event) => { menu = ''; paintPops(); handlers.onSignOut?.(event, shadow); }, COPY.menu.signOut);
  signOutItem.dataset.action = 'sign-out';
  // AI 代答的开关（2026-09-23，缺省开）：关掉之后不再替他起草，网页上也不摆「用 AI 写」。
  const aiSwitchItem = tb('pop-item', () => toggleAiSwitch());
  aiSwitchItem.dataset.action = 'ai-answers';
  aiSwitchItem.setAttribute('role', 'switch');
  const aiSwitchKnob = h('span', 'pf-toggle pop-toggle');
  aiSwitchKnob.append(h('span', 'pf-knob'));
  aiSwitchItem.append(svg('spark', 15, { color: '#3B4762', stroke: 1.7 }), doc.createTextNode(COPY.ai.switchLabel), aiSwitchKnob);
  // 「记住我的回答」（2026-09-28，没设过就是开）：开着，他在浮层里答的会记下来、下次自动填。
  const memorySwitchItem = tb('pop-item', () => toggleMemorySwitch());
  memorySwitchItem.dataset.action = 'answer-memory';
  memorySwitchItem.setAttribute('role', 'switch');
  const memorySwitchKnob = h('span', 'pf-toggle pop-toggle');
  memorySwitchKnob.append(h('span', 'pf-knob'));
  memorySwitchItem.append(svg('bookmark', 15, { color: '#3B4762', stroke: 1.7 }), doc.createTextNode(COPY.memory.switchLabel), memorySwitchKnob);
  // 语言（2026-09-27）：两个选项各用自己的语言写，谁都认得出；当前那一个标着按下；只在主页上能换（见 onChangeLocale）。
  const languageItem = h('div', 'pop-item pop-lang');
  languageItem.dataset.action = 'language';
  const languageOptions: HTMLButtonElement[] = [];
  const languageChoices = h('span', 'pop-lang-choices');
  for (const [value, label] of [['zh', '中文'], ['en', 'English']] as const) {
    const option = tb('pop-lang-opt', () => {
      if (value === locale || option.disabled) return;
      menu = '';
      paintPops();
      handlers.onChangeLocale?.(value);
    }, label);
    option.dataset.language = value;
    option.setAttribute('aria-pressed', String(value === locale));
    languageOptions.push(option);
    languageChoices.append(option);
  }
  const languageLabel = h('span', 'pop-lang-label');
  languageLabel.textContent = COPY.menu.language;
  languageItem.append(svg('globe', 15, { color: '#3B4762' }), languageLabel, languageChoices);
  // 招聘网站账号：只在明确打开菜单后读取隐藏的站点列表。
  const siteAcctItem = tb('pop-item', () => {
    if (!acctMenuOpen) { openSiteAccounts(); return; }
    acctMenuOpen = false;
    vaultList.clear();
    paintSiteAccounts();
  });
  siteAcctItem.dataset.action = 'site-accounts';
  const siteAcctChev = h('span', 'pop-ext');
  siteAcctChev.append(svg('chevronDown', 12, { stroke: 2.2 }));
  siteAcctItem.append(svg('lock', 15, { color: '#3B4762', stroke: 1.7 }), doc.createTextNode(COPY.siteAccount.menu.item), siteAcctChev);
  const siteAcctBody = h('div', 'acct-menu');
  siteAcctBody.dataset.account = 'menu';
  siteAcctBody.style.display = 'none';
  const vaultList = createDockVaultList(doc, shadow, handlers.vaultManagement, COPY.siteAccount.vaultList);
  popAccount.append(popHead, h('div', 'pop-sep'));
  if (handlers.onChangeLocale !== undefined) popAccount.append(languageItem);
  // 没接处理器就没有这一项（不是藏起来）。
  if (handlers.aiAnswers !== undefined && face !== 'unlinked') popAccount.append(aiSwitchItem);
  if (handlers.answerMemory !== undefined && face !== 'unlinked') popAccount.append(memorySwitchItem);
  if (handlers.vaultManagement !== undefined && face !== 'unlinked') popAccount.append(siteAcctItem, siteAcctBody);
  if (handlers.onOpenPortal !== undefined) popAccount.append(openPortalItem);
  // 没连接的那张脸上只有「登录 ArgoLand」，两者永不同框。
  if (handlers.onSignOut !== undefined && face !== 'unlinked') popAccount.append(signOutItem);

  const popMore = h('div', 'pop pop-more');
  popMore.dataset.pop = 'more';
  // 网站正在翻页（他按的「继续到下一页」还没有结论）时，「重新填写这一页」「回到主页」都等它有了结论（2026-10-03 体检 3a-1）：
  // 新开的一轮会被翻过去之后接着填的那一轮作废，回到首页之后翻页那一轮又会把浮层拉回去。
  const rerunItem = tb('pop-item', (event) => {
    if (phase === 'advancing') return;
    menu = '';
    startAutofill(event);
  });
  rerunItem.dataset.action = 'rerun';
  rerunItem.append(svg('retry', 15, { color: '#3B4762', stroke: 1.8 }), doc.createTextNode(COPY.menu.rerun));
  const editItem = tb('pop-item', () => { menu = ''; paintPops(); openProfile(); handlers.onOpenEntry('AUTOFILL_INFORMATION'); });
  editItem.dataset.action = 'edit-profile';
  editItem.append(svg('person', 15, { color: '#3B4762' }), doc.createTextNode(COPY.menu.editProfile));
  // 回到主页（2026-09-24）：不撤销，网页上写好的都留着；再按「自动填写」就是新的一轮。
  const homeItem = tb('pop-item', () => goHome());
  homeItem.dataset.action = 'home';
  homeItem.append(svg('home', 15, { color: '#3B4762' }), doc.createTextNode(COPY.menu.home));
  const undoItem = tb('pop-item', (event) => { menu = ''; void undo(event); });
  undoItem.dataset.tone = 'danger';
  undoItem.dataset.action = 'undo';
  undoItem.dataset.undo = '1';
  undoItem.append(svg('undo', 15), doc.createTextNode(COPY.menu.undo));
  const undoSep = h('div', 'pop-sep');
  popMore.append(rerunItem, editItem, homeItem);

  pbody.append(head, routes, bar, popAccount, popMore);
  panel.append(pbody);

  // Toast
  const toastWrap = h('div', 'toast-wrap');
  const toastNode = h('div', 'toast');
  toastNode.setAttribute('role', 'status');
  toastNode.dataset.toast = '1';
  toastWrap.append(toastNode);
  toastWrap.style.display = 'none';

  // 网页上那几栏旁边的 AI 标记与卡片：边与小片在面板下面一层（面板盖住它们），卡片在最上面。
  const aiLayer = createAiFieldLayer({
    doc,
    host,
    root,
    shadow,
    reduced,
    tools: () => (aiOn === false ? null : aiTools),
    openPricing: () => handlers.onOpenPortal?.('PRICING'),
    toast: (text) => toast(text),
    copy: COPY,
    ...(handlers.aiMarkStyle?.edge === undefined ? {} : { edgeStyle: handlers.aiMarkStyle.edge }),
    ...(handlers.aiMarkStyle?.badge === undefined ? {} : { badgePosition: handlers.aiMarkStyle.badge }),
  });
  // 带他去那一栏之后在那一栏上亮一下（2026-09-28，fieldFlash.ts）：网页上不常驻任何标记。
  const flash = createFieldFlash({ doc, reduced });
  root.append(aiLayer.marks, flash.element, launcher, panel, aiLayer.cards, toastWrap);

  const profileEditor: DockProfileEditor = createDockProfileEditor(doc, {
    ...(handlers.directory === undefined ? {} : { directory: handlers.directory }),
    ...(handlers.profilePorts === undefined ? {} : { ports: handlers.profilePorts }),
    reduced,
    toast: (text) => toast(text),
    onLeave: () => { route = 'main'; paint(); },
    onSaved: () => { handlers.onPanelOpen?.(); paint(); },
    onOpenPortal: (page) => handlers.onOpenPortal?.(page),
    copy: COPY,
    onError: (code, error) => handlers.onError?.(code, error),
  });
  profileRoute.append(profileEditor.element);

  (doc.body ?? doc.documentElement).append(host);

  // ── 派生量（设计原型 renderVals 的同一套算式）──────────────────────
  /**
   * 这一行他已经办好了：在网站上自己补上的（看得见变了样），或在浮层里当场答上的（那一栏此刻有值，2026-09-28）。
   * 办好了的那一行离开「需要你」。
   */
  const ud = (row: DockRow): boolean =>
    userDid.get(row.key) === true || (answeredHere.has(row.key) && hostFieldHasValue(row.target));
  const needsOf = (): DockRow[] => rows.filter(isNeed);
  const counts = () => {
    const needs = needsOf();
    const needsLeft = needs.filter((row) => !ud(row)).length;
    const signed = rows.filter((row) => row.st === 'signed');
    const ok = rows.filter((row) => row.st === 'ok');
    const ai = rows.filter((row) => row.st === 'ai');
    const total = rows.length;
    const processed = rows.filter((row) => row.st !== 'pending').length;
    const written = rows.filter((row) => row.st === 'written').length;
    return { needs, needsLeft, udCount: needs.length - needsLeft, signed, ok, ai, filled: ok.length + signed.length + ai.length, total, processed, written };
  };
  const filling = (): boolean => phase === 'preparing' || phase === 'filling';
  const doneLike = (): boolean => phase === 'done' || phase === 'advancing' || phase === 'review';
  /** 断了线，而且手上没有正在走的一轮（正在写、正在翻页、正在提交的那一轮走完再换）：主卡换成「已更新」那张卡。 */
  const updatedCard = (): boolean => orphaned && !filling() && !autoAdvancing && !submitting && phase !== 'advancing';
  /**
   * 规则那几遍写完、这一轮还没完时进度卡上那一行：AI 代答在起草就说 AI；AI 有了结局（或没送题）而求职信还在写，就说
   * 求职信（2026-09-28 负责人：信在写，进度框就该还在、写明在写信）。
   */
  const aiDraftingLine = (): string =>
    aiState.kind === 'DRAFTING' ? COPY.ai.drafting(aiState.count)
      : letterState.kind === 'WRITING' ? COPY.letter.writing
        : COPY.ai.drafting(0);
  /**
   * 单子上的行。AI 在起草时，送给它的那几栏还没有结论：画成「正在写」，不列进「需要你」（2026-09-24 测试台 Ashby：
   * 进度卡写着「AI 正在按你的资料填写 6 道题…」，底下却列着同几题「需要你：开放题，要用你自己的话回答」）。收尾时
   * 按终局单子重新算，AI 没写上的照实回到「需要你」。
   */
  const rowsOf = (progress: AutofillDockProgress): DockRow[] => {
    const drafting = aiStep && aiState.kind === 'DRAFTING' ? aiState.targets ?? [] : [];
    // 求职信还在写：那几栏同样还没有结论，画成「正在写」。
    const letterWriting = letterState.kind === 'WRITING' ? letterState.targets : [];
    return progress.rows.map((source, index) => {
      const row = toDockRow(source, index, COPY);
      return row.target !== null && NEED_STATUSES.has(row.st) && (drafting.includes(row.target) || letterWriting.includes(row.target))
        ? { ...row, st: 'writing' as const }
        : row;
    });
  };
  /** 连填这一页在进度卡上的那一行（2026-09-28）；不是连填、或连填已经停下，就是 null（照旧写「正在填写」）。 */
  const chainLine = (): string | null => {
    const state = chain;
    if (state === null || state.stop !== null) return null;
    const page = state.site?.index ?? state.page;
    const total = state.site?.total ?? null;
    return autoAdvancing ? COPY.chain.filled(page, total) : COPY.chain.status(page, total, state.site?.name ?? null);
  };
  const linked = (): boolean => face !== 'unlinked' && face !== 'linking';
  const nextLabel = (): string | null => {
    const next = handlers.nextStep;
    if (next === undefined) return null;
    try {
      const label = next.label();
      return typeof label === 'string' && label.trim() !== '' ? label : null;
    } catch {
      return null;
    }
  };
  /**
   * 这一页后面还有一步（2026-09-28）：网站的「下一步」此刻读得到；或者刚按过这一页的「下一步」、网站没翻；或者网站自己说还有
   * 几步（第 2 步，共 5 步）。知道还有下一步，就绝不说「提交」、底栏一直有「继续到下一页」（按下去的那一刻再找一次那一颗）——
   * 收尾那一刻「下一步」一时读不到（宿主正在重画底栏），不等于到了最后一页。2026-09-28 测试台上有一次就这样说成了
   * 「必填项都填好了 · 去网站上提交」，而且没有「继续到下一页」；按「继续到下一页」之后等网站翻页的那两三秒里，总结也会
   * 说「检查一遍，没问题就可以提交了」（同一天 origin/main 上实测）。
   */
  const moreSteps = (): boolean => {
    if (nextLabel() !== null) return true;
    if (handlers.nextStep === undefined) return false;
    // 正在按这一页的「下一步」、等网站翻页的那几秒（控制器那几秒答不出那一颗的字）：就是还有下一步。
    if (phase === 'advancing' || autoAdvancing) return true;
    if (notAdv !== null || chain?.stop === 'NOT_ADVANCED') return true;
    const site = chain?.site ?? null;
    return site !== null && site.index !== null && site.total !== null && site.index < site.total;
  };
  const submitAvailable = (): boolean => {
    try {
      return handlers.submission?.available() === true;
    } catch {
      return false;
    }
  };
  /**
   * 能替用户按网站的提交时写「提交」；按不了（远程开关没开、这一家的规则没声明最终提交、按钮此刻按不了）
   * 就照实写「去网站上提交」——一颗写着「提交」却不提交的按钮，会让人以为已经投出去了。
   */
  const submitLabel = (): string => (submitAvailable() ? COPY.bar.submit : COPY.bar.submitOnSite);
  const geometry = () => {
    const { w: vw, h: fullH } = vp();
    // 看得见的那一段（不是嵌入帧就是整个视口）：top 是它在这一帧里的位置，vh 是它的高。
    const { top: bandTop, h: vh } = viewBand();
    const narrow = vw < 700;
    const inset = narrow ? 8 : 10;
    const W = narrow || autoWidthCap === null ? fullPanelWidth(vw) : Math.min(fullPanelWidth(vw), autoWidthCap);
    const WW = Math.min(980, vw - 20);
    return { vw, vh, fullH, bandTop, narrow, inset, W, WW };
  };
  /** 面板原来的宽（窄屏几乎铺满，宽屏 380）。 */
  const fullPanelWidth = (vw: number): number => (vw < 700 ? Math.max(280, vw - 16) : Math.min(380, vw - 20));
  /** 自动打开时为了让开网站的按钮收窄到的宽（`autoOpenWidth`）；null = 原来的宽。收起就清掉；他自己收起、再点开就是原来的宽。 */
  let autoWidthCap: number | null = null;
  /**
   * 自动打开之前避开网站右侧的主要按钮（2026-10-04，bench-1003「体验」：1440 宽的视口上，自动打开的浮层盖住了 BambooHR 的
   * 「Apply for This Job」——浮层失败时让他去点的正是它——、Greenhouse 的「Submit application」的右半截、Workday 第 2 页底部的
   * 「Save and Continue」）。按钮由调用方给（内核的 `sitePrimaryActions`：提交控件与名字是申请、提交、下一步的按钮，只认通用
   * 说法）；这里只量它们的横向位置——面板是钉在右边的一整条，页面上下滚动，这一条里的按钮迟早被它盖住。
   * 面板要占的那一条里没有它们：原来的宽；有：收窄到它们右边（至少 320 像素宽）；收不下：这一次先不自动打开，收起按钮
   * 还在，他自己点开就是原来的宽。
   */
  const AUTO_OPEN_MIN_W = 320;
  const AUTO_OPEN_GAP = 12;
  /** 自动打开之前等页面安静：这么久没有新的节点就量（网站的按钮晚出来）。 */
  const AUTO_OPEN_QUIET_MS = 700;
  /** 最多等这么久（从挂上算起）：页面一直在动，到点也量一次。 */
  const AUTO_OPEN_CAP_MS = 5_000;
  const autoOpenTimers: Array<ReturnType<typeof setTimeout>> = [];
  /** 等的这一会儿他自己碰过浮层（点开、收起）：照他的来，不再自动打开。 */
  let touchedBeforeAutoOpen = false;
  let cancelAutoOpen: (() => void) | null = null;
  const autoOpenWidth = (): number | null => {
    const actions = safe(() => handlers.siteActions?.() ?? [], [] as readonly Element[]);
    const { vw, inset, narrow } = geometry();
    const fullW = fullPanelWidth(vw);
    const panelLeft = vw - inset - fullW;
    let blocking = Number.NEGATIVE_INFINITY;
    for (const element of actions) {
      const rect = safe(() => element.getBoundingClientRect(), null);
      if (rect === null || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.right <= panelLeft || rect.left >= vw - inset) continue;
      blocking = Math.max(blocking, rect.right);
    }
    if (blocking === Number.NEGATIVE_INFINITY) return fullW;
    if (narrow) return null;
    const room = Math.floor(vw - inset - blocking - AUTO_OPEN_GAP);
    return room >= AUTO_OPEN_MIN_W ? room : null;
  };

  // ── 「需要你」这一次画成什么样（2026-09-28）──────────────────────────
  /** 调用方说这一栏能不能在浮层里当场答、是什么样的题（mission 那条路没接：一律不能）。 */
  const questionOf = (row: DockRow): DockQuestion | null => {
    const port = answersPort;
    const target = row.target;
    if (port === null || target === null || !target.isConnected) return null;
    return safe(() => port.question(target), null);
  };
  /** 这一栏旁边有「用 AI 写」：AI 开着、这一栏在调用方交来的那几栏里。 */
  const aiWritable = (row: DockRow): boolean =>
    aiOn !== false && aiTools !== null && row.target !== null && aiTools.targets.includes(row.target);
  const controlOf = (row: DockRow): 'multi' | 'single' | 'choice' => {
    const target = row.target;
    if (target === null) return 'single';
    if ((target as HTMLElement).isContentEditable) return 'multi';
    const kind = badgeKindOf(target);
    return kind === 'outside' ? 'choice' : kind;
  };
  const needKind = (row: DockRow): NeedKind => needKindOf(row, {
    question: questionOf(row),
    aiWritable: aiWritable(row),
    letter: row.target !== null && letterReason(row.target) !== null,
    control: controlOf(row),
  });
  /**
   * 收尾时读到的诊断码挂到它说的那一行上（2026-09-28：总结只说一件事）：简历没附上挂在简历那一栏上，读不到保存的
   * 自我认同答案挂在自我认同那几栏上（改说他能照着做的一句）。
   */
  const hintFor = (row: DockRow): string | null => {
    for (const hint of diagHints) {
      if (hint.key.startsWith('RESUME_ATTACHMENT') && row.attachment) return hint.text;
      if (hint.key === 'EEO_ANSWERS_FETCH_FAILED' && row.source.selfIdentification === true) return COPY.needs.why.eeoUnavailable;
    }
    return null;
  };
  /** 每一行下面那一句：照着做就好。 */
  const needWhy = (row: DockRow, kind: NeedKind): string => {
    const note = rowNotes.get(row.key) ?? hintFor(row);
    if (note !== null) return note;
    if (questionOf(row)?.employerContact !== undefined) return COPY.needs.why.employer;
    // 一栏好几项一项都没加上：那份清单（哪几项、为什么）就是这一句；说得出缺哪一国工作许可的，照实说那一国（AI 没找到
    // 依据也不盖过它）。
    if (row.source.notAdded !== undefined || (row.reason === 'JOB_DEPENDENT' && row.source.regionWithoutRecord !== undefined)) return reasonText(row);
    const reason = row.reason ?? '';
    const tried = row.target !== null && AI_TRIED_REASONS.has(reason);
    if (tried && aiNoEvidence.has(row.target!)) return kind === 'write' ? COPY.needs.why.aiNothing : COPY.ai.noEvidence;
    if (tried && aiUnanswered.has(row.target!)) return kind === 'write' ? COPY.needs.why.aiMissed : COPY.ai.unanswered;
    if (kind === 'write' && aiState.kind === 'USED_UP') return COPY.needs.why.aiUsedUp;
    if (kind === 'choose') {
      if (reason === 'NO_OPTION_MATCH') return COPY.needs.why.noMatch(row.hint);
      if (reason === 'AMBIGUOUS_OPTION') return COPY.needs.why.ambiguous(row.hint);
      if (reason === 'OPTIONS_INCOMPLETE') return COPY.needs.why.incomplete;
      if (reason === 'WIDGET_TIMEOUT') return COPY.needs.why.notLoaded;
      if (reason === 'PREFILLED_NEEDS_CONFIRMATION') return COPY.needs.why.suggested;
      if (reason === 'JOB_DEPENDENT' && row.source.regionWithoutRecord === undefined) return COPY.needs.why.jobDependent;
    }
    if (kind === 'write' && reason === 'USER_ONLY') return COPY.needs.why.openQuestion;
    if (kind === 'missing' && row.source.regionWithoutRecord === undefined) {
      if (reason === 'LOW_CONFIDENCE') return COPY.needs.why.unknown;
      if (reason === 'CHOICE_NO_DATA' || questionOf(row)?.kind === 'choice') return COPY.needs.why.missingChoice;
      if (reason === 'NO_VALUE' || reason === 'MISSING_PROFILE') return COPY.needs.why.missing;
    }
    return reasonText(row);
  };
  /**
   * 那一行摆哪几个选项（按与他资料里那句话的接近程度挑）：每画一次都要，选项多的下拉（国家、学校）一次要比几百个，
   * 所以按「行、线索、选项」记下来，变了才重算。
   */
  const chipMemo = new Map<string, { readonly sig: string; readonly chips: string[] }>();
  const chipsFor = (key: string, question: DockQuestion, hint: string | null): string[] => {
    const sig = `${hint ?? ''}\u0001${question.suggested ?? ''}\u0001${question.options.join('\u0002')}`;
    const memo = chipMemo.get(key);
    if (memo !== undefined && memo.sig === sig) return memo.chips;
    const chips = optionChips(question, hint);
    chipMemo.set(key, { sig, chips });
    return chips;
  };
  /** 这一行摆什么动作：选一个是几个真实选项，资料里没有是小输入框或几个选项，写一段是「AI 帮我写」，其余「去这一栏」。 */
  const needAct = (row: DockRow, kind: NeedKind): NeedAct => {
    if (kind === 'write') {
      const offered = aiWritable(row) && !rowNotes.has(row.key) && aiState.kind !== 'USED_UP';
      if (offered || aiWriting.has(row.key) || aiConfirm.has(row.key)) return { kind: 'ai', busy: aiWriting.has(row.key), confirm: aiConfirm.has(row.key) };
      return { kind: 'go', label: 'write' };
    }
    if (kind !== 'choose' && kind !== 'missing') return { kind: 'go', label: 'go' };
    const question = questionOf(row);
    const remember = rememberable(row, kind);
    // 「可以联系你现在的雇主吗」资料里还没答（2026-09-28）：两颗「可以」「不可以」，点了写上网页、记进资料（不进答案记忆）。
    if (question?.employerContact !== undefined) {
      const { yes, no } = question.employerContact;
      return { kind: 'chips', options: [yes, no], labels: [COPY.needs.employer.yes, COPY.needs.employer.no], more: false, busy: answering.get(row.key) ?? null, remember: false };
    }
    if (question?.kind === 'choice') {
      const chips = chipsFor(row.key, question, kind === 'choose' ? row.hint : null);
      if (chips.length > 0) {
        return { kind: 'chips', options: chips, more: kind === 'choose' || chips.length < question.options.length, busy: answering.get(row.key) ?? null, remember };
      }
      if (kind === 'missing' && question.options.length > 0) return { kind: 'select', options: question.options, busy: answering.has(row.key), remember };
      return { kind: 'go', label: 'pick' };
    }
    if (kind === 'missing' && question !== null) return { kind: 'input', long: question.kind === 'long', busy: answering.has(row.key), remember };
    return { kind: 'go', label: kind === 'choose' ? 'pick' : 'go' };
  };
  /** 还没办好的「需要你」，按组排好（「去第一项／下一处」照这个先后走）。 */
  const needItems = (): NeedItem[] => {
    const enabled = phase === 'done';
    const open = needsOf().filter((row) => !ud(row)).map((row) => ({ row, kind: needKind(row) }));
    return NEED_KINDS.flatMap((kind) => open.filter((one) => one.kind === kind)).map(({ row, kind }) => ({
      row, kind, why: needWhy(row, kind), act: needAct(row, kind), enabled,
    }));
  };
  /** 这一次画的那一份（`paint` 一开头算一次，各处共用）。 */
  let needNow: readonly NeedItem[] = [];

  // ── 画 ─────────────────────────────────────────────────────────
  const paintLayout = (): void => {
    const { vh, bandTop, inset, W, WW } = geometry();
    const R = reduced();
    const prof = route === 'profile';
    const right = inset;
    const top = bandTop + inset;
    const width = prof ? WW : W;
    let height = Math.max(220, vh - inset * 2);
    if (handlers.embeddedFrame === true) height = Math.min(height, 760);
    const radius = 20;
    panel.style.right = `${right}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.borderRadius = `${radius}px`;
    panel.style.transform = open ? 'none' : `translateX(${width + 28}px) scale(.985)`;
    panel.style.opacity = open ? '1' : '0';
    panel.style.pointerEvents = open ? 'auto' : 'none';
    // 看不见的部分只是透明着（为了淡入淡出），所以还要用 inert 把它们移出读屏与 Tab 顺序：
    // 否则读屏会念出收起的面板、另一条路由与关着的菜单，键盘也能 Tab 进看不见的按钮。
    panel.toggleAttribute('inert', !open);
    panel.style.transition = R
      ? 'opacity .15s ease'
      : `top .56s ${EASE},height .56s ${EASE},width .56s ${EASE},right .56s ${EASE},border-radius .56s ${EASE},transform .48s ${EASE},opacity .3s ease`;
    main.style.width = `${W}px`;
    main.style.transform = prof ? 'translateX(-24px)' : 'none';
    main.style.opacity = prof ? '0' : '1';
    main.style.pointerEvents = prof ? 'none' : 'auto';
    main.toggleAttribute('inert', prof);
    main.style.transition = R ? 'none' : prof ? `transform .45s ${EASE},opacity .18s ease` : `transform .5s ${EASE} .1s,opacity .32s ease .16s`;
    profileRoute.style.width = `${WW}px`;
    profileRoute.style.transform = prof ? 'none' : 'translateX(32px)';
    profileRoute.style.opacity = prof ? '1' : '0';
    profileRoute.style.pointerEvents = prof ? 'auto' : 'none';
    profileRoute.toggleAttribute('inert', !prof);
    profileRoute.style.transition = R ? 'none' : prof ? `transform .64s ${EASE} .06s,opacity .42s ease .12s` : `transform .4s ${EASE},opacity .16s ease`;
    profileEditor.layout(WW);
    paintToastPosition();
  };

  const paintLauncher = (): void => {
    const shown = !open && !hidden;
    // 连填替他翻页的那几秒也算在填（收起按钮上照旧转圈、写进度）。
    const f = filling() || autoAdvancing;
    const { total, processed, needsLeft } = counts();
    launcher.dataset.show = String(shown);
    launcher.toggleAttribute('inert', !shown);
    launcher.dataset.expanded = String((f || hover) && shown);
    const { vh, bandTop } = geometry();
    launcher.style.top = `${bandTop + launcherTopPx(topRatio, 44, vh)}px`;
    lRing.remove();
    if (f) {
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
      lRing.style.background = `conic-gradient(#0A1128 ${pct}%, rgba(10,17,40,.1) 0)`;
      lIcon.prepend(lRing);
    }
    const badge = phase === 'done' && needsLeft > 0;
    if (badge) {
      lBadge.textContent = String(needsLeft);
      // 挂在收起按钮那一整条上、不在圆按钮里：按钮的圆（悬停时是胶囊）切不到它（css.ts 的 .l-badge）。
      if (!lBadge.isConnected) {
        launcher.append(lBadge);
        if (!reduced()) animate(lBadge, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING });
      }
    } else lBadge.remove();
    lBtn.setAttribute('aria-label', badge ? COPY.launcherWithNeeds(needsLeft) : COPY.launcher);
    lLabel.textContent = f
      ? (aiStep ? COPY.launcherState.aiFilling : phase === 'preparing' ? COPY.launcherState.preparing : COPY.launcherState.filling(processed, total))
      : phase === 'done' ? (needsLeft > 0 ? COPY.launcherState.needs(needsLeft) : COPY.launcherState.allDone)
      : phase === 'review' ? COPY.launcherState.review
      : face === 'ready' && phase === 'idle' ? COPY.launcherState.ready : COPY.launcherState.idle;
    lHide.style.display = hover && !f && shown ? 'flex' : 'none';
    lBtn.setAttribute('aria-expanded', String(open));
  };

  const paintHead = (): void => {
    const prof = route === 'profile';
    brand.style.display = prof ? 'none' : 'flex';
    headBack.style.display = prof ? 'flex' : 'none';
    const account = safe(() => handlers.account?.() ?? null, null);
    avatar.style.display = linked() ? 'flex' : 'none';
    avatar.replaceChildren();
    const initials = account === null ? '' : initialsOf(account.name);
    if (initials !== '') avatar.textContent = initials;
    else avatar.append(svg('person', 15, { stroke: 1.8 }));
    popName.textContent = account?.name ?? '';
    popMail.textContent = account?.email ?? '';
    popHead.style.display = account === null ? 'none' : 'block';
  };

  const setText = (node: HTMLElement, value: string): void => {
    if (node.textContent !== value) node.textContent = value;
  };
  const showIf = (node: HTMLElement, shown: boolean): void => {
    const want = shown ? '' : 'none';
    if (node.style.display !== want) node.style.display = want;
  };

  const paintJob = (): void => {
    const card = safe(() => handlers.jobCard?.() ?? null, null);
    const title = card !== null && card.title.trim() !== '' ? card.title.trim() : COPY.jobFallback(handlers.vendorLabel ?? null);
    const company = card?.company.trim() ?? '';
    const parts = [company, vendor].filter((part) => part !== '');
    if (submitted) parts.push(COPY.submittedTag);
    setText(jobTitle, title);
    setText(jobSub, parts.length > 0 ? parts.join(' · ') : (handlers.hostname ?? ''));
    setText(jobMark, ((company || vendor || 'A')[0] ?? 'A').toUpperCase());
    const facts = card?.facts;
    if (facts !== undefined) paintJobFacts(facts, title, company);
    // 展开只在首页（还没开始填、这一页能填）；一按「自动填写」就收成一行，填完那一幕也是一行。
    setJobSize(facts !== undefined && phase === 'idle' && face === 'ready' ? 'full' : 'compact');
  };

  /** 展开那一面：公司与「厂商 · N 天前」、岗位名、胶囊、薪资、简介、匹配要点、「查看完整岗位详情」。缺哪样就不摆哪样。 */
  const paintJobFacts = (facts: DockJobFacts, title: string, company: string): void => {
    setText(jobCo, company || vendor);
    const age = postedAgo(facts.postedAt ?? null, new Date(), COPY);
    const meta = [company === '' ? '' : vendor, age ?? '', submitted ? COPY.submittedTag : ''].filter((part) => part !== '');
    setText(jobMeta, meta.join(' · '));
    showIf(jobMeta, meta.length > 0);
    setText(jobTitleLg, title);
    const chips = jobChips(facts, COPY);
    const chipsKey = chips.join('\n');
    if (chipsKey !== jobChipsKey) {
      jobChipsKey = chipsKey;
      jobChipRow.replaceChildren(...chips.map((chip) => h('span', 'job-chip', chip)));
    }
    showIf(jobChipRow, chips.length > 0);
    const pay = salaryText(facts.salary, COPY);
    setText(jobPayAmount, pay?.amount ?? '');
    setText(jobPayUnit, pay?.unit ?? '');
    showIf(jobPay, pay !== null);
    const description = (facts.description ?? '').trim();
    setText(jobDesc, description);
    showIf(jobDesc, description !== '');
    // 匹配要点（✓ 长处 / · 差距）：数据源等负责人定，调用方眼下不给——没有就什么都不画，这里也绝不自己编。
    const highlights = (facts.highlights ?? []).filter((item) => item.text.trim() !== '');
    const highlightsKey = highlights.map((item) => `${item.tone}:${item.text}`).join('\n');
    if (highlightsKey !== jobHighlightsKey) {
      jobHighlightsKey = highlightsKey;
      jobHighlights.replaceChildren(...highlights.map((item) => {
        const line = h('li', 'job-hl-item');
        line.dataset.tone = item.tone;
        const mark = h('span', 'job-hl-mark');
        mark.append(item.tone === 'strength' ? svg('check', 11, { stroke: 3 }) : h('span', 'job-hl-dot'));
        line.append(mark, h('span', 'job-hl-text', item.text.trim()));
        return line;
      }));
    }
    showIf(jobHighlights, highlights.length > 0);
    const url = safeDetailUrl(facts.detailUrl);
    if (url === null) jobLink.removeAttribute('href');
    else if (jobLink.getAttribute('href') !== url) jobLink.href = url;
    showIf(jobLink, url !== null);
    showIf(jobMore, chips.length > 0 || pay !== null || description !== '' || highlights.length > 0 || url !== null);
  };

  let jobSize: 'full' | 'compact' = 'compact';
  /** openPanel 画第一帧的那一下（面板自己在滑进来）。 */
  let opening = false;
  const setJobSize = (size: 'full' | 'compact'): void => {
    if (size === jobSize) return;
    const from = jobSize;
    jobSize = size;
    finishJobMorph();
    const moving = open && !opening && route === 'main' && !reduced() && job.isConnected;
    if (from === 'full' && moving) morphJob(size);
    else if (from === 'compact' && moving) growJob();
    else job.dataset.size = size;
  };

  /**
   * 一行 → 展开（同站点详情页的 JobPosting 晚一点才回来、准备阶段按了停止、撤销之后回到首页）：卡片高度过渡
   * （320ms，浮层的 EASE），展开的那几块稍后淡进来——不是一帧里跳成一张高卡。
   */
  const growJob = (): void => {
    const before = job.getBoundingClientRect().height;
    job.dataset.size = 'full';
    const after = job.getBoundingClientRect().height;
    const keep = (running: Animation | null): void => { if (running !== null) jobMorphing.push(running); };
    keep(animate(job, [{ height: `${before}px` }, { height: `${after}px` }], { duration: 320, easing: EASE }));
    for (const part of [jobId, jobTitleLg, jobMore]) {
      keep(animate(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 100, easing: EASE_OUT, fill: 'backwards' }));
    }
  };

  /**
   * 按下「自动填写」：展开的岗位卡收成填完那一幕的那一行（2026-09-24 负责人）。FLIP：卡片从展开时的矩形
   * 过渡到一行的矩形（320ms，浮层的 EASE）；胶囊、薪资、简介、匹配要点在头 120ms 里淡出；大标题一边缩小、
   * 一边移到一行里岗位名的位置，与那一行的岗位名交叉淡入淡出（两处的换行不同，交叉淡化看不出跳）；
   * 首字母方块跟着内边距挪那几像素；「公司 · 厂商」最后淡入。旧的那几块是克隆，摆在原处，动完就拿掉。
   * 系统要求减少动态时直接换（setJobSize 不走这里）。
   */
  let jobGhost: HTMLElement | null = null;
  let jobMorphTimer: ReturnType<typeof setTimeout> | null = null;
  const jobMorphing: Animation[] = [];
  const finishJobMorph = (): void => {
    if (jobMorphTimer !== null) { clearTimeout(jobMorphTimer); jobMorphTimer = null; }
    // 半路又换了样子（比如准备阶段就按了停止）、或浮层被拆：还在跑的几段直接走到终点，卡片立刻是新的样子。
    // 用 finish 不用 cancel：cancel 会让 finished 那个 promise 以 AbortError 拒绝，没人接就成了一条未处理的拒绝。
    for (const running of jobMorphing.splice(0)) {
      try {
        running.finish();
      } catch {
        // 已经结束、或已随节点一起拿掉的动画：卡片此刻的样子就是终点。
      }
    }
    jobGhost?.remove();
    jobGhost = null;
  };
  const morphJob = (size: 'full' | 'compact'): void => {
    const box = job.getBoundingClientRect();
    const at = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
    };
    const fromMark = at(jobMark);
    const fromTitle = at(jobTitleLg);
    const ghost = h('div', 'job-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.toggleAttribute('inert', true);
    const cloneAt = (node: HTMLElement): HTMLElement => {
      const where = at(node);
      const clone = node.cloneNode(true) as HTMLElement;
      clone.style.left = `${where.x}px`;
      clone.style.top = `${where.y}px`;
      clone.style.width = `${where.w}px`;
      clone.style.margin = '0';
      ghost.append(clone);
      return clone;
    };
    const ghostId = cloneAt(jobId);
    const ghostTitle = cloneAt(jobTitleLg);
    const ghostMore = jobMore.style.display === 'none' ? null : cloneAt(jobMore);
    job.dataset.size = size;
    job.append(ghost);
    jobGhost = ghost;
    const toBox = job.getBoundingClientRect();
    const toMark = at(jobMark);
    const toTitle = at(jobTitle);
    const bigSize = Number.parseFloat(win?.getComputedStyle(jobTitleLg).fontSize ?? '') || 20;
    const smallSize = Number.parseFloat(win?.getComputedStyle(jobTitle).fontSize ?? '') || 15;
    const scale = smallSize / bigSize;
    const DURATION = 320;
    const keep = (running: Animation | null): void => { if (running !== null) jobMorphing.push(running); };
    keep(animate(job, [{ height: `${box.height}px` }, { height: `${toBox.height}px` }], { duration: DURATION, easing: EASE }));
    if (ghostMore !== null) animate(ghostMore, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' });
    animate(ghostId, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' });
    ghostTitle.style.transformOrigin = '0 0';
    animate(ghostTitle, [
      { transform: 'none', opacity: 1 },
      { opacity: 1, offset: 0.35 },
      { transform: `translate(${toTitle.x - fromTitle.x}px,${toTitle.y - fromTitle.y}px) scale(${scale})`, opacity: 0 },
    ], { duration: DURATION, easing: EASE, fill: 'forwards' });
    jobTitle.style.transformOrigin = '0 0';
    keep(animate(jobTitle, [
      { transform: `translate(${fromTitle.x - toTitle.x}px,${fromTitle.y - toTitle.y}px) scale(${1 / scale})`, opacity: 0 },
      { opacity: 0, offset: 0.35 },
      { transform: 'none', opacity: 1 },
    ], { duration: DURATION, easing: EASE }));
    keep(animate(jobMark, [{ transform: `translate(${fromMark.x - toMark.x}px,${fromMark.y - toMark.y}px)` }, { transform: 'none' }], { duration: DURATION, easing: EASE }));
    keep(animate(jobSub, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay: 160, easing: EASE_OUT, fill: 'backwards' }));
    jobMorphTimer = setTimeout(finishJobMorph, DURATION + 40);
  };

  const segColor = (row: DockRow, dark: boolean): string => {
    const need = isNeed(row);
    // AI 代答写成的一格是蓝色（与网页上那一栏的蓝边同一个颜色系）：填好了，但要他核对。
    if (row.st === 'ai') return dark ? '#8FB2F5' : '#5B8DEF';
    if (dark) {
      if (row.st === 'ok' || row.st === 'signed') return '#7FD8AE';
      if (need && row.st === 'manual') return '#FF9D4D';
      if (need) return '#FF7A6B';
      if (row.st === 'written') return 'rgba(255,255,255,.55)';
      if (row.st === 'writing') return 'rgba(255,255,255,.32)';
      return 'rgba(255,255,255,.13)';
    }
    if (row.st === 'ok' || row.st === 'signed' || (need && ud(row))) return '#2E8A63';
    if (need && row.st === 'manual') return '#FF9D4D';
    if (need) return '#FF7A6B';
    return '#E3E9F1';
  };

  /** 进度卡底下那一行实时的数（2026-09-28）：是 0 的那几样淡一点，位置不跳。还在读表时不写。 */
  const paintTally = (node: HTMLElement, empty: boolean): void => {
    const counted = tallyOf(rows, (row) => (isNeed(row) ? needKind(row) : null), ud);
    const words = { filled: COPY.tally.filled, ai: COPY.tally.ai, needs: COPY.tally.needs, kept: COPY.tally.kept } as const;
    for (const item of Array.from(node.children) as HTMLElement[]) {
      const part = item.dataset.tally as keyof typeof words | undefined;
      if (part === undefined) continue;
      const value = counted[part];
      setText(item, empty ? '' : words[part](value));
      item.dataset.zero = String(value === 0);
    }
  };

  const paintSegments = (dark: boolean): void => {
    if (heroSegs === null) return;
    const keep = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of rows) {
      keep.add(row.key);
      let node = segNodes.get(row.key);
      if (node === undefined) {
        node = h('span', 'seg');
        segNodes.set(row.key, node);
      }
      node.style.background = segColor(row, dark);
      const want: ChildNode | null = previous === null ? heroSegs.firstChild : previous.nextSibling;
      if (want !== node) heroSegs.insertBefore(node, want);
      previous = node;
    }
    for (const [key, node] of segNodes) if (!keep.has(key)) { node.remove(); segNodes.delete(key); }
  };

  const heroModeNow = (): { mode: HeroMode; key: string } => {
    // 和插件断了线（「已更新」那张卡，2026-10-03）排在验证码卡前面：这一页上插件已经什么都做不了，「填进网站」那一下也没有回音。
    if (updatedCard()) return { mode: 'updated', key: 'updated' };
    // 网站在等他填邮件里的验证码（2026-10-04）：除了上面那张卡，这件事压过一切——表交不出去，别的都可以等。
    if (codeAsk !== null) {
      return { mode: 'code', key: `code:${codeAsk.error ?? ''}:${codeAsk.siteSays ?? ''}:${codeFilledHere || codeAsk.filled}:${codeBusy}:${codeNote ?? ''}:${codeAsk.recipient ?? ''}` };
    }
    if (phase === 'failed') return { mode: 'failed', key: `failed:${failCode ?? ''}` };
    // 账号墙上停下来要他做一件事（输这一家的密码、去邮箱点验证链接、在网站上过人机验证……）：一张卡照实说。
    if (accountAsk !== null) return { mode: 'account', key: `account:${JSON.stringify(accountAsk)}` };
    // 连填替他翻页：还是这张进度卡（黑色），写明正在翻到下一页。
    if (filling() || autoAdvancing) return { mode: 'activity', key: 'activity' };
    if (doneLike()) return { mode: 'summary', key: 'summary' };
    // 账号墙那一页：主按钮写「注册并自动填写」或「登录并自动填写」（换了就重画这颗按钮）。
    if (face === 'ready') return { mode: 'button', key: `button:${accountWall?.action ?? ''}` };
    return { mode: 'face', key: `face:${face}` };
  };

  /** 等他在网站上过的那两种关（人机验证、验证码）：这一轮还在走，他过了关我们接着来。 */
  const ACCOUNT_WAITING: ReadonlySet<string> = new Set(['CAPTCHA', 'VERIFICATION']);

  /**
   * 密码框里按的键不往网页上冒（2026-09-28）：键盘事件会穿出关着的 shadow，网页在冒泡阶段挂的监听（统计、录屏脚本）
   * 读得到按了哪个键。在输入框上就截住。网页在捕获阶段挂的监听截不住——所以共用密码缺省由我们生成，不必输。
   */
  const sealKeys = (input: HTMLInputElement): void => {
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'compositionend']) {
      input.addEventListener(type, (event) => event.stopPropagation());
    }
  };

  /** 卡上那一下（输了这一家的密码、验证过了邮箱）：接着替他登录。与「自动填写」同一个样子：进度卡、准备中。 */
  const startAccountStep = (fire: () => void): void => {
    if (!sheetAllowed) return;
    accountAsk = null;
    chain = null;
    chainHold = false;
    beginPreparing();
    fire();
  };

  /**
   * 账号墙上停下来要他做的那一件事（2026-09-28）：一张卡、一句话、至多一颗按钮。这一家早有账号而密码对不上时，卡上
   * 一格让他输这一家的密码（只存在这台电脑上），按「用这个密码登录」——那一下点击就是接着替他登录的凭证。
   */
  const accountCard = (ask: DockAccountPrompt): HTMLElement => {
    const P = COPY.siteAccount.prompts;
    const wrap = markIn(h('div', 'face'));
    wrap.dataset.account = ask.kind;
    const tile = h('span', 'face-icon');
    const bad = ask.kind === 'FAILED' || ask.kind === 'REJECTED' || ask.kind === 'NO_RESPONSE' || ask.kind === 'UNAVAILABLE' || ask.kind === 'EXPIRED';
    const done = ask.kind === 'CONTINUE_BY_HAND';
    tile.style.background = bad ? '#FDECEA' : done ? '#EAF6F0' : '#FFF3E8';
    tile.style.color = bad ? '#B4483A' : done ? '#2E8A63' : '#A3521B';
    tile.append(svg(bad ? 'alert' : done ? 'check' : ask.kind === 'VERIFY_EMAIL' || ask.kind === 'NO_EMAIL' ? 'mail' : 'lock', 20, { stroke: 1.8 }));
    let title: string; let sub: string;
    if (ask.kind === 'SITE_PASSWORD') { title = P.SITE_PASSWORD.title(ask.site); sub = ask.retry ? P.SITE_PASSWORD.retrySub : P.SITE_PASSWORD.sub(ask.email); }
    else if (ask.kind === 'VERIFY_EMAIL') { title = P.VERIFY_EMAIL.title; sub = P.VERIFY_EMAIL.sub(ask.site, ask.email, ask.mail?.from[0] ?? null); }
    else if (ask.kind === 'OFF' || ask.kind === 'BLOCKED') { title = P[ask.kind].title(ask.site); sub = P[ask.kind].sub; }
    else { title = P[ask.kind].title; sub = P[ask.kind].sub; }
    const text = h('div', '');
    text.append(h('div', 'face-title', title), h('div', 'face-sub', sub));
    wrap.append(tile, text);
    const port = handlers.accountAccess;
    if (ask.kind === 'SITE_PASSWORD' && port !== undefined) {
      const input = h('input', 'pf-input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.placeholder = P.SITE_PASSWORD.placeholder;
      input.setAttribute('aria-label', P.SITE_PASSWORD.placeholder);
      input.dataset.account = 'site-password';
      sealKeys(input);
      const go = tb('btn-primary', (event) => {
        const password = input.value;
        if (password === '') { input.focus(); return; }
        input.value = '';
        startAccountStep(() => port.onSitePassword(password, event, shadow));
      }, P.SITE_PASSWORD.primary);
      go.dataset.action = 'account-site-password';
      wrap.append(input, go, h('div', 'face-sub', P.SITE_PASSWORD.forgot));
    } else if (ask.kind === 'VERIFY_EMAIL' && port !== undefined) {
      const go = tb('btn-primary', (event) => startAccountStep(() => port.onResume(event, shadow)), P.VERIFY_EMAIL.primary);
      go.dataset.action = 'account-resume';
      wrap.append(go);
    } else if (ask.kind === 'CONSENT') {
      // 代填授权那一格在资料编辑器里（与门户资料页同一格）。
      const go = tb('btn-primary', () => { openProfile(); handlers.onOpenEntry('AUTOFILL_INFORMATION'); }, P.CONSENT.primary);
      go.dataset.action = 'account-consent';
      wrap.append(go);
    } else if (ask.kind === 'NO_EMAIL' && port !== undefined) {
      const go = tb('btn-primary', () => { openProfile(); handlers.onOpenEntry('AUTOFILL_INFORMATION'); }, P.NO_EMAIL.primary);
      go.dataset.action = 'account-email';
      wrap.append(go);
    } else if (ACCOUNT_WAITING.has(ask.kind)) {
      const waiting = h('div', 'waiting');
      waiting.append(h('span', 'waiting-dot'), doc.createTextNode(COPY.siteAccount.waiting));
      wrap.append(waiting);
      if (handlers.onStop !== undefined) {
        const stop = tb('btn-ghost', () => stopRun(), COPY.run.stop);
        stop.dataset.action = 'stop';
        wrap.append(stop);
      }
    } else if (ask.kind !== 'OFF') {
      // 他在网站上处理好了（或已经登录了）：这一下就是新的一轮。
      const again = tb('btn-primary', (event) => startAutofill(event));
      again.dataset.action = done ? 'autofill' : 'retry';
      again.style.gap = '7px';
      again.append(svg(done ? 'spark' : 'retry', 15, { stroke: done ? 1.7 : 2 }), doc.createTextNode(done ? COPY.autofill : COPY.siteAccount.retry));
      wrap.append(again);
    }
    return wrap;
  };

  /**
   * 网站要邮件里的验证码（2026-10-04，负责人：验证码第 1 步）：一张卡说清发生了什么、去哪个收件箱找哪一封；他在卡上那一格里
   * 输或粘贴，按「填进网站」——那一下点击就是写进网站的凭证（调用方在派发当中同步取证）。写上之后只说下一步：再按一次
   * 「提交」（只按规则声明的最终提交，还是要他按），或者去网站上按验证钮。插件不读邮件，也不因为填了验证码就提交。
   */
  const codeCard = (ask: DockCodePrompt): HTMLElement => {
    const C = COPY.emailCode;
    const digits = ask.charset === 'DIGITS';
    const filled = codeFilledHere || (ask.filled && ask.error === null);
    const wrap = markIn(h('div', 'face'));
    wrap.dataset.code = ask.error ?? (filled ? 'filled' : 'ask');
    const tile = h('span', 'face-icon');
    const bad = ask.error !== null;
    tile.style.background = bad ? '#FDECEA' : filled ? '#EAF6F0' : '#FFF3E8';
    tile.style.color = bad ? '#B4483A' : filled ? '#2E8A63' : '#A3521B';
    tile.append(svg(bad ? 'alert' : filled ? 'check' : 'mail', 20, { stroke: 1.8 }));
    let title: string; let sub: string;
    if (bad) {
      const said = C.errors[ask.error!];
      title = said.title;
      sub = said.sub;
    } else if (filled) {
      title = C.filled.title;
      sub = ask.next === 'VERIFY' ? C.filled.verify : submitAvailable() && doneLike() ? C.filled.resubmitHere : C.filled.resubmitOnSite;
    } else {
      title = C.title;
      sub = C.ask(ask.site, ask.recipient, ask.mail.from[0] ?? '', ask.mail.from.length > 1, ask.mail.subject, ask.length);
    }
    const text = h('div', '');
    text.append(h('div', 'face-title', title), h('div', 'face-sub', sub));
    if (bad && ask.siteSays !== null) {
      const said = h('div', 'face-sub', C.siteSays(ask.siteSays));
      said.dataset.code = 'site-says';
      text.append(said);
    }
    wrap.append(tile, text);
    const port = handlers.verificationCode;
    if (port === undefined || filled) return wrap;
    const input = h('input', 'pf-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = digits ? 'numeric' : 'text';
    // 位数加几个分隔（「AB12 CD34」「123-456」）的余量；多出来的由内核整理时拒，不在这里截。
    input.maxLength = ask.length + 8;
    input.placeholder = C.placeholder(ask.length, digits);
    input.setAttribute('aria-label', C.placeholder(ask.length, digits));
    input.dataset.code = 'input';
    input.value = codeDraft;
    input.disabled = codeBusy;
    // 他输的验证码不往网页上冒（与这一家的密码同一个口子）。
    sealKeys(input);
    input.addEventListener('input', () => { codeDraft = input.value; });
    const go = tb('btn-primary', (event) => {
      const code = input.value;
      if (code.trim() === '') { input.focus(); return; }
      let pending: Promise<DockCodeOutcome>;
      try {
        // 当场交出去：调用方在派发当中取证，之后才写。
        pending = port.enter(code, event, shadow);
      } catch {
        pending = Promise.resolve('FAILED');
      }
      codeBusy = true;
      codeNote = null;
      paint();
      void pending.catch((): DockCodeOutcome => 'FAILED').then((outcome) => {
        codeBusy = false;
        if (outcome === 'FILLED') {
          codeFilledHere = true;
          codeDraft = '';
          codeNote = null;
        } else {
          codeNote = outcome === 'FORMAT' ? C.notes.FORMAT(ask.length, digits) : C.notes[outcome];
        }
        paint();
      });
    }, codeBusy ? C.entering : C.enter);
    go.dataset.action = 'code-enter';
    go.disabled = codeBusy;
    wrap.append(input, go);
    if (codeNote !== null) {
      const note = h('div', 'face-sub', codeNote);
      note.dataset.code = 'note';
      wrap.append(note);
    }
    wrap.append(h('div', 'face-sub', C.privacy));
    return wrap;
  };

  const buildHeroTop = (mode: HeroMode): HTMLElement => {
    for (const key of Object.keys(heroRefs) as (keyof typeof heroRefs)[]) delete heroRefs[key];
    autofillButton = null;
    if (mode === 'button') {
      const button = tb('hero-btn', (event) => startAutofill(event));
      button.dataset.action = 'autofill';
      button.dataset.act = 'autofill';
      const autoIn = markIn(h('span', 'hero-btn-in'));
      const wall = accountWall;
      autoIn.append(svg('spark', 17, { stroke: 1.7 }), doc.createTextNode(
        wall === null ? COPY.autofill : wall.action === 'REGISTER' ? COPY.siteAccount.register : COPY.siteAccount.signIn));
      if (wall !== null) button.dataset.account = wall.action;
      const subDone = h('span', 'hero-btn-in');
      const dot = h('span', 'done-dot');
      dot.append(svg('check', 10, { stroke: 3.4, color: '#fff' }));
      subDone.append(dot, doc.createTextNode(COPY.submitted));
      button.append(autoIn);
      heroRefs.autoIn = autoIn;
      heroRefs.subDone = subDone;
      autofillButton = button;
      return button;
    }
    if (mode === 'account' && accountAsk !== null) return accountCard(accountAsk);
    if (mode === 'updated') {
      // 插件更新之后的孤儿页（2026-10-03 体检 3e）：照实说，给一颗「刷新页面」（只认他本人的点击）。刷新之后新的内容脚本接上
      // 新的插件；不刷新，这一页上要找插件的按钮一颗都不会有回音。
      const wrap = markIn(h('div', 'face'));
      wrap.dataset.face = 'updated';
      const tile = h('span', 'face-icon');
      tile.style.background = '#EEF4FA';
      tile.style.color = '#0A1128';
      tile.append(svg('retry', 20, { stroke: 1.8 }));
      const text = h('div', '');
      text.append(h('div', 'face-title', COPY.updated.title), h('div', 'face-sub', COPY.updated.sub));
      const reload = tb('btn-primary', () => { win?.location.reload(); }, COPY.updated.reload);
      reload.dataset.action = 'reload';
      wrap.append(tile, text, reload);
      return wrap;
    }
    if (mode === 'code' && codeAsk !== null) return codeCard(codeAsk);
    if (mode === 'activity') {
      const wrap = markIn(h('div', 'act'));
      const status = h('div', 'act-status');
      // 连填时这一行写第几页、这一步叫什么（网站的步骤名可能很长）：放不下就省略号，不把右边的计数挤走。
      const statusText = h('span', 'act-label');
      const count = h('span', 'act-count');
      status.append(h('span', 'spin-light'), statusText, count);
      const ticker = h('div', 'ticker');
      ticker.dataset.ticker = '1';
      const q = h('div', 'ticker-q');
      const v = h('div', 'ticker-v');
      ticker.append(q, v);
      wrap.append(status, ticker);
      heroRefs.status = statusText;
      heroRefs.count = count;
      heroRefs.ticker = ticker;
      heroRefs.tickerQ = q;
      heroRefs.tickerV = v;
      return wrap;
    }
    if (mode === 'summary') {
      const wrap = markIn(h('div', 'sum'));
      const title = h('div', 'sum-title');
      title.dataset.sumTitle = '1';
      const sub = h('div', 'sum-sub');
      const notes = h('div', 'sum-notes');
      wrap.append(title, sub, notes);
      heroRefs.sumTitle = title;
      heroRefs.sumSub = sub;
      heroRefs.sumNotes = notes;
      return wrap;
    }
    if (mode === 'failed') {
      // 连填翻过去之后那一页上没有我们能填的表（2026-09-28）：要他本人过的关卡、一页我们认不出的——照实说那一件事，
      // 卡上的「再试一次」就是他处理好之后接着往下填的那一下。
      // 原因是一件他要先做、或我们还没开放的事（2026-10-04）：那一句标题与说明，不说「这一轮没有完成」、更不说「连不上」。
      const guided = failCode !== null ? COPY.blockedFaces[failCode] : undefined;
      const chainBlocked = failCode !== null && failCode.startsWith('CHAIN_') ? COPY.chain.blocked[failCode.slice('CHAIN_'.length)] : guided;
      const network = chainBlocked === undefined && failCode !== null && NETWORK_CODES.has(failCode);
      const copy = network ? COPY.failed.network : COPY.failed.unknown;
      const wrap = markIn(h('div', 'failed'));
      const tile = h('span', 'face-icon');
      tile.style.background = chainBlocked === undefined ? '#FDECEA' : '#FFF3E8';
      tile.style.color = chainBlocked === undefined ? '#B4483A' : '#A3521B';
      tile.append(guided !== undefined ? svg('doc', 20, { stroke: 1.7 }) : chainBlocked !== undefined ? svg('lock', 20, { stroke: 1.8 }) : network ? svg('cloudOff', 20, { stroke: 1.8 }) : svg('alert', 20, { stroke: 1.8 }));
      const text = h('div', '');
      const known = failCode !== null ? COPY.outcomes[failCode] ?? COPY.outcomes[failCode.split(':')[0] ?? ''] : undefined;
      text.append(h('div', 'face-title', chainBlocked?.title ?? copy.title), h('div', 'face-sub', chainBlocked?.sub ?? (network ? copy.sub : known ?? copy.sub)));
      const retry = tb('btn-primary', (event) => startAutofill(event));
      retry.dataset.action = 'retry';
      retry.style.gap = '7px';
      retry.append(svg('retry', 15, { stroke: 2 }), doc.createTextNode(COPY.failed.retry));
      wrap.append(tile, text, retry);
      if (failAction !== null) {
        const action = failAction;
        const openForm = tb('btn-secondary', () => action.onClick(), COPY.failed.openForm);
        openForm.dataset.action = 'open-form';
        wrap.append(openForm);
      }
      const tech = h('div', 'tech');
      tech.dataset.open = String(techOpen);
      const toggle = tb('tech-toggle', () => { techOpen = !techOpen; tech.dataset.open = String(techOpen); });
      toggle.dataset.action = 'toggle-tech';
      const chev = h('span', 'tech-chev');
      chev.append(svg('chevronDown', 12, { stroke: 2.2 }));
      toggle.append(doc.createTextNode(COPY.failed.tech), chev);
      const body = h('div', 'tech-body');
      const clip = h('div', 'clip');
      const code = h('div', 'tech-code');
      const copyBtn = tb('tech-copy', () => {
        const text = code.textContent ?? '';
        // 复制没成（没有剪贴板、被拒）就照实说，不说「已复制」（2026-10-04 体检「吞掉的错」第 7 条）。
        const failed = (): void => {
          toast(COPY.failed.copyFailed);
          handlers.onDiagnostic?.('DOCK_COPY_FAILED');
        };
        let copying: Promise<void> | undefined;
        try {
          copying = win?.navigator?.clipboard?.writeText?.(text);
        } catch {
          copying = undefined;
        }
        if (copying === undefined) failed();
        else void copying.then(() => toast(COPY.failed.copied), failed);
      });
      copyBtn.append(svg('copy', 13, { stroke: 1.8 }), doc.createTextNode(COPY.failed.copy));
      clip.append(code, copyBtn);
      body.append(clip);
      tech.append(toggle, body);
      wrap.append(tech);
      heroRefs.techCode = code;
      heroRefs.tech = tech;
      return wrap;
    }
    // 其余几张脸
    const wrap = markIn(h('div', 'face'));
    const tile = h('span', 'face-icon');
    let title = ''; let sub = '';
    const iconColor = (bg: string, fg: string) => { tile.style.background = bg; tile.style.color = fg; };
    if (face === 'unlinked') {
      iconColor('#EEF4FA', '#0A1128');
      tile.append(logo(doc, 28));
      title = COPY.faces.unlinked.title; sub = COPY.faces.unlinked.sub;
    } else if (face === 'linking') {
      iconColor('#EEF4FA', '#0A1128');
      tile.append(h('span', 'spin-dark'));
      title = COPY.faces.linking.title; sub = COPY.faces.linking.sub;
    } else if (face === 'dormant' || face === 'noForm') {
      iconColor('#EEF4FA', '#0A1128');
      tile.append(svg('doc', 20, { stroke: 1.7 }));
      const copy = face === 'dormant' ? COPY.faces.dormant : COPY.faces.noForm;
      title = copy.title; sub = copy.sub;
    } else if (face === 'rules') {
      iconColor('#FFF3E8', '#A3521B');
      tile.append(svg('clock', 20, { stroke: 1.8 }));
      title = COPY.faces.rules.title; sub = COPY.faces.rules.sub;
    } else if (face === 'closed') {
      // 这一家还没在运行时包里放行（2026-10-04）：不是连不上，也不是认不出——照实说，不摆按钮。
      iconColor('#EEF4FA', '#0A1128');
      tile.append(svg('doc', 20, { stroke: 1.7 }));
      title = COPY.faces.closed.title; sub = COPY.faces.closed.sub;
    } else {
      iconColor('#FFF3E8', '#A3521B');
      tile.append(svg('lock', 20, { stroke: 1.8 }));
      title = COPY.faces.signin.title(handlers.vendorLabel ?? null); sub = COPY.faces.signin.sub;
    }
    const text = h('div', '');
    text.append(h('div', 'face-title', title), h('div', 'face-sub', sub));
    wrap.append(tile, text);
    if (face === 'signin') {
      const waiting = h('div', 'waiting');
      waiting.append(h('span', 'waiting-dot'), doc.createTextNode(COPY.faces.signin.waiting));
      wrap.append(waiting);
    }
    if (face === 'unlinked') {
      const login = tb('btn-primary', () => {
        handlers.onOpenPortal?.('CONNECT');
        flipPrep();
        face = 'linking';
        paint();
      });
      login.dataset.action = 'login';
      login.disabled = handlers.onOpenPortal === undefined;
      login.append(doc.createTextNode(COPY.faces.unlinked.primary), svg('arrowRight', 15, { stroke: 2 }));
      wrap.append(login);
    }
    if (face === 'linking') {
      const cancel = tb('btn-ghost', () => { flipPrep(); face = 'unlinked'; paint(); }, COPY.faces.linking.ghost);
      cancel.dataset.action = 'cancel-login';
      wrap.append(cancel);
    }
    if (face === 'rules' && handlers.onRecheck !== undefined) {
      const recheck = tb('btn-secondary', () => {
        if (checking) return;
        checking = true;
        recheck.textContent = COPY.faces.rules.checking;
        handlers.onRecheck?.();
        setTimeout(() => {
          checking = false;
          if (recheck.isConnected) recheck.textContent = COPY.faces.rules.secondary;
        }, 2400);
      }, COPY.faces.rules.secondary);
      recheck.dataset.action = 'recheck';
      wrap.append(recheck);
    }
    return wrap;
  };

  /**
   * 当前这一项：每换一项上滑淡入（260ms）。真实的页一栏常常只要几十毫秒，逐个换会一直停在淡入的
   * 头几帧、什么都看不清——所以每一项至少停 350ms，期间来的新项只记下最新的那一个。
   */
  let tickerWant: { key: string; q: string; v: string } | null = null;
  let tickerShownAt = 0;
  let tickerTimer: ReturnType<typeof setTimeout> | null = null;
  const TICKER_DWELL_MS = 350;
  const applyTicker = (): void => {
    tickerTimer = null;
    const want = tickerWant;
    if (want === null || heroRefs.tickerQ === undefined || heroRefs.tickerV === undefined) return;
    const changed = want.key !== tickerKey;
    heroRefs.tickerQ.textContent = want.q;
    heroRefs.tickerV.textContent = want.v;
    if (!changed) return;
    const first = tickerKey === '';
    tickerKey = want.key;
    tickerShownAt = Date.now();
    if (!first && !reduced()) animate(heroRefs.ticker, [{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE_OUT });
  };
  const showTicker = (key: string, q: string, v: string): void => {
    tickerWant = { key, q, v };
    if (key === tickerKey) { applyTicker(); return; }
    // 只有逐栏的那几项要停够时间；准备阶段那几句一来就换。
    const wait = tickerKey === '' || !key.startsWith('row:') ? 0 : TICKER_DWELL_MS - (Date.now() - tickerShownAt);
    if (wait <= 0) { if (tickerTimer !== null) clearTimeout(tickerTimer); applyTicker(); return; }
    if (tickerTimer === null) tickerTimer = setTimeout(applyTicker, wait);
  };

  const paintHero = (): void => {
    const { mode, key } = heroModeNow();
    const dark = mode === 'button' || mode === 'activity';
    hero.dataset.dark = String(dark);
    hero.dataset.press = mode === 'button' ? '1' : '';
    hero.style.background = '';
    hero.style.boxShadow = '';
    if (key !== heroModeKey) {
      heroModeKey = key;
      heroMode = mode;
      const top = buildHeroTop(mode);
      if (heroTop !== null) heroTop.replaceWith(top);
      else hero.prepend(top);
      heroTop = top;
    }
    // 进度条：填写中与填完是同一个元素，只换颜色。
    const c = counts();
    const hasBar = mode === 'activity' || (mode === 'summary' && c.total > 0);
    const barKind: 'shimmer' | 'segs' | null = !hasBar ? null : mode === 'activity' && phase === 'preparing' ? 'shimmer' : 'segs';
    if (barKind === null) {
      heroBar?.remove();
      heroBar = null;
      heroBarKind = null;
      heroSegs = null;
      segNodes.clear();
    } else {
      if (heroBar === null) {
        heroBar = h('div', 'hbar');
        heroTop?.after(heroBar);
      }
      if (heroBarKind !== barKind) {
        heroBarKind = barKind;
        heroBar.replaceChildren();
        segNodes.clear();
        heroSegs = null;
        if (barKind === 'shimmer') {
          const shimmer = h('div', 'shimmer');
          shimmer.append(h('span', ''));
          heroBar.append(shimmer);
        } else {
          heroSegs = h('div', 'segs');
          heroBar.append(heroSegs);
        }
      }
      if (heroTop !== null && heroBar.previousElementSibling !== heroTop) heroTop.after(heroBar);
      paintSegments(mode === 'activity');
    }
    // 底部：进度卡的图例与「停止」，总结卡下面留 14px。
    const bottomKind = mode === 'activity' ? 'legend' : mode === 'summary' ? 'gap' : null;
    if (bottomKind === null) {
      heroBottom?.remove();
      heroBottom = null;
    } else if (heroBottom === null || heroBottom.dataset.kind !== bottomKind) {
      heroBottom?.remove();
      if (bottomKind === 'legend') {
        heroBottom = h('div', 'legend');
        // 实时的数（2026-09-28）：已填 · AI 写的 · 需要你 · 按规定不代填。只数，不编百分比。
        const tally = h('span', 'tally');
        for (const part of ['filled', 'ai', 'needs', 'kept'] as const) {
          const item = h('span', 'tally-item');
          item.dataset.tally = part;
          tally.append(item);
        }
        heroBottom.append(tally);
        heroRefs.tally = tally;
        if (handlers.onStop !== undefined) {
          const stop = tb('stop', () => stopRun(), COPY.run.stop);
          stop.dataset.action = 'stop';
          heroBottom.append(stop);
        }
      } else heroBottom = h('div', 'sum-gap');
      heroBottom.dataset.kind = bottomKind;
      hero.append(heroBottom);
    } else if (bottomKind === 'legend' && heroRefs.tally === undefined) {
      heroRefs.tally = heroBottom.querySelector<HTMLElement>('.tally') ?? undefined;
    }

    if (mode === 'activity') {
      // 那一行说此刻在做什么（2026-09-28）：读表单、对照资料、匹配选项、填第几段经历、等 AI、写求职信；连填写第几页。
      // AI 代答在起草：不写计数——规则那几遍都结算了，数出来就成了「4 / 4」。
      if (heroRefs.status) {
        heroRefs.status.textContent = activityStatus({
          preparing: phase === 'preparing' && !aiStep,
          prep,
          ai: aiStep && aiState.kind === 'DRAFTING',
          letter: aiStep && aiState.kind !== 'DRAFTING' && letterState.kind === 'WRITING',
          chain: chainLine(),
          rows,
        }, COPY);
      }
      if (heroRefs.count) heroRefs.count.textContent = phase === 'preparing' || aiStep ? '' : `${c.processed} / ${c.total}`;
      if (heroRefs.tally) paintTally(heroRefs.tally, phase === 'preparing' && !aiStep);
      let q = ''; let v = ''; let key2 = '';
      if (autoAdvancing) {
        q = COPY.chain.advancing;
        v = autoAdvanceLabel === null ? '' : COPY.chain.pressing(autoAdvanceLabel);
        key2 = 'chain-advance';
      } else if (aiStep || phase === 'preparing') {
        // 上面那一行说在做什么（读表单、对照资料、等 AI）；这里写在为哪一份申请做（岗位名），翻页、mission 那条路的那几句照旧。
        const title = safe(() => handlers.jobCard?.()?.title.trim() ?? '', '');
        q = aiStep ? aiDraftingLine() : prepLabel ?? (title !== '' ? title : COPY.jobFallback(handlers.vendorLabel ?? null));
        v = [safe(() => handlers.jobCard?.()?.company ?? '', ''), vendor].filter((part) => part !== '').join(' · ');
        key2 = `${aiStep ? 'ai' : 'prep'}:${q}`;
      } else if (current !== undefined && current.rows.length === 0 && typeof (current as { phase?: unknown }).phase === 'string') {
        // 联调包的运行：只有阶段与计数。
        q = dockRunSummary(current as DockRunProgress, COPY);
        key2 = `phase:${q}`;
      } else {
        const cur = rows.find((row) => row.st === 'writing') ?? [...rows].reverse().find((row) => row.st === 'written');
        if (cur !== undefined) {
          q = cur.q;
          // 正在写的那一栏：上面那一行已经说了在做什么（匹配选项、填第几段经历……），这里只写题目；写上了的写值。
          v = cur.st === 'writing' ? '' : cur.checkbox ? COPY.run.checked : cur.value ?? '';
          key2 = `row:${cur.key}`;
        } else {
          q = COPY.run.confirming;
          key2 = 'confirming';
        }
      }
      showTicker(key2, q, v);
    } else { tickerKey = ''; tickerWant = null; }
    if (mode === 'summary' && heroRefs.sumTitle && heroRefs.sumSub) {
      const wd = moreSteps();
      // 连填（2026-09-28）停下了：为什么。填到头了一句话总结；半路停下只说他要做的那一件事。
      const why = chain?.stop ?? null;
      const wall = why === 'LOGIN' || why === 'VERIFICATION' || why === 'CAPTCHA' ? why : null;
      let title: string; let sub: string;
      if (phase === 'review') {
        if (chain !== null && chain.donePages > 0) { title = COPY.chain.doneTitle; sub = COPY.chain.doneSub(chain.donePages, chain.doneFields, !submitAvailable()); }
        else { title = COPY.summary.review.title; sub = COPY.summary.review.sub; }
      }
      else if (stopped) { title = COPY.summary.stopped.title; sub = COPY.summary.stopped.sub(c.filled); }
      else if (wall !== null) { title = COPY.chain.walls[wall].title; sub = COPY.chain.walls[wall].sub; }
      else if (c.needsLeft > 0) {
        // 总结只说一件事（2026-09-28）：还有几项；下面一句只说填好了多少。每一项在下面的单子里，主按钮带他去第一项。
        title = COPY.summary.needs(c.needsLeft, wd);
        sub = COPY.summary.filledSub(c.filled, c.ai.length);
      } else if (why === 'SITE_ERRORS') {
        // 网站自己在这一页上标着错（2026-10-04）：不说「这一页填好了」，也没替他按「下一步」。
        title = COPY.chain.siteErrors.title;
        sub = COPY.chain.siteErrors.sub;
      } else if (why === 'REVIEW' && chain !== null && chain.donePages > 0) {
        // 连着填到了最后一页（最终提交就在这一页上、或这一页没有下一步了）：算上这一页。
        title = COPY.chain.doneTitle;
        sub = COPY.chain.doneSub(chain.donePages + 1, chain.doneFields + c.filled, !submitAvailable());
      } else if (c.total === 0 && handBack) { title = COPY.handBack.title; sub = COPY.handBack.sub; }
      else if (c.total === 0) { title = COPY.summary.nothing.title; sub = COPY.summary.nothing.sub; }
      else if (wd && (why === 'PAGE_CAP' || why === 'TIME_CAP') && chain !== null) {
        title = COPY.summary.pageDone.title;
        sub = why === 'PAGE_CAP' ? COPY.chain.pageCap(chain.maxPages) : COPY.chain.timeCap;
      }
      // 翻页按钮说不清（不止一颗、或读不出页面）：不说「都填好了、可以提交」——后面可能还有。
      else if (why === 'UNAVAILABLE' && chain !== null) { title = COPY.summary.pageDone.title; sub = COPY.chain.unavailable; }
      else if (wd) { title = COPY.summary.pageDone.title; sub = c.ai.length > 0 ? COPY.sentences(COPY.ai.filled(c.filled, c.ai.length), COPY.summary.pageDone.sub) : COPY.summary.pageDone.sub; }
      else { title = COPY.summary.allDone.title; sub = c.ai.length > 0 ? COPY.sentences(COPY.ai.filled(c.filled, c.ai.length), COPY.summary.allDone.sub) : COPY.summary.allDone.sub; }
      heroRefs.sumTitle.textContent = title;
      heroRefs.sumSub.textContent = sub;
      // 说明挂到它说的那一行上（2026-09-28：简历没附上挂在简历那一栏、读不到保存的答案挂在自我认同那几栏、AI 次数用完挂在
      // 要写的那几题、按默认答的工作授权与没加全的那几项在「提交前核对」里）。挂不上的简历说明才留在这里。
      const notes: HTMLElement[] = [];
      for (const hint of diagHints) {
        if (!hint.key.startsWith('RESUME_ATTACHMENT') || needNow.some((item) => item.row.attachment)) continue;
        notes.push(h('div', 'sum-note', hint.text));
      }
      // 连填半路停下：前面几页已经填好了（放在最前）；这一页还有要他处理的，说处理好之后怎么接着填。
      if (chain !== null && why !== null && why !== 'REVIEW' && why !== 'STOPPED' && phase !== 'review' && chain.donePages > 0) {
        const line = h('div', 'sum-note', COPY.chain.sofar(chain.donePages));
        line.dataset.chain = 'sofar';
        notes.unshift(line);
      }
      if (chain !== null && why === 'NEEDS_USER' && c.needsLeft > 0 && wd && !stopped) {
        const line = h('div', 'sum-note', COPY.chain.needsNext);
        line.dataset.chain = 'needs-next';
        notes.push(line);
      }
      // 替他在招聘网站上注册、登录（2026-09-28）：每一件都照实写，放在最前。
      notes.unshift(...accountDone.map((line) => {
        const node = h('div', 'sum-note', line);
        node.dataset.account = 'done';
        return node;
      }));
      heroRefs.sumNotes?.replaceChildren(...notes);
    }
    if (mode === 'failed' && heroRefs.techCode) {
      const codes = [...new Set([failCode ?? 'UNKNOWN', ...failDiagnostics])];
      const version = handlers.extensionVersion ?? '';
      heroRefs.techCode.textContent = [...codes, ...(version === '' ? [] : [`ext ${version}`]), localStamp(new Date())].join(' · ');
    }
  };

  const paintBanner = (): void => {
    const c = counts();
    // 验证码那张卡在的时候不再亮红条：卡上已经照实说了要他做什么。
    const show = phase === 'done' && codeAsk === null && (notAdv !== null || submitNote !== null);
    banner.style.display = show ? 'grid' : 'none';
    if (!show) { delete banner.dataset.shown; return; }
    if (submitNote !== null) {
      banner.dataset.ok = 'false';
      bannerMark.textContent = '!';
      const copy = submitNote === 'NOT_SUBMITTED' ? COPY.banner.notSubmitted : COPY.banner.unconfirmed;
      bannerTitle.textContent = copy.title;
      bannerBody.textContent = copy.text;
      return;
    }
    const stuck = c.needsLeft > 0 || (notAdv !== null && notAdv.needsAtClick === 0);
    const fixed = c.needsLeft === 0 && notAdv !== null && notAdv.needsAtClick > 0;
    banner.dataset.ok = String(fixed);
    bannerMark.textContent = fixed ? '✓' : '!';
    bannerTitle.textContent = fixed ? COPY.banner.fixed.title : COPY.banner.stuck.title;
    bannerBody.textContent = fixed ? COPY.banner.fixed.text
      : c.needsLeft > 0 ? COPY.banner.stuck.text(c.needsLeft)
      : stuck ? COPY.banner.stuck.filled : '';
  };

  /** 这几类原因说的是「我们用资料答不了」——送给了 AI、AI 也没找到依据的，照实改说 AI 没找到依据。 */
  const AI_TRIED_REASONS: ReadonlySet<string> = new Set(['LOW_CONFIDENCE', 'USER_ONLY', 'CHOICE_NO_DATA', 'JOB_DEPENDENT']);
  /** 搜索式多选没加上的几项，按原因分组（原因与别处同一句话；时间用完的说「没来得及」）。 */
  const notAddedText = (missed: NonNullable<DockRow['source']['notAdded']>): string => {
    const groups = new Map<string, string[]>();
    for (const miss of missed) {
      const why = miss.reason === 'ABORTED' ? COPY.notAdded.late : COPY.reasons[miss.reason] ?? '';
      groups.set(why, [...(groups.get(why) ?? []), miss.value]);
    }
    return COPY.notAdded.list([...groups].map(([why, values]) => ({ values, why })));
  };
  /** 一段经历／教育（全加全存，2026-09-24）的那一行：没存上的说还差什么，没加上的说为什么、接下来怎么办。 */
  const entryReason = (row: DockRow): string | null => {
    const unsaved = row.source.unsavedEntry;
    if (unsaved !== undefined) {
      return unsaved.missing !== undefined
        ? COPY.unsavedEntry.missing(unsaved.missing, unsaved.saveLabel)
        : row.reason === 'HOST_REJECTED' ? COPY.unsavedEntry.rejected(unsaved.saveLabel) : COPY.unsavedEntry.reason(unsaved.saveLabel);
    }
    const unadded = row.source.unaddedEntries;
    if (unadded === undefined) return null;
    return unadded.afterUnsaved ? COPY.unsavedEntry.notAdded.afterUnsaved
      : row.reason === 'CLICK_DENIED' ? COPY.unsavedEntry.notAdded.editorOpen : COPY.unsavedEntry.notAdded.again;
  };
  /** 求职信那几栏的行上说什么（没有求职信的状态就是 null，照旧按原因码说）。 */
  const letterReason = (target: Element): string | null => {
    const state = letterState;
    if (state.kind === 'IDLE' || state.kind === 'ATTACHED' || !state.targets.includes(target)) return null;
    if (state.kind === 'WRITING') return COPY.letter.writing;
    if (state.kind === 'READY') return COPY.letter.readyRow;
    return COPY.letter.refused[state.code];
  };
  const reasonText = (row: DockRow): string =>
    row.source.notAdded !== undefined
      ? notAddedText(row.source.notAdded)
      : entryReason(row) ?? (row.reason === 'JOB_DEPENDENT' && row.source.regionWithoutRecord !== undefined
      ? COPY.workAuth.noRecord(row.source.regionWithoutRecord)
      : row.target !== null && letterReason(row.target) !== null
        ? letterReason(row.target) ?? ''
      : row.target !== null && aiNoEvidence.has(row.target) && AI_TRIED_REASONS.has(row.reason ?? '')
        ? COPY.ai.noEvidence
        : row.target !== null && aiUnanswered.has(row.target) && AI_TRIED_REASONS.has(row.reason ?? '')
          ? COPY.ai.unanswered
          : COPY.reasons[row.reason ?? ''] ?? '');

  /**
   * 「需要你」（2026-09-28）：按要做的事分组，每一行一个明摆着的动作。办好了的那一行离开列表（`needsView` 负责过渡）。
   */
  const paintNeeds = (): void => {
    // 填写途中不摆（那时是进度卡下面那一条列表的事，底下那一行的数里写着「需要你」几项）；收尾之后接过焦点。
    const show = doneLike() && needNow.length > 0;
    needsFold.dataset.open = String(show);
    needsView.paint(show ? needNow : []);
  };

  const paintSigned = (): void => {
    const c = counts();
    const show = c.signed.length > 0 && doneLike();
    signedGrp.style.display = show ? 'block' : 'none';
    if (!show) delete signedGrp.dataset.shown;
    signedCount.textContent = String(c.signed.length);
    const canLoc = phase === 'done';
    const keep = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of c.signed) {
      keep.add(row.key);
      let node = signedNodes.get(row.key);
      if (node === undefined) {
        node = tb('nrow', () => locate(row.key));
        node.dataset.act = 'locate';
        node.dataset.signed = row.key;
        const glyph = h('span', 'glyph');
        glyph.dataset.kind = 'sign';
        glyph.append(svg('signature', 13, { stroke: 2.2 }));
        const text = h('span', 'ntext');
        text.append(h('span', 'nq', row.q), h('span', 'nsign', row.signed === null || row.signed === undefined ? '' : COPY.signed[row.signed]));
        const loc = h('span', 'nloc');
        loc.append(svg('locate', 16, { stroke: 1.8 }));
        node.append(glyph, text, loc);
        signedNodes.set(row.key, node);
      }
      node.disabled = !canLoc;
      const want: ChildNode | null = previous === null ? signedCard.firstChild : previous.nextSibling;
      if (want !== node) signedCard.insertBefore(node, want);
      previous = node;
    }
    for (const [key, node] of signedNodes) if (!keep.has(key)) { node.remove(); signedNodes.delete(key); }
  };

  /** AI 代答写成的那几栏：一组，逐行写着问题与 AI 写进去的内容，点一下滚到那一栏。 */
  const paintAi = (): void => {
    const c = counts();
    const show = c.ai.length > 0 && doneLike();
    aiGrp.style.display = show ? 'block' : 'none';
    if (!show) delete aiGrp.dataset.shown;
    aiCount.textContent = String(c.ai.length);
    const canLoc = phase === 'done';
    const keep = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of c.ai) {
      keep.add(row.key);
      let node = aiNodes.get(row.key);
      if (node === undefined) {
        const item = h('div', 'ai-item');
        const button = tb('nrow', () => locate(row.key));
        button.dataset.act = 'locate';
        button.dataset.aiRow = row.key;
        const glyph = h('span', 'glyph');
        glyph.dataset.kind = 'ai';
        glyph.append(svg('spark', 13, { stroke: 1.9 }));
        const text = h('span', 'ntext');
        const value = h('span', 'nai');
        text.append(h('span', 'nq', row.q), value);
        const loc = h('span', 'nloc');
        loc.append(svg('locate', 16, { stroke: 1.8 }));
        button.append(glyph, text, loc);
        // 「换一个说法」（2026-09-28）：AI 写的那一段不满意，一下让它换一种说法（单栏 AI 那一条路，原来那一段进撤销日志）。
        const act = h('div', 'need-act ai-act');
        const again = tb('need-link', (event) => aiRephrase(row.key, event));
        again.dataset.action = 'ai-rephrase';
        item.append(button, act);
        node = { item, row: button, value, act, again };
        aiNodes.set(row.key, node);
      }
      node.value.textContent = row.checkbox ? COPY.run.checked : row.value ?? '';
      node.row.disabled = !canLoc;
      node.row.setAttribute('aria-label', COPY.lists.locateAria(row.q));
      const revisable = canLoc && !row.checkbox && aiOn !== false && aiTools !== null && row.target !== null && aiTools.targets.includes(row.target);
      if (revisable && !node.again.isConnected) node.act.append(node.again);
      if (!revisable && node.again.isConnected) node.again.remove();
      const busy = rephrasing.has(row.key);
      node.again.disabled = busy;
      node.again.replaceChildren();
      if (busy) node.again.append(h('span', 'spin-dark need-spin'), doc.createTextNode(COPY.ai.rephrasing));
      else node.again.append(svg('spark', 13, { stroke: 1.9 }), doc.createTextNode(rephraseConfirm.has(row.key) ? COPY.ai.rephraseFill : COPY.ai.rephrase));
      const want: ChildNode | null = previous === null ? aiCard.firstChild : previous.nextSibling;
      if (want !== node.item) aiCard.insertBefore(node.item, want);
      previous = node.item;
    }
    for (const [key, node] of aiNodes) if (!keep.has(key)) { node.item.remove(); aiNodes.delete(key); }
  };

  /**
   * 「换一个说法」（2026-09-28）：AI 写的那一段，一下让它换一种说法。与网页上「AI 改写」同一条路（这一下点击就是写入的凭证，
   * 调用方在派发当中同步取证；写之前他自己动过那一栏就不写；原来那一段进撤销日志）。说给 AI 的那句要求不给用户看，写成英文、
   * 让它保持原来的语言与长短。
   */
  const aiRephrase = (key: string, event: MouseEvent): void => {
    const row = rows.find((one) => one.key === key);
    const target = row?.target ?? null;
    const tools = aiTools;
    if (row === undefined || target === null || rephrasing.has(key) || phase !== 'done') return;
    const confirm = rephraseConfirm.get(key);
    const serial = runSerial;
    let pending: Promise<DockAiGenerateOutcome>;
    try {
      pending = confirm !== undefined
        ? confirm(event, shadow)
        : tools === null || aiOn === false
          ? Promise.resolve<DockAiGenerateOutcome>({ kind: 'FAILED', reason: 'UNAVAILABLE' })
          : tools.generate(target, REPHRASE_INSTRUCTION, event, shadow, () => serial === runSerial);
    } catch {
      pending = Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' });
    }
    rephraseConfirm.delete(key);
    rephrasing.add(key);
    paint();
    void pending.catch((): DockAiGenerateOutcome => ({ kind: 'FAILED', reason: 'UNAVAILABLE' })).then((outcome) => {
      rephrasing.delete(key);
      if (serial !== runSerial) return;
      if (outcome.kind === 'WRITTEN') toast(COPY.ai.rephrased);
      else if (outcome.kind === 'EXPIRED') rephraseConfirm.set(key, outcome.confirm);
      else if (outcome.kind === 'USED_UP') toast(COPY.ai.card.usedUp);
      else if (outcome.kind === 'NOTHING_TO_WRITE') toast(COPY.ai.noEvidence);
      else {
        const text = aiFailedText(COPY, outcome.reason);
        if (text !== '') toast(text);
      }
      paint();
    });
  };

  /** 答案回来晚了：「填入 AI 答案」那一张小卡。 */
  const paintAiOffer = (): void => {
    const show = aiState.kind === 'READY' && doneLike();
    aiOffer.style.display = show ? 'grid' : 'none';
    if (!show) { delete aiOffer.dataset.shown; return; }
    aiOfferTitle.textContent = COPY.ai.readyTitle(aiState.kind === 'READY' ? aiState.count : 0);
    aiOfferButton.disabled = aiApplying;
    aiOfferButton.replaceChildren();
    if (aiApplying) aiOfferButton.append(h('span', 'spin-dark ai-offer-spin'), doc.createTextNode(COPY.ai.applying));
    else aiOfferButton.append(svg('spark', 15, { stroke: 1.8 }), doc.createTextNode(COPY.ai.readyButton));
  };

  /** 求职信写好了、但要再点一下：「附上求职信」那一张小卡。 */
  const paintLetterOffer = (): void => {
    const show = letterState.kind === 'READY' && doneLike();
    letterOffer.style.display = show ? 'grid' : 'none';
    if (!show) { delete letterOffer.dataset.shown; return; }
    letterOfferButton.disabled = letterApplying;
    letterOfferButton.replaceChildren();
    if (letterApplying) letterOfferButton.append(h('span', 'spin-dark ai-offer-spin'), doc.createTextNode(COPY.letter.attaching));
    else letterOfferButton.append(svg('spark', 15, { stroke: 1.8 }), doc.createTextNode(COPY.letter.attach));
  };

  /** 账号墙那一页（2026-09-28）：主按钮下面那一行。 */
  const paintAccountNote = (): void => {
    const wall = heroMode === 'button' ? accountWall : null;
    showIf(acctNote, wall !== null);
    if (wall !== null) setText(acctNote, COPY.siteAccount.wallNote(wall.site));
  };

  /** 列表只读站点元数据；明文与导出都在插件自己的设置页。 */
  const openSiteAccounts = (): void => {
    if (handlers.vaultManagement === undefined) return;
    menu = 'account';
    acctMenuOpen = true;
    if (!open) openPanel();
    paintPops();
    paintSiteAccounts();
    vaultList.load();
  };

  const paintSiteAccounts = (): void => {
    siteAcctItem.setAttribute('aria-expanded', String(acctMenuOpen));
    siteAcctBody.style.display = acctMenuOpen ? 'grid' : 'none';
    siteAcctBody.replaceChildren(...(acctMenuOpen ? [vaultList.element] : []));
  };

  /**
   * 代填授权的一键同意（2026-09-28）：没在填写、调用方说要请他同意、他这一页没点过同意或暂不，才摆出来。
   * 连填（一页一页填到检查页）还在往下走、或正替他按网站的下一步时也不摆：卡片不该在两页之间冒出来。
   */
  const paintConsentOffer = (): void => {
    const show = !consentSettled && !filling() && !chainHold && !autoAdvancing &&
      safe(() => handlers.signingReconsent?.offered() === true, false);
    consentOffer.style.display = show ? 'grid' : 'none';
    if (!show) { delete consentOffer.dataset.shown; return; }
    consentAgree.disabled = consentSaving;
    consentLater.disabled = consentSaving;
    consentAgree.replaceChildren();
    if (consentSaving) consentAgree.append(h('span', 'spin-dark consent-offer-spin'), doc.createTextNode(COPY.reconsent.agreeing));
    else consentAgree.append(doc.createTextNode(COPY.reconsent.agree));
  };

  /** 「同意新版本」：这一下点击原样交出去，调用方当场验它是我们 shadow 里的真实点击，再记到 argoland。 */
  const consentAccept = (event: MouseEvent): void => {
    const reconsent = handlers.signingReconsent;
    if (reconsent === undefined || consentSaving || consentSettled) return;
    let pending: Promise<boolean>;
    try {
      pending = reconsent.accept(event, shadow);
    } catch {
      pending = Promise.resolve(false);
    }
    consentSaving = true;
    paint();
    void pending.catch(() => false).then((saved) => {
      consentSaving = false;
      if (saved) consentSettled = true;
      toast(saved ? COPY.reconsent.saved : COPY.reconsent.failed);
      paint();
    });
  };

  /** 「暂不」：什么都不改；这一版不再请他（调用方记在本机）。 */
  const consentDecline = (): void => {
    if (consentSaving || consentSettled) return;
    consentSettled = true;
    safe(() => { handlers.signingReconsent?.decline(); }, undefined);
    paint();
  };

  /** 「附上求职信」：这一下点击就是写入的凭证——原样交出去，调用方在派发当中同步取证。 */
  const letterApply = (event: MouseEvent): void => {
    const state = letterState;
    if (state.kind !== 'READY' || letterApplying) return;
    let pending: Promise<boolean>;
    try {
      pending = state.apply(event, shadow);
    } catch {
      pending = Promise.resolve(false);
    }
    letterApplying = true;
    paint();
    const serial = runSerial;
    void pending.catch(() => false).then((attached) => {
      letterApplying = false;
      if (serial !== runSerial) return;
      letterState = attached ? { kind: 'ATTACHED' } : { kind: 'REFUSED', code: 'UNAVAILABLE', targets: state.targets };
      toast(attached ? COPY.letter.attached : COPY.letter.attachFailed);
      paint();
    });
  };

  /** 网页上那几栏旁边该摆什么：AI 写过的挂标记 D，交来的长文本题摆「用 AI 写 / AI 改写」（开关关着就不摆）。 */
  const syncAi = (): void => {
    const tools = aiOn === false || !doneLike() ? null : aiTools;
    const targets = new Set(tools?.targets ?? []);
    const specs = new Map<Element, AiFieldSpec>();
    for (const row of rows) {
      if (row.ai && row.target !== null) specs.set(row.target, { element: row.target, aiValue: row.value ?? '', tool: targets.has(row.target) });
    }
    for (const target of targets) {
      if (!specs.has(target)) specs.set(target, { element: target, aiValue: null, tool: true });
    }
    aiLayer.sync([...specs.values()]);
  };

  /** 读一次开关（账户菜单打开时、交来工具时）。读不到就维持原样（缺省是开）。 */
  const loadAiSwitch = (): void => {
    const port = handlers.aiAnswers;
    if (port === undefined) return;
    // 读不到（null 或抛了）就维持原样（缺省是开；worker 照真实设置办），记一个码（2026-10-04 体检「吞掉的错」第 8 条）。
    void port.load().then((value) => {
      if (value === null) handlers.onDiagnostic?.('DOCK_SWITCH_LOAD_FAILED');
      if (value === null || value === aiOn) return;
      aiOn = value;
      paint();
    }).catch(() => handlers.onDiagnostic?.('DOCK_SWITCH_LOAD_FAILED'));
  };
  const toggleAiSwitch = (): void => {
    const port = handlers.aiAnswers;
    if (port === undefined) return;
    const next = aiOn === false;
    aiOn = next;
    paint();
    const undoToggle = (): void => { aiOn = !next; toast(COPY.ai.switchFailed); paint(); };
    void port.save(next).then((saved) => {
      if (saved === null) { undoToggle(); return; }
      aiOn = saved;
      toast(saved ? COPY.ai.switchOn : COPY.ai.switchOff);
      paint();
    }).catch(undoToggle);
  };

  const loadMemorySwitch = (): void => {
    const port = handlers.answerMemory;
    if (port === undefined) return;
    void port.load().then((value) => {
      if (value === null) handlers.onDiagnostic?.('DOCK_SWITCH_LOAD_FAILED');
      if (value === null || value === memoryOn) return;
      memoryOn = value;
      paint();
    }).catch(() => handlers.onDiagnostic?.('DOCK_SWITCH_LOAD_FAILED'));
  };
  const toggleMemorySwitch = (): void => {
    const port = handlers.answerMemory;
    if (port === undefined) return;
    const next = memoryOn === false;
    memoryOn = next;
    paint();
    const undoToggle = (): void => { memoryOn = !next; toast(COPY.memory.switchFailed); paint(); };
    void port.save(next).then((saved) => {
      if (saved === null) { undoToggle(); return; }
      memoryOn = saved;
      toast(saved ? COPY.memory.switchOn : COPY.memory.switchOff);
      paint();
    }).catch(undoToggle);
  };

  /** 「填入 AI 答案」：这一下点击就是写入的凭证——原样交出去，调用方在派发当中同步取证。 */
  const aiApply = (event: MouseEvent): void => {
    const state = aiState;
    if (state.kind !== 'READY' || aiApplying) return;
    let pending: Promise<number>;
    try {
      pending = state.apply(event, shadow);
    } catch {
      pending = Promise.resolve(0);
    }
    aiApplying = true;
    paint();
    const serial = runSerial;
    void pending.catch(() => 0).then((written) => {
      aiApplying = false;
      if (serial !== runSerial) return;
      aiState = written > 0 ? { kind: 'APPLIED', count: written } : { kind: 'IDLE' };
      toast(written > 0 ? COPY.ai.applied(written) : COPY.ai.applyFailed);
      paint();
    });
  };

  /**
   * 提交前核对（2026-09-28）：填好了、但值得他看一眼的那几栏——按默认答的工作授权（负责人 2026-09-24 的决定）、一栏好几项
   * 没加全的。从前是总结下面的一行说明，现在挂在它说的那一行上，点一下去那一栏。
   */
  const reviewRowsOf = (): DockRow[] => rows.filter((row) => {
    const written = (row.st === 'ok' && !row.preserved) || (row.st === 'unverified' && !ud(row));
    return written && (row.source.defaultedWorkAuth !== undefined || (row.source.notAdded?.length ?? 0) > 0);
  });
  const paintReview = (): void => {
    const list = doneLike() ? reviewRowsOf() : [];
    if (!reviewGrp.isConnected) signedGrp.after(reviewGrp);
    reviewGrp.style.display = list.length > 0 ? 'block' : 'none';
    if (list.length === 0) delete reviewGrp.dataset.shown;
    reviewCount.textContent = String(list.length);
    const canLoc = phase === 'done';
    const keep = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of list) {
      keep.add(row.key);
      let node = reviewNodes.get(row.key);
      if (node === undefined) {
        const button = tb('nrow', () => locate(row.key));
        button.dataset.act = 'locate';
        button.dataset.reviewRow = row.key;
        const glyph = h('span', 'glyph');
        glyph.dataset.kind = 'review';
        glyph.append(svg('alert', 12, { stroke: 2.2 }));
        const text = h('span', 'ntext');
        const value = h('span', 'nsign');
        const why = h('span', 'nr');
        text.append(h('span', 'nq', row.q), value, why);
        const loc = h('span', 'nloc');
        loc.append(svg('locate', 16, { stroke: 1.8 }));
        button.append(glyph, text, loc);
        node = { row: button, value, why };
        reviewNodes.set(row.key, node);
      }
      const defaulted = row.source.defaultedWorkAuth;
      const missed = row.source.notAdded ?? [];
      const added = row.checkbox ? COPY.run.checked
        : row.value?.split('\n').filter((value) => !missed.some((miss) => miss.value === value)).join(COPY.lists.valueJoin) ?? '';
      node.value.textContent = [added, row.basis === null ? '' : COPY.historyBasis[row.basis]].filter((part) => part !== '').join(' · ');
      node.why.textContent = defaulted !== undefined ? COPY.workAuth.defaulted(defaulted.region, defaulted.sponsorship) : notAddedText(missed);
      node.row.disabled = !canLoc;
      node.row.setAttribute('aria-label', COPY.lists.locateAria(row.q));
      const want: ChildNode | null = previous === null ? reviewCard.firstChild : previous.nextSibling;
      if (want !== node.row) reviewCard.insertBefore(node.row, want);
      previous = node.row;
    }
    for (const [key, node] of reviewNodes) if (!keep.has(key)) { node.row.remove(); reviewNodes.delete(key); }
  };

  /** 那一条列表里一行写的值（短）：代填写类别，勾选框写「已勾选」，网站读的、网页上原有的照实写，其余写填进去的值。 */
  const feedValue = (row: DockRow): string => {
    if (row.st === 'signed') return row.signed === null ? '' : COPY.signed[row.signed];
    if (row.checkbox) return COPY.run.checked;
    if (row.fromResume) return COPY.lists.fromResume;
    if (row.preserved) return COPY.lists.alreadyThere;
    const missed = row.source.notAdded ?? [];
    return row.value?.split('\n').filter((value) => !missed.some((miss) => miss.value === value)).join(COPY.lists.valueJoin) ?? '';
  };
  /**
   * 填写途中（2026-09-28 负责人）：进度卡下面一条条列出填好的栏，一栏一行，按填上的先后接在最后；页面在下一帧一起改
   * （liveFeed.ts）。这期间「需要你」、代填、AI 那几组都不摆。
   */
  const paintFeed = (): void => {
    if (feedMode !== 'live') {
      if (feedTimer !== null) { clearTimeout(feedTimer); feedTimer = null; }
      feedMode = 'live';
      for (const node of restNodes.values()) node.row.remove();
      restNodes.clear();
      restGrp.dataset.feed = 'live';
    }
    for (const row of rows) {
      if (!FEED_STATUSES.has(row.st) || feedSeen.has(row.key)) continue;
      feedSeen.add(row.key);
      feedOrder.push(row.key);
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const lines = feedOrder.flatMap((key): FeedLine[] => {
      const row = byKey.get(key);
      if (row === undefined || !FEED_STATUSES.has(row.st)) return [];
      return [{ key, q: row.q, v: feedValue(row), kind: row.st === 'ai' ? 'ai' : row.st === 'signed' ? 'signed' : 'ok' }];
    });
    feedShown = lines.length > 0;
    restGrp.style.display = feedShown ? 'block' : 'none';
    if (!feedShown) delete restGrp.dataset.shown;
    restToggle.style.display = 'none';
    restFold.dataset.open = 'true';
    feed.sync(lines);
  };
  /** 那一条列表收好了：行拿掉、高度放开，这张卡回到平常的「其余已填好」。 */
  const endFeed = (): void => {
    if (feedTimer !== null) { clearTimeout(feedTimer); feedTimer = null; }
    feedMode = 'off';
    feedShown = false;
    feed.clear();
    delete restGrp.dataset.feed;
  };

  const paintRest = (): void => {
    if (filling() || autoAdvancing) { paintFeed(); return; }
    if (feedMode === 'live') {
      if (!doneLike()) endFeed();
      else {
        // 收尾（2026-09-28 负责人）：填好的那几行收进「其余已填好 N 项」（可以展开），「需要你」那几组接过焦点。收的那半秒里
        // 行不动，收好了再换成平常的样子；一行都还没列出来、减少动态、面板收着，就直接换。
        restOpen = false;
        if (!feedShown || reduced() || !open) endFeed();
        else {
          feedMode = 'folding';
          feedTimer = setTimeout(() => { feedTimer = null; endFeed(); paint(); }, FEED_FOLD_MS);
        }
      }
    }
    // 收的途中他点开了「其余已填好」：不等了。
    if (feedMode === 'folding' && restOpen) endFeed();
    const c = counts();
    // 其余已填好：我们填好的（提交前核对那几行除外），加上他自己办好了的「需要你」（2026-09-28：办好了就离开那张单子，记在这里）。
    const review = new Set(reviewRowsOf().map((row) => row.key));
    const list = [...c.ok.filter((row) => !review.has(row.key)), ...c.needs.filter((row) => ud(row))];
    restCount.textContent = String(list.length);
    restToggle.setAttribute('aria-expanded', String(restOpen));
    if (feedMode === 'folding') {
      restGrp.style.display = 'block';
      restToggle.style.display = list.length > 0 ? '' : 'none';
      restFold.dataset.open = 'false';
      return;
    }
    restToggle.style.display = '';
    const show = doneLike() && list.length > 0;
    restGrp.style.display = show ? 'block' : 'none';
    if (!show) delete restGrp.dataset.shown;
    restFold.dataset.open = String(restOpen);
    const keep = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of list) {
      keep.add(row.key);
      let node = restNodes.get(row.key);
      if (node === undefined) {
        const line = h('div', 'rrow');
        const check = h('span', 'rcheck');
        check.append(svg('check', 10, { stroke: 3.2 }));
        const text = h('span', 'rtext');
        const qline = h('span', 'rq-line');
        const q = h('span', 'rq', row.q);
        const opt = h('span', 'ropt', COPY.lists.optional);
        qline.append(q, opt);
        const v = h('span', 'rv');
        text.append(qline, v);
        line.append(check, text);
        node = { row: line, q, v, opt };
        restNodes.set(row.key, node);
      }
      node.opt.style.display = row.req ? 'none' : 'inline';
      // 推出来的答案（年满 18、「在这家公司工作过吗」）与按默认答的工作授权（2026-09-24 负责人决定：他有别国的记录、
      // 唯独没有这一国的）在值后面写明依据；勾选框也一样，依据不因控件是勾选框就不说。
      // 我们替他按了保存的那一段（全加全存）：填进去的内容后面写明「已替你按「Update」保存」。
      const defaulted = row.source.defaultedWorkAuth;
      const savedEntry = row.source.savedEntry;
      // 一栏好几项（一行一项）照顺序用顿号连起来；搜索式多选没加上的那几项不算进来（总结下面列着）。
      const missed = row.source.notAdded ?? [];
      const shown = row.value?.split('\n').filter((value) => !missed.some((miss) => miss.value === value)).join(COPY.lists.valueJoin) ?? null;
      // 他在浮层里答上的写明「你填的」；他在网站上自己补上的，我们不读那一栏的值来显示，只写「你已填好」。
      const answered = answeredHere.get(row.key);
      node.v.textContent = row.fromResume
        ? COPY.lists.fromResume
        : row.preserved ? COPY.lists.alreadyThere
        : isNeed(row) ? (answered === undefined ? COPY.lists.youFilled : `${answered} · ${COPY.needs.answered}`)
        : [
            row.checkbox ? COPY.run.checked : shown,
            row.basis === null ? null : COPY.historyBasis[row.basis],
            defaulted === undefined ? null : COPY.workAuth.defaulted(defaulted.region, defaulted.sponsorship),
            savedEntry === undefined ? null : COPY.unsavedEntry.saved(savedEntry.saveLabel),
            row.source.userAnswered === true ? COPY.needs.answered : null,
            row.attachment && resumeVersion !== null ? COPY.resumeVersion[resumeVersion] ?? null : null,
          ].filter((part) => part).join(' · ');
      const want: ChildNode | null = previous === null ? restCard.firstChild : previous.nextSibling;
      if (want !== node.row) restCard.insertBefore(node.row, want);
      previous = node.row;
    }
    for (const [key, node] of restNodes) if (!keep.has(key)) { node.row.remove(); restNodes.delete(key); }
  };

  const paintData = (): void => {
    const show = (phase === 'idle' || phase === 'failed') && linked() && !updatedCard();
    dataFold.dataset.open = String(show);
    for (const [target, sub] of entrySubs) {
      const saved = safe(() => handlers.entrySummary?.(target) ?? null, null);
      sub.textContent = saved ?? COPY.entries[target].sub;
    }
  };

  let barPrimaryAct = '';
  const paintBar = (): void => {
    const c = counts();
    // 连填替他翻页的时候没有底栏：那几秒是进度卡上的事（「停止」在进度卡上）。断了线也没有：提交、翻页都要找插件。
    const show = route === 'main' && doneLike() && !autoAdvancing && !updatedCard();
    bar.style.display = show ? 'grid' : 'none';
    if (!show) { delete bar.dataset.shown; return; }
    const busy = phase === 'advancing';
    const wdLabel = nextLabel();
    let caption = ''; let secondary = ''; let secondaryAct = ''; let primary = ''; let primaryAct = '';
    if (phase === 'review') { primaryAct = 'submit'; primary = submitLabel(); }
    // 后面还有一步：「继续到下一页」（读不到那一颗的字时不写「替你按网站上的…」，按下去的那一刻再找）。
    else if (wdLabel !== null || busy || moreSteps()) {
      caption = wdLabel === null ? '' : COPY.bar.presses(wdLabel);
      if (c.needsLeft > 0 && !busy) {
        secondary = COPY.bar.nextShort; secondaryAct = 'advance';
        primary = cursor === null ? COPY.bar.first : COPY.bar.nextItem; primaryAct = 'guide';
      } else { primaryAct = 'advance'; primary = busy ? COPY.bar.advancing : COPY.bar.next; }
    } else {
      // 还有要他处理的：一颗主按钮带他去第一项，之后是「下一处」；都办好了才是「提交」（2026-09-28）。
      primaryAct = c.needsLeft > 0 ? 'guide' : 'submit';
      primary = c.needsLeft > 0 ? (cursor === null ? COPY.bar.first : COPY.bar.nextItem) : submitLabel();
    }
    if (submitting) { caption = ''; secondary = ''; primary = COPY.bar.submit; }
    barCaption.textContent = caption;
    barCaption.style.display = caption === '' ? 'none' : 'block';
    barSecondary.style.display = secondary === '' ? 'none' : 'block';
    barSecondary.textContent = secondary;
    barSecondary.dataset.act = secondaryAct;
    barSecondary.dataset.action = secondaryAct === 'advance' ? 'next-step' : secondaryAct;
    barPrimary.dataset.act = primaryAct;
    barPrimary.dataset.action = primaryAct === 'advance' ? 'next-step' : primaryAct;
    // 这颗按钮此刻写的是「提交」还是「去网站上提交」（2026-10-04）：按下去照他看到的那一句办，见 submit()。
    if (primaryAct === 'submit' && !submitting) barPrimary.dataset.submit = primary === COPY.bar.submit ? 'plugin' : 'site';
    else if (!submitting) delete barPrimary.dataset.submit;
    barPrimaryAct = primaryAct;
    barPrimary.disabled = busy;
    barPrimary.replaceChildren();
    if (busy) barPrimary.append(h('span', 'spin-btn'));
    barPrimary.append(doc.createTextNode(primary));
    moreBtn.style.opacity = submitting ? '0' : '1';
    moreBtn.style.pointerEvents = submitting ? 'none' : 'auto';
  };

  const paintPops = (): void => {
    // 菜单收起：元数据与改到一半的邮箱都不留，迟到的读取不能重挂。
    if (menu !== 'account' && acctMenuOpen) {
      acctMenuOpen = false;
      vaultList.clear();
      paintSiteAccounts();
    }
    popAccount.dataset.open = String(menu === 'account');
    popMore.dataset.open = String(menu === 'more');
    popAccount.toggleAttribute('inert', menu !== 'account');
    popMore.toggleAttribute('inert', menu !== 'more');
    // 没有可还原的写入就不摆「撤销」：点了没反应比没有这一项更伤。
    const canUndo = audit !== null && audit.handlers.undoAll !== undefined && safe(() => audit?.handlers.canUndo?.() === true, false);
    if (canUndo && !undoItem.isConnected) popMore.append(undoSep, undoItem);
    if (!canUndo && undoItem.isConnected) { undoSep.remove(); undoItem.remove(); }
    rerunItem.disabled = !sheetAllowed || phase === 'advancing';
    homeItem.disabled = phase === 'advancing';
    // 开关没读到之前按缺省画成开。
    aiSwitchItem.setAttribute('aria-checked', String(aiOn !== false));
    aiSwitchKnob.dataset.on = String(aiOn !== false);
    memorySwitchItem.setAttribute('aria-checked', String(memoryOn !== false));
    memorySwitchKnob.dataset.on = String(memoryOn !== false);
    // 换语言要重挂浮层：只在主页上能换，正在填或看着这一轮的结果时置灰。
    for (const option of languageOptions) option.disabled = phase !== 'idle';
  };

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastText = '';
  const paintToastPosition = (): void => {
    const { vw, inset, vh, fullH, bandTop } = geometry();
    const openFull = open;
    const barShown = bar.style.display !== 'none' && route === 'main';
    const panelWidth = Number.parseFloat(panel.style.width) || 380;
    // 嵌入帧：提示贴在看得见的那一段的底边上，不是整个 iframe 的底边（不是嵌入帧时这一项是 0）。
    const below = Math.max(0, fullH - (bandTop + vh));
    toastWrap.style.right = `${openFull ? inset : 12}px`;
    toastWrap.style.width = `${openFull ? panelWidth : Math.min(360, vw - 24)}px`;
    toastWrap.style.bottom = `${below + (openFull ? (route === 'profile' ? 76 : barShown ? (barCaption.style.display !== 'none' ? 110 : 88) : 20) : 20)}px`;
  };
  const toast = (text: string, ms = 2600): void => {
    if (text === '') return;
    const changed = text !== toastText;
    toastText = text;
    toastNode.textContent = text;
    toastWrap.style.display = 'flex';
    paintToastPosition();
    if (changed && !reduced()) animate(toastNode, [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE_OUT });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastWrap.style.display = 'none'; toastText = ''; }, ms);
  };

  // 依次入场：新挂上的 [data-in] 节点（设计：translateY(8px)、透明度 0→1，420ms，每个间隔 45ms，最多 8 个）。
  const animateEntering = (): void => {
    const fresh = Array.from(root.querySelectorAll<HTMLElement>('[data-in]:not([data-shown])'));
    const visible = fresh.filter((node) => node.offsetParent !== null || node.getClientRects().length > 0);
    let n = 0;
    for (const node of visible) {
      node.dataset.shown = '1';
      if (reduced() || !open) continue;
      animate(node, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
        duration: 420, easing: EASE_OUT, delay: Math.min(n, 8) * 45, fill: 'backwards',
      });
      n += 1;
    }
  };

  // 主卡高度：先量，改完再从旧高度过渡到新高度（520ms）。
  let flipFrom: number | null = null;
  const flipPrep = (): void => {
    if (flipFrom === null && hero.isConnected) flipFrom = hero.getBoundingClientRect().height;
  };
  const flipPlay = (): void => {
    const from = flipFrom;
    flipFrom = null;
    if (from === null || reduced() || !open) return;
    const to = hero.getBoundingClientRect().height;
    if (Math.abs(to - from) > 1) animate(hero, [{ height: `${from}px` }, { height: `${to}px` }], { duration: 520, easing: EASE });
  };

  const paint = (): void => {
    const before = heroModeKey;
    if (heroModeNow().key !== before) flipPrep();
    needNow = needItems();
    paintHead();
    paintJob();
    paintHero();
    paintAccountNote();
    paintBanner();
    paintConsentOffer();
    paintNeeds();
    paintAiOffer();
    paintLetterOffer();
    paintAi();
    paintSigned();
    paintReview();
    paintRest();
    paintData();
    paintBar();
    paintPops();
    paintLauncher();
    paintLayout();
    flipPlay();
    animateEntering();
    syncAi();
  };

  let followRaf = 0;
  const onViewportMove = (): void => {
    // 网页上的 AI 标记跟着滚动挪（「去那一栏」亮的那一下不跟：滚动一来就拿掉，见 fieldFlash.ts）。
    const follow = (): void => { aiLayer.reposition(); };
    if (win === null) return follow();
    win.cancelAnimationFrame(followRaf);
    followRaf = win.requestAnimationFrame(follow);
  };
  win?.addEventListener('scroll', onViewportMove, true);

  // ── 面板开合 ────────────────────────────────────────────────────
  /**
   * `moveFocus`：把焦点放进面板。只有他自己打开（点启动按钮、在启动按钮上按回车或空格、浮层里的按钮带他进来）才放；
   * 挂上就自动打开的那一下从不挪焦点（2026-10-03 体检 P0-2：他正在网页上打字，下一个键就丢了）。已经开着也照放：
   * 换语言重挂之后，调用方据此把焦点交回面板。
   */
  const openPanel = (moveFocus = true): void => {
    if (open) {
      if (moveFocus) panel.focus?.({ preventScroll: true });
      return;
    }
    open = true;
    hidden = false;
    hover = false;
    // 先让调用方把要用的读好（岗位卡从页面的 JobPosting 读、头像与「你的资料」开始取），再画：第一帧就是对的，
    // 不先画一张「Ashby 申请表」、过两秒再跳成展开的岗位卡（2026-09-24 测试台，自动打开时最明显）。
    safe(() => handlers.onPanelOpen?.(), undefined);
    // 这一帧面板自己在滑进来：岗位卡直接摆成该有的样子，不再叠一段「一行长成展开」。
    opening = true;
    try {
      paint();
    } finally {
      opening = false;
    }
    if (moveFocus) panel.focus?.({ preventScroll: true });
  };
  const closePanel = (): void => {
    open = false;
    autoWidthCap = null;
    menu = '';
    flash.clear();
    paint();
    lBtn.focus?.({ preventScroll: true });
  };
  /**
   * 要他去网站上自己点（2026-09-28 测试台：Workday 右下角的 Next／Submit 整个在展开的浮层下面，要先收起浮层才按得到）：
   * 他按下我们那一颗的那一刻收起面板，让出网站的按钮；启动器还在，点它就回来。只在他按了之后、只收这一次——不量版面、
   * 不跟着页面动，也不算他自己收起的（下次照常自动打开）。浮层自己带着这一步的时候（「继续到下一页」替他按）不收。
   */
  const giveWayToSite = (): void => {
    if (open) closePanel();
  };
  /** 用户自己收起（页头的「收起」、Esc）：与程序里的 closePanel 分开，调用方据此不再自动打开。 */
  const collapse = (): void => {
    const wasOpen = open;
    closePanel();
    if (wasOpen) handlers.onCollapse?.();
  };

  // ── 资料页 ─────────────────────────────────────────────────────
  const openProfile = (): void => {
    menu = '';
    flash.clear();
    route = 'profile';
    profileEditor.open();
    if (!open) openPanel();
    else paint();
  };
  const leaveProfile = (): void => {
    if (!profileEditor.requestLeave()) return;
    route = 'main';
    paint();
  };

  // ── 一轮 ───────────────────────────────────────────────────────
  const resetRun = (): void => {
    rows = [];
    current = undefined;
    runKey = null;
    userDid.clear();
    settledState.clear();
    userActedOnHost = false;
    stopped = false;
    stopRequested = false;
    failCode = null;
    failAction = null;
    failDiagnostics = [];
    techOpen = false;
    restOpen = false;
    endFeed();
    feedOrder.length = 0;
    feedSeen.clear();
    notAdv = null;
    submitNote = null;
    handBack = false;
    diagHints = [];
    resumeVersion = null;
    answering.clear();
    answeredHere.clear();
    aiWriting.clear();
    aiConfirm.clear();
    rowNotes.clear();
    rephrasing.clear();
    rephraseConfirm.clear();
    chipMemo.clear();
    cursor = null;
    answersPort = null;
    needsView.clear();
    tickerKey = '';
    flash.clear();
    unwatchHostFields();
    aiState = { kind: 'IDLE' };
    aiStep = false;
    aiTools = null;
    aiApplying = false;
    aiNoEvidence = new Set();
    aiUnanswered = new Set();
    letterState = { kind: 'IDLE' };
    letterApplying = false;
    // 连填的那一页（第几页、停没停下）归调用方说（setChain，扫完新一页再说一次）；这里只放下「正在替他翻页」与这一页的等待。
    autoAdvancing = false;
    autoAdvanceLabel = null;
    chainHold = false;
    aiLayer.clear();
    const record = audit;
    audit = null;
    record?.dismiss();
  };

  const beginPreparing = (label?: string): void => {
    if (!sheetAllowed) return;
    flipPrep();
    runSerial += 1;
    resetRun();
    submitted = false;
    phase = 'preparing';
    prep = 0;
    prepLabel = label ?? null;
    route = 'main';
    menu = '';
    sheetCollapsed = false;
    // 用户刚按了「自动填写」（或「继续到下一页」）：这一轮就在面板上。
    if (!open) { open = true; hidden = false; handlers.onPanelOpen?.(); }
    paint();
  };

  const startAutofill = (event: MouseEvent): void => {
    if (!sheetAllowed) return;
    // 新的一次点击就是新的一轮：上一轮连填的样子（第几页、为什么停）不再算数，调用方扫完这一页再说。
    // 上一轮替他在账号墙上做过的那几件、停在账号墙上的那张卡也一样（这一轮若又遇到账号墙，照实再说）。
    accountDone = [];
    accountAsk = null;
    chain = null;
    chainHold = false;
    beginPreparing();
    handlers.onAutofill(event, shadow);
  };

  const setStep = (step: DockRunStep): void => {
    if (phase !== 'preparing' && phase !== 'filling') return;
    if (step === 'SCANNING' || step === 'VERIFYING_INTENT') { prep = 0; prepLabel = null; }
    else if (step === 'PLANNING') { prep = 1; prepLabel = null; }
    // mission 那条路：worker 报「正在填」「正在检查」，逐栏的行随后才到。
    else if (step === 'FILLING') prepLabel = COPY.run.writing;
    else if (step === 'VERIFYING') prepLabel = COPY.run.confirming;
    // 手势路：规则那几遍写完了、AI 代答还在起草——这一轮还没完，进度卡留着（见 aiStep）。
    else if (step === 'AI_DRAFTING') aiStep = true;
    if (phase === 'preparing' || aiStep) paint();
  };

  /**
   * AI 那一段到此为止（调用方说了收尾）：先按等的时候收到的终局单子收尾——与没有 AI 时同一套（记下各格收尾时的
   * 样子、读一次诊断码、用户按过停止就算已停止）——再照调用方说的收尾。
   */
  const endAiStep = (): void => {
    if (!aiStep && !chainHold) return;
    aiStep = false;
    // 连填停下了（调用方说了收尾）：同样按等的时候收到的终局单子收尾。
    chainHold = false;
    if (current !== undefined && (current as { phase?: unknown }).phase === 'SETTLED') adopt(current);
  };

  const adopt = (next: AutofillDockProgress): void => {
    current = next;
    rows = rowsOf(next);
    // AI 代答还在起草、或连填还要往下翻：这是规则那几遍的终局，但这一轮还没完——只换进度条，收尾在 endAiStep。
    const settledNow = (next as { phase?: unknown }).phase === 'SETTLED' && !aiStep && !chainHold;
    if (settledNow) {
      const first = phase !== 'done' && phase !== 'advancing' && phase !== 'review';
      if (first) flipPrep();
      phase = 'done';
      stopped = stopped || stopRequested;
      watchHostFields();
      if (first) readDiagnostics();
    } else if (phase !== 'done' && phase !== 'advancing') {
      if (phase !== 'filling') flipPrep();
      phase = 'filling';
    }
    // 收尾那一刻（以及之后每次改判）记下这一轮要写的那几格的样子：之后变了样才算用户补的。
    if (phase === 'done' || phase === 'advancing') noteSettledStates();
    paint();
  };

  const update = (next: AutofillDockProgress): void => {
    if (!sheetAllowed) return;
    if (retiredRunIds.has(next.runId)) return;
    if (runKey !== null && next.runId !== runKey) return;
    runKey = next.runId;
    adopt(next);
  };

  const beginRun = (next: AutofillDockProgress): void => {
    if (!sheetAllowed) return;
    if (retiredRunIds.has(next.runId)) return;
    if (runKey !== next.runId) {
      userDid.clear();
      settledState.clear();
      userActedOnHost = false;
      notAdv = null;
      submitNote = null;
      stopped = false;
      stopRequested = stopRequested && filling();
    }
    runKey = next.runId;
    failCode = null;
    sheetCollapsed = false;
    adopt(next);
  };

  const finishRun = (outcome: DockRunOutcome): void => {
    if (!sheetAllowed) return;
    endAiStep();
    if (!outcome.started) {
      reportBlocked(outcome.code);
      return;
    }
    // 已经说过为什么一项都没写：随后到的回执不把它改成「成功」。
    if (phase === 'failed') return;
    if (outcome.outcome === 'STOPPED' || outcome.outcome === 'TIMED_OUT') stopped = true;
    if (rows.length === 0 && outcome.outcome !== 'FILLED' && outcome.outcome !== 'NEEDS_USER_INPUT') {
      reportBlocked(outcome.code ?? outcome.outcome);
      return;
    }
    if (rows.length === 0 && outcome.outcome === 'NEEDS_USER_INPUT') handBack = true;
    const first = phase !== 'done' && phase !== 'advancing' && phase !== 'review';
    if (first) flipPrep();
    if (phase !== 'advancing' && phase !== 'review') phase = 'done';
    watchHostFields();
    paint();
    if (first) readDiagnostics();
  };

  /** 收尾时读一次最近的诊断码，认得的换成人话挂在总结下面；码本身不上面。 */
  const readDiagnostics = (): void => {
    if (handlers.recentDiagnostics === undefined) return;
    const serial = runSerial;
    void handlers.recentDiagnostics().then((codes) => {
      if (serial !== runSerial || !doneLike()) return;
      const recent = codes.filter((code) => typeof code === 'string' && /^[A-Z0-9_]{3,64}$/.test(code)).slice(-8);
      const keys = Object.keys(COPY.diagnosticsHints).sort((a, b) => b.length - a.length);
      const hints = new Map<string, string>();
      let version: string | null = null;
      for (const code of recent) {
        const key = keys.find((candidate) => code === candidate || code.startsWith(`${candidate}_`));
        if (key !== undefined) hints.set(key, COPY.diagnosticsHints[key] as string);
        if (COPY.resumeVersion[code] !== undefined) version = code;
      }
      // 挂到它说的那一行上（简历那一栏、自我认同那几栏），挂不上的才留在总结下面（2026-09-28）。
      diagHints = [...hints].map(([key, text]) => Object.freeze({ key, text }));
      resumeVersion = version;
      paint();
    }).catch(() => {});
  };

  const reportBlocked = (code: string, action?: DockBlockedAction): void => {
    if (!sheetAllowed) return;
    endAiStep();
    if (rows.length > 0) {
      // 已经有逐栏结果了：照实停在总结上，行本身就说明了哪几项要他。
      if (phase !== 'done') flipPrep();
      phase = 'done';
      watchHostFields();
      paint();
      return;
    }
    flipPrep();
    phase = 'failed';
    failCode = code;
    failAction = action ?? null;
    techOpen = false;
    if (!open) { open = true; hidden = false; }
    paint();
    const serial = runSerial;
    void handlers.recentDiagnostics?.().then((codes) => {
      if (serial !== runSerial || phase !== 'failed') return;
      failDiagnostics = codes.filter((one) => typeof one === 'string' && /^[A-Z0-9_]{3,64}$/.test(one)).slice(-6);
      paintHero();
    }).catch(() => {});
  };

  /**
   * 这一页和插件断了线（2026-10-03 体检 3e）：从此主卡是「ArgoLand.AI 已更新，刷新这一页即可继续」与一颗「刷新页面」。
   * 还在准备的那一轮（问不到插件，开不了头）放下；正在写、正在翻页、正在提交的那一轮走完再换（进度卡与「停止」留着）。
   * 只换样子、不打开面板：报到时发现的，等他自己打开再看。
   */
  const extensionUpdated = (): void => {
    orphaned = true;
    menu = '';
    if (phase === 'preparing') {
      runSerial += 1;
      if (runKey !== null) retiredRunIds.add(runKey);
      resetRun();
      phase = 'idle';
    }
    paint();
  };

  /**
   * 替他在账号墙上做到哪一步了（2026-09-28）。正在做的（准备、选用邮箱登录、注册、登录）写在进度卡上；做成了的（注册了、
   * 登录了、这一家早有账号、同意了注册条款）记一句，留到他下一次自己按主按钮，这一轮的总结里逐条列出。
   */
  const accountStatus = (status: DockAccountStatus): void => {
    if (!sheetAllowed) return;
    const S = COPY.siteAccount;
    let line: string;
    switch (status.kind) {
      case 'REGISTERED': line = S.done.REGISTERED(status.site, status.email); break;
      case 'SIGNED_IN': line = S.done.SIGNED_IN(status.site, status.email); break;
      case 'ACCOUNT_EXISTS': line = S.done.ACCOUNT_EXISTS(status.site); break;
      case 'TERMS_ACCEPTED': line = S.done.TERMS_ACCEPTED(status.site); break;
      default:
        if (phase === 'filling') return;
        // 他去邮箱验证完回到这一页、我们接着登录：从那张卡回到进度卡。
        if (phase !== 'preparing') { accountAsk = null; chain = null; chainHold = false; beginPreparing(); }
        if (accountAsk !== null) { flipPrep(); accountAsk = null; }
        prepLabel = S.status[status.kind](status.site);
        paint();
        return;
    }
    if (!accountDone.includes(line)) accountDone.push(line);
    if (status.kind === 'REGISTERED' && status.generated && !accountDone.includes(S.done.generated)) accountDone.push(S.done.generated);
    if (status.kind !== 'TERMS_ACCEPTED') toast(line);
    paint();
  };

  /** 账号墙上停下来要他做的那一件事；null 收起。人机验证、验证码那两种不算停：这一轮还在等他。 */
  const accountPrompt = (prompt: DockAccountPrompt | null): void => {
    if (!sheetAllowed) return;
    flipPrep();
    accountAsk = prompt;
    if (prompt !== null && !ACCOUNT_WAITING.has(prompt.kind) && phase === 'preparing') {
      phase = 'idle';
      prepLabel = null;
    }
    if (prompt !== null && !open) { open = true; hidden = false; safe(() => handlers.onPanelOpen?.(), undefined); }
    paint();
  };

  const showAudit = (view: AuditView, auditHandlers: DockAuditHandlers): DockAuditHandle => {
    if (view.rows.length === 0 || !sheetAllowed) return NOOP_AUDIT;
    const previous = audit;
    let dismissed = false;
    const record = {
      handlers: auditHandlers,
      dismiss: (): void => {
        if (dismissed) return;
        dismissed = true;
        auditHandlers.onDismiss?.();
        doc.defaultView?.removeEventListener('pagehide', record.dismiss);
        if (audit === record) audit = null;
        // 这一轮的单子收掉了：当场答的口子随之关上（之后只摆「去这一栏」）。
        if (answersPort !== null && answersPort === auditHandlers.answers) answersPort = null;
      },
    };
    audit = record;
    previous?.dismiss();
    answersPort = auditHandlers.answers ?? null;
    doc.defaultView?.addEventListener('pagehide', record.dismiss);
    // 审计到了，这一轮就收尾了（AI 代答还在起草时除外：收尾在 endAiStep）；还没收到逐栏的行（调用方只交了审计）就照审计画。
    if (rows.length === 0) {
      runKey ??= `audit-${runSerial}`;
      current = dockProgressFromAudit(runKey, view, locale);
      rows = rowsOf(current);
    }
    if (!aiStep && !chainHold) {
      if (phase !== 'done' && phase !== 'advancing' && phase !== 'review') { flipPrep(); phase = 'done'; }
      watchHostFields();
    }
    paint();
    return {
      dismiss: () => { record.dismiss(); paint(); },
      update: () => {},
      shadowRoot: shadow,
    };
  };

  const stopRun = (): void => {
    if (!filling() && !autoAdvancing) return;
    // 在等他过人机验证、验证码的那张卡：这一轮不等了。
    if (accountAsk !== null && ACCOUNT_WAITING.has(accountAsk.kind)) accountAsk = null;
    stopRequested = true;
    handlers.onStop?.();
    if (autoAdvancing) {
      // 连填正在替他翻页：当场停在这一页的总结上。翻页的结论回来时，宿主若已经翻过去了，就回到可以点「自动填写」的样子。
      autoAdvancing = false;
      autoAdvanceLabel = null;
      flipPrep();
      phase = 'done';
      stopped = true;
      noteSettledStates();
      watchHostFields();
      paint();
      return;
    }
    if (phase === 'preparing') {
      // 还没开始写：回到可以点「自动填写」的样子，这一轮之后再送来的一概不收。
      flipPrep();
      runSerial += 1;
      if (runKey !== null) retiredRunIds.add(runKey);
      resetRun();
      phase = 'idle';
      paint();
    }
  };

  const undo = async (event: MouseEvent): Promise<void> => {
    const record = audit;
    if (record === null || record.handlers.undoAll === undefined) return;
    if (!safe(() => record.handlers.canUndo?.() === true, false)) return;
    record.handlers.undoAll(event, shadow);
    flipPrep();
    runSerial += 1;
    if (runKey !== null) retiredRunIds.add(runKey);
    resetRun();
    phase = 'idle';
    paint();
    toast(COPY.toast.undone);
  };

  // ── 「你已填好这一项」：看网站上那一栏有没有值（我们写过的几格看它变没变样）────
  /** 这一轮要写的、此刻「需要你」的那几格：还没记下收尾时的样子就现在记。 */
  const noteSettledStates = (): void => {
    for (const row of needsOf()) {
      if (row.planned && !settledState.has(row.key)) settledState.set(row.key, hostFieldState(row.target));
    }
  };
  /**
   * 这一格现在算不算用户补上的。没写过的行只看有没有值（设计交接 §7）。我们这一轮要写的行，收尾那一刻
   * 的样子——我们写的值（哪怕网站没来得及确认）、宿主据此改成的样子、或者本来就在的内容——不算；用户
   * 之后在网站上把它改成别的样子，才算他的。2026-09-23：后台标签页里我们写成却没能确认的五栏，
   * 从前被算成了「你补上了 5 项」。
   */
  const userSupplied = (row: DockRow): boolean => {
    if (!userActedOnHost) return false;
    // 一段加了、填了、还没保存的经历（2026-09-24）：用户在网站上按了保存（或放弃了这一段），那一段自己的保存钮就
    // 从页面上消失了——这一件他已经处理了。
    if (row.source.unsavedEntry !== undefined) return row.target !== null && !row.target.isConnected;
    // 没加上的那几段：「加一行」那颗按钮本身没有「值」可看；他在网站上加没加、加了几段，这里看不出来。
    // 照旧留着这一行，他再点一次自动填写，会从页面上已有的段数接着加。
    if (row.source.unaddedEntries !== undefined) return false;
    if (!row.planned) return hostFieldHasValue(row.target);
    if (!settledState.has(row.key)) settledState.set(row.key, hostFieldState(row.target));
    const now = hostFieldState(row.target);
    return now !== null && now !== settledState.get(row.key);
  };
  let hostPoll: ReturnType<typeof setInterval> | null = null;
  const recheckUserDid = (): void => {
    if (phase !== 'done' && phase !== 'advancing') return;
    let changed = false;
    const flipped: DockRow[] = [];
    for (const row of needsOf()) {
      const has = userSupplied(row);
      if (has !== (userDid.get(row.key) === true)) {
        userDid.set(row.key, has);
        changed = true;
        if (has) flipped.push(row);
      }
    }
    // 在浮层里答上的那一栏被网站清掉了：回到「需要你」（这一次不算他答上了）。
    for (const [key] of answeredHere) {
      const row = rows.find((one) => one.key === key);
      if (row !== undefined && isNeed(row) && !hostFieldHasValue(row.target)) { answeredHere.delete(key); changed = true; }
    }
    if (!changed) return;
    // 办好了的那几行离开「需要你」（needsView 负责那一段过渡）；总结的数跟着变。
    paint();
    if (reduced() || flipped.length === 0) return;
    animate(heroRefs.sumTitle, [{ opacity: 0.3 }, { opacity: 1 }], { duration: 420 });
  };
  const onHostActivity = (event: Event): void => {
    if (!event.isTrusted || userActedOnHost) return;
    if (event.composedPath().includes(host)) return;
    userActedOnHost = true;
  };
  const HOST_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'input', 'change', 'paste', 'drop'] as const;
  for (const type of HOST_ACTIVITY_EVENTS) doc.addEventListener(type, onHostActivity, true);
  // 用户在网页上动了一栏：AI 写过的那一栏撤下标记 D、空栏小片上的字跟着换；页面自己挪了位置，标记跟上。
  const onHostEdit = (): void => { aiLayer.recheck(); aiLayer.reposition(); recheckUserDid(); };
  const watchHostFields = (): void => {
    if (hostPoll !== null) return;
    doc.addEventListener('input', onHostEdit, true);
    doc.addEventListener('change', onHostEdit, true);
    hostPoll = setInterval(onHostEdit, 900);
  };
  const unwatchHostFields = (): void => {
    if (hostPoll === null) return;
    clearInterval(hostPoll);
    hostPoll = null;
    doc.removeEventListener('input', onHostEdit, true);
    doc.removeEventListener('change', onHostEdit, true);
  };

  // ── 逐项处理 ────────────────────────────────────────────────────
  const scrollToRow = (row: DockRow): void => {
    const target = row.target;
    if (target === null || !target.isConnected) {
      row.source.locate?.();
      return;
    }
    scrollHostFieldIntoView(target, !reduced());
    flash.show(target);
  };
  /**
   * 去那一栏（「去第一项」「下一处」「去这一栏」，2026-09-28）：滚到视口约 26% 的高度、把光标放进去（他可以直接打字——
   * 这是他按了我们的按钮之后的导航，不改那一栏的值），滚动停下之后在那一栏上亮一下。窄屏上面板盖住了整页，先收起。
   */
  const goToRow = (row: DockRow): void => {
    cursor = row.key;
    menu = '';
    const target = row.target;
    if (target === null || !target.isConnected) {
      row.source.locate?.();
      paint();
      return;
    }
    if (geometry().narrow && open) closePanel();
    scrollHostFieldIntoView(target, !reduced());
    try {
      (target as HTMLElement).focus?.({ preventScroll: true });
    } catch {
      // 这一栏此刻不收焦点（藏起来的文件框）：滚过去、亮一下就够了。
    }
    flash.show(target);
    paint();
  };
  /**
   * 「去第一项 / 下一处」：按「需要你」列表的先后，去下一个还没办好的那一栏。停着的那一行办好了、离开了列表，照样从它原来
   * 的位置往后数；到了最后一个就回到第一个还没办好的。
   */
  const jumpNext = (): void => {
    const pending = needItems();
    if (pending.length === 0) return;
    let next = pending[0]!;
    if (cursor !== null) {
      const all = needsOf().map((row) => ({ row, kind: needKind(row) }));
      const order = NEED_KINDS.flatMap((kind) => all.filter((one) => one.kind === kind)).map((one) => one.row.key);
      const at = order.indexOf(cursor);
      if (at >= 0) {
        const after = [...order.slice(at + 1), ...order.slice(0, at + 1)];
        const openKeys = new Set(pending.map((item) => item.row.key));
        const key = after.find((one) => openKeys.has(one));
        next = pending.find((item) => item.row.key === key) ?? next;
      }
    }
    goToRow(next.row);
  };
  /**
   * 在浮层里当场答（2026-09-28）：点了一个选项、或按了「填入」。这一下点击原样交给调用方——它在派发当中同步取证，经内核
   * 同一条授权路写进那一栏；`remember` 说这一题值不值得记进答案记忆（总开关由调用方管，不另问）。写成了，那一行离开列表；
   * 没写成照实说一句，这一轮已经结束或写不进去的就带他去那一栏。
   */
  const answerRow = (row: DockRow, value: string, event: Event, remember: boolean): void => {
    const port = answersPort;
    const target = row.target;
    if (port === null || target === null || answering.has(row.key) || phase !== 'done') return;
    let pending: Promise<DockAnswerOutcome>;
    try {
      pending = port.answer(target, value, event, shadow, remember);
    } catch {
      pending = Promise.resolve({ ok: false, reason: 'REFUSED' });
    }
    answering.set(row.key, value);
    paint();
    const serial = runSerial;
    void pending.catch((): DockAnswerOutcome => ({ ok: false, reason: 'REFUSED' })).then((outcome) => {
      answering.delete(row.key);
      if (serial !== runSerial) return;
      if (outcome.ok) {
        answeredHere.set(row.key, value);
        // 能不能联系雇主那一问：记进资料了没有，照实说一句。
        if (outcome.profile === 'SAVED') toast(COPY.needs.employer.saved, 3_600);
        else if (outcome.profile === 'NOT_SAVED') toast(COPY.needs.employer.notSaved, 4_600);
      } else toast(COPY.needs.answerFailed[outcome.reason]);
      paint();
      if (!outcome.ok && (outcome.reason === 'ENDED' || outcome.reason === 'REFUSED')) goToRow(row);
    });
  };

  /**
   * 「AI 帮我写」（2026-09-28）：单栏 AI 那一条路（与网页上「用 AI 写」同一个口子，不加「写之前确认」）。写进去之后调用方交回
   * 新单子，那一行成了 AI 写的、离开「需要你」；网站的撤销照旧在「⋯」里。没找到依据、次数用完就换一句，改成「去这一栏」。
   */
  const aiWriteRow = (row: DockRow, event: MouseEvent): void => {
    const target = row.target;
    if (target === null || aiWriting.has(row.key) || phase !== 'done') return;
    const tools = aiTools;
    const confirm = aiConfirm.get(row.key);
    const serial = runSerial;
    let pending: Promise<DockAiGenerateOutcome>;
    try {
      pending = confirm !== undefined
        ? confirm(event, shadow)
        : tools === null || aiOn === false
          ? Promise.resolve<DockAiGenerateOutcome>({ kind: 'FAILED', reason: 'UNAVAILABLE' })
          : tools.generate(target, '', event, shadow, () => serial === runSerial);
    } catch {
      pending = Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' });
    }
    aiConfirm.delete(row.key);
    aiWriting.add(row.key);
    paint();
    void pending.catch((): DockAiGenerateOutcome => ({ kind: 'FAILED', reason: 'UNAVAILABLE' })).then((outcome) => {
      aiWriting.delete(row.key);
      if (serial !== runSerial) return;
      if (outcome.kind === 'WRITTEN') toast(COPY.ai.card.written);
      else if (outcome.kind === 'NOTHING_TO_WRITE') rowNotes.set(row.key, COPY.needs.why.aiNothing);
      else if (outcome.kind === 'USED_UP') rowNotes.set(row.key, COPY.needs.why.aiUsedUp);
      else if (outcome.kind === 'EXPIRED') aiConfirm.set(row.key, outcome.confirm);
      else {
        const text = aiFailedText(COPY, outcome.reason);
        if (text !== '') toast(text);
      }
      paint();
    });
  };

  /** 点「需要你」、代填、AI、提交前核对里的一行：去那一栏。 */
  const locate = (key: string): void => {
    if (phase !== 'done') return;
    const row = rows.find((one) => one.key === key);
    if (row === undefined) return;
    if (isNeed(row)) { goToRow(row); return; }
    scrollToRow(row);
  };

  // ── 底栏动作 ────────────────────────────────────────────────────
  const barAct = (act: string, event: MouseEvent): void => {
    if (act === 'guide') jumpNext();
    else if (act === 'advance') advance(event);
    else if (act === 'submit') void submit(event);
  };

  // 多页：继续到下一页
  let advancing = false;
  /**
   * 翻页有了结论。用户按的「继续到下一页」与连填替他按的（`auto`，2026-09-28）是同一套：翻过去接着填就进下一页的「准备中」，
   * 没翻过去就停在这一页的总结上照实说。连填那一路一直是进度卡，没翻过去时换回总结卡；网站弹出了只能本人处理的关卡时，
   * 总结自己就说那一件事，不再叠「网站没有翻页」的横幅。
   */
  const settleAdvance = (outcome: DockAdvanceOutcome, needsAtClick: number, auto: boolean): void => {
    if (outcome === 'ADVANCED') { retireRun('ADVANCED'); return; }
    if (outcome === 'ADVANCED_FILLING') {
      retire();
      beginPreparing(COPY.run.nextPage);
      // 连填：进度卡一直在、写着第几页，不另弹一句。
      if (!auto) toast(COPY.toast.nextPage);
      return;
    }
    if (auto) flipPrep();
    phase = 'done';
    const wall = chain?.stop === 'LOGIN' || chain?.stop === 'VERIFICATION' || chain?.stop === 'CAPTCHA';
    if (outcome === 'NOT_ADVANCED' && !wall) notAdv = { needsAtClick };
    else if (outcome !== 'NOT_ADVANCED') toast(outcome === 'UNTRUSTED' ? COPY.toast.untrusted : COPY.toast.advanceUnavailable);
    // 他按的「继续到下一页」此刻按不了、要他去网站上自己点：收起让开（网站的下一步多半就在浮层下面，2026-09-28）。
    const handBackToSite = !auto && outcome !== 'NOT_ADVANCED' && outcome !== 'UNTRUSTED';
    if (auto) {
      noteSettledStates();
      watchHostFields();
      readDiagnostics();
    }
    paint();
    if (handBackToSite) giveWayToSite();
    if (outcome === 'NOT_ADVANCED') scrollMainTop();
  };
  const advance = (event: MouseEvent): void => {
    const next = handlers.nextStep;
    if (advancing || next === undefined) return;
    let pending: Promise<DockAdvanceOutcome>;
    try {
      pending = next.advance(event, shadow);
    } catch {
      pending = Promise.resolve('UNAVAILABLE');
    }
    // 调用方在这一下里发现和插件断了线：主卡已经换成「已更新」那张卡，不转圈等翻页。
    if (orphaned) return;
    const serial = runSerial;
    const needsAtClick = counts().needsLeft;
    advancing = true;
    flash.clear();
    menu = '';
    phase = 'advancing';
    notAdv = null;
    paint();
    void pending.catch((): DockAdvanceOutcome => 'UNAVAILABLE').then((outcome) => {
      advancing = false;
      if (serial !== runSerial) return;
      settleAdvance(outcome, needsAtClick, false);
    });
  };
  /**
   * 连填替他按网站的下一步（2026-09-28）：这一页（规则、AI、求职信）都有了结局，没有要他处理的。没有点击，所以不经底栏；
   * 进度卡留着，写着「第 N 页：已填好 · 正在翻到下一页…」，「停止」一直在。
   */
  const autoAdvance = (pending: Promise<DockAdvanceOutcome>, label: string | null): void => {
    if (!sheetAllowed) return;
    const serial = runSerial;
    const needsAtClick = counts().needsLeft;
    advancing = true;
    autoAdvancing = true;
    autoAdvanceLabel = label;
    aiStep = false;
    chainHold = false;
    // 这一页的终局单子（等的时候收到的）：AI 那几栏不再画成「正在写」。
    if (current !== undefined) rows = rowsOf(current);
    flash.clear();
    menu = '';
    phase = 'advancing';
    notAdv = null;
    paint();
    void pending.catch((): DockAdvanceOutcome => 'UNAVAILABLE').then((outcome) => {
      advancing = false;
      if (serial !== runSerial) return;
      const stillAuto = autoAdvancing;
      autoAdvancing = false;
      autoAdvanceLabel = null;
      if (!stillAuto) {
        // 翻页的那几秒里他按了「停止」：已经停在这一页的总结上。宿主还是翻过去了，就回到可以点「自动填写」的样子。
        if (outcome === 'ADVANCED' || outcome === 'ADVANCED_FILLING') retireRun('ADVANCED');
        return;
      }
      settleAdvance(outcome, needsAtClick, true);
    });
  };
  const scrollMainTop = (): void => { main.scrollTo?.({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); };

  const retire = (): void => {
    runSerial += 1;
    if (runKey !== null) retiredRunIds.add(runKey);
    resetRun();
    unwatchHostFields();
    phase = 'idle';
  };
  const retireRun = (reason: DockRetireReason): void => {
    if (!sheetAllowed) return;
    retire();
    if (reason === 'ADVANCED_EMPTY') {
      flipPrep();
      phase = 'review';
      paint();
      return;
    }
    flipPrep();
    paint();
    toast(reason === 'ADVANCED' ? COPY.toast.advanced : COPY.toast.pageChanged);
  };

  /**
   * ⋯ 菜单里的「回到主页」（2026-09-24 负责人）：**不撤销**——网页上已经写好的都留着。这一轮在浮层上到此为止，
   * 之后送来的一概不收（与翻页、撤销同一个作废口径；审计记录一撤，调用方就停掉还没回来的 AI 答案）。
   * 再按「自动填写」就是新的一轮。动画：没有提交所以没有信封，底栏那颗深蓝的按钮飞到首页「自动填写」的位置
   * （信封第 7 段的时长与缓动），首页再一块一块淡进来。减少动态时直接换。
   */
  let homeFlight: HomeFlight | null = null;
  const goHome = (): void => {
    if (!doneLike() || submitting || phase === 'advancing') return;
    menu = '';
    flash.clear();
    const leave = (): void => {
      retire();
      paint();
      main.scrollTop = 0;
    };
    homeFlight?.cancel();
    homeFlight = null;
    if (reduced() || !open || route !== 'main' || bar.style.display === 'none') {
      paintPops();
      leave();
      return;
    }
    paintPops();
    const flight = flyHome({
      doc,
      words: envelopeWords,
      layer: pbody,
      button: barPrimary,
      snapshot: [main, bar],
      reduced: false,
      land: () => {
        leave();
        return { anchor: hero, items: [job, dataHead, dataCard] };
      },
    });
    homeFlight = flight;
    void flight.done.then(() => { if (homeFlight === flight) homeFlight = null; });
  };

  // ── 提交（2026-09-23 负责人决定：插件替用户按网站的提交）─────────────────
  let envelope: EnvelopeRun | null = null;
  const submit = async (event: MouseEvent): Promise<void> => {
    if (submitting) return;
    // mission 那条路的提交闸：用户在浮层里按「提交」就是他对这一页的逐项复核（取证同步做，派发一结束就取不到了）。
    const review = audit?.handlers;
    const reviewed: Promise<boolean> | null = review?.confirmFinalReview !== undefined && safe(() => review.canConfirmFinalReview?.() === true, false)
      ? Promise.resolve(review.confirmFinalReview(event, shadow)).catch(() => false)
      : null;
    const port = handlers.submission;
    // 他按的那颗按钮上写的是「去网站上提交」（2026-10-04）：哪怕此刻能按了（网站在两次重画之间放开了提交钮），也只请他去网站上
    // 点——按「去网站上提交」不等于确认提交。重画之后写成「提交」，他再按一次才替他按。
    const pressedSubmit = barPrimary.dataset.submit === 'plugin';
    if (port === undefined || !pressedSubmit || !submitAvailable()) {
      if (reviewed !== null) await reviewed;
      // 要他去网站上点提交：收起让开（网站的「提交」多半就在浮层下面，2026-09-28），再说一句。
      giveWayToSite();
      toast(port === undefined || (!pressedSubmit && submitAvailable()) ? COPY.toast.submitOnSite : COPY.toast.submitUnavailable);
      paint();
      return;
    }
    // 先把点击交出去（调用方同步取证），再动画：信封合上的那一刻才真按网站的提交。
    let pressNow: () => void = () => {};
    const pressAt = new Promise<void>((resolve) => { pressNow = resolve; });
    let pending: Promise<DockSubmitOutcome>;
    try {
      pending = port.send(event, shadow, pressAt);
    } catch {
      pending = Promise.resolve('UNAVAILABLE');
    }
    // 调用方在这一下里发现和插件断了线（它一下都没按网站的提交）：不播信封、不说「按不了」，主卡已经换成那张卡。
    if (orphaned) return;
    submitting = true;
    submitNote = null;
    const serial = runSerial;
    if (route !== 'main' || !open) {
      route = 'main';
      open = true;
      menu = '';
      flash.clear();
      paint();
      await wait(660, reduced());
    }
    flash.clear();
    menu = '';
    paint();
    const outcomePromise = pending.catch((): DockSubmitOutcome => 'UNAVAILABLE');
    envelope = startEnvelope({
      doc,
      words: envelopeWords,
      layer: pbody,
      button: barPrimary,
      cards: Array.from(main.querySelectorAll<HTMLElement>('[data-deck]')),
      fades: Array.from(main.querySelectorAll<HTMLElement>('[data-deck-fade]')),
      reduced: reduced(),
      onPress: () => pressNow(),
    });
    const outcome = await outcomePromise;
    if (serial !== runSerial) { envelope.cancel(); envelope = null; submitting = false; return; }
    if (outcome === 'SUBMITTED') {
      await envelope.succeed(async () => {
        // 信封飞回主卡的位置：先把主界面换成「已提交」的首页，再让信封落到「自动填写」上。
        const keepSerial = runSerial;
        retire();
        runSerial = keepSerial + 1;
        submitted = true;
        paint();
        return autofillButton;
      }, main);
      envelope = null;
      submitting = false;
      paint();
      return;
    }
    await envelope.fail();
    envelope = null;
    submitting = false;
    // 网站没收下，而是要邮件里的验证码（2026-10-04）：不报红条，那张卡（codePrompt）说清楚要他做什么。
    if (outcome === 'CODE_REQUIRED') { /* 卡由 codePrompt 画 */ }
    else if (outcome === 'NOT_SUBMITTED' || outcome === 'UNCONFIRMED') submitNote = outcome;
    else toast(outcome === 'UNTRUSTED' ? COPY.toast.untrusted : COPY.toast.submitUnavailable);
    paint();
    scrollMainTop();
  };

  // ── 拖动收起按钮 ────────────────────────────────────────────────
  let dragMoved = false;
  let drag: { pointerId: number; y: number; top: number } | null = null;
  lBtn.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const { vh } = geometry();
    // 记的是在看得见的那一段里的位置（嵌入帧那一段会随外层页面滚动换位置；不是嵌入帧时就是视口）。
    drag = { pointerId: event.pointerId, y: event.clientY, top: launcherTopPx(topRatio, 44, vh) };
    dragMoved = false;
    lBtn.setPointerCapture?.(event.pointerId);
  });
  lBtn.addEventListener('pointermove', (event) => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const dy = event.clientY - drag.y;
    if (Math.abs(dy) > 4) dragMoved = true;
    if (!dragMoved) return;
    launcher.dataset.dragging = 'true';
    const { vh, bandTop } = geometry();
    const top = Math.max(12, Math.min(vh - 56, drag.top + dy));
    topRatio = ratioOfTop(top, 44, vh);
    launcher.style.top = `${bandTop + launcherTopPx(topRatio, 44, vh)}px`;
  });
  const endDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag = null;
    delete launcher.dataset.dragging;
    if (dragMoved) {
      handlers.onMoveLauncher?.(topRatio);
      setTimeout(() => { dragMoved = false; }, 40);
    }
  };
  lBtn.addEventListener('pointerup', endDrag);
  lBtn.addEventListener('pointercancel', endDrag);

  // ── 键盘 ───────────────────────────────────────────────────────
  const fromUs = (event: Event): boolean => event.composedPath().includes(host);
  const onKey = (event: KeyboardEvent): void => {
    if (!event.isTrusted) return;
    const ours = fromUs(event);
    if (event.key === 'Escape' && ours) {
      if (aiLayer.closeCard()) return;
      if (menu !== '') { menu = ''; paintPops(); return; }
      if (route === 'profile') {
        if (profileEditor.handleEscape()) return;
        leaveProfile();
        return;
      }
      if (open) collapse();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S') && route === 'profile' && open && ours) {
      event.preventDefault();
      profileEditor.save();
    }
  };
  win?.addEventListener('keydown', onKey, true);

  // 点在菜单外面：收起菜单。网页上的点击在文档上听（关着的 shadow 从外面看只到宿主节点为止）；
  // 浮层里别处的点击在我们自己的根上听（那里看得见里面的节点）。
  const onPointerDown = (event: PointerEvent): void => {
    if (menu === '' || event.composedPath().includes(host)) return;
    menu = '';
    paintPops();
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointerdown', (event) => {
    if (menu === '') return;
    const path = event.composedPath();
    if (path.includes(popAccount) || path.includes(popMore) || path.includes(avatar) || path.includes(moreBtn)) return;
    menu = '';
    paintPops();
  }, true);

  const onResize = (): void => { paintLayout(); paintLauncher(); aiLayer.reposition(); };
  win?.addEventListener('resize', onResize);
  // 嵌入帧：看得见的那一段一变，就把收起按钮、面板与提示挪进去（只改我们自己的节点）。
  watchBand(() => {
    paintLayout();
    paintLauncher();
    paintToastPosition();
  });

  // ── 挂上 ───────────────────────────────────────────────────────
  paint();
  if (progress !== undefined) update(progress);
  // 自动打开：先看会不会盖住网站右侧的主要按钮（`autoOpenWidth`）——会就收窄让开，让不开就这一次先不开。
  // 网站的按钮常常比浮层晚出来（2026-10-04 测试台：Greenhouse Point72 的「Apply」「Submit application」、Workday 底部的「Next」
  // 都是浮层挂上之后才画出来的），挂上那一刻量到的不算数；开了再收起又会从他手底下把面板抽走。所以给了这一问时，等页面
  // 安静下来（加载完、之后一小段时间里没有新的节点）再量一次、只量这一次：盖不住就打开，盖得住就收窄，收不下就不开。
  // 等的这一会儿他自己点开、收起了，就照他的来，不再自动处理。
  const autoOpenNow = (): void => {
    const width = handlers.siteActions === undefined ? undefined : autoOpenWidth();
    if (width === null) return;
    if (width !== undefined && width < fullPanelWidth(geometry().vw)) autoWidthCap = width;
    // 用平常那段打开动画：上面那次 paint 按「收着」画好了，先让它生效（读一次计算样式，只算样式、不排版），
    // 再打开——面板从右边滑进来，而不是挂上就直接摆在那儿。不挪焦点：这一下不是他点的，他可能正在网页上打字。
    void win?.getComputedStyle?.(panel).transform;
    openPanel(false);
  };
  if (handlers.autoOpen === true && handlers.siteActions === undefined) autoOpenNow();
  else if (handlers.autoOpen === true) {
    let settled = false;
    let observer: MutationObserver | null = null;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (quiet !== null) clearTimeout(quiet);
      for (const timer of autoOpenTimers) clearTimeout(timer);
    cancelAutoOpen?.();
      // 等的这一会儿他自己点开、收起过：照他的来。
      if (!host.isConnected || open || touchedBeforeAutoOpen) return;
      autoOpenNow();
    };
    const hush = (): void => {
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(settle, AUTO_OPEN_QUIET_MS);
    };
    const watch = (): void => {
      const Observer = (win as (Window & { MutationObserver?: typeof MutationObserver }) | null)?.MutationObserver;
      if (Observer !== undefined && doc.body !== null) {
        try {
          observer = new Observer(hush);
          observer.observe(doc.body, { childList: true, subtree: true });
        } catch {
          observer = null;
        }
      }
      hush();
    };
    autoOpenTimers.push(setTimeout(settle, AUTO_OPEN_CAP_MS));
    if (doc.readyState === 'complete' || win === null) watch();
    else win.addEventListener('load', watch, { once: true });
    // 浮层被拆了（换脸、让位）：不再等、不再看页面。
    cancelAutoOpen = () => {
      settled = true;
      observer?.disconnect();
      if (quiet !== null) clearTimeout(quiet);
      win?.removeEventListener('load', watch);
    };
    root.addEventListener('pointerdown', () => { touchedBeforeAutoOpen = true; }, true);
  }
  // 上一页刚替用户按了提交、网站整页跳到了这里：打开面板，把信封的收尾（绿勾、「提交成功」）播完，
  // 再落到主卡上；岗位卡写「已提交」。
  if (handlers.justSubmitted === true) {
    submitted = true;
    if (!open) { open = true; hidden = false; }
    paint();
    const heroAnchor = hero;
    // 首页先藏着：面板打开的那一小段里不先露出主卡与「你的资料」，信封落到主卡上时它们再淡进来
    // （信封接手之后由它负责放出来；它没播成就在这里放出来）。
    const homeNodes = [heroAnchor, ...Array.from(main.querySelectorAll<HTMLElement>('[data-home-item]'))];
    for (const node of homeNodes) node.style.visibility = 'hidden';
    const reveal = (): void => { for (const node of homeNodes) node.style.visibility = ''; };
    setTimeout(() => {
      if (!host.isConnected) return;
      void arriveEnvelope({
        doc,
        words: envelopeWords,
        layer: pbody,
        anchor: heroAnchor,
        reduced: reduced(),
        land: async () => { paint(); return heroAnchor; },
        scroller: main,
      }).catch(reveal);
    }, reduced() ? 0 : 420);
  }

  let dismissed = false;
  const dismiss = (): void => {
    vaultList.clear();
    // 浮层没了：它驱动的那一轮（连填，2026-09-28）一并收场。只说一次。
    if (!dismissed) {
      dismissed = true;
      try {
        handlers.onDismissed?.();
      } catch {
        // 调用方收场出错不挡拆浮层：宿主页上不能留下我们的节点。
      }
    }
    envelope?.cancel();
    homeFlight?.cancel();
    finishJobMorph();
    aiLayer.clear();
    audit?.dismiss();
    unwatchHostFields();
    flash.destroy();
    endFeed();
    win?.removeEventListener('scroll', onViewportMove, true);
    win?.removeEventListener('keydown', onKey, true);
    win?.removeEventListener('resize', onResize);
    bandWatch?.stop();
    bandWatch = null;
    doc.removeEventListener('pointerdown', onPointerDown, true);
    for (const type of HOST_ACTIVITY_EVENTS) doc.removeEventListener(type, onHostActivity, true);
    if (toastTimer !== null) clearTimeout(toastTimer);
    for (const timer of autoOpenTimers) clearTimeout(timer);
    host.remove();
    if (dismissCurrent === dismiss) dismissCurrent = null;
  };
  dismissCurrent = dismiss;

  const rowsFor = (group: 'required' | 'optional'): readonly AutofillDockFieldRow[] =>
    (current?.rows ?? []).filter((row) => row.required === (group === 'required'));
  const runStateNow = (): DockRunState => phase === 'preparing' ? 'PREPARING'
    : phase === 'filling' || autoAdvancing ? 'RUNNING'
    : phase === 'failed' || (phase === 'done' && stopped) ? 'STOPPED'
    : phase === 'done' || phase === 'advancing' || phase === 'review' ? 'SETTLED' : 'IDLE';
  const sceneNow = (): DockScene => route === 'profile' ? 'PROFILE' : phase === 'idle' ? 'HOME' : 'AUTOFILL';

  return Object.freeze({
    face: () => affordance.kind,
    faceKey: () => affordanceFaceKey(affordance),
    autofillEnabled: () => autofillButton !== null && !autofillButton.disabled,
    autofillButton: () => autofillButton,
    dismiss,
    sheetState: () => (phase === 'idle' ? 'ABSENT' as const : sheetCollapsed ? 'AUTOFILL_STICKY_COLLAPSED' as const : 'AUTOFILL_EXPANDED' as const),
    summaryText: () => {
      if (phase === 'idle') return null;
      if (phase === 'failed') return heroTop?.querySelector('.face-title')?.textContent ?? null;
      if (autoAdvancing) return COPY.chain.advancing;
      if (aiStep) return aiDraftingLine();
      if (current === undefined) return phase === 'preparing' ? COPY.run.summaryPreparing : heroRefs.sumTitle?.textContent ?? null;
      const phased = (current as { phase?: unknown }).phase;
      // 联调包（connected）的运行只报阶段与计数：照它自己的说法。
      if (typeof phased === 'string' && (phased !== 'SETTLED' || current.rows.length === 0)) return dockRunSummary(current as DockRunProgress, COPY);
      // 途中：必填的计数（收起按钮与读屏用的那一行）。
      if (typeof phased !== 'string') {
        const { requiredCompleted: done, requiredQuestions: total } = current;
        return COPY.run.required(done, total);
      }
      return heroRefs.sumTitle?.textContent ?? null;
    },
    toggleSheet: () => {
      if (phase === 'idle') return;
      sheetCollapsed = !sheetCollapsed;
      if (sheetCollapsed) closePanel(); else openPanel();
    },
    fieldRows: rowsFor,
    update,
    beginRun,
    isOpen: () => open,
    // 关着的 shadow 从文档那一层看只到宿主节点：焦点在浮层里的任何一处，文档的 activeElement 都是它。
    hasFocus: () => doc.activeElement === host,
    launcherButton: () => lBtn,
    addJobButton: () => null,
    entryButtons: () => entryButtons.slice(),
    attentionCount: () => counts().needsLeft,
    rowValues: (group: 'required' | 'optional') => rowsFor(group).map((row) => row.value ?? null),
    reviewButtons: () => (doneLike() ? { edit: editItem, fill: rerunItem } : { edit: null, fill: null }),
    openPanel: () => openPanel(),
    closePanel,
    setNotice: (text: string) => toast(text),
    sheetFace: () => (phase === 'idle' ? 'ABSENT' as const : filling() || autoAdvancing ? 'WORKING' as const : 'COMPLETE' as const),
    scene: sceneNow,
    runState: runStateNow,
    beginPreparing,
    setStep,
    finishRun,
    reportBlocked,
    showAudit,
    openProfile,
    backHome: () => { if (route === 'profile') leaveProfile(); },
    profileRoot: () => (route === 'profile' ? profileEditor.element : null),
    sceneRoot: () => pbody,
    toast,
    retireRun,
    nextStepButton: () => {
      if (bar.style.display === 'none') return null;
      if (barPrimaryAct === 'advance') return barPrimary;
      if (barSecondary.dataset.act === 'advance' && barSecondary.style.display !== 'none') return barSecondary;
      return null;
    },
    primaryButton: () => (bar.style.display === 'none' ? null : barPrimary),
    refreshAccount: () => { paint(); },
    forgetUser: () => {
      acctMenuOpen = false;
      vaultList.clear();
      paintSiteAccounts();
      // 上一个人的开关状态：下次打开菜单时按新的人重新问。
      aiOn = null;
      memoryOn = null;
      profileEditor.forget(route === 'profile');
      paint();
    },
    revalidateProfile: () => { if (route === 'profile') profileEditor.revalidate(); },
    refreshJob: () => { paint(); },
    setAiAnswers: (state: DockAiAnswersState) => {
      if (!sheetAllowed) return;
      const before = aiState.kind;
      aiState = state;
      if (state.kind === 'APPLIED' && before !== 'APPLIED') toast(COPY.ai.applied(state.count));
      // AI 还在起草、流上又到了一批（2026-09-24）：还在写的那几栏变少了——按手里这份单子重新分「正在写」与「需要你」，
      // 不等下一份单子（这一批可能一栏都没写上，只有 AI 看过、没找到依据的）。
      if (aiStep && current !== undefined) rows = rowsOf(current);
      paint();
    },
    setAiTools: (tools: DockAiTools | null) => {
      if (!sheetAllowed) return;
      aiTools = tools;
      if (tools !== null && aiOn === null) loadAiSwitch();
      paint();
    },
    setAiNoEvidence: (targets: readonly Element[]) => {
      if (!sheetAllowed) return;
      aiNoEvidence = new Set(targets);
      paint();
    },
    setAiUnanswered: (targets: readonly Element[]) => {
      if (!sheetAllowed) return;
      aiUnanswered = new Set(targets);
      paint();
    },
    noteRemembered: () => {
      if (!sheetAllowed) return;
      memoryOn = true;
      // 说得久一点（两件事：记住了、在哪里关），仍是一句轻的提示，不挡着什么。
      toast(COPY.memory.noted, 4_600);
    },
    setCoverLetter: (state: DockCoverLetterState) => {
      if (!sheetAllowed) return;
      const before = letterState.kind;
      letterState = state;
      if (state.kind === 'ATTACHED' && before !== 'ATTACHED') toast(COPY.letter.attached);
      // 还在写的那几栏换了状态：按手里这份单子重新分「正在写」与「需要你」。
      if (current !== undefined) rows = rowsOf(current);
      paint();
    },
    setChain: (state: DockChainState | null) => {
      if (!sheetAllowed) return;
      chain = state;
      // 连填还要往下翻：这一页的终局单子先不收尾（见 chainHold）。停下了（或不连填）就照常收尾。
      chainHold = state !== null && state.stop === null;
      paint();
    },
    autoAdvance,
    setAccountWall: (wall: DockAccountWall | null) => {
      if (!sheetAllowed || (wall?.action === accountWall?.action && wall?.site === accountWall?.site)) return;
      accountWall = wall;
      // 账号墙不见了（他自己在网站上登录了、或我们替他过去了）：停在账号墙上的那张卡不再算数。这一轮还在走时由它自己收。
      if (wall === null && accountAsk !== null && phase !== 'preparing') accountAsk = null;
      paint();
    },
    accountStatus,
    accountPrompt,
    accountContinuing: () => {
      if (!sheetAllowed) return;
      accountAsk = null;
      beginPreparing(COPY.siteAccount.continuing);
    },
    extensionUpdated,
    codePrompt: (prompt: DockCodePrompt | null) => {
      if (!sheetAllowed) return;
      const before = codeAsk;
      // 网站说了新的一句（验证码不对、过期了），或者那一块不见了：上一次「已填进网站」不再算数。
      if (prompt === null || before === null || prompt.error !== before.error || prompt.siteSays !== before.siteSays) {
        if (prompt === null || prompt.error !== null) codeFilledHere = false;
        codeNote = null;
      }
      if (prompt === null) codeDraft = '';
      const same = JSON.stringify(prompt) === JSON.stringify(before);
      codeAsk = prompt;
      // 网站刚开始要验证码：打开面板（不挪焦点——他可能正在网页上打字）。
      if (prompt !== null && before === null && !open) { open = true; hidden = false; safe(() => handlers.onPanelOpen?.(), undefined); }
      if (same) return;
      flipPrep();
      if (prompt !== null) submitNote = null;
      paint();
    },
  });
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
