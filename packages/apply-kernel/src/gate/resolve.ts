/**
 * 注入门控的合成入口（CAP-AF-006）。
 *
 * 四件判断——`hostVeto` / `frameArbitration` / `vendorFingerprint` / `pageVeto`
 * ——各自写完、各自有测试，但**从来没有人把它们串起来调用过**。生产路径上的
 * 第一道判断至今是 `detectApplyVendor(location.hostname)`，一张 8 个精确主机名
 * 的表；公司把 Greenhouse / Ashby / Workable 嵌进自家 careers 域名的那类页面
 * ——极常见——全部认不出，浮层根本不出现。
 *
 * ## 顺序本身是安全属性
 *
 * 1. **hostVeto**：纯函数、不碰 DOM，所以放在最便宜的位置。远程否决在它内部
 *    排第一——那是运维在事故中用的开关，必须优先于任何本地判断。
 * 2. **帧仲裁**：顶层页嵌着候选人侧 iframe 时，真正持有表单的是那一帧。
 *    必须排在厂商判定**之前**——否则顶层的 embed 产物会让它自己也命中，
 *    结果两帧都挂，或者顶层挂了却什么都扫不到。
 * 3. **厂商判定**：精确主机名优先，认不出才用 DOM 指纹。这个次序保证扩围
 *    **不改变今天任何一条已覆盖路径的行为**。
 * 4. **pageVeto**：登录页、挑战页、匿名举报页。排在厂商判定之后是因为它要读
 *    正文、最贵；但它的否决**优先于厂商命中**——在登录页上挂浮层比认不出坏得多。
 *
 * ## 指纹只给提示，不完成归属
 *
 * `fingerprintVendorHint` 的返回值叫 hint 不叫 vendor：URL 参数是投放方与攻击者
 * 可控的，单靠它归属等于把判定权交出去。真正的确认在调用方——`readApplyForm`
 * 必须真的解析出表单才算数（`kernelScanner` 的 `descriptor === null → return null`
 * 就是那道确认）。本函数只决定"要不要往下走"。
 *
 * FINDING-AF-002 逐字警告：接线之后的失败形态是「认错厂商、套错规则」，
 * **比认不出更坏**——用错的 attrMap 会把值写进别人的字段。所以指纹那一层
 * 只认厂商自己的产物，不认"看起来像申请表"。
 */

import type { ApplyPolicy } from '../policy';
import type { ApplyVendor } from '../contracts';
import { detectApplyVendor } from '../vendors';
import { evaluateHostVeto, type HostVetoReason } from './hostVeto';
import { evaluatePageVeto, type PageVetoOptions, type PageVetoReason } from './pageVeto';
import { fingerprintVendorHint } from './vendorFingerprint';

/** 内容脚本在报到时也要算一次「先试哪家」（P2-11 白标 B），与门控用同一个函数。 */
export { fingerprintVendorHint } from './vendorFingerprint';
/** 内容脚本报「这一页有一张通用申请表」之前先过同一道页面否决（密码页、挑战页不算）。 */
export { evaluatePageVeto } from './pageVeto';
/** 白标 C（P2-12）：没有表单的落地页上「申请表在哪」，与指纹同一层、同样只读厂商自己的产物。 */
export {
  GREENHOUSE_BOARD_TOKEN_PATTERN,
  GREENHOUSE_JOB_ID_PATTERN,
  applicationFormTarget,
  type ApplicationFormTarget,
} from './applicationFormTarget';
import { shouldYieldToEmbeddedFrame } from './frameArbitration';
/**
 * 顶层浮层露不露面（2026-10-04）：页面上嵌着认得的 ATS iframe 时，申请表在那一帧里、那一帧自己挂浮层；顶层这一个按下去
 * 只会让位（`YIELDED_TO_FRAME`）。内容脚本用门控同一个函数判，让开就不挂。
 */
export { shouldYieldToEmbeddedFrame };

/** 厂商是怎么认出来的。诊断要能分开"主机表"与"扩围"两条路径的责任。 */
export type ApplyGateSource = 'EXACT_HOST' | 'FINGERPRINT' | 'REMOTE_MAPPING';

/** 不挂载的原因。稳定闭集——它会进诊断，不能是随手写的字符串。 */
export type ApplyGateRefusal =
  | HostVetoReason
  | PageVetoReason
  | 'YIELDED_TO_FRAME'
  | 'NO_VENDOR';

export type ApplyGateVerdict =
  | { readonly attach: true; readonly vendor: ApplyVendor; readonly source: ApplyGateSource }
  | {
      readonly attach: false;
      readonly reason: ApplyGateRefusal;
      /** Vendor known at the time of refusal; pre-attribution refusals stay null. */
      readonly vendor: ApplyVendor | null;
    };

/**
 * 门控**只读两样东西**：主机名，和 URL 查询参数。
 *
 * 刻意不收一个完整 `URL`：调用方手上的主机名与 origin 可能来自不同来源
 * （`kernelScanner` 的 `loc` 就是分开的三个字段），收 URL 会让"从 origin 推出来的
 * 主机名"静默压过调用方明确给的那个——本仓已经因此红过一次
 * （kernel-scanner.test.ts 的「厂商认不出」用例刻意让两者不一致）。
 */
