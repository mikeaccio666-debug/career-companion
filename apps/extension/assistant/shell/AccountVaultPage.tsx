import { useEffect, useSyncExternalStore } from 'react';
import type { AccountVaultUi } from '../features/account-vault/model';
import { AccountVaultScene } from '../scenes/AccountVaultScene';
import '../design/account-vault.css';

export function AccountVaultPage({ ui, selectedOrigin = null }: { ui: AccountVaultUi; selectedOrigin?: string | null }) {
  const state = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState !== 'visible') ui.lock(); else void ui.load(); };
    const blur = () => ui.lock();
    const focus = () => { void ui.load(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    void ui.load();
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); ui.dispose(); };
  }, [ui]);
  return <main className="vault-page" lang="zh-CN">
    <header className="vault-header"><div><p className="vault-eyebrow">AI 求职伙伴 · 本机设置</p><h1>招聘网站账号</h1><p>查看各网站保存的账号，或导出一份你自己保管的备份。</p></div><button type="button" data-action="refresh-vault" onClick={(event) => { if (event.nativeEvent.isTrusted) void ui.load(); }}>重新读取</button></header>
    <AccountVaultScene state={state} ui={ui} selectedOrigin={selectedOrigin} />
    <footer className="vault-footer">这里的密码不会发送到求职平台的服务器。最终提交申请仍由你本人操作。</footer>
  </main>;
}
