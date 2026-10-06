import { describe, it, expect, vi } from "vitest";
import { createAssistantAutofillHost } from "../assistant/features/autofill/host";
import type { AssistantAutofillRow } from "@edaix/contracts";
const id = "10000000-0000-4000-8000-000000000001";
const selection = {
  batchId: id,
  preparationId: id,
  missionId: id,
  resumeVersionId: id,
};
const mission = {
  missionId: id as never,
  missionStepId: id as never,
  missionRevision: "1" as never,
};
const target = { canonicalOrigin: "https://example.test", pathname: "/apply" };
function setup() {
  const abort = new AbortController();
  let alive = true;
  const ctx = {
    tabId: 1,
    ownerKey: "owner:1",
    topUrl: "https://example.test/apply",
    signal: abort.signal,
    current: async () => alive,
  };
  const resolve = vi.fn(async () => ({
    mission,
    target,
    runContext: {
      resumeVersionId: id,
      fieldKeys: ["email"],
      planDigest: "sha256:" + "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      approval: null,
      start: mission,
    },
  }));
  let finish!: (v: { kind: "FILLED"; runId: string }) => void;
  const run = vi.fn(
    async (
      _m: unknown,
      _c: unknown,
      signal: AbortSignal,
      rows: (v: readonly AssistantAutofillRow[]) => void,
    ) => {
      rows([{ index: 0, fieldKey: "email", state: "WRITING", reason: null }]);
      return new Promise<{ kind: "FILLED"; runId: string }>((r) => {
        finish = r;
        signal.addEventListener("abort", () =>
          r({ kind: "FILLED", runId: "ended" }),
        );
      });
    },
  );
  const host = createAssistantAutofillHost({
    resolve,
    prepare: async () => ({ok:true}),
    run,
    openTarget: vi.fn(async () => {}),
  });
  return {
    host,
    ctx,
    resolve,
    prepare: async () => ({ok:true}),
    run,
    abort,
    start: async () => {
      const check = await host.execute(ctx, "CHECK", selection);
      return host.execute(
        ctx,
        "START",
        selection,
        check.ok ? (check.value.reviewId ?? undefined) : undefined,
      );
    },
    finish: () => finish({ kind: "FILLED", runId: "ended" }),
    expire: () => {
      alive = false;
    },
  };
}
describe("Assistant exact selected Mission host", () => {
  it("rejects another page or stale authority before calling the existing executor", async () => {
    const x = setup();
    expect(
      await x.host.execute(
        { ...x.ctx, topUrl: "https://example.test/other" },
        "START",
        selection,
      ),
    ).toEqual({ ok: false, code: "PAGE_CHANGED" });
    x.expire();
    expect(await x.host.execute(x.ctx, "START", selection)).toEqual({
      ok: false,
      code: "PAGE_CHANGED",
    });
    expect(x.run).not.toHaveBeenCalled();
  });
  it("deduplicates starts and retains truthful interrupted state; read/recheck never reruns", async () => {
    const x = setup();
    expect((await x.start()).ok).toBe(true);
    expect(await x.host.execute(x.ctx, "START", selection)).toEqual({
      ok: false,
      code: "RUN_BUSY",
    });
    await x.host.execute(x.ctx, "STOP", selection);
    await Promise.resolve();
    const read = await x.host.execute(x.ctx, "READ", selection);
    expect(read).toMatchObject({
      ok: true,
      value: { phase: "PAUSED", rows: [{ state: "WRITING" }] },
    });
    await x.host.execute(x.ctx, "CHECK", selection);
    expect(x.run).toHaveBeenCalledOnce();
  });
  it("does not expose a previous owner snapshot or infer success after a worker restart", async () => {
    const x = setup();
    await x.start();
    x.finish();
    await Promise.resolve();
    expect(
      await x.host.execute({ ...x.ctx, ownerKey: "other" }, "READ", selection),
    ).toEqual({ ok: false, code: "RESULT_UNKNOWN" });
    const fresh = setup();
    expect(await fresh.host.execute(fresh.ctx, "READ", selection)).toEqual({
      ok: false,
      code: "RESULT_UNKNOWN",
    });
  });
  it("requires another confirmation when the reviewed field scope changes", async () => {
    const x = setup();
    const check = await x.host.execute(x.ctx, "CHECK", selection);
    const authority = await x.resolve();
    x.resolve.mockResolvedValue({
      ...authority,
      runContext: { ...authority.runContext, fieldKeys: ["phone"] },
    });
    expect(
      await x.host.execute(
        x.ctx,
        "START",
        selection,
        check.ok ? check.value.reviewId! : undefined,
      ),
    ).toEqual({ ok: false, code: "MATERIAL_CHANGED" });
    expect(x.run).not.toHaveBeenCalled();
  });
  it("fails closed when an executor throws synchronously and permits a fresh check", async () => {
    const x = setup();
    x.run.mockImplementation(() => {
      throw new Error("FIXTURE_RUN_FAILURE");
    });
    await x.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(await x.host.execute(x.ctx, "READ", selection)).toMatchObject({
      ok: true,
      value: { phase: "PAUSED", code: "RESULT_UNKNOWN" },
    });
    expect(await x.host.execute(x.ctx, "CHECK", selection)).toMatchObject({
      ok: true,
    });
  });
  it("allows only one executor when two tabs finish approval concurrently", async () => {
    const x = setup();
    const authority = await x.resolve();
    const pending = {
      ...authority,
      runContext: {
        ...authority.runContext,
        start: null,
        approval: {
          missionRevision: "1",
          missionStepId: id,
          stepAttempt: 1,
          approvalMessageId: id,
          actionId: id,
          actionRevision: "1",
          actionPayloadDigest: "sha256:" + "a".repeat(64),
          planDigest: authority.runContext.planDigest,
        },
      },
    };
    const approve = vi.fn(async () => authority);
    const host = createAssistantAutofillHost({
      resolve: async () => pending as never,
      approve,
      prepare: async () => ({ok:true}),
      run: x.run,
      openTarget: async () => {},
    });
    const second = { ...x.ctx, tabId: 2 };
    const [a, b] = await Promise.all([
      host.execute(x.ctx, "CHECK", selection),
      host.execute(second, "CHECK", selection),
    ]);
    const results = await Promise.all([
      host.execute(
        x.ctx,
        "START",
        selection,
        a.ok ? a.value.reviewId! : undefined,
      ),
      host.execute(
        second,
        "START",
        selection,
        b.ok ? b.value.reviewId! : undefined,
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(x.run).toHaveBeenCalledOnce();
    host.invalidate();
  });
});
it("requires a new review after a same-URL document replacement", async () => {
  const x = setup();
  const check = await x.host.execute(x.ctx, "CHECK", selection);
  expect(
    await x.host.execute(
      { ...x.ctx, topDocumentId: "replacement" },
      "START",
      selection,
      check.ok ? check.value.reviewId! : undefined,
    ),
  ).toEqual({ ok: false, code: "MATERIAL_CHANGED" });
  expect(x.run).not.toHaveBeenCalled();
});

it("accepts query and fragment on the same canonical application page", async () => {
  const x = setup(); x.ctx.topUrl += "?gh_src=campaign#application";
  expect((await x.start()).ok).toBe(true); expect(x.run).toHaveBeenCalledOnce(); x.host.invalidate();
});
it.each([undefined, "foreign-review"])("rejects an absent or foreign review in otherwise valid context: %s", async reviewId => {
  const x=setup(); const approve=vi.fn();
  const host=createAssistantAutofillHost({resolve:x.resolve,approve,prepare:async()=>({ok:true}),run:x.run,openTarget:async()=>{}});
  await host.execute(x.ctx,"CHECK",selection);
  expect(await host.execute(x.ctx,"START",selection,reviewId)).toEqual({ok:false,code:"MATERIAL_CHANGED"});
  expect(approve).not.toHaveBeenCalled(); expect(x.run).not.toHaveBeenCalled();
});
it("does not evict a live review when another tab reaches the review limit", async () => {
  const x=setup(); const first=await x.host.execute(x.ctx,"CHECK",selection);
  for(let tabId=2;tabId<=64;tabId++) await x.host.execute({...x.ctx,tabId},"CHECK",selection);
  expect(await x.host.execute({...x.ctx,tabId:65},"CHECK",selection)).toEqual({ok:false,code:"RUN_BUSY"});
  expect((await x.host.execute(x.ctx,"START",selection,first.ok?first.value.reviewId!:undefined)).ok).toBe(true);
  x.host.invalidate();
});

it('preflights the exact executor before consuming the Mission approval',async()=>{
 const x=setup(); const approve=vi.fn(); const prepare=vi.fn(async()=>({ok:false as const,code:'EXECUTOR_RELOAD_REQUIRED' as const}));
 const authority=await x.resolve();
 const pending={...authority,runContext:{...authority.runContext,start:null,approval:{missionStepId:id,missionRevision:'1',planDigest:authority.runContext.planDigest}}};
 const host=createAssistantAutofillHost({resolve:async()=>pending as never,approve,prepare,run:x.run,openTarget:async()=>{}});
 const check=await host.execute(x.ctx,'CHECK',selection); expect(prepare).not.toHaveBeenCalled();
 expect(await host.execute(x.ctx,'START',selection,check.ok?check.value.reviewId!:undefined)).toEqual({ok:false,code:'EXECUTOR_RELOAD_REQUIRED'});
 expect(approve).not.toHaveBeenCalled();expect(x.run).not.toHaveBeenCalled();
});

it('ignores refreshed target verification timestamps but retains policy identity in the reviewed fingerprint',async()=>{
 const x=setup();const authority=await x.resolve();
 x.resolve.mockResolvedValue({...authority,target:{...target,verifiedAt:'2026-09-14T00:00:00Z',freshUntil:'2099-01-01T00:00:00Z',revision:'1',policyVersion:'policy-1'}} as never);
 const check=await x.host.execute(x.ctx,'CHECK',selection);
 x.resolve.mockResolvedValue({...authority,target:{...target,verifiedAt:'2026-09-14T00:01:00Z',freshUntil:'2099-01-01T00:01:00Z',revision:'2',policyVersion:'policy-1'}} as never);
 expect((await x.host.execute(x.ctx,'START',selection,check.ok?check.value.reviewId!:undefined)).ok).toBe(true);x.host.invalidate();
 const second=await x.host.execute(x.ctx,'CHECK',selection);
 x.resolve.mockResolvedValue({...authority,target:{...target,policyVersion:'policy-2'}} as never);
 expect(await x.host.execute(x.ctx,'START',selection,second.ok?second.value.reviewId!:undefined)).toEqual({ok:false,code:'MATERIAL_CHANGED'});
});

it('preserves authentication failure in the UI instead of claiming the material changed',async()=>{
 const {SelectedMaterialFailure}=await import('../assistant/features/autofill/selected-material');
 const x=setup();x.resolve.mockRejectedValue(new SelectedMaterialFailure());
 expect(await x.host.execute(x.ctx,'CHECK',selection)).toEqual({ok:false,code:'LOGIN_REQUIRED'});expect(x.run).not.toHaveBeenCalled();
});

it('fails closed if an untyped caller omits the executor preflight',async()=>{
 const x=setup(),approve=vi.fn();const authority=await x.resolve();
 const host=createAssistantAutofillHost({resolve:async()=>authority,approve,run:x.run,openTarget:async()=>{}} as never);
 const check=await host.execute(x.ctx,'CHECK',selection);
 expect(await host.execute(x.ctx,'START',selection,check.ok?check.value.reviewId!:undefined)).toEqual({ok:false,code:'EXECUTOR_UNAVAILABLE'});
 expect(approve).not.toHaveBeenCalled();expect(x.run).not.toHaveBeenCalled();
});
