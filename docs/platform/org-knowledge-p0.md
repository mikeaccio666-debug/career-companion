# P0 组织知识库：授权导入与出处读取

依据产品 04 的 P0 内容许可、题库／方法卡／陪伴模式，以及 09 的 3C。本切片提供实际的员工操作 CLI、PostgreSQL 持久化和学生引用读取。未导入蔓藤真实资料、未签发生产许可或首批用户权益；虚构测试不代表人工审核、商业授权或上线通过。

## 内容与权限

三类闭合结构保存在 career-core 的 assets/p0-assets.ts。题目类型、岗位家族、方法的 skill 和 speaker 必须是现有定义；rubric 有 3–6 个维度，每维度 0–3 四级描述；行为题不提供预制个人经历答案。外部平台题目只保存公开引用信息和系统生成的引用请求，不能粘贴原题。纯校验和联系方式／销售措辞拦截只是补充，不能代替去标识化、版权和内容审核。

新导入的源正文为经过校验内容的确定性可读文本，结构化记录独立保存；旧规范 JSON 正文仍按原文与原哈希校验。单条不超过 64 KiB；沿用 splitKnowledgePassages，每段最多 1200 字符。原始销售对话、学生材料和合同正文不得进入源码、导入正文或日志。陪伴模式始终不能由学生出处接口打开。真人导师的身份只由真实员工账号及 mentor 角色证明。

每项许可引用操作员自己的私有上传凭据。登记时核对实际存储文件和数据库大小；读取时凭据记录仍需存在。登记行为表示获授权操作员的声明，不意味着软件已经判断合同法律效力。用途只有 retrieve、model_context、display_excerpt、display_full、aggregate，没有训练授权。没有 display_full 的许可不能导入自有题目的完整题面。

## 操作 CLI

在服务器的项目目录使用 ./scripts/project.sh --filter @companion/platform-api org-content，动作包括 license、import、publish、withdraw、entitlement、revoke-license。每次都需要 --org、--session-file 和 --input-file；publish／withdraw／revoke-license 另外需要 --id。publish 的 id 是导入批次，withdraw 是来源，revoke-license 是许可。

会话文件是当前真实登录会话的 userId 和 token，权限必须为 0600，归当前 Linux 用户所有。CLI 不创建用户、角色、会话、许可或权益样例；不提供假签发接口。仅将 token 转为哈希，然后使用现有会话、账号种类、组织状态与 ops／org_admin 角色通道核验。不要把 token 放到命令行或聊天中。输入文件同样要求 0600、当前所有者、普通文件；拒绝符号链接、共享权限、读取期间变化、非 UTF-8 和超限文件。会话上限 4 KiB，导入文件上限 16 MiB。

输入顶层字段：

| 动作 | 字段 |
| --- | --- |
| license | operationId、assetClass、agreementRef、allowedUses、audience、validFrom、validUntil |
| import | operationId、licenseId、sources |
| publish | operationId |
| withdraw／revoke-license | operationId、expectedRevision、reason |
| entitlement | operationId、userId、expectedRevision、audienceGrants、expiresAt、revoke |

所有 ID 为实际 UUID，时间为规范 UTC ISO 字符串。audience 为 all_users／cohort／entitled／staff_only；权益的 audienceGrants 为 cohort／entitled。初次权益 expectedRevision 为 0，修改需要当前版本；所有写操作需要独立 operationId。同一 nonce、同一输入重试返回原回执；改输入复用 nonce 返回冲突。原回执是历史记录，不能表示许可或权益目前仍有效，更不能恢复已撤回内容。

每个 sources 行必须包含 assetClass、title、structured、language、roleFamilies、tags、editor、reviewer、validUntil、reviewConfirmed、deidentified。editor 和 reviewer 是已有真实员工的规范小写邮件，且必须为独立账号及 content_editor／content_reviewer 角色；规范结构与元数据岗位家族必须一致。两个布尔值必须由已经完成离线审核的人明确设为 true，程序不会自动审核。P0 最多 150 条；任一行无效、角色不成立、许可不适用，整批回滚。

