# 第一封信原稿执行验证

2026-10-09，edaix-dev，Node 24.21.0 / pnpm 11.13.1。真实本地 PostgreSQL 隔离 schema、实际 O2/诞生/初见命令、实际 provider runtime 和注入的虚构响应。不使用外部模型，不修改主数据库或预览。

## 最终结果

- platform-api 类型检查通过。
- 原稿执行 11 项、准备记录 7 项、来源/编排/共用检查/复核 18 项、账户覆盖清单 11 项，共 47/47 通过，无跳过。
- 账户及相关功能回归：419/419 通过，无跳过。
- git diff --check 通过。

原稿执行测试包含：

- 实际 started → 预留/发送意图 → admission → finished/结算 → 加密结果。已保存结果可由新服务实例和停用模型的 runtime 重新读取，不再请求。
- 真实并发请求只有一个执行者；两个 chat 租约不消耗 background 名额；欢迎状态不推进。
- 缺少 usage 的保守计费、invalid_format 留档、供应商拒绝、没有路线/预算时不发请求。
- 仅失败且没有调用/费用记录时允许重新取得租约；存在调用记录时不清零重发。
- 发送后撤回协议、取消或失去租约，保留费用回执但不保存可发布的原稿。
- launch 之后模拟授权事务提交失败，风险标记仍存在、费用不释放，也不授权第二次请求。
- 实际发送后丢弃 finished 回调，同时注入清理失败；过期记录由新服务实例 recover 为 uncertain，费用协调为保守估计；重复恢复不重复结算/请求。这是故障注入，不是真实进程 kill/restart。
- 最后一条 launch SQL 前分别让预算政策、会话和 runtime 租约过期，均阻止请求；已确认未 launch 时释放预留。
- 跨账户读取拒绝；移动开始记录、回执或正文密文、篡改 ledger 金额，均拒绝。
- JSON/含文件归档读取同一实际原稿和回执，输出明确是 unreviewed_model_output，不带执行凭据。
- 实际删除用户清理阶段；匿名费用增量等于被删用户的真实 ledger 汇总。单独删除仍被阶段引用的预留会失败。
- buildApp 装配内部服务，没有第一封信生成 HTTP 接口。

## 测试发现与修正

首轮 fixture 没有显式 first_letter_generation 路由，真实服务正确报 MODEL_ROUTE_UNAVAILABLE。已补齐虚构 fixture 的明确路线，没有给业务添加默认路由；并修复并发测试在前置失败时仍等待 transport 的清理问题。失败套件的遗留测试进程在确认 schema 已清理后终止，未将超时当成功。

第二轮发现账户删除的 BEFORE DELETE 费用汇总先删除预留，早于阶段归属级联，因此即时外键会阻断删除。迁移 085 已按现有 078 规则使用 DEFERRABLE INITIALLY DEFERRED，保留外键检查而不弱化为任意费用删除级联；重读实际 catalog 后更新审阅基线，删除及非法单独删除均已验证。

## 限制

工程测试中的内容与用量均为虚构数据，不能替代真实模型质量评测。当前只有原稿阶段；完整复核/重写持久化、自动 worker、完整恢复调度、post 唯一发布、C7 和 UI 未完成。没有商业调用、主库迁移、部署、预览重启或发信。

私有日志在忽略目录 .local/verification/ci-regression-20261008/，本轮使用 first-letter-generation- 前缀，包含 schema/schema2、types/types2/final-types/complete-types、db/db2/db3/complete-db、single 和 account-regression。日志不进入公开仓库。
