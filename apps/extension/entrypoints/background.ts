import { PRODUCTION_API_BASE, PRODUCTION_WEB_APP_BASE } from '../lib/deploymentConfig';
/**
 * 扩展后台（MV3 service worker）：通道的扩展侧端点。
 *
 * chat 页经 externally_connectable 的 runtime.connect 连进来（manifest 已把
 * 可连 origin 收窄到门户），每个连接配一个运行协调器；端口断开 →
 * dispose → 进行中的运行停在下一检查点（断连 fail-closed，绝不半途提交）。
 *
 * 接线进度：
 *  - acquirer/claimer = 真实现（intentClient）；scanner/filler = 真实现
 *    （tabBridge → 内容脚本 kernel 链）；token/用户 id/install id =
 *    真实现（authClient，登录态经 §2.3 交接进扩展，刀八）。
 *  - 仍是桩的只剩 profile 取数（对齐清单⑦：等后端定档案读端点）——
 *    未登录或未定端点时 run 停在 INTENT_REJECTED / 全字段 NO_VALUE，
 *    路径是真的，闸是关的。
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  createDiscoveryCoordinator,
  createExtensionHandshakeCoordinator,
  createPortTransport,
  createRunCoordinator,
  type RuntimePortLike,
} from '@edaix/agent-channel';
import { createIntentClient } from '../lib/intentClient';
import { createTabKernelBridge, type TabBridgeDeps } from '../lib/tabBridge';
import { createAssistantExecutorInstaller, ASSISTANT_EXECUTOR_FILE, readAssistantExecutorState } from '../assistant/features/autofill/executor-installation';
import { createAssistantRunAdapter } from '../assistant/features/autofill/run-adapter';
import { createReceiptUploader, uploadDockReceipt } from '../lib/receiptClient';
import { createAuthClient, type AuthKeyValueStore } from '../lib/authClient';
import { createAuthHandoffHandler, normalizeAuthMessageKind } from '../lib/authHandoff';
import {
  isAllowedPortalSender,
  resolvePortalSenderOrigin,
} from '../lib/portalSenderRealm';
import { createProfileProvider } from '../lib/profileClient';
import { DEADLINE_PASSED, PROFILE_REPLY_BUDGET_MS, withDeadline } from '../lib/deadline';
import { createSessionStamp } from '../lib/sessionStamp';
import {
  frameFormForSender,
  isChildFrameId,
  parseBridgeFrameForm,
  parseFrameFormRegistry,
  recordFrameForm,
  removeFrameForm,
  type FrameFormRegistry,
} from '../lib/frameFormRegistry';
import { applicationFormUrl, parseDockOpenApplicationFormIntent } from '../lib/openApplicationFormIntent';
import { isDockConsentGateChosen, isDockConsentGateSettled } from '../lib/consentGateNote';
import { createQuestionDraftClient } from '../lib/questionDraftClient';
import { parseDockQuestionDraftIntent, type DockQuestionDraftReply } from '../lib/questionDraftIntent';
import { createQuestionDraftProvider } from '../lib/questionDraftProvider';
import { createAiAnswersClient } from '../lib/aiAnswersClient';
import {
  AI_ANSWERS_STREAM_PORT,
  parseDockAiAnswersIntent,
  type DockAiAnswersReply,
  type DockAiStreamMessage,
} from '../lib/aiAnswersIntent';
import { createAiAnswersProvider } from '../lib/aiAnswersProvider';
import { KERNEL_BRIDGE_PORT_NAME, type BridgePortLike } from '../lib/bridgeProtocol';
import {
  createTrustTelemetryClient,
  createTrustTelemetryHttpTransport,
  trustTelemetryErrorCode,
  type TrustTelemetryClient,
} from '../lib/trustTelemetryClient';
import { createSubmissionBoundaryClient } from '../lib/submissionBoundaryClient';
import {
  createSubmissionBoundaryRuntime,
  type SubmissionBoundaryPersistence,
} from '../lib/submissionBoundaryRuntime';
import { parseSubmissionRuntimeMessage } from '../lib/submissionBoundaryProtocol';
import { createMissionSubmissionAuthorityClient } from '../lib/missionSubmissionAuthorityClient';
import { createExecutionRuntimeBundleClient } from '../lib/executionRuntimeBundleClient';
import { createRuntimeRulesInstaller, type RuntimeRulesInstaller } from '../lib/runtimeRulesInstaller';
import { APPLICATION_PROFILE_FIELD_KEYS, describeExecutionRuntimeBundleNoticesV1 } from '@edaix/contracts';
import { detectApplyVendor } from '@edaix/apply-kernel/vendors';
import { declaresAccountSteps, hasApplyAdapter, isAccountFormPath, isApplyFormPath } from '@edaix/apply-kernel/registry';
import { isApplyPolicyEnabled } from '@edaix/apply-kernel/policy';
import type { ApplyVendor } from '@edaix/apply-kernel/vendors';
import { installApplyAdaptersFromRules } from '../lib/executionRuntimeAuthority';
import { createExecutionRuntimeBundleStore } from '../lib/executionRuntimeBundleStore';
import { bundleOpenVendors, createBackgroundExecutionRuntimeAuthority } from '../lib/executionRuntimeAuthority';
import { createAccountVault, createIndexedDbVaultKeyStore } from '../lib/accountVault';
import { createAccountAccessProvider, createAccountAccessOperationStore } from '../lib/accountAccessProvider';
import { createAccountVaultLifecycle } from '../lib/accountVaultLifecycle';
import { createAccountVaultMessageRouter } from '../lib/accountVaultMessageRouter';
import { parseDockAccountAccessIntent, type DockAccountAccessReply } from '../lib/accountAccessIntent';
import { createMissionApplicationTargetClient } from '../lib/missionApplicationTargetClient';
import { createMissionMaterialsClient } from '../lib/missionMaterialsClient';
import { createMissionDockClient } from '../lib/missionDockClient';
import { createDockMissionRuns } from '../lib/dockMissionRuns';
import { createDockMissionWorker, createTabMissionBindings } from '../lib/dockMissionWorker';
import { dockFaceForPage, frameFormFace, pageVendor, recognisedApplyFormPage } from '../lib/autofillDockDecision';
import { isDirectoryCachedRequest, parseDirectoryRequest } from '../lib/directoryRequest';
import { createProfileDirectoryCache } from '../lib/profileDirectoryCache';
import { createSerialSessionRecord } from '../lib/serialSessionRecord';
import { createProfileDirectoryTransport } from '../lib/profileDirectoryTransport';
import { createMissionPageBindingClient } from '../lib/missionPageBindingClient';
import { parseDockAddJobIntent } from '../lib/dockAddJobIntent';
import { parseDockApplyMaterialsIntent, type DockApplyMaterialsReply } from '../lib/applyMaterialsIntent';
import { createApplyMaterialsClient } from '../lib/applyMaterialsClient';
import { senderTabForPageOrFrame } from '../lib/senderPage';
import { createProfileCollectionsProvider } from '../lib/profileCollectionsProvider';
import { createEeoAnswersProvider } from '../lib/eeoAnswersProvider';
import { createSigningConsentProvider, signingConsentCoversAccountRegistration } from '../lib/signingConsentProvider';
import { createResumeAttachmentClient } from '../lib/resumeAttachmentClient';
import { parseDockResumeAttachmentIntent, type DockResumeAttachmentReply } from '../lib/resumeAttachmentIntent';
import { parseDockCoverLetterIntent, type DockCoverLetterReply } from '../lib/coverLetterIntent';
import { createCoverLetterAttachmentClient } from '../lib/coverLetterAttachmentClient';
import { createCoverLetterProvider } from '../lib/coverLetterProvider';
import { createResumeAttachmentProvider } from '../lib/resumeAttachmentProvider';
import { createAnswerMemoryClient } from '../lib/answerMemoryClient';
import { parseDockAnswerMemoryIntent, type DockAnswerMemoryReply } from '../lib/answerMemoryIntent';
import { createAnswerMemoryProvider } from '../lib/answerMemoryProvider';
import { DOCK_PORTAL_PATHS, parseDockPortalIntent } from '../lib/dockPortalIntent';
import { parseDockSignOutIntent } from '../lib/dockSignOutIntent';
import { arrivesAfterSubmit, isDockSubmitPressed, isDockSubmitSettled, type SubmittedTabMark } from '../lib/dockSubmitPressed';
import { DOCK_SESSION_CHANGED } from '../lib/dockSessionChanged';
import { DOCK_PROFILE_CHANGED } from '../lib/dockProfileChanged';
import { errorClassOf, parseDockDiagnostic } from '../lib/dockDiagnostic';
import { createDockRunOutcome, parseDockRunOutcome, type RunOutcomeEvent } from '../lib/runOutcome';
import { portalConnectUrl } from '../lib/portalConnectUrl';
import {
  FIRST_RUN_CONNECT_TAB_KEY,
  firstRunConnectTab,
  landingAfterConnect,
  parseFirstRunConnectTab,
  shouldOpenConnectOnInstall,
  type FirstRunConnectTab,
} from '../lib/firstRunConnect';
import { createJobIntakeClient } from '../lib/jobIntakeClient';
import { createApplicationQuestionClient } from '../lib/applicationQuestionClient';
import { APPLICATION_QUESTION_MESSAGE_PREFIX, handleApplicationQuestionMessage } from '../lib/applicationQuestionMessages';
import { createExactTabDiscoveryScanner } from '../lib/discoveryScanner';
import {
  parseBridgeHello,
  parseTabRegistry,
  registerApplicationTab,
  registeredExactPage,
  removeApplicationTab,
  type ApplicationTabRegistry, type RegisteredApplicationTab } from '../lib/tabRegistry';
import { installPilotUa1ActionTrigger } from '../lib/pilotUa1DiscoveryRuntime';
import { createDiagnosticsUploader, workerFailureCode, type DiagnosticDetail } from '../lib/diagnosticsUploader';
import { installAssistantWorker } from '../assistant/runtime/worker';

// Build manifest and runtime share the new product deployment boundary.
const SUBMISSION_BOUNDARY_STORAGE_KEY = 't11SubmissionBoundaryStateV2';
const LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY = 't11SubmissionBoundaryStateV1';

/** worker 拒给这一页只读授权的那几种原因里，说的是「这一家没放行」的（2026-10-04）。 */
const VENDOR_CLOSED_CODES: ReadonlySet<string> = new Set([
  'DISCOVERY_GENERIC_UNAVAILABLE',
  'DISCOVERY_AUTHORITY_RUNTIME_AUTHORITY_POLICY_DISABLED',
]);

