/**
 * 桥的内容脚本端（刀六b）：真正持有页面 DOM 的一侧。
 *
 * 关键状态：`lastScan`（含活 descriptor）留在本模块内存，绝不过桥——
 * claim 绑定的是"那一次扫描"，fill 必须用同一份 descriptor 执行；
 * 页面在扫描后又变样的兜底在 kernel 逐写入的身份重查（IDENTITY_CHANGED）。
 */

import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type { KernelPageScan } from './kernelScanner';
import type { KernelFillInput } from './kernelFiller';
import { decodeBase64 } from './binaryEncoding';
import {
  parseBridgeRequest,
  type BridgeEvent,
  type BridgePortLike,
  type BridgeResumeFile,
} from './bridgeProtocol';
import type { SubmissionArmDescriptor } from './submissionBoundaryProtocol';
import {
  sameRuntimeExecutionAuthorization,
  type RuntimeExecutionAuthorization,
} from './executionRuntimeAuthority';

export interface ContentBridgeDeps {
  /** Projection-only scan: never retained for fill, submission, or revalidation. */
  readonly discover?: (
    runtime: RuntimeExecutionAuthorization & { readonly purpose: 'DISCOVERY' },
  ) => Promise<KernelPageScan | null>;
  readonly scan: (
    runtime?: RuntimeExecutionAuthorization,
  ) => Promise<KernelPageScan | null>;
  readonly fill: (input: KernelFillInput) => Promise<readonly ReceiptFieldOutcome[]>;
  /** Exact synchronous origin/path fence used before submission-arm or fill work. */
  readonly isCurrentScanTarget: (scan: KernelPageScan) => boolean;
  /** Exact observer/seal generation fence; false or throwing is stale. */
  readonly isScanFresh: (scan: KernelPageScan) => boolean;
  /**
   * Re-runs the authorized path/form scan without activating its observer.
   * The bridge activates the candidate only after its retained-scan CAS and
   * exact digest/runtime comparison have both succeeded.
   */
  readonly revalidateScan: (
    scan: KernelPageScan,
    runtime?: RuntimeExecutionAuthorization,
  ) => Promise<RevalidatedScanCandidate | null>;
  /** Installs the synchronous native-submit blocker before any SUBMIT fill. */
  readonly armSubmission?: (
    descriptor: SubmissionArmDescriptor,
    scan: KernelPageScan,
  ) => boolean;
}

export interface RevalidatedScanCandidate {
  readonly scan: KernelPageScan;
  /** Commits this exact observer/scan generation. False means fail closed. */
  readonly activate: () => boolean;
  /** Idempotently retires an unaccepted (or just-failed) generation. */
  readonly dispose: () => void;
}

/** 跨端口留存：SW 每次连接都是新 port，但页面扫描状态属于页面本身。 */
let lastScan: KernelPageScan | null = null;
let scanRequestRevision = 0;

/** 仅测试用：隔离用例间的模块级状态。 */
export function resetContentBridgeStateForTests(): void {
  lastScan = null;
  scanRequestRevision = 0;
}

/**
 * Invalidates only the exact live scan object an authorized observer was
 * armed for. Digest equality is insufficient: two scans with the same
 * origin/path/vendor/field-key set intentionally have the same digest.
 */
export function invalidateRetainedContentScan(scan: KernelPageScan): boolean {
  if (lastScan !== scan) return false;
  lastScan = null;
  return true;
}

/**
 * Authority-wide invalidation used when the local runtime bundle changes or
 * disappears. It also fences an in-flight bridge/scan from restoring state.
 */
export function invalidateRetainedContentScanState(): void {
  scanRequestRevision += 1;
  lastScan = null;
}

