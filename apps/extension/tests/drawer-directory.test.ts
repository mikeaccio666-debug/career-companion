// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('the profile scene reads what it shows', () => {
  // A scene that fetched on mount would pull someone's whole profile onto a
  // host page to show a launcher, so it asks only when the user opens it — and
  // through the one door production actually serves: the owner's Profile V2.
  it('fetches the profile when the scene is opened, and not before', async () => {
    const asked: string[] = [];
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, {
      onAutofill: () => {},
      onOpenEntry: () => {},
      directory: {
        profileV2: async () => { asked.push('profileV2'); return { ok: false, code: 'UNAVAILABLE' }; },
        saveProfileV2: async () => { asked.push('save'); return { ok: false, code: 'UNAVAILABLE' }; },
      },
    }, doc);
    expect(asked, 'nothing is fetched before the user asks for it').toEqual([]);
    handle.entryButtons()[0]?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    await settle();
    expect(asked).toEqual(['profileV2']);
    // 2026-09-23 新编辑器：读不到就照实说，并给「在 ArgoLand 里编辑」。
    expect(handle.profileRoot()?.textContent).toContain('暂时读不到你的资料');
  });
});
