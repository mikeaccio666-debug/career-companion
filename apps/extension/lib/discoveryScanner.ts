/** Exact-tab, runtime-authorized, read-only application form discovery. */

import type {
  ReadOnlyDiscoveryScanner,
  VerifiedApplicationTarget,
} from '@edaix/agent-channel';
import {
  APPLICATION_PROFILE_FIELD_KEYS,
  type ApplicationProfileFieldKey,
} from '@edaix/contracts';
import {
  parseBridgeEvent,
  type BridgePortLike,
  type BridgeRequest,
} from './bridgeProtocol';
import type {
  BackgroundExecutionRuntimeAuthority,
  DiscoveryRuntimeAuthorization,
} from './executionRuntimeAuthority';
import {
  selectExactApplicationTab,
  type RegisteredApplicationTab,
} from './tabRegistry';

export interface ExactTabDiscoveryScannerDeps {
  readonly runtimeAuthority: Pick<
    BackgroundExecutionRuntimeAuthority,
    'authorizeDiscovery' | 'revalidate'
  >;
  readonly queryTabs: () => Promise<readonly RegisteredApplicationTab[]>;
  readonly connectToTab: (tabId: number) => BridgePortLike;
  readonly timeoutMs?: number;
  readonly newRequestId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
type ReadOnlyBridgeScan = Readonly<{
  jobId: string;
  canonicalOrigin: string;
  fieldKeys: readonly string[];
}>;
const DISCOVERY_FIELD_KEYS: ReadonlySet<string> = new Set(APPLICATION_PROFILE_FIELD_KEYS);

export function createExactTabDiscoveryScanner(
  deps: ExactTabDiscoveryScannerDeps,
): ReadOnlyDiscoveryScanner {
  let requestSequence = 0;
  const newRequestId = deps.newRequestId ?? (() => `discovery_bridge_${++requestSequence}`);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    async scan(target: VerifiedApplicationTarget) {
      let authorization: DiscoveryRuntimeAuthorization;
      try {
        const result = await deps.runtimeAuthority.authorizeDiscovery({
          atsProvider: target.atsProvider,
          pathRuleId: target.pathRuleId,
        });
        if (!result.ok) return { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const };
        authorization = result.value;
      } catch {
        return { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const };
      }
      if (
        authorization.atsProvider !== target.atsProvider ||
        authorization.pathRuleId !== target.pathRuleId
      ) return { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const };

      let tab: RegisteredApplicationTab | null;
      try {
        tab = selectExactApplicationTab(
          await deps.queryTabs(),
          target.canonicalOrigin,
          target.pathname,
        );
      } catch {
        tab = null;
      }
      if (tab === null) return { ok: false as const, code: 'TAB_UNAVAILABLE' as const };

      const requestId = newRequestId();
      const scan = await new Promise<ReadOnlyBridgeScan | null>((resolve) => {
        let settled = false;
        let port: BridgePortLike;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (value: ReadOnlyBridgeScan | null) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          try {
            port.disconnect();
          } catch {
            // A disconnected tab is an unavailable scan.
          }
          resolve(value);
        };
        try {
          port = deps.connectToTab(tab!.tabId);
        } catch {
          resolve(null);
          return;
        }
        timer = setTimeout(() => settle(null), timeoutMs);
        port.onDisconnect.addListener(() => settle(null));
        port.onMessage.addListener((raw) => {
          const event = parseBridgeEvent(raw);
          if (event?.kind === 'bridge/discovery-result' && event.requestId === requestId) {
            settle(event.scan);
          }
        });
        port.postMessage({
          kind: 'bridge/discovery-scan',
          requestId,
          runtime: authorization,
        } satisfies BridgeRequest);
      });

      if (
        scan === null ||
        scan.canonicalOrigin !== target.canonicalOrigin ||
        scan.jobId !== target.pathname ||
        !isCanonicalFieldKeys(scan.fieldKeys)
      ) return { ok: false as const, code: 'SCAN_UNAVAILABLE' as const };

      try {
        if (!(await deps.runtimeAuthority.revalidate(authorization))) {
          return { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const };
        }
      } catch {
        return { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const };
      }
      return Object.freeze({
        ok: true as const,
        vendor: authorization.vendor,
        fieldKeys: Object.freeze([...scan.fieldKeys]),
      });
    },
  });
}

function isCanonicalFieldKeys(
  value: readonly string[],
): value is readonly ApplicationProfileFieldKey[] {
  if (value.length > APPLICATION_PROFILE_FIELD_KEYS.length) return false;
  let previous: string | undefined;
  for (const key of value) {
    if (
      !DISCOVERY_FIELD_KEYS.has(key) ||
      (previous !== undefined && previous >= key)
    ) return false;
    previous = key;
  }
  return true;
}
