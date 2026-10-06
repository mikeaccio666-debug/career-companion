/**
 * Lever application-form adapter。
 *
 * JSON 化改造（docs/40-工程计划 P1）后，Lever 的全部选择器、稳定 name 表与
 * 匹配正则都住在 `@edaix/apply-rules/lever.json`（纯数据，后端可下发热更新），
 * 本文件只负责把随包内置的那份编译成 VendorAdapter；扫描语义在
 * `../../rules/interpreter.ts`，四家共一份。
 *
 * 实测记录（2026-08-01 真实 posting 只读核实、`urls[...]` 命名空间高于标签、
 * location 部件托管为何报 WIDGET 等）以 `$comment` 随行保存在 JSON 里。
 */

import rules from '@edaix/apply-rules/lever.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const leverAdapter = compileBundledAdapter(rules);
