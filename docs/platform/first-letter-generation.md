# 第一封信原稿：租约、真实费用与加密结果

接续 [持久化准备](first-letter-task-preparation.md)，按产品 02 §5.4、03 §6.5、09 后台生成规则，实现内部 FirstLetterGeneration。它消费已保存的真实 direct_letter 任务，实际调用现有 first_letter_generation runtime；没有学生 HTTP 路由、自动队列或发布接口。

## 执行过程

1. 在同一事务中通过 FirstLetterTasks.readInTransaction 重读真实来源、配置与当前协议/邮箱/安全状态，取得用户锁。解析明确配置的服务端模型路线，保存绑定来源、准备摘要、路线和账户鉴权版本的加密开始记录。
2. 取得 background 租约，和 chat 的两个并发名额分开。执行租约为 60 秒，每 15 秒续期；原稿消费整体最多 40 秒，单次 runtime 沿用 15 秒、1536 输出 token、零工具、store=false 和严格结构化格式。
3. 真正的 started 回调才申请 CostGuard 预算并写入 callId、reservationId 和独立用途。预留金额使用 UTF-8 字节加 schema/framing 余量做保守上界，不冒充精确 tokenizer。调用行与 dispatch intent 在授权发出事务之前持久化。
4. requestAdmission 再检查来源、会话版本、执行租约、明确路线、预算及价格。最后一条授权 SQL 重新核对会话、租约、预算政策和全部四类价格的有效时间，随后在保留锁的事务里启动请求。网络响应不在该事务内等待；事务提交失败仍保留此前的费用风险标记。
5. 实际 finished 回调持久化费用和加密回执。已发出的请求，即使用户取消、撤回模型协议、租约失效或发送事务提交失败，也保留真实用量或保守估计；只有本执行器确认从未调用 launch 时才能释放预留。
6. 正常终态、结构化格式和记账全部完成后，再核对当前来源与执行权，将原始 JSON 正文加密保存，状态为 draft_saved。回执、正文、准备摘要和归属坐标相互绑定，不能挪用另一个账户或任务的密文。

draft_saved 的正文明确标记 unreviewed_model_output。它不是“第一封信已送达”，不属于主线消息，也不完成 C7。结构化形状不等于事实和表达合格；共用检查和语义复核由独立的 [持久化复核入口](first-letter-durable-review.md) 完成。

## 重复请求、失败与恢复

- 同一任务的 write_original 阶段唯一。并发第二次执行被拒绝；已保存的原稿或 invalid_format 结果可重新读取，不再次花费。主应用停用模型也不阻止本人读取已经保存的结果。
- 预算拦截等失败若**没有调用记录，也没有费用预留/发送意图**，允许使用同一阶段身份重新取得租约。来源、路线和鉴权版本仍须吻合；不会删除旧调用回执。
- 已经建立调用记录的失败、取消、拒绝或不确定结果，不在本步自动重试。原稿格式错误记为 invalid_format，供后续明确的一次重写状态机消费，不能重新调原稿来绕过限制。
- recover 只重新核验历史证据、处理过期租约和协调 CostGuard。可能已发出但缺少正常回执的请求标记 uncertain，超期费用保守记账；重复恢复不重复记账、不重发请求。
- 执行租约凭据仅保留在服务端表中，完成/失败时清除。旧执行器不能修改持有新租约的任务。
- 当前没有恢复 worker。[真实进程退出测试](first-letter-process-recovery-verification.md)已覆盖原稿发送、费用回执与正文提交，以及复核发送后的恢复；复核/重写阶段的持久化续跑见 [后续实现](first-letter-durable-review.md)。

## 数据和账户生命周期

迁移 085 新增 platform_first_letter_stages，原先仅开放 write_original 阶段；迁移 086 扩展三个复核/重写阶段和前序证据绑定。task + user 组合外键沿真实用户归属级联删除；费用预留外键保留完整性检查，但按迁移 078 的隐私删除顺序延迟到 COMMIT，允许先汇总费用、再由用户级联删除执行记录。单独删除仍被引用的预留仍然失败。

start_ciphertext 认证准备身份和路线；receipt_ciphertext 认证实际回调、用量和结算；output_ciphertext 绑定准备摘要与回执摘要。历史读取同时验证真实费用预留、价格行、ledger 的归属、用途、用量和重新计算的金额。缺失/损坏/移位证据不能作为成功原稿。

账户 JSON 和含文件归档增加 firstLetterStages，包含本人阶段状态、调用回执和明确标记为未审稿的私有正文，不包含 auth_version、lease_token、runtime_lease_id 或密文。历史导出不要求当前模型协议；仍要求真实会话和账户重新认证。删除账户后仅保留现有匿名费用汇总，不保留信稿、调用 ID 或来源坐标。

已审阅实际 catalog，将新表归为 credential_projection：173 表、7 项排除、166 项需投影；JSON 已覆盖 143、剩余 23，含文件归档覆盖 146、剩余 20。账户导出仍是 complete=false。

## 后续工作与上线边界

语义复核、至多一次重写及第二次复核已接入 [持久化阶段与费用回执](first-letter-durable-review.md)，不会通过重启 runFirstLetterReviewCycle 重置计数。已有执行记录的准备配置过期恢复、无人值守 worker/恢复调度、唯一 post 发布、C7 完成和 UI 仍未接通。

真实模型质量评测和 PR3 顺序门槛保留。本轮只以虚构资料、实际 runtime 的注入传输和隔离数据库验证工程行为，没有修改主应用商业调用开关、真实价格/预算或密钥，没有主库迁移、付费调用、部署、预览重启或发信。

尚未执行的准备现可通过 [FirstLetterTasks.refresh](first-letter-task-preparation.md) 显式更新，保留原任务身份；已有执行或费用记录不会被刷新。
