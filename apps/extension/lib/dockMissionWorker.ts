/**
 * Worker side of the dock Mission wiring (2026-09-24), kept out of `background.ts` so it can
 * be exercised end to end: which Mission a tab's page is bound to, the run record, the
 * Mission's materials and the submission report.
 *
 * Every message is checked against its sender exactly as the other dock messages are (our
 * own top frame, or the registered form frame, on exactly the page the message names).
 * Nothing a page says selects a Mission: the backend's page binding does, under this
 * owner's bearer, and the answer never leaves the worker except as the dock's face.
 */

import type { MissionMaterialsV1, MissionPageBindingV1 } from '@edaix/contracts';
import type { DockMissionPage, DockMissionRuns } from './dockMissionRuns';
import {
  parseDockMissionCoverLetterIntent,
  parseDockMissionRunBeginIntent,
  parseDockMissionRunFinishIntent,
  parseDockSubmitConfirmedIntent,
  type DockMissionCoverLetterReply,
  type DockMissionCoverLetterTrigger,
  type DockMissionRunBeginReply,
} from './dockMissionIntent';
import type { FrameFormRegistry } from './frameFormRegistry';
import type { MissionDockClient } from './missionDockClient';
import type { MissionMaterialsClient, ReadyMissionResume } from './missionMaterialsClient';
import type { MissionPageBindingClient } from './missionPageBindingClient';
import type { MissionResumeSupply } from './resumeAttachmentProvider';
import { senderTabForPageOrFrame, type SenderPageLike } from './senderPage';

/** Mission statuses whose materials, runs and submission report are still the dock's business. */
export const OPEN_MISSION_STATUSES: ReadonlySet<string> = new Set([
  'QUEUED', 'PREPARING', 'WAITING_FOR_APPROVAL', 'READY_TO_EXECUTE', 'EXECUTING', 'WAITING_FOR_USER',
]);
/** How long a tab's binding is reused (runs always ask afresh: they need the revision). */
const TAB_BINDING_TTL_MS = 60_000;
/** How long after the user's 提交 a site's confirmation still reports the submission. */
const SUBMISSION_REPORT_WINDOW_MS = 2 * 60_000;
/** How long a Mission's materials manifest is reused between PLAN and RELEASE. */
const MATERIALS_MANIFEST_TTL_MS = 60_000;

export interface TabMissionBindings {
  isBound(tabId: number, page: DockMissionPage): Promise<boolean>;
  /** A bound page whose Mission is still open. */
  open(tabId: number, page: DockMissionPage): Promise<MissionPageBindingV1 | null>;
  /** Asked again, not from the cache: a run needs the Mission's current revision. */
  fresh(tabId: number, page: DockMissionPage): Promise<MissionPageBindingV1 | null>;
  /** What this tab was last bound to, without asking (the 提交 mark reads it). */
  cached(tabId: number): MissionPageBindingV1 | null;
  forget(tabId: number): void;
  /** 换了账号（2026-10-04）：每个标签页记着的任务都是上一个人的，一并清掉。 */
  forgetAll(): void;
}

export function createTabMissionBindings(deps: Readonly<{
  client: Pick<MissionPageBindingClient, 'resolve'>;
  now?: () => number;
}>): TabMissionBindings {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<number, { page: DockMissionPage; binding: MissionPageBindingV1 | null; at: number }>();
  const get = async (tabId: number, page: DockMissionPage): Promise<MissionPageBindingV1 | null> => {
    const cached = entries.get(tabId);
    if (
      cached !== undefined &&
      cached.page.canonicalOrigin === page.canonicalOrigin &&
      cached.page.pathname === page.pathname &&
      now() - cached.at < TAB_BINDING_TTL_MS
    ) return cached.binding;
    const binding = await deps.client.resolve(page).catch(() => null);
    entries.set(tabId, { page: { canonicalOrigin: page.canonicalOrigin, pathname: page.pathname }, binding, at: now() });
    return binding;
  };
  const open = async (tabId: number, page: DockMissionPage) => {
    const binding = await get(tabId, page);
    return binding !== null && OPEN_MISSION_STATUSES.has(binding.status) ? binding : null;
  };
  const bindings: TabMissionBindings = {
    async isBound(tabId, page) {
      return (await get(tabId, page)) !== null;
    },
    open,
    async fresh(tabId, page) {
      entries.delete(tabId);
      return open(tabId, page);
    },
    cached(tabId) {
      return entries.get(tabId)?.binding ?? null;
    },
    forget(tabId) {
      entries.delete(tabId);
    },
    forgetAll() {
      entries.clear();
    },
  };
  return Object.freeze(bindings);
}

