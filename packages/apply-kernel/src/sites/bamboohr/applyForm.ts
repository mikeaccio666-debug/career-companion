/**
 * BambooHR application-form adapter（第九家，2026-08-23）。
 *
 * 纯数据驱动，与前八家同构：选择器与映射都住在
 * `@edaix/apply-rules/bamboohr.json`，本文件只把随包内置的那份编译成 VendorAdapter。
 *
 * 这一家的形态是**字段极好接、域归属极危险**，两句话各记一下：
 *
 * **字段**：锚点是 `form#job-application-form`（逐租户稳定的语义 id，不是构建哈希），
 * `name` 完全语义化（`firstName` / `email` / `linkedinUrl` / `city.value`…），
 * 是我们见过最干净的几家之一。
 *
 * **域归属**：候选人面与 HR 控制台**共用同一个主机**。`<租户>.bamboohr.com/careers/<id>`
 * 是求职者看的岗位页（点「Apply for This Job」原地展开申请表，**路径不变**），
 * 而同一台机器的其余路径是 HR／员工控制台；厂商总登录入口 `app.bamboohr.com`
 * 也在这个后缀下。它一客户一子域、无法穷举精确主机，所以**只能用后缀**——
 * 而后缀正是 2026-07-29 `greenhouse.io` 事故的形状。
 *
 * 放行它的前提是两层：
 *
 *  · `gate/hostVeto.ts` 的 `SHARED_HOST_RULES` 对 `bamboohr.com` **deny by default**，
 *    只放行实测过的候选人路径，**路径未知也算否决**；
 *  · `vendors.ts` 的 `candidateHostSuffixes` 硬条件已由「域下无雇主面」放宽成二选一，
 *    而新增的那一条（被路径闸覆盖）更严 —— 老条件靠人的判断且会随厂商加功能悄悄失效，
 *    新条件是机器强制、默认拒绝的。这条耦合由 `apply-vendor-detect.test.ts` 钉住：
 *    **加后缀而不加路径闸，当场红。**
 *
 * 另有两个必须挡住的东西：表单里挂着 `g-recaptcha-response`（铁律 5，
 * 规则的 `denyNameSubstrings` 把它挡在扫描面之外），以及一个**蜜罐**
 * `nickname_hpcsaf` —— 填进去申请会被静默丢弃。蜜罐刻意**不写进规则**：
 * 它由 `dict/guards.ts` 的文案层（label 就是 `Please leave this field blank`）
 * 与几何层（`position:absolute; left:-9999px` 的 0×0 父节点）接住，
 * 写进规则反而等于承认它是个字段。回归用例见 `apply-bamboohr-adapter.test.ts`。
 */

import rules from '@edaix/apply-rules/bamboohr.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const bamboohrAdapter = compileBundledAdapter(rules);
