/**
 * SmartRecruiters application-form adapter（第五家，2026-08-22）。
 *
 * 与前四家同样是纯数据驱动：全部选择器、autocomplete 映射与标签兜底闸门都住在
 * `@edaix/apply-rules/smartrecruiters.json`，本文件只把随包内置的那份编译成
 * VendorAdapter；扫描语义共用 `../../rules/interpreter.ts`。
 *
 * 这一家值得单独记一句：**它是第一个整张表都在 shadow root 里的厂商**
 * （真实 posting 上 27 个 shadow host，document 层 `querySelectorAll('input')`
 * 返回 0）。之所以不需要给解释器加任何东西，是因为 CAP-AF-047 的穿透扫描
 * 已经落地——它在这里第一次拿到真实收益。
 *
 * 实测记录（钩子分档、生成序号 id 为什么不能进 attrMap）以 `$comment` 随行
 * 保存在 JSON 里。
 */

import rules from '@edaix/apply-rules/smartrecruiters.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const smartrecruitersAdapter = compileBundledAdapter(rules);