export interface DockMissionWorker {
  /** One of the four dock Mission messages, or undefined when the message is not ours. */
  handle(message: unknown, sender: SenderPageLike): Promise<unknown> | undefined;
  /** The user pressed 提交 in this tab (top frame): remember its open Mission for the report. */
  submitPressed(tabId: number): void;
  /** The tab's page is bound to an open Mission: its tailored resume, or null. */
  resumeSupply(tabId: number, page: DockMissionPage): Promise<MissionResumeSupply | null>;
  forgetTab(tabId: number): void;
  /** 换了账号（2026-10-04）：任务的材料清单（定制简历叫什么）与待报的「已提交」都是上一个人的，清掉。 */
  forgetUser(): void;
}

export function createDockMissionWorker(deps: Readonly<{
  extensionId: string;
  readFrameForms: () => Promise<FrameFormRegistry>;
  bindings: TabMissionBindings;
  runs: DockMissionRuns;
  materials: MissionMaterialsClient;
  missions: Pick<MissionDockClient, 'reportSubmission'>;
  /** Only stable codes (RULE-GLOBAL-DATA-L1). */
  onDiagnostic?: (code: string) => void;
  now?: () => number;
}>): DockMissionWorker {
  const now = deps.now ?? (() => Date.now());
  const diag = (code: string): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // A broken diagnostic ring never breaks a fill.
    }
  };
  const pendingSubmissions = new Map<number, { missionId: string; at: number }>();
  const manifests = new Map<string, { manifest: MissionMaterialsV1; at: number }>();

  const manifestFor = async (missionId: string): Promise<MissionMaterialsV1 | null> => {
    const cached = manifests.get(missionId);
    if (cached !== undefined && now() - cached.at < MATERIALS_MANIFEST_TTL_MS) return cached.manifest;
    const manifest = await deps.materials.manifest(missionId);
    if (manifest === null) manifests.delete(missionId);
    else manifests.set(missionId, { manifest, at: now() });
    return manifest;
  };

  const resumeSupplyFor = (missionId: string): MissionResumeSupply => {
    const ready = async (): Promise<ReadyMissionResume | null> => {
      const manifest = await manifestFor(missionId);
      return manifest?.resume.state === 'READY' ? manifest.resume : null;
    };
    return {
      async plan() {
        const resume = await ready();
        return resume === null
          ? { ok: false, code: 'RESUME_UNAVAILABLE' }
          : { ok: true, fileName: resume.fileName, size: resume.size };
      },
      async release() {
        const resume = await ready();
        if (resume === null) return { ok: false, code: 'RESUME_UNAVAILABLE' };
        const file = await deps.materials.releaseResume(missionId, resume);
        if (file === null) {
          // The pinned version may have moved since the manifest (a re-render): read it anew next time.
          manifests.delete(missionId);
          return { ok: false, code: 'RESUME_UNAVAILABLE' };
        }
        return { ok: true, fileName: file.fileName, size: file.size, bytes: file.bytes };
      },
    };
  };

  const coverLetterFor = async (
    tabId: number,
    page: DockMissionPage,
    trigger: DockMissionCoverLetterTrigger,
  ): Promise<DockMissionCoverLetterReply> => {
    const binding = await deps.bindings.open(tabId, page);
    if (binding === null) return { kind: 'REFUSED', code: 'UNBOUND' };
    const requested = await deps.materials.requestCoverLetter(binding.missionId, trigger);
    if (requested === null) {
      diag('DOCK_MISSION_COVER_LETTER_UNAVAILABLE');
      return { kind: 'REFUSED', code: 'UNAVAILABLE' };
    }
    if (!requested.ok) {
      diag(`DOCK_MISSION_COVER_LETTER_${requested.code}`);
      return { kind: 'REFUSED', code: requested.code };
    }
    const text = await deps.materials.coverLetterText(binding.missionId, requested.coverLetter.artifactId);
    if (text === null) {
      diag('DOCK_MISSION_COVER_LETTER_RELEASE_FAILED');
      return { kind: 'REFUSED', code: 'UNAVAILABLE' };
    }
    diag(requested.generated ? 'DOCK_MISSION_COVER_LETTER_WRITTEN' : 'DOCK_MISSION_COVER_LETTER_REUSED');
    return { kind: 'COVER_LETTER_TEXT', text };
  };

  const reportSubmitted = async (tabId: number): Promise<{ ok: boolean }> => {
    const pending = pendingSubmissions.get(tabId);
    pendingSubmissions.delete(tabId);
    if (pending === undefined || now() - pending.at > SUBMISSION_REPORT_WINDOW_MS) return { ok: false };
    const reported = await deps.missions.reportSubmission(pending.missionId);
    diag(`DOCK_MISSION_SUBMISSION_${reported}`);
    // The Mission closed: the next hello asks the backend again instead of the cache.
    if (reported !== 'FAILED') deps.bindings.forget(tabId);
    return { ok: reported !== 'FAILED' };
  };

  const worker: DockMissionWorker = {
    handle(message, sender) {
      const begin = parseDockMissionRunBeginIntent(message);
      const finish = begin === null ? parseDockMissionRunFinishIntent(message) : null;
      const cover = begin === null && finish === null ? parseDockMissionCoverLetterIntent(message) : null;
      const confirmed = begin === null && finish === null && cover === null
        ? parseDockSubmitConfirmedIntent(message)
        : null;
      const intent = begin ?? finish ?? cover ?? confirmed;
      if (intent === null) return undefined;
      return deps.readFrameForms().then(async (frameForms): Promise<unknown> => {
        const tabId = senderTabForPageOrFrame(sender, deps.extensionId, intent, frameForms);
        if (tabId === null) return undefined;
        const page = { canonicalOrigin: intent.origin, pathname: intent.pathname };
        if (begin !== null) {
          const start = await deps.runs.begin(tabId, page, { fieldKeys: begin.fieldKeys, vendor: begin.vendor });
          return (start.kind === 'MISSION_RUN'
            ? { kind: 'MISSION_RUN', ticket: start.ticket }
            : { kind: 'NO_RUN', code: start.code }) satisfies DockMissionRunBeginReply;
        }
        if (finish !== null) return { ok: await deps.runs.finish(finish.ticket, finish.outcomes, tabId) };
        if (cover !== null) return coverLetterFor(tabId, page, cover.trigger);
        return reportSubmitted(tabId);
      }).catch(() => undefined);
    },
    submitPressed(tabId) {
      const binding = deps.bindings.cached(tabId);
      if (binding !== null && OPEN_MISSION_STATUSES.has(binding.status)) {
        pendingSubmissions.set(tabId, { missionId: binding.missionId, at: now() });
      }
    },
    async resumeSupply(tabId, page) {
      const binding = await deps.bindings.open(tabId, page);
      return binding === null ? null : resumeSupplyFor(binding.missionId);
    },
    forgetTab(tabId) {
      deps.bindings.forget(tabId);
      deps.runs.forgetTab(tabId);
      pendingSubmissions.delete(tabId);
    },
    forgetUser() {
      manifests.clear();
      pendingSubmissions.clear();
    },
  };
  return Object.freeze(worker);
}
