import type { PilotUa1PageBinding } from '@edaix/contracts/draft';
import {
  PILOT_UA5_CONTROLLED_LOCAL_ORIGIN,
  PILOT_UA5_CONTROLLED_LOCAL_PATHNAME,
} from '../lib/pilotUa5ControlledLocalAdmission';

const REQUEST_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LEASE_MS = 120_000;

export type PilotUa5ExactPageFacts = Readonly<{
  tabId: number;
  origin: string;
  pathname: string;
  targetUrlDigest: string;
  pageEpoch: number;
}>;

type Lease = PilotUa5ExactPageFacts & Readonly<{ expiresAtMs: number }>;
type Run = Lease & {
  requestId: string;
  retireAtMs: number;
  domGeneration: string | null;
  settled: boolean;
};
type TabRecord = { pending?: Lease; run?: Run };

function validFacts(facts: PilotUa5ExactPageFacts): boolean {
  return Number.isSafeInteger(facts.tabId) && facts.tabId >= 0 &&
    Number.isSafeInteger(facts.pageEpoch) && facts.pageEpoch >= 0 &&
    ((facts.origin === 'https://job-boards.greenhouse.io' &&
      /^\/[A-Za-z0-9._~-]+\/jobs\/[1-9][0-9]{0,19}$/u.test(facts.pathname)) ||
      (facts.origin === PILOT_UA5_CONTROLLED_LOCAL_ORIGIN &&
        facts.pathname === PILOT_UA5_CONTROLLED_LOCAL_PATHNAME)) &&
    SHA256.test(facts.targetUrlDigest);
}

function sameFacts(lease: Lease, facts: PilotUa5ExactPageFacts): boolean {
  return lease.tabId === facts.tabId && lease.origin === facts.origin &&
    lease.pathname === facts.pathname && lease.targetUrlDigest === facts.targetUrlDigest &&
    lease.pageEpoch === facts.pageEpoch;
}

export function createPilotUa5ExactPageLeaseRegistry(input: Readonly<{
  now?: () => number;
  leaseMs?: number;
}> = {}) {
  const now = input.now ?? Date.now;
  const leaseMs = input.leaseMs ?? 60_000;
  const tabs = new Map<number, TabRecord>();
  let highWaterMs = 0;
  let clockRevoked = false;
  const currentTime = (): number | null => {
    if (clockRevoked) return null;
    let time: number;
    try { time = now(); } catch { time = NaN; }
    if (!Number.isSafeInteger(time) || time < highWaterMs) {
      clockRevoked = true;
      tabs.clear();
      return null;
    }
    highWaterMs = time;
    for (const [tabId, record] of tabs) {
      if (record.pending !== undefined && time >= record.pending.expiresAtMs) delete record.pending;
      if (record.run !== undefined && time >= record.run.retireAtMs) delete record.run;
      if (record.pending === undefined && record.run === undefined) tabs.delete(tabId);
    }
    return time;
  };
  const findRun = (requestId: string): TabRecord | undefined =>
    [...tabs.values()].find((record) => record.run?.requestId === requestId);
  const authorizeActive = (
    facts: PilotUa5ExactPageFacts,
    requestId: string,
    binding?: PilotUa1PageBinding,
  ): number | null => {
    const time = currentTime();
    const record = findRun(requestId);
    const run = record?.run;
    if (time === null || run === undefined || run.settled) return null;
    if (!sameFacts(run, facts) || (binding !== undefined && (
      binding.origin !== run.origin || binding.pathname !== run.pathname ||
      !SHA256.test(binding.domGeneration) ||
      (run.domGeneration !== null && run.domGeneration !== binding.domGeneration)
    ))) {
      delete record!.run;
      return null;
    }
    if (time >= run.expiresAtMs) return null;
    if (binding !== undefined) run.domGeneration = binding.domGeneration;
    return run.expiresAtMs;
  };
  const hasRecovery = (facts: PilotUa5ExactPageFacts, requestId: string): boolean => {
    const time = currentTime();
    const run = tabs.get(facts.tabId)?.run;
    return time !== null && run !== undefined && run.requestId === requestId &&
      run.settled && run.domGeneration !== null && sameFacts(run, facts) && time < run.retireAtMs;
  };

  return Object.freeze({
    currentTime,
    arm(facts: PilotUa5ExactPageFacts): boolean {
      const time = currentTime();
      if (time === null || !validFacts(facts) || !Number.isSafeInteger(leaseMs) ||
          leaseMs <= 0 || leaseMs > MAX_LEASE_MS || !Number.isSafeInteger(time + leaseMs)) return false;
      const record = tabs.get(facts.tabId) ?? {};
      record.pending = Object.freeze({ ...facts, expiresAtMs: time + leaseMs });
      tabs.set(facts.tabId, record);
      return true;
    },
    hasPending(facts: PilotUa5ExactPageFacts): boolean {
      const time = currentTime();
      const pending = tabs.get(facts.tabId)?.pending;
      return time !== null && pending !== undefined && sameFacts(pending, facts);
    },
    consumePending(facts: PilotUa5ExactPageFacts, requestId: string): boolean {
      const time = currentTime();
      const record = tabs.get(facts.tabId);
      if (time === null || record?.pending === undefined || !REQUEST_ID.test(requestId) ||
          findRun(requestId) !== undefined || !sameFacts(record.pending, facts) ||
          (record.run !== undefined && !record.run.settled) ||
          !Number.isSafeInteger(time + 2 * leaseMs)) return false;
      delete record.pending;
      // A replacement run consumes the gesture and retires older recovery.
      record.run = { ...facts, requestId, expiresAtMs: time + leaseMs,
        retireAtMs: time + 2 * leaseMs, domGeneration: null, settled: false };
      return true;
    },
    revalidateActive(facts: PilotUa5ExactPageFacts, requestId: string, binding?: PilotUa1PageBinding): boolean {
      return authorizeActive(facts, requestId, binding) !== null;
    },
    authorizeActive,
    finishRun(requestId: string, keepUndo: boolean): boolean {
      if (currentTime() === null) return false;
      const record = findRun(requestId);
      const run = record?.run;
      if (run === undefined || run.settled) return false;
      if (!keepUndo || run.domGeneration === null) {
        delete record!.run;
        return !keepUndo;
      }
      // Settlement retires forward authority. It does not start a new TTL.
      run.settled = true;
      return true;
    },
    hasRecovery,
    consumeUndo(facts: PilotUa5ExactPageFacts, requestId: string): boolean {
      if (!hasRecovery(facts, requestId)) return false;
      delete tabs.get(facts.tabId)!.run;
      return true;
    },
    revokeRun(requestId: string): void {
      const record = findRun(requestId);
      if (record !== undefined) delete record.run;
    },
    revokeTab(tabId: number): void { tabs.delete(tabId); },
    revokeAll(): void { tabs.clear(); },
  });
}
