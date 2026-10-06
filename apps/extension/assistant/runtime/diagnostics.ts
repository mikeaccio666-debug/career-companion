import type { AssistantAutofillCode } from "@edaix/contracts";
import type { AssistantFrameRejection } from './frame-admission';

/** Local development diagnostics only. Never accept a payload, URL, identity or exception. */
export type AssistantRuntimeDiagnostic = AssistantFrameRejection | AssistantAutofillCode
  | 'WORKER_SENDER_MISSING' | 'WORKER_SENDER_ID_MISMATCH' | 'WORKER_SENDER_TAB_MISSING'
  | 'WORKER_LAUNCH_MISSING' | 'WORKER_LAUNCH_REPLACED' | 'WORKER_LAUNCH_READ_FAILED'
  | 'WORKER_FRAME_LOOKUP_FAILED' | 'WORKER_REQUEST_MALFORMED' | 'WORKER_REQUEST_REPLAY'
  | 'WORKER_CONTEXT_LOOKUP_FAILED' | 'WORKER_HOST_ATTESTATION_UNAVAILABLE'
  | 'WORKER_INFLIGHT_LIMIT' | 'WORKER_REQUEST_LIMIT' | 'WORKER_OPERATION_FAILED'
  | 'WORKER_RESPONSE_POST_FAILED' | 'WORKER_TOP_CONTEXT_CHANGED' | 'WORKER_CHILD_DOCUMENT_CHANGED'
  | 'CLIENT_RESPONSE_MALFORMED' | 'CLIENT_RESPONSE_UNEXPECTED' | 'CLIENT_PORT_DISCONNECTED'
  | 'CLIENT_RECEIVER_MISSING' | 'CLIENT_SEND_FAILED';

export function reportAssistantDiagnostic(code: AssistantRuntimeDiagnostic): void {
  console.warn('[ArgoLand.AI]', code);
}
