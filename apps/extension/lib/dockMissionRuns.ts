/**
 * One dock run on a Mission-bound page, recorded the way the backend records every
 * execution (2026-09-24, argoland ADR-024 chain; owner decision D1):
 *
 *   Start approval (the scanned keys) → intent issue + local verification → claim (the same
 *   keys) → the dock fills with its gesture engine → receipt for the claimed keys.
 *
 * The fill itself never waits on this and never depends on it: the gesture engine fills on
 * the user's own click, exactly as on a page with no Mission. What the Mission adds is the
 * server-verified record of the run -- the portal shows 已填好 from the receipt -- and the
 * tailored materials. So every failure here is a stable diagnostic code and a run without
 * a lease, never a blocked fill.
 *
 * The execution lease never leaves the worker: the content script holds an opaque ticket.
 */

import type { IntentAcquirer, IntentClaimer } from '@edaix/agent-channel';
import { APPLICATION_PROFILE_FIELD_KEYS, type MissionPageBindingV1 } from '@edaix/contracts';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import { sha256CanonicalJson } from './canonicalDigest';
import type { MissionDockClient } from './missionDockClient';
import { dockReceiptFieldResults } from './receiptClient';

/** The page a run is for, as the worker verified it against the sender. */
export type DockMissionPage = Readonly<{ canonicalOrigin: string; pathname: string }>;

export type DockMissionRunBegin = Readonly<{
  /** Canonical Profile keys the scan found on this page (the claim compares them exactly). */
  fieldKeys: readonly string[];
  /** The runtime vendor the scan resolved; part of the scan digest the claim checks. */
  vendor: string;
}>;

export type DockMissionRunStart =
  | Readonly<{ kind: 'MISSION_RUN'; ticket: string; missionId: string }>
  | Readonly<{ kind: 'NO_RUN'; code: string }>;

export interface DockMissionRuns {
  begin(tabId: number, page: DockMissionPage, run: DockMissionRunBegin): Promise<DockMissionRunStart>;
  /** `tabId`: the sender's tab; a ticket another tab opened is unknown here. */
  finish(ticket: string, outcomes: readonly ReceiptFieldOutcome[], tabId: number): Promise<boolean>;
  /** The open run of a tab, if any (a new run, a page change or a closed tab drops it). */
  forgetTab(tabId: number): void;
}

export interface DockMissionRunsDeps {
  /** The Mission this tab's page is bound to (the worker's per-tab cache), or null. */
  readonly bindingFor: (tabId: number, page: DockMissionPage) => Promise<MissionPageBindingV1 | null>;
  readonly missions: Pick<MissionDockClient, 'startApproval'>;
  readonly acquirer: IntentAcquirer;
  readonly claimer: IntentClaimer;
  readonly uploadReceipt: (input: Readonly<{
    grant: ClaimedGrant;
    fieldResults: ReturnType<typeof dockReceiptFieldResults>;
    startedAt: Date;
    finishedAt: Date;
  }>) => Promise<boolean>;
  /** Only stable codes (RULE-GLOBAL-DATA-L1). */
  readonly onDiagnostic?: (code: string) => void;
  readonly newTicket?: () => string;
  readonly now?: () => number;
}

type ClaimedGrant = Readonly<{
  missionId: string;
  missionStepId: string;
  intentVersion: number;
  executionLease: string;
  planDigest: string;
  jobIdentityHash: string;
  fieldKeys: readonly string[];
}>;

type OpenRun = Readonly<{
  tabId: number;
  grant: ClaimedGrant;
  startedAt: number;
}>;

/** Vendors the scan digest may name; anything else is not a page the dock scanned. */
const VENDOR_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const PROFILE_KEYS: ReadonlySet<string> = new Set(APPLICATION_PROFILE_FIELD_KEYS);

