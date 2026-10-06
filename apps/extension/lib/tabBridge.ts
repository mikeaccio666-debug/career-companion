/**
 * 桥的背景 SW 端（刀六b）：把协调器的 PageScanner/FieldFiller 接到
 * 目标 tab 的内容脚本上。
 *
 * 目标 tab 解析（v1）：按已验签 Intent 的 target.canonicalOrigin 匹配
 * 登记表条目，多个命中取最近报到的——§5.5.2 本来就要求"扫描的必须是
 * 批准目标所在的页面"，origin 之外的 tab 根本不看。找不到 → 扫描失败 →
 * 协调器停 RESCAN_MISMATCH。岗位级精确定位（pathRule/postingFingerprint）
 * 等规则下发（对齐清单第 1 项）。
 *
 * 执行绑定：扫描成功按 **scanDigest** 登记 tab；fill 帧携带同一 digest，
 * 内容侧与其 lastScan 比对——并发/交错的 run 拿不到别人那次扫描的执行权
 * （审计 2026-08-13 [3]）。
 *
 * profile 在这里取（扩展隔离环境，将来 = 经背景代理的鉴权取数，T22）；
 * 取不到 → 全字段 NO_VALUE，一个宿主节点都不碰。
 */

import type { ProfileBinding, ProfileFetchResult } from './profileClient';
import type {
  AcquiredIntent,
  ExecutionGrant,
  FieldFiller,
  FillProgress,
  PageScan,
  PageScanner,
  RunStartRef,
} from '@edaix/agent-channel';
import type { APPLY_ENTRY_KEYS } from '@edaix/apply-kernel/contracts';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import { encodeBase64 } from './binaryEncoding';
import {
  parseBridgeEvent,
  type BridgePortLike,
  type BridgeRequest,
  type BridgeResumeFile,
} from './bridgeProtocol';
import type { MissionResumeFile } from './missionMaterialsClient';
import type { SubmissionArmDescriptor } from './submissionBoundaryProtocol';
import type { RuntimeExecutionAuthorization } from './executionRuntimeAuthority';

export interface BridgeTabInfo {
  readonly id: number;
  readonly url?: string;
  readonly lastAccessed?: number;
}

export interface TabBridgeDeps {
  /** 从已验签凭证取批准目标 origin（intentClient.getVerifiedTargetOrigin）。 */
  readonly resolveTargetOrigin: (intent: AcquiredIntent) => string | null;
  /**
   * Fresh pathname from the owner-scoped canonical Mission target. Required
   * in production runtime mode; absence or mismatch means zero connection.
   */
  readonly resolveTargetPathname?: (
    ref: RunStartRef,
    intent: AcquiredIntent,
  ) => Promise<string | null>;
  readonly queryTabs: () => Promise<readonly BridgeTabInfo[]>;
  readonly connectToTab: (tabId: number) => BridgePortLike;
  /** §5.8 档案取数注入口（binding 源自已验签 grant）；
   *  失败 → 全字段 NO_VALUE；stale（档案已变）→ 全字段 PLAN_STALE。 */
  readonly getProfile: (binding: ProfileBinding) => Promise<ProfileFetchResult>;
  /** Mandatory mode choice prevents an omitted callback from becoming a fallback. */
  readonly runtimeAuthority:
    | Readonly<{
        mode: 'REQUIRED';
        resolve: (
          intent: AcquiredIntent,
        ) => Promise<RuntimeExecutionAuthorization | null>;
        revalidate: (
          authorization: RuntimeExecutionAuthorization,
        ) => Promise<boolean>;
      }>
    | Readonly<{ mode: 'LOCAL_REHEARSAL' }>;
  /** Resolve/persist exact T11 authority before a SUBMIT-capable fill. */
  readonly prepareSubmissionArm?: (
    tabId: number,
    grant: ExecutionGrant,
  ) => Promise<SubmissionArmDescriptor>;
  /**
   * Mission-bound resume bytes for a grant that covers the resume file (CAP-AF-053). Consulted
   * only after target and runtime revalidation; null or a failure leaves the text fields filling
   * and the file field reporting NO_VALUE.
   */
  readonly getResumeFile?: (missionId: string) => Promise<MissionResumeFile | null>;
  readonly newRequestId?: () => string;
  /** 单次桥请求的响应超时（毫秒）；超时按失败收口。 */
  readonly timeoutMs?: number;
}

