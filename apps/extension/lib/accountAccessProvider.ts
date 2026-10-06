import { generateAccountPassword, sharedPasswordProblem } from './accountPassword';
import type { DockAccountAccessPayload, DockAccountAccessReply } from './accountAccessIntent';
import { EMPTY_ACCOUNT_VAULT, type AccountVault, type AccountVaultRecord } from './accountVault';

/**
 * worker 侧：招聘网站账号（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）。
 *
 * 保险箱只在这里。交出邮箱与密码（`CREDENTIAL`）之前两把钥匙都要在：
 *  1. 运行时包里 `account-access` 开着、这一家的总开关开着（`capability`，按这一页的厂商现解，读不到当关）；
 *  2. 他同意着点名「替你注册账号和登录」的那一版代填授权（`consent`，读后端记录，读不到当没同意）。
 * 发信人与这一页（我们自己的内容脚本、登记过的那一页、规则声明了账号墙的厂商）由 background.ts 在调这里之前判。
 *
 * 共用密码没有就在第一次交出时生成（accountPassword.ts 的规则），存进保险箱再交出去。
 *
 * **不出这台电脑**：这里没有任何网络调用；邮箱默认值来自调用方给的 `profileEmail`（worker 本来就在读的扁平档案），
 * 同意来自调用方给的 `consent`（读的是同意记录本身，不带任何账号数据）。诊断只有 `ACCOUNT_ACCESS_*` 稳定码。
 */

export type AccountAccessDiagnostic =
  | 'ACCOUNT_ACCESS_NOT_SIGNED_IN'
  | 'ACCOUNT_ACCESS_CONSENT_MISSING'
  | 'ACCOUNT_ACCESS_DISABLED'
  | 'ACCOUNT_ACCESS_NO_EMAIL'
  | 'ACCOUNT_ACCESS_PASSWORD_GENERATED'
  | 'ACCOUNT_ACCESS_VAULT_FAILED'
  | 'ACCOUNT_ACCESS_OWNER_CHANGED'
  | `ACCOUNT_ACCESS_RECORDED_${'CREATED' | 'SIGNED_IN' | 'EXISTS'}`;

export interface AccountAccessProviderDeps {
  readonly vault: AccountVault;
  /** 此刻登录的 ArgoLand 用户；没登录是 null。 */
  readonly getUserId: () => Promise<string | null>;
  /** 第二把钥匙：同意着点名这一类的那一版。 */
  readonly consent: () => Promise<boolean>;
  /** 第一把钥匙：运行时包里这一家的 `account-access`。 */
  readonly capability: () => Promise<boolean>;
  /** 资料里的邮箱（没改过注册邮箱时用它）；读不到是 null。 */
  readonly profileEmail: () => Promise<string | null>;
  readonly now?: () => number;
  readonly generate?: () => string;
  readonly onDiagnostic?: (code: AccountAccessDiagnostic) => void;
}

export interface AccountAccessProvider {
  /** `site` 是这一页的 origin（按 origin 记每一家）。 */
  handle(payload: DockAccountAccessPayload, site: string): Promise<DockAccountAccessReply>;
}

const refuse = (code: Extract<DockAccountAccessReply, { kind: 'REFUSED' }>['code']): DockAccountAccessReply =>
  Object.freeze({ kind: 'REFUSED', code });

