/**
 * 站点支持度三态（CAP-AF-014）。
 *
 * 卡片逐字：「非四家页面上彻底静默——不注入、不解释，连『我认不出这一页』
 * 都不说。」impact 逐字：「用户完全不知道该不该等，形成**「这插件时灵时不灵」**
 * 的印象；我们也拿不到覆盖缺口的真实分布。欧洲站点在 Simplify 上大面积失效
 * 仍属高频差评，说明**「说不清自己支不支持」本身就是差评来源**。」
 *
 * ## 三态的判据是「用户此刻该做什么」
 *
 *  · `SUPPORTED`        认出厂商且表单解析成功 —— 等着，我们来填。不打扰。
 *  · `LIKELY_SUPPORTED` 认出厂商但没解析出表单 —— **这一刻最该解释**。
 *    用户在一个我们"应该支持"的站点上干等，而我们什么都不会发生。
 *    最典型：Greenhouse 的岗位描述页（不是申请页），或申请页改版后锚点失效。
 *  · `UNSUPPORTED`      没认出厂商 —— 别等了。
 *
 * ## ⚠️ UNSUPPORTED 不自动弹面板
 *
 * 宽注入之下 UNSUPPORTED 意味着"任意网页"。在每一个网页上弹东西，正是 Simplify
 * 那条「lags my computer to a complete stop」差评的形状——用户不会归因于页面，
 * 会直接卸载。所以分类照做、状态照报，**自动可见的解释只给 LIKELY_SUPPORTED**：
 * 那是用户真的在等我们的唯一场景。
 *
 * 卡片提到的「一键复制兜底面板」需要一个用户主动触发点（扩展图标／popup），
 * 而本仓 manifest 今天只有 `permissions: ['storage']`、没有 `action`。
 * 触发面归 CAP-AF-069 那一批（上架形态与权限），这里先把**判定**做实，
 * 触发点落地后直接消费，不用改判据。
 */

import type { ApplyGateRefusal } from '@edaix/apply-kernel/gate';
import type { ApplyVendor } from '@edaix/apply-kernel/contracts';

export type SiteSupportState = 'SUPPORTED' | 'LIKELY_SUPPORTED' | 'UNSUPPORTED';

export interface SiteSupportInput {
  /** 门控认出的厂商；认不出是 null。 */
  readonly vendor: ApplyVendor | null;
  /** 门控拒绝挂载的原因；挂载了是 null。 */
  readonly gateRefusal: ApplyGateRefusal | null;
  /** `readApplyForm` 是否真的解析出了表单——归属的终点是这一步，不是指纹。 */
  readonly formParsed: boolean;
}

/**
 * 该对用户说哪一句。null = 什么都不说。
 *
 *  · `SIGN_IN_FIRST` —— 认出厂商，但这一页是登录／建号页（账号墙 ATS 的第 1 步，
 *    Workday／Avature 系都是这个形态）。**这不是"不能碰"就等于"不能说"**：
 *    当前 pre-approval runtime 的密码只能用户本人输；pending L2-P 即使获批也只能走
 *    独立的 origin-bound local credential authority，不能从该页面指引推导授权。告诉他"你先登录，登录完我接手"是
 *    我们该做的事——竞品也是这么做的（引导到站点、用户在那边用插件）。
 *    我方浮层里**没有任何输入框**，说的是"请在本页自己输入"——形状上与钓鱼相反。
 *  · `NO_FORM_FOUND` —— 认出厂商、也不是登录页，但解析不出申请表。
 */
export type SiteGuidance = 'SIGN_IN_FIRST' | 'NO_FORM_FOUND';

export interface SiteSupportVerdict {
  readonly state: SiteSupportState;
  /** 是否该在页面上主动解释。 */
  readonly shouldExplain: boolean;
  /** 说哪一句；`shouldExplain` 为 false 时是 null。 */
  readonly guidance: SiteGuidance | null;
  readonly vendor: ApplyVendor | null;
  /** 稳定原因码，供诊断。绝不携带页面内容（Data-L1）。 */
  readonly refusal: ApplyGateRefusal | null;
}

/**
 * 被门控拒绝的页面一律闭嘴——不解释，也不算疑似支持。
 *
 * 雇主后台、公共部门、登录页、挑战页上出现任何我方界面都是错的。尤其后两者：
 * 一个浮层足以让站点把整轮判成 bot 流量，而挑战页恰恰是它正在判的时候。
 * 顶层让位给 iframe 同理——真正干活的是那一帧，两边都弹就是弹两个。
 */
export function classifySiteSupport(input: SiteSupportInput): SiteSupportVerdict {
  const base = { vendor: input.vendor, refusal: input.gateRefusal } as const;
  const silent = { ...base, shouldExplain: false, guidance: null } as const;

  if (input.gateRefusal !== null) {
    // 账号墙 ATS（Workday／Avature 系）的第 1 步就是登录／建号。认出了厂商就该
    // 说一句——用户是从我们这儿点进来的，站在一张登录页上等，而我们默不作声。
    //
    // ⚠️ 只有 CREDENTIAL_PAGE 开口。**CHALLENGE_PAGE 绝不**：那是站点正在判定
    // 这是不是 bot 的时刻，任何浮层都可能把整轮判进去。雇主后台／公共部门同理
    // ——那些页面上出现我方界面本身就是错的。
    if (input.gateRefusal === 'CREDENTIAL_PAGE' && input.vendor !== null) {
      return { ...base, state: 'LIKELY_SUPPORTED', shouldExplain: true, guidance: 'SIGN_IN_FIRST' };
    }
    return { ...silent, state: 'UNSUPPORTED' };
  }
  if (input.vendor === null) return { ...silent, state: 'UNSUPPORTED' };
  if (input.formParsed) return { ...silent, state: 'SUPPORTED' };
  // 认出厂商却没解析出表单：用户在等我们，而我们什么都不会发生。
  return { ...base, state: 'LIKELY_SUPPORTED', shouldExplain: true, guidance: 'NO_FORM_FOUND' };
}
