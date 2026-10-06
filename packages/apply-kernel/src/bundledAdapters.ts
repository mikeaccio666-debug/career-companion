/**
 * 随包内置的厂商适配器。
 *
 * 2026-09-15 从 `registry.ts` 切出来。原因：这 11 个模块各自 import 一份
 * `@edaix/apply-rules/<厂商>.json`，而 registry 里那几个工具函数（识别、路径
 * 判断、读表单）是内容脚本要用的——于是**只要用到其中任何一个函数，11 家的
 * 规则数据就全被打进内容脚本**，实测 43,409 字节。一个页面只可能在一家厂商上。
 *
 * 生产填表用的从来不是这一份：`runtimeRegistry.ts` 用后端下发的 ruleset 现编
 * 适配器。这一份只服务于授权前的识别，以及构建期从 `ADAPTERS` 推导注入范围
 * （`wxt.config.ts` 的 `applyHostMatchPatterns`）与实验室/测试。
 *
 * 所以本模块只应被**构建期工具、实验室与测试**导入，不应进入内容脚本的图。
 * 运行时改由 `registry.ts` 的 `installApplyAdapters()` 从后端规则装配。
 */

import { greenhouseAdapter } from './sites/greenhouse/applyForm';
import { ashbyAdapter } from './sites/ashby/applyForm';
import { leverAdapter } from './sites/lever/applyForm';
import { workableAdapter } from './sites/workable/applyForm';
import { smartrecruitersAdapter } from './sites/smartrecruiters/applyForm';
import { icimsAdapter } from './sites/icims/applyForm';
import { ripplingAdapter } from './sites/rippling/applyForm';
import { doverAdapter } from './sites/dover/applyForm';
import { bamboohrAdapter } from './sites/bamboohr/applyForm';
import { jobviteAdapter } from './sites/jobvite/applyForm';
import { installApplyAdapters } from './registry';
import {
  APPLY_VENDORS,
  type ApplyVendor,
  type VendorAdapter,
} from './contracts';

export const ADAPTERS = Object.freeze({
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  // 识别与 My Information 的四字段解释资产已落地；production runtime mapping
  // 尚未发布，且多页 wizard 仍未收口。null 是有意的：`hasApplyAdapter` 与
  // `applyHostMatchPatterns` 都按它判断，所以上架包注入范围不受影响，
  // bundled asset 不会被误当成 vendor authority。远程 registry 验证 exact mapping
  // 后才可编译同一份 JSON；缺 mapping、pathname 或 policy 时仍是零写入。
  workday: null,
  // 同上。Avature 的锚点与字段分类法已实测（两个真实租户），但适配器要等
  // 「标签是唯一跨租户信号」这条决定了的匹配策略落地——数字字段名逐租户不同。
  avature: null,
  // 第五家（2026-08-22 真实 posting 实测）。整张表在 shadow root 里，
  // 靠 CAP-AF-047 的穿透扫描才看得见；解释器未加任何新 keyStep。
  smartrecruiters: smartrecruitersAdapter,
  // 第六家（2026-08-22 真实 posting、负责人本人登录后实测）。整站套同源 iframe，
  // 帧仲裁已有；建号页与档案页共用一个 form，密码与 captcha 靠规则的
  // denyNameSubstrings 挡在扫描面之外。
  icims: icimsAdapter,
  // 以下三项是可复验的规则资产 registry，不是 production vendor authority：
  // VENDOR_CATALOG 不为它们登记本地主机，生产扫描只接受后端 runtime bundle
  // 的 exact (atsProvider, pathRuleId) mapping，合同未收口时始终 fail closed。
  // 第七家（2026-08-23 真实在招岗位实测）。三个常规属性钩子全部不可用——
  // name 每次页面加载重新生成、id 是位置序号、autocomplete 一律 off；
  // 这一家是 `attrMap` 放行 `data-testid` 的原因。
  rippling: ripplingAdapter,
  // 第八家（2026-08-23 真实在招岗位实测）。字段本身是最干净的一家
  //（name 全语义化），但 label 全是零宽空格——标签兜底在这一家等于不存在。
  dover: doverAdapter,
  // 第九家（2026-08-23 真实在招岗位实测）。蜜罐通过横向几何判据 fail closed；
  // 逐租户 URL 的归属与 pathname 仍必须由后端 canonical target/mapping 证明。
  bamboohr: bamboohrAdapter,
  // 第十家（2026-08-23）。申请页第一步是数据同意闸，那一下由用户本人点
  // （铁律 5），我们在他过闸之后接管 —— 产品面与 iCIMS 的登录墙同档。
  // 过闸之后是唯一一家标准 HTML autocomplete 词表直接可用的。生产归属仍
  // 只认后端 runtime bundle exact mapping，本地 catalog 不登记 jobs.jobvite.com。
  jobvite: jobviteAdapter,
  // 不绑厂商的那条路（argoland #584 的 GENERIC）。**故意没有随包适配器**：
  // 它的判据是「这一张表里有几个字段我们认得」，而这个判断只有在后端已验证的
  // runtime bundle 里有 GENERIC 的 exact mapping 时才该发生。随包一份等于给它
  // 一条不经准入清单的本地入口——RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 明令不许。
  // 顺带：null 让 `applyHostMatchPatterns` 一条主机都不为它派生，这本来也是对的
  // ——通用路按内容认，不按主机认。
  generic: null,
} satisfies Record<ApplyVendor, VendorAdapter | null>);

/** Convenience view for diagnostics and tests; build matches consume ADAPTERS directly. */
export function activeApplyVendors(): ApplyVendor[] {
  return APPLY_VENDORS.filter((vendor) => ADAPTERS[vendor] !== null);
}

/**
 * 把随包内置那份装进识别路径。**只给实验室与测试用。**
 *
 * 生产不走这里：`registry.ts` 的装入表由后端下发的 release 装配
 *（`installApplyAdaptersFromRules`），没有内置回退。这个函数存在只是因为
 * 单测与 ATS lab 不连后端，需要一份可复验的固定资产。
 */
export function installBundledApplyAdapters(): void {
  installApplyAdapters(ADAPTERS);
}
