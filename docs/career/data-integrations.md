# 求职 Agent 的知识、邮件与岗位数据接入

> 历史参考：本文已被 [docs/product/](../product/README.md) 取代，不再作为当前产品或实施决策。以下保留当时的调研与源码观察；当前定位、流程、分期和边界以权威产品文档为准，外部接口仍需在实际接入前重新核实。
>
> 产品不做个人签证或工作资格判断，相关问题交给学校 DSO 或雇主核实。

核实日期：**2026-10-06**。本文中的官方链接均于该日访问；接口、政策与数据版本需要在真实接入前重新核实。本文记录源码现状、官方资料和建议设计，没有连接蔓藤私库、访问用户邮箱、申请 OAuth 授权、调用搜索付费接口或提交申请。

先建立独立的职业数据层：授权知识帮助解释和练习，岗位目录提供当前观察，市场统计提供总体背景，个人证据记录用户实际经历。它们使用不同的来源和权限，不能混成一个“模型已经知道一切”的知识库。蔓藤资料同时包含文档、课程、咨询案例、数据库和内部网站，尚未集中整理；这不阻塞职业领域逻辑开发，但真实私库检索验收要等待内容目录、使用权和可访问样本。

## 当前代码具备什么

| 位置 | 已实现 | 还需要接入 |
| --- | --- | --- |
| [ai-core/chat.ts](../../packages/ai-core/src/chat.ts) | 模型流式消息、受限工具循环、上传附件上下文；Agent 将工具和页面内容视为不可信数据 | 文档解析、检索索引、知识版本、联网搜索和邮件连接 |
| [platform-api/app.ts](../../services/platform-api/src/app.ts) | 认证账号、私有 memories、上传、成果读取、私有知识来源及 `search_knowledge` / `read_knowledge_passage` 工具 | 职业档案和岗位工具、OAuth 连接账户、组织语料授权和同步服务 |
| [career-core/contracts.ts](../../packages/career-core/src/contracts.ts) | `CareerKnowledgePort`、`CareerJobsPort`、来源引用和求职证据契约 | 这些 ports 的真实实现；它们不是已经连接的 RAG 或 ATS |
| [career-core/skills.ts](../../packages/career-core/src/skills.ts) | 技能所需的 `search_knowledge`、`search_jobs` 等工具声明 | 将声明映射到经过认证、限定权限的服务器工具 |

现有 memory 是用户主动保存的短文本，附件是某次聊天的输入，文字成果读取工具是单文件读取；它们都不能替代可维护的知识库。现有浏览器观察工具读取已审批任务的私有结果，不会自行联网搜索。

## 私有资料库的第一条接入路径

网页资料页允许用户粘贴自己选择的纯文本或 Markdown，保存标题、来源说明和可选 HTTPS 来源链接。链接只是定位信息，服务器不会访问它，也不因此取得内部网站权限。当前来源只属于创建账号，不是共享的蔓藤课程目录；实际内部资料尚未导入。

来源原文与确定分段一起保存到 PostgreSQL。每份资料最多 64 KiB UTF-8，每个账号最多 200 份；修改和删除均提交当前版本，冲突时保留网页草稿。更新后旧段落版本拒绝读取，删除会移除源内容和索引段落。已经发送到聊天中的摘录仍受聊天保留规则约束，删除来源不会撤回模型已处理的输入。

`search_knowledge` 在认证账号的范围内进行词汇检索，返回至多八个段落。每段带来源 ID、当前版本、段落 ID、登记更新时间和 `untrusted_knowledge` 标记。`read_knowledge_passage` 只读取这个账号指定版本的段落，不生成建议或执行任务。检索没有命中时返回空结果；关键词相似不等于知识质量、事实核验或语义理解。

网页可以先预览真实片段，再把引用追加到 Agent 草稿。用户明确发送后，模型才可调用只读工具；所读内容可能进入选定模型的上下文。存资料和点击带入草稿不会自行调用模型。资料中的提示词、成功案例或操作要求都不构成执行授权，也不会变成当前用户的经历。