export function handleKernelBridgePort(port: BridgePortLike, deps: ContentBridgeDeps): void {
  const stopped = new Set<string>();
  let portAlive = true;
  port.onDisconnect.addListener(() => {
    portAlive = false;
  });
  const send = (event: BridgeEvent) => {
    if (!portAlive) return;
    try {
      port.postMessage(event);
    } catch {
      portAlive = false;
    }
  };

  port.onMessage.addListener((raw) => {
    const request = parseBridgeRequest(raw);
    if (!request) return; // 畸形帧丢弃；桥上不猜。

    if (request.kind === 'bridge/stop') {
      stopped.add(request.requestId);
      return;
    }

    if (request.kind === 'bridge/discovery-scan') {
      void (async () => {
        let scan: KernelPageScan | null = null;
        try {
          scan = await deps.discover?.(request.runtime) ?? null;
        } catch {
          scan = null;
        }
        if (
          scan !== null &&
          (!runtimeBindingMatches(scan.runtimeAuthorization, request.runtime) ||
            !safeCurrentTargetMatch(deps, scan))
        ) scan = null;
        // Deliberately do not assign lastScan: a discovery authorization can
        // never become a fill/submission descriptor, even if policy later
        // changes in the same content-script lifetime.
        send({
          kind: 'bridge/discovery-result',
          requestId: request.requestId,
          scan: scan === null
            ? null
            : {
                jobId: scan.jobId,
                canonicalOrigin: scan.canonicalOrigin,
                fieldKeys: scan.fieldKeys,
                scanDigest: scan.scanDigest,
              },
        });
      })();
      return;
    }

    if (request.kind === 'bridge/scan') {
      const requestRevision = ++scanRequestRevision;
      // A new scan attempt immediately retires the previously retained page.
      // Do not leave an old descriptor fillable while authority/DOM refresh is
      // still unresolved.
      lastScan = null;
      void (async () => {
        let scan: KernelPageScan | null = null;
        try {
          scan = await deps.scan(request.runtime);
        } catch {
          scan = null; // 扫描炸了 = 认不出 → 上游停 RESCAN_MISMATCH。
        }
        const isNewestRequest = requestRevision === scanRequestRevision;
        const freshScan = scan !== null && safeScanFresh(deps, scan) ? scan : null;
        if (isNewestRequest) lastScan = freshScan;
        const responseScan = isNewestRequest ? freshScan : null;
        send({
          kind: 'bridge/scan-result',
          requestId: request.requestId,
          scan: responseScan
            ? {
                jobId: responseScan.jobId,
                canonicalOrigin: responseScan.canonicalOrigin,
                fieldKeys: responseScan.fieldKeys,
                scanDigest: responseScan.scanDigest,
              }
            : null,
        });
      })();
      return;
    }

    if (request.kind === 'bridge/revalidate-scan') {
      void (async () => {
        const scan = lastScan;
        let accepted = false;
        if (
          scan !== null &&
          scan.scanDigest === request.scanDigest &&
          scan.canonicalOrigin === request.canonicalOrigin &&
          scan.jobId === request.pathname &&
          runtimeBindingMatches(scan.runtimeAuthorization, request.runtime) &&
          safeCurrentTargetMatch(deps, scan) &&
          safeScanFresh(deps, scan)
        ) {
          const candidate = await safeRevalidateScan(deps, scan, request.runtime);
          if (
            lastScan === scan &&
            candidate !== null &&
            sameRetainedScan(scan, candidate.scan)
          ) {
            const refreshed = activateRevalidatedScan(deps, candidate);
            if (refreshed !== null && lastScan === scan) {
              lastScan = refreshed;
              accepted = true;
            } else if (lastScan === scan) {
              lastScan = null;
            }
          } else if (lastScan === scan) {
            safeDisposeCandidate(candidate);
            lastScan = null;
          } else {
            safeDisposeCandidate(candidate);
          }
        }
        send({
          kind: 'bridge/revalidate-scan-result',
          requestId: request.requestId,
          accepted,
        });
      })();
      return;
    }

    if (request.kind === 'bridge/submission-arm') {
      let accepted = false;
      try {
        const scan = lastScan;
        accepted = scan !== null &&
          scan.scanDigest === request.scanDigest &&
          safeCurrentTargetMatch(deps, scan) &&
          safeScanFresh(deps, scan) &&
          deps.armSubmission?.(request.descriptor, scan) === true;
      } catch {
        accepted = false;
      }
      send({
        kind: 'bridge/submission-arm-result',
        requestId: request.requestId,
        accepted,
      });
      return;
    }

    // bridge/fill
    void (async () => {
      const scan = lastScan;
      // 没有在册扫描，或帧里的 scanDigest 不是本页最近那次扫描（并发 run
      // 交错/页面导航后重扫）——claim 绑定的不变量破了，一个字段都不碰。
      if (!scan || scan.scanDigest !== request.scanDigest || !safeScanFresh(deps, scan)) {
        const outcomes = request.grant.fieldKeys.map<ReceiptFieldOutcome>((key) => ({
          key,
          ok: false,
          reason: 'DETACHED',
        }));
        send({ kind: 'bridge/fill-result', requestId: request.requestId, outcomes });
        return;
      }
      const retainedRuntime = scan.runtimeAuthorization;
      const requestedRuntime = request.runtime;
      if (!runtimeBindingMatches(retainedRuntime, requestedRuntime)) {
        const outcomes = request.grant.fieldKeys.map<ReceiptFieldOutcome>((key) => ({
          key,
          ok: false,
          reason: 'POLICY_DISABLED',
        }));
        send({ kind: 'bridge/fill-result', requestId: request.requestId, outcomes });
        return;
      }
      if (!safeCurrentTargetMatch(deps, scan)) {
        sendDetachedResult(send, request.requestId, request.grant.fieldKeys);
        return;
      }
      const candidate = await safeRevalidateScan(deps, scan, requestedRuntime);
      if (
        lastScan !== scan ||
        candidate === null ||
        !sameRetainedScan(scan, candidate.scan)
      ) {
        safeDisposeCandidate(candidate);
        if (lastScan === scan) lastScan = null;
        sendDetachedResult(send, request.requestId, request.grant.fieldKeys);
        return;
      }
      const refreshedScan = activateRevalidatedScan(deps, candidate);
      if (refreshedScan === null || lastScan !== scan) {
        if (lastScan === scan) lastScan = null;
        sendDetachedResult(send, request.requestId, request.grant.fieldKeys);
        return;
      }
      lastScan = refreshedScan;
      const resume = decodeBridgeResume(request.resume);
      let outcomes: readonly ReceiptFieldOutcome[];
      try {
        outcomes = await deps.fill({
          grant: request.grant,
          scan: refreshedScan,
          profile: request.profile,
          ...(requestedRuntime ? { runtimeAuthorization: requestedRuntime } : {}),
          ...(resume === undefined ? {} : { resume }),
          progress: {
            onOutcome: (outcome) =>
              send({ kind: 'bridge/fill-outcome', requestId: request.requestId, outcome }),
            onNeedsUserInput: (inputKind, fieldKey) =>
              send(
                fieldKey === undefined
                  ? { kind: 'bridge/needs-user-input', requestId: request.requestId, inputKind }
                  : { kind: 'bridge/needs-user-input', requestId: request.requestId, inputKind, fieldKey },
              ),
            shouldStop: () => !portAlive || stopped.has(request.requestId),
          },
        });
      } catch {
        // 执行链裸抛也要有稳定收尾（与协调器同姿势，不读 Error 本体）。
        outcomes = request.grant.fieldKeys.map<ReceiptFieldOutcome>((key) => ({
          key,
          ok: false,
          reason: 'ABORTED',
        }));
      }
      send({ kind: 'bridge/fill-result', requestId: request.requestId, outcomes });
    })();
  });
}

