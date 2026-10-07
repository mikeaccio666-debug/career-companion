import type { AccountVaultUi, AccountVaultUiState } from '../features/account-vault/model';
import type { VaultSiteView } from '../features/account-vault/ports';

const label = (origin: string) => { try { return new URL(origin).hostname; } catch { return origin; } };
const status = (site: VaultSiteView) => site.state === 'PENDING' ? '注册还没完成'
  : site.state === 'NEEDS_PASSWORD' ? '需要你保存密码'
    : site.source === 'USER_SAVED' || site.source === 'LEGACY_SITE' ? '已保存密码' : '已注册';

/** Only mounted by the extension-owned vault entrypoint; never in an ATS frame. */
export function AccountVaultScene({ state, ui, selectedOrigin }: { state: AccountVaultUiState; ui: AccountVaultUi; selectedOrigin: string | null }) {
  const snapshot = state.snapshot;
  const ready = state.phase === 'READY' && snapshot?.status === 'READABLE' && snapshot.revision !== null;
  const blocked = snapshot?.status === 'KEY_MISSING' ? '本机密钥丢失，保存的密码无法恢复。请到对应网站上重设密码。'
    : snapshot?.status === 'UNREADABLE' ? '这份保存内容读不出来，无法恢复密码。请到对应网站上重设密码。' : null;
  return <>
    {state.transition !== null && <section className="vault-card vault-transition" aria-labelledby="vault-transition-title">
      <h2 id="vault-transition-title">{state.transition.action === 'LOGOUT' ? '退出前，先保存招聘网站账号' : '换账号前，先保存招聘网站账号'}</h2>
      <p>{state.transition.hasVault ? '确认后会删除这台电脑保存的招聘网站账号。可以先导出，再回来确认。' : '确认后会结束当前登录。'}</p>
      {state.transition.hasVault && !state.transition.canExport && <p className="vault-help">现在无法导出原账号的密码。请先重新连接原账号，保存好密码后再换账号。</p>}
      <div className="vault-actions">
        {state.transition.hasVault && <button type="button" disabled={!state.transition.canExport || !ready || state.transitionBusy} onClick={(event) => ui.askExport(event.nativeEvent)}>先导出</button>}
        <button type="button" data-action="cancel-transition" disabled={state.transitionBusy} onClick={(event) => void ui.resolveTransition('CANCEL', event.nativeEvent)}>先不</button>
        <button type="button" className="vault-primary" data-action="confirm-transition" disabled={state.transitionBusy} onClick={(event) => void ui.resolveTransition('CONFIRM', event.nativeEvent)}>{state.transitionBusy ? '正在处理…' : state.transition.action === 'LOGOUT' ? '清除并退出' : '清除并换账号'}</button>
      </div>
    </section>}
    <section className="vault-card vault-safety" aria-label="本机保存说明">
      <h2>密码保存在这台电脑上</h2>
      <p>换电脑或清除浏览器数据前先导出。本机密钥丢失后，保存的密码无法恢复，只能到网站上重设。</p>
      <p className="vault-help">退出登录或换账号前会请你确认，并给你导出的机会。</p>
    </section>
    <section className="vault-card" aria-labelledby="vault-sites-title">
      <div className="vault-section-head"><h2 id="vault-sites-title">保存的网站</h2><button type="button" data-action="export-vault" disabled={!ready || state.busy !== null || state.transitionBusy} onClick={(event) => ui.askExport(event.nativeEvent)}>导出 CSV</button></div>
      {state.phase === 'LOADING' && <p role="status">正在读取这台电脑保存的账号…</p>}
      {state.phase === 'LOCKED' && <p>密码已隐藏，重新读取后再查看。</p>}
      {state.phase === 'UNAVAILABLE' && <p>现在读不到保存的账号，尚未查看或导出密码。</p>}
      {blocked !== null && <p role="status" className="vault-help">{blocked}</p>}
      {state.phase === 'READY' && snapshot?.status === 'EMPTY' && <p>这台电脑还没有保存招聘网站账号。</p>}
      {ready && snapshot.sites.length === 0 && <p>还没有关联到网站的账号。已有的旧共用密码会单独保存在导出文件里。</p>}
      {ready && <ul className="vault-sites">{snapshot.sites.map((site) => {
        const revealed = state.revealed?.origin === site.origin ? state.revealed.password : null;
        return <li key={site.origin} className="vault-site" data-selected={site.origin === selectedOrigin} data-origin={site.origin}>
          <div className="vault-site-heading"><h3>{label(site.origin)}</h3><span className="vault-chip">{status(site)}</span></div>
          <p className="vault-origin">{site.origin}</p>
          <dl><div><dt>登录邮箱</dt><dd>{site.email ?? '没有保存邮箱'}</dd></div><div><dt>密码</dt><dd className="vault-password">
            {site.hasPassword ? <><input aria-label={`${label(site.origin)} 的密码`} type={revealed === null ? 'password' : 'text'} value={revealed ?? ''} placeholder="••••••••••••" autoComplete="off" readOnly spellCheck={false} />
              <button type="button" data-action="reveal-site" disabled={state.busy !== null || state.transitionBusy} onClick={(event) => { if (!event.nativeEvent.isTrusted) return; if (revealed !== null) ui.hide(); else void ui.reveal(site.origin, event.nativeEvent); }}>{revealed === null ? '查看密码' : '隐藏'}</button></> : <span>没有保存密码，请到网站上重设。</span>}
          </dd></div></dl>
          {site.state === 'PENDING' && <p className="vault-help">有密码还不代表注册完成，请先完成网站要求的验证。</p>}
          {(site.source === 'LEGACY_SHARED' || site.source === 'LEGACY_SITE') && <p className="vault-help">此前保存的账号。新注册的网站会分别生成独立密码。</p>}
        </li>;
      })}</ul>}
    </section>
    {state.confirmExport && <section className="vault-card vault-export-confirm" aria-labelledby="vault-export-title">
      <h2 id="vault-export-title">保存一份账号备份</h2>
      <p>CSV 含明文密码，用于导入 Chrome 或 1Password 等密码管理器。请妥善保存，导入后删除不需要的副本。</p>
      <p className="vault-help">若文件里有「旧共用密码（未关联网站）」，这一行没有网址，需要手动保存。</p>
      <div className="vault-actions"><button type="button" onClick={(event) => { if (event.nativeEvent.isTrusted) ui.cancelExport(); }}>先不</button><button type="button" className="vault-primary" data-action="confirm-export" onClick={(event) => void ui.export(event.nativeEvent)}>下载账号备份</button></div>
    </section>}
    {state.notice !== null && <p className="vault-notice" role="status">{state.notice}</p>}
    {state.busy !== null && <p className="vault-notice" role="status">{state.busy === 'EXPORT' ? '正在准备本地下载…' : '正在读取这一家保存的密码…'}</p>}
  </>;
}
