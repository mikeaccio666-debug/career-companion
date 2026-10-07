import { FULL_AI_LIMITS, parseAssistantDockVisibility, type FullAiField, type FullAiJob } from '@edaix/contracts';
/**
 * 隔离世界内容脚本（inert 注入 + backend runtime authority）。
 *
 * 为什么宽注入：申请表可以出现在任何域名（白标/自定义域），枚举主机名
 * 永远追不上——注入 ≠ 动手，进来先跑否决，认不出厂商就立刻退出。
 *
 * 启动时只做两件 inert 操作：
 *  1. 向背景 SW 报到（origin → tab 登记；不申请 tabs 权限就能定位目标页
 *     ——那个权限会在商店审核挂"读取浏览历史"警告）；
 *  2. 挂桥端口监听。只有 verified intent + fresh backend bundle 的 exact
 *     mapping 到达后才允许 DOM scan；fill 前再校同一 release/ruleset。
 *
 * ⚠️ 注入范围纪律（tests/injection-scope-gate 锁死）：
 *  - 本隔离世界入口可用 AUTOFILL_WIDE_MATCHES（宽表）；
 *  - 将来任何 MAIN world 入口**只许**用 applyHostMatchPatterns 的窄表——
 *    它是 page-observable 的通道，跟宽表扩围 = 在用户网银页面装监听器。
 */

import { claimAssistantExecutor, markAssistantExecutorReady, markAssistantExecutorFailed } from '../assistant/features/autofill/executor-installation';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { installApplyAdaptersFromRules } from '../lib/executionRuntimeAuthority';
import { browser } from 'wxt/browser';
import {
  AUTOFILL_EXCLUDE_MATCHES,
  AUTOFILL_WIDE_MATCHES,
  detectApplyVendor,
  type ApplyVendor,
} from '@edaix/apply-kernel/vendors';
import type { ScanRootMutationPolicy } from '@edaix/apply-kernel/scanRoot';
import { KERNEL_BRIDGE_PORT_NAME, type BridgePortLike } from '../lib/bridgeProtocol';
import { parseDockFrameYield, parseDockTopYield } from '../lib/frameFormRegistry';
import { applicationFormTarget, fingerprintVendorHint, shouldYieldToEmbeddedFrame } from '@edaix/apply-kernel/gate';
import { createAccountAccessPage } from '../lib/accountAccessPage';
import { createVerificationCodePage } from '../lib/verificationCodePage';
import { createDockOpenApplicationFormIntent } from '../lib/openApplicationFormIntent';
import { withDocumentPath } from '../lib/documentPath';
import { createDockQuestionDraftIntent, parseDockQuestionDraftReply } from '../lib/questionDraftIntent';
import {
  createDockApplyMaterialsIntent,
  parseDockApplyMaterialsReply,
} from '../lib/applyMaterialsIntent';
import { createNearbyPostingReader, detailPageUrl, hasJobPosting, readJobCardFromPage, readJobSummaryFromPage, type NearbyPostingReader, type PageJobSummary } from '../lib/jobCardFromPage';
import { createPageEvidenceTracker } from '../lib/pageEvidence';
import { createSubmitController, type SubmitCodeMark } from '../lib/submitController';
import { DOCK_SUBMIT_PRESSED, DOCK_SUBMIT_SETTLED } from '../lib/dockSubmitPressed';
import { browserDockLocale, dockCopy, type DockLocale } from '../lib/dock/copy';
import type { DockProfileEditorPorts } from '../lib/dock/profileEditorPorts';
import { eeoAnswersBeyondDock, eeoAnswersForSave } from '../lib/dock/eeoSave';
import { onSamePagePathChange } from '../lib/samePagePathChange';
import { inferRegionCode } from '@edaix/apply-kernel/regions';
import { fillFromGesture } from '../lib/gestureFill';
import {
  createDockResumeAttachmentIntent,
  parseDockResumeAttachmentReply,
  type ResumeAttachmentStep,
} from '../lib/resumeAttachmentIntent';
import { createDockCoverLetterIntent, parseDockCoverLetterReply } from '../lib/coverLetterIntent';
import { COVER_LETTER_WAIT_MS, coverLetterFromWorker, shownLetterRefusal, type AskCoverLetter, type CoverLetterOutcome } from '../lib/coverLetterSeam';
import { coverLetterPageJob } from '../lib/coverLetterPageJob';
import { coverLetterTargets } from '@edaix/apply-kernel/engine';
import { pageOffersFileInput, resumeSeamFromWorker } from '../lib/resumeSeam';
import {
  ANSWER_MEMORY_NOTICE_VERSION,
  createDockAnswerMemoryIntent,
  parseDockAnswerMemoryReply,
  type AnswerMemorySettings,
  type DockAnswerMemoryReply,
} from '../lib/answerMemoryIntent';
import { matchRememberedAnswers, memoryCandidates, rememberRequestsFor } from '../lib/answerMemoryReuse';
import { createDockAnswers } from '../lib/dockAnswers';
import {
  AI_ANSWERS_STREAM_PORT,
  createDockAiAnswersIntent,
  parseDockAiAnswersReply,
  type DockAiAnswersPayload,
  type DockAiAnswersReply,
} from '../lib/aiAnswersIntent';
import {
  createAiAnswersSession,
  createAiStreamReceiver,
  type AiAnswersSink,
  type KernelAiAnswersOutcome,
  type KernelAiProgress,
} from '../lib/aiAnswers';
import { closeGestureRun } from '../lib/gestureRunClose';
import { QUESTION_DISCLOSURE_VERSION } from '../lib/questionReviewPanel';
import type { PatchCandidateProfileV2, RememberedAnswerV1 } from '@edaix/contracts';
import { captureTrustedShadowGesture, type GestureRoot, type TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { detectHumanCheckpoint, findWizardNextControl, readWizardProgress, sitePrimaryActions } from '@edaix/apply-kernel/wizardAdvance';
import { readPageGaps, type PageGaps } from '@edaix/apply-kernel/pageGaps';
import { withPageGaps } from '../lib/pageGaps';
import { createSigningReconsent, SIGNING_RECONSENT_DECLINED_KEY } from '../lib/signingReconsent';
import {
  MISSION_RUN_WAIT_MS,
  createDockMissionSession,
  withinBudget,
} from '../lib/dockMissionContent';
import {
  handleKernelBridgePort,
  invalidateRetainedContentScan,
  invalidateRetainedContentScanState,
} from '../lib/contentBridge';
import {
  genericApplyFormEvidence,
  openVerifiedHostShadowRoot,
  scanCurrentPageWithDiscoveryAuthority,
  scanCurrentPageWithRuntimeAuthority,
  type KernelPageScan,
  type KernelScanMutationGuard,
  type RuntimeKernelScanGate,
} from '../lib/kernelScanner';
import { noticeForRescan } from '../lib/rescanNotice';
import { fillFromGrant, type KernelFillAudit, type KernelFillLive } from '../lib/kernelFiller';
import type { AuditView } from '@edaix/apply-kernel/audit';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import {
  parseRuntimeExecutionAuthorization,
  resolveStoredDiscoveryRuntimeAuthority,
  resolveStoredExecutionRuntimeAuthority,
  type RuntimeExecutionAuthorization,
} from '../lib/executionRuntimeAuthority';
import { EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY } from '../lib/executionRuntimeBundleStore';
import { parseApplicationQuestionSchemaV1 } from '@edaix/contracts';
import { withSchemaOptions } from '../lib/applicationQuestionSchema';
import { showAuditPanel } from '../lib/auditPanel';
import { startLateRecheck } from '../lib/lateRecheck';
import { advanceAllowed, createWizardAdvanceController, finalSubmitOnPage, isRenderedControl, nextControlState } from '../lib/wizardAdvanceController';
import { openApplyFormFirst } from '../lib/applyGateOpen';
import { readRuntimeApplyGate, readRuntimeConsentGate } from '@edaix/apply-kernel/runtimeRegistry';
import { chooseConsentGateResidence } from '@edaix/apply-kernel/consentGate';
import { passConsentGate } from '../lib/consentGatePass';
import { DOCK_CONSENT_GATE_CHOSEN, DOCK_CONSENT_GATE_SETTLED } from '../lib/consentGateNote';
import { chainDockState, createFillToReview, requiredNeedsIn, type FillToReview } from '../lib/fillToReview';
import { NEXT_PAGE_SCAN_BUDGET_MS, createAdvanceThenFill, scanWhenReady } from '../lib/advanceThenFill';
import type { ApplyPolicy } from '@edaix/apply-kernel/policy';
import { classifySiteSupport } from '../lib/siteSupport';
import { showSiteNotice } from '../lib/siteNotice';
import {
  affordanceFaceKey,
  mountAutofillDock,
  parseAutofillDockInstruction,
  parseDockFaceReply,
  parseDockRunStep,
  type AutofillDockHandle,
  type DockAiGenerateOutcome,
  type DockJobCard,
} from '../lib/autofillDock';
import { nextFaceRetryDelayMs } from '../lib/autofillDockDecision';
import type { AutofillAffordance } from '../product-panel/affordance';
import { createDockPortalIntent, type DockPortalPage } from '../lib/dockPortalIntent';
import { parseDockVaultTransitionIntent } from '../lib/accountVaultTransitionIntent';
import { isDockSessionChanged } from '../lib/dockSessionChanged';
import { isDockProfileChanged } from '../lib/dockProfileChanged';
import { createDockDiagnostic, createDockErrorDiagnostic, type DockErrorCode, type DockPlainCode } from '../lib/dockDiagnostic';
import { ASK_WORKER_DEADLINE_MS, DEADLINE_PASSED, withDeadline } from '../lib/deadline';
import { createRunOutcomeTap, type RunOutcomeTap } from '../lib/runOutcomeTap';
import { runVendor } from '../lib/runOutcome';
import { loadSiteKnowledge } from '../lib/siteKnowledge';
import { hostFieldHasValue } from '../lib/dock/hostField';
import { LAUNCHER_TOP_RATIO_KEY } from '../product-panel/launcherPosition';
import { DOCK_COLLAPSED_AT_KEY, collapsedRecently, createDockAutoOpen, freshCollapses, withCollapse, withoutCollapse, type DockAutoOpen } from '../lib/dockAutoOpen';
import { DOCK_LOCALE_KEY, storedDockLocale } from '../lib/dockLanguage';
import { createDirectoryRun } from '../lib/directoryRun';
import { DIRECTORY_CACHED_REQUEST } from '../lib/directoryRequest';
import { createProfileDirectoryClient } from '../lib/profileDirectoryClient';
import { dockProgressFromAudit, dockProgressWhileFilling } from '../lib/autofillDockProgress';
import {
  buildExecutionTelemetryDraft,
  buildStructureReportDraft,
  frameDepthBucket,
  supportsTrustTelemetryVendor,
} from '../lib/trustTelemetryPayload';
import {
  installScanMutationThrottle,
  type ScanMutationThrottleHandle,
} from '../lib/scanMutationThrottle';
import {
  addExactReviewInvalidationListener,
  captureExactFormValueSeal,
  createSubmissionGestureGate,
  installEarlySubmissionCaptureBroker,
  resolveFinalSubmissionTarget,
  type SubmissionGestureGate,
} from '../lib/submissionGestureGate';
import type { SubmissionArmDescriptor } from '../lib/submissionBoundaryProtocol';
import { enforceHostSubmissionContainmentPolicy } from '../lib/hostWriteContainment';
import {
  installPilotUa1ContentTrigger,
  type PilotUa1RuntimeMessageApi,
} from '../lib/pilotUa1DiscoveryRuntime';

/** How the dock names a vendor. The registry's keys are ours; the words are the brands' own. */
const VENDOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', smartrecruiters: 'SmartRecruiters',
  jobvite: 'Jobvite', icims: 'iCIMS', workday: 'Workday', avature: 'Avature', bamboohr: 'BambooHR', rippling: 'Rippling',
  teamtailor: 'Teamtailor', personio: 'Personio', recruitee: 'Recruitee', breezy: 'Breezy',
});
function vendorDisplayName(hostname: string): string | undefined {
  const vendor = detectApplyVendor(hostname);
  if (vendor === null) return undefined;
  return VENDOR_NAMES[vendor] ?? `${vendor.charAt(0).toUpperCase()}${vendor.slice(1)}`;
}

/** main() 起来的那一段抛了：里面那一套（runtimeAlive、sendToWorker）还没立起来，直接发。和插件断了线就记不下。 */
function reportMainThrew(error: unknown): void {
  try {
    if (typeof browser.runtime?.id === 'string') void browser.runtime.sendMessage(createDockErrorDiagnostic('APPLY_MAIN_THREW', error)).catch(() => undefined);
  } catch {
    // 和插件断了线：sendMessage 当场就抛。没有第二条路可报。
  }
}

/** 用户本地时区的当天，ISO `YYYY-MM-DD`（签名日期用；内核自己不碰时钟）。 */
function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface PendingScanMutationGuard extends KernelScanMutationGuard, ScanMutationThrottleHandle {
  readonly policy: ScanRootMutationPolicy;
  readonly activate: (onInvalidate: () => void) => boolean;
}

interface SubmissionArmBinding {
  readonly descriptor: SubmissionArmDescriptor;
  readonly scan: KernelPageScan;
  readonly purpose: 'submission-boundary' | 'fill-window';
}

interface SuspendedSubmissionArm {
  readonly descriptor: SubmissionArmDescriptor;
  readonly gate: SubmissionGestureGate;
  readonly purpose: SubmissionArmBinding['purpose'];
}

/** Observer is installed before the scan digest await, then activated atomically. */
function createPendingScanMutationGuard(
  policy: ScanRootMutationPolicy,
): PendingScanMutationGuard | null {
  let dirty = false;
  let activeInvalidation: (() => void) | null = null;
  const handle = installScanMutationThrottle({
    policy,
    onInvalidate: () => {
      dirty = true;
      activeInvalidation?.();
    },
  });
  if (!handle) return null;

  const isCurrent = () => {
    if (dirty) return false;
    try {
      return policy.isCurrent();
    } catch {
      return false;
    }
  };
  return {
    policy,
    isCurrent,
    activate: (onInvalidate) => {
      if (!isCurrent()) return false;
      activeInvalidation = onInvalidate;
      return isCurrent();
    },
    dispose: () => handle.dispose(),
  };
}

