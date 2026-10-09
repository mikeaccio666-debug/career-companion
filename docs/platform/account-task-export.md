# 已保存任务历史的账户归档

对应 09 §11 的本人数据覆盖要求，账户捕获新增六个区段：jobs、jobApprovals、jobAttempts、jobDispatches、conversationTasks、jobOutcomeReviews。它们读取底座中已经保存的用户历史，不向学生开放通用工作台，也不改变 03 §9 对产品待确认卡和内部任务审批的区分。

普通 JSON 当前覆盖 117 张已投影、7 张明确排除、47 张待处理；带私有文件模式为 120 / 7 / 44。两者仍 complete=false。当前计数包含后续加入的[浏览器/工作流执行历史](account-execution-export.md)。其他个人数据表、持久化归档任务、公开下载及删除协调仍未全部交付。

## 历史内容

任务保留原类型、供应商/模型、prompt、options、附件引用、实际状态、generation、尝试计数、进度、原错误和时间。保存的输入标记为 saved_task_input；不调用当前 provider 能力、模型配置、审批有效性或恢复流程重算状态。lease 仅转换为 cleanupPending，外部任务句柄仅转换为 hasProviderTask，不输出句柄本身。取消且仍持有 lease 的任务仍表示清理未确认，不改成执行已停止。

审批保存原请求输入、历史版本、pending/approved/rejected/expired 状态和决定时间，不限当前版本。原始请求标记 saved_approval_request，不能作为新的执行许可。已知公开模板 version/hash、模型 relay 额度、MCP 名称/授权版本/公共 schema 摘要以及计划来源均使用明确字段投影。内部 execution_policy、完整 ComfyUI graph、提供商端点、上游路由摘要、工作流/浏览器/MCP 定义摘要与 lease 不导出，也不从当前服务器配置补齐。

原用户输入的 options、MCP arguments 和附件坐标属于用户原始请求，按原值保留；不会把这些字段的原文与服务器密钥配置混在一起。未知审批顶层或服务器附加元数据字段使捕获失败，不任意展开。旧的 conversation-only 审批没有已知载荷协议，当前明确拒绝整包；未声称支持所有旧审批结构，不静默漏掉它们。

执行尝试和通知按存活父任务归属保存全部历史 generation。通知仅记录 createdAt、dispatchedAt、definitionRecorded，不发通知、不恢复队列，也不将 dispatchedAt 当作执行完成。对话来源按自身 user_id 独立读取，再检查任务、对话、消息的真实所有者和对应关系；对话已删而来源行随外键消失时，不为独立任务重建来源。

人工结果备注按任务、generation 和 revision 分页，校验连续版本及保存时 request_hash。保留 observed_effect/no_effect_observed/still_unknown、原 note、requestId、历史 evidenceVersion、provenance=user_reported 和 verified=false，不将用户观察升级成系统验证。不用当前执行状态重新生成过去的 evidenceVersion；现存摘要也不是认证不可变的全历史链，不宣称能检测整个历史被一致重写。

## 归属和事务

已有附件、计划、来源消息/任务/材料和 MCP 连接必须属于本人；存在的来源消息需对应原计划对话，材料需对应原来源任务及附件。已删除的非强外键引用保留原 ID 并标 not_found，不重新读取文件或补造文字。原来源 sha256/byteSize 只是保存的历史声明，归档不会据此声称验证了现有字节。跨账号或孤立强关联拒绝整个捕获。

仍使用固定本人会话、导出密码复核、现有 5 秒 REPEATABLE READ 事务、逐页取消和 JSON 容量限制。任务 reader 不实例化或调用模型、队列、对象存储或执行服务；SQL 仅显式读取字段。当前任务和审批可在并发取消后变化，导出仍保持原事务快照；归档失败回滚复核凭证消费，不返回部分历史。

## 验证记录

测试使用真实 JobService 创建、审批、取消、重试，对真实 worker 提供仅在进程内抛出虚构未知结果的 runtime，并通过真实 JobOutcomeReviews 写入人工备注。历史过期状态、额外执行代次及部分服务器元数据使用明确标记的保留状态夹具；不冒充真实第三方执行。覆盖归属隔离、未知字段、损坏备注、缺失修订、105 条记录跨页、取消与容量回滚，以及实际并发取消。MCP 使用虚构发现端口，禁止外部 RPC。

首轮测试修正了三个夹具引用错误（ProviderError 的导出包、结果读取方法和审批查询）；随后发现审批载荷的合法可选字段被误设为必填，改为闭合的必填/可选字段集合。前 10 项定向测试通过。扩展到 15 项后全部通过；完整相关回归首轮 279/280，唯一失败是旧 MCP 断言仍要求整包不含任务原文。改为分别检查任务原文保留与 MCP 元数据不含正文；修正过程中一处夹具 SQL 值被误删，已恢复，MCP 8/8 定向复验通过。计划归档 10/10 也通过。最终累计 282 项不同测试已有通过结果，无跳过；API 类型检查、git diff --check 通过。没有真实模型、外部 RPC、主数据库或部署操作。

覆盖计数核对于 2026-10-09，包含日常偏好、休息和计划记录，以及[共享记忆分类与待处理记录](account-memory-safety-export.md)、[模型调用记录](account-model-audit-export.md)及[主理人名字与选择历史](account-companion-identity-export.md)。
