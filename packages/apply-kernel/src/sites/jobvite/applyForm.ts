/**
 * Jobvite application-form adapter（第十家，2026-08-23）。
 *
 * 纯数据驱动，与前九家同构：选择器与映射都住在
 * `@edaix/apply-rules/jobvite.json`，本文件只把随包内置的那份编译成 VendorAdapter。
 *
 * 这一家的形态是**一道人闸 + 一张很干净的表**：
 *
 * **人闸**：申请页第一步是数据同意闸（AngularJS 的 `form[name="consentForm"]`），
 * 选完居住地才动态加载隐私政策正文与同意动作。铁律 5 ——
 * **那一下永远由用户本人点**，我们在他过闸之后接管。
 * 产品面与 iCIMS 的登录墙同档：用户自己过人闸，我们在之后接手。
 * （本规则的结构来自负责人本人过闸后的实测。）
 *
 * **表**：过闸之后是九家里唯一一家**标准 HTML `autocomplete` 词表直接可用**的：
 * `given-name` / `family-name` / `email` / `tel` / `country-name` /
 * `address-level1` / `address-level2`。解释器一个扩项都不需要。
 * `name` 与 `id` 反而是逐字段 token（`input-yH3T0fwn`），跨租户不可用。
 *
 * 两件与直觉相反、值得单独记的事：
 *
 *  1. **锚点是 `div.jv-apply-form` 而不是 `<form>`**。两个文件输入
 *     （简历 `file-input-0`、求职信 `file-input-1`）在 `<form>` **之外**，
 *     只有这个容器同时罩得住（实测 `form` 内 10 个控件、容器内 14 个）。
 *  2. ⚠️ **那两个文件输入的 label 都只是 `File`**。唯一的区分信号是旁边那句
 *     「Type or paste your Resume here」/「…Cover Letter here」。
 *     我们的正向白名单认不出 `File`，所以两个都如实报「需手动填」——
 *     那是安全的一侧（挂错栏比不挂糟），但**简历上传在这一家暂时走不通**，
 *     需要另立结构信号（旁邻文本），见 50-证据库 §F.8-g。
 */

import rules from '@edaix/apply-rules/jobvite.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const jobviteAdapter = compileBundledAdapter(rules);
