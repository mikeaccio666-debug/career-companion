/**
 * Ashby application-form adapter。
 *
 * JSON 化改造（docs/40-工程计划 P1）后，Ashby 的全部选择器、`_systemfield_*`
 * 稳定 name 表与标签正则都住在 `@edaix/apply-rules/ashby.json`（纯数据，
 * 后端可下发热更新），本文件只负责把随包内置的那份编译成 VendorAdapter；
 * 扫描语义在 `../../rules/interpreter.ts`，四家共一份。
 *
 * 实测记录（2026-08-01 只读核实：没有 <form> 元素、只有语义容器 class 稳定、
 * g-recaptcha-response 在容器内部所以 captcha 过滤是承重墙）以 `$comment`
 * 随行保存在 JSON 里。
 */

import rules from '@edaix/apply-rules/ashby.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const ashbyAdapter = compileBundledAdapter(rules);
