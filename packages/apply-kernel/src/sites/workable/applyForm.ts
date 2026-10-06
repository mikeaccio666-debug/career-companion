/**
 * Workable application-form adapter。
 *
 * JSON 化改造（docs/40-工程计划 P1）后，Workable 的全部选择器、稳定 name 表与
 * `QA_<digits>` 标签兜底闸门都住在 `@edaix/apply-rules/workable.json`
 * （纯数据，后端可下发热更新），本文件只负责把随包内置的那份编译成
 * VendorAdapter；扫描语义在 `../../rules/interpreter.ts`，四家共一份。
 *
 * 实测记录（2026-08-01 只读核实：data-ui 是锚点但不是完整字段信号、
 * address/postcode/country/cover_letter 刻意不映射的理由）以 `$comment`
 * 随行保存在 JSON 里。
 */

import rules from '@edaix/apply-rules/workable.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const workableAdapter = compileBundledAdapter(rules);
