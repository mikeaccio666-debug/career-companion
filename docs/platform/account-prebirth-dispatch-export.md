# 入门索引与命名任务的本人导出

依据产品 09 §11、13 §4.5，AccountPrebirthDispatchExport 将剩余五张 owner_projection 表接入原账户捕获事务。

| JSON 区段 | 原表 | 保留的事实 |
| --- | --- | --- |
| prebirthHeads | platform_companion_prebirth_heads | 原采用时间、索引版本、末条记录 ID |
| prebirthInventory | platform_companion_prebirth_inventory | 入门操作、命名入口、命名提交的原来源坐标与登记时间 |
| nameDispatches | platform_companion_name_dispatches | 用户原提交对应的接受记录、执行日志版本、最后操作、日志暂停原因 |
| nameDispatchOperations | platform_companion_name_dispatch_operations | claim / recover / start / hold / detected / application / resource 的原顺序和允许导出的证据 |
| nameDispatchOutbox | platform_companion_name_dispatch_outbox | 通知创建、最近分发时间与队列暂停原因 |

## 事实与校验

接受命名任务不代表已经调用模型。claim 也不等于 start；classification、应用命名、准备安全资源各保留独立操作。resource 只表示原固定响应准备成功，不代表发布、展示或真人阅读。队列行标为 notification_metadata；队列 heldReason 和日志 journalHold 分别保留：完成时队列可能是 terminal、日志没有暂停；队列也可能独立标为 storage。它们不能互相推导。

复用原 dispatch 读取器校验用户、原提交及其不可变坐标、加密请求、接受胶囊、连续操作链、最终状态、实际分类与命名结果。resource 操作还须匹配本事务已验证的 ready 响应及其实际密文字节摘要，不能仅凭日志内部自洽就接受另一个 responseId。

复用原入门 inventory 读取器校验 owner 锚点、加密 head、完整连续索引及其摘要链；再重新遍历原入门操作和命名提交，与每条索引逐一匹配。不存在根的 legacy 用户维持未采用状态，不因导出初始化、补齐或重签历史。已有锚点却缺失根或子记录时拒绝整份捕获。

表计数与命名提交锚点核对防止整段历史被漏掉。操作 recordedAt 和队列时间是数据库保存的元数据，未声称这些字段自身有密封证明；校验实际归属、时间顺序及未来时间。真实权限仍由当前固定会话和原账户再验证事务控制。已撤回的模型同意、已删除的原提交会话不阻止本人用当前有效会话导出历史。

## 输出与执行边界

逐字段选择输出，不带原会话 hash、auth version、lease/execution token、内部请求/日志/密文摘要、密文或其他用户内容。保留 detector revision、租约截止 epoch、操作结果、来源 ID、版本与时间。历史租约时间不授予执行权限。

原读取器增加显式归档无行锁模式，正常执行仍默认使用原锁。dispatch 按 ID、操作按 revision 每页 100 条；inventory 及原来源按稳定顺序每页 100 条，在同一 REPEATABLE READ 快照内取 OFFSET 页。每份完整链仍在内存校验，现有 16 MiB 和事务时限仍适用；不是可持续处理任意规模数据的归档 worker。超限、取消、鉴权变化、损坏或缺失时不返回部分结果，再验证凭据消费随事务回滚。

## 当前交付边界

JSON 当前覆盖 141 表、剩余 23；带私有文件覆盖 144、剩余 20；既有豁免 7，总清单 171。owner_projection 项已全部有捕获路径。剩余为 20 张 organization_review 与 JSON 模式下 3 张 file_projection；组织内容涉及本人资料、他人资料、员工身份及许可，仍要逐项实现或按产品规则给出明确豁免。两种模式维持 complete=false。

无数据库迁移、网页变更、付费模型调用或部署。完整自助导出/下载、持久化归档任务、删除协调以及整个 P0 仍未完成。专项和原流程回归结果见 [验证记录](verification.md)。
