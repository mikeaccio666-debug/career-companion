import type { SiteGuidance, SiteSupportVerdict } from '../lib/siteSupport';

/**
 * Whether this page gets a panel at all, and whether Autofill may be offered on it.
 *
 * Answered twice in a page's life, from the same rules.
 *
 * **Before any scan** (`site: null`) the only fact we are allowed to use is the
 * URL: the content script must not read host DOM or parse a form until a verified
 * runtime authorization exists (`apply.content.ts`, iron rule at the top of
 * `main()`). The URL is what told the manifest to inject us in the first place, so
 * deciding from it alone adds no reach — and a first face that cannot describe the
 * user's form cannot leak it either.
 *
 * **After a scan** the site classifier's verdict refines the same answer: a page
 * the gate refused gets nothing, and a recognised vendor whose form is unreachable
 * gets the explanation the classifier already chose instead of a button.
 *
 * The Mission check is the one that is cheap to drop and expensive to lose. Unlike
 * a single-profile autofiller, an answer here is bound to one Mission's exact
 * résumé version and application bundle, so a form we cannot tie to a Mission has
 * no authority behind it. The panel still appears — the user should see us and be
 * told where to go — but Autofill is not offered.
 */
export type AutofillAffordance =
  | Readonly<{ kind: 'HIDDEN' }>
  /**
   * The launcher, and nothing claimed.
   *
   * A page we do not recognise as an application form is not a page we may say
   * anything about -- but it is also not a reason to be unreachable. The user
   * may be looking at a posting on a vendor we have not modelled, or on a
   * company's own careers page, and the honest answer is "open me and see",
   * not silence. The tab is there; it opens only if a person opens it, and it
   * offers no Autofill because nothing here has been recognised.
   */
  | Readonly<{ kind: 'DORMANT' }>
  | Readonly<{ kind: 'GUIDANCE'; guidance: SiteGuidance }>
  /**
   * `RULES_UNAVAILABLE`：这一次没拿到规则包，所以**任何**页面都判不出来。
   *
   * 必须与 DORMANT 分开。DORMANT 说的是「这一页我们不认识」，而取不到规则时
   * 我们连认识的那些也认不出——2026-09-18 事故里，一份规规矩矩的 Greenhouse
   * 申请表被说成「这一页没有认出申请表」。那句话把一次运维故障伪装成覆盖面
   * 问题：用户以为这家不支持，而查的人（包括我）顺着它去查了竞态和缓存，
   * 真正的原因藏在后面。
   */
  /**
   * `VENDOR_CLOSED`（2026-10-04）：认出了申请表，但这一家此刻没在运行时包里放行（厂商位关着）。不亮「自动填写」、
   * 不自动打开，照实说「这类网站还没开放自动填写」——不是「连不上」，也不是「认不出」。
   */
  | Readonly<{ kind: 'UNAVAILABLE'; reason: 'PORTAL_UNLINKED' | 'NO_MISSION' | 'RULES_UNAVAILABLE' | 'VENDOR_CLOSED' }>
  | Readonly<{ kind: 'READY' }>;

export function autofillPanelAffordance(input: Readonly<{
  /** Null until a verified authorization has allowed a scan; never fabricated. */
  site: SiteSupportVerdict | null;
  /** URL-only: this path is one the vendor adapter declares as an application form. */
  onApplyFormPath?: boolean;
  /** The portal handoff completed and this install is bound to the owner. */
  connected: boolean;
  /** This page resolves to a Mission whose bundle authorises an answer. */
  missionBound: boolean;
  /**
   * Show the launcher on a page we recognise nothing on.
   *
   * Off by default: the dormant tab is a standing presence on every injected
   * page, which is a product decision rather than a detail, and a caller that
   * has not made it should keep the old silence.
   */
  reachableWhenUnrecognised?: boolean;
  /**
   * 这一次有没有拿到规则包。
   *
   * 省略时按「拿到了」算：旧调用方的行为一个字不变，而它们本来也只在拿到规则
   * 之后才问这个问题。
   */
  rulesAvailable?: boolean;
}>): AutofillAffordance {
  const { site } = input;
  // 没拿到规则就什么都判不出来。先说没连接——两件事都成立时，要说他能动手的
  // 那一件；规则那件他做不了什么，只能等。
  if (input.rulesAvailable === false) {
    if (!input.connected) return { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' };
    return { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' };
  }
  if (site === null) {
    // Reachable everywhere, proactive nowhere but on a form we recognise.
    if (input.onApplyFormPath !== true) {
      return input.reachableWhenUnrecognised === true ? { kind: 'DORMANT' } : { kind: 'HIDDEN' };
    }
    return offer(input.connected, input.missionBound);
  }
  if (site.shouldExplain && site.guidance !== null) return { kind: 'GUIDANCE', guidance: site.guidance };
  if (site.state === 'UNSUPPORTED') return { kind: 'HIDDEN' };
  return offer(input.connected, input.missionBound);
}

function offer(connected: boolean, missionBound: boolean): AutofillAffordance {
  if (!connected) return { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' };
  if (!missionBound) return { kind: 'UNAVAILABLE', reason: 'NO_MISSION' };
  return { kind: 'READY' };
}
