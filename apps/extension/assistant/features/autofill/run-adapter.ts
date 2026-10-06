import type { ExecutorInstallationResult } from "./executor-installation";
import {
  createRunCoordinator,
  type IntentAcquirer,
  type IntentClaimer,
  type ReceiptUploader,
} from "@edaix/agent-channel";
import type { AssistantAutofillRow } from "@edaix/contracts";
import type { ReceiptFieldOutcome } from "@edaix/contracts/draft";
import {
  createTabKernelBridge,
  type TabBridgeDeps,
} from "../../../lib/tabBridge";
import { launchLocalRun } from "../../../lib/localRunLauncher";
import type {
  AssistantAutofillHostDependencies,
  AutofillHostContext,
} from "./host";

export function rowsFromFinalOutcomes(
  outcomes: readonly ReceiptFieldOutcome[],
): readonly AssistantAutofillRow[] {
  return outcomes
    .filter(
      (o) =>
        !["HONEYPOT", "SENSITIVE_OPT_OUT", "DUPLICATE_FIELD"].includes(
          o.reason ?? "",
        ),
    )
    .map((o, index) => ({
      index,
      fieldKey: o.key,
      state: o.ok
        ? "READBACK_CONFIRMED"
        : o.reason === "NOT_EMPTY"
          ? "PRESERVED"
          : [
                "MANUAL_ONLY",
                "OTHER_PERSON",
                "JOB_DEPENDENT",
                "NO_OPTION_MATCH",
                "AMBIGUOUS_OPTION",
                "UNSUPPORTED_CONTROL",
                "SENSITIVE",
                "NO_VALUE",
              ].includes(o.reason ?? "")
            ? "MANUAL"
            : "FAILED",
      reason: o.reason ?? null,
    }));
}
/** Same coordinator and field executor; only the exact clicked tab is offered to the bridge. */
export function createAssistantRunAdapter(input: {
  prepareExecutor: (
    context: AutofillHostContext,
    signal: AbortSignal,
  ) => Promise<ExecutorInstallationResult>;
  bridge: (context: AutofillHostContext) => TabBridgeDeps;
  acquirer: IntentAcquirer;
  claimer: IntentClaimer;
  receiptUploader: ReceiptUploader;
}): AssistantAutofillHostDependencies["run"] {
  return async (mission, context, signal, onRows, reviewedFieldKeys) => {
    if (signal.aborted) return {kind:"STOPPED",runId:null,code:"RUN_STOPPED"};
    if (!(await context.current())) return {kind:"STOPPED",runId:null,code:"PAGE_CHANGED"};
    const prepared = await input.prepareExecutor(context, signal);
    if (!prepared.ok) return {kind:"STOPPED",runId:null,code:prepared.code};
    if (signal.aborted) return {kind:"STOPPED",runId:null,code:"RUN_STOPPED"};
    if (!(await context.current())) return {kind:"STOPPED",runId:null,code:"PAGE_CHANGED"};
    const reviewed = new Set(reviewedFieldKeys);
    const base = input.bridge(context);
    const bridge = createTabKernelBridge({
      ...base,
      queryTabs: async () =>
        signal.aborted || !(await context.current())
          ? []
          : [{ id: context.tabId, url: context.topUrl }], // Fresh attestation replaces the legacy hello registry.
      runtimeAuthority:
        base.runtimeAuthority.mode === "REQUIRED"
          ? {
              ...base.runtimeAuthority,
              revalidate: async (authority) =>
                !signal.aborted &&
                (await context.current()) &&
                base.runtimeAuthority.mode === "REQUIRED" &&
                (await base.runtimeAuthority.revalidate(authority)),
            }
          : base.runtimeAuthority,
    });
    let scopeChanged = false;
    const outcome = await launchLocalRun({
      mission,
      signal,
      attachCoordinator: (transport) =>
        createRunCoordinator({
          transport,
          acquirer: {
            acquire: async (ref) =>
              signal.aborted || !(await context.current())
                ? { ok: false }
                : input.acquirer.acquire(ref),
          },
          claimer: input.claimer,
          scanner: bridge.scanner,
          receiptUploader: input.receiptUploader,
          filler: {
            fill: async (grant, scan, progress) => {
              if (signal.aborted || !(await context.current()))
                return grant.fieldKeys.map((key) => ({
                  key,
                  ok: false,
                  reason: "ABORTED",
                }));
              if (!reviewedFieldKeys || reviewed.size !== reviewedFieldKeys.length ||
                grant.fieldKeys.length > 256 || grant.fieldKeys.length !== reviewed.size ||
                new Set(grant.fieldKeys).size !== reviewed.size ||
                !grant.fieldKeys.every(key => reviewed.has(key))) {
                scopeChanged = true;
                return grant.fieldKeys.map((key) => ({
                  key,
                  ok: false,
                  reason: "PLAN_STALE",
                }));
              }
              onRows(
                grant.fieldKeys.map((fieldKey, index) => ({
                  index,
                  fieldKey,
                  state: "WRITING",
                  reason: null,
                })),
              );
              const outcomes = await bridge.filler.fill(grant, scan, {
                ...progress,
                shouldStop: () => signal.aborted || progress.shouldStop(),
              });
              // Final bridge outcomes include readback/late recheck failures. Incremental counters never mint ticks.
              onRows(rowsFromFinalOutcomes(outcomes));
              return outcomes;
            },
          },
        }),
    });
    return scopeChanged ? {kind:"STOPPED",runId:outcome.kind === "TIMED_OUT" ? null : outcome.runId,code:"MATERIAL_CHANGED"} : outcome;
  };
}
