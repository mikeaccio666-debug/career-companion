import { autofillFieldLabel } from "./field-label";
import { C } from "../../design/palette";
import type { ViewContext } from "../../app/view-context";
export function connectedFillView(ctx: ViewContext) {
  const state = ctx.state,
    fill = state.autofill,
    snapshot = fill?.snapshot,
    job = ctx.job(state.fillId);
  const t = ctx.t;
  const code = fill?.error ?? snapshot?.code ?? null;
  const active = snapshot?.phase === "RUNNING";
  const running = active && !code;
  const ready =
    snapshot?.phase === "READY" &&
    snapshot.pageMatches &&
    !fill?.loading &&
    !code;
  const rows = (snapshot?.rows ?? []).map((r) => {
    const status =
      r.state === "READBACK_CONFIRMED"
        ? t("已写入并核对")
        : r.state === "PRESERVED"
          ? t("保留你已有内容")
          : r.state === "MANUAL"
            ? t("需要你本人完成")
            : r.state === "FAILED"
              ? t("本项未完成，请检查页面")
              : r.state === "WRITING"
                ? t("正在填写并核对…")
                : t("待填写");
    const good = r.state === "READBACK_CONFIRMED",
      manual = r.state === "MANUAL",
      failed = r.state === "FAILED";
    const reason =
      r.reason === "NOT_EMPTY"
        ? t("已有内容未覆盖")
        : r.reason === "LATE_REVERTED"
          ? t("网站改变了写入结果，请重新核对")
          : r.reason === "PLAN_STALE"
            ? t("资料或页面已变化，请重新核对")
            : r.reason === "NO_VALUE"
              ? t("缺少已确认的资料")
              : r.reason
                ? t("执行器未确认本项完成，请在网站检查")
                : "";
    return {
      key: String(r.index),
      label: autofillFieldLabel(t, r.fieldKey, r.index),
      sub: reason,
      spinning: running && r.state === "WRITING",
      notSpinning: !running || r.state !== "WRITING",
      mark: good
        ? "✓"
        : r.state === "PRESERVED"
          ? "="
          : manual
            ? "!"
            : failed
              ? "×"
              : "",
      status,
      statusWeight: good ? 600 : 500,
      bg: "#fff",
      iconBg: good ? C.mint : manual ? C.peach : failed ? C.rose : C.grey,
      iconColor: good ? C.green : C.ink,
      statusColor: good ? C.green : C.muted,
    };
  });
  const filled = rows.filter(
    (_, i) => snapshot?.rows[i]?.state === "READBACK_CONFIRMED",
  ).length;
  const kept =
    snapshot?.rows.filter((r) => r.state === "PRESERVED").length ?? 0;
  const manual = snapshot?.rows.filter((r) => r.state === "MANUAL").length ?? 0;
  const messages = {
    EXECUTOR_DOCUMENT_MISSING: "无法确认当前页面，请重新打开助手。",
    EXECUTOR_PROBE_INVALID: "无法核对执行器，请刷新申请页后重试。",
    EXECUTOR_TIMEOUT: "执行器准备超时，请刷新申请页后重新检查。",
    EXECUTOR_RELOAD_REQUIRED: "执行器未完成初始化，请刷新申请页后重试。",
    EXECUTOR_UNAVAILABLE: "无法安装执行器，请点击浏览器工具栏中的助手后重试。",
    UNAVAILABLE: "填写服务暂不可用，请稍后重新检查。",
    LOGIN_REQUIRED: "请先登录再填写。",
    OWNER_CHANGED: "账号已变化，请重新登录并选择任务。",
    PAGE_CHANGED: "请打开并核对这个岗位的申请页。",
    MATERIAL_CHANGED: "材料或授权已变化，请返回申请清单重新核对。",
    RUN_BUSY: "已有填写任务进行中，请先停止或等待结束。",
    RUN_STOPPED: "后续填写已停止，请检查网站已有内容。",
    USER_ACTION_REQUIRED: "需要你在网站完成剩余问题。",
    RESULT_UNKNOWN: "执行结果尚未确认。请检查网站；不会自动重试。",
  } as const;
  const summary = code
    ? t(messages[code])
    : t("请在网站核对所有内容。其余问题与最终 Submit 由你完成。");
  const resumeId = fill?.selection.resumeVersionId;
  const resumeLabel =
    ctx.data.resumeVersions.find((r) => r.id === resumeId)?.label ??
    state.materials?.choices.find(
      (c) =>
        c.plan.mode === "USE_EXISTING" && c.plan.resumeVersionId === resumeId,
    )?.label ??
    t("本任务已绑定的简历版本");
  return {
    title: job.title,
    company: job.company,
    initial: job.company[0] ?? "",
    markBg: ctx.markBg(state.fillId),
    resumeLabel,
    pageLabel: snapshot?.pageMatches ? t("当前申请页") : t("待核对申请页"),
    stateLabel: fill?.loading
      ? t("正在核对任务与申请页…")
      : running
        ? t("正在逐项填写并读回核对")
        : ready
          ? t("已核对任务与申请页")
          : t("请核对本次执行状态"),
    progress: rows.length ? `${filled} / ${rows.length}` : "—",
    rows,
    showSummary:
      !!code || snapshot?.phase === "SETTLED" || snapshot?.phase === "PAUSED",
    summaryBg: C.peach,
    summaryTitle: code
      ? t("填写需要你核对")
      : t("{v0} 项已核对 · {v1} 项保留 · {v2} 项需人工", {
          v0: filled,
          v1: kept,
          v2: manual,
        }),
    summaryText: summary,
    showStart: ready,
    showDone: !running && !fill?.loading && !ready,
    running: running || !!fill?.loading,
    startLabel: t("Autofill · 自动填写"),
    startNote: t("每一项写入后读回核对，才会出现 ✓"),
    showStop: active,
    showOpenTarget:
      snapshot?.phase === "READY" && !snapshot.pageMatches && !fill?.loading,
  };
}
