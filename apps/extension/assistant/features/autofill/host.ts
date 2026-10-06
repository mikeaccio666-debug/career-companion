import type { VerifiedApplicationTarget } from "@edaix/agent-channel";
import { SelectedMaterialFailure } from "./selected-material";
import type { ExecutorInstallationResult } from "./executor-installation";
import {
  ASSISTANT_AUTOFILL_CODES,
  type AssistantAutofillCode,
  parseAssistantAutofillSnapshot,
  type AssistantMissionRunContext,
  type AssistantAutofillSelection,
  type AssistantAutofillSnapshot,
  type AssistantAutofillOperation,
  type AssistantAutofillResult,
  type AssistantAutofillRow,
} from "@edaix/contracts";
import type {
  LocalRunMission,
  LocalRunOutcome,
} from "../../../lib/localRunLauncher";

export interface AutofillHostContext {
  readonly tabId: number;
  readonly ownerKey: string;
  readonly topUrl: string;
  readonly signal: AbortSignal;
  readonly topDocumentId?: string;
  readonly current: () => Promise<boolean>;
}
export interface SelectedAutofillAuthority {
  readonly mission: LocalRunMission;
  readonly target: Pick<VerifiedApplicationTarget, 'canonicalOrigin' | 'pathname'> & Partial<VerifiedApplicationTarget>;
  readonly runContext: AssistantMissionRunContext;
}
export interface AssistantAutofillHostDependencies {
  resolve(
    selection: AssistantAutofillSelection,
    context: AutofillHostContext,
  ): Promise<SelectedAutofillAuthority | null>;
  approve?(
    selection: AssistantAutofillSelection,
    authority: SelectedAutofillAuthority,
    context: AutofillHostContext,
    requestId: string,
  ): Promise<SelectedAutofillAuthority | null>;
  prepare(context: AutofillHostContext, signal: AbortSignal): Promise<ExecutorInstallationResult>;
  run(
    mission: LocalRunMission,
    context: AutofillHostContext,
    signal: AbortSignal,
    rows: (rows: readonly AssistantAutofillRow[]) => void,
    reviewedFieldKeys: readonly string[],
  ): Promise<LocalRunOutcome>;
  openTarget(url: string): Promise<void>;
}
const same = (a: AssistantAutofillSelection, b: AssistantAutofillSelection) =>
  a.batchId === b.batchId &&
  a.preparationId === b.preparationId &&
  a.missionId === b.missionId &&
  a.resumeVersionId === b.resumeVersionId;
