# 共享安全准备事件与问题交付历史的本人导出

产品 09 §11、13 §4.5 要求覆盖所有本人资料。AccountSharedSafetyExport 在原账户捕获事务内接入五张混合来源表：

| JSON 区段 | 原表 | 含义 |
| --- | --- | --- |
| safetyResponseEvents | platform_safety_events | 入门或命名固定提示实际准备完成的事件 |
| safetyQuestionScopes | platform_safety_question_scopes | 两类来源共用的对话级问题交付版本 |
| safetyQuestionOccurrences | platform_safety_question_occurrences | 每个问题当前保存的预留、领取、展示声明状态与原时间 |
| safetyQuestionOperations | platform_safety_question_operations | 原 reserve / claim / present 操作及当时状态；claim 保留原问题文本 |
| safetyLegacyExposures | platform_safety_legacy_exposures | 旧版已传输提示的“可能展示”记录 |

## 原始事实和语义

准备事件必须逐一匹配同一事务里已验证的原响应、来源类型、代次、检测版本、级别和时间。每个 ready 响应恰好有一个事件，pending 响应没有事件；入门和命名各用原始字段关联，不借用另一类来源的 ID。

reserved 表示已预留，claimed 表示已领取展示许可，declared 表示服务端收到客户端的展示声明。claimed 即使过了展示窗口，也不能据此推定用户没看过；declared 也不证明真人阅读或理解。导出保留原 phase 与时间，不按当前时间改写历史状态。claim 的问题文字表示当时发出的内容，不因导出这段文字而补造展示回执。

旧版提示可能已经包含问题；legacy_possible_exposure 不会升级成已提问，也不会被当作明确没展示。现有重复提问限制不因导出改变。

## 验证与边界

作用域必须对应已验证的入门草稿、原切换记录及草稿上的 scope 锚点。复用 readQuestionJournal 验证原 legacy genesis、连续操作版本、摘要链、当时请求与秘密摘要、会话/展示端关联、每次状态转换以及最终 occurrence 和 scope。再将每次操作的原状态核对到同一事务中已验证的实际发布：来源类型、逻辑草稿、submission、generation、L2 级别、原问题摘要和时间窗口全部一致，claim 问题必须逐字等于原审核发布。仅操作链内部自洽不能替代这一步来源核验。

旧提示以真实原输入、分类、固定响应和原密封发布重新核对其历史摘要；不查询当前政策来重写内容。只给原读函数加入归档用的 lock=false 与分页选项，正常执行仍使用原锁和原查询。所有归档表按 100 条取页；单个 scope 仍需要在内存中验证完整操作链，这不是面向任意规模的流式归档 worker。

输出逐字段选择，排除 session hash、render owner ID、reservation/grant ID 和秘密/摘要、原密文、员工身份与审核细节。保留用户问题内容、原操作 ID、来源坐标与时间，不签发或恢复任何展示权限，不初始化 scope，不调用模型。

原表计数与草稿锚点防止整个 scope 或子表遗漏后被误报为空；准备事件和旧展示时间不得在未来。取消、认证失效、内容损坏、跨用户替换、缺失来源或超出大小/事务时限时，整份捕获回滚，密码再验证凭据可重试。

## 覆盖范围

JSON 现覆盖 141 表、剩余 23；带私有文件覆盖 144、剩余 20；既有豁免 7 项，总清单 171。两种模式仍 complete=false。无数据库迁移或 UI 变更；其余资料、完整自助下载、可持续归档任务及删除协调仍需完成。

专项验证包括两类来源、同一实际用户的混合 scope、真实预留/领取/展示、旧版可能展示、当前政策撤回、105 条实际事件/occurrence/operation 跨页、密文损坏或串户、缺失整段、旧 scope 回滚、操作后缀截断、来源不一致，以及取消/鉴权/容量回滚。资料全部虚构，使用隔离 PostgreSQL schema 与 loopback provider；展示声明只来自测试客户端，不声称做过浏览器视觉或真人阅读验证。最终结果见 [验证记录](verification.md)。

按实际覆盖常量与 ACCOUNT_DATA_SCHEMA 核对，23 张剩余表由 20 张 organization_review 和 3 张 file_projection 组成。5 张命名任务与入门索引已由[原记录导出](account-prebirth-dispatch-export.md)覆盖。带私有文件模式已覆盖后者；组织数据须按学生/员工归属、授权与许可单独决定导出字段，不能直接复制整份共享知识或员工权限资料。