export default defineBackground(() => {
  if (
    typeof __VIBE_PILOT_UA1_DISCOVERY_ENABLED__ !== 'undefined' &&
    __VIBE_PILOT_UA1_DISCOVERY_ENABLED__
  ) {
    installPilotUa1ActionTrigger({
      enabled: true,
      action: browser.action,
      tabs: {
        onUpdated: {
          addListener: (listener) => browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
            listener(tabId, {
              status: changeInfo.status,
              urlChanged: typeof changeInfo.url === 'string',
            });
          }),
        },
        onRemoved: {
          addListener: (listener) => browser.tabs.onRemoved.addListener(listener),
        },
        get: async (tabId) => {
          const tab = await browser.tabs.get(tabId);
          return { id: tab.id, url: tab.url, status: tab.status };
        },
        sendMessage: (tabId, message, options) =>
          browser.tabs.sendMessage(tabId, message, options),
      },
    });
  }
  const apiBase = __VIBE_API_BASE__ ?? PRODUCTION_API_BASE;
  const allowedPortalOrigins = [
    PRODUCTION_WEB_APP_BASE,
    ...(__VIBE_WEB_BASE__ ? [__VIBE_WEB_BASE__] : []),
  ];
  // 浮层不挂在我们自己的门户与后端上（门户资料页那张表不是申请表）。按 origin 比，构建给的基址可能带路径。
  const ownPageOrigins = [...allowedPortalOrigins, apiBase].flatMap((base) => {
    try {
      return [new URL(base).origin];
    } catch {
      return [];
    }
  });

  const storageLocal: AuthKeyValueStore = {
    async get(key) {
      return (await browser.storage.local.get(key))[key];
    },
    async set(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await browser.storage.local.remove(key);
    },
  };
  let telemetryClient: TrustTelemetryClient | undefined;
  let assistantInvalidated = () => {};
  /** 换了账号：标签页记着的任务、任务的材料清单是上一个人的（2026-10-04；建好之后下面接上）。 */
  let missionCachesInvalidated = (): void => {};
  /**
   * 稳定原因码的环形缓冲（P0-3）。
   *
   * authClient / authHandoff / intentClient 都会报 `AUTH_REFRESH_FAILED`、
   * `HANDOFF_NO_PENDING_STATE` 这类码，此前 worker 一个都没接，全被丢掉——2026-09-18
   * 每一个难查的问题都难在这。只存码，不存任何值（RULE-GLOBAL-DATA-L1 允许的正是这个）。
   */
  const DIAGNOSTIC_RING_SIZE = 256;
  const diagnostics: string[] = [];
  /** 只进本机的环形缓冲与控制台（浮层「技术细节」、本机排查读它）。 */
  const remember = (code: string): void => {
    diagnostics.push(code);
    if (diagnostics.length > DIAGNOSTIC_RING_SIZE) diagnostics.shift();
    console.debug(`[argo] ${code}`);
  };
  // 同一批码也送后端（→ Loki）：环形缓冲随 worker 挂起就没了，线上排查看不到。
  // 2026-10-04（体检 11-3、11-5）：release 带上构建形态（`1.1.0+store`；指向生产的本机包从前也报 0.0.0）；
  // 待送的放在 storage.session（worker 挂起、重启不丢，有上限），送不出去退避重试。
  const TELEMETRY_QUEUE_KEY = 'telemetryQueueV1';
  // Assistant 构建里浮层挂不出来、没有手势路，不会有一轮的结局：解析器与那几张闭集表不进它的产物（编译期常量）。
  const takesRunOutcomes = !(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__);
  const diagnosticsUploader = createDiagnosticsUploader({
    apiBase,
    release: `${browser.runtime.getManifest().version}+${__VIBE_BUILD_FLAVOR__}`,
    store: {
      get: async () => (await browser.storage.session.get(TELEMETRY_QUEUE_KEY))[TELEMETRY_QUEUE_KEY],
      set: (value) => browser.storage.session.set({ [TELEMETRY_QUEUE_KEY]: value }),
    },
    onLocal: remember,
    ...(takesRunOutcomes
      ? { parseRun: (raw: unknown) => parseDockRunOutcome(createDockRunOutcome(raw as RunOutcomeEvent, true))?.event ?? null }
      : {}),
  });
  /**
   * 记一个原因码：本机环形缓冲 + 上报。`count` 是数量码的数量：上报的码不嵌数字（体检 11-4），环形缓冲里照旧写成
   * `<码>_<数>`（「技术细节」与本机排查照旧读得到）；数量为 0 只记本机。`http` 是那一次失败请求的状态码与 x-request-id
   * （体检 11-3），环形缓冲里照旧写成 `<码>_HTTP_<状态>`。
   */
  const recordDiagnostic = (code: string, detail?: DiagnosticDetail): void => {
    const status = detail?.http?.httpStatus;
    remember(detail?.count !== undefined ? `${code}_${detail.count}` : status !== undefined ? `${code}_HTTP_${status}` : code);
    if (detail?.count === 0) return;
    diagnosticsUploader.record(code, detail);
  };
  // worker 里没人接住的异常也记成稳定码；只取类名，不取 message。上报成 uncaught_error / unhandled_rejection（`WORKER:<类名>`）。
  globalThis.addEventListener('error', (event) => {
    const error = (event as ErrorEvent).error;
    remember(workerFailureCode('error', error));
    diagnosticsUploader.recordError({ surface: 'background', kind: 'uncaught_error', code: `WORKER:${errorClassOf(error)}` });
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    remember(workerFailureCode('rejection', reason));
    diagnosticsUploader.recordError({ surface: 'background', kind: 'unhandled_rejection', code: `WORKER:${errorClassOf(reason)}` });
  });
  /**
   * 提前轮换：到期前 120s 把 worker 叫醒去换 refresh token（P0-1）。
   *
   * 只要轮换发生在 worker 醒着的时候，就不会死在「服务端已轮换、客户端未落盘」之间。
   * `when` 是 unix 秒；alarm 同名重建即覆盖，所以每拿到一枚 access token 登记一次即可。
   */
  const ROTATION_ALARM = 'auth-rotate';
  const scheduleRotation = (whenUnixSeconds: number): void => {
    void browser.alarms.create(ROTATION_ALARM, { when: Math.max(Date.now() + 1_000, whenUnixSeconds * 1_000) });
  };
  /**
   * 「我的资料」上一次读到的那一份（2026-10-04，先显示旧的、后台换新；lib/profileDirectoryCache.ts）：只在 storage.session、
   * 只给读到它的那个账号。会话一变（退出登录、换账号握手、会话被清）就整份清掉——authClient 在变之前先通知这里。
   * 浮层的东西：Assistant 产物里浮层从不挂出来，不建这一层（常量折叠，连同模块整个删掉）。
   */
  const profileDirectoryCache = !(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__)
    ? createProfileDirectoryCache({
      area: () => browser.storage.session,
      userId: () => authClient.getUserId(),
      onDiagnostic: recordDiagnostic,
    })
    : null;
  let vaultAuthInvalidated: () => void = () => {};
  let beforeVaultSessionReplace: NonNullable<Parameters<typeof createAuthClient>[0]['beforeReplaceSession']> = async () => false;
  const authClient = createAuthClient({
    apiBase,
    store: storageLocal,
    onDiagnostic: recordDiagnostic,
    scheduleRotation,
    beforeReplaceSession: (change) => beforeVaultSessionReplace(change),
    onSessionInvalidated: () => {
      assistantInvalidated();
      void profileDirectoryCache?.clear();
      missionCachesInvalidated();
      vaultAuthInvalidated();
    },
    onBeforeLogout: async (cleanupAccessToken) => {
      if (!telemetryClient) return;
      let deletionAccessToken = cleanupAccessToken;
      const deletionOnlyTransport = createTrustTelemetryHttpTransport({
        apiBase,
        getAccessToken: async () => {
          const token = deletionAccessToken;
          deletionAccessToken = null;
          return token;
        },
        refreshAccessToken: async () => null,
        getInstallId: () => authClient.getInstallId(),
      });
      try {
        await telemetryClient.clear(deletionOnlyTransport.deleteIdentity);
      } finally {
        deletionAccessToken = null;
      }
    },
  });
  // 浮层「诊断」区要看的最近原因码。只回码；这条消息不授予任何东西。
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if ((message as Record<string, unknown> | null)?.kind !== 'diagnostics/recent') return;
    if (sender.id !== browser.runtime.id) return;
    sendResponse({ codes: diagnostics.slice(-20) });
    return true;
  });
  // 内容脚本那一侧的稳定原因码（2026-10-03 体检 3a-2：一轮填写半路抛了）：闭集里的码才记，不回话。
  // 2026-10-04（体检 11-2）：入口处的异常带闭集里的类名，上报成 uncaught_error / unhandled_rejection（`<码>:<类名>`）；
  // 码自己说它来自内容脚本（apply）还是浮层（dock）。
  browser.runtime.onMessage.addListener((message, sender) => {
    const diagnostic = parseDockDiagnostic(message);
    if (diagnostic === null || sender.id !== browser.runtime.id) return;
    remember(diagnostic.code);
    if (diagnostic.kind === 'diagnostic') diagnosticsUploader.record(diagnostic.code, { surface: diagnostic.surface });
    else diagnosticsUploader.recordError({ surface: diagnostic.surface, kind: diagnostic.kind, code: `${diagnostic.code}:${diagnostic.errorClass}` });
  });
  // 每一轮自动填写怎么收场（2026-10-04，体检 11-1，lib/runOutcome.ts）：闭集里、一致的才收，排进上报队列；不回话。
  if (takesRunOutcomes) {
    browser.runtime.onMessage.addListener((message, sender) => {
      const parsed = parseDockRunOutcome(message);
      if (parsed === null || sender.id !== browser.runtime.id) return;
      console.debug(`[argo] run ${parsed.event.vendor} ${parsed.event.outcome}${parsed.event.reason === undefined ? '' : ` ${parsed.event.reason}`}`);
      diagnosticsUploader.recordRun(parsed.event, parsed.final);
    });
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ROTATION_ALARM) return;
    // 结果不用管：换成了会再登记下一次；换不成走 rotateOnce 自己的三分（4xx 清会话、
    // 5xx/断网留日志位、宽限窗内 201 救回）。这里只负责「在 worker 醒着时发起」。
    void authClient.forceRefresh();
  });
  if (typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__ && __VIBE_API_BASE__ && __VIBE_WEB_BASE__) {
    const prepareExecutor = createAssistantExecutorInstaller({
      probe: (tabId, documentId) => browser.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', func: readAssistantExecutorState }),
      inject: (tabId, documentId) => browser.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', files: [ASSISTANT_EXECUTOR_FILE] }),
    });
    assistantInvalidated = installAssistantWorker(authClient, __VIBE_API_BASE__, __VIBE_WEB_BASE__, {
      roleManagement: typeof __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__,
      profileEditing: typeof __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__,
      prepareAutofill: prepareExecutor,
      // 连接门的握手 state 由同一个处理器预铸（见 portalConnectUrl.ts）。
      connectState: () => handleAuthMessage.beginPending(),
      runAutofill: (mission, context, signal, rows, reviewedFieldKeys) => createAssistantRunAdapter({
        prepareExecutor,
        bridge: () => ({
          ...bridgeDependencies,
          connectToTab: tabId => browser.tabs.connect(tabId, {
            name: KERNEL_BRIDGE_PORT_NAME,
            documentId: context.topDocumentId,
          }) as unknown as BridgePortLike,
        }),
        acquirer: intentClient.acquirer,
        claimer: intentClient.claimer,
        receiptUploader,
      })(mission, context, signal, rows, reviewedFieldKeys),
    }).invalidate;
  }
  telemetryClient = createTrustTelemetryClient({
    store: storageLocal,
    automaticDeliveryEnabled: __VIBE_TRUST_TELEMETRY_ENABLED__,
    transport: createTrustTelemetryHttpTransport({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
      getInstallId: () => authClient.getInstallId(),
    }),
  });
  let recoverSubmissionBoundaryOutbox = () => {};

  // STACKED predecessor：建立 versioned bundle 的严格取数与原子缓存；缓存
  // 只有在本次远端返回 exact 304 时才可继续作为 authority。断网、超时或 5xx
  // 一律 fail closed，不得用先前 allow bundle 继续授权；scan/fill authority
  // 默认关闭。VM0 Auth/API 与 execution-runtime fetch authority 分闸；只有显式、
  // 构建期验证过的 runtime-bundle 开关才允许 remote refresh。任一未启用状态都把
  // client base 固定为 null，避免仅为 Auth 配置 API base 就顺带启动执行面。
  // 开关关着 → 字面量 null；开着 → 覆盖优先，没有覆盖就落到生产 origin。
  //
  // 这里刻意**不抽成函数**：三道产物闸（store / assistant×2）靠 Rollup 把这个
  // 表达式折成一个字面量，从字节上直接看出这条道是开是关、终点在哪。抽成函数
  // 就折不动了，那三道闸只能退化成读逻辑——而它们存在的理由正是不读逻辑。
  //
  // `?? PRODUCTION_API_BASE` 是 2026-09-18 补的，补的是商店包上的一条死路：
  // `EXECUTION_RUNTIME_BUNDLE_ENABLED` 对商店包写死为 true，而
  // `resolveApiBaseOverride({ storeBuild: true })` 恒为 null（商店包拿不到覆盖），
  // 于是终点是 null、`executeRefresh` 第一行就答 RUNTIME_BUNDLE_CONFIG_UNAVAILABLE、
  // 规则永远取不到、装入表永远是空的、浮层在任何申请页上都不出现。
  //
  // 这不是「偷开执行面」：开关仍是唯一的开关。非商店包要让它为真，wxt.config
  // 那边已经要求同时给出合法的 VIBE_API_BASE，所以那条路上 fallback 轮不到；
  // 它只在商店包这一种形态下真正生效，而那正是它该生效的地方。
  const executionRuntimeApiBase = __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__
    ? (__VIBE_API_BASE__ ?? PRODUCTION_API_BASE)
    : null;
  // `executionRuntimeApiBase === null` 时 refresh 与
  // authorization 都 fail closed；绝不借 production fallback 偷开执行面。
  // Runtime-bundle base 刻意不使用上面的 production fallback；
  // 因此普通／store 构建不会仅因包内存在此代码就开启远程 execution authority。
  const executionRuntimeBundleStore = createExecutionRuntimeBundleStore({
    async get(key) {
      return (await browser.storage.local.get(key))[key];
    },
    async set(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
  });
  const executionRuntimeBundleClient = createExecutionRuntimeBundleClient({
    apiBase: executionRuntimeApiBase,
    store: executionRuntimeBundleStore,
    extensionVersion: () => browser.runtime.getManifest().version,
  });
  const executionRuntimeAuthority = createBackgroundExecutionRuntimeAuthority({
    client: executionRuntimeBundleClient,
  });
  // 每次 MV3 worker 被唤起时做一次 conditional GET；client 内 single-flight，
  // 304 不续时，且任何失败只返回 disabled Result，不会恢复 bundled authority。
  //
  // 顺带把同一份规则装进识别路径：`autofillDockDecision` 在 background 这侧用
  // `hasApplyAdapter` / `isApplyFormPath` 判断一个页面该不该露面，而那两个函数
  // 从 2026-09-15 起读的是装入表、不再读随包内置的 ADAPTERS（站点知识已经整个
  // 移出产物）。取不到规则就装空表，识别 fail closed。
  // 刷新保持在字面量的构建开关 if 里——`execution-runtime-bundle-wiring` 那道
  // 门禁按源码形状钉死它，守的是 default-off：开关关着时这条路径连提都不提。
  // 装载器：**装上了才算成功**，失败留待重试，成功也只算到这一份的新鲜期为止。
  // 原来这里是一行 `refresh().then(...)`——算一次记一辈子，包括记住失败。
  // 2026-09-18 事故里后端 503 了几分钟，那期间起来的 worker 装了空表，后端恢复
  // 之后它们仍然是空表，用户持续看到「认不出申请页」，直到 worker 恰好闲置回收。
  //
  // 2026-09-22 实测到「成功」这一侧的两处：编译不过时 `installApplyAdaptersFromRules`
  // 装空表却返回 0 而不抛错，被当成功记下；而成功一旦记下就记一辈子，后端连发
  // 三版都换不上新包，非得手动重载扩展。两处都在 runtimeRulesInstaller.ts 里修了。
  //
  // 重试**不是**沿用缓存：它重新去问后端，后端关着就照旧关着，kill switch
  // 一点没动（见 runtimeRulesInstaller.ts 的头注）。
  let rulesInstaller: RuntimeRulesInstaller = { rules: async () => null };
  // 装上的那一份包放行了哪几家（2026-10-04）：浮层的脸据此说「这类网站还没开放自动填写」，不亮一颗按下去才说「连不上」的按钮。
  // 与规则同一次取包、同生同灭：取不到包时是 null（那时规则也是 null，脸说「暂时没法判断」）。
  let runtimeOpenVendors: ReadonlySet<string> | null = null;
  if (__VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__) {
    rulesInstaller = createRuntimeRulesInstaller({
      refresh: async () => {
        const resolved = await executionRuntimeBundleClient.refresh();
        runtimeOpenVendors = resolved.ok ? bundleOpenVendors(resolved.bundle) : null;
        if (!resolved.ok) {
          // 取不到、验不过的原因码照记（2026-09-28）。此前这里只回一个 `ok: false`，
          // 「这个包太旧、后端要求更新」（`RUNTIME_BUNDLE_EXTENSION_INCOMPATIBLE`）与
          // 「后端 503」在诊断里是同一片空白。只有码，没有内容。
          recordDiagnostic(resolved.code);
          return { ok: false as const };
        }
        // 验过了、但里面有这一版不认识而忽略掉的加法：逐类各记一个码（只有码）。
        for (const notice of describeExecutionRuntimeBundleNoticesV1(resolved.bundle, APPLICATION_PROFILE_FIELD_KEYS)) {
          recordDiagnostic(notice);
        }
        // 带上这一份自己声明的新鲜期终点：装载器不得把它留到 `classifyUsable`
        // 已经会拒的时刻之后（见 runtimeRulesInstaller.ts 的头注）。
        return {
          ok: true as const,
          rules: resolved.bundle.rules,
          freshUntilMs: Date.parse(resolved.bundle.freshUntil),
        };
      },
      install: (rules) => installApplyAdaptersFromRules(rules, recordDiagnostic),
    });
    void rulesInstaller.rules();
  }

  // 内容脚本要同一份规则做识别与读表单。它自己不再带站点知识，所以注入后向
  // 这里要一次。只回规则本身——没有 policy、没有授权、没有 token：这条消息
  // 不授予任何东西，拿到它也只能"看懂页面"，动手仍要走完整的意向链。
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as Record<string, unknown> | null)?.kind !== 'apply-site-knowledge/get') return;
    void (async () => {
      sendResponse({ rules: (await rulesInstaller.rules()) ?? null });
    })();
    return true;
  });

  /**
   * 「此刻登录的是谁」的不透明代号（2026-10-04，lib/sessionStamp.ts）：报到、授权、档案答复里都带上。内容脚本看到它变了就把上一个
   * 人的东西一样不留地丢掉；按下「自动填写」那一刻再拿授权答复里的对一次预取的档案。没登录是 null；算不出就不带（内容脚本当没变）。
   */
  const sessionStampOf = !(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__)
    ? createSessionStamp({
      userId: () => authClient.getUserId(),
      area: () => browser.storage.session,
    })
    : null;
  const sessionStamp = (): Promise<{ session?: string | null }> => (sessionStampOf === null
    ? Promise.resolve({})
    : sessionStampOf().then((session) => ({ session }), () => ({})));

  // 门户 → 扩展的登录交接与 fresh connection attestation（§2.3）。
  // 挂起的 state 写进 storage.session：连接页上的人要先注册或登录，回来时 SW 多半已换过实例
  // （lib/authHandoff.ts 头注，2026-09-23）。session 区跨 SW 重启存活、浏览器退出即清，内容脚本读不到。
  const AUTH_HANDOFF_PENDING_KEY = 'authHandoffPendingV1';
  const handleAuthMessage = createAuthHandoffHandler({
    authClient,
    extensionId: browser.runtime.id,
    allowedOrigins: allowedPortalOrigins,
    onDiagnostic: recordDiagnostic,
    pendingStore: {
      read: async () => (await browser.storage.session.get(AUTH_HANDOFF_PENDING_KEY))[AUTH_HANDOFF_PENDING_KEY],
      write: (value) => value === null
        ? browser.storage.session.remove(AUTH_HANDOFF_PENDING_KEY)
        : browser.storage.session.set({ [AUTH_HANDOFF_PENDING_KEY]: value }),
    },
  });
  // 门户的 origin 是这一次构建钉死的；标签页去哪里只由这里拼，页面提名不了。
  const portalBase = __VIBE_WEB_BASE__ ?? PRODUCTION_WEB_APP_BASE;
  /** 连上之后，门户请我们「开设置页」的那个标签页：装完开的那一页去资料页，别的关掉。 */
  const settleConnectTab = async (tabId: number): Promise<void> => {
    let firstRun: FirstRunConnectTab | null = null;
    try {
      firstRun = parseFirstRunConnectTab((await browser.storage.session.get(FIRST_RUN_CONNECT_TAB_KEY))[FIRST_RUN_CONNECT_TAB_KEY]);
    } catch {
      recordDiagnostic('FIRST_RUN_TAB_READ_FAILED');
    }
    if (landingAfterConnect(tabId, firstRun, Date.now()) === 'PROFILE') {
      await browser.storage.session.remove(FIRST_RUN_CONNECT_TAB_KEY).catch(() => recordDiagnostic('FIRST_RUN_TAB_CLEAR_FAILED'));
      await browser.tabs.update(tabId, { url: new URL(DOCK_PORTAL_PATHS.PROFILE, portalBase).href });
      return;
    }
    await browser.tabs.remove(tabId);
  };
  // 告诉所有标签页的浮层一件事。不带值；发不到的标签页（没有内容脚本的页）静默略过。
  const broadcastToTabs = (message: typeof DOCK_SESSION_CHANGED | typeof DOCK_PROFILE_CHANGED): void => {
    void browser.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        void browser.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }).catch(() => {});
  };
  // 登录态变了（握手完成 / 退出登录）→ 每一页的浮层重新报到。
  const broadcastSessionChanged = (): void => {
    broadcastToTabs(DOCK_SESSION_CHANGED);
    // tabs.sendMessage reaches content scripts; settings are extension pages.
    void browser.runtime.sendMessage(DOCK_SESSION_CHANGED).catch(() => {});
  };
  browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    // 只认领 auth 面的消息通道；无关消息让路（不吞别的监听器的应答口）。
    // 门户 /extension-auth/complete 发的是 VibeID 时代的 `type: 'VIBE_*'`（见 authHandoff.ts 头注），一并认。
    const kind = typeof message === 'object' && message !== null
      ? normalizeAuthMessageKind(message as Record<string, unknown>)
      : undefined;
    if (kind === undefined) return;
    const origin = resolvePortalSenderOrigin(sender) ?? undefined;
    void handleAuthMessage(message, origin)
      .then((response) => {
        if (kind === 'auth/handoff-complete' && response?.ok) {
          recoverSubmissionBoundaryOutbox();
          // 连上了：让每一页的浮层重新报到换脸，不等用户切回来那一下 focus。
          broadcastSessionChanged();
        }
        // 门户的「seamless hop」：握手落地后它请我们开设置页并关掉这个标签页。dock 没有设置页：
        // 浮层发起的连接照旧关掉——用户回到申请页，浮层在 focus 时重新报到就是已连接；装完开的
        // 那一页没有申请页可回，改去资料页（lib/firstRunConnect.ts，2026-09-23）。
        if (kind === 'auth/open-options' && response?.ok === true && typeof sender.tab?.id === 'number') {
          void settleConnectTab(sender.tab.id).catch(() => recordDiagnostic('CONNECT_TAB_SETTLE_FAILED'));
        }
        sendResponse(response ?? { ok: false });
      })
      .catch(() => sendResponse({ ok: false })); // 认领了的通道必有终态应答
    return true; // 异步应答
  });
  // Telemetry has its own explicit-consent/default-off recovery path. Install
  // ownership deliberately has no startup retry here: it may only be linked
  // after a fresh, owner-bound handoff succeeds.
  void telemetryClient.flush();

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const record = message as Record<string, unknown> | null;
    const kind = record?.kind;
    if (typeof kind !== 'string' || !kind.startsWith('trust-telemetry/')) return;
    void (async () => {
      switch (kind) {
        case 'trust-telemetry/get-consent':
          return { ok: true, enabled: await telemetryClient!.getConsent() };
        case 'trust-telemetry/set-consent':
          if (typeof record?.enabled !== 'boolean') return { ok: false, code: 'VALIDATION_FAILED' };
          await telemetryClient!.setConsent(record.enabled);
          return { ok: true };
        case 'trust-telemetry/capture-execution':
          return { ok: true, status: await telemetryClient!.captureExecution(record?.event as never) };
        case 'trust-telemetry/report-structure': {
          const result = await telemetryClient!.reportStructure(record?.event as never);
          return { ok: true, ...result };
        }
        case 'trust-telemetry/clear':
          await telemetryClient!.clear();
          return { ok: true };
        default:
          return { ok: false, code: 'VALIDATION_FAILED' };
      }
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, code: trustTelemetryErrorCode(error) }));
    return true;
  });
  const intentClient = createIntentClient({
    apiBase,
    // 联调环境方案定稿前的约定：iss = API origin（对齐清单第 4 项）。
    expectedIssuer: apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
    getUserId: () => authClient.getUserId(),
    getInstallId: () => authClient.getInstallId(),
  });

  const submissionBoundaryClient = createSubmissionBoundaryClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
    getInstallId: () => authClient.getInstallId(),
  });
  const submissionPersistence: SubmissionBoundaryPersistence = {
    async load() {
      const stored = await browser.storage.local.get([
        SUBMISSION_BOUNDARY_STORAGE_KEY,
        LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY,
      ]);
      return stored[SUBMISSION_BOUNDARY_STORAGE_KEY] ??
        stored[LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY];
    },
    async save(value) {
      await browser.storage.local.set({ [SUBMISSION_BOUNDARY_STORAGE_KEY]: value });
      await browser.storage.local.remove(LEGACY_SUBMISSION_BOUNDARY_STORAGE_KEY);
    },
  };
  const submissionBoundaryRuntime = createSubmissionBoundaryRuntime({
    client: submissionBoundaryClient,
    persistence: submissionPersistence,
  });
  const submissionAuthorityClient = createMissionSubmissionAuthorityClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  recoverSubmissionBoundaryOutbox = () => {
    void submissionBoundaryRuntime.recover().catch(() => {
      // Storage/auth/network failures preserve the durable fail-closed state.
    });
  };
  // Only BOUNDARY_PENDING and a positively observed trigger outbox replay.
  // READY_FOR_USER_GESTURE never self-promotes into a trigger fact.
  recoverSubmissionBoundaryOutbox();

  // 内容脚本报到表：tabId → exact origin + pathname（不申请 tabs 权限）。
  // 放 storage.session 而不是 SW 内存：MV3 SW 空闲 ~30s 就挂起，用户"先开
  // 职位页、聊几分钟再点 run"的最常见路径会唤起一个全新 SW 实例——内存表
  // 必空、定位必败（审计 2026-08-13 [2]）。session 区跨 SW 重启存活、
  // 浏览器退出即清，且只存 canonical target 定位信息，无字段值/DOM。
  // V2 intentionally ignores the legacy origin-only registry: no guessed migration.
  const REGISTRY_KEY = 'kernelBridgeTabRegistryV2';
  // 读—改—写排成一队（2026-09-27）：从前两个标签页同时报到，后写的那次会把先写的那条冲掉，被冲掉的那一页
  // 再问资料就是「这一页没登记」。存储不可用只影响 tab 定位（scan 失败 fail-closed），不值得崩 SW。
  const registryRecord = createSerialSessionRecord(() => browser.storage.session, REGISTRY_KEY, parseTabRegistry);
  async function readRegistry(): Promise<ApplicationTabRegistry> {
    return registryRecord.read();
  }
  async function writeRegistry(
    transform: (registry: ApplicationTabRegistry) => ApplicationTabRegistry,
  ): Promise<void> {
    await registryRecord.update(transform);
  }
  // 子帧持表表（P2-10）：tabId → 持有申请表的那一帧（frameId + exact origin + pathname）。
  // 与报到表分开存：子帧永远不写报到表，报到表也永远不由子帧覆盖。同样放 session 区。
  const FRAME_FORM_KEY = 'kernelBridgeFrameFormV1';
  // 同一条队的道理（见报到表）。存储不可用只让子帧挂不上浮层。
  const frameFormRecord = createSerialSessionRecord(() => browser.storage.session, FRAME_FORM_KEY, parseFrameFormRegistry);
  async function readFrameForms(): Promise<FrameFormRegistry> {
    return frameFormRecord.read();
  }
  async function writeFrameForms(
    transform: (registry: FrameFormRegistry) => FrameFormRegistry,
  ): Promise<void> {
    await frameFormRecord.update(transform);
  }
  /**
   * 顶层报到之后校对子帧持表表：顶层换了页，旧记录随之作废（那一帧已经不存在）；
   * 顶层自己就是申请页，则让登记过的那一帧撤下浮层——浮层归顶层。两种情况都发一声
   * `dock/frame-yield` 给那一帧（帧没了就发不到，无妨）。
   */
  async function reconcileFrameForm(
    tabId: number,
    top: Readonly<{ canonicalOrigin: string; pathname: string }>,
    previous: RegisteredApplicationTab | undefined,
  ): Promise<void> {
    const entry = (await readFrameForms())[String(tabId)];
    if (entry === undefined) return;
    const moved = previous !== undefined &&
      (previous.canonicalOrigin !== top.canonicalOrigin || previous.pathname !== top.pathname);
    if (!moved && !recognisedApplyFormPage(top)) return;
    await writeFrameForms((registry) => removeFrameForm(registry, tabId));
    void browser.tabs.sendMessage(tabId, { kind: 'dock/frame-yield' }, { frameId: entry.frameId })
      .catch(() => {});
  }

  // Page → Mission binding (2026-09-24): an owner-scoped answer to "which of my
  // Missions is this page?", asked with the page alone. Any failure is no binding, and a
  // page learns nothing by asking: the answer stays in the worker. Kept per tab for a
  // minute, so the dock's run, its materials and its submission all see the same Mission.
  const missionPageBindingClient = createMissionPageBindingClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  const tabMissionBindings = createTabMissionBindings({ client: missionPageBindingClient });
  /**
   * The panel's door to the profile, held here because the token is held here.
   * The panel names one of eight operations; the route table and the bearer
   * stay on this side, so a page that has been taken over still cannot aim the
   * user's token somewhere of its own choosing.
   */
  const directoryTransport = createProfileDirectoryTransport({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  // 经它的每一次读到的、存成的都替当时的账号记一份（先显示旧的、后台换新）；答复本身原样交回。
  const directory = profileDirectoryCache === null ? directoryTransport : profileDirectoryCache.wrap(directoryTransport);
  // 「我的资料」先摆出来的那一份（2026-10-04）：与上面同一道闸——只有报到过、还停在那一页的标签页（或登记过的持表子帧）
  // 问得动；交回的只有当前账号记着的那几格原文，形状由面板那一半判。
  if (!(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__)) browser.runtime.onMessage.addListener((message, sender) => {
    if (profileDirectoryCache === null || !isDirectoryCachedRequest(message)) return;
    const tabId = sender.tab?.id;
    const senderFrameId = sender.frameId;
    if (
      sender.id !== browser.runtime.id ||
      (senderFrameId !== 0 && !isChildFrameId(senderFrameId)) ||
      typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0 ||
      typeof sender.url !== 'string'
    ) return;
    const senderUrl = sender.url;
    return Promise.all([readRegistry(), readFrameForms()]).then(([registry, frameForms]): Promise<unknown> | unknown =>
      (senderFrameId === 0
        ? registeredExactPage(registry, tabId, senderUrl) === null
        : frameFormForSender(frameForms, tabId, senderFrameId, senderUrl) === null)
        ? { ok: false, code: 'PAGE_NOT_REGISTERED' }
        : profileDirectoryCache.read().then((slots) => ({ ok: true, slots })));
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const request = parseDirectoryRequest(message);
    if (request === null) return;
    const tabId = sender.tab?.id;
    const senderFrameId = sender.frameId;
    if (
      sender.id !== browser.runtime.id ||
      (senderFrameId !== 0 && !isChildFrameId(senderFrameId)) ||
      typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0 ||
      typeof sender.url !== 'string'
    ) return;
    // Only the exact page this tab reported at hello may ask: same origin and
    // same path as the registry holds for it. A tab that moved since, or one
    // that never reported, gets no answer rather than a refusal it could probe.
    // 子帧持表时（P2-10）同理：只有登记过的那一帧、且仍在那一页，才能替这个标签页问。
    const senderUrl = sender.url;
    return Promise.all([readRegistry(), readFrameForms(), request.session === undefined ? null : sessionStamp()]).then(([registry, frameForms, now]) => {
      if (senderFrameId === 0
        ? registeredExactPage(registry, tabId, senderUrl) === null
        : frameFormForSender(frameForms, tabId, senderFrameId, senderUrl) === null) {
        // 拒绝要有名字。从前这里是 `undefined`，面板那边读 `.ok` 抛异常、被
        // catch 吞掉，最后画成「暂时无法读取，请稍后刷新」——而正确的动作是
        // 刷新这一页重新报到。说出原因不泄漏任何东西：这个码不描述这一页是谁。
        return { ok: false as const, code: 'PAGE_NOT_REGISTERED' as const };
      }
      // 写的这一份是谁的（2026-10-04）：内容脚本认的那个人不是此刻登录的人（存到一半换了账号、换了账号的广播还没到那一页），
      // 一个字都不写——上一个人的修改绝不存进下一个人的资料。
      if (request.session !== undefined && now?.session !== request.session) {
        recordDiagnostic('PROFILE_DIRECTORY_SESSION_CHANGED');
        return { ok: false as const, code: 'SESSION_CHANGED' as const };
      }
      // 先核是谁、再写，写成再广播：资料或代填授权在插件里改过了（2026-10-03 体检 P0-1），每一页把预取的档案作废，
      // 下一轮重新取。读不广播。
      return directory.run(request.operation, request.body).then((result) => {
        if (result.ok && !request.operation.endsWith('_READ')) broadcastToTabs(DOCK_PROFILE_CHANGED);
        return result;
      });
    });
  });
  // 在插件里提交（2026-09-23）：刚按了提交的标签页 → 按下的时刻与那一份文档。见下面 dock/submit-pressed 的头注。
  const submittedTabs = new Map<number, SubmittedTabMark>();
  const consumeJustSubmitted = (tabId: number, documentId: string | null): boolean => {
    const verdict = arrivesAfterSubmit(submittedTabs.get(tabId), documentId, Date.now());
    // 同一页又报到（比如用户切回了这个标签页）：留着，结论由那一页自己等、自己清。
    if (verdict !== 'SAME_PAGE') submittedTabs.delete(tabId);
    return verdict === 'ARRIVED';
  };
  // 替他过了数据同意页（2026-10-04，负责人 D7）：与「刚按了提交」同一个口径——90 秒内、另一份文档的顶层报到才带上。
  const consentGateTabs = new Map<number, SubmittedTabMark>();
  const consumeConsentGatePassed = (tabId: number, documentId: string | null): boolean => {
    const verdict = arrivesAfterSubmit(consentGateTabs.get(tabId), documentId, Date.now());
    if (verdict !== 'SAME_PAGE') consentGateTabs.delete(tabId);
    return verdict === 'ARRIVED';
  };
  browser.runtime.onMessage.addListener((message, sender) => {
    const submissionMessage = parseSubmissionRuntimeMessage(message);
    if (submissionMessage) {
      const submissionTabId = sender.tab?.id;
      if (typeof submissionTabId !== 'number') return { mode: 'BLOCKED' as const };
      return submissionBoundaryRuntime
        .handleMessage(submissionTabId, submissionMessage)
        .catch(() => ({ mode: 'BLOCKED' as const }));
    }
    const hello = parseBridgeHello(message);
    if (hello === null) return;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    // 刚在这个标签页里替用户按了提交、网站整页跳到了确认页：这一次报到的回答里说一声，
    // 新一页的浮层把「提交成功」播完。只认顶层帧、只说一次。
    const justSubmitted = sender.frameId === 0 && consumeJustSubmitted(tabId, typeof sender.documentId === 'string' ? sender.documentId : null);
    const consentGatePassed = sender.frameId === 0 &&
      consumeConsentGatePassed(tabId, typeof sender.documentId === 'string' ? sender.documentId : null);
    // 登记这一页的只能是顶层帧。
    //
    // 注册表是「这个标签页此刻停在哪一页」，按 tabId 存一条，后来的覆盖先来的。
    // 内容脚本是 allFrames 注入的（白标 ATS 把申请表放在跨源 iframe 里，不进子帧
    // 就没有一帧持有表单），于是页面上任何一个跨源 iframe 也会报到，用同一个
    // tabId 把顶层帧那条覆盖掉。
    //
    // 2026-09-18 在真实 Greenhouse 申请页上实测到：表里只剩
    // `https://content.googleapis.com/static/proxy.html`（reCAPTCHA 那个 iframe），
    // 用户看着的那一页根本不在表里。所有认「这一页登记过没有」的入口随之一起失效
    // ——资料面板取不到数、画一片空白，还劝用户刷新，而刷新也没用：那个 iframe
    // 每次都在。
    //
    // 子帧仍然照常拿到它的脸与规则（那两条不经过注册表）；这里挡住的只是
    // 「由它来说这个标签页停在哪一页」。
    if (sender.frameId !== 0) return;
    let previous: RegisteredApplicationTab | undefined;
    void writeRegistry((registry) => {
      previous = registry[String(tabId)];
      return registerApplicationTab(registry, {
        tabId,
        canonicalOrigin: hello.canonicalOrigin,
        pathname: hello.pathname,
        at: Date.now(),
      });
    }).then(() => reconcileFrameForm(tabId, hello, previous)).catch(() => {});
    // The dock's face is decided here, not in the content script: that script may
    // not touch the host document before a verified authorization, and whether
    // this browser is connected is a fact only the background holds. A failure
    // resolves to no dock rather than to an optimistic one.
    // 每一次 await 自己兜住自己。
    //
    // 整段外面那个 `.catch(() => undefined)` 的意思是「不挂浮层」——对真正意料之外
    // 的错误，那是对的（不可信边界上认不出的东西不该变成 UI）。但取 token、装规则、
    // 问 Mission 归属这三件事**会**失败，而且都是有话可说的失败：
    // 没登录、取不到规则、不属于任何 Mission，浮层各有一句文案。
    // 让它们掉进那个 catch，用户看到的就不是解释，是一片空白。
    //
    // 2026-09-18 实测到这个形状：同一个包，干净 profile 出浮层、**连接过的
    // profile 不出**——差别就是有没有 authSession，而有 token 的那条路多走了
    // 取 token 与问 Mission 两步。用户的说法是「插件连不上」，其实是连上之后才没的。
    return authClient
      .getAccessToken()
      .catch(() => null)
      .then(async (token) => {
        // 先等规则装完再判这一页认不认得出。
        //
        // MV3 的 worker 是冷启动的：用户打开申请页，内容脚本立刻报到，而规则包
        // 还在下载。不等的话，`dockFaceForPage` 读到的是一张**空的装入表**，
        // 于是判成「这一页没有认出申请表」——而且就那样留着，直到有别的事再触发
        // 一次报到。2026-09-17 在 jobs.lever.co 上实测到：规则包已经在 storage
        // 里、7 家都在、路径也匹配，面板却说没认出。
        //
        // 等它不等于信它：refresh 失败时装的是空表，那时判「没认出」仍然是对的。
        // 这一行只保证我们**知道答案之后**再回答，不放松任何一道闸。
        //
        // 同一条消息链上的 `apply-site-knowledge/get` 一直是等的；漏的是这一条。
        // 规则装完了吗，以及**装到了没有**。两件事：等它是为了不抢跑（下面那段
        // 头注），而它的结果决定面板该说哪一句——取不到规则时说「暂时取不到
        // 填写规则」，不能说「这一页没有认出申请表」：那把一次运维故障伪装成
        // 覆盖面问题（2026-09-18 事故就栽在这句话上）。
        const rulesAvailable = (await rulesInstaller.rules().catch(() => null)) !== null;
        const connected = typeof token === 'string' && token !== '';
        // A page never claims a Mission it has not proved: the answer comes
        // from the backend, under this owner's bearer, and only for a page the
        // dock could actually act on.
        const missionBound = connected && (await tabMissionBindings.isBound(tabId, hello).catch(() => false));
        const dock = dockFaceForPage({
          canonicalOrigin: hello.canonicalOrigin,
          pathname: hello.pathname,
          // 白标 B（P2-11）：主机表答不出时才看这个提示。
          vendorHint: hello.vendorHint ?? null,
          // 通用路与岗位页（2026-09-24）：主机表与指纹都答不出时，只凭内容脚本看见的东西。
          genericForm: hello.genericForm === true,
          genericJobForm: hello.genericJobForm === true,
          jobPosting: hello.jobPosting === true,
          ownOrigins: ownPageOrigins,
          connected,
          missionBound,
          // Injection is network-wide, because white-label and employer-owned
          // application domains cannot be enumerated. Recognition is the narrow
          // part, and being unrecognised on a job page is not a reason to be
          // unreachable: the tab stays, opens only if a person opens it, and
          // claims nothing about a page we did not recognise. Other pages show
          // nothing.
          reachableOnJobPages: true,
          rulesAvailable,
          openVendors: rulesAvailable ? runtimeOpenVendors : null,
        });
        return {
          dock,
          ...(justSubmitted ? { justSubmitted: true } : {}),
          ...(consentGatePassed ? { consentGatePassed: true } : {}),
          // 此刻登录的是谁（2026-10-04）：变了，这一页就把上一个人的东西全丢掉（脸没变也一样）。什么都不挂的普通网页用不上，不算。
          ...(dock.kind === 'HIDDEN' ? {} : await sessionStamp()),
        };
      })
      .catch(() => undefined);
  });
  // The user asked for this posting to be added to their list.
  //
  // The dock can stand on a page the scraping pipeline never reached and say so;
  // this is the action that sentence implies. It adds a posting, and starts no
  // run: filling still needs a Mission the user approves.
  //
  // The URL sent is built here from the page the sender was registered on. A
  // content script may report that a person asked; it may not nominate what gets
  // added, so nothing it says about the posting is read.
  const jobIntakeClient = createJobIntakeClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockAddJobIntent(message);
    if (intent === null) return;
    return readFrameForms().then((frameForms) => {
      const tabId = senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms);
      if (tabId === null) return undefined;
      // 子帧持表时（P2-10）加的是**顶层那一页**：申请卡片属于公司官网上的岗位页，不是嵌入帧的 URL。
      const page = sender.frameId === 0
        ? Promise.resolve<{ origin: string; pathname: string } | null>({ origin: intent.origin, pathname: intent.pathname })
        : readRegistry().then((registry) => {
            const top = registry[String(tabId)];
            return top === undefined ? null : { origin: top.canonicalOrigin, pathname: top.pathname };
          });
      return page.then((target) => (target === null
        ? { kind: 'REFUSED' as const, code: 'JOB_INTAKE_UNAVAILABLE' as const }
        : jobIntakeClient.add(target.origin, target.pathname)
            .catch(() => ({ kind: 'REFUSED' as const, code: 'JOB_INTAKE_UNAVAILABLE' as const }))));
    });
  });

  // 子帧说「我这一帧持有申请表」（P2-10，白标 A：公司站点上官方嵌入的 ATS iframe）。
  //
  // 不写报到表；另记一张「这个标签页的申请表在哪一帧」，先来的算数——两个子帧都认出时只给
  // 第一个。脸的判法与顶层同一套（frameFormFace，URL-only）：顶层自己就是申请页 → HIDDEN，
  // 浮层归顶层；这一帧不是认得的厂商的嵌入申请页 → HIDDEN。三件会失败的事（取 token、装规则、
  // 问 Mission 归属）各自兜住，与顶层报到那段同一姿势。
  browser.runtime.onMessage.addListener((message, sender) => {
    const frameForm = parseBridgeFrameForm(message);
    if (frameForm === null) return;
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (sender.id !== browser.runtime.id || typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return;
    // 顶层帧走报到（bridge/hello）；这条只收子帧。
    if (!isChildFrameId(frameId) || typeof sender.url !== 'string') return;
    let senderUrl: URL;
    try { senderUrl = new URL(sender.url); } catch { return; }
    // 它报的必须就是它所在的那一帧（与 senderPage 同一口径：origin + pathname，查询串不算）。
    if (senderUrl.origin !== frameForm.canonicalOrigin || senderUrl.pathname !== frameForm.pathname) return;
    const entry = { tabId, frameId, canonicalOrigin: frameForm.canonicalOrigin, pathname: frameForm.pathname, at: Date.now() };
    return Promise.all([readRegistry(), readFrameForms()])
      .then(async ([registry, frameForms]) => {
        if (!recordFrameForm(frameForms, entry).accepted) return { dock: { kind: 'HIDDEN' as const } };
        const top = registry[String(tabId)];
        const topPage = top === undefined ? null : { canonicalOrigin: top.canonicalOrigin, pathname: top.pathname };
        const token = await authClient.getAccessToken().catch(() => null);
        const rulesAvailable = (await rulesInstaller.rules().catch(() => null)) !== null;
        const connected = typeof token === 'string' && token !== '';
        const missionBound = connected && (await tabMissionBindings.isBound(tabId, frameForm).catch(() => false));
        const dock = frameFormFace({
          frame: frameForm, topPage, connected, missionBound, rulesAvailable,
          openVendors: rulesAvailable ? runtimeOpenVendors : null,
        });
        if (dock.kind !== 'HIDDEN') {
          await writeFrameForms((current) => recordFrameForm(current, entry).registry);
          // 这一帧要挂自己的浮层了：叫顶层再看一眼让不让位（嵌入 iframe 常常晚到，那时顶层的脸早挂好了）。
          // 不带值，判不判仍是顶层自己按门控那个判据；顶层没了就发不到，无妨。
          void browser.tabs.sendMessage(tabId, { kind: 'dock/top-yield' }, { frameId: 0 }).catch(() => {});
        }
        return { dock, ...(dock.kind === 'HIDDEN' ? {} : await sessionStamp()) };
      })
      .catch(() => undefined);
  });

  // 面板要画「这次用哪份简历」那一幕，来问 worker 取清单。凭据只在这里，
  // 内容脚本自始至终拿不到 token。与 add-job 分开是有意的：那一条是写（让一个
  // 岗位进目录），这一条只读用户自己账号里已有的东西。
  const applyMaterialsClient = createApplyMaterialsClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  // 结构化档案（教育 / 经历）给手势填写路按行取值（P1-8a）。凭据只在这里：V2 快照在 worker 里
  // 解析、绑到当前用户、投影成内核的集合形状后才过桥，而且只有用户确认过的事实会被投影出来。
  const profileCollectionsProvider = createProfileCollectionsProvider({
    directory,
    getUserId: () => authClient.getUserId(),
    onDiagnostic: recordDiagnostic,
  });
  // EEO 自我认同答案（2026-09-21）：扁平档案端点对那四个键一律答 null，真正的答案在 EEO 自己的
  // 端点里，按用户选的原文存；这里译成内核的码，且只在用户同意复用时带。内核仍只把它们排成
  //「待确认」，面板预选、用户点头才写。
  const eeoAnswersProvider = createEeoAnswersProvider({
    directory,
    getUserId: () => authClient.getUserId(),
    onDiagnostic: recordDiagnostic,
  });
  // 代填条款、声明与签名（2026-09-23）：用户在资料页单独勾过的同意。只有同意过当前文案版本才算（2026-09-28 起不认
  // 旧版本），读不到一律当没同意；是否真的代填，内核还要看生效策略里的 `sign-on-behalf`。
  const signingConsentProvider = createSigningConsentProvider({
    directory,
    getUserId: () => authClient.getUserId(),
    onDiagnostic: recordDiagnostic,
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockApplyMaterialsIntent(message);
    if (intent === null) return;
    return readFrameForms().then((frameForms) => applyMaterialsReply(intent, sender, frameForms));
  });
  const applyMaterialsReply = (
    intent: NonNullable<ReturnType<typeof parseDockApplyMaterialsIntent>>,
    sender: Readonly<{ id?: string; frameId?: number; url?: string; tab?: { id?: number } }>,
    frameForms: FrameFormRegistry,
  ) => {
    // 与 add-job 同一套发信人核对：必须是我们自己的顶层帧——或登记过的持表子帧（P2-10）——
    // 而且它报的页面要和 worker 看到的 sender.url 同一个 origin、同一条 pathname（见 senderPage.ts）。
    if (senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null) return undefined;
    if (intent.want === 'DISCOVERY_AUTHORITY') {
      // 无 mission 那条填写路要扫这一页。厂商由 worker 自己认（它本来就用装入表
      // 判断 dock 的脸），映射与开关仍然全从下发的 bundle 里取。
      const hostname = (() => { try { return new URL(intent.origin).hostname; } catch { return ''; } })();
      // 主机表先行；答不出时才看内容脚本给的「先试哪家」（P2-11 白标 B），并从此以白标身份走；
      // 两样都答不出时退到通用路（2026-09-22），按「这张表里有几个字段我们认得」判。
      const page = pageVendor(hostname, intent.vendorHint ?? null);
      const vendor = page.vendor;
      // 这一路上的四种拒绝，对外都是同一个 `UNAVAILABLE`（浮层不需要知道分别，
      // 它只能说「这一页用不了」），但**对内必须分得开**：2026-09-22 那次故障里
      // 装入表是空的，拒在第二条；而诊断环一个码都没有，只能靠生产测试台反推。
      // 只记码，不记 origin / pathname / 厂商名（RULE-GLOBAL-DATA-L1）。
      const refuse = (code: string): DockApplyMaterialsReply => {
        recordDiagnostic(code);
        // 这一家没放行（运行时包里的厂商位关着、通用路这一版没放行）：对外单独说一句（2026-10-04），浮层照实说
        // 「这类网站还没开放自动填写」，不再说成「暂时连不上 ArgoLand」。别的拒绝照旧都是 UNAVAILABLE。
        return { kind: 'REFUSED', code: VENDOR_CLOSED_CODES.has(code) ? 'VENDOR_CLOSED' : 'UNAVAILABLE' };
      };
      // 主机表答不出，内容脚本也没给「先试哪家」：这一页不属于我们认得的任何厂商。
      // `pageVendor` 现在总答得出（答不出就退通用路），这一条留着是因为类型上仍可能为
      // null，而且它的含义没变——真到了这里就是那个意思。
      if (vendor === null) return refuse('DISCOVERY_VENDOR_UNKNOWN');
      // 通用路的准入：后端包里没有 GENERIC 映射（或策略位关着）时适配器就装不上。
      // 这**不是**「认得这家但规则没装上」那种运维故障，而是「这一页谁都认不出，
      // 而通用路这一版没放行」——两者要分得开，否则线上只能靠反推。
      if (page.generic && !hasApplyAdapter(vendor)) return refuse('DISCOVERY_GENERIC_UNAVAILABLE');
      // 认得这家，但它的适配器不在装入表里——规则没装上（取不到、验不过、或者
      // 这个包不认得后端发的这一版）。这条是运维故障，不是覆盖面问题。
      if (!hasApplyAdapter(vendor)) return refuse('DISCOVERY_ADAPTER_MISSING');
      // 子帧持表时嵌入路径也算申请页（规则点名的那条）；顶层帧上照旧不算。
      // 白标与通用都不看路径——那两条路上本家的路径知识不适用，闸在 DOM 里。
      // 规则声明的账号页（iCIMS 的 …/login，2026-09-28）也要这张只读授权：账号墙那一路要按规则认出那一步（只认本家主机）。
      if (!isApplyFormPath(vendor, intent.pathname, {
        embedded: sender.frameId !== 0,
        whitelabel: page.whitelabel,
        generic: page.generic,
      }) && (page.whitelabel || page.generic || !isAccountFormPath(vendor, intent.pathname))) {
        return refuse('DISCOVERY_NOT_APPLY_PATH');
      }
      // 带上此刻登录的是谁（2026-10-04）：按下去那一刻内容脚本拿它核对预取的档案。
      return Promise.all([executionRuntimeAuthority.authorizeDiscoveryForVendor(vendor), sessionStamp()]).then(
        ([result, session]): DockApplyMaterialsReply => (result.ok
          ? { kind: 'DISCOVERY_AUTHORITY', authorization: result.value, ...session }
          : refuse(`DISCOVERY_AUTHORITY_${result.code}`)),
        (): DockApplyMaterialsReply => refuse('DISCOVERY_AUTHORITY_THREW'),
      );
    }
    if (intent.want === 'SIGN_ON_BEHALF') {
      // 此刻代不代签（2026-10-03 体检 P0-1，AGENTS.md「撤回即失效」）：内容脚本在按下「自动填写」那一刻来问，每次现读
      // argoland 的同意记录（signingConsentProvider 不缓存：每次都是一次 no-store 的 GET）。门户上、别的标签页里撤回的，
      // 之后开始的每一轮都不代签。读不到一律当没同意。
      return signingConsentProvider.read().then(
        (signing): DockApplyMaterialsReply => ({ kind: 'SIGN_ON_BEHALF', granted: signing.granted }),
        (): DockApplyMaterialsReply => ({ kind: 'SIGN_ON_BEHALF', granted: false }),
      );
    }
    if (intent.want === 'PROFILE') {
      // 无 mission 那条填写路要的是用户自己的扁平档案。凭据只在这里；
      // `/application-profile` 没有 JWS 验签那一关，所以不需要 intent。
      // `profileSnapshot: null` 说的是「没有可比对的那一份」——不是关掉那道闸，
      // 是这条路上本来就没有 chat 批准过的快照（见 profileClient 的头注）。
      // 扁平档案与结构化集合（P1-8a）并行取。集合读不到只是少了分段内容（行内格如实
      // NO_VALUE），不能让一次 V2 读的抖动把整份档案答复变成 REFUSED、废掉整轮填写。
      // 整份答复有时限（2026-10-04）：每个请求自己 8 秒，四个并行、先可能换一次 token；到点就照实答「太慢」，不让浮层
      // 一直停在「正在对照你的资料」。
      // 这一份是替谁读的（2026-10-04）：读之前、读完各认一次；中途换了人，这一份不知道是谁的，不交出去。
      const reading = sessionStamp().then((before) => withDeadline(Promise.all([
        profileProvider.getProfile({
          // header 要求升序去重；这里没有 JWS 帮我们保证，所以自己排一次。
          fieldKeys: [...APPLICATION_PROFILE_FIELD_KEYS].sort(),
          fieldSchemaVersion: 1,
          profileSnapshot: null,
        }),
        profileCollectionsProvider.read(),
        eeoAnswersProvider.read(),
        // 读不到只是不代填，不能让它把整份档案答复变成 REFUSED。
        signingConsentProvider.read().catch(() => ({ granted: false, reconsent: false })),
      ]).then(([result, facts, eeo, signing]): DockApplyMaterialsReply => {
        // 太慢、门户正在保存档案（再读一次也还在保存），浮层各有各的话；别的失败照旧「读不到」。
        if (!result.ok) return { kind: 'REFUSED', code: result.reason ?? 'UNAVAILABLE' };
        // 「是否拉美裔」（2026-09-23）、「是否跨性别」与性取向（2026-09-23）都不是扁平档案键
        // （那一组与后端契约逐项相等），单独带。
        const { hispanicLatino, transgenderStatus, sexualOrientation, ...eeoCodes } = eeo ?? {};
        return {
          kind: 'PROFILE',
          profile: {
            ...Object.fromEntries(
              Object.entries(result.draft).filter(([, v]) => typeof v === 'string' && v !== ''),
            ),
            ...eeoCodes,
          } as Record<string, string>,
          ...(facts === null
            ? {}
            : { collections: facts.collections, workAuthorizations: facts.workAuthorizations, referrals: facts.referrals }),
          // 没同意当前版本、也没撤回过的，浮层请他一键同意（2026-09-28）。代不代签不随档案带（它会被预取、留一分钟）：
          // 填写开始那一刻另问 SIGN_ON_BEHALF（2026-10-03）。
          ...(signing.reconsent ? { signingReconsent: true as const } : {}),
          // 资料里对「可以联系你现在的雇主吗？」确认过的回答（2026-09-28）：同一次 V2 读带出；没答就不带。
          ...(facts?.employerContact === null || facts?.employerContact === undefined ? {} : { employerContact: facts.employerContact }),
          // 资料里「出差最多能接受多少？」确认过的回答（2026-10-04，argoland #738）：同一次 V2 读带出；没答就不带。
          ...(facts?.travelPercentMax === null || facts?.travelPercentMax === undefined ? {} : { travelPercentMax: facts.travelPercentMax }),
          ...(hispanicLatino === undefined ? {} : { hispanicLatino }),
          ...(transgenderStatus === undefined ? {} : { transgenderStatus }),
          ...(sexualOrientation === undefined ? {} : { sexualOrientation }),
        };
      }, (): DockApplyMaterialsReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' })), PROFILE_REPLY_BUDGET_MS)
        .then(async (reply): Promise<DockApplyMaterialsReply> => {
          if (reply === DEADLINE_PASSED) {
            recordDiagnostic('PROFILE_REPLY_TIMEOUT');
            return { kind: 'REFUSED', code: 'TIMEOUT' };
          }
          if (reply.kind !== 'PROFILE') return reply;
          const after = await sessionStamp();
          if (after.session !== before.session) {
            recordDiagnostic('PROFILE_SESSION_CHANGED');
            return { kind: 'REFUSED', code: 'UNAVAILABLE' };
          }
          return { ...reply, ...before };
        }));
      return reading;
    }
    return applyMaterialsClient.listResumes().then((result): DockApplyMaterialsReply => {
      if (!result.ok) return { kind: 'REFUSED', code: result.code === 'JOB_NOT_FOUND' ? 'UNAVAILABLE' : result.code };
      return {
        kind: 'RESUMES',
        // 只投影面板画得上的那几项。mimeType / fileSize / contentRevision 是
        // 取附件那一步才用得到的，让它们跨进宿主页面所在的进程没有理由。
        options: result.value.items.map((item) => ({
          resumeVersionId: item.resumeVersionId,
          trackId: item.trackId,
          label: item.label ?? `${item.trackName} · v${item.versionNumber}`,
          isDefault: item.isDefault,
        })),
      };
    }, (): DockApplyMaterialsReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }));
  };

  // 手势填写路要把简历挂进这一页的 file input（P1-4）。凭据只在这里；收件人由
  // worker 从核对过的 sender.url 自己组，不收内容脚本另报的值；PLAN 只回文件名，
  // RELEASE 才回字节，字节只在这一次答复里经过，不进存储、不进日志、不进回执。
  const resumeAttachmentProvider = createResumeAttachmentProvider({
    listResumes: () => applyMaterialsClient.listResumes(),
    client: createResumeAttachmentClient({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
    }),
    // 页面绑着一个仍开着的任务时，附的是任务钉住的那份定制简历（2026-09-24）：
    // 不问「为这个岗位准备过的那一版」，也不退回默认版。
    missionResume: async (senderKey, page) => {
      const tabId = Number(senderKey);
      if (!Number.isSafeInteger(tabId)) return null;
      return dockMissionWorker.resumeSupply(tabId, { canonicalOrigin: page.origin, pathname: page.pathname });
    },
    onDiagnostic: recordDiagnostic,
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockResumeAttachmentIntent(message);
    if (intent === null) return;
    // 与 apply-materials 同一套发信人核对：必须是我们自己的顶层帧，而且它报的
    // 页面要和 worker 看到的 sender.url 同一个 origin、同一条 pathname——收件人
    // 就从这两项里组。
    return readFrameForms().then((frameForms) => {
      const tabId = senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms);
      if (tabId === null) return undefined;
      return resumeAttachmentProvider.handle(intent, String(tabId)).catch(
        (): DockResumeAttachmentReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }),
      );
    });
  });

  // 求职信（2026-09-27，argoland #653）：按页面要一封、交给这一页。与简历附件同一套发信人核对，收件人从核对过的
  // 发信页组；信的正文、PDF 与这一页的职位描述只在内存里（RULE-GLOBAL-DATA-L1）。
  const coverLetterProvider = createCoverLetterProvider({
    client: createCoverLetterAttachmentClient({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
    }),
    onDiagnostic: recordDiagnostic,
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockCoverLetterIntent(message);
    if (intent === null) return;
    return readFrameForms().then((frameForms) => {
      const tabId = senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms);
      if (tabId === null) return undefined;
      return coverLetterProvider.handle(intent, String(tabId)).catch(
        (): DockCoverLetterReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }),
      );
    });
  });

  // 手势填写路的答案记忆（P1-6）：内容脚本只说在哪一页、要清单还是要记一条；凭据只在
  // 这里。两个开关存在本地（后端没有它们的端点）。答案是 Data-L1，不进日志。
  const answerMemoryProvider = createAnswerMemoryProvider({
    client: createAnswerMemoryClient({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
      onDiagnostic: recordDiagnostic,
    }),
    storage: {
      get: async (key) => (await browser.storage.local.get(key))[key],
      set: async (key, value) => { await browser.storage.local.set({ [key]: value }); },
    },
    onDiagnostic: recordDiagnostic,
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockAnswerMemoryIntent(message);
    if (intent === null) return;
    return readFrameForms().then((frameForms) => {
      if (senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null) return undefined;
      return answerMemoryProvider.handle(intent).catch(
        (): DockAnswerMemoryReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }),
      );
    });
  });

  // AI 起草开放题（P3-13）：内容脚本只说在哪一页、这一份岗位是什么、要起草哪几道题；凭据、requestId
  // 与配额都在这里。题目与岗位是用户点了「让 AI 起草」才上行的；草稿回到面板等他改完再回填。
  const questionDraftProvider = createQuestionDraftProvider({
    client: createQuestionDraftClient({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
    }),
    onDiagnostic: recordDiagnostic,
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockQuestionDraftIntent(message);
    if (intent === null) return;
    return readFrameForms().then((frameForms) => {
      if (senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null) return undefined;
      return questionDraftProvider.handle(intent).catch(
        (): DockQuestionDraftReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }),
      );
    });
  });

  // AI 代答（2026-09-23 负责人决定）：规则答不了、页面上还空着的题，按用户自己确认过的资料由 argoland 起草。
  // Assistant 产物里浮层从不挂出来（内容脚本的 hello 在 Assistant 接管时直接返回，手势填写路整条是死代码），
  // 没有谁会发这条消息：那个产物里不注册，Full AI 的客户端与契约解析器也就不进它的 background。
  if (!(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__)) {
    // 内容脚本只说在哪一页、问哪几道题（不透明题号、题面与选项，不带选择器与现值）；凭据、requestId 与配额
    // 都在这里。本地开关（缺省开、按人存）在发请求之前判，关着一条都不发。答案是 Data-L1，诊断只记码与个数。
    const aiAnswersProvider = createAiAnswersProvider({
      client: createAiAnswersClient({
        apiBase,
        getAccessToken: () => authClient.getAccessToken(),
        refreshAccessToken: () => authClient.forceRefresh(),
      }),
      storage: {
        get: async (key) => (await browser.storage.local.get(key))[key],
        set: async (key, value) => { await browser.storage.local.set({ [key]: value }); },
      },
      userId: () => authClient.getUserId(),
      onDiagnostic: (code, count) => recordDiagnostic(code, count === undefined ? undefined : { count }),
      // 逐个时刻的计时串只进本机（体检 11-4：上报的是固定的码与桶）。
      onLocalDiagnostic: remember,
    });
    browser.runtime.onMessage.addListener((message, sender) => {
      const intent = parseDockAiAnswersIntent(message);
      if (intent === null) return;
      return readFrameForms().then((frameForms) => {
        if (senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null) return undefined;
        return aiAnswersProvider.handle(intent).catch(
          (): DockAiAnswersReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }),
        );
      });
    });
    // 一次「自动填写」的规划（2026-09-24）：内容脚本连上这条长连接、发一条 PLAN；这里打 `plan/stream`，答案一批一批
    // 按到达的先后交回，最后一条永远是结束或拒绝，然后断开。发信人与一次性消息同一道核对；一条连接只问一次；
    // 内容脚本那一头断了（翻页、新的一轮、撤销）就中止请求。
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== AI_ANSWERS_STREAM_PORT) return;
      const gone = new AbortController();
      port.onDisconnect.addListener(() => gone.abort());
      const post = (message: DockAiStreamMessage): void => {
        if (gone.signal.aborted) return;
        try {
          port.postMessage(message);
        } catch {
          // 那一头已经走了：不再发。
          gone.abort();
        }
      };
      let asked = false;
      port.onMessage.addListener((message: unknown) => {
        if (asked) return;
        asked = true;
        const intent = parseDockAiAnswersIntent(message);
        if (intent?.step !== 'PLAN' || port.sender === undefined) {
          port.disconnect();
          return;
        }
        void readFrameForms()
          .then(async (frameForms) => {
            if (senderTabForPageOrFrame(port.sender!, browser.runtime.id, intent, frameForms) === null) return;
            await aiAnswersProvider.stream(intent, post, gone.signal);
          })
          .catch(() => { recordDiagnostic('AI_ANSWERS_STREAM_FAILED'); post({ kind: 'REFUSED', code: 'UNAVAILABLE' }); })
          .finally(() => {
            if (gone.signal.aborted) return;
            gone.abort();
            port.disconnect();
          });
      });
    });
  }

  // The user asked, from the dock, to be taken to the portal. The dock names a
  // page by a closed word; the URL is built here from the portal origin this
  // build was made with (`portalBase`), so a page can never nominate where the tab goes.
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockPortalIntent(message);
    if (intent === null) return;
    if (sender.id !== browser.runtime.id || (sender.frameId !== 0 && !isChildFrameId(sender.frameId)) || typeof sender.tab?.id !== 'number') return;
    // 连接门：开门前预铸握手 state，门户的 /extension-auth/complete 用它建 handoff，
    // 插件兑换时对的就是这一个（见 portalConnectUrl.ts 与 authHandoff.beginPending）。
    // state 写进 storage.session 之后才开门。
    return (async () => {
      const url = intent.page === 'CONNECT'
        ? portalConnectUrl(portalBase, browser.runtime.id, await handleAuthMessage.beginPending())
        : new URL(DOCK_PORTAL_PATHS[intent.page], portalBase).href;
      return browser.tabs.create({ url });
    })().then(() => ({ ok: true as const }), () => ({ ok: false as const }));
  });

  // 装完把人带到连接页（2026-09-22）。在此之前 worker 里一个 onInstalled 都没有：
  // 用户装完插件浏览器停在原地，没有任何一句话说下一步是回官网登录。商店安装尤其
  // 如此——Chrome 只把图标塞进工具栏，而我们的入口是页面上的浮层，浮层又只在十四个
  // 主机上出现，于是新用户装完最可能的经历是「什么都没发生」。
  //
  // 开的就是浮层「登录」开的那一个页面，握手逐字同一条路，不是第二条。判据窄在
  // lib/firstRunConnect.ts：只认第一次安装（更新、Chrome 自更新一律不开，商店版会
  // 自动更新，每次静默更新抢一次焦点不能接受），而且已经连上就不开。
  browser.runtime.onInstalled.addListener((details: { reason?: string }) => {
    void (async () => {
      const token = await authClient.getAccessToken().catch(() => null);
      const connected = typeof token === 'string' && token !== '';
      if (!shouldOpenConnectOnInstall({ reason: details.reason ?? '', connected })) return;
      let url: string;
      try {
        url = portalConnectUrl(portalBase, browser.runtime.id, await handleAuthMessage.beginPending());
      } catch {
        // state 铸不出来就什么都不开：把人送到一个会显示「Invalid request」的页面，
        // 比不送更糟。浮层上的「登录」仍然随时可以再来一次。
        recordDiagnostic('FIRST_RUN_CONNECT_STATE_FAILED');
        return;
      }
      const tab = await browser.tabs.create({ url }).catch(() => undefined);
      if (typeof tab?.id !== 'number') {
        recordDiagnostic('FIRST_RUN_CONNECT_TAB_FAILED');
        return;
      }
      // 记下这一页：连上之后它去资料页，不像浮层发起的那样被关掉（settleConnectTab）。
      await browser.storage.session
        .set({ [FIRST_RUN_CONNECT_TAB_KEY]: firstRunConnectTab(tab.id, Date.now()) })
        .catch(() => recordDiagnostic('FIRST_RUN_TAB_WRITE_FAILED'));
    })();
  });

  // 在插件里提交（2026-09-23）：内容脚本就要按网站的提交时报一声。只记标签页、那一份文档与时间（不记任何
  // 页面内容）；90 秒内这个标签页里**另一份**文档的顶层报到带上 justSubmitted。同一页自己等到了结论就再报
  // 一声 settled，这一条删掉。它只决定新一页的浮层播不播那段动画。
  browser.runtime.onMessage.addListener((message, sender) => {
    const pressed = isDockSubmitPressed(message);
    if (!pressed && !isDockSubmitSettled(message)) return;
    if (sender.id !== browser.runtime.id || typeof sender.tab?.id !== 'number' || sender.frameId !== 0) return;
    if (pressed) {
      submittedTabs.set(sender.tab.id, {
        at: Date.now(),
        documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
      });
      // 这一页绑着一个仍开着的任务：记住是哪一个，网站确认之后替用户报「已提交」（2026-09-24）。
      dockMissionWorker.submitPressed(sender.tab.id);
    } else submittedTabs.delete(sender.tab.id);
    return Promise.resolve({ ok: true as const });
  });

  // 替他在数据同意页选上了居住地（2026-10-04，负责人 D7）：只记标签页、那一份文档与时间；网站整页跳到申请表之后，新一页
  // 的报到带上 consentGatePassed，浮层照实说一句。只收顶层帧、我们自己的内容脚本。
  browser.runtime.onMessage.addListener((message, sender) => {
    const chosen = isDockConsentGateChosen(message);
    if (!chosen && !isDockConsentGateSettled(message)) return;
    if (sender.id !== browser.runtime.id || typeof sender.tab?.id !== 'number' || sender.frameId !== 0) return;
    // 网站没有自己跳走（要他本人点同意）：删掉那一条，之后他自己点过去的新一页不说「已替你过了」。
    if (!chosen) consentGateTabs.delete(sender.tab.id);
    else {
      consentGateTabs.set(sender.tab.id, {
        at: Date.now(),
        documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
      });
    }
    return Promise.resolve({ ok: true as const });
  });

  // Old dock versions cannot bypass the local export/confirmation flow.
  browser.runtime.onMessage.addListener((message) => {
    if (parseDockSignOutIntent(message) === null) return;
    return Promise.resolve({ ok: false as const });
  });

  // 白标 C（P2-12）：用户在没有申请表的落地页上点了「打开申请表」。内容脚本只交两个闭集 token，
  // URL 在这里按固定模板拼在厂商自己的域名上——页面就算接管了内容脚本也开不到别处。只导航，不写。
  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockOpenApplicationFormIntent(message);
    if (intent === null) return;
    if (sender.id !== browser.runtime.id || (sender.frameId !== 0 && !isChildFrameId(sender.frameId)) || typeof sender.tab?.id !== 'number') return;
    return browser.tabs.create({ url: applicationFormUrl(intent) }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void writeRegistry((registry) => removeApplicationTab(registry, tabId));
    void writeFrameForms((registry) => removeFrameForm(registry, tabId));
    dockMissionWorker.forgetTab(tabId);
  });

  const profileProvider = createProfileProvider({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
    // 只有闭集里的稳定码（PROFILE_CLIENT_DIAG_CODES），不带值；HTTP 失败另带状态码与 x-request-id（只进上报）。从前没接：
    // 浮层说「暂时读不到你的资料」（PROFILE_UNAVAILABLE），后台一个码都没有，超时、读锁都看不见（2026-10-04，体检 11-3、3f-3）。
    onDiagnostic: recordDiagnostic,
  });

  // Worker-only local credentials. Each site owns its own password; retained
  // ciphertext survives expired auth and requires explicit confirmation to clear.
  const vaultArea = {
    get: async (key: string) => (await browser.storage.local.get(key))[key],
    set: async (key: string, value: unknown) => { await browser.storage.local.set({ [key]: value }); },
    remove: async (key: string) => { await browser.storage.local.remove(key); },
  };
  const accountVault = createAccountVault({
    area: vaultArea,
    keys: createIndexedDbVaultKeyStore(globalThis.indexedDB),
    onDiagnostic: recordDiagnostic,
  });
  // Assistant keeps the real retained-vault auth fence without exposing the
  // legacy credential or settings protocols. No operations exist in that build.
  let invalidateAccountOperations: () => void = () => {};
  const vaultManagementUrl = browser.runtime.getURL('/vault.html');
  const vaultManagementAvailable = !(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__);
  const vaultLifecycle = createAccountVaultLifecycle({
    auth: () => authClient, vault: accountVault, area: vaultArea,
    invalidateOperations: () => invalidateAccountOperations(),
    broadcastInvalidated: broadcastSessionChanged,
    showSwitch: async (ticket) => {
      if (!vaultManagementAvailable) throw new Error('VAULT_SETTINGS_UNAVAILABLE');
      const url = new URL(vaultManagementUrl);
      url.searchParams.set('transition', ticket);
      await browser.tabs.create({ url: url.toString() });
    },
  });
  beforeVaultSessionReplace = vaultLifecycle.beforeReplaceSession;
  vaultAuthInvalidated = vaultLifecycle.onAuthInvalidated;
  if (!(typeof __VIBE_ASSISTANT_READ_ENABLED__ !== 'undefined' && __VIBE_ASSISTANT_READ_ENABLED__)) {
    // One registry per worker, never one per RPC. Worker restarts reject old operations.
    const accountOperations = createAccountAccessOperationStore();
    invalidateAccountOperations = () => accountOperations.invalidate();
    const vaultMessages = createAccountVaultMessageRouter({
      extensionId: browser.runtime.id, managementUrl: vaultManagementUrl,
      transitions: vaultLifecycle.transitions,
      manage: (payload) => createAccountAccessProvider({
        vault: accountVault, ops: accountOperations,
        getAuthContext: () => vaultLifecycle.readContext(),
        getManagementContext: () => vaultLifecycle.readContext(true),
        consent: async () => false, capability: async () => false,
        // Export while a handoff waits cannot call the auth queue or guess historical emails.
        profileEmail: async () => null, onDiagnostic: recordDiagnostic,
      }).manage(payload),
      pageAllowed: async (sender, page) => senderTabForPageOrFrame(sender, browser.runtime.id, page, await readFrameForms()) !== null,
      openTab: async (url) => {
        if (!vaultManagementAvailable) throw new Error('VAULT_SETTINGS_UNAVAILABLE');
        await browser.tabs.create({ url });
      },
    });
    browser.runtime.onMessage.addListener((message, sender) => vaultMessages.management(message, sender));
    browser.runtime.onMessage.addListener((message, sender) => vaultMessages.transition(message, sender));
    browser.runtime.onMessage.addListener((message, sender) => vaultMessages.open(message, sender));
    /** 第一把钥匙：这一家此刻的写策略里 `account-access` 开着、这一家的总开关开着。读不到当关。 */
    const accountCapability = async (vendor: ApplyVendor): Promise<boolean> => {
      const policy = await executionRuntimeAuthority.fillPolicyForVendor(vendor);
      return policy !== null && policy.capabilities['account-access'] === true && isApplyPolicyEnabled(policy, vendor, Date.now());
    };
    const accountProfileEmail = async (): Promise<string | null> => {
      const result = await profileProvider.getProfile({
        fieldKeys: [...APPLICATION_PROFILE_FIELD_KEYS].sort(),
        fieldSchemaVersion: 1,
        profileSnapshot: null,
      });
      const email = result.ok ? result.draft.email : undefined;
      return typeof email === 'string' && email.trim() !== '' ? email.trim() : null;
    };
    browser.runtime.onMessage.addListener((message, sender) => {
      const intent = parseDockAccountAccessIntent(message);
      if (intent === null) return;
      return readFrameForms().then((frameForms): Promise<DockAccountAccessReply> | DockAccountAccessReply | undefined => {
        if (senderTabForPageOrFrame(sender, browser.runtime.id, intent, frameForms) === null) return undefined;
        const refused: DockAccountAccessReply = { kind: 'REFUSED', code: 'DISABLED' };
        const step = intent.payload.step;
        // Metadata list remains sender-bound; credential operations also require a declared account wall.
        const pageBound = step !== 'LIST';
        let vendor: ApplyVendor | null = null;
        try {
          vendor = detectApplyVendor(new URL(intent.origin).hostname);
        } catch {
          vendor = null;
        }
        if (pageBound && (vendor === null || !declaresAccountSteps(vendor) ||
            !(isApplyFormPath(vendor, intent.pathname) || isAccountFormPath(vendor, intent.pathname)))) {
          recordDiagnostic('ACCOUNT_ACCESS_PAGE_OUT_OF_SCOPE');
          return refused;
        }
        const provider = createAccountAccessProvider({
          vault: accountVault,
          ops: accountOperations,
          getAuthContext: () => vaultLifecycle.readContext(),
          getManagementContext: () => vaultLifecycle.readContext(true),
          // 第二把钥匙：他同意着的那一版点名了「替你注册、登录招聘网站」（#130 的判定，别处不自己比版本号）。
          consent: async () => signingConsentCoversAccountRegistration(await signingConsentProvider.read()),
          capability: () => (vendor === null ? Promise.resolve(false) : accountCapability(vendor)),
          profileEmail: accountProfileEmail,
          onDiagnostic: recordDiagnostic,
        });
        return provider.handle(intent.payload, intent.origin);
      }).catch((): DockAccountAccessReply => ({ kind: 'REFUSED', code: 'UNAVAILABLE' }));
    });
  }
  const missionApplicationTargetClient = createMissionApplicationTargetClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  // The Mission materials entry (2026-09-24): the tailored resume and the cover letter a
  // Mission's job needs. Bytes and letter text are fetched here, verified, and handed to the
  // fill only; they never touch storage, logs or receipts.
  const missionMaterials = createMissionMaterialsClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });

  // Question answering (CAP-AF-035): the content script sends scanned questions and the
  // answers the user confirmed; the mission context and the API call stay in here.
  const applicationQuestionClient = createApplicationQuestionClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
    getInstallId: () => authClient.getInstallId(),
    resolveTarget: (missionId) => missionApplicationTargetClient.resolve(missionId),
  });
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const kind = (message as Record<string, unknown> | null)?.kind;
    if (typeof kind !== 'string' || !kind.startsWith(APPLICATION_QUESTION_MESSAGE_PREFIX)) return;
    handleApplicationQuestionMessage(applicationQuestionClient, kind, message as Record<string, unknown>)
      .then(sendResponse, () => sendResponse({ ok: false, code: 'UNAVAILABLE' }));
    return true;
  });

  const bridgeDependencies:TabBridgeDeps = {
    resolveTargetOrigin: (intent) => intentClient.getVerifiedTargetOrigin(intent),
    resolveTargetPathname: async (ref, intent) => {
      const canonical = await missionApplicationTargetClient.resolve(ref.missionId);
      const verifiedIntent = intentClient.getVerifiedRuntimeTarget(intent);
      if (
        canonical === null ||
        verifiedIntent === null ||
        canonical.canonicalOrigin !== verifiedIntent.canonicalOrigin ||
        canonical.atsProvider !== verifiedIntent.atsProvider ||
        canonical.pathRuleId !== verifiedIntent.pathRuleId
      ) return null;
      return canonical.pathname;
    },
    runtimeAuthority: {
      mode: 'REQUIRED',
      resolve: async (intent) => {
        const target = intentClient.getVerifiedRuntimeTarget(intent);
        if (target === null) return null;
        const resolved = await executionRuntimeAuthority.authorize(target);
        return resolved.ok ? resolved.value : null;
      },
      revalidate: (authorization) =>
        executionRuntimeAuthority.revalidate(authorization),
    },
    queryTabs: async () =>
      Object.values(await readRegistry()).map((entry) => ({
        id: entry.tabId,
        url: `${entry.canonicalOrigin}${entry.pathname}`,
        lastAccessed: entry.at,
      })),
    connectToTab: (tabId) =>
      browser.tabs.connect(tabId, { name: KERNEL_BRIDGE_PORT_NAME }) as unknown as BridgePortLike,
    // §5.8：binding 由 tabBridge 从已验签 grant 取出——三道相等校验在 profileClient。
    getProfile: (binding) => profileProvider.getProfile(binding),
    getResumeFile: (missionId) => missionMaterials.resumeFile(missionId),
    prepareSubmissionArm: async (tabId, grant) => {
      const authority = await submissionAuthorityClient.resolve(grant);
      if (!authority) return { mode: 'BLOCKED' as const };
      return submissionBoundaryRuntime
        .arm(tabId, authority, grant.leaseExpiresAt * 1000)
        .catch(() => ({ mode: 'BLOCKED' as const }));
    },
  };
  const bridge = createTabKernelBridge(bridgeDependencies);

  const receiptUploader = createReceiptUploader({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });

  const discoveryScanner = createExactTabDiscoveryScanner({
    runtimeAuthority: executionRuntimeAuthority,
    queryTabs: async () => Object.values(await readRegistry()),
    connectToTab: (tabId) =>
      browser.tabs.connect(tabId, { name: KERNEL_BRIDGE_PORT_NAME }) as unknown as BridgePortLike,
  });

  // ── Dock Mission wiring (2026-09-24) ─────────────────────────────────────────────
  //
  // A page bound to a Mission the user started in the portal is filled by the dock's own
  // gesture engine, exactly as any other page; the Mission adds the server-verified record
  // of each run (Start approval → intent → claim → receipt), the tailored materials, and the
  // submission report. The old `dock/fill` route (a kernel-bridge run found through the
  // Mission list) is gone: it could never find an approved Mission in production.
  const missionDock = createMissionDockClient({
    apiBase,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
    getInstallId: () => authClient.getInstallId(),
  });
  const dockMissionRuns = createDockMissionRuns({
    bindingFor: (tabId, page) => tabMissionBindings.fresh(tabId, page),
    missions: missionDock,
    acquirer: intentClient.acquirer,
    claimer: intentClient.claimer,
    uploadReceipt: (input) => uploadDockReceipt({
      apiBase,
      getAccessToken: () => authClient.getAccessToken(),
      refreshAccessToken: () => authClient.forceRefresh(),
      onDiagnostic: recordDiagnostic,
    }, input),
    onDiagnostic: recordDiagnostic,
  });
  // The four dock Mission messages (run begin/finish, cover letter, confirmed submission),
  // the materials and the submission report: lib/dockMissionWorker.ts. Same sender check as
  // every dock message: our own top frame (or the registered form frame) on exactly the page
  // the message names.
  const dockMissionWorker = createDockMissionWorker({
    extensionId: browser.runtime.id,
    readFrameForms,
    bindings: tabMissionBindings,
    runs: dockMissionRuns,
    materials: missionMaterials,
    missions: missionDock,
    onDiagnostic: recordDiagnostic,
  });
  missionCachesInvalidated = () => {
    tabMissionBindings.forgetAll();
    dockMissionWorker.forgetUser();
  };
  browser.runtime.onMessage.addListener((message, sender) => dockMissionWorker.handle(message, sender));

  browser.runtime.onConnectExternal.addListener((port) => {
    const sender = (port as unknown as { readonly sender?: unknown }).sender;
    if (!isAllowedPortalSender(sender, allowedPortalOrigins)) {
      port.disconnect();
      return;
    }
    let handshakeCoordinator: ReturnType<typeof createExtensionHandshakeCoordinator> | null = null;
    let runCoordinator: ReturnType<typeof createRunCoordinator> | null = null;
    let discoveryCoordinator: ReturnType<typeof createDiscoveryCoordinator> | null = null;
    const transport = createPortTransport(port as unknown as RuntimePortLike, {
      onDisconnect: () => {
        handshakeCoordinator?.dispose();
        runCoordinator?.dispose();
        discoveryCoordinator?.dispose();
      },
    });
    handshakeCoordinator = createExtensionHandshakeCoordinator({
      transport,
      extensionVersion: () => browser.runtime.getManifest().version,
      readReadiness: (expectedOwnerId) =>
        authClient.readConnectionReadiness(expectedOwnerId),
    });
    runCoordinator = createRunCoordinator({
      transport,
      acquirer: intentClient.acquirer,
      claimer: intentClient.claimer,
      scanner: bridge.scanner,
      filler: bridge.filler,
      receiptUploader,
    });
    discoveryCoordinator = createDiscoveryCoordinator({
      transport,
      authorizeStart: (ref) =>
        handshakeCoordinator?.consumeReady(
          ref.clientRequestId,
          'DISCOVERY_V1',
        ) === true,
      targetResolver: {
        resolve: async (ref) => {
          const target = await missionApplicationTargetClient.resolve(ref.missionId);
          return target === null
            ? { ok: false as const, code: 'TARGET_UNAVAILABLE' as const }
            : { ok: true as const, target };
        },
      },
      scanner: discoveryScanner,
    });
  });
});
