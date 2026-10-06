import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { parseUuid } from '@edaix/contracts';
import { readLayout } from '../assistant/spike/layout-channel';
import { attestAssistantHost } from '../assistant/runtime/host-attestation';

/** Injected only by the worker after a toolbar gesture. No host selectors or profile messages. */
export default defineContentScript({
  // Imperative executeScript uses only the toolbar's activeTab grant. No automatic URL registration.
  matches: [], registration: 'runtime',
  async main(ctx) {
    const launch = await browser.runtime.sendMessage({ kind: 'assistant/host-ready-v1' }) as unknown;
    if (!launch || typeof launch !== 'object' || Object.keys(launch).length !== 2 || !('nonce' in launch) || !parseUuid(launch.nonce) || !('frameUrl' in launch) || typeof launch.frameUrl !== 'string') return;
    const expectedPrefix = browser.runtime.getURL('/assistant.html') + '?launch=';
    if (!launch.frameUrl.startsWith(expectedPrefix) || !/^[a-f0-9-]{36}$/.test(launch.frameUrl.slice(expectedPrefix.length))) return;
    const frameUrl = launch.frameUrl;
    const frame = document.createElement('iframe');
    frame.src = frameUrl; frame.title = 'ArgoLand.AI'; frame.allow = "microphone 'none'; camera 'none'";
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', border: '0', width: `${innerWidth}px`,
      height: `${innerHeight}px`, zIndex: '2147483646', background: 'transparent', colorScheme: 'light' });
    const channel = new MessageChannel(), previousFocus = document.activeElement;
    let bound = false, disposed = false;
    const viewport = () => channel.port1.postMessage({ type: 'argo-lab-viewport', width: innerWidth, height: innerHeight });
    const destroy = () => {
      if (disposed) return; disposed = true; observer.disconnect(); channel.port1.close(); frame.remove();
      window.removeEventListener('message', ready); window.removeEventListener('resize', viewport);
      browser.runtime.onMessage.removeListener(open);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
    channel.port1.onmessage = event => {
      const layout = readLayout(event.data, { width: innerWidth, height: innerHeight }); if (!layout) return;
      frame.style.width = `${layout.width}px`; frame.style.height = `${layout.height}px`;
      if (!layout.open && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
    const ready = (event: MessageEvent) => {
      if (bound || event.source !== frame.contentWindow || event.origin !== `chrome-extension://${browser.runtime.id}` || event.data?.type !== 'argo-lab-ready') return;
      bound = true; frame.contentWindow?.postMessage({ type: 'argo-lab-connect', nonce: launch.nonce }, event.origin, [channel.port2]); viewport();
    };
    const open = (message: unknown, sender: { id?: string }) => {
      const attestation = attestAssistantHost(message, sender.id, browser.runtime.id, frame, frameUrl, disposed);
      if (attestation) return Promise.resolve(attestation);
      if (sender.id === browser.runtime.id && message && typeof message === 'object' && 'kind' in message && message.kind === 'assistant/host-open-v1') {
        channel.port1.postMessage({ type: 'argo-lab-open' }); return Promise.resolve({ ok: true });
      }
    };
    const observer = new MutationObserver(() => { if (!frame.isConnected || frame.src !== frameUrl) destroy(); });
    window.addEventListener('message', ready); window.addEventListener('resize', viewport); browser.runtime.onMessage.addListener(open);
    document.documentElement.append(frame);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    observer.observe(frame, { attributes: true, attributeFilter: ['src'] });
    ctx.onInvalidated(destroy);
  },
});
