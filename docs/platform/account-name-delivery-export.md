# 命名阶段原始提示与交付记录的本人导出

依据产品 09 §11 和 13 §4.5，在同一个 AccountCoreExport 捕获事务中增加八张原始表：

| JSON 段 | 原始表后缀（platform_companion_name_） | 含义 |
| --- | --- | --- |
| nameSafetyResponses | safety_responses | 原检测结果对应的待准备或已准备提示、当时语言及语言来源 |
| nameDeliveryHeads | delivery_heads | 每个来源的发布版本与最后发布引用 |
| nameDeliveryOperations | delivery_operations | 原发布、恢复及重试命令 |
| nameResourcePublications | safety_publications | 按当时审核资产生成的正文、问题模板与资源卡 |
| nameBodyProjections | safety_body_projections | 实际签发的正文投影；不等于已经展示 |
| nameFollowupStates | safety_followup_states | 原操作链的版本与末次操作引用 |
| nameFollowups | safety_followups | 实际展示、确认、支持请求与明确处理动作 |
| nameHandledSources | safety_handled | 明确继续或澄清操作与原检测来源的关联 |

读取保留原始状态：pending、prepared、published、projected、presented、acknowledged、handled 分别来自各自记录，不相互推定。问题模板不证明问题真的问过；共享提问 occurrence/operation/scope/exposure 及混合来源 safety_events 表由[共享安全历史导出](account-shared-safety-export.md)独立核验与投影。

原始响应核验真实检测来源、准备事件、原密文、来源代次、语言来源证明与时间关系。原检测已产生 L1/L2 时，响应整行缺失也使导出失败，即使还没有发布记录；不以重新创建记录来掩盖缺失。已准备的响应不得早于原记录创建时间，创建时间不得在未来。

每份发布核验原始响应、当时资源资产、审核激活、创建命令、正文/问题摘要与保留期。原始读取及校验函数由交付流程与导出共用，归档仅在账户 REPEATABLE READ 事务内使用无行锁读；执行路径的默认锁保持不变。当前政策被删除、用户更名、撤回协议或邮箱验证变化，不替换过去实际捕获的内容。

来源的发布版本必须连续，首份发布锚点、当前 head 和所有创建操作必须一致。每份发布的操作逐条连接 genesis、版本、摘要链与原封存状态；展示、确认与明确处理必须属于同一会话和正文投影，不能跨会话拼接。子表总量与来源核对防止整段缺失后被当成空历史。

所有 owner 表以及每份提示的投影和操作以每页 100 条遍历。原来源缓存最多八份，淘汰后重新验证；关系缓存不保留密文。每条输出计入账户总字节限制。固定会话在捕获前后验证；损坏、缺失、取消、认证失效或超限会回滚整份结果与密码再验证凭据消费。

返回的是本人历史，不调用模型、发布/恢复服务、签发凭据或创建共享记忆。不返回密钥、session hash、展示凭据/摘要、执行令牌、原密文、内部审核人身份或历史 authVersion；处理时的协议版本保留。资源资产与审核操作仅用于核验，不因被读取就算作用户数据表已经导出。

JSON 当前覆盖 139 表、剩余 25；带私有文件覆盖 142、剩余 22；另有 7 项既有豁免，总清单 171。两种模式保持 complete=false。没有 schema 或 UI 变更；完整自助下载、删除协调、其余资料及整个 P0 仍需继续完成。

验证使用虚构资料、隔离 PostgreSQL schema 和受控 loopback provider；11 个专项用例覆盖原始状态、实际处理、105 条重试/投影/操作分页、七类密文损坏或串户、八类表缺失、旧状态回滚、操作后缀截断、历史资产/激活丢失、原语言证明变动、未发布响应缺失、时间不一致及取消/鉴权/容量回滚。详细回归结果见 [验证记录](verification.md)。
