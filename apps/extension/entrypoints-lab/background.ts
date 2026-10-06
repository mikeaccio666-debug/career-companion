/**
 * ATS lab worker (VIBE_DIST=ats-lab only).
 *
 * The lab has no backend, no auth, no intents and no receipts. The worker does
 * two things: the toolbar action forwards a fill command to the active tab's
 * lab content script, and run logs from content scripts are kept in session
 * storage so a person can read them from the extension's service worker
 * console. Nothing here touches a host page.
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

export default defineBackground(() => {
  if (!__VIBE_ATS_LAB__) return;

  browser.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const id = `action-${Date.now().toString(36)}`;
    browser.tabs.sendMessage(tab.id, { kind: 'lab/fill', id }).catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return false;
    const { kind, payload } = message as { kind?: unknown; payload?: unknown };
    if (kind !== 'lab/log') return false;
    const key = `lab:${sender.tab?.id ?? 'x'}:${Date.now()}`;
    void browser.storage.session.set({ [key]: payload }).catch(() => undefined);
    sendResponse({ ok: true });
    return false;
  });
});