export function createAccountAccessProvider(deps: AccountAccessProviderDeps): AccountAccessProvider {
  const now = deps.now ?? (() => Date.now());
  const generate = deps.generate ?? (() => generateAccountPassword());
  const diag = (code: AccountAccessDiagnostic): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不影响这一下。
    }
  };
  const safely = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch {
      return fallback;
    }
  };

  /** 这份保险箱属于此刻登录的这个人：还没写过就认领；属于别人就整份作废（换了一个 ArgoLand 用户）。 */
  const ownVault = async (userId: string): Promise<AccountVaultRecord> => {
    const record = await deps.vault.read();
    if (record.owner === null || record.owner === userId) return record;
    diag('ACCOUNT_ACCESS_OWNER_CHANGED');
    await deps.vault.clear();
    return EMPTY_ACCOUNT_VAULT;
  };

  const settings = async (userId: string): Promise<DockAccountAccessReply> => {
    const record = await ownVault(userId);
    const defaultEmail = await safely(deps.profileEmail, null);
    return Object.freeze({
      kind: 'ACCOUNT_SETTINGS',
      email: record.email,
      defaultEmail,
      hasPassword: record.password !== null,
      sites: Object.values(record.sites).filter((site) => site.password !== undefined).length,
    });
  };

  async function handle(payload: DockAccountAccessPayload, site: string): Promise<DockAccountAccessReply> {
    const userId = await safely(deps.getUserId, null);
    if (userId === null || userId === '') {
      diag('ACCOUNT_ACCESS_NOT_SIGNED_IN');
      return refuse('UNAVAILABLE');
    }
    try {
      switch (payload.step) {
        case 'STATUS': {
          const [consent, enabled, record] = await Promise.all([
            safely(deps.consent, false),
            safely(deps.capability, false),
            ownVault(userId),
          ]);
          const entry = record.sites[site];
          return Object.freeze({ kind: 'ACCOUNT_STATUS', consent, enabled, known: entry?.known === true || entry?.password !== undefined });
        }
        case 'CREDENTIAL': {
          // 两把钥匙都在才交出密码：先判开关（不读同意记录也能判），再判同意。
          if (!(await safely(deps.capability, false))) {
            diag('ACCOUNT_ACCESS_DISABLED');
            return refuse('DISABLED');
          }
          if (!(await safely(deps.consent, false))) {
            diag('ACCOUNT_ACCESS_CONSENT_MISSING');
            return refuse('CONSENT_REQUIRED');
          }
          let record = await ownVault(userId);
          const email = record.email ?? await safely(deps.profileEmail, null);
          if (email === null || email.trim() === '') {
            diag('ACCOUNT_ACCESS_NO_EMAIL');
            return refuse('NO_EMAIL');
          }
          const entry = record.sites[site];
          let generated = false;
          if (entry?.password === undefined && record.password === null) {
            const password = generate();
            record = await deps.vault.update((current) => ({ ...current, owner: userId, password: current.password ?? password }));
            generated = record.password === password;
            if (generated) diag('ACCOUNT_ACCESS_PASSWORD_GENERATED');
          }
          const password = entry?.password ?? record.password;
          if (password === null) return refuse('UNAVAILABLE');
          return Object.freeze({
            kind: 'ACCOUNT_CREDENTIAL',
            email: email.trim(),
            password,
            source: entry?.password === undefined ? 'SHARED' : 'SITE',
            generated,
            known: entry?.known === true || entry?.password !== undefined,
          });
        }
        case 'RECORD': {
          await deps.vault.update((current) => ({
            ...current,
            owner: userId,
            sites: { ...current.sites, [site]: { ...current.sites[site], known: true, at: now() } },
          }));
          diag(`ACCOUNT_ACCESS_RECORDED_${payload.outcome}`);
          return Object.freeze({ kind: 'ACCOUNT_SAVED' });
        }
        case 'SITE_PASSWORD': {
          await ownVault(userId);
          await deps.vault.update((current) => ({
            ...current,
            owner: userId,
            sites: { ...current.sites, [site]: { password: payload.password, known: true, at: now() } },
          }));
          return Object.freeze({ kind: 'ACCOUNT_SAVED' });
        }
        case 'SETTINGS_GET':
          return await settings(userId);
        case 'SETTINGS_SET_EMAIL': {
          await ownVault(userId);
          await deps.vault.update((current) => ({ ...current, owner: userId, email: payload.email }));
          return await settings(userId);
        }
        case 'SETTINGS_SET_PASSWORD': {
          if (sharedPasswordProblem(payload.password) !== null) return refuse('WEAK_PASSWORD');
          await ownVault(userId);
          await deps.vault.update((current) => ({ ...current, owner: userId, password: payload.password }));
          return await settings(userId);
        }
        case 'REVEAL': {
          const record = await ownVault(userId);
          return Object.freeze({ kind: 'ACCOUNT_PASSWORD', password: record.password });
        }
      }
    } catch {
      diag('ACCOUNT_ACCESS_VAULT_FAILED');
      return refuse('UNAVAILABLE');
    }
  }

  return Object.freeze({ handle });
}
