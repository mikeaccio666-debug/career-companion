import { parseUuid } from "./common.ts";
import {
  RECEIPT_REASON_CODES,
  type ReceiptReasonCode,
} from "./draft/channel.ts";

/** Presentation commands carry references only. They never grant execution authority. */
export interface AssistantAutofillSelection {
  readonly batchId: string;
  readonly preparationId: string;
  readonly missionId: string;
  readonly resumeVersionId: string;
}
export const ASSISTANT_AUTOFILL_CODES = [
  "UNAVAILABLE",
  "LOGIN_REQUIRED",
  "OWNER_CHANGED",
  "PAGE_CHANGED",
  "MATERIAL_CHANGED",
  "RUN_BUSY",
  "RUN_STOPPED",
  "USER_ACTION_REQUIRED",
  "RESULT_UNKNOWN",
  "EXECUTOR_DOCUMENT_MISSING",
  "EXECUTOR_PROBE_INVALID",
  "EXECUTOR_TIMEOUT",
  "EXECUTOR_RELOAD_REQUIRED",
  "EXECUTOR_UNAVAILABLE",
] as const;
export type AssistantAutofillCode = (typeof ASSISTANT_AUTOFILL_CODES)[number];
export type AssistantAutofillOperation =
  "CHECK" | "START" | "READ" | "STOP" | "OPEN_TARGET";
export interface AssistantAutofillRequest {
  readonly kind: "assistant/autofill-request-v1";
  readonly id: string;
  readonly operation: AssistantAutofillOperation;
  readonly selection: AssistantAutofillSelection;
  readonly reviewId?: string;
}
export interface AssistantAutofillRow {
  readonly index: number;
  readonly fieldKey: string;
  readonly state:
    | "PENDING"
    | "WRITING"
    | "READBACK_CONFIRMED"
    | "PRESERVED"
    | "MANUAL"
    | "FAILED";
  readonly reason: ReceiptReasonCode | null;
}
export interface AssistantAutofillSnapshot {
  readonly selection: AssistantAutofillSelection;
  readonly phase: "READY" | "RUNNING" | "SETTLED" | "PAUSED";
  readonly pageMatches: boolean;
  readonly rows: readonly AssistantAutofillRow[];
  readonly code: AssistantAutofillCode | null;
  readonly reviewId: string | null;
  readonly fieldKeys: readonly string[];
}
export type AssistantAutofillResult =
  | { readonly ok: true; readonly value: AssistantAutofillSnapshot }
  | { readonly ok: false; readonly code: AssistantAutofillCode };
export type AssistantAutofillResponse = AssistantAutofillResult & {
  readonly kind: "assistant/autofill-result-v1";
  readonly id: string;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));
export function parseAssistantDockVisibility(
  v: unknown,
): { kind: "assistant/dock-visibility-v1"; hidden: boolean } | null {
  return record(v) &&
    keys(v, ["kind", "hidden"]) &&
    v.kind === "assistant/dock-visibility-v1" &&
    typeof v.hidden === "boolean"
    ? (v as { kind: "assistant/dock-visibility-v1"; hidden: boolean })
    : null;
}
export function parseAssistantAutofillSelection(
  v: unknown,
): AssistantAutofillSelection | null {
  return record(v) &&
    keys(v, ["batchId", "preparationId", "missionId", "resumeVersionId"]) &&
    Object.values(v).every((x) => parseUuid(x) !== null)
    ? (v as unknown as AssistantAutofillSelection)
    : null;
}
export function parseAssistantAutofillRequest(
  v: unknown,
): AssistantAutofillRequest | null {
  return record(v) &&
    keys(v, [
      "kind",
      "id",
      "operation",
      "selection",
      ...(v.operation === "START" ? ["reviewId"] : []),
    ]) &&
    v.kind === "assistant/autofill-request-v1" &&
    parseUuid(v.id) &&
    (v.operation !== "START" || !!parseUuid(v.reviewId)) &&
    ["CHECK", "START", "READ", "STOP", "OPEN_TARGET"].includes(
      String(v.operation),
    ) &&
    parseAssistantAutofillSelection(v.selection)
    ? (v as unknown as AssistantAutofillRequest)
    : null;
}
export function parseAssistantAutofillSnapshot(
  v: unknown,
): AssistantAutofillSnapshot | null {
  if (
    !record(v) ||
    !keys(v, [
      "selection",
      "phase",
      "pageMatches",
      "rows",
      "code",
      "reviewId",
      "fieldKeys",
    ]) ||
    !parseAssistantAutofillSelection(v.selection) ||
    !(v.reviewId === null || parseUuid(v.reviewId)) ||
    !Array.isArray(v.fieldKeys) ||
    v.fieldKeys.length > 256 ||
    !v.fieldKeys.every(
      (k) =>
        typeof k === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(k),
    ) ||
    new Set(v.fieldKeys).size !== v.fieldKeys.length ||
    !["READY", "RUNNING", "SETTLED", "PAUSED"].includes(String(v.phase)) ||
    typeof v.pageMatches !== "boolean" ||
    !(
      v.code === null ||
      ASSISTANT_AUTOFILL_CODES.includes(v.code as AssistantAutofillCode)
    ) ||
    !Array.isArray(v.rows) ||
    v.rows.length > 256
  )
    return null;
  if (
    !v.rows.every(
      (r, i) =>
        record(r) &&
        keys(r, ["index", "fieldKey", "state", "reason"]) &&
        r.index === i &&
        typeof r.fieldKey === "string" &&
        /^[A-Za-z][A-Za-z0-9_.:\[\]-]{0,127}$/.test(r.fieldKey) &&
        [
          "PENDING",
          "WRITING",
          "READBACK_CONFIRMED",
          "PRESERVED",
          "MANUAL",
          "FAILED",
        ].includes(String(r.state)) &&
        (r.reason === null ||
          RECEIPT_REASON_CODES.includes(r.reason as ReceiptReasonCode)),
    )
  )
    return null;
  return v as unknown as AssistantAutofillSnapshot;
}
export function parseAssistantAutofillResponse(
  v: unknown,
): AssistantAutofillResponse | null {
  if (
    !record(v) ||
    v.kind !== "assistant/autofill-result-v1" ||
    !parseUuid(v.id)
  )
    return null;
  if (
    v.ok === true &&
    keys(v, ["kind", "id", "ok", "value"]) &&
    parseAssistantAutofillSnapshot(v.value)
  )
    return v as unknown as AssistantAutofillResponse;
  if (
    v.ok === false &&
    keys(v, ["kind", "id", "ok", "code"]) &&
    ASSISTANT_AUTOFILL_CODES.includes(v.code as AssistantAutofillCode)
  )
    return v as unknown as AssistantAutofillResponse;
  return null;
}
