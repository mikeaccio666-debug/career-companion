import { parseUuid, parseSha256Digest, parseIsoDateTime } from "./common.ts";
import type { AssistantMissionRunContext } from "./missions.ts";
export type {
  AssistantMissionApprovalRef,
  AssistantMissionRunContext,
} from "./missions.ts";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, k: readonly string[]) =>
  Object.keys(v).length === k.length && k.every((x) => Object.hasOwn(v, x));
const revision = (v: unknown) =>
  typeof v === "string" &&
  /^[1-9][0-9]{0,18}$/.test(v) &&
  BigInt(v) <= 9223372036854775807n;
export function parseAssistantMissionRunContext(
  v: unknown,
): AssistantMissionRunContext | null {
  if (
    !record(v) ||
    !keys(v, [
      "resumeVersionId",
      "fieldKeys",
      "planDigest",
      "expiresAt",
      "approval",
      "start",
    ]) ||
    !parseUuid(v.resumeVersionId) ||
    !parseSha256Digest(v.planDigest) ||
    !parseIsoDateTime(v.expiresAt) ||
    !Array.isArray(v.fieldKeys) ||
    v.fieldKeys.length < 1 ||
    v.fieldKeys.length > 256 ||
    !v.fieldKeys.every(
      (k) =>
        typeof k === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(k),
    ) ||
    new Set(v.fieldKeys).size !== v.fieldKeys.length
  )
    return null;
  if ((v.approval === null) === (v.start === null)) return null;
  if (
    v.start !== null &&
    (!record(v.start) ||
      !keys(v.start, ["missionId", "missionStepId", "missionRevision"]) ||
      !parseUuid(v.start.missionId) ||
      !parseUuid(v.start.missionStepId) ||
      !revision(v.start.missionRevision))
  )
    return null;
  if (v.approval !== null) {
    const a = v.approval;
    if (
      !record(a) ||
      !keys(a, [
        "missionRevision",
        "missionStepId",
        "stepAttempt",
        "approvalMessageId",
        "actionId",
        "actionRevision",
        "actionPayloadDigest",
        "planDigest",
      ]) ||
      !revision(a.missionRevision) ||
      !parseUuid(a.missionStepId) ||
      !Number.isSafeInteger(a.stepAttempt) ||
      Number(a.stepAttempt) < 1 ||
      !parseUuid(a.approvalMessageId) ||
      !parseUuid(a.actionId) ||
      !revision(a.actionRevision) ||
      !parseSha256Digest(a.actionPayloadDigest) ||
      a.planDigest !== v.planDigest
    )
      return null;
  }
  return v as unknown as AssistantMissionRunContext;
}

/** Validated, value-free projection of the existing owner-only GET Mission envelope.
 * The executable MissionDetailView remains the source type; unrelated detail fields are not retained.
 */
export function parseAssistantMissionDetailProjection(value: unknown): Pick<import('./missions.ts').MissionDetailView, 'id' | 'revision' | 'status'> & {readonly assistantRun: AssistantMissionRunContext} | null {
  if (!record(value) || !record(value.mission)) return null;
  const mission = value.mission;
  const id = parseUuid(mission.id);
  const assistantRun = parseAssistantMissionRunContext(mission.assistantRun);
  if (!id || !revision(mission.revision) || !assistantRun ||
    (mission.status !== 'WAITING_FOR_APPROVAL' && mission.status !== 'READY_TO_EXECUTE')) return null;
  const ref = assistantRun.start ?? assistantRun.approval!;
  if (ref.missionRevision !== mission.revision ||
    (assistantRun.start && (assistantRun.start.missionId !== id || mission.status !== 'READY_TO_EXECUTE')) ||
    (assistantRun.approval && mission.status !== 'WAITING_FOR_APPROVAL')) return null;
  return {id, revision: mission.revision as import('./missions.ts').MissionDetailView['revision'], status:mission.status, assistantRun};
}
