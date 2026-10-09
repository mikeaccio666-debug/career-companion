# 第一封信规则校验验证

2026-10-09，edaix-dev，Node 24.21.0 / pnpm 11.13.1。虚构资料与供应商传输，独立 PostgreSQL schema 已清理，没有付费调用、主库迁移、部署、通知或预览重启。

## 最终结果

- career-core 全量 296/296 通过，无跳过；其中新增第一封信检查 21 项。保留原 729 种人格维度 × 三种长度的预览 fallback 回归。
- 第一封信来源/组装、规划来源、人格来源三组真实数据库测试 33/33 通过，无跳过；新增真实保存人格维度、事实来源到共用检查器的贯通验证。
- career-core 与 platform-api 类型检查通过。
- git diff --check 通过。

检查包含：必含条款分别缺失、真实签名/日期长度、无资料和一条资料的后续说明、引用缺失/重复/外来、与原来源不匹配的措辞、未经引用的新学历/日期断言、空队员名单、未列或漏列队员、中英文与无偏好、结果保证、身份/付费/供应商词、自称真人、已完成执行声明、未来专家帮助、人格冲突、访问器及伪造 semanticReview/approved 字段。

验证边界：正确逐字引用和必含关键词不能证明完整语义。包括错误学历、否定句和未引用事实的用例都不能返回 passed_rules。整个第一封信 surface 当前只返回 blocked 或 requires_review；这证明未误放行，不证明已经完成可发送的第一封信。自然语言语义复核、一次重写和真实质量评测仍待实现。

首轮测试因新增正则转义错误在模块加载时失败，类型检查同时报错。修复后全量核心测试和最终类型检查通过；数据库验证在修复后执行通过。没有降低断言或绕过检查。

私有日志保留在 .local/verification/ci-regression-20261008/，不提交：
first-letter-output-core.log、first-letter-output-types.log、
first-letter-output-core-recheck.log、first-letter-output-types-recheck.log、
first-letter-output-final-types.log、first-letter-output-db.log。
