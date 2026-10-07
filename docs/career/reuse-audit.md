# 求职 Agent 复用审计

> 历史参考：本文已被 [docs/product/](../product/README.md) 取代，不再作为当前产品或实施决策。以下保留当时的代码观察与复用建议；仓库、分支和 PR 状态是该次审计的快照，当前实施以权威产品文档和实际源码为准。
>
> 产品不做个人签证或工作资格判断，相关问题交给学校 DSO 或雇主核实。

核对日期：2026-10-06。范围为当前 workspace、本地已发现的源仓、已授权 GitHub CLI 的仓库与 PR 元数据，以及官方浏览器／ATS 文档。本次只读检查源码；唯一新增文件是本报告。未读取环境值、履历或运行数据库内容，未抓取真实岗位、调用模型、提交申请、推送或部署。

## 结论

建议以现有通用平台承载求职 Agent，用独立岗位目录适配器接入 `job-radar`，从 Argoland 提取技能缺口、课程／项目推荐和练习证据模型，保留插件作为电脑端填表执行器。新产品的身份、资料、任务、授权、结果和学习进度由新架构管理。

已经找到用户所说“只提过一个 PR”的明确候选：`mikeaccio666-debug/job-radar` 的 [PR #1](https://github.com/mikeaccio666-debug/job-radar/pull/1)，目前 **OPEN、未合并**。本地 `/Users/acciokee/抓岗` 的 clean HEAD 与该 PR head 相同：`90d34a984266b8822cb9fcb19fd957b9e797fac4`。另有一套来源不同的旧 scraper，不能混为同一项目。

## 实际来源与状态

GitHub 已授权 CLI 确认当前账号为 `mikeaccio666-debug`。用户写的 `edaix-offcial` 查无对应组织；实际可访问组织为 `edaix-official`。下列 GitHub 仓库均为 private，链接需要相应权限。

| 来源 | 实际位置／固定证据 | 当前用途 |
| --- | --- | --- |
| 当前新产品 | `/Users/acciokee/chatbot`；活跃目录为 `apps/`、`packages/`、`services/` | 通用网页、平台 API、模型 runtime 与插件边界；本轮根目录不是 Git checkout |
| 用户岗位监控 | `/Users/acciokee/抓岗` → [job-radar](https://github.com/mikeaccio666-debug/job-radar)，PR #1 head `90d34a984266b8822cb9fcb19fd957b9e797fac4` | 小型独立 Python 采集、发现、岗位变更与新鲜度核心；尚无产品 API／前端／推荐与投递 |
| 插件源仓 | `/Users/acciokee/argoland-extension` → [argoland-extension](https://github.com/edaix-official/argoland-extension)，本地 HEAD `01006b023edc85265d33cd0ffc7b371f1bb0108c` | 完整源仓；当前 workspace 另有固定迁移快照，不能把本地源仓 HEAD 当迁入版本 |
| 插件迁移来源 | `imports/extension-reference/migration-manifest.json`，commit `d1a496bfce8249c694792ad70c237fe5b943aaee` | 历史来源记录；活跃插件已在 `apps/extension` 与四个独立包 |
| Argoland 后端参考 | `imports/argoland`，manifest 固定 [argoland](https://github.com/edaix-official/argoland) commit `013d5128bd474f98b78df8c9878e1321712b134b` | 选定源码及依赖参考，不是 workspace 包，也不是可启动的完整 Learning 应用 |
| Argoland 网页参考 | `imports/argoland-web`，同一 commit，独立 manifest | 旧网页／插件桥接和课堂类型参考，不作为新网页运行时 |
| 另外本地 Argoland checkout | `/Users/acciokee/edaix-job-agents/argoland`，HEAD `9bd35d6865bff831ae254858761f32439cc58ddb`，`src/learning` 存在 117 个 TS 文件 | 完整源仓的另一版本；多个本地 worktree 不代表多个产品后端。`/Users/acciokee/argoland` 自身只是目录入口，未发现根 Git 元数据 |
| EdAIX 旧 job agents | `/Users/acciokee/edaix-job-agents/main` → [edaix-job-agents](https://github.com/edaix-official/edaix-job-agents)，HEAD `6c74a3d0f5d61b4196eb10d73f1b105057c98ea8` | 包含 `services/scraper` 与旧岗位目录／推荐业务，具有不同门户与服务假设 |
| 旧 scraper donor | `/Users/acciokee/edaix-job-agents/scraping-pipeline` → `victorx98/scraping-pipeline`，HEAD `ae6d3a16d4e70b93bbc4109a256931ac53f3a0e0` | EdAIX `docs/provenance/services-scraper.manifest.json` 指向这一来源；与 job-radar 无关 |

组织中还存在 `edaix-official/edaix-job-agents-backend`；已确认仓库元数据，没有假定它与上述本地 checkout 内容相同。PR 数量核对针对 job-radar 全部状态：只返回 #1。仓库存在、源码存在、历史测试记录与今天真实服务可用性是不同证据，本报告不把它们互相替代。

## 当前平台可以直接承接的部分

| 模块 | 可复用职责 | 新求职域需要补的内容 |
| --- | --- | --- |
| `apps/web` | 聊天／Agent、手机布局、语音、附件、作品预览、工作流与任务审阅 | 职业资料、岗位列表、行动计划、练习／复盘界面；不在 React 页面中写站点执行器 |
| `services/platform-api` | 用户会话、owned conversation／job／artifact、审批、任务租约、队列、结果与私有文件读取 | 求职域所有权、版本和数据 API；抓取公共岗位不等同于获准读取私人职业档案 |
| `packages/ai-core` | 显式 provider routing、工具调用、任务执行接口、可取消的本地 browser 与 CLI | 有界、只读的岗位查询／证据读取工具；规划或生成内容不能自行取得发送与投递权限 |
| `packages/platform-contracts` | 通用 Provider／Job／Approval／Workflow／Artifact 契约 | 新职业域的公共 DTO；不要直接暴露 Python 内部数据库行或旧 Prisma 类型 |
| `packages/contracts` | 已存在的技能、gap analysis、学习推荐与插件协议的纯解析／计算 | 清晰的职业子入口与适配层；暂保留 `@edaix/*` 名称不影响独立产品架构 |

平台已支持 owned 文字成果带回 Agent 草稿与 `read_artifact_text`；浏览器观测使用专用 `get_browser_observation`。可以沿用“引用来源、用户发送后按权限读取”的交接方式，让项目练习与岗位分析回到对话；不要复制私人正文到日志或把外部岗位正文当可信指令。

## 岗位采集：优先复用 job-radar

`/Users/acciokee/抓岗/pyproject.toml` 声明 Python 3.11+、`httpx`、`psycopg[binary]`、`beautifulsoup4`；Playwright 是可选依赖。主路径不需要模型或招聘平台 key。以下结论来自源码，不是本轮外网抓取成绩。

| 源码 | 可复用能力 | 接入边界 |
| --- | --- | --- |
| `src/job_radar/adapters.py` | Greenhouse／Lever／Ashby／SmartRecruiters 的固定 HTTPS GET；分页、结构校验、20 MiB 响应限额、拒重定向 | 保持独立采集服务；失败与合法空列表分开，不把部分结果当完整快照 |
| `models.py` | 不可变 Source／Job／ScanResult、来源身份、内容 hash、发布时间语义 | 新 DTO 保留 provider、external ID、来源 URL、observed／first-seen／published 的区别 |
| `store.py`、`schema.sql` | PostgreSQL 来源与岗位、baseline 后 NEW／UPDATED／REOPENED／CLOSED 事件、worker advisory lock | 通过只读 repository 或增量事件 adapter 接入；消费游标由新服务持久化，不让聊天进程直接运行采集循环 |
| `scan_history.py`、`health.py` | 成功／失败／中断记录、provider 冷却与来源新鲜度 | 查询时展示数据日期与未知状态；配置轮询间隔不是实际发现时延 |
| `discovery.py`、`discovery_catalog.py`、`career_links.py`、`source_evidence.py` | 公司招聘入口候选、有限验证、精确 ATS 回链与来源证据 | 候选目录与审核过的公司身份分开；候选数量不是已覆盖公司的数量 |
| `jobboards.py`、`browser.py` | LinkedIn／Indeed 公共搜索解析与可选本地 Chromium 补救 | `coverage=discovery`，不能从搜索窗口缺失推断岗位关闭；遇封锁如实失败，不承诺全量或稳定可访问 |

源码 `store.py` 明确拒绝 incomplete scan 更新岗位状态，且只对 `coverage=full` 做缺失对账。README 说明 SmartRecruiters 当前仅保存列表摘要、没有详情正文；搜索来源没有跨平台归并。职位推荐、F1 适配判断、联系人和申请执行均未在该项目实现。10,000+ 公司是目标，不是已达成覆盖。

官方文档核对支持先走公开 ATS：Greenhouse 的 GET 无需认证，提交申请 POST 则需要 Job Board API key；读取岗位不能推导出我们拥有向任意公司提交的权限。[Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) 其他公开岗位接口有各自定义，需逐 adapter 保留其分页和字段语义。[Lever 官方 postings API](https://github.com/lever/postings-api)、[Ashby 官方 Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)、[SmartRecruiters 官方 Posting API](https://developers.smartrecruiters.com/docs/posting-api)

**不要把 job-radar 的 browser 当作平台安全执行器。**它使用独立 context、不加载个人 Chrome profile，也有 URL／资源域名与次数限制；但 `browser.py` 的 route 按域名和 resource type 放行，没有像当前平台 `executors.ts` 一样限制所有请求为 GET／HEAD并固定 DNS／socket 地址。扩展到任意 URL、私人会话或提交前，应重新接入现有执行边界，不能仅放宽它的域名表。

旧 `services/scraper` 可选择性参考确定性解析器、去重和挑战页面 fixture；它还依赖 Selenium、webdriver manager、多个商业抓取／模型 SDK、MongoDB 与旧 storage factory。其 `requirements.txt` 自带历史注释说明 Firecrawl pin 与 import 世代不一致，并与测试 requirements 分开。本轮未联网重新安装，因此只据源码判断：不适合整包成为新平台默认运行依赖。配置池、原始 HTML、临时模型响应、邮件发送和原生产连接不迁入。

## 学习系统：提取链路，重新接持久化

学习相关内容实际有两层，不只是一份课程列表。

1. **职业技能到项目推荐。**当前 `packages/contracts/src/learning-recommendation-v2.ts`、`learning-course-ranking.ts`、`gap-analysis-v2.ts`、`skill-library.ts` 已包含纯解析、精确 taxonomy 映射、按 gap severity／depth 排序、报告 revision 绑定与 uncovered gap。应优先用这些活跃模块及现有测试。
2. **完成项目与留下成果。**Argoland `src/learning/classroom` 有 authored milestones／microtasks、quiz／response／interactive、跨课 evidence references、tutor context、进度和成果；`learning-project-read.adapter.ts` 将用户已选择公开的项目成果投影成 highlights。这些模型适合“真实练习→反馈→作品／面试故事”的产品链路。

| 参考源码 | 提取价值 | 需要解耦的依赖 |
| --- | --- | --- |
| `imports/argoland/src/career-team/learning/learning-course-catalog.data.ts`、`learning-course-skill-map.data.ts`、`learning-course-copy.en-US.data.ts` | 版本化课程／项目 seed、技能关系和中英文文案 | 这是 code-owned 展示 catalog，不能据此声称某课程已发布、可报名或完整课堂可用；内容与公开权利需单独核对 |
| `learning-recommendation.service.ts`、`learning-course-catalog.store.ts` | stale report 拒绝、owned report 查询、catalog port | Nest DI、旧 planner/runtime／Prisma、旧 conversation 与 reservation 写入；不直接复制 service 到新 API |
| `imports/argoland/src/learning/classroom/classroom-pbl.ts`、`classroom-quiz.ts`、`classroom-response.ts`、`classroom-evidence-contract.ts` | PBL 定义、完成标准、证据身份与使用场景校验 | 表面为规则 helper，但仍带 Nest exceptions／zod 和互相依赖，应提成独立 schema＋稳定错误码再迁移 |
| `classroom-runtime.service.ts`、`classroom-evidence.service.ts`、`classroom-tutor.service.ts` | 进度／证据／辅导生命周期的行为和测试参考 | 旧 Prisma、S3、purchase entitlement、AiService／quota／Config；换成新身份、storage、model runtime 和学习 repository ports |
| `learning-project-definition.service.ts`、workbook／JSON／package import | 版本、发布和内容导入流程 | Prisma、audit、queue outbox与旧视频资产；第一版不必导入全部管理后台 |
| `learning-artifact-extraction.service.ts`、`learning-project-read.adapter.ts` | 有界成果摘要、明确提取状态、按 owner 发布项目 highlights | 旧 Prisma enum、ExcelJS／mammoth／pdf-parse、`ADDED_TO_VIBEID` 状态；沿用新 private artifact，不复制旧公开发布假设 |

**已有明确契约差异，须做窄适配。**旧 catalog 用 `canonicalRoleKeys`，活跃 `LearningCourseCatalogItem`／ranker 用 `roleKeys`；旧 service 使用 donor contracts 的 `buildLearningRecommendationForGapAnalysisV2`，活跃入口是 `buildLearningRecommendationV2`，报告字段也不能只按同名类型拼接。适配器应核对 role／skill taxonomy、catalog version和报告 revision，再调用活跃纯函数；未知技能保留 uncovered，不静默丢掉。

`imports/argoland/src/learning/learning.module.ts` 引用整个课堂、购买、通知、分析和 AI module；参考快照中也有未搬入的完整模块依赖。它不是可直接启动的学习服务。不要把“import 里有 module 文件”描述成新产品已拥有学习系统。

## 插件与 computer use 的能力分工

| 执行端 | 本地已存在的能力 | 不能从现状承诺的内容 | 手机边界 |
| --- | --- | --- | --- |
| 产品网页 `apps/web` | 对话、资料／成果引用、语音练习基础、任务草稿与审阅 | 无法直接操作用户另一个浏览器标签的 DOM或继承网站登录 | 适合准备、演练、查岗位、审阅与看进度；当前 localhost 预览并未因此变成可从手机公网访问的服务 |
| 电脑插件 `apps/extension` | 获授权页面观测、ATS 规则识别、确定性填写、readback、真实用户点击与站点策略核验 | 不是任意网站的通用截图 agent；当前新 application-service 未接完整登录／档案／租约／回执链，不能声称新产品已能真投递 | 现有 Chrome 包面向桌面；手机网页批准不能替代插件这一页的 trusted gesture |
| 本地服务器 Chromium `packages/ai-core/src/executors.ts` | 独立公共网页 GET／HEAD、网络隔离、最多 12 个显式审阅的 click／fill／select／scroll，额外 action flag＋持久 checkpoint＋当前授权 | 不继承用户本地登录，不登录、不解验证码、不写敏感资料或最终提交；已有动作后未知结果不能普通重试 | 手机可以作为任务控制界面，执行仍发生在服务器；本机运行时机器须在线 |
| job-radar 可选本地 browser | 公共搜索页只读采集补救，独立 context，确定性 Playwright | 没有通用 CUA、私人会话、申请任务权限或生产云调度；其网络策略不能照搬为通用执行器 | 没有手机执行包；采集服务是否在线与用户手机分开 |
| 未来云 browser | 当前代码没有独立的逐用户登录会话、凭据隔离和接管产品 | 不能把服务器 Chromium 叫作已经完成的云端代办；需另实现会话生命周期、用户接管、能力开关、结果与成本边界 | 可以让手机控制服务端浏览器，但需要服务实际部署可达与账户隔离；本轮未部署 |

Chrome content script 能在获得权限的页面读写 DOM，并通过 extension 消息与其他部分协作；这解释了插件为什么适合用户当前已登录的本地表单。[Chrome 官方 content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) MV3 worker 会闲置终止、内存变量会丢失，任务账本不能仅依赖插件内存队列。[Chrome 官方生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

Google 的手机安装说明是 “Add to Desktop”，最终在电脑启用；不能据此宣称现有 Chrome 插件在手机运行。[Chrome Web Store 官方安装说明](https://support.google.com/chrome_webstore/answer/2664769) iPhone Safari 有自己的扩展安装与权限体系；现有包尚未做 Safari 适配与分发验证。[Apple 官方 iPhone Safari 扩展说明](https://support.apple.com/en-ie/guide/iphone/iphab0432bf6/ios)

插件现有具体边界可核对 `apps/extension/lib/submitController.ts` 与 `packages/apply-kernel`：提交需要 shadow 内真实 gesture、当前页面／规则／policy 及 `submit-application` capability；内核不自行提交。旧源的签名／注册／登录例外与历史放行不继承到新产品；根 AGENTS 仍要求敏感字段、登录、验证码与最终提交由用户参与。`services/application-service/src/server.ts` 目前只挂 GET health／rules-release，health 明示 `executionEnabled:false`；纯 ES256 工具与公开规则摘要不是执行授权。

## 新架构中保留与舍弃的边界

建议保留三条独立数据链：

- **公共岗位目录：**采集来源→有 provenance／时间／覆盖语义的岗位版本→新平台只读查询／匹配。采集故障不会改掉用户学习或申请状态。
- **私人职业与学习：**用户确认资料→目标／技能 gap→版本化项目计划→练习证据／反馈→用户选择的求职材料。旧课堂状态通过 ports 重新接，不依赖购买才能完成基础练习。
- **申请执行：**材料和真实页面观测→具体审阅→执行许可／租约→插件或受限 browser→回执和未确认结果。对外发送、敏感答案和最终提交保留人工参与。

舍弃作为新运行依赖的部分：旧 Nest 全站模块树、Prisma 全库、VibeID 发布页、Stripe／subscription／entitlement、旧账号 handoff 与门户 JWT、旧生产域名／配置、Mongo／Supabase storage factory、邮件报告发送、部署脚本与共享长期 browser profile。保留必要算法、解析器、状态机与拒绝型测试，再通过新平台 ports 接入；不是删除源参考。

第一段可审阅实现边界是：新岗位 DTO＋离线 fixtures＋owned 职业资料／目标＋确定性 gap／项目推荐＋练习证据保存。首个端到端目标可设为“选一份岗位→理解要求→选一个训练项目→完成一个 microtask→把成果带回 Agent→生成用户可审阅的项目表述”。岗位 URL与原始正文作为来源材料，岗位里没有明确的信息保持未知。插件真实填表接入作为另一条执行里程碑，不能用前述文字闭环的成功替代它。

## 验证与尚未完成的证据

本轮验证了路径、源 manifest、Git remote／commit、PR 状态和关键源码；没有重新跑源仓套件或实抓。迁移文档中的历史能力与本轮源码结论如有差别，以当前源码和实际运行验证为准。后续最有价值的检查是：离线 collector 完整／部分／空／失败语义；catalog role／skill 适配与 stale revision；跨 owner evidence／artifact 拒绝；插件 trusted-click与未知写入结果；手机完整审阅与恢复。

公开仓库仍须先确认来源使用权：Argoland package 标记 `UNLICENSED`；job-radar 当前未找到 LICENSE 文件；私有仓库的访问权不自动等同于重新公开所有源码和课程／图像资产的权利。本轮不发布源码，也不改变原仓许可。

进一步来源记录见 [架构迁移](../architecture-migration.md)、[后端迁移审计](../backend-migration.md)、[执行方式研究](../automation-options-research.md)；这些是历史交接文档，本报告补充本轮实际定位与新求职域的提取边界。