export function createDockMissionRuns(deps: DockMissionRunsDeps): DockMissionRuns {
  const now = deps.now ?? (() => Date.now());
  const newTicket = deps.newTicket ?? (() => crypto.randomUUID());
  const runs = new Map<string, OpenRun>();
  const diag = (code: string): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // The diagnostic ring breaking must not break a run.
    }
  };
  const noRun = (code: string): DockMissionRunStart => {
    diag(`DOCK_MISSION_${code}`);
    return Object.freeze({ kind: 'NO_RUN', code });
  };

  const forgetTab = (tabId: number): void => {
    for (const [ticket, run] of runs) if (run.tabId === tabId) runs.delete(ticket);
  };

  const api: DockMissionRuns = {
    forgetTab,

    async begin(tabId, page, run) {
      try {
        // One open run per tab: a new click supersedes an unfinished one.
        forgetTab(tabId);
        const binding = await deps.bindingFor(tabId, page);
        if (binding === null) return noRun('UNBOUND');
        if (binding.startApproval !== 'AVAILABLE') return noRun(`START_${binding.startApproval}`);
        if (!VENDOR_TOKEN.test(run.vendor)) return noRun('VENDOR_INVALID');
        // Only canonical Profile keys can be approved: the backend refuses the whole request
        // over one key it does not know, so a row key the runtime rules also allow
        // (`education.school`, `resumeFile`) is left out here rather than costing the run.
        const scanned = [...new Set(run.fieldKeys)].filter((key) => PROFILE_KEYS.has(key)).sort();
        if (scanned.length === 0) return noRun('NO_KEYS');

        const approved = await deps.missions.startApproval(binding, scanned);
        if (!approved.ok) return noRun(`APPROVAL_${approved.code}`);
        const approval = approved.approval;

        const acquired = await deps.acquirer.acquire({
          clientRequestId: newTicket(),
          missionId: approval.mission.id,
          missionStepId: approval.approval.stepId,
          missionRevision: approval.mission.revision,
        });
        if (!acquired.ok) return noRun('INTENT_UNAVAILABLE');

        // The claim compares the approved keys with the page exactly, and the scan digest
        // with the same keys: computed here for the approved set (it may be a subset of what
        // the page showed when the runtime policy allows fewer keys).
        const fieldKeys: readonly string[] = approval.approval.fieldKeys;
        const scanDigest = await sha256CanonicalJson({
          schemaVersion: 1,
          canonicalOrigin: page.canonicalOrigin,
          pathname: page.pathname,
          vendor: run.vendor,
          fieldKeys,
        });
        const claimed = await deps.claimer.claim({
          intent: acquired.intent,
          actualOrigin: page.canonicalOrigin,
          actualFieldKeys: fieldKeys,
          scanDigest,
        });
        if (!claimed.ok) return noRun(`CLAIM_${claimed.code}`);
        const grant: ClaimedGrant = Object.freeze({
          missionId: claimed.grant.missionId,
          missionStepId: claimed.grant.missionStepId,
          intentVersion: claimed.grant.intentVersion,
          executionLease: claimed.grant.executionLease,
          planDigest: claimed.grant.planDigest,
          jobIdentityHash: claimed.grant.jobIdentityHash,
          fieldKeys: [...claimed.grant.fieldKeys],
        });
        const ticket = newTicket();
        runs.set(ticket, Object.freeze({ tabId, grant, startedAt: now() }));
        diag('DOCK_MISSION_RUN_CLAIMED');
        return Object.freeze({ kind: 'MISSION_RUN', ticket, missionId: grant.missionId });
      } catch {
        return noRun('THREW');
      }
    },

    async finish(ticket, outcomes, tabId) {
      const run = runs.get(ticket);
      if (run === undefined || run.tabId !== tabId) {
        diag('DOCK_MISSION_RUN_UNKNOWN');
        return false;
      }
      runs.delete(ticket);
      try {
        const fieldResults = dockReceiptFieldResults(run.grant.fieldKeys, outcomes);
        const sent = await deps.uploadReceipt({
          grant: run.grant,
          fieldResults,
          startedAt: new Date(run.startedAt),
          finishedAt: new Date(Math.max(run.startedAt, now())),
        });
        diag(sent ? 'DOCK_MISSION_RECEIPT_SENT' : 'DOCK_MISSION_RECEIPT_FAILED');
        return sent;
      } catch {
        diag('DOCK_MISSION_RECEIPT_THREW');
        return false;
      }
    },
  };
  return Object.freeze(api);
}