导入为 in_review，学生无法检索。publish 再核对许可、有效期、独立编辑与审核角色；题目有 rubric 时审核员还需 mentor 角色，方法作者和审核员都需真实、独立的 mentor 身份，structured.reviewer_id 必须与该行真实审核员一致。方法的反例为必填，有效日期必须合法。方法只在有效日期到达、没有 superseded_by 且 speaker 绑定匹配时进入内部检索。内容经显式发布后获得全局单调 publish_batch，来源版本从 1 变为 2，引用坐标同步更新。

发布前仍需蔓藤教研／规划师和产品负责人按 04 完成人工内容评审：题库 rubric、方法是否可执行、陪伴对话分类、去标识化，以及 considering_agency 中免费的学校职业中心、队伍练习、公开资源等替代方案。CLI 的员工角色和输入断言不能自动证明两方真实做过这些工作。

withdraw 清空正文、结构和段落，保留撤回墓碑及加密回执；原因仅保存在加密操作记录，不进入 stdout 或内容日志。revoke-license 与权益 revoke 立即影响后续实际读取。组织变更串行，状态有加密校验和不可变的独立最新版本证明；回放旧的真实密文不会恢复旧权限。员工审计只记录 ID、角色、动作、结果及实际记录数，不包含正文。

## 学生出处读取与内部检索

GET /api/platform/org-knowledge/passages/:sourceId/:revision/:passageId，返回闭合的学生 passage（含服务端品牌前缀、内容版本及对应标签），Cache-Control 为 private, no-store。要求当前真实会话、窗口账号标头、已验证邮箱、现行条款与学生账号。使用独立 org-knowledge 请求额度（初始工程配置每用户每分钟 60 次，可由可信服务器配置调整）。

出处读取核对当前组织、当前权益、许可用途／受众／有效期、来源版本、发布状态、内容哈希和实际段落。无当前权益返回 NOT_ENTITLED；授权仍有效但来源版本变化或撤回返回 STALE_REVISION；完整性无法证明则拒绝输出。all_users 也仍要求有效的该组织权益；staff_only 不进入学生读取。禁止 includeOlder 等未实现查询。

OrgKnowledge.search 是未向学生暴露、未注册进 agent 的服务端结构化读取，最多 8 段／48 KiB。当前权限、许可和内容筛选在 LIMIT 前；角色、题型、难度和主题按 P0 元数据检索，不声称已实现中文全文语义检索。题目用于前辈、投递官、面试官；模式仅用于主理人，方法按绑定 speaker 加载。结果标记 untrusted_knowledge，不能把正文当作系统指令。

真实请求会写内容无关的访问记录及 180 天 retention_until；账号删除级联移除本人权益、权益证明和访问记录。定期到期清理任务尚未接入。当前 preparation_lookup 只记录内部准备读取，不伪装成某条模型消息真正使用了该来源。

## 验证与后续

用虚构许可和资料在隔离 PostgreSQL schema、真实 LocalBlobStorage、实际密码登录 HTTP 中测试；全程模型请求关闭。覆盖私有凭据、用途、独立角色、整批失败回滚、150 条导入／发布、重复操作、引用版本、权益与许可撤销、旧密文回放拒绝、不可变证明、内容篡改、模式隐藏、mentor 身份、账户删除及重复迁移。隔离 schema 与虚构文件均清理。

本切片没有修改运行中的预览或主数据库，没有部署。CareerKnowledgePort 已接通真实准备引用和统一读取，服务内绑定与剩余运行持久化边界见 career-knowledge-port.md。下一步仍需将知识绑定写入真实专家运行记录，接通任务租约和输入准入，完成 skill 绑定、真实回复的出处标签接入、练习／反馈记录及提醒；独立出处页见 org-source-web.md。完整 64 KiB 来源、不同机器负载和真实内容批次仍需进一步容量验证；150 条短虚构题通过不等同于最坏负载保证。09 的模型实测与禁止付费调用之间的待决事项继续保持原边界。
