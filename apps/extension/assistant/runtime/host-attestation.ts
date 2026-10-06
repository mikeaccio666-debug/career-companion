import { parseAssistantHostAttest, type AssistantHostAttestation } from '@edaix/contracts';

/** Closure-owned iframe in the isolated content script; never locate it with a host selector. */
export function attestAssistantHost(message: unknown, senderId: string | undefined, extensionId: string,
  frame: HTMLIFrameElement, frameUrl: string, disposed: boolean): AssistantHostAttestation | null {
  if (senderId !== extensionId) return null;
  const request = parseAssistantHostAttest(message);
  if (!request) return null;
  return { kind: 'assistant/host-attestation-v1', present: !disposed && request.frameUrl === frameUrl &&
    window === window.top && frame.ownerDocument === document && frame.isConnected && frame.src === frameUrl &&
    frame.contentWindow !== null && frame.contentWindow.parent === window };
}
