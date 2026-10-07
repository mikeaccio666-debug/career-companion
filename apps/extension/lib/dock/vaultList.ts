import type { DockVaultManagement } from './types';
import { el, trusted } from './dom';
import type { VaultSnapshotView } from '../../assistant/features/account-vault/ports';

export interface DockVaultListCopy {
  readonly loading: string;
  readonly empty: string;
  readonly unavailable: string;
  readonly keyMissing: string;
  readonly unreadable: string;
  readonly pending: string;
  readonly registered: string;
  readonly saved: string;
  readonly needsPassword: string;
  readonly manage: string;
  readonly view: string;
  readonly note: string;
}

/** Metadata-only child of the actual dock. This module has no reveal/export port. */
export function createDockVaultList(doc: Document, shadowRoot: ShadowRoot, port: DockVaultManagement | undefined, copy: DockVaultListCopy) {
  const root = el(doc, 'div', 'acct-sites');
  root.dataset.account = 'sites';
  let generation = 0, request = new AbortController();
  const clear = () => { generation += 1; request.abort(); request = new AbortController(); root.replaceChildren(); };
  const open = (origin: string | null, event: MouseEvent) => {
    const current = generation;
    void port?.openSettings(origin, event, shadowRoot).catch(() => false).then((opened) => {
      if (current === generation && opened === false) root.append(el(doc, 'p', 'acct-sub', copy.unavailable));
    });
  };
  const render = (snapshot: VaultSnapshotView | null) => {
    root.replaceChildren();
    if (snapshot === null) root.append(el(doc, 'p', 'acct-sub', copy.unavailable));
    else if (snapshot.status === 'KEY_MISSING' || snapshot.status === 'UNREADABLE') root.append(el(doc, 'p', 'acct-sub', snapshot.status === 'KEY_MISSING' ? copy.keyMissing : copy.unreadable));
    else if (snapshot.sites.length === 0) root.append(el(doc, 'p', 'acct-sub', copy.empty));
    else for (const site of snapshot.sites) {
      const row = el(doc, 'div', 'acct-site');
      let hostname = site.origin;
      try { hostname = new URL(site.origin).hostname; } catch { /* Render text only; the worker rechecks the origin. */ }
      row.append(el(doc, 'b', 'acct-site-title', hostname));
      const status = site.state === 'PENDING' ? copy.pending : site.state === 'NEEDS_PASSWORD' ? copy.needsPassword
        : site.source === 'USER_SAVED' || site.source === 'LEGACY_SITE' ? copy.saved : copy.registered;
      row.append(el(doc, 'span', 'acct-sub', status));
      // Password existence is metadata; never ask for or render the password here.
      if (site.hasPassword) row.append(el(doc, 'span', 'acct-value', '••••••••'));
      const view = trusted(doc, 'acct-link', (event) => open(site.origin, event), copy.view);
      view.dataset.action = 'account-open-site-settings';
      view.dataset.origin = site.origin;
      row.append(view); root.append(row);
    }
    if (port !== undefined) {
      const settings = trusted(doc, 'acct-link', (event) => open(null, event), copy.manage);
      settings.dataset.action = 'account-open-settings'; root.append(settings);
    }
    root.append(el(doc, 'p', 'acct-sub', copy.note));
  };
  return {
    element: root,
    clear,
    load() {
      clear(); const current = generation;
      root.append(el(doc, 'p', 'acct-sub', copy.loading));
      if (port === undefined) { render(null); return; }
      void port.list(request.signal).catch(() => null).then((reply) => {
        if (current !== generation || request.signal.aborted) return;
        render(reply?.ok === true ? reply.value : null);
      });
    },
  };
}