/** Memory-only run display; a worker restart yields UNKNOWN, never resume or success. */
export function createAssistantAutofillHost(
  deps: AssistantAutofillHostDependencies,
) {
  const runs = new Map<
    number,
    {
      ownerKey: string;
      topUrl: string;
      topDocumentId?: string;
      snapshot: AssistantAutofillSnapshot;
      abort: AbortController;
      active: boolean;
    }
  >();
  const admitting = new Set<number>();
  const stopEpoch = new Map<number, number>();
  const reviews = new Map<
    number,
    {
      id: string;
      ownerKey: string;
      topUrl: string;
      topDocumentId?: string;
      selection: AssistantAutofillSelection;
      fingerprint: string;
      at: number;
    }
  >();
  // Verification freshness is revalidated by the resolver on every command.
  // Only the reviewed target identity and execution authority belong in the consent fingerprint.
  const fingerprint = (a: SelectedAutofillAuthority) => {
    const {verifiedAt: _verifiedAt, freshUntil: _freshUntil, revision: _revision, ...target} = a.target;
    return JSON.stringify({mission:a.mission,runContext:a.runContext,target});
  };
  const canonicalPage = (url: string) => {
    try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
    catch { return null; }
  };
  async function execute(
    context: AutofillHostContext,
    operation: AssistantAutofillOperation,
    selection: AssistantAutofillSelection,
    reviewId?: string,
  ): Promise<AssistantAutofillResult> {
    if (context.signal.aborted || !(await context.current()))
      return { ok: false, code: "PAGE_CHANGED" };
    const raw = runs.get(context.tabId);
    const record =
      raw?.ownerKey === context.ownerKey &&
      raw.topUrl === context.topUrl &&
      raw.topDocumentId === context.topDocumentId &&
      same(raw.snapshot.selection, selection)
        ? raw
        : null;
    if (operation === "READ")
      return record
        ? { ok: true, value: record.snapshot }
        : { ok: false, code: "RESULT_UNKNOWN" };
    if (operation === "STOP") {
      stopEpoch.set(context.tabId, (stopEpoch.get(context.tabId) ?? 0) + 1);
      if (!record) return { ok: false, code: "RESULT_UNKNOWN" };
      record.abort.abort();
      record.snapshot = {
        ...record.snapshot,
        phase: "PAUSED",
        code: "RUN_STOPPED",
      };
      return { ok: true, value: record.snapshot };
    }
    if (
      admitting.has(context.tabId) ||
      raw?.active ||
      [...runs.values()].some(
        (r) =>
          r.active && r.snapshot.selection.missionId === selection.missionId,
      )
    )
      return { ok: false, code: "RUN_BUSY" };
    admitting.add(context.tabId);
    const epoch = stopEpoch.get(context.tabId) ?? 0;
    try {
      let authority = await deps.resolve(selection, context);
      if (context.signal.aborted || !(await context.current()))
        return { ok: false, code: "PAGE_CHANGED" };
      if (!authority) return { ok: false, code: "MATERIAL_CHANGED" };
      if (
        operation === "START" &&
        epoch !== (stopEpoch.get(context.tabId) ?? 0)
      )
        return { ok: false, code: "RUN_STOPPED" };
      if (
        operation === "START" &&
        [...runs.values()].some(
          (r) =>
            r.active && r.snapshot.selection.missionId === selection.missionId,
        )
      )
        return { ok: false, code: "RUN_BUSY" };
      const url = `${authority.target.canonicalOrigin}${authority.target.pathname}`;
      const matches = canonicalPage(context.topUrl) === url;
      if (operation === "OPEN_TARGET") {
        await deps.openTarget(url);
        return {
          ok: true,
          value: {
            selection,
            phase: "READY",
            rows: [],
            pageMatches: false,
            code: "PAGE_CHANGED",
            reviewId: null,
            fieldKeys: authority.runContext.fieldKeys,
          },
        };
      }
      if (operation === "CHECK") {
        for (const [tabId, review] of reviews) if (Date.now() - review.at > 300000) reviews.delete(tabId);
        if (reviews.size >= 64 && !reviews.has(context.tabId)) return { ok: false, code: "RUN_BUSY" };
        const review = {
          id: crypto.randomUUID(),
          ownerKey: context.ownerKey,
          topUrl: context.topUrl,
          topDocumentId: context.topDocumentId,
          selection,
          fingerprint: fingerprint(authority),
          at: Date.now(),
        };
        reviews.set(context.tabId, review);
        return {
          ok: true,
          value: {
            selection,
            phase: "READY",
            rows: [],
            pageMatches: matches,
            code: matches ? null : "PAGE_CHANGED",
            reviewId: review.id,
            fieldKeys: authority.runContext.fieldKeys,
          },
        };
      }
      if (!matches) return { ok: false, code: "PAGE_CHANGED" };
      const review = reviews.get(context.tabId);
      if (
        !review ||
        review.id !== reviewId ||
        review.ownerKey !== context.ownerKey ||
        review.topUrl !== context.topUrl ||
        review.topDocumentId !== context.topDocumentId ||
        !same(review.selection, selection) ||
        Date.now() - review.at > 300000 ||
        review.fingerprint !== fingerprint(authority)
      )
        return { ok: false, code: "MATERIAL_CHANGED" };
      // Installation is inert, but must succeed before consuming a durable approval.
      if (typeof deps.prepare !== "function") return {ok:false,code:"EXECUTOR_UNAVAILABLE"};
      {
        const prepared = await deps.prepare(context, context.signal);
        if (!prepared.ok) return prepared;
        if (context.signal.aborted || !(await context.current())) return {ok:false,code:"PAGE_CHANGED"};
        if (epoch !== (stopEpoch.get(context.tabId) ?? 0)) return {ok:false,code:"RUN_STOPPED"};
      }
      reviews.delete(context.tabId);
      if (authority.runContext.approval) {
        authority =
          (await deps.approve?.(selection, authority, context, review.id)) ??
          null;
        if (!authority) return { ok: false, code: "RESULT_UNKNOWN" };
      }
      if (
        !authority.runContext.start ||
        context.signal.aborted ||
        !(await context.current()) ||
        epoch !== (stopEpoch.get(context.tabId) ?? 0)
      )
        return { ok: false, code: "RUN_STOPPED" };
      if (
        `${authority.target.canonicalOrigin}${authority.target.pathname}` !==
        canonicalPage(context.topUrl)
      )
        return { ok: false, code: "PAGE_CHANGED" };
      if (
        [...runs.values()].some(
          (r) =>
            r.active && r.snapshot.selection.missionId === selection.missionId,
        )
      )
        return { ok: false, code: "RUN_BUSY" };
      if (runs.size >= 64 && !raw) {
        const oldest = [...runs].find(([, r]) => !r.active);
        if (!oldest) return { ok: false, code: "RUN_BUSY" };
        runs.delete(oldest[0]);
      }
      const abort = new AbortController();
      const run = {
        ownerKey: context.ownerKey,
        topUrl: context.topUrl,
        topDocumentId: context.topDocumentId,
        abort,
        active: true,
        snapshot: {
          selection,
          phase: "RUNNING",
          pageMatches: true,
          rows: [],
          code: null,
          reviewId: review.id,
          fieldKeys: authority.runContext.fieldKeys,
        } as AssistantAutofillSnapshot,
      };
      runs.set(context.tabId, run);
      const signal = AbortSignal.any([context.signal, abort.signal]);
      const interrupted = () => {
        run.snapshot = {
          ...run.snapshot,
          phase: "PAUSED",
          code: "RUN_STOPPED",
        };
      };
      signal.addEventListener("abort", interrupted, { once: true });
      const mission = authority.mission;
      void Promise.resolve()
        .then(() =>
          deps.run(mission, context, signal, (rows) => {
            if (signal.aborted || runs.get(context.tabId) !== run) return;
            const parsed = parseAssistantAutofillSnapshot({
              ...run.snapshot,
              rows,
            });
            if (!parsed) {
              abort.abort();
              return;
            }
            run.snapshot = parsed;
          }, authority.runContext.fieldKeys),
        )
        .then(
          (outcome) => {
            if (signal.aborted) return;
            run.snapshot = {
              ...run.snapshot,
              phase: outcome.kind === "FILLED" ? "SETTLED" : "PAUSED",
              code:
                outcome.kind === "FILLED"
                  ? null
                  : outcome.kind === "NEEDS_USER_INPUT"
                    ? "USER_ACTION_REQUIRED"
                    : outcome.kind === "TIMED_OUT"
                      ? "RESULT_UNKNOWN"
                      : outcome.kind === "STOPPED" && ASSISTANT_AUTOFILL_CODES.includes(outcome.code as AssistantAutofillCode)
                        ? outcome.code as AssistantAutofillCode : "RUN_STOPPED",
            };
          },
          () => {
            run.snapshot = {
              ...run.snapshot,
              phase: "PAUSED",
              code: "RESULT_UNKNOWN",
            };
          },
        )
        .finally(() => {
          run.active = false;
          signal.removeEventListener("abort", interrupted);
        });
      return { ok: true, value: run.snapshot };
    } catch (error) {
      return { ok: false, code: error instanceof SelectedMaterialFailure ? error.code : "UNAVAILABLE" };
    } finally {
      admitting.delete(context.tabId);
    }
  }
  return {
    execute,
    invalidate() {
      for (const r of runs.values()) r.abort.abort();
      runs.clear();
      reviews.clear();
      stopEpoch.clear();
    },
  };
}
