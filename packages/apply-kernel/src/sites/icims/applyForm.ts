/**
 * iCIMS application-form adapter（第六家，2026-08-22）。
 *
 * 纯数据驱动，与前五家同构：选择器、命名空间映射与拒绝表都住在
 * `@edaix/apply-rules/icims.json`，本文件只把随包内置的那份编译成 VendorAdapter。
 *
 * 这一家有两件与众不同、值得单独记的事：
 *
 *  1. **整站套在同源 iframe 里**——顶层页面零 input，全部内容在 `?in_iframe=1`
 *     的同源子帧内。内容脚本注入到子帧即可，帧仲裁（gate/frameArbitration.ts）
 *     已有；不需要任何新机制。
 *  2. **申请入口这一步同时是建号页**——同一个 `form#profileForm` 里既有
 *     `PersonProfileFields.FirstName` 这类档案字段，也有
 *     `PersonProfileFields.Password` 与 hCaptcha。规则里用 `denyNameSubstrings`
 *     把 password/captcha 整类**挡在扫描面之外**，而不是靠「不映射」——
 *     不映射的控件仍会进候选集、仍会被标签兜底看到。铁律 5 这一档要的是
 *     根本看不见，不是看得见但不填。
 */

import rules from '@edaix/apply-rules/icims.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const icimsAdapter = compileBundledAdapter(rules);
