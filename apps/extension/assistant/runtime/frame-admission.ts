export interface AssistantFrameInfo { frameId: number; parentFrameId: number; documentId?: string; parentDocumentId?: string; url: string }
export interface AssistantLaunch { tabId: number; topDocumentId: string; topUrl: string; frameUrl: string }
export interface AssistantFrameSender { id?: string; tab?: { id?: number }; frameId?: number; documentId?: string; url?: string }
export interface AssistantExtensionContext { tabId: number; frameId: number; documentId?: string; documentUrl?: string }

/** Chrome redirects a dynamic WAR URL to the canonical extension document. */
export function assistantDocumentUrl(extensionId: string, frameUrl: string): string {
  const url = new URL(frameUrl); url.hostname = extensionId; return url.href;
}

/** Browser-provided frame metadata, never a claimed tab, URL or document from a message body. */
export type AssistantFrameRejection = 'FRAME_SENDER_ID_MISMATCH' | 'FRAME_SENDER_TAB_MISMATCH'
  | 'FRAME_SENDER_FRAME_INVALID' | 'FRAME_SENDER_DOCUMENT_MISSING' | 'FRAME_SENDER_URL_MISMATCH'
  | 'FRAME_TOP_NOT_UNIQUE' | 'FRAME_TOP_DOCUMENT_MISMATCH' | 'FRAME_TOP_URL_MISMATCH'
  | 'FRAME_CHILD_NOT_UNIQUE' | 'FRAME_CHILD_ID_MISMATCH' | 'FRAME_CHILD_DOCUMENT_MISMATCH'
  | 'FRAME_HOST_ATTESTATION_FAILED';

export function assistantFrameRejection(extensionId: string, launch: AssistantLaunch, sender: AssistantFrameSender,
  frames: readonly AssistantFrameInfo[], contexts: readonly AssistantExtensionContext[], hostPresent: boolean): AssistantFrameRejection | null {
  if (sender.id !== extensionId) return 'FRAME_SENDER_ID_MISMATCH';
  if (sender.tab?.id !== launch.tabId) return 'FRAME_SENDER_TAB_MISMATCH';
  if (!Number.isSafeInteger(sender.frameId) || (sender.frameId ?? 0) <= 0) return 'FRAME_SENDER_FRAME_INVALID';
  if (!sender.documentId) return 'FRAME_SENDER_DOCUMENT_MISSING';
  const documentUrl = assistantDocumentUrl(extensionId, launch.frameUrl);
  if (sender.url !== documentUrl) return 'FRAME_SENDER_URL_MISMATCH';
  const tops = frames.filter(frame => frame.frameId === 0);
  // webNavigation filters chrome-extension:// documents. The browser runtime
  // supplies the child identity; the registered top content script witnesses its parent.
  const matching = contexts.filter(frame => frame.tabId === launch.tabId && frame.documentUrl === documentUrl);
  if (tops.length !== 1) return 'FRAME_TOP_NOT_UNIQUE';
  if (tops[0]?.documentId !== launch.topDocumentId) return 'FRAME_TOP_DOCUMENT_MISMATCH';
  if (tops[0]?.url !== launch.topUrl) return 'FRAME_TOP_URL_MISMATCH';
  if (matching.length !== 1) return 'FRAME_CHILD_NOT_UNIQUE';
  if (matching[0]?.frameId !== sender.frameId) return 'FRAME_CHILD_ID_MISMATCH';
  if (matching[0]?.documentId !== sender.documentId) return 'FRAME_CHILD_DOCUMENT_MISMATCH';
  if (!hostPresent) return 'FRAME_HOST_ATTESTATION_FAILED';
  return null;
}

export function admitAssistantFrame(extensionId: string, launch: AssistantLaunch, sender: AssistantFrameSender,
  frames: readonly AssistantFrameInfo[], contexts: readonly AssistantExtensionContext[], hostPresent: boolean): boolean {
  return assistantFrameRejection(extensionId, launch, sender, frames, contexts, hostPresent) === null;
}
