import { describe, it, expect, vi } from "vitest";
import { createSelectedMaterialResolver } from "../assistant/features/autofill/selected-material";
const id = "10000000-0000-4000-8000-000000000001";
const selection = {
  batchId: id,
  preparationId: id,
  missionId: id,
  resumeVersionId: id,
};
describe("Selected preparation authority", () => {
  it("reads the exact preparation and Mission without listing or guessing among 25 candidates", async () => {
    const fetchFn = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/preparations")
              ? {
                  schemaVersion: 1,
                  batchId: id,
                  conversationId: id,
                  items: [
                    {
                      preparationId: id,
                      itemId: id,
                      revision: "1",
                      status: "READY",
                      failureCode: null,
                      retryable: false,
                      resumeVersionId: id,
                      missionId: id,
                      updatedAt: "2026-09-13T00:00:00Z",
                    },
                  ],
                }
              : {
                  mission: {
                    id,
                    revision: "4",
                    status: "READY_TO_EXECUTE",
                    assistantRun: {
                      resumeVersionId: id,
                      fieldKeys: ["email"],
                      planDigest: "sha256:" + "a".repeat(64),
                      expiresAt: "2099-01-01T00:00:00Z",
                      approval: null,
                      start: {
                        missionId: id,
                        missionStepId: id,
                        missionRevision: "4",
                      },
                    },
                  },
                },
          ),
          { status: 200 },
        ),
    );
    const target = {
      missionRevision: "4",
      canonicalOrigin: "https://example.test",
      pathname: "/apply",
    };
    const refreshAccessToken = vi.fn(async()=>"refreshed");
    const resolve = createSelectedMaterialResolver({
      apiBase: "https://api.example.test",
      accessToken: async () => "fixture",
      refreshAccessToken,
      resolveTarget: async () => target as never,
      fetchFn: fetchFn as never,
    });
    const context = {
      tabId: 1,
      ownerKey: "owner:1",
      topUrl: "https://example.test/apply",
      signal: new AbortController().signal,
      current: async () => true,
    };
    expect(await resolve(selection, context)).toMatchObject({
      mission: { missionId: id, missionRevision: "4" },
    });
    expect(fetchFn.mock.calls.map((x) => x[0])).toEqual([
      `https://api.example.test/api/v1/agent/recommendation-batches/${id}/preparations`,
      `https://api.example.test/api/v1/agent/missions/${id}`,
    ]);
    fetchFn.mockImplementationOnce(async()=>new Response('{}',{status:401}));
    expect(await resolve(selection,context)).toMatchObject({mission:{missionId:id}});
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(
      await resolve(
        {
          ...selection,
          resumeVersionId: "20000000-0000-4000-8000-000000000002",
        },
        context,
      ),
    ).toBeNull();
    target.missionRevision = "5";
    expect(await resolve(selection, context)).toBeNull();
  });
});

it("approves only the reviewed metadata, then re-reads the bound resume, plan and incremented revision", async () => {
  let approved = false,
    changed = false;
  const digest = "sha256:" + "a".repeat(64);
  const approval = {
    missionRevision: "2",
    missionStepId: id,
    stepAttempt: 1,
    approvalMessageId: id,
    actionId: id,
    actionRevision: "1",
    actionPayloadDigest: digest,
    planDigest: digest,
  };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        ...approval,
        clientRequestId: id,
        decision: "APPROVE",
      });
      approved = true;
      return new Response("{}", { status: 200 });
    }
    return new Response(
      JSON.stringify(
        url.endsWith("/preparations")
          ? {
              schemaVersion: 1,
              batchId: id,
              conversationId: id,
              items: [
                {
                  preparationId: id,
                  itemId: id,
                  revision: "1",
                  status: "READY",
                  failureCode: null,
                  retryable: false,
                  resumeVersionId: id,
                  missionId: id,
                  updatedAt: "2026-09-13T00:00:00Z",
                },
              ],
            }
          : {
              mission: {
                id,
                revision: approved ? "3" : "2",
                status: approved ? "READY_TO_EXECUTE" : "WAITING_FOR_APPROVAL",
                assistantRun: {
                  resumeVersionId: id,
                  fieldKeys: changed ? ["phone"] : ["email"],
                  planDigest: digest,
                  expiresAt: "2099-01-01T00:00:00Z",
                  approval: approved ? null : approval,
                  start: approved
                    ? { missionId: id, missionStepId: id, missionRevision: "3" }
                    : null,
                },
              },
            },
      ),
      { status: 200 },
    );
  });
  const resolve = createSelectedMaterialResolver({
    apiBase: "https://api.example.test",
    accessToken: async () => "fixture",
    resolveTarget: async () =>
      ({
        missionRevision: approved ? "3" : "2",
        canonicalOrigin: "https://example.test",
        pathname: "/apply",
      }) as never,
    fetchFn: fetchFn as never,
  });
  const context = {
    tabId: 1,
    ownerKey: "owner:1",
    topUrl: "https://example.test/apply",
    signal: new AbortController().signal,
    current: async () => true,
  };
  const pending = (await resolve(selection, context))!;
  expect(pending.runContext.start).toBeNull();
  expect(await resolve.approve(selection, pending, context, id)).toMatchObject({
    mission: { missionRevision: "3" },
    runContext: { approval: null },
  });
  changed = true;
  expect(await resolve.approve(selection, pending, context, id)).toBeNull();
  const before = fetchFn.mock.calls.length;
  expect(
    await resolve.approve(
      selection,
      pending,
      { ...context, current: async () => false },
      id,
    ),
  ).toBeNull();
  expect(fetchFn).toHaveBeenCalledTimes(before);
});

it.each(['no-token','refresh-failed','repeat-401'])('preserves LOGIN_REQUIRED for %s',async(kind)=>{
 const refresh=vi.fn(async()=>kind==='refresh-failed'?null:'fresh');const fetchFn=vi.fn(async()=>new Response('{}',{status:401}));
 const resolve=createSelectedMaterialResolver({apiBase:'https://api.example.test',accessToken:async()=>kind==='no-token'?null:'expired',refreshAccessToken:refresh,resolveTarget:async()=>null,fetchFn});
 await expect(resolve(selection,{tabId:1,ownerKey:'owner',topUrl:'https://example.test/apply',signal:new AbortController().signal,current:async()=>true})).rejects.toMatchObject({code:'LOGIN_REQUIRED'});
 expect(refresh).toHaveBeenCalledTimes(kind==='no-token'?0:1);expect(fetchFn).toHaveBeenCalledTimes(kind==='no-token'?0:kind==='repeat-401'?2:1);
});
it('refreshes once and rechecks owner before retrying a read',async()=>{
 let current=true;const fetchFn=vi.fn(async()=>new Response('{}',{status:401}));
 const resolve=createSelectedMaterialResolver({apiBase:'https://api.example.test',accessToken:async()=> 'expired',refreshAccessToken:async()=>{current=false;return 'fresh';},resolveTarget:async()=>null,fetchFn});
 expect(await resolve(selection,{tabId:1,ownerKey:'owner',topUrl:'https://example.test/apply',signal:new AbortController().signal,current:async()=>current})).toBeNull();
 expect(fetchFn).toHaveBeenCalledTimes(1);
});
