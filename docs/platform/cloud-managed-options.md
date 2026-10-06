# 托管云方案比较：Vercel、Render 与 Google Cloud Run

核对日期：**2026-10-06**。状态：**研究与建议，未部署**。假设首批用户主要在美国，由小团队运营，先调用服务端模型 API，不自训模型、不购买 GPU。本文只写这份文档；没有注册云服务、读取私密账户、调用付费模型或修改运行进程。VM／AWS 的独立比较不在本文范围。

**我们的判断：近期以最少迁移工作交付可信第一版，Render 同源 Web＋独立 worker 更直接；重视独立前端预览与发布体验时，可以选择 Vercel 前端＋Render API／worker；已有 GCP 运维能力、希望统一 IAM／网络治理或逐步采用按需任务时，Cloud Run 是有力候选。** 依据是当前程序的进程和数据边界，不是“大用户只能用某一家云”。

## 先分清部署对象

网页的 CDN、聊天 API、持续消费队列的 worker、模型推理服务、私有数据库与文件存储，是不同部署对象。网页放在 Vercel 不意味着模型、任务消费者和所有数据都在 Vercel。托管平台自动扩容也不会自动处理应用的审批、幂等、租约、外部结果未知和恢复。

| 方案 | 网页／API | 后台任务 | 持久数据 | 对当前项目的迁移成本与适合场景（判断） |
| --- | --- | --- | --- | --- |
| Render 同源 | 一份 Web Service 服务 React build＋Fastify `/api/platform` | 独立 Background Worker，继续 BullMQ | 同区 Postgres／Key Value；私有 S3-compatible bucket | **最低**。当前 Cookie、相对 URL、SSE 与私有媒体保持一个 origin；适合先验证产品闭环 |
| Vercel＋Render | Vercel 服务 React 静态产物；Render 服务 Fastify | Render Background Worker | 同上 | **中等**。增加两个发布面和代理／跨 origin 验收；适合前端迭代频繁、希望独立 Preview／CDN 的团队 |
| Cloud Run，尽量保留现结构 | 同源 Cloud Run service，或独立前端＋service | worker pool 继续持续消费队列；有限一次性工作可设计为 jobs | Cloud SQL／Memorystore 或经验证的其它 PG／Redis；私有对象存储 | **中高**。容器可保留，但还需 IAM、VPC、CPU／缩容策略和生命周期适配；适合已有 GCP 能力的团队 |
| Vercel 应用＋Queues／Workflows | API／streaming Functions；Services 可组合不同语言后端 | 采用 Vercel 事件消费者、durable workflow 与 Sandbox | 外置／Marketplace 数据库、私有存储 | **较高的架构改造**。技术上可行，但当前 BullMQ 常驻消费者不能仅改 URL 就变成这套执行模式 |

## Vercel 的真实能力与边界

