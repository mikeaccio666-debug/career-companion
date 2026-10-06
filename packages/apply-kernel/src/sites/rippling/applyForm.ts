/**
 * Rippling application-form adapter（第七家，2026-08-23）。
 *
 * 纯数据驱动，与前六家同构：选择器与映射都住在
 * `@edaix/apply-rules/rippling.json`，本文件只把随包内置的那份编译成 VendorAdapter。
 *
 * 这一家逼出了引擎的一个真扩项，值得单独记：
 *
 * **三个常规钩子全部不可用。** 实测（两次页面加载对照，50-证据库 §F.8-c）：
 * `name` 每次加载都重新生成（`z7FRYsYUls` → `Ka37Cca77m`），`id` 是位置序号
 * （`field-8`），`autocomplete` 一律 `off`。唯一稳定且语义化的是 `data-testid`
 * （`input-first_name` / `input-email`）——`attrMap` 的属性白名单为它扩了一项。
 *
 * 顺带澄清能力地图 CAP-AF-009 记的一句话：它说「随机 name 是唯一的坑，而我们的
 * descriptor 模型把十六进制与数字段替换成 '#'，天然免疫」。这不成立。归一化
 * （`fieldIdentity.ts#normalizeNameShape`）产出的是**结构身份**，不是语义键；
 * `z7FRYsYUls` 归一之后照样映不到 `firstName`。免疫的是「同一次加载内认得出是同一个
 * 控件」，而那一段本来就没坏——真正坏的是键映射，归一化对它一点忙都帮不上。
 */

import rules from '@edaix/apply-rules/rippling.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const ripplingAdapter = compileBundledAdapter(rules);
