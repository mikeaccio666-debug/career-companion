# 第一封信的持久化复核与一次重写

按产品 02 §3.4、§5.4 和 03 §6.5，在原稿执行器上补齐 review_original、rewrite、review_rewrite。内部 FirstLetterGeneration.review 消费已保存的原稿，不自动生成原稿，也不发布消息。

## 阶段与恢复

共用纯函数 planFirstLetterReview 依据当前准备资料、原稿和有序历史决定下一步：原稿符合硬规则时先复核；格式或硬规则不符合时直接使用一次重写；复核 contradicted/uncertain 时重写，随后再次共用检查和复核。第二次仍不合格返回产品固定失败提示。缺项、非法 JSON 或格式失败的复核响应停止，不当作可继续重写的有效判断。

最多一个原稿、两个复核、一个重写。数据库唯一 task + stage 槽位限制次数。每一步重读当前会话、协议、来源、配置和实际数据库历史，不能靠重启服务清零计数。完成阶段直接读取；只有失败且没有实际调用及费用意图的阶段可以重新取得租约。

每阶段复用原执行器的 background 租约、最终发送检查、CostGuard、实际 started/finished 回调和费用结算。原稿费用继续绑定 taskId；后续费用分别绑定 stageId，避免先前合法费用阻止下一阶段的未调用重试。供应商和模型必须与前序相同，不自动回退。

readReview 只重建结果或返回需要的阶段。recoverReview 只协调已存在的当前阶段和过期费用，不发出模型请求。缺少回调且可能已发出的请求保留 uncertain，不能自动重发。

## 证据和数据

迁移 086 只扩展现有阶段表：predecessor_id、predecessor_digest、request_digest。前序复合外键约束同一 owner 和 task，删除级联；初稿的三个字段必须为空，其余阶段必须有合法前序和摘要。解码器额外限制合法阶段边，递归深度至多三层。

加密开始记录认证前序身份、完整解码结果摘要及请求摘要。继续执行时重新生成请求并核对摘要；历史读取逐层认证密文、调用回执、实际费用和模型路线。任何前序损坏或归属错配都会拒绝读取及后续执行。原稿旧开始记录和费用绑定保持兼容。

完整复核结论由这些已保存记录重新计算，不另建最终结论表。仅持久化入口在认证历史后返回 durable_model_judgment 和阶段证据；纯函数仍标记 non_durable_model_judgment。原始阶段内容均标记 unreviewed_model_output。模型判断不是事实正确性的保证，也不是发布授权。

账户导出使用同一解码器，包含实际阶段、回执、依赖摘要及私人输出，不输出鉴权版本、租约凭据或密文。实际 catalog 的新增字段和归属外键已审阅；仍是 173 张表、7 项排除、166 项需投影，JSON 143 项、文件归档 146 项，complete=false。删除账户清理阶段和可识别费用记录，保留既有匿名费用汇总。

## 尚未接通

当前只支持真实 direct_letter 的既有来源。已有执行记录的准备配置过期恢复、无人值守 worker、post 唯一发布、C7 完成与 UI 尚未接通。模型质量评测和 PR3 顺序门槛仍保留。没有新增 HTTP 入口或学生可见的“已完成”状态。

[验证记录](first-letter-durable-review-verification.md)；新增[真实进程退出与恢复验证](first-letter-process-recovery-verification.md)。本轮没有外部付费调用、主库迁移、部署、预览重启或发信。

尚未执行的准备现可通过 [FirstLetterTasks.refresh](first-letter-task-preparation.md) 显式更新，保留原任务身份；已有执行或费用记录不会被刷新。

已增加[持久化请求与后台队列](first-letter-dispatch.md)：原始会话绑定、数据库 outbox 和 Redis 恢复已实现；生产启动、学生触发和发布仍未接通。已接受请求的准备也不可刷新。