官方支持流式响应；Fluid Compute 当前 Functions 的 Hobby 最大 300 秒，Pro／Enterprise 通常最大 800 秒，符合 runtime 和逐 function 配置条件时可使用 **1,800 秒延长时长 Beta**。计时包含处理和发送流式响应。长流不是无限后台进程。[Streaming Functions](https://vercel.com/docs/functions/streaming-functions)、[Function limits](https://vercel.com/docs/functions/limitations)、[Duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)

`waitUntil`／Next.js `after` 可以在返回响应后继续任务，但仍受同一 function deadline 限制，超时会取消。Queues 当前是 Beta，提供 durable topics、重试和至少一次投递；Workflows 支持跨故障／部署恢复、等待外部事件和流式输出。它们证明 Vercel 可以承载 agent 与后台工作，但应用仍需处理重复投递与未知外部结果。[waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)、[Queues](https://vercel.com/docs/queues)、[Workflows](https://vercel.com/docs/workflows)

Vercel **Services Beta** 允许同一 project 组合前后端与内部 service binding；**Container Images Beta** 可运行 OCI 镜像。Services 仍受 Functions 的内存和 duration 限制。这不是 VM 上持续运行任意 daemon 的承诺，不能据此假设当前 executor 所需的嵌套 Docker daemon、宿主 bind mount 或长期模型驻留已经兼容。[Services](https://vercel.com/docs/services)、[Services limits](https://vercel.com/docs/services/pricing)、[Container Images](https://vercel.com/docs/functions/container-images)

如果只用 Vercel 服务网页，可以用 external rewrite 保留 `/api/platform` 同源入口。官方列出的 external origin proxy 等待上游响应超时是 **120 秒**；不能将它与 Function 的 800／1,800 秒混用。聊天应尽早输出 SSE 并验证真实代理持续 flush；耗时媒体任务应先返回 ID。Function request／response payload 上限 4.5MB 也要求大文件走合适的上传／读取路径，不能把当前 20MiB 音频上传机械搬进 Function。[External rewrites](https://vercel.com/docs/routing/rewrites)、[Proxy timeout](https://vercel.com/docs/limits)、[Payload limit](https://vercel.com/docs/functions/limitations)

**适合选 Vercel 的情况（判断）：** 前端预览、分支协作与 CDN 是重点；主要执行是模型 API 调用和有界 HTTP；愿意按托管 workflow／queue 语义设计后台。如果我们仍保留当前常驻 worker，把 Vercel 用在网页层即可，不需要因使用 Vercel而同时重写所有领域规则。

## Render 的真实能力与边界

Web Service 支持 Node／Python 等 runtime 或 Docker image；Background Worker 持续运行、通常拉取队列，不接收网络入站，官方明确列出 BullMQ。服务必须通过 `0.0.0.0` 监听平台提供的 `PORT`。这与当前 Fastify＋BullMQ 结构接近。[Web Services](https://render.com/docs/web-services)、[Background Workers](https://render.com/docs/background-workers)

Render 私网以 workspace 和 region 为边界；美国可选 Oregon、Ohio、Virginia，现有服务更换 region 要创建新服务／数据库并迁移。数据库、队列与 API／worker 应同区，CDN 并不能消除 API→数据库跨区延迟。[Regions](https://render.com/docs/regions)、[Private network](https://render.com/docs/private-network)

付费 Key Value 提供可选择的 persistence；队列应明确配置 `noeviction` 和 `Journal + Snapshot`。后者每秒落 journal，故障仍可能丢最近一秒，不能称 exactly-once；我们应保留 PG outbox 与执行幂等。Render Free Web 闲置 15 分钟会休眠、再起约一分钟，Free PG 30 天到期、Free KV 不持久化，不适合作为持续生产底座。[Key Value](https://render.com/docs/key-value)、[Free limits](https://render.com/docs/free)

滚动部署仍会结束旧进程：SIGTERM 后默认 30 秒、可配置最长 300 秒，之后 SIGKILL。有 persistent disk 的服务不具有通常的 zero-downtime deploy。进行中的任务必须由业务 checkpoint／lease／receipt 恢复，不能把“零停机部署”解释成任意模型请求绝不被中断。[Deploys and shutdown](https://render.com/docs/deploys)

**适合选 Render 的情况（判断）：** 小团队想保留常驻 API／worker、托管数据库与队列，减少 IAM／网络产品组合工作。代价是空闲常驻资源仍付费、扩容受到 plan 条件和数据库连接预算约束；普通 Docker service 也没有承诺提供我们现在的宿主 Docker executor。

## Cloud Run：service、job、worker pool 应分别选择

| 资源 | 官方能力 | 本项目用途与必要条件 |
| --- | --- | --- |
| Service | HTTP endpoint；自动／手动扩容，可缩到零；请求默认 300 秒、最长 3,600 秒 | Fastify／SSE。缩到零带来冷启动；请求超时并不保证代码立即停止，取消与租约仍由应用控制 |
| Job | 有限任务执行后退出；每 task 默认 10 分钟，非 GPU 可到 168 小时 | 迁移／一次性媒体处理候选；当前持续 BullMQ worker 不能直接用 job 模式，需要有限工作入口、触发和回执适配 |
| Worker pool | 持续非 HTTP／pull 工作；2026-04-14 **GA**；没有 load-balanced URL | 较贴合现有 BullMQ 消费者。默认不自动扩容，需手动实例数；至少一实例才会消费 |

[Service timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)、[Job task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)、[Worker pool deployment](https://docs.cloud.google.com/run/docs/deploy-worker-pools)、[GA release note](https://docs.cloud.google.com/run/docs/release-notes)

Google 的最新 overview 另列 **CREMA external autoscaler**，根据 Kafka lag／PubSub backlog／Prometheus 等外部指标调整 worker 数。这是额外系统，不代表把当前 Redis URL 填进去就获得基于 BullMQ lag 的自动扩容。resource-model 比较表部分描述较宽，但其 worker-pool 正文和专门部署页均说明没有默认自动扩容；本文按明确的专门文档记录。[Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)、[Resource model](https://docs.cloud.google.com/run/docs/resource-model)

Cloud Run service 的 request-based billing 在请求外的 CPU 可用性有限；instance-based billing 可分配持续 CPU。**当前 API 自身还有每秒 outbox dispatch 与每 30 秒 stream recovery timer**，因此不能不改程序就让 API 缩到零并期待这些工作继续推进。可把相关循环移到常驻 worker，或 API 配置 min=1＋instance-based，并验证旧／新 revision 同时运行的幂等。[Billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)

容器需 Linux `amd64`、HTTP ingress 监听 `0.0.0.0:$PORT`；文件系统不持久，写入可能消耗内存；服务终止有 10 秒 SIGTERM 窗口。PG、队列、文件与业务 checkpoint 必须外置。Cloud SQL／Memorystore／Cloud Storage 是可组合产品，不是包含在 Cloud Run 计算账单中的自动数据库。[Container contract](https://docs.cloud.google.com/run/docs/container-contract)

**适合选 Cloud Run 的情况（判断）：** 团队可以运营 service accounts、IAM、VPC、镜像和预算告警；想统一 GCP 服务或逐步把有界任务改成按需执行。它能承载规模化 AI 产品，但对当前只有少量用户的项目，数据库、队列与工程时间可能比 HTTP compute 更影响总成本。

## 费用：按资源计算，暂不按“用户数”保证容量

单位 USD／月；核对日期同上；按 **30 天＝720 小时**。不扣开户赠金／试用／免费额度，不用承诺折扣，不含税、域名、模型调用、额外流量、private media bucket、备份超额和独立 browser／CLI／TTS／ASR 资源。资源只是预算例，不是经过压测的容量保证。

### Render 与 Vercel＋Render

Render 当前公开价：Web／worker `0.5c-512mb` $7、`1c-2g` $25；PG `0.1c-256mb` $6、`0.5c-1g` $19；KV `256mb` $10；PG storage $0.30/GB/month。Workspace Hobby $0＋compute，Pro $25＋compute，Pro 的团队／扩容功能不能当免费。官方价格页的自动文本提取遗漏了表格，本轮另读取其公开 HTML 实际表格核对。[Render pricing](https://render.com/pricing)、[Current compute plan IDs](https://render.com/docs/compute-plans)

| 具体配置 | Render 同源资源小计 | 加 Vercel 前端后的资源小计 |
| --- | --- | --- |
| 单人低流量预算下界：API $7＋worker $7＋PG $6＋KV $10＋PG 1GB $0.30；Render Hobby workspace | **$30.30** | **$50.30**，假设一个 Vercel Pro deploying seat |
| 更宽松普通 API／worker 起步：各 `1c-2g` $25；PG 1GB RAM $19＋10GB storage $3；KV $10；Render Pro workspace $25 | **$107** | **$127**，仍只有一个 Vercel deploying seat |

512MB worker 不能当作 Chromium 或模型推理的可靠规格；最低表只覆盖轻量 API 调用与普通队列工作。PG磁盘允许1GB或5的倍数，Basic默认15GB并非最低15GB；团队若需要 Render Pro，把第一行也加 $25。[PG磁盘规则](https://render.com/docs/blueprint-spec#disksizegb)

Vercel Pro 当前 $20/month platform fee，含一个 deploying seat 和 $20 usage credit，额外 deploying seat $20；用量超额另付。表中 credit 没有被再减一次，React 网页并不要求迁成 Next.js。Hobby限非商业个人用途，因此创业产品按Pro做预算。[Vercel Pro](https://vercel.com/docs/plans/pro-plan)、[Hobby用途限制](https://vercel.com/docs/plans/hobby)

### Cloud Run 两条预算路径

以 Iowa `us-central1` 公开 on-demand 单价说明计算：request-based service 活跃 CPU $0.000024/vCPU-second、RAM $0.0000025/GiB-second、请求 $0.40/million；instance-based service CPU $0.000018、RAM $0.000002；worker pool CPU $0.000011244、RAM $0.000001235。这些是不同资源 SKU，不混用。[Cloud Run pricing](https://cloud.google.com/run/pricing)

| 资源假设 | 不扣免费额度的算术估算 |
| --- | --- |
| 常驻 worker pool 1vCPU／2GiB／720h | `(0.000011244 + 2×0.000001235) × 2,592,000`＝**$35.55** |
| 保留 API 当前后台 timer：service min=1、instance-based 1vCPU／1GiB／720h | `(0.000018 + 0.000002) × 2,592,000`＝**$51.84** |
| 将 timer 移出 API 后，request-based service 1vCPU／1GiB、10,000 请求、共 100,000 billed instance-seconds（每请求平均10秒、按无并发共享计） | `100,000×(0.000024+0.0000025)+10,000/1,000,000×0.40`＝**$2.65**；实际 billed instance time 随并发、启动和流长变化 |
| Memorystore Redis Basic 1GiB／720h，按 Iowa $0.049/GiB-hour | **$35.28**；单实例非 HA，不是持久队列安全配置已经验收 |
| Cloud SQL 预算公式：Enterprise 单区 1vCPU＋4GiB／720h＋10GB SSD，按官方起价 $0.0413/vCPU-hour、$0.007/GiB-hour、$0.17/GB-month | 约 **$51.60**；是起价算术例，最终区域／可选机型／HA／备份／网络需 pricing calculator 核对，不宣称已选可购买 SKU |

[Memorystore pricing](https://cloud.google.com/memorystore/docs/redis/pricing)、[Cloud SQL published starting rates](https://cloud.google.com/sql)、[Cloud SQL full pricing](https://cloud.google.com/sql/pricing)

据上述同一组假设，保留当前 timer 路径约 **$174.27**，改为低流量按需 API 后约 **$125.08**，均只是四项资源的示例小计。不是“Cloud Run 最少要这个价格”，也不是完整产品账单；选择其它 PG／队列、按需 job 或配置会改变结构和价格。较低的共享 CPU Cloud SQL 不应与生产 SLA 混为一谈。API 很便宜并不意味着平台整体免费。

## 已有产品怎么组合基础设施：可证案例

| 官方材料 | 公开事实 | 能推导什么／不能推导什么 |
| --- | --- | --- |
| **OpenEvidence**，Vercel 客户访谈，2026-02-25 | Next.js frontend 部署 Vercel；Python backend 在 **Google Cloud Platform**，负责 ingestion／model orchestration／business logic。文章称 January 2026 >20M clinical consultations | 混合部署是成熟 AI 产品的实际选择。GCP backend **没有在该文指明 Cloud Run**；consultations 是供应商访谈口径，不是同时在线／独立审计用户数，也不证明我们的容量 |
| **v0**，Vercel 官方 2026-02-03 与 2026-08-05 | 前文称自 GA 起 >4M people have used（累计口径）；后文明确每个 chat 是隔离 workspace，agent 在 **Vercel Sandbox** 读／改／运行文件与 dev server、流式输出并提供 preview，支持 async／poll／webhook | 大用户 agent 可把交互、执行沙箱与发布流程分成组件。材料没有披露所有数据库／队列／调度内部，不据此画出完整私有 stack |

[OpenEvidence official case](https://vercel.com/customers/how-openevidence-built-a-healthcare-ai-that-physicians-can-trust)、[v0 user-count source](https://vercel.com/blog/introducing-the-new-v0)、[v0 API／Sandbox source](https://vercel.com/blog/introducing-the-new-v0-api)

Lovable 生成的 app 可部署 Vercel、Cursor 可使用 Vercel MCP，是集成能力，**不能证明 Lovable／Cursor 自己的平台部署结构**。本文不从 logo、模型清单、DNS 或用户数推测 Higgsfield 的内部架构。

## 对本仓的具体迁移与验收缺口

本轮只读源码看到：已有 `infra/platform/production/Dockerfile` 和可审阅 Render Blueprint 示例；`static-web.ts` 已可在 `PLATFORM_WEB_STATIC_DIR` 配置下服务 React build，并隔离 API／SPA fallback；`config.ts` 已支持显式生产 host／PORT、HTTPS origin、私有 S3 配置。它们是上线基础，**没有替代真实云环境验收**。更完整的当前迁移计划见 [deployment-plan.md](deployment-plan.md)。

| 范围 | 代码证据／当前状态 | 部署前还要证明什么 |
| --- | --- | --- |
| Vercel＋Render 接口 | 已支持 `VITE_PLATFORM_API_ORIGIN`、统一API／私人媒体URL与credentialed CORS；合法预检不认证／执行业务，原mutation Origin检查保留；实际浏览器两个同站loopback端口通过登录、Ollama SSE及私人图片／视频 | 同站HTTPS自有子域与Secure Cookie仍需验收；external proxy路线需另测。无关vercel.app／onrender.com站点间的第三方cookie不在本轮保证内 |
| Cookie 与私有响应 | `auth.ts` 为 HttpOnly、SameSite=Lax、production Secure；mutations 检查 exact Origin | HTTPS 注册／登录／退出／过期／跨 owner；proxy Set-Cookie、multipart、SSE 与 Range 保真；private API 禁共享缓存。外部 rewrite 新项目会尊重上游缓存头，不能盲配缓存 |
| 当前 API 后台循环 | `TaskQueue.start()` 一秒 dispatch；`app.ts` 30秒 stream recovery | Cloud Run 缩到零前迁移／替换这些循环，或明确持续 CPU；Render／Cloud Run revision 重叠时仍防双 dispatch |
| 恢复与暂停 | 任务／审批／lease／checkpoint 已有领域边界 | 暂停先停止接新任务和发外部请求，保存回执，再停止进程；恢复重新验 lease／approval，completed 不重放，unknown 无 handle 继续审阅 hold。暂停 compute 不等于删除数据库／对象，也不等于这些资源停止计费 |
| 私有数据 | PG／Redis ports 与 S3BlobStorage；生产配置要求 private S3-compatible | 目标 PG／队列版本与重连、连接池总上限、outbox backlog；实际 bucket PUT／Range／IfMatch／两 owner 404／断连；GCS 原生 API 不是现有 S3 adapter 的直接替换 |
| 模型与语音 | 密钥在后端；商业 gate 默认关闭；本地 TTS／ASR literal loopback、离线资产 | 实际 provider 小额受控验收须另授权；本轮零付费。Linux 依赖／CPU／真实虚构音频与取消要在目标环境验证；不能把 loopback URL 改成私网 hostname 就宣称兼容 |
| 浏览器与 CLI | 现 runner 依赖 Chromium／OS 及独立 Docker daemon／workspace mount | 普通云 Docker image 托管不等于嵌套 daemon。先关闭未验执行端，之后经专用 executor／受控沙箱 adapter 接回身份、审批、租约、预算和 private receipts |
| 可观测与发布 | health／safe errors／DB receipt 已有，生产 trace 尚需运营配置 | error rate、首 token／p95、outbox age、queue lag、worker lease、DB pool、storage errors、provider spend 告警；日志不含简历／prompt／音频文字／key／原图；备份恢复、回滚和版本兼容演练 |

Render 提供 CPU／RAM／连接等 service metrics，部分 HTTP percentile 功能与 retention 取决于 workspace plan；Cloud Run 提供 Cloud Logging／Monitoring，可另外配置业务指标。基础图表都不能自动发现“模型已经收费但任务未知”或“outbox 卡住”，这些需我们的业务告警。[Render metrics](https://render.com/docs/service-metrics)、[Cloud Run logging](https://docs.cloud.google.com/run/docs/logging)、[Cloud Run monitoring](https://docs.cloud.google.com/run/docs/monitoring)

## 选择依据与下一步

**事实：** 三个生态都支持生产 AI 应用，Vercel 当前也有 streaming、后台、durable workflow、container 和 sandbox 能力；官方 OpenEvidence 案例明确采用 Vercel frontend＋GCP backend。**判断：** 这支持按组件选择平台，不支持断言某家公司拥有多少用户就必须使用某种云。

近期若优先求职产品首个真实闭环，我会先选 Render 同源普通 API／worker，并按实测选资源；Vercel＋Render 是有价值的独立前端路径，而不是必须先付出的复杂度。Cloud Run 可做后续或已有 GCP 团队的首选，尤其在明确哪些循环常驻、哪些任务可按需执行之后。最终资源选型须与用户预算、峰值并发、媒体存储／传输和是否启用执行端一起确认；本报告未作部署承诺。

本次验证仅包含官方网页／公开价格 HTML、源码与费用算术。未运行云压力测试、未宣称 Linux 模型或真实 AWS／GCP 质量已验收。现有 localhost 验证记录见 [verification.md](verification.md)。
