# 上线前的运行健康检查

2026-10-06：已实现分开的进程、数据和执行就绪检查，以及私有只读运维 CLI。独立环境中 API 431项：427通过／4跳过；网页399项全部通过，类型检查与构建通过。新增真实 PostgreSQL／Redis／HTTP 与 BullMQ 生命周期11组全部通过。真实 worker 的两条 Redis 连接明确断开后，已审批的虚构任务保留排队，恢复后只有1次 attempt／1次合成执行；这不是模型、实际CLI、worker-main进程关闭或生产监控验收。完整范围见[验证记录](verification.md#运行健康检查与worker心跳)。

本人主开发预览仍运行导出版本 `da4434a`，数据库账本为001–016。017–021 尚未进入主实例，本页新增接口和 worker 心跳已通过隔离验证，但未进入主实例。源码存在、模型质量、主实例已更新与生产上线是分别核对的事实。

## 分开表示三种状态

| 状态 | 应确认的事实 | 不应做的操作 |
| --- | --- | --- |
| 进程存活 | `/api/platform/live` 仅返回进程可响应的 `{ok:true}` | 查询数据库、模型或创建任务 |
| 数据服务就绪 | `/api/platform/ready` 检查有界数据库读取、当前发布所需迁移账本、表和关键列是否存在 | 自动迁移、修复数据或扩大连接池 |
| 任务执行可用 | `/api/platform/execution-ready` 额外检查独立 Redis 只读连接、全局暂停标记与相同队列／构建的近30秒 worker 报告 | 用空队列推断 worker 活着，或通过探针执行任务 |

`/ready` 与 `/execution-ready` 返回 `{ok,checkedAt,database,execution}`，数据状态为 `ready`／`unavailable`，执行状态为 `ready`／`degraded`／`disabled`／`unknown`，响应禁用缓存。`/ready` 的200只由数据就绪决定；worker 或 Redis 降级不令整个 API 失活。`/execution-ready` 仅在执行就绪时返回200，其他状态返回503。`/health` 保留原有 `ok`、`database: connected|unavailable` 与 `queue: configured|disabled` 字段，数据库检查改为同一有界数据检查；`queue: configured` 仍只表示启用了队列，不能作执行证据。

执行服务降级时，聊天、查看已有成果和保存人工核对记录可能仍可用。网页已接入简要执行状态和明确的只读刷新入口；不因 Redis 故障抹去 PostgreSQL 中已保存的审批或 outbox。数据就绪检查只核对迁移名称、关系与关键列存在，不证明所有约束、权限、数据内容或供应商配置正确。

公开状态只有固定简要状态与检查时间，没有跨租户计数、worker实例、队列名、构建标识或原始错误。当前账号模型没有管理员角色，未增加管理员诊断 HTTP 入口。详细诊断由私有运维 CLI 提供，不输出 SQL、提示词、用户标识、连接地址、凭据或正文。从已加载本人专用后端配置的进程环境运行 `./scripts/project.sh --filter @companion/platform-api operations`；输出只保存在私有运维位置，不进入公开源码或运行日志。CLI 不迁移、不恢复或派发任务，也不创建执行器。

## 队列证据

CLI 的积压统计连接当前任务版本：`j.status = 'queued' AND j.generation = o.generation`。历史 outbox、待批准任务和已经完成的任务不算待执行积压。当前输出未投递数量、已投递却仍排队数量及两类记录的最长创建年龄；Redis 只读列表／有序集合长度另行显示，不把二者当成相同业务状态。同一版本首次 attempt 开始时间减 outbox 创建时间尚未接入此次 CLI。

当前 dispatcher 会刷新 `dispatched_at`。这个时间不能证明 worker 存活，也不适合直接作为稳定的排队起点。新增 `platform_worker_heartbeats` 由 worker 每次结算后约10秒单飞写入，使用数据库时钟。执行就绪要求同一队列与构建标识、报告时间不在未来且距数据库现在不超过30秒、进程报告为 running、两条既有 Redis 连接都 ready、worker 本地运行且未本地暂停；独立探针还读取 `bull:<queue>:meta` 的全局暂停标记。全局暂停的空队列仍属执行降级。

新鲜心跳只证明进程近期报告这些状态，不能证明任务已经成功执行。构建标识是显式配置的部署元数据，生产拒绝缺失或 `development`／`unknown`；它不是源码摘要比对、发布成功或实例正在运行某份构建的独立证明。实际执行与故障恢复另用隔离合成任务验收。

过期执行／取消租约、未知结果种类、过期聊天流和语音租约的汇总及告警仍待接入。当前 readiness 采样单飞、结果缓存1秒，缓存使用单调时钟，`checkedAt` 使用墙钟。数据库借连接使用 pg 原生有限等待；借到连接后才启动操作 deadline，超时销毁自己的 socket、从池中丢弃该 client 并等实际关闭，迟到 callback 不能再查询。查询失败的回滚也受该期限限制，不销毁其他调用正在使用的连接。池的 idle 错误仅安全计数，不输出原始错误或杀死进程。

Redis 探针独占临时 `RedisConnection`，仅发送只读命令，不构造 BullMQ Queue、不读取现有 producer 的惰性 queue getter，也不写 meta 或执行 Lua。操作默认1500ms、自己的 disconnect 强制关闭等待默认100ms；返回前等待实际 socket `end`，成功路径也关闭该连接。合成 TCP 黑洞测试确认自有 socket 实际关闭；另用真实 Redis 和 worker 的自有 TCP 代理验证了两条 worker 连接明确断开及恢复，producer／probe仍连接正常的 Redis。该结果不覆盖静默网络停滞时客户端仍报告 ready 的情况。

## 连接预算

`Database` 已支持显式连接预算：`PLATFORM_DATABASE_POOL_MAX` 默认12、范围1–100；`PLATFORM_DATABASE_CONNECT_TIMEOUT_MS` 默认5000ms、范围100–5000ms。一个默认 API 与一个默认 worker 理论上可占24个连接；三个 API 与三个 worker 为72个，此外还有迁移、运维和其他服务。实际配置需明确：

`API 副本数 × API poolMax + worker 副本数 × worker poolMax + 迁移／运维保留量 ≤ 数据库可分配连接数`

共享 `withBoundedTransaction` 默认是最多5秒原生 checkout 等待，加借到连接后的2秒操作期限与清理；这不是整个检查严格2秒内返回的承诺。它用于此次探针与心跳，原有普通 `query`／`transaction` 没有因此全部获得总 deadline。CLI 新建 max1 的独立 pool，并标示 `poolScope: diagnostic_process`；它的 total／idle／waiting／idle-error计数不能代替运行中 API 或 worker 的池状态。worker 心跳报告自己进程的 pool 读数。当前每用户请求限额和聊天／语音租约也不是全平台数据库或推理容量限制。

探针 close 等待自己有界的在途检查与连接清理，心跳 stop 等待当前写入并尝试 stopping 报告。整个 worker 的关闭期限现已接通，见 [Worker 总退出期限](worker-shutdown.md)。应用默认 25 秒覆盖全部收尾阶段；仍需核对目标托管窗口，不能把应用定时器当作宿主级的硬终止保证。

## 独立验收

1. 空库、缺迁移、数据库拒绝连接：进程仍活，数据 readiness 失败且在期限内返回。
2. Redis 断连或 worker 停止：明确报告执行降级，合成任务的 PostgreSQL outbox 保留；恢复后只产生一次符合授权的 attempt。探针本身始终不派发任务。
3. 小连接池占满、数据库锁等待或网络停滞：采样单飞、排队有界，超时之后连接实际归还。

以上是验收目标。本轮已覆盖空库／缺迁移／关键列缺失、空队列全局暂停、真实worker本地暂停／恢复、heartbeat停止报告、两条worker Redis连接明确断开与恢复、实际PG连接池排队及SQL／锁超时，并直接观察受测服务器查询从active到消失。CLI与探针没有修改执行表或创建Redis meta。心跳计时及缓存到期在测试中加速，数据库时间与连接状态真实；任务runtime为合成实现，没有启动真实CLI或模型。

网页以真实API／PG验证了数据可查看、执行不可用与明确的只读刷新；桌面1280px与手机390px没有横向溢出，刷新按钮44×44px。完整日志与截图仅在忽略目录，初次预期拒绝被测试等待器错误上抛的失败记录保留，修正后全部回归通过。数据库整机断连／网络停滞、正式worker-main的SIGTERM与总关闭期限、真实HTTPS、备份恢复、并发负载和供应商质量仍须分别验收，不能由这些开发检查或生产构建通过推算。


## 2026-10-09：修复带数字表名的就绪检查

发现原迁移表名匹配式只接受小写字母与下划线，漏掉 050 中 7 张带 v2 的初见安全资源表。即使迁移账本完整，实际缺少 platform_onboarding_safety_v2_handled，公开 /ready 仍会返回 200。隔离真实 PostgreSQL 与 HTTP 已先复现这一错误。

匹配式现允许标识符首字符之后出现数字。新增回归把迁移得出的关系清单与真实迁移后 PostgreSQL 的全部普通表/分区表清单逐项比较，防止只校验某个已知表名。另一项测试在保留原迁移账本时临时改名 V2 表，确认 /ready 与 /health 返回 503，/live 仍为 200，公开响应不泄露表名或 schema；恢复表后新的只读探针重新可用。探针不会迁移、补表或修改账本。

17 项就绪检查通过，包括真实 PostgreSQL、Redis、HTTP、连接池与查询期限回归；平台类型检查通过。此修复没有新增迁移，也不证明所有列、约束、触发器、数据或生产供应商状态正确。没有改动主数据库、主预览或部署。
