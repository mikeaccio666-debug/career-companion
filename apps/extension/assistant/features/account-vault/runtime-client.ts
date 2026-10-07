import { createAccountVaultManagementIntent, parseAccountVaultManagementReply, type AccountVaultManagementPayload } from '../../../lib/accountAccessIntent';
import { isVaultManagementSender, parseExtensionVaultTransitionIntent, parseVaultTransitionReply, type VaultTransitionPayload } from '../../../lib/accountVaultTransitionIntent';
import { isDockSessionChanged } from '../../../lib/dockSessionChanged';
import type { AccountVaultUiPorts, VaultUiFailure, VaultUiResult } from './ports';

interface VaultUiRuntime {
  readonly extensionId: string;
  readonly managementUrl: string;
  readonly pageUrl: string;
  send(message: unknown): Promise<unknown>;
  subscribe(listener: (message: unknown) => void): () => void;
  download(csv: string): void;
}

const failure = <T>(code: VaultUiFailure = 'UNAVAILABLE'): VaultUiResult<T> => ({ ok: false, code });
const mapFailure = (code: string): VaultUiFailure => {
  if (code === 'AUTH_CHANGED' || code === 'OWNER_CHANGED' || code === 'KEY_MISSING' || code === 'UNREADABLE' || code === 'CLEAR_FAILED' || code === 'EXPIRED' || code === 'CANCELED') return code;
  return code === 'REVISION_CHANGED' || code === 'OPERATION_STALE' ? 'CHANGED' : 'UNAVAILABLE';
};

/** Transport only: the worker rechecks its real sender and current account. */
export function createVaultSettingsPorts(runtime: VaultUiRuntime): AccountVaultUiPorts {
  const pageAllowed = isVaultManagementSender({ id: runtime.extensionId, frameId: 0, url: runtime.pageUrl }, runtime.extensionId, runtime.managementUrl);
  const page = new URL(runtime.pageUrl);
  let logoutPrepared = false;
  const management = async (payload: AccountVaultManagementPayload, signal: AbortSignal) => {
    const message = createAccountVaultManagementIntent(payload);
    if (!pageAllowed || signal.aborted || message === null) return null;
    const reply = await runtime.send(message);
    return signal.aborted ? null : parseAccountVaultManagementReply(reply);
  };
  const transition = async (payload: VaultTransitionPayload, signal: AbortSignal) => {
    const message = parseExtensionVaultTransitionIntent({ kind: 'account-vault/transition', version: 1, payload });
    if (!pageAllowed || signal.aborted || message === null) return null;
    const reply = await runtime.send(message);
    return signal.aborted ? null : parseVaultTransitionReply(reply);
  };
  return {
    async list(signal) {
      try {
        const reply = await management({ step: 'LIST' }, signal);
        return reply?.kind === 'VAULT_LIST' ? { ok: true, value: reply } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
    async reveal(input, event, signal) {
      if (!event.isTrusted) return failure('UNTRUSTED');
      try {
        const reply = await management({ step: 'REVEAL', ...input }, signal);
        return reply?.kind === 'ACCOUNT_PASSWORD' ? { ok: true, value: reply } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
    async export(input, event, signal) {
      if (!event.isTrusted) return failure('UNTRUSTED');
      try {
        const reply = await management({ step: 'EXPORT', ...input }, signal);
        return reply?.kind === 'VAULT_EXPORT' ? { ok: true, value: reply } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
    download(csv) { if (!pageAllowed) throw new Error('VAULT_PAGE_UNAVAILABLE'); runtime.download(csv); },
    onInvalidated(listener) { return runtime.subscribe((message) => { if (isDockSessionChanged(message)) listener(); }); },
    async loadPendingTransition(signal) {
      try {
        let reply = await transition({ step: 'PENDING' }, signal);
        if (reply?.kind === 'TRANSITION_NONE' && page.searchParams.get('action') === 'logout' && !logoutPrepared) {
          logoutPrepared = true;
          reply = await transition({ step: 'PREPARE_LOGOUT' }, signal);
        }
        if (reply?.kind === 'CONFIRM_REQUIRED') return { ok: true, value: reply };
        return reply?.kind === 'TRANSITION_NONE' ? { ok: true, value: null } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
    async confirmTransition(ticket, event, signal) {
      if (!event.isTrusted) return failure('UNTRUSTED');
      try {
        const reply = await transition({ step: 'CONFIRM', ticket }, signal);
        return reply?.kind === 'TRANSITION_DONE' ? { ok: true, value: undefined } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
    async cancelTransition(ticket, event, signal) {
      if (!event.isTrusted) return failure('UNTRUSTED');
      try {
        const reply = await transition({ step: 'CANCEL', ticket }, signal);
        return reply?.kind === 'REFUSED' && reply.code === 'CANCELED' ? { ok: true, value: undefined } : failure(reply?.kind === 'REFUSED' ? mapFailure(reply.code) : 'UNAVAILABLE');
      } catch { return failure(); }
    },
  };
}

/** Local download from the extension page; CSV is never rendered or sent to a server. */
export function downloadVaultCsv(doc: Document, csv: string): void {
  const win = doc.defaultView;
  if (win === null) throw new Error('VAULT_PAGE_UNAVAILABLE');
  const url = win.URL.createObjectURL(new win.Blob([csv], { type: 'text/csv;charset=utf-8' }));
  try {
    const link = doc.createElement('a');
    link.href = url; link.download = 'career-companion-passwords.csv';
    link.hidden = true; doc.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally { setTimeout(() => win.URL.revokeObjectURL(url), 0); }
}
