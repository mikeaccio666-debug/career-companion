import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { AccountVaultPage } from '../../assistant/shell/AccountVaultPage';
import { createAccountVaultUi } from '../../assistant/features/account-vault/model';
import { createVaultSettingsPorts, downloadVaultCsv } from '../../assistant/features/account-vault/runtime-client';
import { isVaultSiteOrigin } from '../../lib/accountVaultTransitionIntent';

const page = new URL(location.href);
const selected = page.searchParams.get('selectedOrigin');
const ports = createVaultSettingsPorts({
  extensionId: browser.runtime.id,
  managementUrl: browser.runtime.getURL('/vault.html'),
  pageUrl: page.href,
  send: (message) => browser.runtime.sendMessage(message),
  subscribe(listener) {
    const receive = (message: unknown) => { listener(message); };
    browser.runtime.onMessage.addListener(receive);
    return () => browser.runtime.onMessage.removeListener(receive);
  },
  download: (csv) => downloadVaultCsv(document, csv),
});
const root = document.getElementById('root');
if (root === null) throw new Error('VAULT_PAGE_UNAVAILABLE');
createRoot(root).render(<AccountVaultPage ui={createAccountVaultUi(ports)} selectedOrigin={isVaultSiteOrigin(selected) ? selected : null} />);