export interface ApplyGateInput {
  readonly doc: Document;
  readonly hostname: string;
  /**
   * 形如 `/apply/acme/<uuid>`。**共域厂商**（候选人面与 HR 后台同主机，
   * 见 `hostVeto.ts` 的 `SHARED_HOST_RULES`）上，路径是唯一的分界线；
   * 缺它等于否决。其余主机上不参与判断。
   *
   * 与 `hostname` 分开收而不是收一个完整 URL，理由同上：调用方手上的几段
   * 可能来自不同来源，收 URL 会让推导值静默压过明确给的那个。
   */
  readonly pathname?: string;
  /** 形如 `?gh_jid=123`。Greenhouse／Lever 的 URL 参数是指纹的一条**弱**信号。 */
  readonly search?: string;
  readonly policy: ApplyPolicy;
  /** `window.top === window.self`。让位规则只对顶层生效。 */
  readonly isTopFrame: boolean;
  /**
   * 页面否决读可见性的手段（2026-09-28，见 `PageVetoOptions`）：只用来判「只靠 autocomplete 自称密码的栏
   * 是不是藏起来的蜜罐」。不给就只看属性层，那样的栏照旧否决整页——保守一侧。
   */
  readonly readVisibility?: PageVetoOptions['readVisibility'];
}

export interface AuthorizedApplyGateInput extends ApplyGateInput {
  /** Exact backend mapping result; never inferred from host or DOM. */
  readonly vendor: ApplyVendor;
}

/**
 * 指纹层只从 URL 上读 `searchParams`。主机名照 `input.hostname` 拼进去，
 * 保证它与 hostVeto／`detectApplyVendor` 读的是同一个值。畸形主机名不该让整页哑掉，
 * 拼不出合法 URL 时退回一个不会命中任何参数的空 URL。
 */
function pageVetoOptions(input: ApplyGateInput): PageVetoOptions {
  return input.readVisibility === undefined ? {} : { readVisibility: input.readVisibility };
}

function fingerprintUrl(input: ApplyGateInput): URL {
  const search = input.search ?? '';
  try {
    return new URL(`https://${input.hostname}/${search.startsWith('?') ? search : ''}`);
  } catch {
    return new URL('https://x.invalid/');
  }
}

export function resolveApplyGate(input: ApplyGateInput): ApplyGateVerdict {
  const hostVerdict = evaluateHostVeto({
    hostname: input.hostname,
    pathname: input.pathname,
    policy: input.policy,
  });
  if (hostVerdict.vetoed) {
    return { attach: false, reason: hostVerdict.reason, vendor: null };
  }

  if (shouldYieldToEmbeddedFrame({ doc: input.doc, isTopFrame: input.isTopFrame })) {
    return { attach: false, reason: 'YIELDED_TO_FRAME', vendor: null };
  }

  // 精确主机名先行：今天已覆盖的每一条路径，行为逐字不变。
  const exact = detectApplyVendor(input.hostname);
  const vendor =
    exact ?? fingerprintVendorHint({ doc: input.doc, url: fingerprintUrl(input) });
  if (vendor === null) return { attach: false, reason: 'NO_VENDOR', vendor: null };

  const pageVerdict = evaluatePageVeto(input.doc, pageVetoOptions(input));
  if (pageVerdict.vetoed) {
    return { attach: false, reason: pageVerdict.reason, vendor };
  }

  return { attach: true, vendor, source: exact === null ? 'FINGERPRINT' : 'EXACT_HOST' };
}

/**
 * 账号墙那一路（2026-09-28）：与下面的授权道同一套否决——远程否决名单、帧让位、挑战页、匿名举报页——只有一处不同：
 * 页面上有密码框（`CREDENTIAL_PAGE`）在这里不是拒绝理由，因为账号墙本来就是那一页。它**不**放行任何填写：
 * 调用方接着只认规则声明的账号墙（`accountSteps`），认不出就照旧什么都不做；申请表那一路照旧用下面的函数、照旧拒密码页。
 */
export function resolveAuthorizedAccountGate(
  input: AuthorizedApplyGateInput,
): ApplyGateVerdict {
  const hostVerdict = evaluateHostVeto({
    hostname: input.hostname,
    pathname: input.pathname,
    policy: input.policy,
  });
  if (hostVerdict.vetoed) {
    return { attach: false, reason: hostVerdict.reason, vendor: null };
  }
  if (shouldYieldToEmbeddedFrame({ doc: input.doc, isTopFrame: input.isTopFrame })) {
    return { attach: false, reason: 'YIELDED_TO_FRAME', vendor: null };
  }
  const pageVerdict = evaluatePageVeto(input.doc);
  if (pageVerdict.vetoed && pageVerdict.reason !== 'CREDENTIAL_PAGE') {
    return { attach: false, reason: pageVerdict.reason, vendor: input.vendor };
  }
  return { attach: true, vendor: input.vendor, source: 'REMOTE_MAPPING' };
}

/**
 * Runtime-authorized lane.  It retains every safety veto but deliberately
 * omits `detectApplyVendor` and `fingerprintVendorHint`: vendor attribution is
 * exclusively the backend bundle's exact `(atsProvider, pathRuleId)` mapping.
 */
export function resolveAuthorizedApplyGate(
  input: AuthorizedApplyGateInput,
): ApplyGateVerdict {
  const hostVerdict = evaluateHostVeto({
    hostname: input.hostname,
    pathname: input.pathname,
    policy: input.policy,
  });
  if (hostVerdict.vetoed) {
    return { attach: false, reason: hostVerdict.reason, vendor: null };
  }
  if (shouldYieldToEmbeddedFrame({ doc: input.doc, isTopFrame: input.isTopFrame })) {
    return { attach: false, reason: 'YIELDED_TO_FRAME', vendor: null };
  }
  const pageVerdict = evaluatePageVeto(input.doc, pageVetoOptions(input));
  if (pageVerdict.vetoed) {
    return { attach: false, reason: pageVerdict.reason, vendor: input.vendor };
  }
  return { attach: true, vendor: input.vendor, source: 'REMOTE_MAPPING' };
}
