import type { AutofillPorts } from "../features/autofill/ports";
import type { AssistantAutofillSnapshot } from "@edaix/contracts";
/** Explicit fictional preview only; this module is excluded from production imports. */
export function createAutofillFixture() {
  let snapshot: AssistantAutofillSnapshot | null = null;
  const ports: AutofillPorts = {
    async execute(operation, selection, signal) {
      if (signal.aborted) return { ok: false, code: "RESULT_UNKNOWN" };
      if (operation === "READ")
        return snapshot
          ? { ok: true, value: snapshot }
          : { ok: false, code: "RESULT_UNKNOWN" };
      snapshot = {
        selection,
        reviewId: crypto.randomUUID(),
        fieldKeys: ["firstName", "email", "phone", "resumeFile"],
        phase:
          operation === "START"
            ? "SETTLED"
            : operation === "STOP"
              ? "PAUSED"
              : "READY",
        pageMatches: true,
        code: operation === "STOP" ? "RUN_STOPPED" : null,
        rows:
          operation === "START"
            ? [
                {
                  index: 0,
                  fieldKey: "firstName",
                  state: "READBACK_CONFIRMED",
                  reason: null,
                },
                {
                  index: 1,
                  fieldKey: "email",
                  state: "PRESERVED",
                  reason: "NOT_EMPTY",
                },
                {
                  index: 2,
                  fieldKey: "phone",
                  state: "MANUAL",
                  reason: "MANUAL_ONLY",
                },
                {
                  index: 3,
                  fieldKey: "resumeFile",
                  state: "FAILED",
                  reason: "LATE_REVERTED",
                },
              ]
            : [],
      };
      return { ok: true, value: snapshot };
    },
  };
  return ports;
}
