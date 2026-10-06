import {
  getMission,
  listApplicationPreparations,
  parseApplicationPreparationsResponse,
  parseAssistantAutofillSelection,
  parseAssistantMissionDetailProjection,
  recordMissionApproval,
} from "@edaix/contracts";
import type { VerifiedApplicationTarget } from "@edaix/agent-channel";
import type { RecordMissionApprovalRequest } from "@edaix/contracts";
import type { AssistantAutofillHostDependencies } from "./host";

/** Only a closed local error crosses the resolver boundary; never a server message. */
export class SelectedMaterialFailure extends Error {
  readonly code = "LOGIN_REQUIRED" as const;
  constructor() { super("LOGIN_REQUIRED"); }
}
/** Exact owner reads replace the legacy first-25 Mission search for selected jobs. */
export function createSelectedMaterialResolver(input: {
  apiBase: string;
  accessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  resolveTarget: (id: string) => Promise<VerifiedApplicationTarget | null>;
  fetchFn?: typeof fetch;
}) {
  const request = async (path: string, context: Parameters<AssistantAutofillHostDependencies["resolve"]>[1], signal: AbortSignal, init: RequestInit): Promise<Response | null> => {
    const current = async () => !signal.aborted && await context.current() && !signal.aborted;
    if (!await current()) return null;
    let token = await input.accessToken();
    if (!await current()) return null;
    if (!token) throw new SelectedMaterialFailure();
    const send = (credential: string) => (input.fetchFn ?? fetch)(new URL(path, input.apiBase).href, {
      ...init, headers: {...init.headers, accept: "application/json", authorization: `Bearer ${credential}`},
      cache: "no-store", redirect: "error", signal,
    });
    let response = await send(token);
    if (response.status === 401) {
      if (!await current()) return null;
      token = await input.refreshAccessToken?.() ?? null;
      if (!await current()) return null;
      if (!token) throw new SelectedMaterialFailure();
      response = await send(token);
    }
    if (!await current()) return null;
    if (response.status === 401) throw new SelectedMaterialFailure();
    return response;
  };
  const resolve: AssistantAutofillHostDependencies["resolve"] = async (
    selection,
    context,
  ) => {
    if (
      !parseAssistantAutofillSelection(selection) ||
      context.signal.aborted ||
      !(await context.current())
    )
      return null;
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(12_000),
    ]);
    const get = async (path: string): Promise<unknown> => {
      const response = await request(path, context, signal, {method:"GET"});
      return response?.ok && response.status === 200 ? response.json() : null;
    };
    try {
      const batch = parseApplicationPreparationsResponse(
        await get(
          listApplicationPreparations.path.replace(
            ":batchId",
            selection.batchId,
          ),
        ),
      );
      const preparation =
        batch?.batchId === selection.batchId
          ? batch.items.find((p) => p.preparationId === selection.preparationId)
          : null;
      if (
        preparation?.status !== "READY" ||
        preparation.missionId !== selection.missionId ||
        preparation.resumeVersionId !== selection.resumeVersionId
      )
        return null;
      const detail = await get(
        getMission.path.replace(
          ":missionId",
          selection.missionId,
        ),
      );
      const state = parseAssistantMissionDetailProjection(detail);
      const runContext = state?.assistantRun;
      if (
        !runContext ||
        runContext.resumeVersionId !== selection.resumeVersionId ||
        state?.id !== selection.missionId ||
        !["WAITING_FOR_APPROVAL", "READY_TO_EXECUTE"].includes(
          String(state.status),
        ) ||
        Date.parse(runContext.expiresAt) <= Date.now()
      )
        return null;
      const mission = runContext.start ?? {
        missionId: selection.missionId,
        missionStepId: runContext.approval!.missionStepId,
        missionRevision: runContext.approval!.missionRevision,
      };
      if (
        state.revision !== mission.missionRevision ||
        mission.missionId !== selection.missionId
      )
        return null;

      const target = await input.resolveTarget(selection.missionId);
      if (
        !target ||
        target.missionRevision !== mission.missionRevision ||
        signal.aborted ||
        !(await context.current())
      )
        return null;
      return { mission, target, runContext };
    } catch (error) {
      if (error instanceof SelectedMaterialFailure) throw error;
      return null;
    }
  };
  const approve: NonNullable<
    AssistantAutofillHostDependencies["approve"]
  > = async (selection, authority, context, requestId) => {
    if (
      !authority.runContext.approval ||
      context.signal.aborted ||
      !(await context.current())
    )
      return null;
    try {
      const approvalRequest: RecordMissionApprovalRequest = {
        ...authority.runContext.approval,
        clientRequestId: requestId as never,
        decision: "APPROVE",
      };
      const response = await request(
        recordMissionApproval.path.replace(":missionId", selection.missionId),
        context, AbortSignal.any([context.signal, AbortSignal.timeout(12000)]),
        {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(approvalRequest)},
      );
      if (!response?.ok || response.status !== 200) return null;
      const current = await resolve(selection, context);
      if (
        !current?.runContext.start ||
        BigInt(current.mission.missionRevision) !==
          BigInt(authority.mission.missionRevision) + 1n ||
        current.runContext.planDigest !== authority.runContext.planDigest ||
        JSON.stringify(current.runContext.fieldKeys) !==
          JSON.stringify(authority.runContext.fieldKeys)
      )
        return null;
      return current;
    } catch (error) {
      if (error instanceof SelectedMaterialFailure) throw error;
      return null;
    }
  };
  return Object.assign(resolve, { approve });
}