/**
 * Rebuilds the supplied bytes as an in-memory File for the kernel's resume seam. The bridge
 * accepted this frame only with the runtime binding retained by the exact scan, and the
 * background attached bytes only after the canonical target was verified, so the seam's
 * target fact holds. A size mismatch means no file at all; nothing is stored anywhere.
 */
function decodeBridgeResume(resume: BridgeResumeFile | undefined): KernelFillInput['resume'] | undefined {
  if (resume === undefined) return undefined;
  const bytes = decodeBase64(resume.bytesBase64);
  if (bytes === null || bytes.byteLength !== resume.size) return undefined;
  const file = new File([bytes], resume.fileName, { type: 'application/pdf' });
  return { fileName: resume.fileName, targetVerified: true, resolve: async () => file };
}

function runtimeBindingMatches(
  retained: RuntimeExecutionAuthorization | undefined,
  requested: RuntimeExecutionAuthorization | undefined,
): boolean {
  return retained === undefined
    ? requested === undefined
    : requested !== undefined && sameRuntimeExecutionAuthorization(retained, requested);
}

function safeCurrentTargetMatch(deps: ContentBridgeDeps, scan: KernelPageScan): boolean {
  try {
    return deps.isCurrentScanTarget(scan) === true;
  } catch {
    return false;
  }
}

function safeScanFresh(deps: ContentBridgeDeps, scan: KernelPageScan): boolean {
  try {
    return deps.isScanFresh(scan) === true;
  } catch {
    return false;
  }
}

async function safeRevalidateScan(
  deps: ContentBridgeDeps,
  scan: KernelPageScan,
  runtime: RuntimeExecutionAuthorization | undefined,
): Promise<RevalidatedScanCandidate | null> {
  try {
    return await deps.revalidateScan(scan, runtime);
  } catch {
    return null;
  }
}

function activateRevalidatedScan(
  deps: ContentBridgeDeps,
  candidate: RevalidatedScanCandidate,
): KernelPageScan | null {
  let activated = false;
  try {
    activated = candidate.activate() === true;
  } catch {
    activated = false;
  }
  if (!activated || !safeScanFresh(deps, candidate.scan)) {
    safeDisposeCandidate(candidate);
    return null;
  }
  return candidate.scan;
}

function safeDisposeCandidate(candidate: RevalidatedScanCandidate | null | undefined): void {
  if (candidate == null) return;
  try {
    candidate.dispose();
  } catch {
    // Disposal is a local safety action. A throwing host adapter must not turn
    // an already-rejected generation back into an accepted bridge result.
  }
}

function sameRetainedScan(
  retained: KernelPageScan,
  refreshed: KernelPageScan | null | undefined,
): refreshed is KernelPageScan {
  return refreshed != null &&
    refreshed.scanDigest === retained.scanDigest &&
    refreshed.canonicalOrigin === retained.canonicalOrigin &&
    refreshed.jobId === retained.jobId &&
    runtimeBindingMatches(retained.runtimeAuthorization, refreshed.runtimeAuthorization) &&
    refreshed.runtimeFreshUntilMs === retained.runtimeFreshUntilMs &&
    refreshed.runtimeNotAfterMs === retained.runtimeNotAfterMs;
}

function sendDetachedResult(
  send: (event: BridgeEvent) => void,
  requestId: string,
  fieldKeys: readonly string[],
): void {
  send({
    kind: 'bridge/fill-result',
    requestId,
    outcomes: fieldKeys.map<ReceiptFieldOutcome>((key) => ({
      key,
      ok: false,
      reason: 'DETACHED',
    })),
  });
}
