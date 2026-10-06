import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { mountLabFrame } from '../mount-frame';
export default defineContentScript({
  matches: ['http://127.0.0.1/*'],
  main(ctx) {
    // Exact local lab path. No real website, auth, profile or Autofill API is reachable.
    if (location.port !== '8871' || location.pathname !== '/container.html') return;
    const dispose = mountLabFrame(`chrome-extension://${browser.runtime.id}/assistant.html`, document.body);
    ctx.onInvalidated(dispose);
  },
});
