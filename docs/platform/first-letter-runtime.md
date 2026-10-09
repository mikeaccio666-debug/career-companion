# 第一封信的后台模型通道

依据 02 §5.4、09 第 2 步：第一封信需要后台单次生成，不经过聊天/工具循环。新增内部用途 first_letter_generation，由现有 runtime.streamChat 的 background 通道处理，与人格预览 companion_generation 分开选择和记账。

## 配置和行为

- 服务端路由为 PLATFORM_FIRST_LETTER_PROVIDER；当前已验证适配器仅支持 openai。具体模型来自 OPENAI_FIRST_LETTER_MODEL。两个配置都需明确；没有普通聊天、人格预览或其他供应商回退。
- .env.example 仅增加未启用的示例。真实环境、密钥、商业调用开关、价格表、费用预算及学生功能开关均未修改；现有隔离 Haiku/Luna 预试入口独立保留。
- Runtime 仍要求实际 requestAdmission 和 onModelCall 回调。请求、用途、模型、结构化 schema、消息与限制在惰性流启动前冻结；后续改写调用方对象不能换成另一个用途或模型。
- 沿用一请求、零工具、store=false、严格结构化格式、最多 1536 输出 token 和 15 秒的当前后台界限，不复用旧会话或 continuation。结构化格式按 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) 发送；本地仍校验原 schema 的字符串长度等约束。
- onModelCall.started 明确记录 first_letter_generation；终态用同一 callId 记录结果与实际用量。供应商部分文字不会向上返回；要等正常终态、结构检查和最终记账回调完成后才返回完整文本。
- 拒绝、断流、超输出上限、工具结果、错误 JSON/schema 和取消均不能成为成功结构化结果。只有正常读完的终态证据可以标记 invalid_format；供应商自述“完成”或内容中的字段不算回执。记账回调失败时不返回可用文本。

单次传输支持不等于真实费用已落库：消费服务仍须使用真实 CostGuard 预留/发送意图/结算、用户身份和来源核对。没有费用回调持久化的内存测试不能当作生产计费证据。本通道也不实施自动重试；重试必须由未来持久化信件任务控制，不能把失联调用当作未花费。

## 产品边界和剩余实现

路由不出现在学生可选能力中，内部 model metadata 不替换公开 chat/preview 配置。没有新增学生 HTTP 接口；它不是第一封信完成状态、发送接口或权限。

本批测试的 letter schema 和正文都是虚构的传输夹具，不是正式提示词或产品质量评测。schema 通过只能证明形状符合要求，不能证明事实、人格、引用、已上线队员、AI 披露和对外执行说明都正确。

仍需将 [真实 O2 来源](first-letter-sources.md)、当前人格、实际队员开关、正式信件格式/规则和费用接到任务服务，再实现后台租约、恢复、唯一消息保存、可信完成回执和界面。当前 ConversationTurns 只有旧会话 submit，尚无产品需要的 post 发布接口；不能复用旧聊天 SQL 或把 C1 固定欢迎语冒充信件完成。PR3 的真实评测/顺序门槛仍待解决，本文不批准改变它。

没有数据库变更、主库迁移、付费调用、通知、部署或页面解锁。
