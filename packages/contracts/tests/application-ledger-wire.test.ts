import { describe, expect, it } from "vitest";
import {
  decodeListApplicationLedgerResponse,
  decodeUpdatePrimaryTimeZoneResponse,
} from "../src/applicationLedgerWire.ts";

const applicationId = "11111111-1111-4111-8111-111111111111";
const canonicalJobId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";

function ledgerResponse() {
  return {
    schemaVersion: 1,
    primaryTimeZone: "America/Los_Angeles",
    items: [{
      applicationId,
      canonicalJobId,
      applicationBundleVersion: "1",
      status: "VERIFIED",
      dateState: "KNOWN",
      firstProviderConfirmedSubmittedAt: "2026-08-24T10:00:00.000Z",
      receipts: [{
        receiptId,
        sourceOutcome: "SUBMISSION_TRIGGERED",
        effectiveOutcome: "SUBMISSION_CONFIRMED",
        verificationLevel: "PROVIDER_CONFIRMED",
        submittedAt: "2026-08-24T10:00:00.000Z",
        verifiedAt: "2026-08-24T10:00:01.000Z",
      }],
      milestones: ["FINAL_ROUND"],
      outcome: "REJECTED",
    }],
    nextCursor: null,
  };
}

describe("Application Ledger hostile-boundary codec", () => {
  it("accepts the exact response including an authoritative direct milestone skip", () => {
    expect(decodeListApplicationLedgerResponse(ledgerResponse())).toEqual(
      ledgerResponse(),
    );
  });

  it.each([
    ["extra wrapper key", (value: ReturnType<typeof ledgerResponse>) => {
      (value as Record<string, unknown>).debug = true;
    }],
    ["extra receipt key", (value: ReturnType<typeof ledgerResponse>) => {
      (value.items[0]!.receipts[0] as Record<string, unknown>).providerId = "secret";
    }],
    ["non-canonical timezone alias", (value: ReturnType<typeof ledgerResponse>) => {
      value.primaryTimeZone = "US/Pacific";
    }],
    ["malformed provider timestamp", (value: ReturnType<typeof ledgerResponse>) => {
      value.items[0]!.receipts[0]!.submittedAt = "yesterday";
    }],
    ["KNOWN date without account timezone", (value: ReturnType<typeof ledgerResponse>) => {
      value.primaryTimeZone = null as never;
    }],
    ["client claims provider confirmation", (value: ReturnType<typeof ledgerResponse>) => {
      value.items[0]!.receipts[0]!.verificationLevel = "CLIENT_REPORTED";
    }],
    ["duplicate receipt", (value: ReturnType<typeof ledgerResponse>) => {
      value.items[0]!.receipts.push({ ...value.items[0]!.receipts[0]! });
    }],
    ["VERIFIED status paired with a conflict date state", (value: ReturnType<typeof ledgerResponse>) => {
      value.items[0]!.dateState = "UNKNOWN_CONFLICT";
      value.items[0]!.firstProviderConfirmedSubmittedAt = null as never;
    }],
    ["zero bundle version", (value: ReturnType<typeof ledgerResponse>) => {
      value.items[0]!.applicationBundleVersion = "0";
    }],
    ["non-ascending Application ids", (value: ReturnType<typeof ledgerResponse>) => {
      value.items.push({
        ...value.items[0]!,
        applicationId: "00000000-0000-4000-8000-000000000000",
      });
    }],
    ["next cursor not equal to the final Application id", (value: ReturnType<typeof ledgerResponse>) => {
      value.nextCursor = "44444444-4444-4444-8444-444444444444" as never;
    }],
  ])("rejects %s", (_label, mutate) => {
    const value = ledgerResponse();
    mutate(value);
    expect(decodeListApplicationLedgerResponse(value)).toBeNull();
  });

  it("rejects a continuation cursor on an empty page", () => {
    const value = ledgerResponse();
    value.items = [];
    value.nextCursor = "44444444-4444-4444-8444-444444444444" as never;
    expect(decodeListApplicationLedgerResponse(value)).toBeNull();
  });

  it("rejects malformed and extra PATCH response fields", () => {
    expect(decodeUpdatePrimaryTimeZoneResponse({
      schemaVersion: 1,
      primaryTimeZone: "America/Los_Angeles",
    })).not.toBeNull();
    expect(decodeUpdatePrimaryTimeZoneResponse({
      schemaVersion: 1,
      primaryTimeZone: "US/Pacific",
    })).toBeNull();
    expect(decodeUpdatePrimaryTimeZoneResponse({
      schemaVersion: 1,
      primaryTimeZone: "America/Los_Angeles",
      accepted: true,
    })).toBeNull();
  });

  it("accepts the server's fail-closed projection of a legacy confirmed source fact", () => {
    const value = ledgerResponse();
    Object.assign(value.items[0]!, {
      status: "SUBMITTED_UNVERIFIED",
      dateState: "UNKNOWN_MISSING_SUBMITTED_AT",
      firstProviderConfirmedSubmittedAt: null,
    });
    Object.assign(value.items[0]!.receipts[0]!, {
      sourceOutcome: "SUBMISSION_CONFIRMED",
      effectiveOutcome: "SUBMISSION_TRIGGERED",
      verificationLevel: "CLIENT_REPORTED",
      submittedAt: null,
      verifiedAt: null,
    });

    expect(decodeListApplicationLedgerResponse(value)).not.toBeNull();
  });
});