这一实现先走现有 PostgreSQL 和通用模型工具循环，保持供应商可以替换。PostgreSQL 提供全文解析、排序和 GIN 索引；中文连续文本还需要有界的字面匹配，不能据此宣称已经有完整中文语义检索。[查询与排序](https://www.postgresql.org/docs/17/textsearch-controls.html)、[全文索引](https://www.postgresql.org/docs/17/textsearch-indexes.html)。OpenAI 的托管 file search 是另一个可选 adapter，需要上传文件并创建 vector store；当前没有上传、购买或接入该托管服务。[官方 file search](https://developers.openai.com/api/docs/guides/tools-file-search)

后续仍需补文档文件解析、授权课程目录、内部只读 API、召回评测及向量／混合检索。`CareerKnowledgePort` 的适配和职业比较状态也尚未挂入 runtime；通用资料库不代表首十五分钟求职体验已经完成。实际实现的验证范围见 [平台验证记录](../platform/verification.md)。

## RAG、聊天 SDK 和 MCP 的职责

RAG 是“先检索相关资料，再把资料提供给生成过程”的组合。文档导入、分段、权限过滤、检索和引用属于产品的数据流程；聊天 SDK 负责模型调用与工具循环。已有 SQL、文档服务或 CRM 可以直接通过工具检索，不必先全部改造成向量数据库。[LangChain 官方检索说明](https://docs.langchain.com/oss/javascript/deepagents/retrieval)

Embedding 是可选的检索能力，并非当前聊天模型自动附带的知识库。Ollama 提供独立的 `/api/embed`；文档和查询需要使用兼容的 embedding 模型与版本。本轮没有检查或下载 embedding 权重，也没有调用该接口。第一条小型授权流程可先用全文搜索与明确标签，发现召回问题后再加入向量或混合检索。[Ollama embeddings](https://docs.ollama.com/capabilities/embeddings)

| 组件 | 解决的问题 | 不能自动解决的问题 |
| --- | --- | --- |
| 聊天/Agent SDK | 消息、流式响应、提出与执行工具调用 | 内容使用权、档案事实、检索质量、数据新鲜度 |
| RAG 数据层 | 找到适用资料、返回出处和版本 | 自动保证资料正确、自动证明用户做过某件事 |
| MCP | 以统一协议暴露工具和资源 | 替用户取得第三方授权、替服务器实施 ACL、授权网页中的指令 |
| 求职领域层 | 决定流程所需输入、输出和审阅标准 | 把不明来源内容变成已核验成果 |

MCP 可以作为蔓藤只读服务的一种外壳，普通 HTTP API 同样可用。采用 MCP 时，工具 annotations 只是提示，不能当作权限证明；每次调用仍由服务器核验用户和资源授权。访问 token 必须针对对应 MCP 服务，不把 Gmail refresh token 当作通用 MCP token 透传。远程服务和重定向也要防 SSRF。当前已实现 [服务器审阅的 MCP 客户端路径](../platform/mcp.md)：工具发现、账号 grant、任务审批、租约及私有回执；目录默认为空。尚未建立蔓藤 MCP 服务器、第三方 OAuth 或真实组织内容权限，现有服务凭据不代表用户邮箱授权。[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[MCP 安全实践](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

## 蔓藤混合知识库：两个入口，一个来源目录

### 先确认内容，再确认技术连接

第一步建立 inventory，逐项记录：内容负责人、形式与位置、覆盖的流程、人群、更新时间、是否包含客户或学生个人信息、可否用于产品检索/模型上下文/展示摘录、可访问的人群，以及撤回方式。拥有内部网站账号不等于拥有复制案例或对外展示课程的权利；匿名化也不自动取得使用权。这里是本项目的接入要求，尚未核实蔓藤各项资料的具体许可。

挑选一条可匿名、可授权的完整流程做试点，例如“商业类学生从一个课程项目探索实习方向”。至少保留触发条件、诊断问题、步骤、判断分支、案例、评价标准和需要导师介入的情形。只把课程切成孤立问答，容易丢失咨询过程中的先后顺序与适用条件。

| 入口 | 建议 port 职责 | 需要的真实材料 | 避免的做法 |
| --- | --- | --- | --- |
| 文档 import | 读取用户或内容方明确授权的文件；解析、分段、预览、确认后发布知识版本 | 一小组获准使用的课程/流程/匿名案例，原文件与权限记录 | 自动扫描所有网盘；未经许可复制整套课程；解析失败却显示已导入 |
| 数据库/内部网站只读 API | 服务端限定 endpoint、字段与查询；继承或映射源 ACL；返回稳定记录版本 | 内部系统提供的只读接口或限定导出、账号权限范围和撤回机制 | 让模型执行任意 SQL、接收客户端 URL/数据库密码、爬取登录后的全部页面 |

这两个入口是待实现的适配器，不新增假连接状态。初期数据库来源也可以先导出一小组获准记录作为文档试点；这只能验收导入流程，不能声称已验收实时 API、增量同步或原系统 ACL。

### 权限、版本与出处

建议私有来源目录维护 `sourceId`、内容负责人/组织、可见范围、许可状态、源定位符、内容版本、解析器版本、内容 hash、源修改时间（如有）、读取时间、知识版本登记时间及撤回状态。定位符、原文和凭据保存在私有层；向模型返回可解释的摘要、授权摘录和引用。

共享授权语料与个人档案分开：公开/获准课程可被多用户检索，咨询客户案例、个人简历与邮件必须依照各自 ACL；不能因为放在同一个向量库就共享。查询的 `ownerId` 来自认证服务器，不接受模型或客户端自行指定用户。先过滤授权来源，再检索、排序和组装上下文；缓存键包含账号/授权范围与知识版本。授权撤回后立即禁止读取、取消相关同步，清理副本、索引和缓存；旧对话中的摘录也需纳入保留/删除设计。

现有 `CareerKnowledgePort.search({ownerId, signal}, query)` 返回 `{text, citations}`，适合统一两个入口；`KnowledgeCitation` 的 `sourceId/revision/passageId/updatedAt` 不需要携带原始文件或密钥。`revision` 绑定不可变的内容版本，`passageId` 定位页/章节/记录字段。当前 `updatedAt` 可表示知识目录该版本的登记时间，但界面必须准确标注；不能用它冒充未知的原文修改日期。原文修改时间和抓取时间由适配器额外保存。

建议首版检索输入限定查询长度，返回少量段落及总字节预算，例如最多 8 段、摘录累计 16 KiB；只在需要时加载更多。具体限制应由服务端解析器实施，不依赖 tool description。每段都带可读取的引用，拒绝伪造/跨用户 `sourceId`，并将内容标记为知识来源而不是执行指令。资料中的“成功案例”只能支持方法建议，不能写进当前用户的履历；个人 IBM 课程项目的贡献和教授点评仍需要本人提供或确认。

## Gmail：先识别线索，再确认求职事件

### 最小权限仍有真实接入成本

| OAuth scope | 官方允许的能力 | 首版建议 |
| --- | --- | --- |
| `gmail.metadata` | 邮件 headers、labels 等元数据，不读取正文；Restricted | 若先做邮件线索，优先评估这一范围 |
| `gmail.readonly` | 读取邮件，包含正文；Restricted | 只有确需正文且用户明确选择后才评估升级 |
| `gmail.send` | 发送邮件；Sensitive | 独立外联发送功能才考虑；读取线索不需要 |
| `gmail.compose` / `gmail.modify` | 草稿、发送或修改等更广能力；Restricted | 首版不为了方便一起申请 |
| `mail.google.com` | 极广邮箱权限，包含永久删除 | 不作为本产品默认权限 |

scope 的类别和限制来自 [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。Restricted scopes 的公开应用接入涉及 Google 审核；存储或传输受限制数据可能需要安全评估，适用要求和例外必须按实际应用确认。注册本产品的邮箱地址、用户在 Codex 中连接 Gmail，都不能替代本产品自己的授权。

真实服务需要 Google Cloud 项目、启用 Gmail API、OAuth client、登记 redirect URI、服务器回调和每用户同意。OAuth state、防重放、账号绑定、加密 token、refresh/revoke、连接失效与后台任务停止也属于接入功能。本轮没有申请这些权限，也不需要用户现在在聊天中发送密钥。[Google Web Server OAuth 流程](https://developers.google.com/identity/protocols/oauth2/web-server)

### metadata 能证明到哪一步

`messages.list` 只返回消息/线程标识；使用 `gmail.metadata` 时不能使用 Gmail `q` 搜索参数。可通过限定 labels 和有上限的分页，再 `messages.get(format=METADATA, metadataHeaders=...)` 读取必要 headers，例如 From、To、Subject、Date 和关联回复标识；不能将正文、snippet 或附件假设为已授权输入。[messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)

| 观察 | 可以记录 | 不能直接断言 |
| --- | --- | --- |
| 有一封 Subject 类似 Application received 的邮件 | 邮箱里存在相应邮件；待确认的申请回执线索 | 用户真实完成了某个准确岗位的申请，或申请有效 |
| SENT label 和收件人 | 邮箱中存在发送记录线索 | 对方成功收到、阅读，或外联完成预定目标 |
| 某线程出现回复 | 线程中观察到新消息 | 招聘者有积极意向、消息不是自动回复 |
| Subject 含 interview / offer | 待确认的面试/offer 线索 | 具体日期、是否改期/取消、是否已面试、薪酬与条件 |
| 长期没有邮件 | 尚未观察到邮件证据 | 已被拒绝、没有申请或没有机会 |

业务判断列是本项目证据规则，不是 Gmail 提供的分类结果。发件人显示名、主题与线程也可能有歧义。先显示候选事件和依据，再由用户确认或补充；`observed` 不直接升级为 `user_confirmed`。邮件关联使用账号内 message/thread 标识与业务 subject 去重，同一申请的多封消息不能重复累计申请数量。

保存时间需要分开：普通 SMTP 邮件的 `internalDate` 是 Google 接受时间，API 导入的邮件可能由客户端按 Date 设置；它都不是自动确认的申请/面试发生时间。[Message 资源](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)

增量同步可使用 history cursor，但 history 记录邮件/标签变化，不是求职事件。游标过期可能返回 404，需要受控重新同步；失败或未完成同步不能显示“没有新机会”。[Gmail 同步指南](https://developers.google.com/workspace/gmail/api/guides/sync)

### 保留与模型使用边界

Google 当前 Limited Use 约束同时覆盖敏感/受限制数据及其派生数据；政策禁止建立永久 Google 用户数据副本，并限制超出 cache headers 的缓存。不得把邮箱整库导入长期 RAG、公共数据集或跨用户训练；发送到模型也要符合用户可见功能、同意及转移限制。真实接入前要确定允许的缓存、最少字段、模型数据处理与删除策略，不把一个自定 TTL 说成已经合规。[Google Workspace 用户数据政策](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

可先设计短期、按请求读取的邮件线索和用户手动输入的求职记录。来自 Google 的派生信息仍保留来源和政策约束；“用户点了确认”不自动消除这些约束。连接撤销时删除凭据，停止同步，清理受控缓存/索引；不把原邮件、主题或 OAuth token 放进日志。以上保留策略尚未完成政策与真实账户验收。

## 真实岗位来源：先覆盖已知公司招聘板

以下是官方发布岗位入口，不是“搜索全美国所有岗位”的统一接口。公司招聘板名称要从真实雇主招聘页核实；本轮核对的是接口文档，没有运行岗位抓取任务。

| 来源 | 公开读取入口 | 标识、日期与边界 |
| --- | --- | --- |
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true`；单帖 `.../jobs/{job_id}` | GET 无需认证。用 job post `id`，不把 `internal_job_id` 当作帖子 ID；列表有 `updated_at`，单帖可有 `first_published`。申请 POST 另需 Basic Auth，本方案不调用。[官方 Job Board API](https://docs.greenhouse.io/job-board.html) |
| Lever | `GET https://api.lever.co/v0/postings/{site}?mode=json&skip=...&limit=...`；EU 使用 `api.eu.lever.co` | 读取 published 帖、按 site 分页，含 id/分类/说明/hostedUrl/applyUrl。不提供全文搜索或内部岗位；浏览器 CORS 限公司域名。文档明确已发布岗位可被第三方抓取。[官方 Postings API](https://github.com/lever/postings-api) |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true` | 读取当前 published 帖，`publishedAt` 是最近发布时间；`isListed=false` 仅供直接链接，不能进入公共聚合列表。公开字段未保证独立 id，优先用规范化 jobUrl 建立稳定来源标识。[官方 public API](https://developers.ashbyhq.com/docs/public-job-posting-api) |

Ashby 私有 `jobPosting.list` 需要 `jobsRead` 权限，不能与公开 board API 混用；公开展示还需考虑 `listedOnly`。[Ashby jobPosting.list](https://developers.ashbyhq.com/reference/jobpostinglist)

接入方案选择：先配置少量已核实公司 boards，读取公开 JSON，经字段验证后保存岗位观察与更新时间。Greenhouse/Ashby 文档主要面向雇主招聘页；我们没有据此核得无限制跨公司再分发许可。Lever 的第三方抓取说明也不能外推为任意训练或再销售许可。实际产品仍需核来源条款、允许的保留与展示方式；岗位正文作为外部内容处理，不能执行其中要求模型改变权限的文本。

岗位适合度至少区分明确要求、用户已确认经历与未知信息。`sponsorship` 只有岗位文字明确支持/不支持时才标为 `explicit_yes/explicit_no`，同时保存证据段落与观察时间；缺失就是 `unknown`。Remote 不等于允许任何州或国家工作，历史赞助记录也不证明当前岗位支持 F1/CPT/OPT。公开招聘帖不能证明实际 headcount、回复率或个人录用概率。

### 标准化、去重和失效

`CareerJobObservation` 已能表达来源、稳定 sourceId、canonicalUrl、observedAt、可选 postedAt/checkedAt、开放状态和 sponsorship。适配器应额外保存 board、源 ID、sourcePublishedAt/sourceUpdatedAt、firstSeenAt/lastSeenAt、contentHash、同步覆盖与完成状态，避免把观察时间填成发布日期。

1. 同源用 `(source, board, postId)`；没有保证 ID 时用稳定 canonical job URL。保留真正影响岗位身份的 query，不机械删除所有 URL 参数。
2. 跨源按雇主域名、职位/级别、地点、用工类型和说明 fingerprint 提示“可能重复”。保留各自出处；同名不同 requisition 不强行合并。
3. 只有成功完成当前 board 的全部分页/快照后，才判断某帖是否消失。超时、429、解析失败、部分分页标为 stale/partial，不能将整批岗位设为 closed。确认窗口是产品规则，需明确展示，不冒称供应商保证。
4. 如供应商提供 ETag/Last-Modified，可以条件读取；304 代表版本未变，不代表岗位刚发布。审阅投递材料前再核当前源帖，保留 checkedAt；重新读取不提交申请。
5. 数据展示写明已覆盖公司、观察时间及缺失范围。有限 boards 的帖数不能称为美国市场总岗位数。

## O*NET 与 BLS：五种不同的数据

| 数据 | 统计/内容对象 | 对产品的价值 | 不应混称 |
| --- | --- | --- | --- |
| O*NET | 职业知识、任务、技能、工作活动与环境 | 帮学生理解日常工作，把课程经历映射到任务 | 当前雇主 JD、招聘数量或签证许可 |
| BLS OEWS | 职业就业存量与工资；覆盖规定范围的全职/兼职工资薪金岗位 | 比较职业规模、地区和工资分布 | 今天开放岗位、毕业生起薪或 total compensation |
| BLS JOLTS | 月末最后工作日的 job openings；整月 hires/separations 是流量 | 理解行业层面的劳动力需求与流动 | 具体职业/公司职位清单或招聘帖总数 |
| ATS 帖 | 我们覆盖的雇主公开招聘广告观察 | 了解现时岗位要求，准备一次具体申请 | 全国空缺统计、真实人数或所有招聘渠道 |
| BLS Employment Projections | 十年就业变化与预计职业 openings；包括退出/转行产生的机会 | 长期方向探索和背景解释 | 即时招聘量、每个人的求职成功率 |

O*NET 当前数据库为 **31.0（2026 年 8 月）**，按版本维护。下载数据多数适用 CC BY 4.0，但需保留归属、许可证与改动说明，并核具体例外；API/网站材料分别核其许可。职业任务可帮助形成假设，用户是否具备技能还需作品或练习证据。[O*NET database](https://www.onetcenter.org/database.html)、[版本档案](https://www.onetcenter.org/db_releases.html)、[许可入口](https://www.onetcenter.org/license_agreements.html)

O*NET Web Services 当前 API **2.0** 用 `X-API-Key` header，需要注册项目，支持 GET 读取；不是旧版 Basic Auth。版本化数据库下载是另一入口，可先评估离线有限字段而不建立真实 API 连接。[O*NET API 2.0](https://services.onetcenter.org/reference/start/overview)

OEWS 的 employment 是岗位数口径，主要覆盖非农工资薪金单位，不包含所有自雇或农业工作；职业按实际工作分类。工资也不等于完整总薪酬。May 2025 数据于 **2026-05-15** 发布，估计使用六个半年度样本面板，不能拿访问当天当作统计期。[OEWS concepts](https://www.bls.gov/opub/hom/oews/concepts.htm)、[calculation](https://www.bls.gov/opub/hom/oews/calculation.htm)、[May 2025 发布](https://www.bls.gov/news.release/archives/ocwage_05152026.htm)

JOLTS openings 要满足具体职位、可在 30 天内开始及主动对外招聘等定义；统计时点是月末最后工作日，hires/separations 则涵盖整月。[JOLTS FAQ](https://www.bls.gov/jlt/jltfaq.htm)

当前 BLS 职业预测期为 **2025–2035**，表中的 openings 是年度平均预测，含就业变化和职业分离，不能按招聘网站帖数解释。比较数据时保留单位（如千个岗位）、统计期、地域、季调状态、SOC/职业 taxonomy 版本和覆盖范围；未验证 crosswalk 不直接合并细职业。[职业 openings 表](https://www.bls.gov/emp/tables/occupational-separations-and-openings.htm)、[EP 定义](https://www.bls.gov/emp/documentation/definitions.htm)

这些来源都不能独立给出国际学生的法律工作资格或某岗位的签证支持结论。产品可以明确提出需向学校 DSO/雇主核实的问题，不从总体统计推导个人资格。

## 联网搜索与抓取：发现来源，再读取和核实

搜索可以发现公司、board 和资料 URL，但搜索摘要不是已验证的职位内容。以 Brave 官方接口为例，它需要订阅 token，`freshness` 根据网页发布/修改日期过滤，分页结果仍可能重叠；“最近一周”不证明雇主当前仍招这个职位。本项目尚未接搜索供应商，需真实账户/计划与服务端显式配置后才能验收，也不能预设调用免费。[Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)

建议流程是搜索发现 → 核实雇主与规范 URL → 优先官方 ATS JSON → 必要时读取允许访问的公开页面 → 记录出处/观察时间 → 去重 → 在任务审阅时再次核实。模型联网能力、浏览器抓取和搜索供应商分别记录状态；某一项不可用不以模型凭记忆生成“最新岗位”。

抓取遵守 robots 和源站适用条款；robots 规则不是授权机制，也不表示获得转载许可。[RFC 9309](https://www.rfc-editor.org/info/rfc9309/) 服务器另外实施 HTTPS、目标域名/地址检查、重定向复核、响应类型/大小/时限与请求预算；登录、验证码和受限制页面不得通过抓取绕过。现有审批浏览器可以作为限定补充，不把通用爬虫权限暗藏在岗位搜索里。

## 最小试点与验收边界

第一条流程可用本人已确认的 IBM 课程项目事实、一条获准使用的蔓藤匿名流程和少量有来源的岗位观察：检索适用方法 → 列出缺失事实 → 比较两个工作方向 → 形成待审阅项目表达/练习 → 用户纠正 → 安排一次小行动。引用咨询案例的方法不意味着当前用户做过该案例；不把“包装项目”变成虚构客户、收入、实习或教授评价。

| 现在可进行 | 真实接入验收需要 |
| --- | --- |
| 职业领域契约、工具 readiness、权限与版本测试 | 私库内容清单、使用范围、可授权试点和真实 ACL |
| 虚构文档/数据库适配器测试与引用校验 | 文档原件或限定只读 API；不能以 fixture 宣称已连接 |
| 官方岗位字段解析、分页/重复/失效 fixture | 经核实的公司 boards、条款/许可和实际读取验收 |
| 邮件事件规则与匿名 metadata fixture | 本产品 Google OAuth 项目、用户授权、审核/安全/保留方案 |
| O*NET/BLS 字段与统计期设计 | 选择具体数据版本/许可；如走 O*NET API，再配置真实 key |
| 搜索适配器与失败状态设计 | 供应商账号/计划、配置和真实传输验收 |

以上依赖不要求现在发送任何凭据。未连接工具应显示 `requires_connection` 或 `unavailable`；私库尚未整理不阻塞 draft/domain core，但不能显示“已用蔓藤知识核实”。

接入实现应至少验证：两个账号不能读对方来源/引用/缓存；撤权后旧 passage 不再可读；内容修改后旧版本不能冒充新引用；检索无结果与连接失败分开；引用确实对应所述段落；网页/知识内容不能改变工具权限；metadata 模式不能读取正文；邮件主题只生成候选事件；分页失败不关闭岗位；缺失 sponsor/日期保留 unknown；所有同步可取消、有预算，不泄漏 token、原邮件或私库原文到日志。纯 fixture 只证明本地协议和规则，真实连接与内容质量需要另行验收。
