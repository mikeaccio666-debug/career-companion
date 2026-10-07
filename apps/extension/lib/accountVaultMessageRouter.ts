import { parseAccountVaultManagementIntent, type AccountVaultManagementPayload, type AccountVaultManagementReply } from './accountAccessIntent';
import { isVaultManagementSender, parseDockOpenVaultIntent, parseDockVaultTransitionIntent, parseExtensionVaultTransitionIntent, type VaultManagementSender } from './accountVaultTransitionIntent';
import { MANAGEMENT_TRANSITION_BINDING, type AccountVaultTransitions } from './accountVaultTransitions';
import type { SenderPageClaim, SenderPageLike } from './senderPage';

/** The actual worker uses these routes. ATS/portal callers can only open a tab;
 * secret replies and destructive confirmations belong to the extension page. */
export function createAccountVaultMessageRouter(deps: Readonly<{
  extensionId: string;
  managementUrl: string;
  manage: (payload: AccountVaultManagementPayload) => Promise<AccountVaultManagementReply>;
  transitions: AccountVaultTransitions;
  pageAllowed: (sender: SenderPageLike, page: SenderPageClaim) => Promise<boolean>;
  openTab: (url: string) => Promise<void>;
}>) {
  const binding = MANAGEMENT_TRANSITION_BINDING;
  return Object.freeze({
    management(message: unknown, sender: VaultManagementSender) {
      const intent = parseAccountVaultManagementIntent(message);
      if (intent === null || !isVaultManagementSender(sender, deps.extensionId, deps.managementUrl)) return undefined;
      return deps.manage(intent.payload);
    },
    transition(message: unknown, sender: VaultManagementSender) {
      const intent = parseExtensionVaultTransitionIntent(message);
      if (intent === null || !isVaultManagementSender(sender, deps.extensionId, deps.managementUrl)) return undefined;
      const payload = intent.payload;
      if (payload.step === 'PREPARE_LOGOUT') return deps.transitions.prepareLogout(binding);
      if (payload.step === 'PENDING') return deps.transitions.pending(binding);
      if (payload.step === 'CONFIRM') return deps.transitions.confirm(payload.ticket, binding);
      return Promise.resolve(deps.transitions.cancel(payload.ticket, binding));
    },
    open(message: unknown, sender: SenderPageLike) {
      const open = parseDockOpenVaultIntent(message), transition = parseDockVaultTransitionIntent(message);
      const intent = open ?? transition;
      if (intent === null || (transition !== null && transition.payload.step !== 'PREPARE_LOGOUT')) return undefined;
      return deps.pageAllowed(sender, intent).then(async (allowed) => {
        if (!allowed) return { ok: false as const };
        const url = new URL(deps.managementUrl);
        if (transition !== null) url.searchParams.set('action', 'logout');
        else if (open?.selectedOrigin !== undefined) url.searchParams.set('selectedOrigin', open.selectedOrigin);
        await deps.openTab(url.toString());
        return { ok: true as const };
      }).catch(() => ({ ok: false as const }));
    },
  });
}
