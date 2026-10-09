# 主理人命名原始记录的本人导出

依据产品 09 §11 与 13 §4.5，AccountCoreExport 增加四段内部资料：

| JSON 段 | 原始表 | 内容 |
| --- | --- | --- |
| companionNameEntries | platform_companion_name_entries | 入门预览原件、命名输入版本和最新提交引用 |
| companionNameSubmissions | platform_companion_name_submissions | 用户原始请求、检测状态与结果、失败、名字采用结果及原身份快照 |
| companionNameIdentityReceipts | platform_companion_name_identity_receipts | 实际采用名字对应的操作与身份版本 |
| companionNameIdentityProvenance | platform_companion_name_identity_provenance | 每次采用名字的原始来源与结果关联 |

输入原文保留空白、控制字符、无效名字和被后续输入替换的提交；这是一份本人私有存档，不会因此进入队伍共享记忆。pending、running、detected 与 applied、name_rejected、superseded、not_eligible 分开记录。关键词检测没有模型用量时输出 null，不补造调用或零费用。

## 验证与读取边界

读取只使用同一 REPEATABLE READ 事务中已经验证的生成和身份资料。每条请求及 entry 中保存的预览，必须匹配原生成的完整 preview、dimensions 和来源坐标。原 claim 与 result 均核对其密文、代次和实际来源；full 检测还核对真实完成的模型用量记录。失败任务清除了租约时，以原密封 claim 验证历史，不签发或恢复租约。

被采用的名字必须对应原身份操作、版本和按原资源验证的身份快照，并同时存在精确匹配的 receipt 与 provenance。后续改名不覆盖旧的名字、候选字和资源版本；currentForIdentity 明确标识是否仍对应当前身份。现行政策、协议同意、邮箱验证或用户显示名变化，不重新解释历史。

identityArchiveValidator 复用原身份校验，资源缓存仍限 8 份。分类来源读取新增可选无锁模式，仅存档使用；正常执行默认锁语义不变。四张表均按 owner 分页，每页 100；provenance 使用 (draft_id, identity_revision) 复合游标，防止同一身份的历史在分页边界丢失。entry 的连续版本、最新引用、采用结果与两种凭据逐项对账。缺失、重复、损坏、跨用户密文或无法确认的关联使整个导出失败。

导出不调用供应商、不重新检测、不采用名字、不恢复任务、不创建共享记忆；不返回 session hash、执行或租约令牌、密文、内部审核人资料。重新验证密码后的固定会话校验、16 MiB 大小边界和事务提交后才返回资料的规则保持不变。中断、身份失效及超限均回滚重新验证凭据的消耗。

## 范围

没有数据库迁移或网页改动。JSON 当前覆盖 141 表、剩余 23；带私有文件覆盖 144、剩余 20；既有豁免 7 项，总清单 171。命名流程的原始提示、发布、展示与处理记录由[命名交付导出](account-name-delivery-export.md)补齐；共享提问由[共享安全历史导出](account-shared-safety-export.md)覆盖；其他剩余表仍待实现。两种模式保持 complete=false；完整自助下载、删除协调与 P0 继续开发。

## 验证口径

集成测试使用隔离 PostgreSQL schema、虚构资料与受限 loopback provider，覆盖未提交、未检测、失败、运行中、关键词结果、模型结果、被拒绝、被替换和实际采用的记录；检查密文损坏、跨用户替换、关联缺失、旧 entry 回滚、原预览或身份快照变更、用量缺失、取消、认证失效和超限时整份回滚。

跨页测试准备同一身份 105 个实际采用版本。旧写入流程会反复扫描此前完整历史，因此该测试只在数据准备阶段放宽测试时钟，并使用协议允许的 60 秒租约；导出前恢复全部设置，实际导出仍受原 5 秒事务边界约束。该用例验证完整分页及原件关联，不证明旧检测/写入流程的高频性能或 1 秒 SLA。旧流程的重复历史读取开销保留为后续性能工作，不通过放宽正式时限来隐藏。

压力检查单独运行：`pnpm --filter @companion/platform-api exec tsx --test test/account-name-source-export-pagination.stress.ts`（须在配置隔离测试数据库的远端验证环境中执行）。普通 `test/*.test.ts` 包含其余 7 项，不自动运行这个耗时场景。
