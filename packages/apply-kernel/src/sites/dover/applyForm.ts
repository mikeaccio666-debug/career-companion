/**
 * Dover application-form adapter（第八家，2026-08-23）。
 *
 * 纯数据驱动，与前七家同构：选择器与映射都住在
 * `@edaix/apply-rules/dover.json`，本文件只把随包内置的那份编译成 VendorAdapter。
 *
 * 这一家在**两个维度上都是极端**，各自值得记一笔：
 *
 * **字段维度：最干净的一家。** `name` 完全语义化（`firstName` / `lastName` /
 * `email` / `linkedinUrl` / `phoneNumber`），8 个控件、一个 `<form>`。
 * 代价是 label 全是**零宽空格**——标签兜底在这一家等于不存在，`name` 是唯一信号。
 * 与 Ashby 正好相反（那家没有稳定 name，标签是主信号）。
 *
 * **域归属维度：最危险的一家。** 候选人面与 HR 控制台**在同一个主机上**：
 * `app.dover.com/apply/<slug>/<uuid>` 是申请表，`app.dover.com/login` 是
 * **带密码框的登录页**。此前七家至少还能靠主机名分开
 * （`app.greenhouse.io` vs `job-boards.greenhouse.io`；
 * `app.rippling.com` vs `ats.rippling.com`）——这一家分不开。
 *
 * 所以它逼出了两层新东西，缺一不可：
 *
 *  · `gate/hostVeto.ts` 的 `SHARED_HOST_RULES` —— 对这台机器 deny by default，
 *    白名单只放实测过的整条路径形状，**路径未知也算否决**；
 *  · `vendors.ts` 的 `candidatePathPrefixes` —— 让上架包的注入范围收到
 *    `https://app.dover.com/apply/*`，别把 MAIN world 桥装进登录页的主 realm。
 *
 * 前者管「挂不挂浮层」，后者管「注不注入」。match pattern 表达不了 uuid 形状，
 * hostVeto 管不了注入面，两层各管各的。
 */

import rules from '@edaix/apply-rules/dover.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const doverAdapter = compileBundledAdapter(rules);
