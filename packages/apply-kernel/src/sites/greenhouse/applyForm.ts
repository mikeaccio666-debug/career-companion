/**
 * Greenhouse application-form adapter。
 *
 * JSON 化改造（docs/40-工程计划 P1）后，Greenhouse 的全部选择器、属性名与
 * 匹配正则都住在 `@edaix/apply-rules/greenhouse.json`（纯数据，后端可下发热更新），
 * 本文件只负责把随包内置的那份编译成 VendorAdapter；扫描语义在
 * `../../rules/interpreter.ts`，四家共一份。
 *
 * 字段级判断依据与实测记录（form#application-form 于 2026-07-30 只读核实、
 * 页脚订阅框 #email 的反例等）以 `$comment` 随行保存在 JSON 里。
 */

import rules from '@edaix/apply-rules/greenhouse.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const greenhouseAdapter = compileBundledAdapter(rules);