const jobSummary = {
  canonicalJobId, canonicalJobRevision: "4", listingId: "44444444-4444-4444-8444-444444444444",
  listingGenerationKey: "generation-1", descriptionDigest: `sha256:${"a".repeat(64)}`,
  title: "Software Engineer", company: "Example", checkedAt: "2026-09-09T10:00:00.000Z",
  freshUntil: "2026-09-09T11:00:00.000Z",
};
function enriched(summary: unknown) {
  const response = ledgerResponse();
  return { ...response, items: [{ ...response.items[0], jobSummary: summary }] };
}
it("accepts legacy, explicit unavailable and exact bound summaries", () => {
  for (const response of [ledgerResponse(), enriched(null), enriched(jobSummary)]) {
    expect(decodeListApplicationLedgerResponse(response)).toEqual(response);
  }
});
it.each([
  { canonicalJobId: applicationId }, { canonicalJobRevision: "01" }, { title: "" },
  { company: "bad\ncompany" }, { descriptionDigest: "invalid" }, { listingId: "invalid" },
  { freshUntil: jobSummary.checkedAt }, { description: "must not cross this boundary" },
])("rejects invalid or misbound material metadata %j", (patch) => {
  expect(decodeListApplicationLedgerResponse(enriched({ ...jobSummary, ...patch }))).toBeNull();
});


it("validates opt-in recording activity without accepting invented or unbound milestones", () => {
  const base = ledgerResponse();
  const withActivity = (activity: unknown) => ({ ...base, items: [{ ...base.items[0], activity }] });
  const event = { milestone: "FINAL_ROUND", recordedAt: "2026-09-09T08:00:00.000Z" };
  expect(decodeListApplicationLedgerResponse(withActivity(null))).not.toBeNull();
  expect(decodeListApplicationLedgerResponse(withActivity({ source: "REFERRAL", milestones: [event] }))).not.toBeNull();
  for (const activity of [
    { source: "PROVIDER", milestones: [event] },
    { source: "REFERRAL", milestones: [] },
    { source: "REFERRAL", milestones: [event, event] },
    { source: "REFERRAL", milestones: [{ ...event, milestone: "INTERVIEW" }] },
    { source: "REFERRAL", milestones: [{ ...event, recordedAt: "yesterday" }] },
    { source: "REFERRAL", milestones: [{ ...event, rawText: "not permitted" }] },
  ]) expect(decodeListApplicationLedgerResponse(withActivity(activity))).toBeNull();
});
