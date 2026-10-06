// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attestAssistantHost } from '../assistant/runtime/host-attestation';
const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const frameUrl = `chrome-extension://${extensionId}/assistant.html?launch=20000000-0000-4000-8000-000000000001`;
const request = { kind: 'assistant/host-attest-v1', frameUrl };
beforeEach(() => { (window as any).happyDOM.settings.disableIframePageLoading = true; });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('isolated host witness', () => {
  it('attests only the closure-owned connected child of the current top window', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    // happy-dom's parent Window is not Vitest's global proxy. Model Chrome's WindowProxy equality.
    vi.spyOn(frame, 'contentWindow', 'get').mockReturnValue({ parent: window } as unknown as Window);
    vi.spyOn(frame, 'src', 'get').mockReturnValue(frameUrl);
    const attest = (disposed = false) => attestAssistantHost(request, extensionId, extensionId, frame, frameUrl, disposed);
    expect(attest()).toEqual({ kind: 'assistant/host-attestation-v1', present: true });
    expect(attest(true)?.present).toBe(false);
    vi.spyOn(frame, 'contentWindow', 'get').mockReturnValue({ parent: {} } as unknown as Window);
    expect(attest()?.present).toBe(false);
    vi.spyOn(frame, 'contentWindow', 'get').mockReturnValue({ parent: window } as unknown as Window);
    frame.remove(); expect(attest()?.present).toBe(false);
    const replacement = document.createElement('iframe'); document.body.append(replacement);
    expect(attest()?.present).toBe(false);
    document.body.append(frame);
    vi.spyOn(frame, 'src', 'get').mockReturnValue('https://attacker.invalid');
    expect(attest()?.present).toBe(false);
  });
  it('rejects unknown senders, URL drift and body extensions without exposing state', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    // happy-dom's parent Window is not Vitest's global proxy. Model Chrome's WindowProxy equality.
    vi.spyOn(frame, 'contentWindow', 'get').mockReturnValue({ parent: window } as unknown as Window);
    vi.spyOn(frame, 'src', 'get').mockReturnValue(frameUrl);
    expect(attestAssistantHost(request, 'other', extensionId, frame, frameUrl, false)).toBeNull();
    expect(attestAssistantHost({ ...request, owner: 'private' }, extensionId, extensionId, frame, frameUrl, false)).toBeNull();
    expect(attestAssistantHost({ ...request, frameUrl: frameUrl.replace('20000000', '30000000') }, extensionId, extensionId, frame, frameUrl, false)?.present).toBe(false);
    const foreign = document.implementation.createHTMLDocument('foreign'); foreign.body.append(frame);
    expect(attestAssistantHost(request, extensionId, extensionId, frame, frameUrl, false)?.present).toBe(false);
  });
});