export default defineContentScript({
  // WXT evaluates registration for this build; final manifest tests enforce no automatic Assistant injection.
  // For programmatic injection, matches/excludes are inert: exact owner/page/document attestation is the boundary.
  registration: typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__ ? 'runtime' : 'manifest',
  matches: [...AUTOFILL_WIDE_MATCHES],
  excludeMatches: [...AUTOFILL_EXCLUDE_MATCHES],
  // 嵌入式 ATS 板（雇主自家页面里嵌 Greenhouse embed/job_app）把申请表放在
  // 跨源 iframe 里。顶层文档看见那个 iframe 就让位（gate/frameArbitration），
  // 不进子帧就没有任何一帧持有表单——让位让给了空气。
  // 这不扩注入面：跑哪些 URL 仍由 matches/excludeMatches 与主机否决决定，
  // 这里只说"已经匹配的 URL 里跑哪些帧"。
  allFrames: true,
  runAt: 'document_start',
  // WXT 默认在每一帧往页面上 postMessage「<扩展 ID>:apply:wxt:content-script-started」：任何网站的 message 监听都收得到，
  // 借它就能认出用户装了 ArgoLand（2026-10-03 实测 63 次里 63 次）。那条广播只为兼容老版本 WXT 的「新的来了、旧的停下」；
  // 我们的 main() 从不用 ctx（失效了也没有东西可停），商店包又是 manifest 注入（新旧两份从不同在一个文档里），无事可做。
  // 只关这一条，document 上的 CustomEvent 照旧（tests/content-script-started-message.test.ts；商店包产物由 store-manifest 钉）。
  noScriptStartedPostMessage: true,
  main() {
    const assistant = typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__;
    if (assistant && (window.top !== window.self || !claimAssistantExecutor())) return;

    try {
    // 主机不在厂商表里的子帧（广告、视频、验证码、社交插件、站内小部件……）从不报到（见 hello），永远拿不到浮层：
    // 下面的站点规则与早装的提交拦截在它那里都用不上，就不付这笔钱（2026-10-03 全网注入实测：每一帧约 90 KB 规则
    // 再编译复核一遍、window 上一排捕获监听）。hello 不报到用的就是这一个值，两处不会各说各的。
    // 主机在厂商表里的子帧（公司官网里嵌的 Greenhouse 申请表）与顶层帧一切照旧。
    const inertSubframe = window.top !== window.self && detectApplyVendor(location.hostname) === null;
    // 站点知识不再随包内置（2026-09-15：11 家规则 43,409 字节整个移出产物），
    // 所以注入后先向 background 要一次它已经从后端取到的那一份，编译好装进
    // 识别路径。这条消息只取规则，不带任何授权——拿到它也只能"看懂页面"，
    // 动手仍要走完整的意向链。
    //
    // 要不到就隔一会儿再要一次（只一次），两次都没要到装空表（识别随之 fail closed）、记一个码（2026-10-04 体检 10-6：
    // 从前要不到就什么都不做，后端抖一下，白标与公司自建的表这一整次加载都认不出，后台一个码都没有；lib/siteKnowledge.ts）。
    // 这里必须一个异常都不能逃逸——下面那个 try 的 catch 负责标记 executor FAILED，游离的 promise rejection 会绕过它。
    // 规则装上之后再看一眼页面（通用表要靠规则才认得出，`recheckEvidence`，下面赋值）。
    const afterRulesInstalled: { run: () => void } = { run: () => {} };
    // 无关子帧（inertSubframe）照旧不要规则（#143）；要规则的帧照 lib/siteKnowledge.ts 再要一次、记码（#147）。
    if (!inertSubframe) {
      void loadSiteKnowledge({
        ask: async () => browser.runtime.sendMessage({ kind: 'apply-site-knowledge/get' }),
        install: async (rules) => { await installApplyAdaptersFromRules(rules); },
        // `reportDockDiagnostic` 在下面才定义；这一句只在第一次要规则的答复回来之后才跑，那时早已定义好。
        onDiagnostic: (code) => reportDockDiagnostic(code),
      }).then(() => afterRulesInstalled.run()).catch((error: unknown) => reportDockError('APPLY_LISTENER_THREW', error));
    }

    if (
      typeof __VIBE_PILOT_UA1_DISCOVERY_ENABLED__ !== 'undefined' &&
      __VIBE_PILOT_UA1_DISCOVERY_ENABLED__
    ) {
      installPilotUa1ContentTrigger({
        enabled: true,
        runtime: browser.runtime as unknown as PilotUa1RuntimeMessageApi,
      });
    }
    // Installed before any await, scan, or authority lookup. Until an exact
    // kernel target is bound it is selector-free and inert.
    // 没装的帧（inertSubframe）一律不武装提交闸门（installSubmissionGate 里 fail closed）。
    const earlySubmissionCapture = inertSubframe ? null : installEarlySubmissionCaptureBroker(window, document);
    // 安装端口监听与 DOM 授权分离：内容脚本可以报到并等待，但在收到一个
    // 已验签 intent 绑定的 selector-free runtime authorization、且本地原子缓存
    // 再次严格验过之前，不读取页面 DOM，也不创建 UI，更不写宿主控件。
    const isTopFrame = window.top === window.self;
    // 子帧持表（P2-10）：后台答「这个标签页的申请表在你这一帧」之后才为真。它是子帧挂浮层、
    // 收进度的唯一放行条件；顶层帧永远不看它。
    let frameOwnsDock = false;
    // 白标 B（P2-11）：主机不在厂商表里时，按厂商自己的产物算一次「先试哪家」（与门控同一个函数）。
    // 只是提示：worker 只在主机表答不出时才用它，随后 resolveRoot 认不出就照常 null。
    const whitelabelHost = detectApplyVendor(location.hostname) === null;
    /** 替他点开申请表之后，表单渲染出来之前扫描照旧停在这一种上：等，不当结论（D8）。 */
    const APPLY_GATE_NOT_READY: ReadonlySet<string> = new Set(['APPLY_FORM_NOT_OPENED']);
    /** 这几种停因说的都是「这一页上没有我们认得的表」；别的停因（页面在变、没授权）不该去开新标签。 */
    const NO_FORM_STOPS: ReadonlySet<string> = new Set([
      'ROOT_NOT_FOUND', 'NO_KEYED_FIELD', 'RULES_MATCHED_NOTHING', 'PATH_NOT_APPLY', 'NO_FORM_FOUND',
      // 「表单还没打开」也属于这一页上没有我们认得的表（BambooHR 的 /careers/<id>）。
      'APPLY_FORM_NOT_OPENED',
    ]);
    const applicationFormTargetOnPage = () => {
      try {
        return applicationFormTarget({ doc: document, url: new URL(location.href) });
      } catch {
        return null;
      }
    };
    const vendorHint = (): ApplyVendor | null => {
      if (!whitelabelHost) return null;
      try {
        return fingerprintVendorHint({ doc: document, url: new URL(location.href) });
      } catch {
        return null;
      }
    };
    /**
     * 这一页走三层里的哪一层——与 worker 的 `pageVendor` **同一个次序、同一条判据**：
     * 主机表答得出就两个都不是；答不出时看指纹提示，有提示走白标、没提示走通用。
     *
     * 互斥是必须的，不是整洁：`isApplyPath` 先看白标位，而通用规则集没有
     * `whitelabelRoot`——在通用页上把白标位也打开，等于当场把通用路堵死。
     */
    const pageLane = (): Readonly<{ whitelabel: boolean; generic: boolean }> => {
      if (!whitelabelHost) return { whitelabel: false, generic: false };
      return vendorHint() === null
        ? { whitelabel: false, generic: true }
        : { whitelabel: true, generic: false };
    };
    /**
     * 主机不在厂商表里的页面上，浮层为什么该露面（2026-09-24，商店包开全网）：厂商指纹、恰好一张通用申请表、
     * 页面自己声明的 JobPosting。后台只凭这几件事判——什么都没有的页面（百科、新闻、搜索）什么都不挂。
     * 只在顶层帧上看；只增不减，换路径才清（`lib/pageEvidence.ts`）。
     *
     * `!assistant` 放在最前：Assistant 构建里它是编译期常量 false，整段连同两个读法一起被删掉（apply.js 预算）。
     */
    const watchesEvidence = !assistant && isTopFrame && whitelabelHost;
    const pageEvidence = !watchesEvidence ? null : createPageEvidenceTracker({
      pathname: () => location.pathname,
      vendorHint,
      genericForm: () => {
        try {
          return genericApplyFormEvidence(document);
        } catch {
          // 读不动这一页就当没有表：不挂浮层是保守的那一边。
          return 'NONE';
        }
      },
      jobPosting: () => {
        try {
          return hasJobPosting(document);
        } catch {
          return false;
        }
      },
    });
    let submissionGate: SubmissionGestureGate | null = null;
    let submissionArmBinding: SubmissionArmBinding | null = null;
    let scanMutationThrottle: ScanMutationThrottleHandle | null = null;
    let activeMutationPolicy: ScanRootMutationPolicy | null = null;
    let activeScan: KernelPageScan | null = null;
    let activeScanEpoch: object | null = null;
    let scanAttemptRevision = 0;
    let fillAttemptRevision = 0;
    const activeFillControllers = new Map<AbortController, KernelPageScan>();
    // The standing dock, once the background has said this page may show one.
    let dockHandle: AutofillDockHandle | null = null;
    // 浮层说哪一种话（2026-09-25）：浏览器界面是中文就说中文，否则说英文。用到时才读——浮层挂不出来的
    // Assistant 构建里，用到它的这几处连同浮层一起是死代码，打包时整个删掉。
    // 用户在账户菜单里选过语言（2026-09-27）就照他选的：报到时从 storage.local 读回来（`DOCK_LOCALE_KEY`）。
    let dockLocaleNow: DockLocale | null = null;
    const dockLocale = (): DockLocale => (dockLocaleNow ??= browserDockLocale());
    // 最后挂上的那张脸：换语言时拿它原样重挂一遍（不带「刚提交」，那一段不该重播）。
    let lastFaceReply: { readonly dock: unknown } | null = null;
    let assistantOwnsDock=assistant;

    const tombstoneSubmissionGate = () => {
      submissionGate?.retireToBlockedTombstone();
      submissionArmBinding = null;
    };

    const abortFillsForScan = (scan: KernelPageScan) => {
      for (const [controller, fillScan] of activeFillControllers) {
        if (fillScan === scan) controller.abort();
      }
    };

    const retireActiveScan = (invalidateRetained: boolean) => {
      const previousScan = activeScan;
      const current = scanMutationThrottle;
      activeScan = null;
      activeScanEpoch = null;
      activeMutationPolicy = null;
      scanMutationThrottle = null;
      tombstoneSubmissionGate();
      if (previousScan) {
        abortFillsForScan(previousScan);
        if (invalidateRetained) invalidateRetainedContentScan(previousScan);
      }
      current?.dispose();
    };

    /**
     * A revalidation may await storage and a fresh DOM digest. Keep the old
     * form-local listener installed throughout that gap, but strip its review
     * latch and make its generation unverifiable. It therefore remains a
     * synchronous fail-closed blocker until the candidate is atomically
     * activated and a replacement gate is installed.
     */
    const suspendActiveScanForRevalidation = (
      scan: KernelPageScan,
    ): SuspendedSubmissionArm | null => {
      if (
        activeScan !== scan ||
        submissionGate === null ||
        submissionArmBinding?.scan !== scan
      ) {
        retireActiveScan(false);
        return null;
      }
      const suspended = Object.freeze({
        descriptor: submissionArmBinding.descriptor,
        gate: submissionGate,
        purpose: submissionArmBinding.purpose,
      });
      const previousObserver = scanMutationThrottle;
      submissionGate.retireToBlockedTombstone();
      submissionArmBinding = null;
      activeScan = null;
      activeScanEpoch = null;
      activeMutationPolicy = null;
      scanMutationThrottle = null;
      abortFillsForScan(scan);
      previousObserver?.dispose();
      return suspended;
    };

    const disposeSuspendedSubmissionArm = (
      suspended: SuspendedSubmissionArm | null,
    ): void => {
      // A concurrent scan may already have retired this exact gate and installed
      // another. Never let a stale rejection tear down the newer generation.
      if (suspended !== null && submissionGate === suspended.gate) {
        tombstoneSubmissionGate();
      }
    };

    const activateScanMutationGuard = (
      scan: KernelPageScan,
      pending: PendingScanMutationGuard,
    ): boolean => {
      if (!isRuntimeDeadlineCurrent(scan)) {
        pending.dispose();
        return false;
      }
      const epoch = Object.freeze({});
      const activated = pending.activate(() => {
        // Attempt identity is object/generation based. scanDigest deliberately
        // stays equal across same-target scans with the same field-key set.
        if (
          scanMutationThrottle !== pending ||
          activeScanEpoch !== epoch ||
          activeScan !== scan
        ) return;
        scanMutationThrottle = null;
        activeScanEpoch = null;
        activeMutationPolicy = null;
        activeScan = null;
        tombstoneSubmissionGate();
        abortFillsForScan(scan);
        invalidateRetainedContentScan(scan);
        pending.dispose();
      });
      if (!activated) {
        pending.dispose();
        return false;
      }
      scanMutationThrottle = pending;
      activeScanEpoch = epoch;
      activeMutationPolicy = pending.policy;
      activeScan = scan;
      return true;
    };

    const isCurrentScanTarget = (scan: Readonly<{
      canonicalOrigin: string;
      jobId: string;
    }>) => location.origin === scan.canonicalOrigin && location.pathname === scan.jobId;

    const isRuntimeDeadlineCurrent = (scan: KernelPageScan): boolean => {
      if (scan.runtimeAuthorization === undefined) return true;
      const freshUntil = scan.runtimeFreshUntilMs;
      const notAfter = scan.runtimeNotAfterMs;
      const now = Date.now();
      return typeof freshUntil === 'number' && Number.isFinite(freshUntil) &&
        typeof notAfter === 'number' && Number.isFinite(notAfter) &&
        Number.isFinite(now) && now < freshUntil && now < notAfter;
    };

    const installSubmissionGate = (
      descriptor: SubmissionArmDescriptor,
      scan: KernelPageScan,
      purpose: SubmissionArmBinding['purpose'],
    ): boolean => {
      let mutationCurrent = false;
      try {
        mutationCurrent = activeMutationPolicy?.isCurrent() === true;
      } catch {
        mutationCurrent = false;
      }
      if (
        activeScan !== scan ||
        !isCurrentScanTarget(scan) ||
        !isRuntimeDeadlineCurrent(scan) ||
        !mutationCurrent
      ) {
        if (activeScan === scan && !mutationCurrent) retireActiveScan(true);
        return false;
      }
      const target = resolveFinalSubmissionTarget(scan.descriptor);
      if (!target) {
        tombstoneSubmissionGate();
        return false;
      }
      if (
        target.element.ownerDocument !== document ||
        target.form.ownerDocument !== document ||
        target.element.getRootNode() !== document ||
        target.form.getRootNode() !== document
      ) {
        tombstoneSubmissionGate();
        return false;
      }
      const submissionEpoch = activeScanEpoch;
      const submissionMutationPolicy = activeMutationPolicy;
      // 这一帧没装早装拦截（inertSubframe），拦不住宿主自己的提交：不武装，fail closed。
      if (earlySubmissionCapture === null) {
        tombstoneSubmissionGate();
        return false;
      }
      try {
        const previousGate = submissionGate;
        const gate = createSubmissionGestureGate({
          descriptor,
          target,
          sendMessage: (message) => browser.runtime.sendMessage(message),
          addSubmitListener: (listener) =>
            earlySubmissionCapture.addSubmitListener(target, listener),
          addActivationListener: (listener) =>
            earlySubmissionCapture.addActivationListener(target, listener),
          addReviewInvalidationListener: (listener) =>
            addExactReviewInvalidationListener(target.form, () => {
              // Writer-dispatched input/change events happen while the fill
              // controller is active and are reflected in the audit created
              // at the end of that fill. Any later edit makes that immutable
              // audit stale: retire the exact generation so it cannot be
              // reconfirmed without a fresh scan and a fresh audit.
              const fillIsActive = [...activeFillControllers.values()]
                .some((fillScan) => fillScan === scan);
              if (fillIsActive) return;
              if (activeScan === scan) {
                fillAttemptRevision += 1;
                retireActiveScan(true);
                return;
              }
              listener();
            }),
          hasActiveUserGesture: () => navigator.userActivation?.isActive === true,
          captureReviewValueSeal: () => captureExactFormValueSeal(target.form),
          isStillAuthorized: () => {
            let current = activeScan === scan &&
              activeScanEpoch === submissionEpoch &&
              activeMutationPolicy === submissionMutationPolicy &&
              submissionMutationPolicy !== null &&
              isCurrentScanTarget(scan) &&
              isRuntimeDeadlineCurrent(scan);
            if (current && submissionMutationPolicy !== null) {
              try {
                current = submissionMutationPolicy.isCurrent();
              } catch {
                current = false;
              }
            }
            if (!current && activeScan === scan) retireActiveScan(true);
            return current;
          },
        });
        submissionGate = gate;
        submissionArmBinding = Object.freeze({ descriptor, scan, purpose });
        previousGate?.dispose();
        return true;
      } catch {
        tombstoneSubmissionGate();
        return false;
      }
    };

    async function readStoredRuntimeBundle(): Promise<unknown> {
      return (await browser.storage.local.get(EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY))[
        EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY
      ];
    }

    async function resolveExecutionRuntime(authorization: RuntimeExecutionAuthorization) {
      try {
        const resolved = await resolveStoredExecutionRuntimeAuthority({
          stored: await readStoredRuntimeBundle(),
          authorization,
          nowMs: Date.now(),
          extensionVersion: browser.runtime.getManifest().version,
        });
        return resolved.ok ? resolved.value : null;
      } catch {
        return null;
      }
    }

    async function scanWithAuthorizedRuntime(
      authorization: RuntimeExecutionAuthorization,
      gate: RuntimeKernelScanGate,
    ) {
      try {
        if (authorization.purpose !== 'EXECUTION') return null;
        const runtime = await resolveExecutionRuntime(authorization);
        if (runtime === null) return null;
        return scanCurrentPageWithRuntimeAuthority(
          runtime,
          document,
          location,
          gate,
        );
      } catch {
        return null;
      }
    }

    // The locally verified bundle is part of every live execution grant. Any
    // replacement, narrowing, or deletion retires the exact scan generation
    // and aborts in-flight writes; a later request must resolve the new bundle.
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName !== 'local' ||
        !Object.prototype.hasOwnProperty.call(changes, EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY)
      ) return;
      scanAttemptRevision += 1;
      invalidateRetainedContentScanState();
      retireActiveScan(false);
    });

    window.addEventListener('pagehide', () => {
      scanAttemptRevision += 1;
      fillAttemptRevision += 1;
      invalidateRetainedContentScanState();
      retireActiveScan(false);
    });

    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      scanAttemptRevision += 1;
      fillAttemptRevision += 1;
      invalidateRetainedContentScanState();
      retireActiveScan(false);
    });

    /**
     * 插件更新（或重载、停用）之后，这一页上旧的内容脚本还在跑，但它和插件断了线（2026-10-03 体检 3e：孤儿页）：`runtime.id`
     * 读出来是 undefined，sendMessage、connect、storage 一调就当场抛「Extension context invalidated」——不是交回一个被拒的
     * promise，而是在点击处理器里直接抛出去，按钮一声不吭。Chrome 不给开着的页面重新注入，只能请他刷新这一页。
     * 每一处要找插件的入口先探一下；断了线就让浮层换成「ArgoLand.AI 已更新，刷新这一页即可继续」。
     */
    const runtimeAlive = (): boolean => {
      try {
        return typeof browser.runtime?.id === 'string';
      } catch {
        return false;
      }
    };
    const extensionUpdated = (): void => { dockHandle?.extensionUpdated(); };
    /** 发给 worker，永不当场抛：断了线时 sendMessage 当场就抛，这里一律交回 promise，由调用方的 catch 接住。 */
    const sendToWorker = async (message: unknown): Promise<unknown> => browser.runtime.sendMessage(message);
    /** 内容脚本这一侧的稳定原因码交给 worker 记进诊断环（只有闭集里的码，lib/dockDiagnostic.ts）。 */
    const reportDockDiagnostic = (code: DockPlainCode): void => {
      // 断了线就记不下；发送本身失败也不再起一个错——诊断通道坏了不该打断用户手上的事。
      if (runtimeAlive()) void sendToWorker(createDockDiagnostic(code)).catch(() => undefined);
    };
    /** 入口处接住的异常：消息里只带它闭集里的类名（2026-10-04 体检 11-2），message 与 stack 不出这一页。 */
    const reportDockError = (code: DockErrorCode, error: unknown): void => {
      if (runtimeAlive()) void sendToWorker(createDockErrorDiagnostic(code, error)).catch(() => undefined);
    };
    /**
     * The panel's own door to the saved profile. The checking lives here, where
     * the values are used; the worker holds the token and the routes, and hands
     * back unchecked text until this client opens it.
     */
    const directory = createProfileDirectoryClient({
      // 这一页没登记（报到表那一条被冲掉、站内换路径没赶上报到）就重新报到一次、再问一次（2026-09-27）。
      // `hello` 在下面才定义；这里只在用户打开资料时才调，那时早已定义好。
      run: createDirectoryRun({
        send: (message) => browser.runtime.sendMessage(message),
        rehello: () => { lastHelloAt = 0; return hello(); },
        // 存（写）的时候带上这一页认的那个人（2026-10-04）：worker 此刻登录的不是他就不写。`sessionNow` 在下面才定义；只在
        // 他存资料时才调，那时早已定义好。
        session: () => sessionNow,
      }),
      // 上一次读到的那一份（2026-10-04，先显示旧的、后台换新）：worker 只交回当前账号记在 storage.session 里的原文。
      cached: () => browser.runtime.sendMessage(DIRECTORY_CACHED_REQUEST),
    });
    // 悬浮窗由**背景下发**才挂，不在 main() 里自己挂：授权前内容脚本不碰
    // 宿主 document 的任何东西（submission-boundary-wiring 用空 document
    // 桩钉死了这条），而连接状态与 Mission 归属本来就只有背景知道。
    // 回复是不可信边界：认不出的面一律不挂，HIDDEN 永远不是"出现"的指令。
    // Where the launcher sat last time, as a share of the viewport. Read once
    // with the first hello; a drag writes it back so the next page finds it.
    let launcherTopRatio: number | undefined;
    // 能填的申请表上自动打开浮层（2026-09-24 负责人），但尊重用户：一次加载只开一次；这一页收起过、或这个站点
    // 30 分钟之内收起过，就保持收起。收起的记录按 origin 存在插件自己的 storage.local 里（lib/dockAutoOpen.ts）。
    // 用到时才建（浮层挂不出来的 Assistant 构建里它连同这一整段都是死代码，打包时整个删掉）。
    let dockAutoOpenPolicy: DockAutoOpen | null = null;
    const dockAutoOpen = (): DockAutoOpen => (dockAutoOpenPolicy ??= createDockAutoOpen());
    let dockCollapses: unknown;
    const rememberCollapse = (update: (stored: unknown, origin: string, now: number) => Record<string, number>): void => {
      // 断了线就记不下（storage 当场抛）：这一页已经记住了（dockAutoOpen().collapsed），只是下一页可能又自动打开一次。
      if (!runtimeAlive()) return;
      void browser.storage.local.get(DOCK_COLLAPSED_AT_KEY)
        .then((stored) => {
          const next = update((stored as Record<string, unknown>)[DOCK_COLLAPSED_AT_KEY], location.origin, Date.now());
          dockCollapses = next;
          return browser.storage.local.set({ [DOCK_COLLAPSED_AT_KEY]: next });
        })
        .catch(() => {
          // 存不下只是下一页可能又自动打开一次；这一页已经记住了（dockAutoOpen().collapsed）。
        });
    };
    // 最近的稳定原因码，只有码（P0-3）。浮层的结语与审计折叠区共用同一条取法。
    const recentDiagnostics = async (): Promise<readonly string[]> => {
      const response = await browser.runtime.sendMessage({ kind: 'diagnostics/recent' }).catch(() => null) as { codes?: unknown } | null;
      return Array.isArray(response?.codes) ? response.codes.filter((c): c is string => typeof c === 'string') : [];
    };
    // Open the real extension confirmation page from this trusted dock click.
    const signOut = (event: MouseEvent, shadowRoot: ShadowRoot): void => {
      if (captureTrustedShadowGesture(event, shadowRoot) === null) { dockHandle?.reportBlocked('GESTURE_UNTRUSTED'); return; }
      if (!runtimeAlive()) { extensionUpdated(); return; }
      const intent = withDocumentPath(parseDockVaultTransitionIntent({ kind: 'dock/vault-transition', version: 1,
        origin: location.origin, pathname: location.pathname, payload: { step: 'PREPARE_LOGOUT' } }), document);
      if (intent === null) return;
      void sendToWorker(intent).then((reply) => {
        if ((reply as { ok?: unknown } | null)?.ok !== true) dockHandle?.toast(dockCopy(dockLocale()).toast.signOutFailed);
      }).catch(() => { dockHandle?.toast(dockCopy(dockLocale()).toast.signOutFailed); });
    };
    const openPortal = (page: DockPortalPage): void => {
      if (!runtimeAlive()) { extensionUpdated(); return; }
      const intent = createDockPortalIntent(page);
      if (intent === null) return;
      void sendToWorker(intent)
        .then((reply) => {
          const ok = (reply as { ok?: unknown } | null)?.ok === true;
          const say = dockCopy(dockLocale()).toast;
          dockHandle?.toast(ok ? say.portalOpened : say.portalFailed);
        })
        .catch(() => { dockHandle?.toast(dockCopy(dockLocale()).toast.portalFailed); });
    };
    /** 国家码 → 本地化国家名（面板文案用）；环境不支持就退回码本身。 */
    const regionDisplayName = (code: string): string => {
      try {
        return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) ?? code;
      } catch {
        return code;
      }
    };
    /**
     * worker 没答上来：发信当场抛、或被拒（2026-10-03 体检 3e）。断了线（插件刚更新）时浮层已经换成「已更新」那张卡；
     * 还连着（worker 那一头没人接）就是「插件没有响应」（WORKER_UNREACHABLE）。从前一律当 null，说成「暂时连不上 ArgoLand」。
     * worker 到点（ASK_WORKER_DEADLINE_MS）都没答（2026-10-04）也是它：浮层说「插件没有响应」，不一直停在「正在对照你的资料」。
     * worker 自己的每一件事都有更短的时限（档案整份 15 秒），走到这里只会是它根本没答——被停掉了、消息丢了。
     */
    const WORKER_UNREACHABLE = Object.freeze({ kind: 'WORKER_UNREACHABLE' as const });
    const workerUnreachable = (): void => {
      if (runtimeAlive()) dockHandle?.reportBlocked('WORKER_UNREACHABLE');
      else extensionUpdated();
    };
    /** 问 worker 要一样东西；形状由调用方自己判。 */
    const askWorker = async (want: 'PROFILE' | 'DISCOVERY_AUTHORITY' | 'SIGN_ON_BEHALF') => {
      if (!runtimeAlive()) {
        extensionUpdated();
        return WORKER_UNREACHABLE;
      }
      // 单页应用改过地址时多带文档加载时的路径：worker 的发信人核对拿它比 sender.url（documentPath.ts）。
      // 不带的话，草稿建立后的 Workday 申请页上这里一条授权都要不到（2026-09-22 实测）。
      const intent = withDocumentPath(createDockApplyMaterialsIntent(location.origin, location.pathname, want, vendorHint()));
      if (intent === null) return null;
      try {
        const reply = await withDeadline(browser.runtime.sendMessage(intent) as Promise<unknown>, ASK_WORKER_DEADLINE_MS);
        return reply === DEADLINE_PASSED ? WORKER_UNREACHABLE : parseDockApplyMaterialsReply(reply);
      } catch {
        return WORKER_UNREACHABLE;
      }
    };
    /** 档案没拿到：浮层上说哪一种（2026-10-04：太慢、资料正在保存、插件没有响应各有各的话，不都说「读不到」）。 */
    const profileBlockedCode = (reply: Awaited<ReturnType<typeof askWorker>>): string => {
      if (reply?.kind === 'WORKER_UNREACHABLE') return 'WORKER_UNREACHABLE';
      if (reply?.kind !== 'REFUSED') return 'PROFILE_UNAVAILABLE';
      return reply.code === 'AUTH_REQUIRED' ? 'LOGIN_REQUIRED'
        : reply.code === 'TIMEOUT' ? 'PROFILE_TIMEOUT'
        : reply.code === 'BUSY' ? 'PROFILE_BUSY'
        : 'PROFILE_UNAVAILABLE';
    };
    /** 慢出来的失败（太慢、资料正在保存、worker 没响应）：已经等过一轮的不再等第二轮。 */
    const slowProfileFailure = (reply: Awaited<ReturnType<typeof askWorker>>): boolean =>
      reply?.kind === 'WORKER_UNREACHABLE' || (reply?.kind === 'REFUSED' && (reply.code === 'TIMEOUT' || reply.code === 'BUSY'));
    /**
     * 档案预取（2026-09-23 测速）：每一轮先要花 2–3 秒向 worker 要档案（四个接口，已经是并行的；
     * 慢在后端，实测单个接口 1–1.9 秒），那段时间浮层只写着「正在准备…」。手势路那张脸一挂上就先去取，
     * 打开面板时过期了再取一次，按下自动填写时多半已经到手。档案请求不带任何页面信息。
     *
     * 只在这一页的内存里、只留一分钟；在面板里改了资料（档案、自我认同、代填授权）、别的标签页里改了（worker 广播
     * `dock/profile-changed`）、或换了脸（退出登录之类）就作废。
     * 手动按的那一轮只吃一次预取：「重新填写这一页」重新取（他可能刚去改过资料）；
     * 翻到下一页接着填的那一轮沿用同一份。取回来的不是档案（没登录、网络抖动）就不算数，当场重取。
     * 代不代签从不跟着它走（2026-10-03 体检 P0-1）：每一轮按下去那一刻另问 worker 现读（`SIGN_ON_BEHALF`）。
     */
    const PROFILE_WARM_TTL_MS = 60_000;
    /**
     * 他第几次回到这一页（2026-10-04）。worker 看不到门户的写入（体检 3.1：开着的页面最多旧一分钟）；可在门户里改资料总得先离开
     * 这一页（切到别的标签页、窗口或程序），再回来按「自动填写」。每回来一次就加一：之前取的预取（包括他不在时取的，比如在后台
     * 标签页里打开、还没看过的这一页）一律不用，回来那一刻就在后台重取（见 cameBack）。
     */
    let presence = 0;
    /** 他此刻不在这一页（标签页藏着，或整个窗口没有焦点）。在后台标签页里打开的这一页，一开始就算不在。 */
    let away = document.visibilityState === 'hidden';
    type ProfileWarm = { at: number; presence: number; reply: ReturnType<typeof askWorker>; usedByClick: boolean; settled: boolean };
    let profileWarm: ProfileWarm | null = null;
    /** 起一次预取（还没答完时 `settled` 是 false）。 */
    const startProfileWarm = (usedByClick: boolean): ProfileWarm => {
      // 预取没人等：失败只能落成「没取到」，不能变成一条没人接的拒绝。
      const warm: ProfileWarm = { at: Date.now(), presence, reply: askWorker('PROFILE').catch(() => null), usedByClick, settled: false };
      void warm.reply.then(() => { warm.settled = true; });
      return warm;
    };
    const warmProfile = (): void => {
      // 他不在这一页（在后台标签页里打开、还没看过）：不白取——回来那一刻要重取，这一份用不上（2026-10-04）。
      if (away) return;
      if (profileWarm !== null && profileWarm.presence === presence && Date.now() - profileWarm.at < PROFILE_WARM_TTL_MS) return;
      profileWarm = startProfileWarm(false);
    };
    /** 按这个人（会话代号）重读一次档案：读回来的还不是他（读的时候又换了一次人）就是 null（2026-10-04）。 */
    const profileOf = async (session: string | null | undefined): ReturnType<typeof askWorker> => {
      // 换了人之后已经在取的那一份（丢掉上一个人的东西时起的）就是这个人的：接着等它，不再多取一次。
      const warm = profileWarm !== null && profileWarm.presence === presence ? profileWarm : (profileWarm = startProfileWarm(true));
      warm.usedByClick = true;
      const reply = await warm.reply;
      return reply?.kind === 'PROFILE' && reply.session !== session ? null : reply;
    };
    const takeProfile = async (mode?: 'AFTER_ADVANCE'): ReturnType<typeof askWorker> => {
      const warm = profileWarm;
      // 他上一次回到这一页之前取的那一份不用（他可能去门户改了资料，2026-10-04）：回来那一刻已经在重取了（见 cameBack）。
      if (warm !== null && warm.presence === presence && Date.now() - warm.at < PROFILE_WARM_TTL_MS && (mode === 'AFTER_ADVANCE' || !warm.usedByClick)) {
        if (mode !== 'AFTER_ADVANCE') warm.usedByClick = true;
        const pendingAtClick = !warm.settled;
        const reply = await warm.reply;
        if (reply?.kind === 'PROFILE') return reply;
        // 按下去时预取还在路上，等到的是慢出来的失败（太慢、资料正在保存、worker 没响应）：他已经等过这一轮了，照实说，
        // 不再从头等第二轮（2026-10-04）。别的失败（多半很快、或早就失败了）照旧当场重取。
        if (pendingAtClick && slowProfileFailure(reply)) return reply;
      }
      const fresh = startProfileWarm(mode !== 'AFTER_ADVANCE');
      profileWarm = fresh;
      return fresh.reply;
    };
    // 简历附件（P1-4）：与 askWorker 同一条边界——凭据与收件人都在 worker 那边，
    // 这里只说在哪一页、要问询还是要字节。
    const askResumeAttachment = async (step: ResumeAttachmentStep) => {
      const intent = withDocumentPath(createDockResumeAttachmentIntent(location.origin, location.pathname, step));
      if (intent === null) return null;
      try {
        return parseDockResumeAttachmentReply(await browser.runtime.sendMessage(intent));
      } catch {
        return null;
      }
    };
    // 求职信（2026-09-27）：同一条边界——凭据与收件人都在 worker 那边，这里只说在哪一页、要哪一步。
    const askCoverLetter: AskCoverLetter = async (request) => {
      const intent = withDocumentPath(createDockCoverLetterIntent(location.origin, location.pathname, request));
      if (intent === null) return null;
      try {
        return parseDockCoverLetterReply(await browser.runtime.sendMessage(intent));
      } catch {
        return null;
      }
    };
    /**
     * 简历问询也预取（2026-09-23 测速：档案预取之后，它那 0.7–1.3 秒成了开填前最长的一段）。
     * 问询只读：服务端判收件域名、报这一版叫什么多大，不取字节、不留痕——字节要等内核真走到
     * 简历栏才要（resumeSeam.ts）。页面上看得到文件框才预取；规则扫描认不认它，照旧由扫描说了算。
     * 与档案同一套：一分钟、手动按的那一轮只吃一次；翻到下一页的那一轮不沿用（地址可能已变）。
     */
    let resumeWarm: { at: number; presence: number; seam: ReturnType<typeof resumeSeamFromWorker>; usedByClick: boolean } | null = null;
    const warmResume = (): void => {
      if (away) return;
      if (resumeWarm !== null && resumeWarm.presence === presence && Date.now() - resumeWarm.at < PROFILE_WARM_TTL_MS) return;
      if (!pageOffersFileInput(document)) return;
      resumeWarm = { at: Date.now(), presence, seam: resumeSeamFromWorker(askResumeAttachment).catch(() => undefined), usedByClick: false };
    };
    const takeResume = async (mode?: 'AFTER_ADVANCE'): ReturnType<typeof resumeSeamFromWorker> => {
      const warm = resumeWarm;
      if (mode !== 'AFTER_ADVANCE' && warm !== null && warm.presence === presence && !warm.usedByClick && Date.now() - warm.at < PROFILE_WARM_TTL_MS) {
        warm.usedByClick = true;
        const seam = await warm.seam;
        if (seam !== undefined) return seam;
      }
      return resumeSeamFromWorker(askResumeAttachment);
    };
    // 答案记忆（P1-6）：与 askWorker 同一条边界——凭据在 worker，这里只说在哪一页。
    const askAnswerMemory = async (intent: ReturnType<typeof createDockAnswerMemoryIntent>): Promise<DockAnswerMemoryReply | null> => {
      if (intent === null) return null;
      try {
        return parseDockAnswerMemoryReply(await browser.runtime.sendMessage(intent));
      } catch {
        return null;
      }
    };
    const answerMemorySettings = async (): Promise<AnswerMemorySettings | null> => {
      const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'SETTINGS_GET')));
      return reply?.kind === 'ANSWER_MEMORY_SETTINGS' ? reply.settings : null;
    };
    const rememberedAnswers = async (): Promise<readonly RememberedAnswerV1[]> => {
      const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'LIST')));
      return reply?.kind === 'ANSWER_MEMORY_LIST' ? reply.answers : [];
    };
    /**
     * 在浮层里当场答上、值得记的那一题（2026-09-28 负责人：默认记下、不另问）：答案记忆的总开关开着才记（按用户，所有申请；
     * 没设过就算开着，他关过的照旧关着）。记不上不打扰他——worker 那一侧记下稳定码。
     *
     * 第一次记住（他还没看过这一版说明）：浮层里说一句「已记住，下次自动填 · 可在菜单里关」，并记下说过的那一版——只说一次，
     * 同一页里连着答几题也只说一次；存不下那一版，下次记住时再说。
     */
    let memoryNoticeShown = false;
    const rememberQuietly = async (question: QuestionDescription, value: string): Promise<void> => {
      const settings = await answerMemorySettings();
      if (settings?.enabled !== true) return;
      let saved = false;
      for (const request of await rememberRequestsFor(question, value)) {
        const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'PUT', request)));
        if (reply?.kind === 'ANSWER_MEMORY_PUT') saved = true;
      }
      if (!saved || !settings.autoReuse || memoryNoticeShown || settings.disclosureVersion === ANSWER_MEMORY_NOTICE_VERSION) return;
      memoryNoticeShown = true;
      dockHandle?.noteRemembered();
      await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'SETTINGS_SET', {
        enabled: true, autoReuse: true, disclosureVersion: ANSWER_MEMORY_NOTICE_VERSION,
      })));
    };
    /**
     * 「可以联系你现在的雇主吗」在浮层里答了（2026-09-28）：记进资料的 `preferences.contactCurrentEmployer`，走资料编辑器
     * 保存的同一条路（先读一份资料拿到版本，再只改这一项）。存成了，预取的那一份作废，下一轮按资料自动答。
     * 服务端还不认这一项时（argoland 的那一刀没上线）存不上，浮层照实说「下次还会问你」。
     */
    const saveEmployerContact = async (answer: 'YES' | 'NO'): Promise<boolean> => {
      const read = await directory.profileV2().catch(() => null);
      if (read === null || !read.ok) return false;
      const patch: PatchCandidateProfileV2 = {
        schemaVersion: 2,
        expectedRevision: read.value.revision,
        expectedDeletionEpoch: read.value.deletionEpoch,
        fields: { 'preferences.contactCurrentEmployer': answer === 'YES' },
      };
      const saved = await directory.saveProfileV2(patch).catch(() => null);
      profileWarm = null;
      return saved !== null && saved.ok;
    };
    /**
     * 浮层账户菜单里「记住我的回答」那个开关（2026-09-28）：开＝记住他在浮层里答的、下次自动带出（两个本地开关一起开）；
     * 关＝都不。他亲手拨过，就算看过这一版说明。
     */
    const memorySwitch = {
      load: async (): Promise<boolean | null> => {
        const settings = await answerMemorySettings();
        return settings === null ? null : settings.enabled && settings.autoReuse;
      },
      save: async (on: boolean): Promise<boolean | null> => {
        const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'SETTINGS_SET', {
          enabled: on, autoReuse: on, disclosureVersion: ANSWER_MEMORY_NOTICE_VERSION,
        })));
        return reply?.kind === 'ANSWER_MEMORY_SETTINGS' ? reply.settings.enabled && reply.settings.autoReuse : null;
      },
    };
    /**
     * AI 代答（2026-09-23）与「用 AI 写 / AI 改写」（2026-09-24）：与答案记忆同一条边界——凭据、requestId 与配额
     * 都在 worker，这里只说在哪一页、问哪几道题（不透明题号、题面、选项，没有选择器与现值）。worker 睡着了、
     * 答非所问、或者等太久，都当「这次没有」：规则那一遍从不等它。
     */
    const AI_REPLY_BUDGET_MS = 95_000;
    const askAi = async (payload: DockAiAnswersPayload): Promise<DockAiAnswersReply | null> => {
      const intent = withDocumentPath(createDockAiAnswersIntent(location.origin, location.pathname, payload));
      if (intent === null) return null;
      try {
        const reply = await Promise.race([
          browser.runtime.sendMessage(intent) as Promise<unknown>,
          new Promise<null>((resolve) => { setTimeout(() => resolve(null), AI_REPLY_BUDGET_MS); }),
        ]);
        return parseDockAiAnswersReply(reply);
      } catch {
        return null;
      }
    };
    /** 送给服务端的页面标题（契约：可打印字符、最多 240 字）。 */
    const pageTitle = (): string => document.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    /** AI 代答的开关（缺省开）。关掉之后，还没写的 AI 答案也不再写。 */
    let aiSwitchOn: boolean | null = null;
    const aiSwitch = {
      load: async (): Promise<boolean | null> => {
        const reply = await askAi({ step: 'SETTINGS_GET' });
        if (reply?.kind !== 'AI_ANSWERS_SETTINGS') return null;
        aiSwitchOn = reply.enabled;
        return reply.enabled;
      },
      save: async (enabled: boolean): Promise<boolean | null> => {
        const reply = await askAi({ step: 'SETTINGS_SET', enabled });
        if (reply?.kind !== 'AI_ANSWERS_SETTINGS') return null;
        aiSwitchOn = reply.enabled;
        // 关掉之后，这一轮还开着的那条流也关掉（之后到的本来就不写，也不必再让服务端跑下去）。
        if (!reply.enabled) gestureAi?.cancel();
        return reply.enabled;
      },
    };
    /** 只报码与个数（worker 记进诊断）；报不上就算了。 */
    const reportAi = (outcome: 'APPLIED' | 'OFFERED' | 'OFFER_APPLIED', count: number): void => {
      void askAi({ step: 'REPORT', outcome, count: Math.min(Math.max(0, count), FULL_AI_LIMITS.fields) });
    };
    /**
     * 一次「自动填写」的规划（2026-09-24）：连上 worker 的那条长连接、发一条 PLAN（题与岗位），答案一批一批按到达的
     * 先后交给 `sink`，最后一条是结束或拒绝。交回「不要了」：断开连接（worker 随之中止请求，服务端停下还在跑的调用）。
     * 连接断了、超时了、一条消息不合格：不再读，已经写上的留着，还没拿到结果的题当没答上。
     */
    const openAiStream = (fields: readonly FullAiField[], job: FullAiJob | undefined, sink: AiAnswersSink): (() => void) => {
      const receiver = createAiStreamReceiver(fields, sink);
      const intent = withDocumentPath(createDockAiAnswersIntent(location.origin, location.pathname, {
        step: 'PLAN',
        title: pageTitle(),
        fields,
        ...(job === undefined ? {} : { job }),
      }));
      if (intent === null) {
        receiver.cut();
        return () => {};
      }
      let port: ReturnType<typeof browser.runtime.connect>;
      try {
        port = browser.runtime.connect({ name: AI_ANSWERS_STREAM_PORT });
      } catch {
        receiver.cut();
        return () => {};
      }
      const disconnect = (): void => {
        try {
          port.disconnect();
        } catch {
          // 那一头已经断了。
        }
      };
      const timer = setTimeout(() => { receiver.cut(); disconnect(); }, AI_REPLY_BUDGET_MS);
      port.onMessage.addListener((raw: unknown) => {
        receiver.message(raw);
        if (receiver.finished()) {
          clearTimeout(timer);
          disconnect();
        }
      });
      port.onDisconnect.addListener(() => { clearTimeout(timer); receiver.cut(); });
      try {
        port.postMessage(intent);
      } catch {
        clearTimeout(timer);
        receiver.cut();
      }
      return () => {
        clearTimeout(timer);
        receiver.close();
        disconnect();
      };
    };

    /**
     * 按「继续到下一页」之前重读一次写策略。与下面 runGestureFill 同一条路：worker 给这一页的
     * DISCOVERY 授权、本机从已存的运行时包解出策略。读不到就是 null，不按
     * （RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）——不拿 arm 那一刻的快照，用户可能几分钟后才按。
     */
    const resolveGesturePolicy = async (): Promise<ApplyPolicy | null> => {
      const authReply = await askWorker('DISCOVERY_AUTHORITY');
      if (authReply?.kind !== 'DISCOVERY_AUTHORITY') return null;
      const authorization = parseRuntimeExecutionAuthorization(authReply.authorization);
      if (authorization === null || authorization.purpose !== 'DISCOVERY') return null;
      try {
        const resolved = await resolveStoredDiscoveryRuntimeAuthority({
          stored: await readStoredRuntimeBundle(),
          authorization,
          nowMs: Date.now(),
          extensionVersion: browser.runtime.getManifest().version,
        });
        return resolved.ok ? resolved.value.fillPolicy : null;
      } catch {
        return null;
      }
    };
    /**
     * 多页申请的「继续到下一页」（2026-09-22）。一轮手势填写跑完就 arm 这一页：浮层问能按哪颗、
     * 用户按了之后按宿主那颗并等它翻页、用户自己在网站上翻了页——三件事都由它判
     * （wizardAdvanceController.ts）。按的永远只是翻页那一颗，不是最终提交。
     */
    const wizardAdvance = createWizardAdvanceController({
      document,
      isVisible: isRenderedControl,
      resolvePolicy: resolveGesturePolicy,
    });
    /**
     * 在插件里提交（2026-09-23 负责人决定）：用户在浮层里按「提交」，信封合上的那一刻替他按规则声明的
     * 那一颗最终提交。远程开关 `submit-application` 关着、规则没声明、身份对不上，都不按。
     */
    /**
     * 网站此刻在不在要邮件里的验证码（2026-10-04）：浮层那张脸上建的那一套（lib/verificationCodePage.ts）把读法挂到这里。
     * 只是一个挂钩——外层活代码不直接引用那一套（Assistant 构建里浮层挂不出来，那一套随 showFace 一起删掉）。
     */
    const submitCodeHook: { read: () => SubmitCodeMark | null } = { read: () => null };
    const submitter = createSubmitController({
      document,
      isVisible: isRenderedControl,
      resolvePolicy: resolveGesturePolicy,
      codePrompt: () => submitCodeHook.read(),
      // 这两条送不到 worker（体检「吞掉的错」第 3 条）：整页跳走后下一页不说「提交成功」、任务不报「已提交」——记一个码。
      onPressing: () => { void sendToWorker(DOCK_SUBMIT_PRESSED).catch(() => reportDockDiagnostic('SUBMIT_PRESSED_UNSENT')); },
      onSettled: () => { void sendToWorker(DOCK_SUBMIT_SETTLED).catch(() => reportDockDiagnostic('SUBMIT_SETTLED_UNSENT')); },
    });
    /**
     * 浮层任务接线（2026-09-24）：这一页绑着用户在门户「开始申请」的任务（READY 那张脸）时，
     * 一轮填写在 worker 里另记一条任务运行、按表单要求取任务的求职信、网站确认提交后替他报「已提交」。
     * 填写本身照旧是手势路，不等它太久、也不因它失败而停。
     */
    const missionSession = createDockMissionSession({
      send: (message) => browser.runtime.sendMessage(message),
      page: () => ({ origin: location.origin, pathname: location.pathname }),
      wrap: withDocumentPath,
    });
    /**
     * 同站点的职位详情页只取一次（2026-09-24）：面板打开时首页岗位卡要它（申请页自己没有 JobPosting 时），
     * 按下「自动填写」时工作授权推国家也要它——两处共用这一次同源取数（时限、读取上限与从前相同）。
     */
    // 用到时才建：浮层挂不出来的 Assistant 构建里，手势填写与岗位卡都是死代码，读取器随之整个删掉。
    let nearbyPostingReader: NearbyPostingReader | null = null;
    const nearbyPosting = (): NearbyPostingReader => (nearbyPostingReader ??= createNearbyPostingReader());
    /** 手势填写的轮次：新一轮开始、或这一页因翻页作废时加一。迟到的复查据此停下。 */
    let gestureRunSerial = 0;
    /**
     * 每一轮自动填写怎么收场（2026-10-04，体检 11-1，lib/runOutcomeTap.ts）：浮层挂上时包一层，收场的那几下原样转给浮层、
     * 同时记下这一轮的结局，收场时交给 worker 一条闭集消息（厂商、结局、闭集原因、分桶的字段数与时长、连填第几页、浮层「提交」
     * 的结局；没有网址、题目或值）。用到时才建：只有手势路上用得到，浮层挂不出来的 Assistant 构建里它是死代码。所以外层活代码里
     * 一处都不读 `runOutcomes`（见 fillToReviewNow 的头注）。
     */
    let runOutcomes: RunOutcomeTap | null = null;
    const runTap = (): RunOutcomeTap => {
      if (runOutcomes !== null) return runOutcomes;
      const tap = createRunOutcomeTap({
        send: (message) => { if (runtimeAlive()) void sendToWorker(message).catch(() => undefined); },
        // 与扫描同一个判据（pageLane）：主机表答得出就是那一家；答不出看指纹（白标）；都没有是通用路。
        page: () => {
          const host = detectApplyVendor(location.hostname);
          if (host !== null) return { vendor: runVendor(host), lane: 'host' };
          const hint = vendorHint();
          return hint === null ? { vendor: 'generic', lane: 'generic' } : { vendor: runVendor(hint), lane: 'whitelabel' };
        },
        hasValue: hostFieldHasValue,
        onError: (error) => reportDockError('RUN_OUTCOME_THREW', error),
      });
      // 这一页要走了（整页跳走、关标签页、进往返缓存）：还开着的那一轮交终稿。
      window.addEventListener('pagehide', () => { tap.pageHidden(); });
      runOutcomes = tap;
      return tap;
    };
    /** 这一轮手势填写的「停止」：浮层进度卡上那颗按钮（2026-09-23 设计）。 */
    let gestureStop: AbortController | null = null;
    /** 这一轮 AI 代答的那条流（2026-09-24）：新的一轮开始时关掉上一条。 */
    let gestureAi: { cancel: () => void } | null = null;
    /** 关掉此刻那条 AI 代答的流（这一轮半路抛了）。 */
    const closeGestureAi = (): void => {
      gestureAi?.cancel();
      gestureAi = null;
    };
    /**
     * 按一下「自动填写」，一页一页填到检查页（2026-09-28 负责人决定，lib/fillToReview.ts）：那一下点击开一轮有边界的连填
     * （内核 openAdvanceRun：同一页面、同一张申请、同一家，总时限与页数上限），每页填完、AI 与求职信都有了结局，没有要他
     * 处理的就替他按网站的下一步、接着填下一页；到检查页（或规则声明的最终提交所在的那一页）停下等他按「提交」。
     *
     * 用到时才建：它引用 runGestureFill。浮层挂不出来的 Assistant 构建里，整条手势填写链是死代码、被整个删掉。
     * 所以收场只写在同样是死代码的地方：浮层被拆（`onDismissed`：换脸、让给助手、让给顶层帧）、它自己挂的 pagehide、
     * 手势填写里的几处。外层活代码里一处都不能读 `fillToReviewNow`——打包器会把对它的每一次赋值连同所在的函数一起留下，
     * 从这里一路把整条手势填写链拉回 apply.js（2026-09-28 实测 +68 KB）。runGestureFill 也不回头叫这个取用函数（连填由
     * 调用方交进去）：两者互相引用，打包器就删不掉这一对。
     */
    let fillToReviewNow: FillToReview | null = null;
    /** 连填翻过去之后这一页上没有我们认得的表时：页面上还有没有一颗「下一步」（有就不是检查页）。 */
    const nextControlWithoutForm = (): 'ONE' | 'NONE' | 'AMBIGUOUS' => {
      const found = findWizardNextControl({ document, formElements: [], isVisible: isRenderedControl });
      return found.ok ? 'ONE' : found.code === 'NEXT_STEP_NONE' ? 'NONE' : 'AMBIGUOUS';
    };
    const fillToReview = (): FillToReview => {
      if (fillToReviewNow !== null) return fillToReviewNow;
      const driver = createFillToReview({
        resolvePolicy: resolveGesturePolicy,
        advance: (step) => wizardAdvance.advanceInRun(step),
        checkpoint: () => detectHumanCheckpoint({ document, isVisible: isRenderedControl }),
        fillNextPage: (page) => { void runGestureFill(page, driver, 'AFTER_ADVANCE'); },
        dock: () => dockHandle,
      });
      // 这个标签页要离开这一页了（整页跳走、进往返缓存）：一轮连填到此为止。
      window.addEventListener('pagehide', () => { driver.end(); });
      fillToReviewNow = driver;
      return driver;
    };

    /**
     * 无 mission 的填写：用他自己的档案填这一页。
     *
     * 信任根是**用户刚按下的这一次点击**——`isTrusted` 加「事件来自我方 shadow」，
     * 页面 JS 两者都伪造不了。它授权的是「把我的资料填进我正在看的这张表」，
     * 不代表用户对任何岗位做任何对外的事，所以不需要 mission、不签 intent、
     * 不归档回执。
     *
     * 三样东西都从 worker 要（凭据自始至终不进内容脚本）：
     *   DISCOVERY_AUTHORITY  这一页的只读运行时授权 —— 识别仍只来自后端下发的规则
     *   PROFILE              用户自己的扁平档案
     * 扫描与写入在本地，用那张只读授权，厂商闸与能力位一条没放松。
     */
    /**
     * 拒绝一律走 `reportBlocked`，不走 `finishRun`。
     *
     * `finishRun` 第一行是 `if (!sheetAllowed || !sheetExists) return;`——没有运行
     * 面板时它**什么都不做**。而这条路上的早期拒绝（要不到授权、要不到档案、
     * 解不出运行时、扫不出表单、手势没过校验）全都发生在任何面板出现之前，
     * 于是用户按下 Autofill，浮层一声不吭——那正是「点了没反应」。
     *
     * `reportBlocked` 是为这件事准备的：没有面板它自己claim 一个，再把理由画上去。
     * 2026-09-18 批测里抓到的形状：legacy `boards.greenhouse.io` 那一批全是
     * 「浮层还停在主界面」，25 个控件一个没填，而浮层从头到尾没说过一句话。
     */
    /**
     * `AFTER_ADVANCE`：用户按了「继续到下一页」、或连填替他按了网站的下一步（2026-09-28），我们刚翻过去，这一轮填的是
     * 新的那一页。新一页还在渲染，所以扫描要等它出来（scanWhenReady）；等不到就照实说，不报成错误。
     *
     * `root`：那一下点击的凭证；连填翻到的那几页是那一轮发给这一页的凭证（不是点击，见 lib/fillToReview.ts）。
     * `chainDriver`：连填（调用方交进来，不在这里回头取：见 fillToReview 的头注）。
     */
    const runGestureFill = async (root: GestureRoot, chainDriver: FillToReview, mode?: 'AFTER_ADVANCE'): Promise<void> => {
      // 新的一轮：上一轮 arm 的那一页、它的复查，都不再归它管。
      wizardAdvance.disarm();
      submitter.disarm();
      const serial = ++gestureRunSerial;
      // 连填翻到的这一页（不是一次真实点击）：这一轮的结局接着上一页那一轮记（runTap().begin）。
      const continuesChain = chainDriver.pageOf(root) !== null;
      // 一次真实点击（自动填写、继续到下一页、再试一次、重新填写这一页）：上一轮连填到此为止。连填翻到的这一页接着那一轮。
      if (chainDriver.pageOf(root) === null) chainDriver.end();
      gestureStop?.abort();
      gestureAi?.cancel();
      gestureAi = null;
      const stopper = new AbortController();
      gestureStop = stopper;
      // 新的一轮开始：上一轮若还开着就此交出它的结局（被顶掉、或连填翻过来的那一页），这一轮从这一刻计时。
      runTap().begin({ continuesChain, signal: stopper.signal, superseded: () => serial !== gestureRunSerial });
      try {
        await fillGesturePage(root, chainDriver, serial, stopper, mode);
      } catch (error) {
        // 这一轮半路抛了（内核或页面上的一个 TypeError，2026-10-03 体检 3a-2）：从前进度卡和「停止」永远挂着，只能刷新页面，
        // 后台也看不到。记一个稳定码（带闭集里的类名，2026-10-04）交给 worker；还是这一轮就照「这一轮没有完成」（RUN_FAILED）
        // 收尾，连填到此为止。已经被新的一轮取代：浮层与连填都是新那一轮的，一样不碰。
        reportDockError('GESTURE_RUN_THREW', error);
        if (serial !== gestureRunSerial) return;
        if (gestureStop === stopper) gestureStop = null;
        closeGestureAi();
        chainDriver.end();
        dockHandle?.reportBlocked('RUN_FAILED');
      }
    };
    /**
     * 一页的手势填写（runGestureFill 开好这一轮之后）：`serial` 与 `stopper` 是这一轮的轮次与「停止」。
     *
     * 新的一轮开始、或他按了「停止」，这一轮就不再归它管（2026-10-03 体检 3a-1）：开写之前每一个 await 之后先问 `live()`，
     * 不再碰浮层（报拒绝、报到了哪一步）、不开连填（会把新一轮开的那一轮结束掉）、不在 worker 里记任务运行。开写之后按了
     * 「停止」照「已停止」收尾；被新的一轮取代就一个字都不碰。
     */
    const fillGesturePage = async (
      root: GestureRoot,
      chainDriver: FillToReview,
      serial: number,
      stopper: AbortController,
      mode?: 'AFTER_ADVANCE',
    ): Promise<void> => {
      const live = (): boolean => serial === gestureRunSerial && !stopper.signal.aborted;
      // 档案与授权、扫描同时进行（2026-09-23）：从前三步排队，档案那 2–3 秒一分都省不下。
      const profilePending = takeProfile(mode);
      // 代不代签（2026-10-03 体检 P0-1，AGENTS.md「撤回即失效」）：按下去这一刻请 worker 现读 argoland 的同意记录，不拿预取的
      // 档案答复——那一份留一分钟，门户上、别的标签页里刚撤回的它不知道。与档案同时出发，不多等。
      const signingPending = askWorker('SIGN_ON_BEHALF');
      // 三处早期拒绝从前都报同一个 RUN_UNAVAILABLE（「填写服务暂不可用」），2026-09-21 生产实测两家
      // 页面都停在这一句，却分不清是 worker 没给授权、还是本机解析不了规则包——现在各报各的。
      const authReply = await askWorker('DISCOVERY_AUTHORITY');
      if (!live()) return;
      if (authReply?.kind !== 'DISCOVERY_AUTHORITY') {
        if (authReply?.kind === 'WORKER_UNREACHABLE') workerUnreachable();
        // 这一家没放行（2026-10-04）：照实说「这类网站还没开放自动填写」，不说「暂时连不上 ArgoLand」。
        else dockHandle?.reportBlocked(authReply?.kind === 'REFUSED' && authReply.code === 'VENDOR_CLOSED' ? 'VENDOR_CLOSED' : 'AUTHORITY_UNAVAILABLE');
        return;
      }
      const authorization = parseRuntimeExecutionAuthorization(authReply.authorization);
      if (authorization === null || authorization.purpose !== 'DISCOVERY') {
        dockHandle?.reportBlocked('AUTHORITY_UNAVAILABLE');
        return;
      }
      // 按下去这一刻登录的是谁（worker 现答，2026-10-04）：换了人（广播没到也算），上一个人的预取一样不留——简历问询下面重问。
      if (authReply.session !== undefined && observeSession(authReply.session)) afterSessionChange();
      const runtime = await (async () => {
        try {
          const resolved = await resolveStoredDiscoveryRuntimeAuthority({
            stored: await readStoredRuntimeBundle(),
            authorization,
            nowMs: Date.now(),
            extensionVersion: browser.runtime.getManifest().version,
          });
          return resolved.ok ? resolved.value : null;
        } catch {
          return null;
        }
      })();
      if (!live()) return;
      if (runtime === null) {
        dockHandle?.reportBlocked('RUNTIME_UNRESOLVED');
        return;
      }
      dockHandle?.setStep('SCANNING');
      // 与其它扫描同一个穿透口子：Ashby 那类把整张表放在 shadow root 里的
      // 厂商，不给它就一个字段都看不见。
      //
      // 封不住就再试几次。封存那一道是承重的——它保证我们写进去的就是我们看过的
      // 那一代 DOM，不能放松。但**一次抖动不该是终局**：真实的申请页在 React 水合
      // 期间会反复重排（Discord 那张 Greenhouse 表实测就是，控制台里一串
      // "React recovered from an error during hydration"），而用户按下 Autofill
      // 的那一刻恰好落在抖动里的概率并不低。2026-09-18 实测：第一次必停在
      // NOT_SEALABLE，浮层报「这一页还在变」，用户看到的是按了没反应。
      //
      // 重试不放松任何一道闸：每一次仍然要求一代**完整封得住**的 DOM，
      // 封不住就继续等，等够了还封不住才如实报出来。
      //
      // ⚠️ 实测下来这几次重试**救不了 Discord 那张 Greenhouse 表**，原因在更深一层：
      // `sealScanRootMutationPolicy` 对同一个 root 是「一次判脏、永久判脏」——
      // 元数据里存着 sealedPolicy，之后每次调用都只问 `isExecutionCurrent()`，
      // 而 `dirty` 一旦置起来就再也不会放下。于是页面在第一次封存之后动过一下，
      // 这一页在**本次加载的余生里**都扫不出表单，只能靠刷新恢复。
      // 真正的修复是 kernel 侧要有一条「重新封存」的路：上一代过期就取一份新的基线，
      // 而不是永久拒绝——「写进你看过的那一代」这个保证，新基线同样满足。那一刀还没落。
      const scanOnce = () => scanCurrentPageWithDiscoveryAuthority(runtime, document, location, {
        isTopFrame,
        // 子帧持表时（P2-10）嵌入路径才算申请页；顶层帧上照旧不算。
        embedded: !isTopFrame,
        // 白标 B（P2-11）：主机不在厂商表里时路径不看本家的，容器要过 whitelabelRoot 那道闸。
        // 连指纹都答不出时走通用路（2026-09-22）：闸换成 genericRoot 数字段。
        ...pageLane(),
        openShadowRoot: openVerifiedHostShadowRoot,
      });
      let outcome = mode === 'AFTER_ADVANCE'
        ? await scanWhenReady({ scanOnce, budgetMs: NEXT_PAGE_SCAN_BUDGET_MS })
        : await scanOnce();
      for (let attempt = 0; attempt < 4 && live() && outcome.stop?.startsWith('NOT_SEALABLE') === true; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        outcome = await scanOnce();
      }
      if (!live()) return;
      // 申请表还没打开（2026-10-04，负责人 D8）：规则声明的那一颗「打开申请表」（BambooHR 的「Apply for This Job」），翻页那一位
      // 开着时先替他点开——它只把表单展开、网址不变，不提交任何东西——等表单出来，接着走下面同一条路（lib/applyGateOpen.ts）。
      if (outcome.scan === null && mode !== 'AFTER_ADVANCE' && outcome.stop === 'APPLY_FORM_NOT_OPENED') {
        const opened = await openApplyFormFirst({
          allowed: () => advanceAllowed(runtime.fillPolicy, runtime.mapping.vendor),
          control: () => readRuntimeApplyGate(runtime.mapping, document),
          isVisible: isRenderedControl,
          waitForForm: () => scanWhenReady({ scanOnce, budgetMs: NEXT_PAGE_SCAN_BUDGET_MS, alsoNotReady: APPLY_GATE_NOT_READY }),
          signal: stopper.signal,
        });
        if (!live()) return;
        if (opened !== null) outcome = opened;
      }
      // 数据同意页（2026-10-04，负责人 D7）：代填授权成立（运行时包放行 sign-on-behalf ∧ 他同意着当前版本）时，替他在规则声明的
      // 居住地下拉里选他资料里的居住国那一项（lib/consentGatePass.ts，写入走内核的专用票）。网站选完就整页跳到申请表的，新一页
      // 的浮层照实说一句（worker 记一声）；网站把条款摆出来、要人点「Accept」的，那一下交还本人——插件不按任何提交控件。
      // 两把钥匙里「他同意着当前版本」按这一轮按下去那一刻现读的那一份（`signingPending`，2026-10-03 体检 P0-1：撤回即失效；档案
      // 答复里不再带同意）。居住地按此刻登录的这个人的资料：预取的那一份不是他的，就按他重读（2026-10-04，换了账号绝不用上一个人的）。
      if (outcome.scan === null && mode !== 'AFTER_ADVANCE' && outcome.stop === 'CONSENT_GATE') {
        // 两样都在按下去那一刻就出发了：先后等，花的时间与一起等相同。
        const consentRead = await profilePending;
        const signingNow = await signingPending;
        const consentProfile = consentRead?.kind === 'PROFILE' && consentRead.session !== authReply.session
          ? await profileOf(authReply.session)
          : consentRead;
        if (!live()) return;
        const profileFacts = consentProfile?.kind === 'PROFILE' ? consentProfile : null;
        const signedNow = signingNow?.kind === 'SIGN_ON_BEHALF' && signingNow.granted;
        const residence = (profileFacts?.profile as { addressCountry?: unknown } | undefined)?.addressCountry;
        let leaving = false;
        const onLeave = (): void => { leaving = true; };
        window.addEventListener('pagehide', onLeave);
        window.addEventListener('beforeunload', onLeave);
        try {
          const passed = await passConsentGate({
            allowed: () => runtime.fillPolicy.capabilities['sign-on-behalf'] === true && signedNow,
            read: () => readRuntimeConsentGate(runtime.mapping, document),
            residence: typeof residence === 'string' ? residence : null,
            choose: (reading, index) => chooseConsentGateResidence({ reading, index, proof: root, policy: runtime.fillPolicy }).ok,
            leaving: () => leaving,
            isVisible: isRenderedControl,
            onChosen: () => {
              dockHandle?.toast(dockCopy(dockLocale()).consentGate.choosing);
              void sendToWorker(DOCK_CONSENT_GATE_CHOSEN).catch(() => {});
            },
            signal: stopper.signal,
          });
          // 网站整页跳走了：这一页的浮层随之消失，新一页照实说。
          if (passed === 'NAVIGATING') return;
          // 选上了、网站却没有自己跳走：收回报给 worker 的那一声（他之后自己点同意跳过去，新一页不说「已替你过了」）。
          if (passed === 'ACCEPT_BY_USER' || passed === 'STILL_HERE') {
            void sendToWorker(DOCK_CONSENT_GATE_SETTLED).catch(() => {});
          }
          // 被新的一轮取代、或他按了「停止」：不再碰浮层（同上面每一个 await 之后）。
          if (!live()) return;
          if (passed === 'ACCEPT_BY_USER') {
            dockHandle?.reportBlocked('CONSENT_GATE_ACCEPT');
            return;
          }
        } finally {
          window.removeEventListener('pagehide', onLeave);
          window.removeEventListener('beforeunload', onLeave);
        }
      }
      if (outcome.scan === null) {
        // 翻过去之后新一页上等不到表：多半是最后的 Review 页，或这一步只有说明文字。那不是错误——
        // 回主界面照实说。页面一直在变（封不住）的，请用户稍后自己点 Autofill。
        if (mode === 'AFTER_ADVANCE') {
          const retired = outcome.stop?.startsWith('NOT_SEALABLE') === true ? 'ADVANCED' : 'ADVANCED_EMPTY';
          // 连填（2026-09-28）翻到的这一页上没有表：检查页（到头了）、只能本人处理的关卡、一页我们认不出要填的（后面还有），
          // 或者页面换了地方——照实说那一件事，这一轮到此为止。不是连填翻到的页照旧。
          const ended = retired === 'ADVANCED_EMPTY'
            ? chainDriver.noForm(root, { origin: location.origin, pathname: location.pathname, next: nextControlWithoutForm() })
            : null;
          if (ended === null && retired === 'ADVANCED') chainDriver.end();
          if (ended !== null && ended.stop !== 'REVIEW') {
            if (ended.stop === 'MOVED') dockHandle?.retireRun('PAGE_CHANGED');
            else dockHandle?.reportBlocked(`CHAIN_${ended.stop}`);
            return;
          }
          if (ended !== null) dockHandle?.setChain(chainDockState(ended.page, 'REVIEW'));
          dockHandle?.retireRun(retired);
          return;
        }
        // 扫描器已经算出了它为什么停，别再把三种不同的原因压成一句
        // 「这一页没有表单」——那句话对其中两种是错的。
        const code = outcome.stop ?? outcome.refusal ?? 'NO_FORM_FOUND';
        // 按下去那一刻才发现申请表嵌在一个 iframe 里（嵌入帧晚到，2026-10-04）：那一帧有自己的浮层。照实说去那里填，不说「这一轮没有完成」。
        if (code === 'YIELDED_TO_FRAME') {
          dockHandle?.reportBlocked('IN_EMBEDDED_FRAME');
          return;
        }
        // 白标 C（P2-12）：没有表单、但页面上有厂商自己的「申请表在哪」（预载的 boards-api + ?gh_jid=）
        // → 停止态多一颗「打开申请表」。内容脚本只交两个闭集 token，URL 由 worker 按固定模板拼；只导航，不写。
        const target = NO_FORM_STOPS.has(code) ? applicationFormTargetOnPage() : null;
        dockHandle?.reportBlocked(code, target === null ? undefined : {
          kind: 'OPEN_APPLICATION_FORM',
          onClick: () => {
            const intent = createDockOpenApplicationFormIntent(target);
            if (intent === null) return;
            // 没打开（发信被拒、worker 开不了标签页）：从前一声不吭（体检「吞掉的错」第 4 条）。照实说一句，记一个码。
            void sendToWorker(intent).then((reply) => (reply as { ok?: unknown } | null)?.ok === true).catch(() => false).then((opened) => {
              if (opened) return;
              reportDockDiagnostic('OPEN_APPLICATION_FORM_FAILED');
              dockHandle?.toast(dockCopy(dockLocale()).toast.openFormFailed);
            });
          },
        });
        return;
      }
      const scanned = outcome.scan;
      // 连填（2026-09-28）：一次真实点击，开关开着、这一页是向导的一步（有唯一一颗翻页按钮）→ 开一轮，这一页用那一轮
      // 发的「这一页」凭证写；连填翻到的这一页 → 接着那一轮（还得是同一个页面、同一张申请、同一家）。别的照旧用点击凭证。
      const chain = chainDriver.begin({
        root,
        scope: { origin: location.origin, pathname: location.pathname, vendor: scanned.descriptor.vendor },
        vendor: scanned.descriptor.vendor,
        policy: runtime.fillPolicy,
        next: () => nextControlState({ document, descriptor: scanned.descriptor, isVisible: isRenderedControl }),
        site: () => readWizardProgress({ document, isVisible: isRenderedControl }),
      });
      if (chain.kind === 'REFUSED') {
        // 连填翻到的这一页不能用那一轮的凭证写（换了地方、那一轮已经到点）：一个字不写，回到可以点「自动填写」的样子。
        // 他按了「停止」的，浮层已经收好了。
        if (chain.stop !== 'STOPPED') {
          // 浮层只说「翻过去了」；这一轮的结局记下连填为什么停（到点、换了地方）。
          runTap().note(chain.stop);
          dockHandle?.retireRun('ADVANCED');
        }
        return;
      }
      const proof: GestureRoot = chain.proof;
      dockHandle?.setChain(chain.kind === 'CHAIN' ? chainDockState(chain.page, null) : null);
      // 简历附件（P1-4）：这一页扫出了文件栏才去问。`targetVerified` 只在后端 plan
      // 答了 200 之后为真；被拒就没有接缝，简历栏如实记 NO_VALUE，其余字段照常。
      // 字节要等内核真走到那一栏才过桥（见 resumeSeam.ts）。
      dockHandle?.setStep('PLANNING');
      // 档案（多半已预取到手）、简历问询、答案记忆设置三样互不相干，一起等。
      // 答案记忆（P1-6）：用户在面板上打开了「自动带出我记住的答案」，本页认不出键的题
      // 就先拿他记住的答案来填；没打开就只在面板里预填、等他确认。
      // 岗位地点（P1-7 的数据源）：申请页自己没有 JobPosting 时去同站点的详情页读（见 jobCardFromPage.ts），
      // 与上面三样一起等，有 1.5 秒上限，读不出就是空串。送给 AI 代答的岗位（`job`，2026-09-24）读的是同一份
      // JobPosting、同一次取数。
      // 绑着任务的页（READY）：这一轮在 worker 里记一条任务运行（开始申请即批准 → 签发 → claim），
      // 表单要求求职信就一并取来。记不上不挡填写：最多等 MISSION_RUN_WAIT_MS，迟到的记录填完照样交回执。
      const missionBound = dockHandle?.face() === 'READY';
      const missionTicket = missionBound
        ? missionSession.begin({ fieldKeys: outcome.scan.fieldKeys, vendor: outcome.vendor })
        : null;
      // 求职信（2026-09-27 负责人：申请表上有求职信栏——必填、可选都算——就附上为这个岗位写的一封）。表上认出的求职信栏
      // 决定要正文（文字框）还是 PDF（上传栏）；岗位库里的岗位用核实过的职位描述写，不在库里的用这一页读到的（JobPosting，
      // 或看得见的正文）。原来就有的那一封几秒内就回来，当场交给这一轮；还在写的，先填别的，写好了再附（见下面）。
      // 「AI 代答」关着就不要：信也是 AI 写的。
      const letterTargets = aiSwitchOn === false ? [] : coverLetterTargets(outcome.scan.descriptor);
      const letterElements = letterTargets.map((target) => target.element);
      const letterPending: Promise<CoverLetterOutcome> | null = letterTargets.length === 0 ? null : (async () => {
        const job = await nearbyPosting().job(document, location.href).catch(() => undefined);
        const pageJob = coverLetterPageJob({ doc: document, ...(job === undefined ? {} : { job }), card: readJobCardFromPage(document) }) ?? undefined;
        return coverLetterFromWorker(
          askCoverLetter,
          { text: letterTargets.some((target) => target.kind === 'text'), file: letterTargets.some((target) => target.kind === 'file') },
          pageJob,
        );
      })();
      const [profileRead, resume, memory, postingLocation, aiJob, , letterEarly, signing] = await Promise.all([
        profilePending,
        outcome.scan.descriptor.fields.some((field) => field.kind === 'file')
          ? takeResume(mode)
          : Promise.resolve(undefined),
        answerMemorySettings(),
        nearbyPosting().location(document, location.href),
        nearbyPosting().job(document, location.href),
        missionTicket === null ? Promise.resolve(null) : withinBudget(missionTicket, MISSION_RUN_WAIT_MS),
        letterPending === null ? Promise.resolve(null) : withinBudget(letterPending, COVER_LETTER_WAIT_MS),
        signingPending,
      ]);
      if (!live()) return;
      if (letterPending !== null) {
        dockHandle?.setCoverLetter(letterEarly === null
          ? { kind: 'WRITING', targets: letterElements }
          : letterEarly.kind === 'REFUSED' ? { kind: 'REFUSED', code: shownLetterRefusal(letterEarly.code), targets: letterElements } : { kind: 'IDLE' });
      }
      // 预取的档案是替谁读的（2026-10-04）：不是按下去这一刻登录的那个人，就按这个人重读一次（只在换了人时才多等这一下），
      // 上一个人的值一个都不交给填写。
      const profileReply = profileRead?.kind === 'PROFILE' && profileRead.session !== authReply.session
        ? await profileOf(authReply.session)
        : profileRead;
      // 重读也是开写之前的一个 await：那一段里按了「停止」或另起了一轮，这一轮就不再碰浮层（同上面每一个 await 之后）。
      if (!live()) return;
      if (profileReply?.kind !== 'PROFILE') {
        if (profileReply?.kind === 'WORKER_UNREACHABLE') workerUnreachable();
        else dockHandle?.reportBlocked(profileBlockedCode(profileReply));
        return;
      }
      const autoReuse = memory?.enabled === true && memory.autoReuse === true;
      // 工作授权推国家（P1-7）：题目不点名国家时按申请卡片的岗位地点答。只在地点能确定性解出
      // 恰好一个国家时才交：Remote / EMEA、说不清是州还是国家的「Remote - IN」都不交（2026-09-24，见 dict/regions.ts）。
      const jobCard = readJobCardFromPage(document);
      const jobRegionCode = inferRegionCode(jobCard.location) ?? inferRegionCode(postingLocation);
      // 搬迁题没写搬去哪儿时说的就是岗位地点（2026-09-24）：页面自己的 JobPosting 优先，其次同站点详情页读到的。
      const jobLocation = jobCard.location !== '' ? jobCard.location : postingLocation;
      // 写什么由后端下发的那一份说了算——手势只证明「用户要填」。
      // 取不到写策略就根本不走到写这一步（fail closed），不退回包内默认值。
      const audits: KernelFillAudit[] = [];
      // 这一轮的单子从开填那一刻起就在浮层上逐栏亮（2026-09-23）：先整张摆出来（分母齐、一栏未亮），
      // 每结算一栏刷新一次。收尾时用同一个 runId 换成终局那一份。
      const runId = `gesture-${Date.now()}`;
      // 页面上还空着、浮层没认出的必填，与网站此刻标着的错（2026-10-04，bench-1003：Jobvite 上浮层只数自己认得的行，说「这一页
      // 填好了」，连填接着替他按了「Next」，网站当场把没认出的四道必填标红）。每次画终局单子、连填问往不往下翻时现读一遍——
      // 他可能刚在网站上补上了，网站也可能刚冒出一道「如果是，请说明」。读法在内核（只认公开的说法，不认任何一家的 DOM）。
      // 「浮层已经在管」的只算单子里当必填列着的那几栏。不进单子的（判成蜜罐的 Jobvite 单选、同一道题问了两遍落选的那一道），
      // 与单子里当选填列着、网站却标了必填的（Ashby 的 CSS 星号，扫描没读到），都交给页面侧清点：题目摆在页面上、还空着，就照实列出来。
      // 认出的那几栏按这一轮最后一次扫描算（加行之后重扫过，新加的几行只在那一次里）。
      const pageGapsFor = (view: AuditView | null): PageGaps => {
        const unshown = new Set(audits[0]?.unshown ?? []);
        const optional = new Set((view?.rows ?? []).filter((row) => !row.required).map((row) => row.element));
        const scannedFields = audits[0]?.scanFields?.() ?? scanned.descriptor.fields;
        const fields = unshown.size === 0 && optional.size === 0
          ? scannedFields
          : scannedFields.filter((field) => !unshown.has(field.element) && !optional.has(field.element));
        const questionText = scanned.descriptor.questionText;
        return readPageGaps({
          form: { root: scanned.descriptor.root, fields, ...(questionText === undefined ? {} : { questionText }) },
          isVisible: isRenderedControl,
        });
      };
      const settledProgress = (view: AuditView) => withPageGaps(dockProgressFromAudit(runId, view, dockLocale()), pageGapsFor(view), dockCopy(dockLocale()).unnamedRequired);
      let streamed = false;
      const showWhileFilling = (view: AuditView, live?: KernelFillLive): void => {
        if (serial !== gestureRunSerial) return;
        const filling = dockProgressWhileFilling(runId, view, live, dockLocale());
        if (streamed) dockHandle?.update(filling);
        else {
          streamed = true;
          dockHandle?.beginRun(filling);
          dockHandle?.setStep('FILLING');
        }
      };
      // 准备期间就按了停止：这一轮不再开始写。
      if (stopper.signal.aborted || serial !== gestureRunSerial) return;
      // AI 代答（2026-09-23 负责人决定）：规则答不了、页面上还空着的题，内核在第一遍开写的同时交给这个口子去问；
      // 答案按他自己确认过的资料起草，写进去之后在网页上标出来。这一轮作废（新的一轮、翻页、撤销、关了开关）就不写。
      // 2026-09-24：一次点击一条流（`plan/stream`），带上岗位；选择题先到先写，开放题随后。
      const aiRun = { cancelled: false };
      const aiSession = createAiAnswersSession({
        gesture: proof,
        port: { request: (fields, sink) => openAiStream(fields, aiJob, sink) },
        // 从点击起算的几个时刻（请求发出、响应头、第一批选择题、第一批开放题、每次写入、晚到、结束）：worker 记成一条诊断码。
        onTiming: (marks) => { void askAi({ step: 'TIMING', marks }); },
      });
      gestureAi = aiSession;
      /** 这一轮作废（撤销、浮层收掉了这一轮、没走完、没有单子）：那条流关掉，之后到的不写、也不再画。 */
      const cancelAi = (): void => {
        aiRun.cancelled = true;
        aiSession.cancel();
      };
      // 用户按了「停止」（填写途中、或 AI 在起草时，#107）：那条流一并关掉——服务端停下还在跑的调用，之后到的一个字
      // 不写。这一轮仍算数（不是作废）：closeGestureRun 照「已停止」收尾，按下那一刻已经写上网页的照实画上去。
      stopper.signal.addEventListener('abort', () => { aiSession.cancel(); }, { once: true });
      const result = await fillFromGesture({
        signal: stopper.signal,
        onPlanned: aiSession.onPlanned,
        laterWritesCurrent: () => serial === gestureRunSerial && !aiRun.cancelled && aiSwitchOn !== false,
        onProgress: showWhileFilling,
        proof,
        scan: outcome.scan,
        policy: runtime.fillPolicy,
        profile: profileReply.profile as never,
        // 结构化档案（P1-8a）：worker 交来了教育 / 经历就按行填进页面上已有的行；没交来就只填扁平字段。
        ...(profileReply.collections === undefined ? {} : { collections: profileReply.collections }),
        // 工作授权记录（2026-09-21）：题目点名国家、用户在那国有确认过的记录才预填，且一律等他点头。
        ...(profileReply.workAuthorizations === undefined ? {} : { workAuthorizations: profileReply.workAuthorizations }),
        ...(jobRegionCode === null ? {} : { jobRegionCode }),
        ...(jobLocation === '' ? {} : { jobLocation }),
        // 推荐人（P1-9）：用户亲手存的推荐人 + 申请卡片的公司名；只在恰好一条推荐到这家时预填姓名、等点头。
        ...(profileReply.referrals === undefined ? {} : { referrals: profileReply.referrals }),
        ...(jobCard.company === '' ? {} : { jobCompany: jobCard.company }),
        // 代填条款、声明与签名（2026-09-23）：worker 在按下去那一刻现读到用户同意着当前版本才带（2026-09-28 起不认旧版本；
        // 2026-10-03 起不从预取的档案里拿，读不到当没同意）；签名日期取用户本地的当天。能力位是否放行，内核按生效策略自己再判。
        ...(signing?.kind === 'SIGN_ON_BEHALF' && signing.granted ? { signOnBehalf: true, signingDate: localIsoDate(new Date()) } : {}),
        // 资料里对「可以联系你现在的雇主吗？」的回答（2026-09-28）：那一类题照它答；没答就不带（交还本人）。
        ...(profileReply.employerContact === undefined ? {} : { employerContact: profileReply.employerContact }),
        // 资料里的出差上限（2026-10-04，argoland #738）：出差题照它答；没答就不带（交还本人）。
        ...(profileReply.travelPercentMax === undefined ? {} : { travelPercentMax: profileReply.travelPercentMax }),
        // 「是否拉美裔」那一问用户亲口的回答（2026-09-23）：不是扁平档案键，单独带。
        ...(profileReply.hispanicLatino === undefined ? {} : { hispanicLatino: profileReply.hispanicLatino }),
        // 「是否跨性别」与性取向（2026-09-23）同理；「是否 LGBTQ+」由内核从这两句推出。
        ...(profileReply.transgenderStatus === undefined ? {} : { transgenderStatus: profileReply.transgenderStatus }),
        ...(profileReply.sexualOrientation === undefined ? {} : { sexualOrientation: profileReply.sexualOrientation }),
        // 用户本地的当天（2026-10-04）：内核按资料推「工作年限」「你现在在读吗」要用（内核不碰时钟）。
        today: localIsoDate(new Date()),
        // 加行（P1-8b）：档案段数多于页面行数时按厂商声明的控件加行，加完用同一份只读授权重扫这一页。
        rowAdds: { rescan: async () => (await scanOnce()).scan },
        ...(resume === undefined ? {} : { resume }),
        ...(letterEarly?.kind === 'MATERIAL' ? { coverLetter: letterEarly.material } : {}),
        ...(autoReuse
          ? {
              reuseRememberedAnswers: true,
              resolveRememberedAnswers: async (questions: readonly { questionId: string; question: never }[]) => {
                const matches = await matchRememberedAnswers(questions.map((entry) => entry.question), await rememberedAnswers());
                return matches.map(({ questionId, value }) => ({ questionId, value }));
              },
            }
          : {}),
        progress: { onOutcome: () => {}, shouldStop: () => false } as never,
        onAudit: (value: KernelFillAudit) => audits.push(value),
      } as never);
      // 任务运行（若记上了，哪怕迟到）以这一轮的逐项结果收口；worker 只报 claim 过的那几个键。
      if (missionTicket !== null) {
        const outcomes = result.ok ? result.outcomes : [];
        void missionTicket.then((ticket) => { if (ticket !== null) missionSession.finish(ticket, outcomes); });
      }
      // 写的时候被新的一轮取代了（它按下了这一轮的「停止」）：浮层、连填、这一页的提交与翻页都归新那一轮，这里一个字都不碰。
      if (serial !== gestureRunSerial) {
        cancelAi();
        return;
      }
      if (!result.ok) {
        if (gestureStop === stopper) gestureStop = null;
        // 这一轮没走完：AI 答案也不再要（那条流关掉，免得服务端为一轮不会写的答案计次）；连填也不再往下翻。
        cancelAi();
        if (chain.kind === 'CHAIN') chainDriver.end();
        dockHandle?.reportBlocked(result.code);
        return;
      }
      // 这一页扫过、填过了：arm「继续到下一页」，并开始盯着用户是不是自己在网站上翻了页。
      // 必须在浮层画收尾那一幕**之前**：那一幕画的时候就要问「能按哪一颗」。
      // 一项都没填上也 arm——这一页可能本来就没有我们能填的，用户答完照样要翻页。
      if (serial === gestureRunSerial) {
        // 这一页的最终提交也归这一轮：浮层里的「提交」按的是规则声明的那一颗。
        submitter.arm({ descriptor: outcome.scan.descriptor, policy: runtime.fillPolicy });
        wizardAdvance.arm({
          descriptor: outcome.scan.descriptor,
          policy: runtime.fillPolicy,
          onLeft: () => {
            gestureRunSerial += 1;
            // 他自己在网站上翻了页：一轮连填（若有）到此为止——那一页不是我们翻过去的，不拿那一轮的凭证写。
            chainDriver.end();
            dockHandle?.retireRun('PAGE_CHANGED');
          },
        });
      }
      // 「跑完了」不等于「填上了」。逐项结果在手里，就按逐项结果说话：
      // 一项都没落地时报的是**那一条真实的拒绝理由**，不是一句「填写需要核对」。
      // 2026-09-17 实测过反例：浮层画出终局那一幕，页面上 44 个控件一个值都没有。
      const filled = result.outcomes.filter((item) => item.ok).length;
      const audit = audits[0];
      const stillThisRun = (): boolean => serial === gestureRunSerial && !aiRun.cancelled;
      // 这一页此刻的单子（AI 写上、求职信附上、复查改判之后的那一份）：连填据此判「这一页还有没有必填要他处理」。
      let pageView: AuditView | null = audit?.view ?? null;
      // 求职信这一轮开填时还在写：写好了趁那一下点击还在 30 秒之内当场附上；过了就摆一颗「附上求职信」，
      // 那一下点击是新的凭证。只写求职信那几栏、空的才写（kernelFiller 的 attachCoverLetter）。
      // 信还在写，这一轮就还没完（2026-09-28 负责人）：`letterSettled` 交给下面的 closeGestureRun，附上了、要再点一下、
      // 附不了都算有了结局（交回写上了几栏），进度卡在那之前一直写着「正在为这个岗位写求职信…」。
      const letterSettled: Promise<number> | undefined = letterPending !== null && letterEarly === null
        ? letterPending.then(async (letter): Promise<number> => {
          if (serial !== gestureRunSerial) return 0;
          // 按过「停止」：不再附，也不说没写出来。
          if (stopper.signal.aborted) {
            dockHandle?.setCoverLetter({ kind: 'IDLE' });
            return 0;
          }
          if (letter.kind === 'REFUSED') {
            dockHandle?.setCoverLetter({ kind: 'REFUSED', code: shownLetterRefusal(letter.code), targets: letterElements });
            return 0;
          }
          const attach = audit?.attachCoverLetter;
          if (attach === undefined) {
            dockHandle?.setCoverLetter({ kind: 'REFUSED', code: 'UNAVAILABLE', targets: letterElements });
            return 0;
          }
          const showLetterView = (view: AuditView): void => {
            if (serial !== gestureRunSerial) return;
            pageView = view;
            dockHandle?.update(settledProgress(view));
          };
          const first = await attach(proof, letter.material);
          if (serial !== gestureRunSerial) return 0;
          if (first.ok && first.written > 0) {
            showLetterView(first.view);
            dockHandle?.setCoverLetter({ kind: 'ATTACHED' });
            return first.written;
          }
          if (!first.ok && first.code === 'GESTURE_EXPIRED') {
            dockHandle?.setCoverLetter({
              kind: 'READY',
              targets: letterElements,
              apply: (event, shadowRoot) => {
                // 这一下点击就是写入的凭证：派发当中同步取证，之后才能 await。
                const fresh = captureTrustedShadowGesture(event, shadowRoot);
                if (fresh === null || serial !== gestureRunSerial) return Promise.resolve(false);
                return attach(fresh, letter.material).then((written) => {
                  if (!written.ok || written.written === 0) return false;
                  showLetterView(written.view);
                  return true;
                });
              },
            });
            return 0;
          }
          // 这期间用户自己填了那一栏（NOT_EMPTY）：不碰，也不再提。按过「停止」不说没写出来。别的失败照实说没附上。
          dockHandle?.setCoverLetter(!first.ok && first.code !== 'NOT_EMPTY' && !stopper.signal.aborted
            ? { kind: 'REFUSED', code: 'UNAVAILABLE', targets: letterElements }
            : { kind: 'IDLE' });
          return 0;
        }, (): number => 0)
        : undefined;
      // 没有单子就没有地方接 AI 答案（按过「停止」的那条流已经随停止关掉了）：那条流关掉。
      if (audit === undefined) cancelAi();
      // AI 代答还在起草，这一轮就还没完（2026-09-24 负责人：「ai 如果在启用的话，就代表正在填写，那个黑色的进度框应该
      // 还显示着」）。先告诉浮层，再把规则那几遍的终局单子交给它：它只换进度条，进度卡留着、写明 AI 在填，送出去的那几栏
      // 不列进「需要你」，等下面 closeGestureRun 在流结束（AI 有了结局）之后才收尾。已经按了「停止」的这一轮不再问 AI
      // 要答案（写入那一侧也已挡住）。流上每到一批答案就交给 drawAiProgress（在下面、单子交给浮层之后才接上）。
      let drawAiProgress: ((progress: KernelAiProgress) => void) | undefined;
      const ai = audit === undefined || stopper.signal.aborted
        ? undefined
        : aiSession.attach(audit, (progress) => { drawAiProgress?.(progress); });
      if (ai !== undefined) {
        dockHandle?.setAiAnswers({ kind: 'DRAFTING', count: ai.asked, targets: ai.targets });
        dockHandle?.setStep('AI_DRAFTING');
      } else if (letterPending !== null && letterEarly === null && !stopper.signal.aborted) {
        // 没送题给 AI、只有求职信还在写：进度卡同样留着，写明在写信（浮层的 aiDraftingLine 按状态换那一句）。
        dockHandle?.setStep('AI_DRAFTING');
      }
      let drawAiOutcome: ((outcome: KernelAiAnswersOutcome) => void) | undefined;
      if (audit) {
        const progress = settledProgress(audit.view);
        dockHandle?.beginRun(progress);
        dockHandle?.update(progress);
        // 没有 dock 能收这份单子时退回独立面板——与 mission 那条路同一个退路。
        const present = dockHandle?.showAudit === undefined
          ? showAuditPanel
          : dockHandle.showAudit.bind(dockHandle);
        // 还没填上的题进面板的「补答」区（P1-6）：候选只在本地与用户记住的答案比对，
        // 题干不上行；他确认并勾了「记住」的答案才以 PUT 存到他的账号。
        const questionHandlers = audit.questions.length === 0 ? undefined : {
          questions: audit.questions,
          // 计划期替他选好、只等点头的答案（自我认同 / 工作授权）：面板预选，不用打开记忆也摆出来。
          prefills: audit.prefills,
          // 按岗位地点推断的题：面板在提示里写明是按哪个国家推的，用户点头前看得见。
          prefillNotes: new Map([...audit.prefillBasis].map(([questionId, basis]) => [questionId, [
            ...(basis.inferredRegionCode === undefined ? [] : [`按岗位地点（${regionDisplayName(basis.inferredRegionCode)}）推断`]),
            ...(basis.referralCompany === undefined ? [] : [`来自你保存的推荐人（${basis.referralCompany}）`]),
          ].join('；')])),
          loadSettings: async () => {
            const settings = await answerMemorySettings();
            return settings === null ? null : { schemaVersion: 1 as const, enabled: settings.enabled, autoReuse: settings.autoReuse, disclosureVersion: QUESTION_DISCLOSURE_VERSION, revision: '0' as never };
          },
          updateSettings: async (update: { enabled: boolean; autoReuse: boolean }) => {
            const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'SETTINGS_SET', {
              enabled: update.enabled, autoReuse: update.autoReuse, disclosureVersion: ANSWER_MEMORY_NOTICE_VERSION,
            })));
            return reply?.kind === 'ANSWER_MEMORY_SETTINGS'
              ? { schemaVersion: 1 as const, enabled: reply.settings.enabled, autoReuse: reply.settings.autoReuse, disclosureVersion: QUESTION_DISCLOSURE_VERSION, revision: '0' as never }
              : null;
          },
          fetchCandidates: async (questions: typeof audit.questions) => ({
            ok: true as const,
            context: null,
            candidates: memoryCandidates(questions, await matchRememberedAnswers(questions, await rememberedAnswers())),
          }),
          answer: (event: Event, shadowRoot: ShadowRoot, answers: readonly { questionId: string; value: string }[]) =>
            audit.answer(event, shadowRoot, answers),
          remember: async ({ question, value, scope }: { question: typeof audit.questions[number]; value: string; scope: string }) => {
            if (scope !== 'USER') return false;
            const requests = await rememberRequestsFor(question, value);
            if (requests.length === 0) return false;
            let saved = false;
            for (const request of requests) {
              const reply = await askAnswerMemory(withDocumentPath(createDockAnswerMemoryIntent(location.origin, location.pathname, 'PUT', request)));
              if (reply?.kind === 'ANSWER_MEMORY_PUT') saved = true;
            }
            return saved;
          },
          // AI 起草开放题（P3-13）：用户点了面板上的「让 AI 起草」才发；题目与岗位卡片上行，档案在服务端读。
          // 草稿摆成可编辑的一行，与其它候选一样要他点「回填」才写。
          fetchDrafts: async (questions: typeof audit.questions) => {
            const card = readJobCardFromPage(document);
            const field = (value: string): string | null => (value.trim() === '' ? null : value.trim().slice(0, 200));
            const intent = withDocumentPath(createDockQuestionDraftIntent(
              location.origin,
              location.pathname,
              { company: field(card.company), title: field(card.title), location: field(card.location) },
              questions.map((question) => ({ questionId: question.questionId, text: question.text.slice(0, 2000), maxLength: null })),
            ));
            if (intent === null) return null;
            let reply: ReturnType<typeof parseDockQuestionDraftReply>;
            try {
              reply = parseDockQuestionDraftReply(await browser.runtime.sendMessage(intent));
            } catch {
              return null;
            }
            if (reply === null) return null;
            return reply.kind === 'QUESTION_DRAFTS'
              ? { ok: true as const, drafts: new Map(reply.drafts.map((draft) => [draft.questionId, draft.text])) }
              : { ok: false as const, code: reply.code };
          },
          disclosure: '候选来自你记住的答案，只在本地比对，题目不会上传；勾选「记住」时才把这道题的答案保存到你的 ArgoLand 账号。开放题可以让 AI 起草——点那颗按钮时题目与岗位会发送到 EdAIX。',
          scopeChoices: ['', 'USER'] as const,
        };
        // 「需要你」在浮层里当场答（2026-09-28）：选一个、填一句，那一下点击走补答那条路（点击当下铸票、这一轮的信封、同一本
        // 撤销日志）；写上了换单子，值得记的默默记下。
        const answers = createDockAnswers({
          audit,
          current: () => stillThisRun() && !stopper.signal.aborted,
          onAnswered: (view) => {
            pageView = view;
            dockHandle?.update(settledProgress(view));
            panel.update(view);
          },
          remember: rememberQuietly,
          // 「可以联系你现在的雇主吗」资料里还没答：在浮层里答一次就记进资料，以后按资料自动答（2026-09-28）。
          ...(profileReply.employerContact === undefined ? { employerContact: { save: saveEmployerContact } } : {}),
        });
        const panel = present(audit.view, {
          canUndo: audit.canUndo,
          undoAll: (undoEvent: Event, undoShadow: ShadowRoot) => {
            // 撤销了这一轮：还没回来的 AI 答案也不再写（那条流一并关掉）。
            cancelAi();
            void audit.undoAll(undoEvent, undoShadow);
          },
          // 浮层把这一轮收掉了（「回到主页」、新的一轮、翻页）：网页上写好的留着，还没回来的 AI 答案不再写——
          // 浮层上已经没有这一轮，写进去的东西用户就看不到是谁写的。
          onDismiss: cancelAi,
          ...(questionHandlers === undefined ? {} : { questions: questionHandlers }),
          ...(answers === undefined ? {} : { answers }),
        } as never);
        // 整轮之后再问几次「我们填的还在不在」，与 mission 那条路同一份排程（lateRecheck.ts）。
        // 这条路从前没接：CAP-AF-055 的复查只接在 mission 路上，而真实用户走的是这一条——
        // Lever 那种结算后十二秒的宿主回写，在这里照样会让一行永远停在「已填」。
        // 这一页翻走了、或用户开了新的一轮，就停下。
        // 宿主在整轮之后把我们填好的栏清空了（Lever 附上简历约三秒后清掉 Current location，2026-09-24）：
        // 复核一看到，就用同一张点击凭证按资料重填一次（只一次，只填被清空、用户没动过的栏；见 kernelFiller）。
        let lateRepairAsked = false;
        const repairIfEmptied = (view: AuditView): void => {
          if (lateRepairAsked || audit.repairReverted === undefined || serial !== gestureRunSerial) return;
          if (!view.rows.some((row) => row.key !== null && row.reason === 'LATE_REVERTED')) return;
          lateRepairAsked = true;
          void audit.repairReverted(proof).then((repaired) => {
            // 重填没成（体检「吞掉的错」第 5 条）：那一栏照旧标着「网站后来改掉了这一项」，记一个码。
            if (!repaired.ok) reportDockDiagnostic('LATE_REPAIR_FAILED');
            if (!repaired.ok || serial !== gestureRunSerial) return;
            pageView = repaired.view;
            dockHandle?.update(settledProgress(repaired.view));
            panel.update(repaired.view);
          }, () => reportDockDiagnostic('LATE_REPAIR_FAILED'));
        };
        repairIfEmptied(audit.view);
        startLateRecheck({
          current: audit.view,
          recheck: audit.recheck,
          apply: (view) => {
            if (serial === gestureRunSerial) pageView = view;
            dockHandle?.update(settledProgress(view));
            panel.update(view);
            repairIfEmptied(view);
          },
          stopped: () => gestureRunSerial !== serial,
        });
        if (ai !== undefined) {
          // 答案一批一批到（选择题先、开放题随后，2026-09-24 起一次点击一条流）：30 秒之内到的趁同一张凭证写上，每写一批
          // 就把单子换成写上之后的那一份；进度卡上的题数随之减少，还在起草的那几栏照旧不列进「需要你」（drawAiProgress）。
          // 流结束（closeGestureRun 在这一轮还算数时叫到 drawAiOutcome，画完它才收尾）：晚到的摆一颗「填入 AI 答案」；
          // 次数用完说一句；别的失败不打扰用户（规则填的已经在那儿了）。然后才在长文本题旁边摆「用 AI 写」。
          // 按过「停止」则只为已经写上的那几项再叫一次。
          let stopAiRecheck: (() => void) | null = null;
          const showAiView = (view: AuditView): void => {
            if (serial !== gestureRunSerial) return;
            pageView = view;
            dockHandle?.update(settledProgress(view));
            panel.update(view);
            stopAiRecheck?.();
            stopAiRecheck = startLateRecheck({
              current: view,
              recheck: audit.recheck,
              apply: (next) => {
                if (serial === gestureRunSerial) pageView = next;
                dockHandle?.update(settledProgress(next));
                panel.update(next);
              },
              stopped: () => gestureRunSerial !== serial,
            });
          };
          let shownWritten = 0;
          drawAiProgress = (progress) => {
            if (!stillThisRun() || stopper.signal.aborted) return;
            // 还在起草的那几栏先交给浮层，再换单子：换单子时浮层按它们分「正在写」与「需要你」。题都有了着落、只差流上
            // 最后那一行时是 0：进度卡照旧写 AI 在填（不写数），直到流结束收尾。
            dockHandle?.setAiAnswers({ kind: 'DRAFTING', count: progress.pending, targets: progress.drafting });
            dockHandle?.setAiNoEvidence(progress.noEvidence);
            if (progress.view !== null && progress.written > shownWritten) {
              shownWritten = progress.written;
              showAiView(progress.view);
            }
          };
          drawAiOutcome = (outcome) => {
            // AI 看过却在资料里没找到依据的、这一轮没拿到答案的那几栏：原因照实说，不再说「我们没认出这道题」。
            if (outcome.kind !== 'REFUSED') {
              dockHandle?.setAiNoEvidence(outcome.noEvidence);
              dockHandle?.setAiUnanswered(outcome.unanswered);
            }
            if (outcome.kind === 'APPLIED') {
              if (outcome.written > shownWritten) showAiView(outcome.view);
              dockHandle?.setAiAnswers({ kind: 'APPLIED', count: outcome.written });
              reportAi('APPLIED', outcome.written);
            } else if (outcome.kind === 'READY') {
              if (outcome.written > 0) reportAi('APPLIED', outcome.written);
              reportAi('OFFERED', outcome.count);
              dockHandle?.setAiAnswers({
                kind: 'READY',
                count: outcome.count,
                apply: (event, shadowRoot) => {
                  // 这一下点击就是写入的凭证：派发当中同步取证，之后才能 await。
                  const proof = captureTrustedShadowGesture(event, shadowRoot);
                  if (proof === null || !stillThisRun()) return Promise.resolve(0);
                  return outcome.apply(proof).then((written) => {
                    if (!written.ok || !stillThisRun()) return 0;
                    showAiView(written.view);
                    reportAi('OFFER_APPLIED', written.written);
                    return written.written;
                  });
                },
              });
            } else {
              dockHandle?.setAiAnswers(outcome.kind === 'REFUSED' && (outcome.code === 'PAYWALL_REQUIRED' || outcome.code === 'QUOTA_EXCEEDED')
                ? { kind: 'USED_UP' } : { kind: 'IDLE' });
            }
            // 开关关着（worker 说的）：网页上也不摆「用 AI 写」。按过「停止」也不摆（这一轮之后的写入已被同一个停止挡住；
            // 停下之后还会叫到这里，是为了把按下那一刻已经写上网页的 AI 答案照实画上去）。
            if (stopper.signal.aborted || ai.revisable.length === 0 || (outcome.kind === 'REFUSED' && outcome.code === 'SWITCHED_OFF')) return;
            // 「用 AI 写 / AI 改写」（2026-09-24）：用户在卡片里按「生成」——这一下是写入的凭证（同步取证），
            // 问 worker 要一段文字，再经内核写进这一栏；写之前他已经关了卡片、或自己改了那一栏，就不写。
            const generate = (target: Element, instruction: string, event: MouseEvent, shadowRoot: ShadowRoot, wanted: () => boolean): Promise<DockAiGenerateOutcome> => {
              const proof = captureTrustedShadowGesture(event, shadowRoot);
              if (proof === null) return Promise.resolve({ kind: 'FAILED', reason: 'UNTRUSTED' });
              const item = ai.revisable.find((one) => one.element === target);
              if (item === undefined || !stillThisRun()) return Promise.resolve({ kind: 'FAILED', reason: 'PAGE_CHANGED' });
              const current = (target as HTMLTextAreaElement).value ?? '';
              if (current.length > FULL_AI_LIMITS.value) return Promise.resolve({ kind: 'FAILED', reason: 'TOO_LONG' });
              const write = async (value: string, withProof: TrustedGestureProof): Promise<DockAiGenerateOutcome> => {
                if (!wanted() || !stillThisRun()) return { kind: 'FAILED', reason: 'CANCELLED' };
                const written = await ai.write(target, value, withProof, current);
                if (written.ok) {
                  showAiView(written.view);
                  return { kind: 'WRITTEN' };
                }
                if (written.code === 'GESTURE_EXPIRED') {
                  return {
                    kind: 'EXPIRED',
                    confirm: (again, againRoot) => {
                      const fresh = captureTrustedShadowGesture(again, againRoot);
                      return fresh === null ? Promise.resolve({ kind: 'FAILED', reason: 'UNTRUSTED' }) : write(value, fresh);
                    },
                  };
                }
                return { kind: 'FAILED', reason: written.code === 'NOT_EMPTY' ? 'CHANGED' : written.code === 'VALUE_COERCED' ? 'UNAVAILABLE' : 'PAGE_CHANGED' };
              };
              return (async (): Promise<DockAiGenerateOutcome> => {
                const reply = await askAi({ step: 'REVISE', title: pageTitle(), field: { ...item.field, hasValue: current.trim() !== '' }, currentValue: current, instruction });
                if (reply?.kind !== 'AI_REVISED') {
                  const code = reply?.kind === 'REFUSED' ? reply.code : 'UNAVAILABLE';
                  return code === 'PAYWALL_REQUIRED' || code === 'QUOTA_EXCEEDED' ? { kind: 'USED_UP' }
                    : { kind: 'FAILED', reason: code === 'AUTH_REQUIRED' ? 'LOGIN' : code === 'SWITCHED_OFF' ? 'SWITCHED_OFF' : 'UNAVAILABLE' };
                }
                if (reply.value.trim() === '') return { kind: 'NOTHING_TO_WRITE' };
                return write(reply.value, proof);
              })();
            };
            dockHandle?.setAiTools({
              targets: ai.revisable.map((item) => item.element),
              generate,
              quota: async () => {
                const reply = await askAi({ step: 'QUOTA' });
                return reply?.kind === 'AI_QUOTA'
                  ? { unlimited: reply.quota.unlimited, remaining: reply.quota.remaining, resetsAt: reply.quota.resetsAt }
                  : null;
              },
            });
          };
        }
      }
      // 这一轮在浮层上收尾：没有送题给 AI 就当场收尾；送了就等 AI 的结局、或用户按「停止」（closeGestureRun）。
      // 「停止」一直管到收尾——AI 那一段也停得了。
      // 连填（2026-09-28）：这一页有了结局（AI、求职信都有了），往下翻还是停下由 fillToReview 判；它接手了就不在这里收尾。
      const continueChain = chain.kind !== 'CHAIN' ? undefined : (written: number) => chainDriver.afterPage(chain.page, {
        written,
        scope: () => ({ origin: location.origin, pathname: location.pathname, vendor: scanned.descriptor.vendor }),
        stopped: () => stopper.signal.aborted,
        current: stillThisRun,
        // 浮层单子里的必填，加上页面上还空着、浮层没认出的；网站此刻标着的错另算（不替他按「下一步」）。
        requiredNeeds: () => requiredNeedsIn(pageView) + pageGapsFor(pageView).unplanned.length,
        siteErrors: () => { const gaps = pageGapsFor(pageView); return gaps.invalid + gaps.alerts; },
        finalSubmit: () => finalSubmitOnPage(scanned.descriptor),
        next: () => wizardAdvance.nextState(),
        label: () => wizardAdvance.label(),
      });
      const refused = result.outcomes.find((item) => !item.ok);
      void closeGestureRun({
        dock: () => dockHandle,
        filled,
        refused: refused !== undefined && refused.ok === false ? refused.reason : undefined,
        ai,
        ...(letterSettled === undefined ? {} : { letter: { settled: letterSettled } }),
        stop: stopper.signal,
        current: stillThisRun,
        onAiOutcome: drawAiOutcome,
        ...(continueChain === undefined ? {} : { next: continueChain }),
      }).catch((error: unknown) => {
        // 收尾那一段抛了（画 AI 的结局、连填往不往下翻）：closeGestureRun 先照常收尾再交出错误，这里记一个码；万一进度卡
        // 还在转，照「这一轮没有完成」收住。
        reportDockError('GESTURE_RUN_CLOSE_THREW', error);
        if (stillThisRun() && dockHandle?.runState() === 'RUNNING') dockHandle.reportBlocked('RUN_FAILED');
      }).finally(() => { if (gestureStop === stopper) gestureStop = null; });
    };

    // ── 浮层上几样只读的展示信息（2026-09-23 设计）：岗位卡、头像与账户菜单、「你的资料」的两行 ──────────
    // 岗位名只在用户打开面板之后才读（只读页面的公开标准：JobPosting / og:title），不在挂浮层时碰宿主页。
    // 首页的岗位卡（2026-09-24）：读到 JobPosting 就带上地点、办公方式、雇佣类型、薪资、一段简介与发布日期，
    // 浮层把它展开成摘要卡。简介是 JD 的第一段：只进浮层，不进日志、诊断、遥测，也不跟着任何意图上行。
    let jobCardNow: DockJobCard | null = null;
    const dockJobCard = (summary: PageJobSummary): DockJobCard | null => {
      if (summary.title === '' && summary.company === '' && summary.facts === null) return null;
      const { facts } = summary;
      if (facts === null) return { title: summary.title, company: summary.company };
      return {
        title: summary.title,
        company: summary.company,
        facts: {
          location: facts.location,
          workMode: facts.workMode,
          employment: facts.employment,
          salary: facts.salary,
          description: facts.description,
          postedAt: facts.datePosted === '' ? null : facts.datePosted,
          // 「查看完整岗位详情」：申请页地址去掉 /apply 或 /application 的那一页；算不出就不摆。
          detailUrl: detailPageUrl(location.href),
        },
      };
    };
    const refreshJobCard = (): void => {
      let here: PageJobSummary;
      try {
        here = readJobSummaryFromPage(document);
      } catch {
        jobCardNow = null;
        return;
      }
      jobCardNow = dockJobCard(here);
      if (here.facts !== null) return;
      // 申请页自己没有 JobPosting（Workable、Lever、Jobvite 的申请页）：读同站点的详情页（与填写共用那一次取数），
      // 回来了再重画岗位卡。读不出就照旧是一行岗位名。
      const href = location.href;
      void nearbyPosting().summary(document, href).then((nearby) => {
        if (nearby === null || nearby.facts === null || location.href !== href) return;
        jobCardNow = dockJobCard({ title: nearby.title || here.title, company: nearby.company || here.company, facts: nearby.facts });
        dockHandle?.refreshJob();
      }, () => {
        // 读取器自己不会拒绝（取不到就是 null）；万一抛了，岗位卡照旧是一行岗位名。
      });
    };
    let accountNow: { name: string; email: string } | null = null;
    let helloGeneration = 0;
    let helloRequest = 0;
    let profileSummaryNow: string | null = null;
    let resumeSummaryNow: string | null = null;
    // 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人，浮层里一张卡请他同意。要不要请由 worker 判、
    // 随预取的档案答复带来；同意那一下当场验是我们 shadow 里的真实点击，再经 worker 记到 argoland。
    const signingReconsent = createSigningReconsent({
      grant: () => directory.setSigningConsent(true),
      verifyGesture: (event, shadowRoot) => captureTrustedShadowGesture(event, shadowRoot) !== null,
      remember: (version) => {
        void browser.storage.local.set({ [SIGNING_RECONSENT_DECLINED_KEY]: version }).catch(() => {
          // 记不下只是下次打开还会再问一次。
        });
      },
      onSaved: () => { profileWarm = null; },
    });
    /** 用预取的那份档案与简历问询画头像和「你的资料」；取不到就维持设计里的通用副标题。 */
    const refreshAccount = async (): Promise<void> => {
      const generation = helloGeneration;
      warmProfile();
      const reply = await profileWarm?.reply.catch(() => null);
      if (generation !== helloGeneration) return;
      // 等的时候换了人（2026-10-04）：这一份是上一个人的，不画。
      if (reply?.kind === 'PROFILE' && reply.session !== undefined && reply.session !== sessionNow) return;
      if (reply?.kind === 'PROFILE') {
        signingReconsent.observe(reply.signingReconsent === true);
        const flat = reply.profile;
        const name = (flat.fullName ?? `${flat.firstName ?? ''} ${flat.lastName ?? ''}`).trim();
        const email = (flat.email ?? '').trim();
        accountNow = name === '' && email === '' ? null : { name, email };
        profileSummaryNow = [name, email].filter((part) => part !== '').join(' · ') || null;
      }
      const seam = await resumeWarm?.seam.catch(() => undefined);
      if (generation !== helloGeneration) return;
      if (seam !== undefined) resumeSummaryNow = dockCopy(dockLocale()).resumeDefault(seam.fileName);
      dockHandle?.refreshAccount();
    };
    /**
     * 此刻登录的是谁（worker 给的不透明代号，lib/sessionStamp.ts；没登录是 null，还没问过是 undefined）。
     *
     * 换了账号绝不填上一个人的资料（2026-10-04；2026-10-03 体检 3.1）：从前「登录态变了」的广播只让这一页重新报到，脸没变时
     * showFace 在清缓存之前就 return 了——开着的页面仍挂着上一个人的名字，60 秒内按「自动填写」用的是上一个人的档案。现在报到、
     * 授权、档案答复里都带这个代号；看到它变了就把上一个人的东西一样不留地丢掉（`forgetUser`），再按新的人重读。
     */
    let sessionNow: string | null | undefined;
    /** 看一眼 worker 说的代号：变了（之前知道是谁、现在是另一个人或没登录）就丢掉上一个人的一切，交回 true。 */
    const observeSession = (stamp: unknown): boolean => {
      if (stamp !== null && typeof stamp !== 'string') return false;
      if (sessionNow === undefined) { sessionNow = stamp; return false; }
      if (stamp === sessionNow) return false;
      sessionNow = stamp;
      forgetUser();
      return true;
    };
    /** 上一个人的东西：预取的档案与简历问询、头像名字与「你的资料」、AI 开关、同意卡、编辑器里那一份（连同没存的修改）。 */
    const forgetUser = (): void => {
      helloGeneration += 1;
      profileWarm = null;
      resumeWarm = null;
      accountNow = null;
      profileSummaryNow = null;
      resumeSummaryNow = null;
      aiSwitchOn = null;
      memoryNoticeShown = false;
      signingReconsent.observe(false);
      dockHandle?.forgetUser();
      dockHandle?.refreshAccount();
    };
    /** 换了人之后：脸没变也按新的人把头像名字读回来（手势路那几张脸顺便预取，按下去就不用等）。 */
    const afterSessionChange = (): void => {
      if (dockHandle === null) return;
      void refreshAccount();
    };
    /**
     * 资料编辑器除 Profile V2 之外的三样（自我认同、代填授权、默认简历），都经 worker 走用户自己的 token。
     * 自我认同存的是门户那几句英文原文；空答案不发（服务端按「没填过」处理）。
     */
    const dockProfilePorts = (): DockProfileEditorPorts => {
      let libraryRevision: string | null = null;
      // 浮层不管的那几问（出生性别、是否跨性别、性取向）：保存是整份替换，每次读到、存成都记下，保存时原样带回去。
      let eeoBeyondDock = eeoAnswersBeyondDock({});
      // 现读过（或存成过）没有：上一次读到的那一份只在还没有现读过时才拿来记 revision 与那几问（2026-10-04）。旧的 revision
      // 存不上只会 412，编辑器会重读、合上去再存。
      let eeoLive = false;
      let libraryLive = false;
      const eeoRecordOf = (value: { answers: Readonly<Record<string, readonly string[] | undefined>>; reuseEnabled: boolean; revision: string }, remember = true) => {
        if (remember) eeoBeyondDock = eeoAnswersBeyondDock(value.answers);
        return {
          revision: value.revision,
          answers: {
            genderIdentity: value.answers.genderIdentity?.[0] ?? '',
            hispanicLatino: value.answers.hispanicLatino?.[0] ?? '',
            raceEthnicity: value.answers.raceEthnicity ?? [],
            veteranStatus: value.answers.veteranStatus?.[0] ?? '',
            disabilityStatus: value.answers.disabilityStatus?.[0] ?? '',
            reuseEnabled: value.reuseEnabled,
          },
        };
      };
      const libraryOf = (library: { defaultTrackId: string | null; tracks: readonly { trackId: string; name: string; archivedAt: string | null; currentVersionId: string | null; versions: readonly { resumeVersionId: string; fileName: string; updatedAt: string }[] }[] }) => {
        const items = library.tracks.filter((track) => track.archivedAt === null && track.currentVersionId !== null).map((track) => {
          const version = track.versions.find((item) => item.resumeVersionId === track.currentVersionId);
          const updated = version === undefined ? null : new Date(version.updatedAt);
          const when = updated === null || Number.isNaN(updated.getTime()) ? '' : dockCopy(dockLocale()).profile.resumeUpdated(updated.getMonth() + 1, updated.getDate());
          return { id: track.trackId, name: version?.fileName ?? track.name, meta: `${track.name}${when}` };
        });
        return { items, defaultId: library.defaultTrackId };
      };
      return {
        // 上一次读到的那一份（2026-10-04）：资料那一格没有就是 null，编辑器照旧先转圈；另三格各自可缺。
        cached: async () => {
          const view = await directory.cached();
          if (view === null || view.profileV2 === null) return null;
          if (view.resumeLibrary.ok && !libraryLive) libraryRevision = view.resumeLibrary.value.libraryRevision;
          return {
            at: view.profileV2.at,
            profile: view.profileV2.value,
            eeo: view.eeo.ok ? { ok: true, value: eeoRecordOf(view.eeo.value as never, !eeoLive) } : { ok: false, code: view.eeo.code },
            consent: view.signingConsent.ok ? { ok: true, value: view.signingConsent.value } : { ok: false, code: view.signingConsent.code },
            resumes: view.resumeLibrary.ok ? { ok: true, value: libraryOf(view.resumeLibrary.value as never) } : { ok: false, code: view.resumeLibrary.code },
          };
        },
        eeo: {
          load: async () => {
            const result = await directory.eeo();
            if (result.ok) eeoLive = true;
            return result.ok ? { ok: true, value: eeoRecordOf(result.value as never) } : { ok: false, code: result.code };
          },
          save: async (answers, expectedRevision) => {
            // 自我认同随档案答复带去预填：存过（存没存上都算，结局说不准）预取的那一份就作废。
            const result = await directory.saveEeo({
              schemaVersion: 1,
              expectedRevision: expectedRevision as never,
              reuseEnabled: answers.reuseEnabled,
              disclosureVersion: 'self-identification-2026-09-21',
              answers: eeoAnswersForSave(answers, eeoBeyondDock),
            }).finally(() => { profileWarm = null; });
            if (result.ok) eeoLive = true;
            return result.ok ? { ok: true, value: eeoRecordOf(result.value as never) } : { ok: false, code: result.code };
          },
        },
        signing: {
          load: async () => {
            const result = await directory.signingConsent();
            return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code };
          },
          set: async (granted) => {
            // 同意、撤回过（存没存上都算）：预取的档案作废（2026-10-03 体检 P0-1）。代不代签本来就在每一轮开始时现读。
            const result = await directory.setSigningConsent(granted).finally(() => { profileWarm = null; });
            return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code };
          },
        },
        resumes: {
          load: async () => {
            const result = await directory.resumeLibrary();
            if (!result.ok) return { ok: false, code: result.code };
            libraryRevision = result.value.libraryRevision;
            libraryLive = true;
            return { ok: true, value: libraryOf(result.value as never) };
          },
          setDefault: async (trackId) => {
            if (libraryRevision === null) return { ok: false, code: 'STALE' };
            const result = await directory.setDefaultResume(trackId, libraryRevision);
            if (!result.ok) return { ok: false, code: result.code };
            libraryRevision = result.value.libraryRevision;
            libraryLive = true;
            resumeWarm = null;
            return { ok: true, value: result.value.defaultTrackId ?? trackId };
          },
        },
      };
    };

    /**
     * 公司官网里嵌着认得的 ATS iframe（2026-10-04，bench-1003：Brex、Datadog、Databricks、MongoDB 嵌 Greenhouse）：申请表在
     * 那一帧里，那一帧自己挂浮层、能填；顶层这一个按下去只会让位（门控的 `YIELDED_TO_FRAME`，「这一轮没有完成」）。页面上
     * 两个浮层、亮着「自动填写」的那个按不动——顶层这一个让开，只留那一帧的（它自己摆在看得见的那一段里，见 dock.ts 的
     * `band`）。判据与门控是同一个函数（只读 iframe 的 src，不读它的内容），所以挂不挂与按下去让不让位永远一致。
     */
    const yieldsToEmbeddedFrame = (): boolean => {
      if (!isTopFrame) return false;
      try {
        return shouldYieldToEmbeddedFrame({ doc: document, isTopFrame });
      } catch {
        return false;
      }
    };
    /** 让位就撤下顶层这一个（已经挂着的一并撤下：它此刻按下去也只会让位）；返回让没让。 */
    const yieldToEmbeddedFrame = (): boolean => {
      if (!yieldsToEmbeddedFrame()) return false;
      wizardAdvance.disarm();
      submitter.disarm();
      dockHandle?.dismiss();
      dockHandle = null;
      return true;
    };
    const showFace = (reply: unknown): void => {
      if ((!isTopFrame && !frameOwnsDock) || assistantOwnsDock) return;
      const dock = parseAutofillDockInstruction(reply);
      if (dock === null) return;
      if (yieldToEmbeddedFrame()) return;
      lastFaceReply = { dock: (reply as { dock?: unknown }).dock };
      const justSubmitted = (reply as { justSubmitted?: unknown } | null)?.justSubmitted === true;
      // 手势路那几张脸：没绑任务（NO_MISSION），或绑着门户「开始申请」的任务（READY，2026-09-24）。
      const gestureFace = dock.kind === 'READY' || (dock.kind === 'UNAVAILABLE' && dock.reason === 'NO_MISSION');
      // The same face again changes nothing on screen; a different one replaces
      // the panel rather than standing a second one beside it.
      // 比完整身份（kind:reason），不只比 kind：退出登录后 UNAVAILABLE 的 reason 从 NO_MISSION
      // 变成 PORTAL_UNLINKED，只比 kind 会让浮层停在「已连接」的旧脸上。
      if (dockHandle !== null && dockHandle.faceKey() === affordanceFaceKey(dock) && !justSubmitted) return;
      // 换脸时保留开合：用户刚在面板里点了「退出登录」，面板不该随之消失只剩一个角标。
      const wasOpen = dockHandle?.isOpen() === true;
      // 焦点在旧浮层里（他正在浮层里操作，比如刚点了「退出登录」）：新浮层挂上后把焦点交回来——开着交给面板，收着交给启动按钮。
      // 焦点在网页上就不碰：自动打开从不挪焦点（2026-10-03 体检 P0-2：他正在网页上打字，下一个键就丢了）。
      const hadFocus = dockHandle?.hasFocus() === true;
      // 能填的那一面才自动打开：一次加载一次，这一页或这个站点 30 分钟之内收起过就不开。
      // 公司自己做的表（通用路——主机不在厂商表里、报到时也没有厂商指纹）：表里有只有求职才问的栏（简历／CV、LinkedIn、
      // 工作授权、学历）才自动打开（负责人 2026-09-28）；只靠 JobPosting 或招聘页网址撑着的表照旧只挂收着的标签。
      const companyBuiltForm = pageEvidence !== null && pageEvidence.hello().vendorHint === undefined;
      const autoOpenNow = !wasOpen && dockAutoOpen().shouldOpen(
        dock,
        collapsedRecently(dockCollapses, location.origin, Date.now()),
        companyBuiltForm ? { lane: 'company', jobOnlyFields: pageEvidence.hasJobOnlyFields() } : { lane: 'vendor' },
      );
      const previousFaceKey = dockHandle?.faceKey() ?? null;
      // 换脸就是换一个浮层：旧浮层上那一轮与它 arm 的那一页一起作废（连填那一轮也是：旧浮层的 onDismissed）。
      wizardAdvance.disarm();
      submitter.disarm();
      dockHandle?.dismiss();
      // 预取的档案与简历问询属于上一张脸（可能刚退出登录、换了账号），一并作废。
      profileWarm = null;
      resumeWarm = null;
      /**
       * 「继续到下一页」= 翻过去，然后接着填下一页（2026-09-22 负责人：点击到下一页，就是自动开始填
       * 下一页了）。点击当下取凭证——与 Autofill 同一个信任根——翻过去之后拿它填新的一页。
       * 用户自己在网站上按的「下一步」不走这里：那一下没有凭证，浮层只回到可以点 Autofill 的样子。
       *
       * 放在这里而不是外层：它引用 runGestureFill。在浮层挂不出来的构建里（Assistant 面板接管时）
       * 整条手势填写链本来是死代码、被整个删掉；从外层引用一次，那约 22 KB 就被拉回 apply.js。
       */
      const advanceThenFill = createAdvanceThenFill({
        advance: (event, shadowRoot) => wizardAdvance.advance(event, shadowRoot),
        fillNextPage: (proof) => { void runGestureFill(proof, fillToReview(), 'AFTER_ADVANCE'); },
      });
      // 招聘网站账号（2026-09-28，lib/accountAccessPage.ts）：手势路那几张脸上才有；换脸、浮层拆掉时一并收掉（等着他回来
      // 接着登录的那一下也算）。只在这里建：Assistant 构建里 showFace 是死代码，这一整套随之删掉。
      // 与手势填写同一条路：worker 给这一页的 DISCOVERY 授权、本机从已存的运行时包解出来。
      const discoverRuntime = async () => {
        const authReply = await askWorker('DISCOVERY_AUTHORITY');
        if (authReply?.kind !== 'DISCOVERY_AUTHORITY') return null;
        const authorization = parseRuntimeExecutionAuthorization(authReply.authorization);
        if (authorization === null || authorization.purpose !== 'DISCOVERY') return null;
        const resolved = await resolveStoredDiscoveryRuntimeAuthority({
          stored: await readStoredRuntimeBundle(),
          authorization,
          nowMs: Date.now(),
          extensionVersion: browser.runtime.getManifest().version,
        }).catch(() => null);
        return resolved?.ok === true ? resolved.value : null;
      };
      const siteName = (): string =>
        dockCopy(dockLocale()).siteAccount.site(jobCardNow?.company.trim() ?? '', vendorDisplayName(location.hostname) ?? 'ATS');
      const account = !gestureFace ? null : createAccountAccessPage({
        doc: document,
        here: () => ({ origin: location.origin, pathname: location.pathname, hostname: location.hostname }),
        vendor: detectApplyVendor(location.hostname),
        isTopFrame,
        isVisible: isRenderedControl,
        openShadowRoot: openVerifiedHostShadowRoot,
        send: sendToWorker,
        discovery: discoverRuntime,
        dock: () => dockHandle,
        chain: fillToReview,
        fillPage: (root, mode) => runGestureFill(root, fillToReview(), mode),
        restart: () => {
          gestureStop?.abort();
          const stopper = new AbortController();
          gestureStop = stopper;
          return stopper;
        },
        site: siteName,
        // 他去邮箱点完验证链接、回到这一页（标签页重新获得焦点）。
        onReturn: (listener) => {
          const onVisible = (): void => { if (document.visibilityState === 'visible') listener(); };
          window.addEventListener('focus', listener);
          document.addEventListener('visibilitychange', onVisible);
          return () => {
            window.removeEventListener('focus', listener);
            document.removeEventListener('visibilitychange', onVisible);
          };
        },
      });
      // 网站要邮件里的验证码（2026-10-04，lib/verificationCodePage.ts）：同样只在手势路那几张脸上、只在这里建。验证码由他在
      // 浮层那张卡上输或粘贴，插件写进规则声明的那几格；插件不读邮件、写完不提交。
      const codePage = !gestureFace ? null : createVerificationCodePage({
        doc: document,
        here: () => ({ hostname: location.hostname, pathname: location.pathname }),
        vendor: detectApplyVendor(location.hostname),
        isTopFrame,
        isVisible: isRenderedControl,
        discovery: discoverRuntime,
        dock: () => dockHandle,
        site: siteName,
      });
      submitCodeHook.read = () => codePage?.mark() ?? null;
      dockHandle = mountAutofillDock(dock, {
        locale: dockLocale(),
        // 账户菜单里换语言（2026-09-27）：记在插件自己的 storage.local 里，换一套文案原样重挂浮层（开着的保持开着）。
        // 浮层只在主页上放行这一下（没有在填、也没有这一轮的结果），重挂不会打断什么。
        onChangeLocale: (value) => {
          // 断了线：存不下、重挂的新浮层也找不到插件——留在「已更新」那张卡上。
          if (!runtimeAlive()) { extensionUpdated(); return; }
          dockLocaleNow = value;
          void browser.storage.local.set({ [DOCK_LOCALE_KEY]: value }).catch(() => {
            // 存不下只是下次打开又跟随浏览器；这一页已经换过来了。
          });
          const reopen = dockHandle?.isOpen() === true;
          const face = lastFaceReply;
          dockHandle?.dismiss();
          dockHandle = null;
          if (face !== null) showFace(face);
          // showFace 刚把新的浮层挂进 dockHandle（TypeScript 看不出这次重新赋值）。他刚在菜单里点了语言：打开并把焦点交回面板。
          if (reopen) (dockHandle as AutofillDockHandle | null)?.openPanel();
        },
        // 在面板里改了资料：预取的那一份作废，下一轮重新取。
        directory: {
          ...directory,
          saveProfileV2: (patch) => directory.saveProfileV2(patch).finally(() => { profileWarm = null; }),
        },
        // 资料编辑器里的自我认同、代填授权、默认简历（2026-09-23：资料要能直接在插件里改）。
        profilePorts: dockProfilePorts(),
        // 面板打开：读这一页的岗位名（只读页面的公开标准：JobPosting / og:title），并把这一轮要用的东西
        // 提前取来——打开面板的人多半下一秒就会按自动填写。
        onPanelOpen: () => {
          refreshJobCard();
          if (gestureFace) { warmProfile(); warmResume(); }
          void refreshAccount();
        },
        jobCard: () => jobCardNow,
        account: () => accountNow,
        entrySummary: (target) => (target === 'AUTOFILL_INFORMATION' ? profileSummaryNow : target === 'RESUME' ? resumeSummaryNow : null),
        extensionVersion: browser.runtime.getManifest().version,
        // 进度卡上的「停止」：停手势路那一轮（绑着任务的页也走手势路，2026-09-24）；连填那一轮（2026-09-28）一并作废——
        // 正在替他翻页的那一下若还没按就不按，翻过去了也不接着填。
        ...(gestureFace ? { onStop: () => { fillToReviewNow?.end(); gestureStop?.abort(); } } : {}),
        // 浮层被拆了（换脸、让给助手、让给顶层帧）：它驱动的那一轮连填一并作废（2026-09-28），账号墙那一套一并收掉。
        onDismissed: () => { fillToReviewNow?.end(); gestureStop?.abort(); account?.dispose(); codePage?.dispose(); submitCodeHook.read = () => null; },
        ...(account === null ? {} : { accountAccess: account.handlers, vaultManagement: account.vaultManagement }),
        ...(codePage === null ? {} : { verificationCode: codePage.handlers }),
        // AI 代答的开关（账户菜单里那一项）：手势路那几张脸上都摆——绑着任务的页（READY）也走手势路，
        // 同一轮里照样会用 AI 代答（2026-09-24），开关得让他在这一页上也够得着。
        ...(gestureFace ? { aiAnswers: aiSwitch } : {}),
        // 「记住我的回答」（2026-09-28，默认开）：同在账户菜单里，手势路那几张脸上都摆。
        ...(gestureFace ? { answerMemory: memorySwitch } : {}),
        // 代填授权的一键同意（2026-09-28）：那张卡要不要摆由预取的档案答复决定。
        signingReconsent,
        // 「暂时没法判断这一页」那张脸上的「重新检查」：重新报到，拿到规则就换脸。
        onRecheck: () => { lastHelloAt = 0; void hello(); },
        // 在插件里提交：信封合上的那一刻按规则声明的最终提交，按完等网站给结论。
        submission: {
          available: () => submitter.available(),
          send: (event, shadowRoot, pressAt) => {
            // 断了线：重读不了远程开关，一下都不按网站的提交（fail closed）；浮层换成「已更新」那张卡。
            if (!runtimeAlive()) { extensionUpdated(); return Promise.resolve('UNAVAILABLE'); }
            const sent = submitter.send(event, shadowRoot, pressAt);
            // 这一页那一轮的结局记下「提交」后来怎样（按了、网站确认、没收、按不了）。
            runTap().pressed(sent);
            // 网站在这一页上确认了提交：让 worker 替他向任务报「已提交」（没绑任务时 worker 什么都不做）。
            missionSession.afterDockSubmit(sent);
            // 网站要的是邮件里的验证码（2026-10-04）：那张卡马上换上，不等下一次看。
            void sent.then((outcome) => { if (outcome === 'CODE_REQUIRED') codePage?.refresh(); }, () => {});
            return sent;
          },
        },
        // 上一页刚替用户按了提交、网站整页跳到了这里：浮层把「提交成功」那段播完。
        ...(justSubmitted ? { justSubmitted: true } : {}),
        // 多页申请：收尾那一幕的「继续到下一页」。浮层只报用户按了；能按哪颗、按不按、翻没翻，
        // 由 wizardAdvance 判——它会当场验这一下是不是我们浮层里的真点击；翻过去之后接着填下一页。
        nextStep: {
          label: () => wizardAdvance.label(),
          advance: (event, shadowRoot) => {
            // 断了线：重读不了远程开关，不按网站的下一步；浮层换成「已更新」那张卡。
            if (!runtimeAlive()) { extensionUpdated(); return Promise.resolve('UNAVAILABLE'); }
            const pending = advanceThenFill(event, shadowRoot);
            // 翻过去了但不接着填：上一页那一轮的复查到此为止。接着填的那一轮自己会换轮次。
            void pending.then((outcome) => { if (outcome === 'ADVANCED') gestureRunSerial += 1; });
            return pending;
          },
        },
        vendorLabel: vendorDisplayName(location.hostname),
        hostname: location.hostname,
        embeddedFrame: !isTopFrame,
        // 能填的申请表：挂上就打开（用平常那段打开动画）；别的脸收着，等用户来点。
        autoOpen: wasOpen || autoOpenNow,
        // 自动打开之前避开网站右侧的主要按钮（提交、申请、下一步）：收窄让开，让不开就先不开（2026-10-04）。
        // 他刚才开着的（换脸重挂）照旧开着，不再量。
        ...(autoOpenNow && !wasOpen ? { siteActions: () => sitePrimaryActions({ document, isVisible: isRenderedControl }) } : {}),
        onCollapse: () => {
          dockAutoOpen().collapsed();
          rememberCollapse(withCollapse);
        },
        onLauncherOpen: () => {
          if (collapsedRecently(dockCollapses, location.origin, Date.now())) rememberCollapse(withoutCollapse);
        },
        ...(launcherTopRatio === undefined ? {} : { launcherTopRatio }),
        onMoveLauncher: (ratio) => {
          launcherTopRatio = ratio;
          // 断了线就记不下（storage 当场抛）：这一页上的位置已经挪好了。
          if (runtimeAlive()) void browser.storage.local.set({ [LAUNCHER_TOP_RATIO_KEY]: ratio }).catch(() => {});
        },
        onAutofill: (event, shadowRoot) => {
          // 和插件断了线（插件刚更新）：问不到授权、要不到档案，一个字都填不了——换成「已更新」那张卡，不说「暂时连不上」。
          if (!runtimeAlive()) { extensionUpdated(); return; }
          // 一律走手势路：信任根是**用户刚按下的这一次点击**（isTrusted + 来自我方 shadow），
          // 填的是他自己已保存的档案。2026-09-17 的产品决定：任何一家我们认得的申请页都能填。
          // 绑着任务的页（READY，2026-09-24）同一条路，另在 worker 里记任务运行（见 runGestureFill）；
          // 从前那条经 worker 找任务、走内核桥的 dock/fill 路在生产上从来找不到批准过的任务，已删。
          // 就在这里判「这是不是我们浮层里的真点击」——**同步，在 await 之前**。
          // `composedPath()` 派发一结束就空了，晚一步问就必然判否。
          const proof = captureTrustedShadowGesture(event, shadowRoot);
          if (proof === null) {
            dockHandle?.reportBlocked('GESTURE_UNTRUSTED');
            return;
          }
          // 这一页是规则声明的账号墙（2026-09-28）：先替他注册或登录，过去了接着填。
          if (account !== null && account.wallOnPage()) { void account.run(proof); return; }
          void runGestureFill(proof, fillToReview());
        },
        onOpenPortal: openPortal,
        onSignOut: signOut,
        recentDiagnostics,
        // 浮层这一侧自己的错（按钮抛了、资料保存抛了、复制没成、开关读不到）：交一个稳定码（2026-10-04 体检 11-2）。
        onDiagnostic: reportDockDiagnostic,
        onError: reportDockError,
        // 简历与求职信在门户里管，那两行打开门户的对应页。
        onOpenEntry: (target) => {
          if (target === 'RESUME') openPortal('PROFILE');
          else if (target === 'COVER_LETTER') openPortal('APPLICATIONS');
        },
      });
      // 这一轮怎么收场，从浮层上看（体检 11-1）：收场的那几下照转给浮层，同时记下来。
      dockHandle = runTap().observe(dockHandle);
      if (autoOpenNow) dockAutoOpen().opened();
      if (hadFocus) {
        if (dockHandle.isOpen()) dockHandle.openPanel();
        else dockHandle.launcherButton()?.focus({ preventScroll: true });
      }
      account?.start();
      codePage?.start();
      // 刚在门户登录完回来：换上已连接的那张脸时说一声。
      if (previousFaceKey === 'UNAVAILABLE:PORTAL_UNLINKED' && !(dock.kind === 'UNAVAILABLE' && dock.reason === 'PORTAL_UNLINKED')) {
        dockHandle.toast(dockCopy(dockLocale()).toast.connected);
      }
      // 上一页替他过了数据同意页、网站整页跳到了这里（2026-10-04，负责人 D7）：照实说替他做了什么。
      if ((reply as { consentGatePassed?: unknown } | null)?.consentGatePassed === true) {
        dockHandle.toast(dockCopy(dockLocale()).consentGate.passed);
      }
      // 档案不带页面信息：这张脸一挂上就开始取，用户点开面板、按下自动填写时多半已经到手
      // （2026-09-23 实测后端这四个接口要 1–1.9 秒，面板打开到点下去常常不够）。
      if (gestureFace) warmProfile();
      // 上一页刚按了提交、整页跳到了这里：网站在这一页上确认了，就替他向任务报「已提交」。
      if (justSubmitted) missionSession.confirmArrival(document);
    };
    // These notices belong to the legacy dock. Assistant uses the kernel bridge;
    // its independent runtime-bundle, scan and submission guards stay installed.
    if (!assistant) {
      // The worker reports which step a dock-started run is on. Words only, and
      // only for the page that asked: a step for a run the dock is not showing
      // changes nothing.
      browser.runtime.onMessage.addListener((raw, sender) => {
        const step = parseDockRunStep(raw);
        if (step === null || sender.id !== browser.runtime.id || sender.tab || (!isTopFrame && !frameOwnsDock)) return;
        dockHandle?.setStep(step);
      });
      // 登录态变了（worker 广播）：重新报到换脸。只认 worker 发来的、不带值的那一条。
      browser.runtime.onMessage.addListener((raw, sender) => {
        if (!isDockSessionChanged(raw) || sender.id !== browser.runtime.id || sender.tab) return;
        // Retire actual writers and plaintext immediately, before awaiting hello.
        gestureRunSerial += 1;
        gestureStop?.abort();
        wizardAdvance.disarm(); submitter.disarm();
        forgetUser();
        // dismiss synchronously ends the dock's chain and disposes its credential/code pages.
        // Keep the gesture-only driver dependency inside showFace for Assistant tree shaking.
        dockHandle?.dismiss(); dockHandle = null;
        lastHelloAt = 0;
        void hello();
      });
      // 资料或代填授权在插件里（别的标签页、这一页的编辑器）改过了（worker 广播，2026-10-03 体检 P0-1）：预取的档案与简历问询
      // 作废，下一轮重新取。同样只认 worker 发来的、不带值的那一条。
      browser.runtime.onMessage.addListener((raw, sender) => {
        if (!isDockProfileChanged(raw) || sender.id !== browser.runtime.id || sender.tab) return;
        profileWarm = null;
        resumeWarm = null;
      });
    }
    browser.runtime.onMessage.addListener((raw,sender)=>{
      const visibility=parseAssistantDockVisibility(raw);
      if(!visibility||sender.id!==browser.runtime.id||sender.tab||!isTopFrame)return;
      assistantOwnsDock=visibility.hidden;
      if(assistantOwnsDock){wizardAdvance.disarm();submitter.disarm();dockHandle?.dismiss();dockHandle=null;}else void hello();
      return Promise.resolve({ok:true});
    });
    // 嵌入的申请表那一帧刚挂上自己的浮层（2026-10-04，iframe 晚到）：worker 叫顶层再看一眼，按门控那个判据让位就撤下。
    browser.runtime.onMessage.addListener((raw, sender) => {
      if (!isTopFrame || sender.id !== browser.runtime.id || sender.tab || !parseDockTopYield(raw)) return;
      yieldToEmbeddedFrame();
    });
    // 顶层帧后来认出自己就是申请页（P2-10）：浮层归顶层，这一帧撤下。
    browser.runtime.onMessage.addListener((raw, sender) => {
      if (isTopFrame || sender.id !== browser.runtime.id || sender.tab || !parseDockFrameYield(raw)) return;
      frameOwnsDock = false;
      wizardAdvance.disarm();
      submitter.disarm();
      dockHandle?.dismiss();
      dockHandle = null;
    });
    // 报到（fire-and-forget；SW 冷启动丢失登记时由下一次报到/重扫兜底）。
    let lastHelloAt = 0;
    /**
     * `recheckEvidence` 刚探过页面、证据多了才报到：那一次报到不必再探一遍（同一拍里 DOM 没变，结论必然相同；
     * 有表的页面上一次探测 13–40 ms，2026-10-03 实测）。只在那一次 hello 同步执行的那一段里为真。
     */
    let evidenceJustRead = false;
    /**
     * 「暂时取不到规则」问到第几次了。
     *
     * 只有那一张脸（以及后台压根没答上来）会重问，判据在 `nextFaceRetryDelayMs`。
     * 任何一次拿到别的脸就归零：那是关于这一页的结论，问题已经过去了。
     */
    let faceRetryAttempt = 0;
    let faceRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const hello = (): Promise<void> => {
      if (assistant) return Promise.resolve(); // Assistant owns the surface; injection never opens the legacy dock.
      /** worker 答上来了：之后再抛的不是「worker 没醒」，是换脸那一段自己的错（2026-10-04 体检 11-2，从前被一并吞掉）。 */
      let answered = false;
      // 和插件断了线（插件刚更新；切回这个标签页、站内换页时最先发现）：不再报到（sendMessage 当场就抛，重问的那一档也排不上），
      // 浮层换成「已更新」那张卡。
      if (!runtimeAlive()) {
        extensionUpdated();
        return Promise.resolve();
      }
      // 子帧不报到。
      //
      // 报到写的是「这个标签页停在哪一页」，按 tabId 存一条、后来的覆盖先来的。
      // 内容脚本是 allFrames 注入的，所以页面上任何一个跨源 iframe 也会报到，
      // 把顶层帧那条盖掉——2026-09-18 在真实 Greenhouse 页上实测到表里只剩
      // reCAPTCHA 那个 `content.googleapis.com` 的 iframe。
      //
      // 后台那侧也查了 `sender.frameId`（两道都留着：这一道省掉一次无谓的消息，
      // 那一道才是承重的——信任判断属于收消息的那一侧）。
      // 子帧照常被扫描（主机在厂商表里的子帧照常拿规则），只是不由它来说这个标签页停在哪一页。
      //
      // 子帧改说「我这一帧持有申请表」（P2-10，白标 A）：后台另记一张表（只记 frameId +
      // origin + pathname，先来的算数），顶层自己是申请页时它答 HIDDEN。主机名不在厂商表里的
      // 帧（reCAPTCHA 之类，`inertSubframe`）连问都不问——省一次消息，判断仍在收消息的那一侧。
      if (inertSubframe) return Promise.resolve();
      const now = Date.now();
      if (now - lastHelloAt < 2000) return Promise.resolve();
      lastHelloAt = now;
      const generation = helloGeneration;
      const request = ++helloRequest;
      let acceptedGeneration = generation;
      if (!evidenceJustRead) pageEvidence?.refresh();
      return Promise.all([
        browser.runtime.sendMessage({
          kind: isTopFrame ? 'bridge/hello' : 'bridge/frame-form',
          origin: location.origin,
          pathname: location.pathname,
          ...(pageEvidence?.hello() ?? {}),
        }),
        browser.storage.local.get([LAUNCHER_TOP_RATIO_KEY, DOCK_COLLAPSED_AT_KEY, DOCK_LOCALE_KEY, SIGNING_RECONSENT_DECLINED_KEY])
          .catch(() => ({} as Record<string, unknown>)),
      ])
        .then(([reply, stored]) => {
          if (generation !== helloGeneration || request !== helloRequest) return;
          answered = true;
          // 他在这台电脑上对这一版代填授权说过「暂不」（2026-09-28）：这一版不再请他。
          signingReconsent.restoreDeclined((stored as Record<string, unknown> | undefined)?.[SIGNING_RECONSENT_DECLINED_KEY]);
          const ratio = (stored as Record<string, unknown> | undefined)?.[LAUNCHER_TOP_RATIO_KEY];
          if (typeof ratio === 'number' && Number.isFinite(ratio)) launcherTopRatio = ratio;
          // 用户选过语言就照他选的（没选过就留给 dockLocale() 去问浏览器）。
          const chosenLocale = storedDockLocale((stored as Record<string, unknown> | undefined)?.[DOCK_LOCALE_KEY]);
          if (chosenLocale !== null) dockLocaleNow = chosenLocale;
          const collapses = (stored as Record<string, unknown> | undefined)?.[DOCK_COLLAPSED_AT_KEY];
          // 过了 30 分钟的收起记录顺手丢掉，不在插件存储里一直留着访问过哪些招聘站点（形状不对的也一并丢掉）。
          const fresh = freshCollapses(collapses, Date.now());
          const storedCount = collapses === undefined ? 0 : collapses !== null && typeof collapses === 'object' ? Object.keys(collapses).length : 1;
          dockCollapses = fresh;
          if (storedCount !== Object.keys(fresh).length) {
            void browser.storage.local.set({ [DOCK_COLLAPSED_AT_KEY]: fresh }).catch(() => {
              // 丢不掉就下次再丢：读的时候本来就只认 30 分钟以内的。
            });
          }
          if (!isTopFrame) {
            const face = parseAutofillDockInstruction(reply);
            frameOwnsDock = face !== null && face.kind !== 'HIDDEN';
            if (!frameOwnsDock) { dockHandle?.dismiss(); dockHandle = null; }
          }
          // 此刻登录的是谁（2026-10-04）：换了人，先把上一个人的东西全丢掉，再换脸（脸没变也照样按新的人重读）。
          const switched = observeSession((reply as { session?: unknown } | null | undefined)?.session);
          // This accepted reply may itself retire the previous owner. Its own
          // rendering failure still needs a diagnostic; older transport errors do not.
          acceptedGeneration = helloGeneration;
          showFace(reply);
          if (switched) afterSessionChange();
          // 重问按后台的回答判：HIDDEN（这一页什么都不挂）是结论，不重问；只有没答上来才是 null（2026-10-03）。
          scheduleFaceRetry(parseDockFaceReply(reply));
        })
        .catch((error: unknown) => {
          if (acceptedGeneration !== helloGeneration || request !== helloRequest) return;
          // SW 未醒/通道抖动：报到失败只影响 tab 定位，不留任何状态。
          // 但这一页上还没有脸，所以照样再问一次——一次抖动不该让插件永久消失。
          // 答上来之后才抛的（挂浮层那一段的错）记一个码，只有类名。
          if (answered) reportDockError('APPLY_HELLO_THREW', error);
          scheduleFaceRetry(null);
        });
    };
    /**
     * 取不到规则就隔一会儿再要一张脸。
     *
     * 判据全在 `nextFaceRetryDelayMs`：只有 `RULES_UNAVAILABLE` 与「后台没答上来」
     * 会重问，其余每一张脸都是关于这一页的结论，不会自己变。
     *
     * 重试不放松任何一道闸——每一次都是重新向后台要，同一条消息、同一段计算、
     * 同样 fail closed。问完还是取不到，就停在那张脸上：那时它是真话。
     */
    const scheduleFaceRetry = (face: AutofillAffordance | null): void => {
      if (faceRetryTimer !== null) { clearTimeout(faceRetryTimer); faceRetryTimer = null; }
      const delay = nextFaceRetryDelayMs(face, faceRetryAttempt);
      if (delay === null) { faceRetryAttempt = 0; return; }
      faceRetryAttempt += 1;
      faceRetryTimer = setTimeout(() => {
        faceRetryTimer = null;
        // 节流窗按真实时间算，退避第一档已经长过它（`dock-face-rules-retry` 钉着）。
        void hello();
      }, delay);
    };
    void hello();
    /**
     * 证据多了就重新报到（2026-09-24）。注入在文档刚开始时，那时页面是空的；表单常常要等脚本画出来，
     * 或者等用户在页面上点一下「Apply」才出现。所以文档就绪、加载完、之后几秒各看一眼，用户在页面上点过
     * 之后再看两眼（已经认出表就不再为点击看）。证据没变什么都不发。
     */
    const recheckEvidence = (): void => {
      if (pageEvidence?.refresh() !== true) return;
      lastHelloAt = 0;
      evidenceJustRead = true;
      try {
        void hello();
      } finally {
        evidenceJustRead = false;
      }
    };
    const recheckEvidenceLater = (): void => {
      for (const delayMs of [1500, 4000, 10000]) setTimeout(recheckEvidence, delayMs);
    };
    if (pageEvidence !== null) {
      afterRulesInstalled.run = recheckEvidence;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', recheckEvidence, { once: true });
      if (document.readyState === 'complete') recheckEvidenceLater();
      else window.addEventListener('load', () => { recheckEvidence(); recheckEvidenceLater(); }, { once: true });
      let clickRecheckPending = false;
      document.addEventListener('click', () => {
        if (clickRecheckPending || pageEvidence.hasJobForm()) return;
        clickRecheckPending = true;
        setTimeout(recheckEvidence, 800);
        setTimeout(() => { clickRecheckPending = false; recheckEvidence(); }, 2500);
      }, { capture: true, passive: true });
    }
    // Choosing the job in the portal and coming back is the ordinary order of
    // things. This build gets no push from the portal, so the page asks again
    // when the user returns to it — the answer is a live lookup either way.
    window.addEventListener('focus', hello);
    window.addEventListener('pageshow', hello);
    /**
     * 离开、回来（2026-10-04，门户里改的资料别旧着用）：标签页藏起来、或整个窗口失去焦点（并排的门户窗口、别的程序）算离开——焦点
     * 只是进了这一页里的 iframe 不算（那时 document.hasFocus() 还是 true）。回来的那一刻：离开之前取的预取作废、在后台重取（手势路
     * 那几张脸），头像名字跟着更新；资料页开着就在后台再对一次。多半在按下去之前就到手了。
     */
    // 浮层挂不出来的构建（Assistant 接管）里没有预取、没有资料页：不挂这几个监听，这一段连同它拉进来的浮层文案整个删掉。
    if (!assistant) {
      const cameBack = (): void => {
        if (!away) return;
        away = false;
        presence += 1;
        profileWarm = null;
        resumeWarm = null;
        const key = dockHandle?.faceKey();
        if (key === 'READY' || key === 'UNAVAILABLE:NO_MISSION') { warmProfile(); void refreshAccount(); }
        dockHandle?.revalidateProfile();
      };
      // visibilitychange 从 document 冒泡到 window：挂在 window 上（授权前不往宿主 document 上挂任何东西）。
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') away = true;
        else cameBack();
      });
      // 只看顶层帧的失焦：子帧（嵌在公司官网里的申请表）每次他点一下外面的页面都会失焦，那不是离开。
      if (isTopFrame) {
        window.addEventListener('blur', () => {
          // 失去焦点的那一拍 hasFocus 还没换过来：等一拍再看焦点是离开了这一页，还是只进了页面里的 iframe。
          setTimeout(() => { if (!document.hasFocus()) away = true; }, 0);
        });
      }
      window.addEventListener('focus', cameBack);
      window.addEventListener('pageshow', (event) => { if (event.persisted) cameBack(); });
    }
    // 站内换路径（2026-09-24）：Rippling 岗位页点「Apply now」、Workday 从岗位页进 applyManually 都是
    // pushState 换页，没有 load／focus。路径一变就重新报到换脸，不等用户切走再切回来。
    onSamePagePathChange(window, () => {
      lastHelloAt = 0;
      void hello();
      // 换了路径就是另一页：新一页的表单同样要等它画出来。
      if (pageEvidence !== null) recheckEvidenceLater();
    });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== KERNEL_BRIDGE_PORT_NAME) return;
      handleKernelBridgePort(port as unknown as BridgePortLike, {
        discover: async (authorization) => {
          try {
            const resolved = await resolveStoredDiscoveryRuntimeAuthority({
              stored: await readStoredRuntimeBundle(),
              authorization,
              nowMs: Date.now(),
              extensionVersion: browser.runtime.getManifest().version,
            });
            if (!resolved.ok) return null;
            const outcome = await scanCurrentPageWithDiscoveryAuthority(
              resolved.value,
              document,
              location,
              {
                isTopFrame,
                embedded: !isTopFrame,
                ...pageLane(),
                openShadowRoot: openVerifiedHostShadowRoot,
              },
            );
            const scan = outcome.scan;
            return scan !== null &&
              isCurrentScanTarget(scan) &&
              isRuntimeDeadlineCurrent(scan)
              ? scan
              : null;
          } catch {
            return null;
          }
        },
        isCurrentScanTarget,
        isScanFresh: (scan) => {
          let fresh = activeScan === scan &&
            activeMutationPolicy !== null &&
            isRuntimeDeadlineCurrent(scan);
          if (fresh) {
            try {
              fresh = activeMutationPolicy!.isCurrent();
            } catch {
              fresh = false;
            }
          }
          if (!fresh && activeScan === scan) retireActiveScan(true);
          return fresh;
        },
        revalidateScan: async (scan, authorization) => {
          const attemptRevision = ++scanAttemptRevision;
          const pendingSlot: { value: PendingScanMutationGuard | null } = { value: null };
          // Keep the bridge's retained object long enough for its compare-and-
          // swap, but stop every write while the refreshed scan is unresolved.
          // If submission was armed, its old listener remains installed as a
          // fail-closed blocker and its review state is revoked.
          const suspendedSubmission = suspendActiveScanForRevalidation(scan);
          if (
            !authorization ||
            location.origin !== scan.canonicalOrigin ||
            location.pathname !== scan.jobId
          ) {
            disposeSuspendedSubmissionArm(suspendedSubmission);
            return null;
          }
          if (attemptRevision !== scanAttemptRevision) {
            disposeSuspendedSubmissionArm(suspendedSubmission);
            return null;
          }
          let refreshed: Awaited<ReturnType<typeof scanWithAuthorizedRuntime>>;
          try {
            refreshed = await scanWithAuthorizedRuntime(authorization, {
              isTopFrame,
              embedded: !isTopFrame,
              ...pageLane(),
              openShadowRoot: openVerifiedHostShadowRoot,
              armMutationGuard: (policy) => {
                if (pendingSlot.value !== null) return null;
                pendingSlot.value = createPendingScanMutationGuard(policy);
                return pendingSlot.value;
              },
            });
          } catch {
            disposeSuspendedSubmissionArm(suspendedSubmission);
            return null;
          }
          const pending = pendingSlot.value;
          if (
            attemptRevision !== scanAttemptRevision ||
            !refreshed?.scan ||
            pending === null
          ) {
            pending?.dispose();
            disposeSuspendedSubmissionArm(suspendedSubmission);
            return null;
          }
          const candidateScan = refreshed.scan;
          let disposed = false;
          return {
            scan: candidateScan,
            activate: () => {
              if (disposed || attemptRevision !== scanAttemptRevision) {
                pending.dispose();
                disposeSuspendedSubmissionArm(suspendedSubmission);
                disposed = true;
                return false;
              }
              const activated = activateScanMutationGuard(candidateScan, pending);
              if (!activated) {
                disposeSuspendedSubmissionArm(suspendedSubmission);
                disposed = true;
                return false;
              }
              if (
                suspendedSubmission !== null &&
                !installSubmissionGate(
                  suspendedSubmission.descriptor,
                  candidateScan,
                  suspendedSubmission.purpose,
                )
              ) {
                disposed = true;
                retireActiveScan(true);
                return false;
              }
              disposed = true;
              return true;
            },
            dispose: () => {
              if (disposed) return;
              disposed = true;
              pending.dispose();
              disposeSuspendedSubmissionArm(suspendedSubmission);
            },
          };
        },
        armSubmission: (descriptor, scan) =>
          scan.runtimeAuthorization?.purpose !== 'DISCOVERY' &&
          installSubmissionGate(descriptor, scan, 'submission-boundary'),
        scan: async (authorization) => {
          const attemptRevision = ++scanAttemptRevision;
          const pendingSlot: { value: PendingScanMutationGuard | null } = { value: null };
          // Every explicit scan attempt retires the previous observer first.
          // An unverifiable attempt returns null and leaves no observer armed.
          retireActiveScan(true);
          if (!authorization) return null;
          if (attemptRevision !== scanAttemptRevision) return null;
          const outcome = await scanWithAuthorizedRuntime(authorization, {
            isTopFrame,
            embedded: !isTopFrame,
            ...pageLane(),
            openShadowRoot: openVerifiedHostShadowRoot,
            armMutationGuard: (policy) => {
              if (pendingSlot.value !== null) return null;
              pendingSlot.value = createPendingScanMutationGuard(policy);
              return pendingSlot.value;
            },
          });
          if (outcome === null) return null;
          const pending = pendingSlot.value;
          if (attemptRevision !== scanAttemptRevision) {
            pending?.dispose();
            return null;
          }
          const scan = noticeForRescan(outcome);
          if (!scan || pending === null) {
            pending?.dispose();
            return null;
          }
          // Mutation freshness is part of this scan's local safety envelope.
          // If its verified roots cannot be observed, do not issue a usable scan.
          if (!activateScanMutationGuard(scan, pending)) return null;
          return scan;
        },
        fill: async (input) => {
          const fillReviewRevision = ++fillAttemptRevision;
          if (submissionArmBinding?.scan === input.scan) {
            submissionGate?.revokeFinalReview();
          }
          const authorization = input.runtimeAuthorization;
          const runtime = authorization
            ? await resolveExecutionRuntime(authorization)
            : null;
          if (
            runtime === null ||
            !input.grant.allowedActions.every((action) =>
              runtime.allowedActions.includes(action)) ||
            !input.grant.fieldKeys.every((key) =>
              runtime.allowedFieldKeys.includes(key))
          ) {
            const outcomes = input.grant.fieldKeys.map((key) => ({
              key,
              ok: false as const,
              reason: 'POLICY_DISABLED' as const,
            }));
            for (const outcome of outcomes) input.progress.onOutcome(outcome);
            // Nothing was written and no field will report itself; say why on
            // the dock, or the user watches a run "finish" with nothing to show.
            dockHandle?.reportBlocked('POLICY_DISABLED');
            return outcomes;
          }
          let mutationCurrent = false;
          try {
            mutationCurrent = activeMutationPolicy?.isCurrent() === true;
          } catch {
            mutationCurrent = false;
          }
          if (
            activeScan !== input.scan ||
            !isCurrentScanTarget(input.scan) ||
            !isRuntimeDeadlineCurrent(input.scan) ||
            !mutationCurrent
          ) {
            if (activeScan === input.scan && !mutationCurrent) retireActiveScan(true);
            const outcomes = input.grant.fieldKeys.map((key) => ({
              key,
              ok: false as const,
              reason: 'DETACHED' as const,
            }));
            for (const outcome of outcomes) input.progress.onOutcome(outcome);
            dockHandle?.reportBlocked('DETACHED');
            return outcomes;
          }
          const effectivePolicy = enforceHostSubmissionContainmentPolicy(runtime.policy, {
            origin: location.origin,
            pathname: location.pathname,
          });
          // Every run that can actually write, including a FILL-only grant, must have the
          // document_start blocker bound before the first host event. Without a
          // SUBMIT authority the descriptor is a temporary tombstone: it
          // blocks requestSubmit/native-submit side effects and cannot expose a
          // review-confirm path. A policy-disabled run produces no value/event
          // write, so installing a blocker would only steal the user's native
          // Submit. A temporary blocker is disposed as soon as its write window
          // closes; only a separately armed submission boundary may persist.
          let temporaryFillGate: SubmissionGestureGate | null = null;
          if (
            effectivePolicy.enabled &&
            submissionArmBinding?.scan !== input.scan &&
            !installSubmissionGate({ mode: 'BLOCKED' }, input.scan, 'fill-window')
          ) {
            const outcomes = input.grant.fieldKeys.map((key) => ({
              key,
              ok: false as const,
              reason: 'POLICY_DISABLED' as const,
            }));
            for (const outcome of outcomes) input.progress.onOutcome(outcome);
            return outcomes;
          }
          if (submissionArmBinding?.scan === input.scan &&
              submissionArmBinding.purpose === 'fill-window') {
            temporaryFillGate = submissionGate;
          }
          const fillEpoch = activeScanEpoch;
          const fillMutationPolicy = activeMutationPolicy;
          const controller = new AbortController();
          activeFillControllers.set(controller, input.scan);
          // 逐字段审计面板（CAP-AF-063）取代了原先只有一个计数的轻确认条：
          // 档位 L1 停在提交前，而"停在提交前"要有意义，用户必须能在这一刻看清
          // 我们到底改了哪几栏、还有哪几栏等着他。
          //
          // 宿主已提交的 run 不弹——那时"请核对后自行提交"与事实相反，
          // 而一份已经递出去的申请也没有可复核的下一步。
          const captured: KernelFillAudit[] = [];
          // 中段屏与终局屏是同一张单子（CAP-AF-063）：这一轮开跑那一下认领它，
          // 之后每结算一栏只是刷新同一张。run id 取这一轮自己的号，不取那个还会
          // 继续涨的计数器——否则第二次 Fill 一开始，第一轮的终局就会挂着第二轮的
          // 号落到用户正在看的那张单子上。
          const runId = `fill-${fillReviewRevision}`;
          let sheetClaimed = false;
          const showProgress = (view: AuditView, live?: KernelFillLive) => {
            // 途中的进度带着「正在写 / 已写入」；收尾那一次（没有 live）才是终局。
            const progress = live === undefined ? dockProgressFromAudit(runId, view, dockLocale()) : dockProgressWhileFilling(runId, view, live, dockLocale());
            if (sheetClaimed) dockHandle?.update(progress);
            else {
              sheetClaimed = true;
              dockHandle?.beginRun(progress);
            }
          };
          let outcomes: Awaited<ReturnType<typeof fillFromGrant>>;
          try {
            outcomes = await fillFromGrant({
              ...input,
              policy: effectivePolicy,
              signal: controller.signal,
              scanStillCurrent: () => {
                let current = activeScan === input.scan &&
                  activeScanEpoch === fillEpoch &&
                  activeMutationPolicy === fillMutationPolicy &&
                  fillMutationPolicy !== null &&
                  isCurrentScanTarget(input.scan) &&
                  isRuntimeDeadlineCurrent(input.scan);
                if (current && fillMutationPolicy !== null) {
                  try {
                    current = fillMutationPolicy.isExecutionCurrent();
                  } catch {
                    current = false;
                  }
                }
                if (!current && activeScan === input.scan) retireActiveScan(true);
                return current;
              },
              // 逐栏亮起来的那份进度只走本地：它带着宿主标签，与审计视图同边界，
              // 不过桥、不进回执、不进遥测。回执那一侧仍然只有 key/ok/原因码。
              onProgress: showProgress,
              progress: {
                ...input.progress,
                // Kernel checks this before the synchronous write pass and at
                // every stop checkpoint. DOM mutation invalidates the exact
                // generation and aborts the signal immediately.
                shouldStop: () =>
                  input.progress.shouldStop() ||
                  activeScan !== input.scan ||
                  activeScanEpoch !== fillEpoch ||
                  !isCurrentScanTarget(input.scan) ||
                  !isRuntimeDeadlineCurrent(input.scan),
              },
              // 已获批复用的记忆答案（PRODUCT-AUTHORITY §3 Reuse）。题干与选项只在这里
              // 上行到后台、再由后台发到第一方 API——与审阅面板同一条路，同一条纪律。
              // 只接受**用户自己记住的答案**支撑的候选；AI 生成的候选照旧走审阅面板。
              resolveRememberedAnswers: async (questions) => {
                const reply = (await browser.runtime
                  .sendMessage({
                    kind: 'application-question/candidates',
                    missionId: input.grant.missionId,
                    pageId: input.scan.scanDigest,
                    pageGeneration: String(fillAttemptRevision + 1),
                    questions: questions.map((entry) => entry.question),
                  })
                  .catch(() => null)) as { ok?: unknown; result?: unknown } | null;
                if (reply?.ok !== true) return [];
                const result = reply.result as {
                  ok?: unknown;
                  candidates?: readonly Readonly<{
                    questionId: string;
                    answer:
                      | Readonly<{ kind: 'TEXT'; text: string; optionIds?: undefined }>
                      | Readonly<{ kind: 'CHOICES'; optionIds: readonly string[]; text?: undefined }>
                      | null;
                    provenance: readonly Readonly<{ source: string }>[];
                  }>[];
                } | null;
                const candidates = result?.ok === true ? result.candidates : undefined;
                if (candidates === undefined) return [];
                return candidates.flatMap((candidate) => {
                  const asked = questions.find((entry) => entry.questionId === candidate.questionId);
                  if (!asked || !candidate.answer || candidate.provenance.length === 0) return [];
                  if (!candidate.provenance.every((item) => item.source === 'CONFIRMED_ANSWER')) return [];
                  const value =
                    candidate.answer.kind === 'TEXT'
                      ? candidate.answer.text
                      : (asked.question.options.find(
                          (option) => option.optionId === candidate.answer?.optionIds?.[0],
                        )?.text ?? '');
                  return value ? [{ questionId: asked.questionId, value }] : [];
                });
              },
              onAudit: (value) => captured.push(value),
            });
          } finally {
            activeFillControllers.delete(controller);
            if (
              temporaryFillGate !== null &&
              submissionGate === temporaryFillGate &&
              submissionArmBinding?.scan === input.scan &&
              submissionArmBinding.purpose === 'fill-window'
            ) {
              submissionGate = null;
              submissionArmBinding = null;
              temporaryFillGate.dispose();
            }
          }
          const hostSubmitted = outcomes.some((outcome) => outcome.reason === 'HOST_SUBMITTED');
          const audit = captured[0];
          const reviewGate = !hostSubmitted && submissionArmBinding?.scan === input.scan
            ? submissionGate
            : null;
          const reviewScanEpoch = activeScanEpoch;
          const isExactReviewGeneration = () =>
            reviewGate !== null &&
            submissionGate === reviewGate &&
            submissionArmBinding?.scan === input.scan &&
            activeScan === input.scan &&
            activeScanEpoch === reviewScanEpoch &&
            isRuntimeDeadlineCurrent(input.scan) &&
            fillAttemptRevision === fillReviewRevision;
          // A submission abort cannot hide the only explicit Undo surface
          // while a transaction still owns reversible host residue.
          if (audit && (!hostSubmitted || audit.canUndo())) {
            const consentResponse = await browser.runtime.sendMessage({ kind: 'trust-telemetry/get-consent' }).catch(() => null) as { enabled?: unknown } | null;
            const telemetrySupported = supportsTrustTelemetryVendor(input.scan.descriptor.vendor);
            // 扫描期展不开的 combobox 题在这里补上它自己的选项：后台按 Mission 取这份
            // value-free 的表单 schema（§4.16），取不到就保持扫描时的样子。
            const scannedQuestions = audit.questions ?? [];
            const schemaReply = scannedQuestions.length === 0 ? null
              : await browser.runtime.sendMessage({ kind: 'application-question/schema', missionId: input.grant.missionId })
                .catch(() => null) as { ok?: unknown; schema?: unknown } | null;
            const reviewQuestions = withSchemaOptions(
              scannedQuestions,
              schemaReply?.ok === true ? parseApplicationQuestionSchemaV1(schemaReply.schema) : null,
            );
            // The dock shows the same audit the panel does. One source, so the
            // two surfaces can never disagree about how much of this application
            // is done; the fill attempt identifies the run so a later fill on the
            // same page cannot land on the previous run's sheet.
            showProgress(audit.view);
            // The dock folds the audit's controls under the rows it is already
            // showing; a page without a dock (or a dock that cannot take an
            // audit) gets the standalone panel it always had.
            const showAudit = dockHandle?.showAudit === undefined
              ? showAuditPanel
              : dockHandle.showAudit.bind(dockHandle);
            const panel = showAudit(audit.view, {
              canUndo: audit.canUndo,
              canConfirmFinalReview: () =>
                isExactReviewGeneration() &&
                reviewGate !== null &&
                reviewGate.canConfirmFinalReview(),
              confirmFinalReview: (event, shadowRoot) =>
                isExactReviewGeneration() && reviewGate !== null
                  ? reviewGate.confirmFinalReview(event, shadowRoot)
                  : Promise.resolve(false),
              subscribeFinalReviewState: (listener) =>
                isExactReviewGeneration() && reviewGate !== null
                  ? reviewGate.onFinalReviewStateChange(listener)
                  : () => {},
              subscribeSubmissionState: (listener) =>
                isExactReviewGeneration() && reviewGate !== null
                  ? reviewGate.onStateChange(listener)
                  : () => {},
              onDismiss: () => {
                if (!isExactReviewGeneration() || reviewGate === null) return;
                fillAttemptRevision += 1;
                retireActiveScan(true);
              },
              undoAll: async (event, shadowRoot) => {
                if (isExactReviewGeneration() && reviewGate !== null) {
                  reviewGate.revokeFinalReview();
                }
                fillAttemptRevision += 1;
                await audit.undoAll(event, shadowRoot);
                // Failed/uncertain restoration must retain the explicit Undo
                // surface; a pending readback is not a completed restoration.
                if (!audit.canUndo()) panel.dismiss();
              },
              questions: reviewQuestions.length === 0 ? undefined : (() => {
                // 题干与选项只在此处上行到后台，再由后台按 §3 发到第一方 API；上下文由后台组装。
                const page = { missionId: input.grant.missionId, pageId: input.scan.scanDigest, pageGeneration: String(fillAttemptRevision + 1) };
                const ask = (kind: string, payload: Record<string, unknown> = {}) =>
                  browser.runtime.sendMessage({ kind, ...payload }).catch(() => null) as Promise<Record<string, unknown> | null>;
                return {
                  questions: reviewQuestions,
                  loadSettings: async () => { const reply = await ask('application-question/settings-get'); return reply?.ok === true ? reply.settings as never : null; },
                  updateSettings: async (update) => { const reply = await ask('application-question/settings-update', { update }); return reply?.ok === true ? reply.settings as never : null; },
                  // 上行的只有契约那五个字段；fieldName 是本地的连接用信息，不进 wire。
                  fetchCandidates: async (questions) => {
                    const packet = questions.map(({ questionId, text, controlType, required, options }) => ({ questionId, text, controlType, required, options }));
                    const reply = await ask('application-question/candidates', { ...page, questions: packet });
                    return reply?.ok === true ? reply.result as never : null;
                  },
                  // 补答只对面板所属的那一代审阅有效。这里**不能**先 await 再把事件交给
                  // kernel：派发一结束 composedPath() 就空了，真实点击会被判成外来手势。
                  // 手势取证由 audit.answer 同步完成，之后才执行这里交上去的服务端再确认：
                  // 功能仍开启、候选生成时的 Mission／target／bundle 仍是当前的、审阅代未变。
                  answer: (event, shadowRoot, answers, context) => {
                    const refuse = (reason: 'IDENTITY_CHANGED') =>
                      answers.map((answer) => ({ key: `question:${answer.questionId}` as const, label: '', ok: false as const, reason }));
                    if (!isExactReviewGeneration() || context === null) return Promise.resolve(refuse('IDENTITY_CHANGED'));
                    return audit.answer(event, shadowRoot, answers, async () => {
                      const reply = await ask('application-question/recheck', { ...page, context });
                      return reply?.ok === true && reply.current === true && isExactReviewGeneration();
                    });
                  },
                  remember: async ({ question, value, scope, answerClass, context }) => {
                    if (context === null) return false;
                    const identity = { text: question.text, controlType: question.controlType, optionTexts: question.options.map((option) => option.text) };
                    const answer = question.controlType === 'SINGLE_CHOICE' || question.controlType === 'MULTI_CHOICE'
                      ? { kind: 'CHOICES', optionTexts: value.split('\n') }
                      : { kind: 'TEXT', text: value };
                    const reply = await ask('application-question/remember', { ...page, context, question: identity, answer, scope, answerClass });
                    return reply?.ok === true;
                  },
                };
              })(),
              telemetryConsent: telemetrySupported && consentResponse?.enabled === true,
              onTelemetryConsentChange: telemetrySupported ? async (enabled) => {
                const response = await browser.runtime.sendMessage({ kind: 'trust-telemetry/set-consent', enabled }).catch(() => null) as { ok?: unknown; code?: unknown } | null;
                if (response?.ok === true) return enabled ? 'UPDATED' : 'CLEARED';
                return response?.code === 'TELEMETRY_PROVIDER_DELETE_PENDING'
                  ? 'PROVIDER_DELETE_PENDING'
                  : 'LOCAL_CLEAR_FAILED';
              } : undefined,
              onReportStructure: telemetrySupported ? async () => {
                const rulesetVersion = input.scan.runtimeAuthorization?.rulesetVersion;
                if (!rulesetVersion) return 'FAILED';
                const event = buildStructureReportDraft(
                  input.scan.descriptor,
                  outcomes,
                  rulesetVersion,
                  frameDepthBucket(),
                );
                if (!event) return 'FAILED';
                const response = await browser.runtime.sendMessage({ kind: 'trust-telemetry/report-structure', event }).catch(() => null) as { status?: unknown; event?: unknown } | null;
                if (response?.status === 'ACCEPTED') return 'ACCEPTED';
                if (response?.status === 'COPY_AVAILABLE' && response.event) {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(response.event, null, 2));
                    return 'COPIED';
                  } catch {
                    return 'FAILED';
                  }
                }
                return 'FAILED';
              } : undefined,
              recentDiagnostics,
              onClearDiagnostics: async () => {
                const response = await browser.runtime.sendMessage({ kind: 'trust-telemetry/clear' }).catch(() => null) as { ok?: unknown; code?: unknown } | null;
                if (response?.ok === true) return 'CLEARED';
                return response?.code === 'TELEMETRY_PROVIDER_DELETE_PENDING'
                  ? 'PROVIDER_DELETE_PENDING'
                  : 'LOCAL_CLEAR_FAILED';
              },
            });
            // 整轮之后再问几次「我们填的还在不在」。内核那 250 毫秒的窗口是照着
            // 受控框架重渲染量的，挡不住**简历解析**那种服务端往返的宿主回写
            // （2026-09-22 Lever 实测约十二秒才把填好的地点清空）。窗口一关就不再
            // 问，那句「已填」会一直挂在这两张面上——不是没填上，是我们说了谎。
            //
            // 两张面一起换：中段屏的计数与审计面板在调用点是可互换的两个显示口，
            // 对同一轮永远不能给出不同说法。面板被拆或这一轮被后一轮顶掉（两者都
            // 会让 `isExactReviewGeneration()` 转假）就停下。
            startLateRecheck({
              current: audit.view,
              recheck: audit.recheck,
              apply: (view) => { showProgress(view); panel.update(view); },
              stopped: () => !isExactReviewGeneration(),
            });
          }
          const executionEvent = buildExecutionTelemetryDraft(input.scan.descriptor, outcomes);
          if (executionEvent) {
            void browser.runtime.sendMessage({
              kind: 'trust-telemetry/capture-execution',
              event: executionEvent,
            }).catch(() => null);
          }
          return outcomes;
        },
      });
    });
    if (assistant) markAssistantExecutorReady();
    } catch (error) {
      if (assistant) { markAssistantExecutorFailed(); return; }
      // 起来的那一段就抛了：这一页上浮层多半挂不出来。记一个码（只有类名，2026-10-04 体检 11-2），照旧抛出。
      reportMainThrew(error);
      throw error;
    }
  },
});