export interface TabKernelBridge {
  readonly scanner: PageScanner;
  readonly filler: FieldFiller;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 250;
/** The kernel's plan entry key for the resume file; typed against its closed entry set. */
const RESUME_FILE_ENTRY_KEY = 'resumeFile' satisfies (typeof APPLY_ENTRY_KEYS)[number];

/** Supply is best effort: any failure means the fill proceeds without a file. */
async function supplyResumeFile(
  getResumeFile: (missionId: string) => Promise<MissionResumeFile | null>,
  missionId: string,
): Promise<BridgeResumeFile | null> {
  try {
    const file = await getResumeFile(missionId);
    if (file === null) return null;
    return {
      fileName: file.fileName,
      sha256: file.sha256,
      size: file.size,
      bytesBase64: encodeBase64(file.bytes),
    };
  } catch {
    return null;
  }
}
/** 扫描登记的存活窗：远超 lease TTL 即可；到点未被 fill 消费就清掉。 */
const SCAN_ENTRY_TTL_MS = 10 * 60_000;

function pickTargetTab(
  tabs: readonly BridgeTabInfo[],
  origin: string,
  pathname: string | null,
): BridgeTabInfo | null {
  const matches = tabs.filter((tab) => {
    if (typeof tab.url !== 'string') return false;
    if (pathname === null) return tab.url === origin || tab.url.startsWith(`${origin}/`);
    try {
      const parsed = new URL(tab.url);
      return parsed.origin === origin &&
        parsed.pathname === pathname &&
        parsed.search === '' &&
        parsed.hash === '';
    } catch {
      return false;
    }
  });
  if (matches.length === 0) return null;
  // Production exact-path ambiguity is unverifiable; never guess by recency.
  if (pathname !== null && matches.length !== 1) return null;
  return matches.reduce((best, tab) =>
    (tab.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? tab : best,
  );
}

/** 异常/超时收口时补齐缺失字段：回执逐 key 有稳定码，不许无声消失。 */
function padMissing(
  grant: ExecutionGrant,
  collected: readonly ReceiptFieldOutcome[],
  progress: FillProgress,
): readonly ReceiptFieldOutcome[] {
  const seen = new Set(collected.map((outcome) => outcome.key));
  const padded = [...collected];
  for (const key of grant.fieldKeys) {
    if (seen.has(key)) continue;
    const outcome: ReceiptFieldOutcome = { key, ok: false, reason: 'DETACHED' };
    padded.push(outcome);
    progress.onOutcome(outcome);
  }
  return padded;
}

export function createTabKernelBridge(deps: TabBridgeDeps): TabKernelBridge {
  let requestSeq = 0;
  const newRequestId = deps.newRequestId ?? (() => `bridge_${++requestSeq}`);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 扫描成功的 tab 按 scanDigest 登记；fill 用同一 digest 找回并一次性消费。
  const scannedTabByDigest = new Map<string, {
    tabId: number;
    at: number;
    runtime: RuntimeExecutionAuthorization | null;
    canonicalOrigin: string;
    pathname: string;
  }>();

  function pruneScanEntries(now: number): void {
    for (const [digest, entry] of scannedTabByDigest) {
      if (now - entry.at > SCAN_ENTRY_TTL_MS) scannedTabByDigest.delete(digest);
    }
  }

  async function scan(ref: RunStartRef, intent: AcquiredIntent): Promise<PageScan | null> {
    pruneScanEntries(Date.now());
    const origin = deps.resolveTargetOrigin(intent);
    if (origin === null) return null;
    let runtime: RuntimeExecutionAuthorization | null = null;
    if (deps.runtimeAuthority.mode === 'REQUIRED') {
      try {
        runtime = await deps.runtimeAuthority.resolve(intent);
      } catch {
        runtime = null;
      }
      if (runtime === null) return null;
    }

    let pathname: string | null = null;
    if (deps.runtimeAuthority.mode === 'REQUIRED') {
      if (!deps.resolveTargetPathname) return null;
      try {
        pathname = await deps.resolveTargetPathname(ref, intent);
      } catch {
        pathname = null;
      }
      if (pathname === null) return null;
    }

    let tab: BridgeTabInfo | null;
    try {
      tab = pickTargetTab(await deps.queryTabs(), origin, pathname);
    } catch {
      tab = null;
    }
    if (!tab) return null;
    const tabId = tab.id;

    const requestId = newRequestId();
    const scanResult = await new Promise<PageScan | null>((resolve) => {
      let settled = false;
      let port: BridgePortLike;
      const settle = (value: PageScan | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // 端口可能已随 tab 关闭；结果不受影响。
        }
        resolve(value);
      };
      try {
        port = deps.connectToTab(tabId);
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => settle(null), timeoutMs);
      port.onDisconnect.addListener(() => settle(null));
      port.onMessage.addListener((raw) => {
        const event = parseBridgeEvent(raw);
        if (event?.kind === 'bridge/scan-result' && event.requestId === requestId) {
          settle(event.scan);
        }
      });
      port.postMessage(
        runtime === null
          ? ({ kind: 'bridge/scan', requestId } satisfies BridgeRequest)
          : ({ kind: 'bridge/scan', requestId, runtime } satisfies BridgeRequest),
      );
    });

    if (
      scanResult &&
      scanResult.canonicalOrigin === origin &&
      (pathname === null || scanResult.jobId === pathname)
    ) {
      scannedTabByDigest.set(scanResult.scanDigest, {
        tabId,
        at: Date.now(),
        runtime,
        canonicalOrigin: scanResult.canonicalOrigin,
        pathname: scanResult.jobId,
      });
      return scanResult;
    }
    return null;
  }

  async function fill(
    grant: ExecutionGrant,
    scan: PageScan,
    progress: FillProgress,
  ): Promise<readonly ReceiptFieldOutcome[]> {
    const failAll = (reason: ReceiptFieldOutcome['reason']): ReceiptFieldOutcome[] => {
      const outcomes = grant.fieldKeys.map<ReceiptFieldOutcome>((key) => ({ key, ok: false, reason }));
      for (const outcome of outcomes) progress.onOutcome(outcome);
      return outcomes;
    };

    const entry = scannedTabByDigest.get(scan.scanDigest);
    scannedTabByDigest.delete(scan.scanDigest); // 一次性消费：执行权不复用
    if (
      entry === undefined ||
      scan.canonicalOrigin !== entry.canonicalOrigin ||
      scan.jobId !== entry.pathname
    ) return failAll('DETACHED');

    if (entry.runtime !== null) {
      let current = false;
      try {
        current = deps.runtimeAuthority.mode === 'REQUIRED' &&
          await deps.runtimeAuthority.revalidate(entry.runtime) === true;
      } catch {
        current = false;
      }
      if (!current) return failAll('POLICY_DISABLED');
    }

    // The claim may have completed after a client-side SPA navigation. Ask the
    // content script to compare the live origin/path and rebuild the exact
    // authorized descriptor before profile data is read.
    if (!(await sendScanRevalidation(entry.tabId, scan, entry.runtime))) {
      return failAll('DETACHED');
    }

    if (grant.allowedActions.includes('SUBMIT')) {
      let descriptor: SubmissionArmDescriptor = { mode: 'BLOCKED' };
      try {
        descriptor = await deps.prepareSubmissionArm?.(entry.tabId, grant) ?? descriptor;
      } catch {
        descriptor = { mode: 'BLOCKED' };
      }
      // This ack means the content script has synchronously installed its
      // capture-phase blocker. Profile I/O and DOM writes start only after it.
      if (!(await sendSubmissionArm(entry.tabId, scan.scanDigest, descriptor))) {
        return failAll('DETACHED');
      }
    }

    let fetched: ProfileFetchResult;
    try {
      fetched = await deps.getProfile({
        fieldKeys: grant.fieldKeys,
        fieldSchemaVersion: grant.fieldSchemaVersion,
        profileSnapshot: grant.profileSnapshot,
      });
    } catch {
      fetched = { ok: false, stale: false };
    }
    // §5.8：绑定失配 = 批准所依据的档案已变——PLAN_STALE 停止填表；
    // 其余失败（未登录/网络/畸形）按取不到值收口。
    if (!fetched.ok) return failAll(fetched.stale ? 'PLAN_STALE' : 'NO_VALUE');
    const profile = fetched.draft;

    // Only a runtime-bound run has a verified canonical target behind it; rehearsal never attaches bytes.
    const resume = entry.runtime !== null && deps.getResumeFile !== undefined &&
      grant.fieldKeys.includes(RESUME_FILE_ENTRY_KEY)
      ? await supplyResumeFile(deps.getResumeFile, grant.missionId)
      : null;

    const requestId = newRequestId();
    return new Promise<readonly ReceiptFieldOutcome[]>((resolve) => {
      const collected: ReceiptFieldOutcome[] = [];
      let settled = false;
      let port: BridgePortLike;
      /** complete=true 走内容侧终帧（已完整）；false 为异常收口，补齐 DETACHED。 */
      const settle = (outcomes: readonly ReceiptFieldOutcome[], complete: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(stopPoll);
        try {
          port.disconnect();
        } catch {
          // 已断开也无妨。
        }
        resolve(complete ? outcomes : padMissing(grant, outcomes, progress));
      };
      try {
        port = deps.connectToTab(entry.tabId);
      } catch {
        resolve(failAll('DETACHED'));
        return;
      }
      const timer = setTimeout(() => settle(collected, false), timeoutMs);
      // 停止信号翻译：协调器的 shouldStop（run/stop、断连、lease 到期）
      // 轮询转发为 bridge/stop，内容侧在下一检查点收手。
      const stopPoll = setInterval(() => {
        if (progress.shouldStop()) {
          try {
            port.postMessage({ kind: 'bridge/stop', requestId } satisfies BridgeRequest);
          } catch {
            settle(collected, false);
          }
        }
      }, STOP_POLL_MS);
      // tab 关闭/导航断桥：已收到的算数，缺的补 DETACHED——回执逐 key
      // 有稳定码；kernel 侧写前记原值、写后读回保证不会"报成功但没写"。
      port.onDisconnect.addListener(() => settle(collected, false));
      port.onMessage.addListener((raw) => {
        const event = parseBridgeEvent(raw);
        if (!event || event.requestId !== requestId) return;
        if (event.kind === 'bridge/fill-outcome') {
          collected.push(event.outcome);
          progress.onOutcome(event.outcome);
        } else if (event.kind === 'bridge/needs-user-input') {
          progress.onNeedsUserInput?.(event.inputKind, event.fieldKey);
        } else if (event.kind === 'bridge/fill-result') {
          settle(event.outcomes, true);
        }
      });
      port.postMessage({
        kind: 'bridge/fill',
        requestId,
        grant,
        scanDigest: scan.scanDigest,
        profile,
        ...(entry.runtime === null ? {} : { runtime: entry.runtime }),
        ...(resume === null ? {} : { resume }),
      } satisfies BridgeRequest);
    });
  }

  async function sendSubmissionArm(
    tabId: number,
    scanDigest: string,
    descriptor: SubmissionArmDescriptor,
  ): Promise<boolean> {
    const requestId = newRequestId();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let port: BridgePortLike;
      const settle = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // A navigation/disconnect is a failed arm acknowledgement.
        }
        resolve(accepted);
      };
      try {
        port = deps.connectToTab(tabId);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => settle(false), timeoutMs);
      port.onDisconnect.addListener(() => settle(false));
      port.onMessage.addListener((raw) => {
        const event = parseBridgeEvent(raw);
        if (
          event?.kind === 'bridge/submission-arm-result' &&
          event.requestId === requestId
        ) settle(event.accepted);
      });
      port.postMessage({
        kind: 'bridge/submission-arm',
        requestId,
        scanDigest,
        descriptor,
      } satisfies BridgeRequest);
    });
  }

  async function sendScanRevalidation(
    tabId: number,
    scan: PageScan,
    runtime: RuntimeExecutionAuthorization | null,
  ): Promise<boolean> {
    const requestId = newRequestId();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let port: BridgePortLike;
      const settle = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // Navigation/disconnect is a failed exact-page revalidation.
        }
        resolve(accepted);
      };
      try {
        port = deps.connectToTab(tabId);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => settle(false), timeoutMs);
      port.onDisconnect.addListener(() => settle(false));
      port.onMessage.addListener((raw) => {
        const event = parseBridgeEvent(raw);
        if (
          event?.kind === 'bridge/revalidate-scan-result' &&
          event.requestId === requestId
        ) settle(event.accepted);
      });
      port.postMessage(
        runtime === null
          ? ({
              kind: 'bridge/revalidate-scan',
              requestId,
              scanDigest: scan.scanDigest,
              canonicalOrigin: scan.canonicalOrigin,
              pathname: scan.jobId,
            } satisfies BridgeRequest)
          : ({
              kind: 'bridge/revalidate-scan',
              requestId,
              scanDigest: scan.scanDigest,
              canonicalOrigin: scan.canonicalOrigin,
              pathname: scan.jobId,
              runtime,
            } satisfies BridgeRequest),
      );
    });
  }

  return { scanner: { scan }, filler: { fill } };
}
