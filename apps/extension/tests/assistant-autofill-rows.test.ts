import { it, expect } from "vitest";
import { rowsFromFinalOutcomes } from "../assistant/features/autofill/run-adapter";
it("ticks only final verified writes, preserves nonempty values and hides excluded controls", () => {
  expect(
    rowsFromFinalOutcomes([
      { key: "firstName", ok: true },
      { key: "email", ok: false, reason: "NOT_EMPTY" },
      { key: "phone", ok: false, reason: "LATE_REVERTED" },
      { key: "resumeFile", ok: false, reason: "NO_VALUE" },
      { key: "trap", ok: false, reason: "HONEYPOT" },
    ]),
  ).toEqual([
    {
      index: 0,
      fieldKey: "firstName",
      state: "READBACK_CONFIRMED",
      reason: null,
    },
    { index: 1, fieldKey: "email", state: "PRESERVED", reason: "NOT_EMPTY" },
    { index: 2, fieldKey: "phone", state: "FAILED", reason: "LATE_REVERTED" },
    { index: 3, fieldKey: "resumeFile", state: "MANUAL", reason: "NO_VALUE" },
  ]);
});
