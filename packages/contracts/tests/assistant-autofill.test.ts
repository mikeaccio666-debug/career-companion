import { parseAssistantMissionRunContext, parseAssistantMissionDetailProjection } from "../src/assistantMissionRun.ts";
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_AUTOFILL_CODES,
  parseAssistantAutofillResponse,
  parseAssistantAutofillRequest,
  parseAssistantAutofillSnapshot,
} from "../src/assistantAutofill.ts";
const id = "10000000-0000-4000-8000-000000000001";
const selection = {
  batchId: id,
  preparationId: id,
  missionId: id,
  resumeVersionId: id,
};
describe("Assistant Autofill closed transport", () => {
  it("accepts references only and rejects nominated URLs, authorities and extra keys", () => {
    const request = {
      kind: "assistant/autofill-request-v1",
      id,
      operation: "START",
      selection,
      reviewId: id,
    };
    expect(parseAssistantAutofillRequest(request)).not.toBeNull();
    for (const patch of [
      { url: "https://example.test" },
      { intent: "forged" },
      { selection: { ...selection, missionId: "bad" } },
      { operation: "SUBMIT" },
    ])
      expect(
        parseAssistantAutofillRequest({ ...request, ...patch }),
      ).toBeNull();
  });
  it("admits value-free truthful rows and refuses invented success or field contents", () => {
    const snapshot = {
      selection,
      reviewId: id,
      fieldKeys: ["email"],
      phase: "SETTLED",
      pageMatches: true,
      rows: [
        {
          index: 0,
          fieldKey: "email",
          state: "READBACK_CONFIRMED",
          reason: null,
        },
      ],
      code: null,
    };
    expect(parseAssistantAutofillSnapshot(snapshot)).not.toBeNull();
    expect(
      parseAssistantAutofillSnapshot({
        ...snapshot,
        rows: [{ index: 0, fieldKey: "email", state: "DONE" }],
      }),
    ).toBeNull();
    expect(
      parseAssistantAutofillSnapshot({
        ...snapshot,
        rows: [
          {
            index: 0,
            fieldKey: "email",
            state: "READBACK_CONFIRMED",
            value: "private",
          },
        ],
      }),
    ).toBeNull();
  });
});

it("binds approval metadata to one plan and rejects ambiguous start authority", () => {
  const approval = {
    missionRevision: "2",
    missionStepId: id,
    stepAttempt: 1,
    approvalMessageId: id,
    actionId: id,
    actionRevision: "1",
    actionPayloadDigest: "sha256:" + "b".repeat(64),
    planDigest: "sha256:" + "a".repeat(64),
  };
  const context = {
    resumeVersionId: id,
    fieldKeys: ["email"],
    planDigest: approval.planDigest,
    expiresAt: "2099-01-01T00:00:00Z",
    approval,
    start: null,
  };
  expect(parseAssistantMissionRunContext(context)).not.toBeNull();
  for (const patch of [
    { approval: null },
    { start: { missionId: id, missionStepId: id, missionRevision: "3" } },
    { approval: { ...approval, planDigest: approval.actionPayloadDigest } },
    { fieldKeys: ["email", "email"] },
    { fieldKeys: ["private text"] },
    { token: "private" },
  ])
    expect(
      parseAssistantMissionRunContext({ ...context, ...patch }),
    ).toBeNull();
  expect(
    parseAssistantMissionRunContext({
      ...context,
      approval: null,
      start: { missionId: id, missionStepId: id, missionRevision: "3" },
    }),
  ).not.toBeNull();
});

it('validates the shared owner Mission projection and keeps no unrelated detail fields',()=>{
 const assistantRun={resumeVersionId:id,fieldKeys:['email'],planDigest:'sha256:'+'a'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',approval:null,start:{missionId:id,missionStepId:id,missionRevision:'4'}};
 const mission={id,revision:'4',status:'READY_TO_EXECUTE',assistantRun};
 expect(parseAssistantMissionDetailProjection({mission:{...mission,steps:[],arbitrary:'discard'}})).toEqual(mission);
 for(const patch of [{id:'invalid'},{revision:'5'},{status:'WAITING_FOR_APPROVAL'},{assistantRun:{...assistantRun,start:{...assistantRun.start,missionId:'20000000-0000-4000-8000-000000000002'}}}])
   expect(parseAssistantMissionDetailProjection({mission:{...mission,...patch}})).toBeNull();
});
it('carries every stable installation failure through the closed response without raw diagnostics',()=>{
 for(const code of ASSISTANT_AUTOFILL_CODES) expect(parseAssistantAutofillResponse({kind:'assistant/autofill-result-v1',id,ok:false,code})).not.toBeNull();
 expect(parseAssistantAutofillResponse({kind:'assistant/autofill-result-v1',id,ok:false,code:'private failure'})).toBeNull();
});
