import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountVaultScene } from '../assistant/scenes/AccountVaultScene';
import { createAccountVaultUi, type AccountVaultUiState } from '../assistant/features/account-vault/model';

const ui = createAccountVaultUi({
  list: async () => ({ ok: false, code: 'UNAVAILABLE' }), reveal: async () => ({ ok: false, code: 'UNAVAILABLE' }), export: async () => ({ ok: false, code: 'UNAVAILABLE' }), download: () => {}, onInvalidated: () => () => {},
});
const origin = 'https://careers.example.test';
const ready: AccountVaultUiState = { phase: 'READY', snapshot: {
  status: 'READABLE', revision: 1, authEpoch: 2, email: 'student@example.test', defaultEmail: null,
  sites: [{ origin, email: 'student@example.test', source: 'GENERATED', state: 'PENDING', hasPassword: true, at: 1 }],
}, revealed: null, busy: null, confirmExport: false, notice: null, transition: null, transitionBusy: false };
const render = (state: AccountVaultUiState) => renderToStaticMarkup(<AccountVaultScene state={state} ui={ui} selectedOrigin={origin} />);

describe('extension-owned vault scene', () => {
  it('shows the selected site, pending registration and masked password independently', () => {
    const html = render(ready);
    expect(html).toContain('data-selected="true"'); expect(html).toContain('注册还没完成');
    expect(html).not.toContain('>已注册<'); expect(html).toContain('type="password"'); expect(html).toContain('value=""');
    expect(html).toContain('换电脑或清除浏览器数据前先导出');
  });

  it('reveals only the selected site in the settings page', () => {
    const html = render({ ...ready, revealed: { origin, password: 'fictional-secret' } });
    expect(html).toContain('type="text"'); expect(html).toContain('value="fictional-secret"');
  });

  it.each(['KEY_MISSING', 'UNREADABLE'] as const)('does not offer export for %s or label it empty', (status) => {
    const html = render({ ...ready, snapshot: { ...ready.snapshot!, status, revision: null, sites: [] } });
    expect(html).toContain(status === 'KEY_MISSING' ? '本机密钥丢失' : '读不出来');
    expect(html).not.toContain('这台电脑还没有保存');
    expect(html).toMatch(/data-action="export-vault" disabled=""/u);
  });

  it('shows plaintext export notice and both confirmation choices', () => {
    const html = render({ ...ready, confirmExport: true });
    expect(html).toContain('CSV 含明文密码'); expect(html).toContain('Chrome 或 1Password');
    expect(html).toContain('下载账号备份'); expect(html).toContain('先不');
  });

  it('gives export and cancellation before destructive account change, with locked-old-owner explanation', () => {
    const html = render({ ...ready, transition: { ticket: 'worker-ticket', action: 'SWITCH_ACCOUNT', hasVault: true, canExport: false, expiresAt: Date.now() + 10_000 } });
    expect(html).toContain('先重新连接原账号'); expect(html).toContain('确认后会删除');
    expect(html).toContain('清除并换账号'); expect(html).toContain('先不');
    expect(html).not.toContain('worker-ticket');
  });
});
