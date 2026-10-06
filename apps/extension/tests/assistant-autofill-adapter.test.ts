import { it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({
  bridge: null as any,
  coordinator: null as any,
  fill: vi.fn(),
}));
vi.mock("../lib/tabBridge", () => ({
  createTabKernelBridge: (deps: any) => {
    h.bridge = deps;
    return { scanner: { scan: vi.fn() }, filler: { fill: h.fill } };
  },
}));
vi.mock("@edaix/agent-channel", () => ({
  createRunCoordinator: (deps: any) => {
    h.coordinator = deps;
    return { dispose: vi.fn() };
  },
}));
vi.mock("../lib/localRunLauncher", () => ({
  launchLocalRun: async (input: any) => {
    input.attachCoordinator({});
    return { kind: "FILLED", runId: "fixture" };
  },
}));
import { createAssistantRunAdapter } from "../assistant/features/autofill/run-adapter";
it("restricts the existing bridge to the clicked tab and shows ticks only after final readback", async () => {
  let current = true;
  const signal = new AbortController();
  const context = {
    tabId: 7,
    topDocumentId: "document",
    ownerKey: "owner",
    topUrl: "https://example.test/apply",
    signal: signal.signal,
    current: async () => current,
  };
  const acquire = vi.fn(async () => ({ ok: false })),
    rows = vi.fn(),
    revalidate = vi.fn(async () => true);
  const bridge = () =>
    ({
      queryTabs: async () => [], // No legacy hello registry entry on an Assistant-only page.
      runtimeAuthority: { mode: "REQUIRED", revalidate },
    }) as never;
  const run = createAssistantRunAdapter({
    prepareExecutor: async () => ({ok:true}),
    bridge,
    acquirer: { acquire } as never,
    claimer: {} as never,
    receiptUploader: {} as never,
  });
  await run(
    {
      missionId: "fixture",
      missionStepId: "fixture",
      missionRevision: "3",
    } as never,
    context,
    signal.signal,
    rows,
    ["email"],
  );
  expect(await h.bridge.queryTabs()).toEqual([{ id: 7, url: context.topUrl }]);
  let finish!: (v: any) => void;
  h.fill.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = h.coordinator.filler.fill(
    { fieldKeys: ["email"] },
    {},
    { shouldStop: () => false },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(rows).toHaveBeenLastCalledWith([
    { index: 0, fieldKey: "email", state: "WRITING", reason: null },
  ]);
  finish([{ key: "email", ok: false, reason: "LATE_REVERTED" }]);
  await pending;
  expect(rows).toHaveBeenLastCalledWith([
    { index: 0, fieldKey: "email", state: "FAILED", reason: "LATE_REVERTED" },
  ]);
  for (const fieldKeys of [["phone"], ["email", "phone"], ["email", "email"], []]) {
    rows.mockClear();
    const result = await h.coordinator.filler.fill({fieldKeys}, {}, {shouldStop:()=>false});
    expect(result.every((r: any)=>r.reason === "PLAN_STALE")).toBe(true);
    expect(rows).not.toHaveBeenCalled(); expect(h.fill).toHaveBeenCalledOnce();
  }
  current = false;
  expect(await h.bridge.queryTabs()).toEqual([]);
  expect(await h.bridge.runtimeAuthority.revalidate({})).toBe(false);
  expect(await h.coordinator.acquirer.acquire({})).toEqual({ ok: false });
  expect(acquire).not.toHaveBeenCalled();
  current = true;
  signal.abort();
  expect(
    await h.coordinator.filler.fill(
      { fieldKeys: ["email"] },
      {},
      { shouldStop: () => false },
    ),
  ).toEqual([{ key: "email", ok: false, reason: "ABORTED" }]);
  expect(h.fill).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'cancelled', 'drift'])('does not start a coordinator after executor %s', async kind => {
  const controller = new AbortController(); let current = true;
  const bridge = vi.fn(); const acquire = vi.fn(); const rows = vi.fn();
  const run = createAssistantRunAdapter({
    prepareExecutor: async () => {
      if (kind === 'cancelled') controller.abort();
      if (kind === 'drift') current = false;
      return kind !== 'unavailable' ? {ok:true} : {ok:false,code:'EXECUTOR_UNAVAILABLE'};
    },
    bridge, acquirer: {acquire} as never, claimer: {} as never, receiptUploader: {} as never,
  });
  expect(await run({missionId:'fixture',missionStepId:'fixture',missionRevision:'1'}, {
    tabId:7,topDocumentId:'doc',ownerKey:'owner',topUrl:'https://example.test/apply',signal:controller.signal,current:async()=>current,
  }, controller.signal, rows, ['email'])).toEqual({kind:'STOPPED',runId:null,code:kind==='cancelled'?'RUN_STOPPED':kind==='drift'?'PAGE_CHANGED':'EXECUTOR_UNAVAILABLE'});
  expect(bridge).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled();
});
