import type {
  AssistantAutofillSelection,
  AssistantAutofillSnapshot,
  AssistantAutofillCode,
  AssistantAutofillOperation,
} from "@edaix/contracts";
import type { ControllerContext } from "../../app/controller-context";
import { isCurrent } from "../../app/controller-context";
import { abortableDelay } from "../../ports/assistant-ports";
export interface ConnectedAutofillState {
  readonly selection: AssistantAutofillSelection;
  readonly snapshot: AssistantAutofillSnapshot | null;
  readonly loading: boolean;
  readonly error: AssistantAutofillCode | null;
}
export function createConnectedAutofillController(ctx: ControllerContext) {
  let sequence = 0;
  const set = (patch: Partial<ConnectedAutofillState>) => {
    if (ctx.state.autofill)
      ctx.patch({ autofill: { ...ctx.state.autofill, ...patch } });
  };
  async function execute(operation: AssistantAutofillOperation) {
    const state = ctx.state.autofill;
    if (!state || !ctx.ports.autofill) return null;
    const scope = ctx.store.scope(),
      seq = sequence;
    try {
      const result = await ctx.ports.autofill.execute(
        operation,
        state.selection,
        scope.signal,
        state.snapshot?.reviewId ?? undefined,
      );
      if (!isCurrent(ctx, scope) || seq !== sequence) return null;
      if (
        result.ok &&
        (
          ["batchId", "preparationId", "missionId", "resumeVersionId"] as const
        ).some((key) => result.value.selection[key] !== state.selection[key])
      ) {
        set({ error: "MATERIAL_CHANGED", loading: false });
        return null;
      }
      if (result.ok)
        set({ snapshot: result.value, error: null, loading: false });
      else set({ error: result.code, loading: false });
      return result;
    } catch {
      if (isCurrent(ctx, scope) && seq === sequence)
        set({ error: "UNAVAILABLE", loading: false });
      return null;
    }
  }
  async function poll() {
    const scope = ctx.store.scope(),
      seq = sequence;
    while (
      isCurrent(ctx, scope) &&
      seq === sequence &&
      ctx.state.autofill?.snapshot?.phase === "RUNNING"
    ) {
      if (!(await abortableDelay(750, scope.signal))) return;
      const result = await execute("READ");
      if (!result?.ok) return;
    }
  }
  async function open(id: string) {
    const preparation = ctx.state.materials?.preparations[id],
      entry = ctx.state.commerce?.entries[id];
    if (
      !entry ||
      preparation?.status !== "READY" ||
      !preparation.missionId ||
      !preparation.resumeVersionId
    ) {
      ctx.toast(ctx.t("请先准备这个岗位的申请材料。"));
      return;
    }
    await stop();
    sequence++;
    ctx.patch({
      fillId: id,
      sheet: null,
      autofill: {
        selection: {
          batchId: entry.batchId,
          preparationId: preparation.preparationId,
          missionId: preparation.missionId,
          resumeVersionId: preparation.resumeVersionId,
        },
        snapshot: null,
        loading: true,
        error: null,
      },
    });
    await ctx.go("autofill");
    const restored = await execute("READ");
    if (restored?.ok) void poll();
    else if (restored && restored.code === "RESULT_UNKNOWN")
      await execute("CHECK");
  }
  async function stop() {
    sequence++;
    const state = ctx.state.autofill;
    if (state?.snapshot?.phase === "RUNNING" || state?.loading) {
      try {
        await ctx.ports.autofill?.execute(
          "STOP",
          state.selection,
          AbortSignal.timeout(8000),
        );
      } catch {
        set({ error: "RESULT_UNKNOWN" });
      }
      if (ctx.state.autofill?.selection === state.selection)
        set({
          loading: false,
          snapshot: state.snapshot
            ? { ...state.snapshot, phase: "PAUSED", code: "RUN_STOPPED" }
            : null,
        });
    }
  }
  return {
    open,
    stop,
    async action(act: string) {
      if (act === "fill-start") {
        if (
          ctx.state.autofill?.loading ||
          ctx.state.autofill?.snapshot?.phase === "RUNNING"
        )
          return;
        const result = await execute("CHECK");
        if (result?.ok && result.value.pageMatches)
          ctx.patch({ sheet: { kind: "fill" } });
        return;
      }
      if (act === "fill-confirm") {
        if (
          ctx.state.autofill?.loading ||
          ctx.state.autofill?.snapshot?.phase === "RUNNING"
        )
          return;
        ctx.patch({ sheet: null });
        set({ loading: true });
        const r = await execute("START");
        if (r?.ok) void poll();
        return;
      }
      if (act === "fill-open-target") {
        const opened = await execute("OPEN_TARGET");
        if (opened?.ok)
          ctx.toast(
            ctx.t("申请页已打开。请在该页打开 ArgoLand.AI，核对后开始填写。"),
          );
        return;
      }
      if (act === "fill-rerun") {
        await stop();
        set({ loading: true });
        await execute("CHECK");
        return;
      }
      if (act === "fill-stop") {
        await stop();
        return;
      }
      if (act === "fill-handoff") {
        await stop();
        await ctx.close();
      }
    },
  };
}
