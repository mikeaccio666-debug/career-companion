import { readLayout } from './layout-channel';

/** Controlled host only: a separate frame owns its CSS, focus and presentation. */
export function mountLabFrame(url: string, parent: HTMLElement) {
  const iframe = document.createElement('iframe');
  iframe.dataset.labState = 'waiting'; iframe.src = url; iframe.title = 'ArgoLand.AI 容器验证';
  iframe.allow = "microphone 'none'; camera 'none'";
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', border: '0', width: `${innerWidth}px`, height: `${innerHeight}px`, zIndex: '2147483646', background: 'transparent', colorScheme: 'light' });
  const channel = new MessageChannel();
  const parsed = new URL(url);
  const targetOrigin = parsed.protocol === 'chrome-extension:' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  const viewport = () => channel.port1.postMessage({ type: 'argo-lab-viewport', width: innerWidth, height: innerHeight });
  channel.port1.onmessage = event => {
    const layout = readLayout(event.data, { width: innerWidth, height: innerHeight }); if (!layout) { iframe.dataset.labState = 'layout-rejected'; return; }
    iframe.dataset.labState = 'sized';
    iframe.style.width = `${layout.width}px`; iframe.style.height = `${layout.height}px`;
  };
  let connected = false;
  const connect = (event: MessageEvent) => {
    if (connected || event.source !== iframe.contentWindow || event.origin !== targetOrigin || event.data?.type !== 'argo-lab-ready') return;
    connected = true; iframe.dataset.labState = 'connected'; iframe.contentWindow?.postMessage({ type: 'argo-lab-connect' }, targetOrigin, [channel.port2]); viewport();
  };
  window.addEventListener('message', connect); window.addEventListener('resize', viewport);
  parent.append(iframe);
  return () => { window.removeEventListener('message', connect); window.removeEventListener('resize', viewport); channel.port1.close(); iframe.remove(); };
}
