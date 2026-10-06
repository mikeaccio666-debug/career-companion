/**
 * Read-only application discovery coordinator.
 *
 * This lane is deliberately separate from createRunCoordinator: it has no
 * issuer, claim, profile, fill, receipt, or submit dependency. The extension
 * first resolves a fresh owner-scoped canonical target, then asks a scanner
 * which must bind the backend runtime mapping and exact target tab.
 */

import type {
  ApplicationProfileFieldKey,
  ExecutionRuntimeActiveVendor,
  ExecutionRuntimeMappedAtsProvider,
  MissionApplicationTargetView,
} from '@edaix/contracts';
import {
  CHANNEL_PROTOCOL_VERSION,
  parseChannelMessage,
  type ChannelErrorCode,
  type DiscoveryUnavailableCode,
} from '@edaix/contracts/draft';
import type { ChannelTransport } from './transport';

export interface DiscoveryStartRef {
  readonly clientRequestId: string;
  readonly missionId: string;
  readonly missionRevision: string;
}

export interface VerifiedApplicationTarget
  extends Omit<MissionApplicationTargetView, 'atsProvider'> {
  readonly atsProvider: ExecutionRuntimeMappedAtsProvider;
}

export interface DiscoveryTargetResolver {
  resolve(ref: DiscoveryStartRef): Promise<
    | { readonly ok: true; readonly target: VerifiedApplicationTarget }
    | { readonly ok: false; readonly code: 'TARGET_UNAVAILABLE' }
  >;
}

export interface ReadOnlyDiscoveryScanner {
  scan(target: VerifiedApplicationTarget): Promise<
    | {
        readonly ok: true;
        readonly vendor: ExecutionRuntimeActiveVendor;
        readonly fieldKeys: readonly ApplicationProfileFieldKey[];
      }
    | {
        readonly ok: false;
        readonly code: Exclude<DiscoveryUnavailableCode, 'TARGET_UNAVAILABLE'>;
      }
  >;
}

export interface DiscoveryCoordinatorDeps {
  readonly transport: ChannelTransport;
  /** Extension-side, per-port one-time capability grant. */
  readonly authorizeStart: (ref: DiscoveryStartRef) => boolean;
  readonly targetResolver: DiscoveryTargetResolver;
  readonly scanner: ReadOnlyDiscoveryScanner;
  readonly onProtocolError?: (code: ChannelErrorCode) => void;
  readonly now?: () => number;
}

export interface DiscoveryCoordinator {
  dispose(): void;
}

const V = CHANNEL_PROTOCOL_VERSION;

export function createDiscoveryCoordinator(
  deps: DiscoveryCoordinatorDeps,
): DiscoveryCoordinator {
  let disposed = false;
  const now = deps.now ?? Date.now;

  const sendUnavailable = (
    ref: DiscoveryStartRef,
    code: DiscoveryUnavailableCode,
  ): void => {
    if (disposed) return;
    deps.transport.send({
      v: V,
      kind: 'discovery/result',
      ...ref,
      status: 'UNAVAILABLE',
      code,
    });
  };

  const handleStart = async (ref: DiscoveryStartRef): Promise<void> => {
    let authorized = false;
    try {
      authorized = deps.authorizeStart(ref);
    } catch {
      authorized = false;
    }
    if (!authorized) return sendUnavailable(ref, 'RUNTIME_UNAVAILABLE');

    let resolved: Awaited<ReturnType<DiscoveryTargetResolver['resolve']>>;
    try {
      resolved = await deps.targetResolver.resolve(ref);
    } catch {
      return sendUnavailable(ref, 'TARGET_UNAVAILABLE');
    }
    if (disposed) return;
    if (
      !resolved.ok ||
      resolved.target.missionRevision !== ref.missionRevision ||
      !isTargetFresh(resolved.target, now())
    ) {
      return sendUnavailable(ref, 'TARGET_UNAVAILABLE');
    }

    let scanned: Awaited<ReturnType<ReadOnlyDiscoveryScanner['scan']>>;
    try {
      scanned = await deps.scanner.scan(resolved.target);
    } catch {
      return sendUnavailable(ref, 'SCAN_UNAVAILABLE');
    }
    if (disposed) return;
    if (!scanned.ok) return sendUnavailable(ref, scanned.code);

    // A scan can take seconds. Resolve the no-store owner authority again and
    // compare every target fence before projecting AVAILABLE. This prevents a
    // canonical URL, mapping, policy or revision that changed/expired during
    // the scan from being reported as current.
    let revalidated: Awaited<ReturnType<DiscoveryTargetResolver['resolve']>>;
    try {
      revalidated = await deps.targetResolver.resolve(ref);
    } catch {
      return sendUnavailable(ref, 'TARGET_UNAVAILABLE');
    }
    if (
      disposed ||
      !revalidated.ok ||
      !sameVerifiedTarget(resolved.target, revalidated.target) ||
      !isTargetFresh(revalidated.target, now())
    ) return sendUnavailable(ref, 'TARGET_UNAVAILABLE');

    const result = {
      v: V,
      kind: 'discovery/result',
      ...ref,
      status: 'AVAILABLE',
      canonicalOrigin: resolved.target.canonicalOrigin,
      pathname: resolved.target.pathname,
      vendor: scanned.vendor,
      freshUntil: revalidated.target.freshUntil,
      fieldKeys: [...scanned.fieldKeys],
    } as const;
    // Treat dependency output as hostile too. A malformed vendor/path/key list
    // becomes one stable unavailable result rather than crossing the channel.
    if (!parseChannelMessage(result).ok) return sendUnavailable(ref, 'SCAN_UNAVAILABLE');
    deps.transport.send(result);
  };

  const unsubscribe = deps.transport.onMessage((raw) => {
    if (disposed) return;
    const parsed = parseChannelMessage(raw);
    if (!parsed.ok) {
      deps.onProtocolError?.(parsed.code);
      return;
    }
    if (parsed.value.kind !== 'discovery/start') return;
    void handleStart({
      clientRequestId: parsed.value.clientRequestId,
      missionId: parsed.value.missionId,
      missionRevision: parsed.value.missionRevision,
    });
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

function isTargetFresh(target: VerifiedApplicationTarget, now: number): boolean {
  const verifiedAt = Date.parse(target.verifiedAt);
  const freshUntil = Date.parse(target.freshUntil);
  return Number.isFinite(now) &&
    Number.isFinite(verifiedAt) &&
    Number.isFinite(freshUntil) &&
    verifiedAt <= now &&
    freshUntil > now &&
    freshUntil > verifiedAt;
}

function sameVerifiedTarget(
  before: VerifiedApplicationTarget,
  after: VerifiedApplicationTarget,
): boolean {
  return before.canonicalOrigin === after.canonicalOrigin &&
    before.missionRevision === after.missionRevision &&
    before.pathname === after.pathname &&
    before.atsProvider === after.atsProvider &&
    before.pathRuleId === after.pathRuleId &&
    before.verifierVersion === after.verifierVersion &&
    before.verifiedAt === after.verifiedAt &&
    before.freshUntil === after.freshUntil &&
    before.policyVersion === after.policyVersion &&
    before.revision === after.revision;
}
