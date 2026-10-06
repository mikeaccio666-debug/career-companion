import { APPLICATION_SIGNING_CONSENT_VERSION } from '@edaix/contracts';

import type { DockSigningReconsent } from './dock/types';

/**
 * 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人（同意过旧版本的也在内：只有当前版本算数），浮层里
 * 一张卡请他同意。
 *
 * 要不要请：worker 读后端记录判（`signingConsentProvider` 的 `reconsent`：服务端要的正是这版插件显示的那一版、他没同意、
 * 最新一条事件也不是撤回），随预取的档案答复带来；他在这一台电脑上对这一版说过「暂不」，就不再请（记在 storage.local，
 * 只记版本号，不记别的）。
 *
 * 同意：那一下必须是我们关着的 shadow 里的真实点击——在任何 await 之前当场验（`verifyGesture`），验不过什么都不发；
 * 验过才经 worker 把**这一版**的版本号记到 argoland（与资料编辑器里那一格同一对端点）。存成了，预取的档案答复作废，
 * 下一轮填写就按它代填。暂不：什么都不改（没同意就不代填同意类），只是这一版不再请他。
 */
export const SIGNING_RECONSENT_DECLINED_KEY = 'argolandSigningReconsentDeclined';

export interface SigningReconsentDeps {
  /** 经 worker 同意这一版（`profileDirectoryClient.setSigningConsent(true)`）：答 true 才算存成。 */
  readonly grant: () => Promise<Readonly<{ ok: true; value: boolean }> | Readonly<{ ok: false }>>;
  /** 这一下是不是我们 shadow 里的真实点击（派发当下同步验）。 */
  readonly verifyGesture: (event: MouseEvent, shadowRoot: ShadowRoot) => boolean;
  /** 把「这一版暂不」记在本机。 */
  readonly remember: (version: string) => void;
  /** 存成之后：让预取的档案答复作废。 */
  readonly onSaved?: () => void;
}

export interface SigningReconsent extends DockSigningReconsent {
  /** 预取的档案答复回来了：它说要不要请他更新。 */
  readonly observe: (offered: boolean) => void;
  /** 报到时从 storage.local 读回来的「暂不」（只认正是这一版的）。 */
  readonly restoreDeclined: (stored: unknown) => void;
}

export function createSigningReconsent(deps: SigningReconsentDeps): SigningReconsent {
  let offeredByWorker = false;
  let declined = false;
  let accepted = false;
  return Object.freeze({
    observe: (offered: boolean) => { offeredByWorker = offered; },
    restoreDeclined: (stored: unknown) => { declined = stored === APPLICATION_SIGNING_CONSENT_VERSION; },
    offered: () => offeredByWorker && !declined && !accepted,
    accept: async (event: MouseEvent, shadowRoot: ShadowRoot): Promise<boolean> => {
      // 在任何 await 之前验：过了这一刻，事件就不再是「正在派发的那一下」。
      if (accepted || !deps.verifyGesture(event, shadowRoot)) return false;
      let result: Awaited<ReturnType<SigningReconsentDeps['grant']>>;
      try {
        result = await deps.grant();
      } catch {
        return false;
      }
      if (!result.ok || result.value !== true) return false;
      accepted = true;
      try {
        deps.onSaved?.();
      } catch {
        // 作废预取只是让下一轮早点读到新版本；做不成，下一次预取过期时一样会读到。
      }
      return true;
    },
    decline: () => {
      declined = true;
      try {
        deps.remember(APPLICATION_SIGNING_CONSENT_VERSION);
      } catch {
        // 记不下只是下次打开还会再问一次；这一页已经不再问了。
      }
    },
  });
}
