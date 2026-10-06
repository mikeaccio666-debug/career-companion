# 申请自动化后端迁移审计

审计日期：2026-10-05。源仓：`edaix-official/argoland`，只读 `main` 快照 `013d5128bd474f98b78df8c9878e1321712b134b`。这是本地源码审计，不证明原站点或新产品的生产可用性。

## 旧仓怎样排列

浏览器扩展在独立的 `argoland-extension` 仓。Argoland 提供网站、登录、用户档案、任务、AI 草稿、规则发布、材料、执行许可及回执。后端没有一个可以单独拎走就启动的“小插件 API”。

| 位置（相对于 Argoland） | 用途 | 主要依赖 |
| --- | --- | --- |
| `src/auth/auth.controller.ts`、`auth.service.ts`、handoff DTO | 网站登录后创建一次性兑换码；扩展兑换独立会话 | 用户、会话、刷新令牌和安装绑定 |
| `src/extension/` | 宿主站点原有安装关联接口 | 宿主 JWT、Prisma |
| `src/career-team/extension/` | 申请执行域中的安装关联和 owner 状态核验 | 已验证账户、安装锁、owner/session 写入围栏 |
| `src/career-team/apply-rules/` | 12 家规则源、版本 manifest、路径映射及摘要 | 共享契约、规则解释器 |
| `src/career-team/apply-kernel/` | 后端用于证明规则能被解释的内核镜像 | 规则、契约；比扩展完整内核小 |
| `src/career-team/execution/` | 签发、claim、材料、租约、回执、过期、运行政策 | Mission、档案、简历、规范岗位、配额、用户、数据库 |
| `src/career-team/full-ai-autofill/` | 根据用户档案为页面字段生成计划/修改草稿 | 模型、Profile V2、答案记忆、配额计费；不返回可执行代码或任意点击 |
| `src/career-team/users/`、`profile/`、`profile-import/` | 档案编辑、自动填写快照、简历提取及确认 | 加密数据、Prisma、简历读取 port、模型 |
| `src/career-team/mission/`、`application/` | 审批、表单绑定、规范申请、材料版本、执行状态与提交边界 | 多表事务、数据库约束、规范岗位及 quota |
| `apps/web/lib/career/agent-channel/`、`extension-channel.ts` | 旧网站和扩展间的浏览器通道 | 扩展存在性、安装/账户确认、心跳、协议 |
| `apps/web/lib/auth/extension-auth.ts`、`app/extension-auth/complete/page.tsx` | 旧网站登录交接页面 | 一次性兑换、扩展标识、旧站点认证 |

其中前端桥接是网站适配器的参考，不能因新 UI 重新设计而把身份绑定和浏览器消息校验丢掉。

## 已保留的源码

`imports/argoland/` 包含 1,712 个源文件/参考文件，18,746,828 字节，包括 53 个历史 migration SQL。为了不漏掉业务能力，保留了完整安全 Career Team 求职域及其宿主依赖；新增产品运行时没有引入旧 Nest 主模块、Prisma schema、队列或 Stripe。

精确路径、原 SHA-256、字节数与 33 项省略理由记录在 `imports/argoland/migration-manifest.json`。没有选择真实 `.env`、credential 目录、Data-L1 导出、抓取/运行日志、报告证据数据库或截图；fixture 和历史 mentor corpus 保守省略。额外扫描只记录匹配的文件名和类别，不记录匹配值。保守命中不等于确认其中有真实密钥。

原代码、测试和说明是参考，缺失的 fixture 不用新用户资料补齐。不能把归档目录的 package/lockfile 当作新产品安装入口。

## 已抽出的独立模块

活跃服务是 `services/application-service/`。它只依赖新 workspace 中的共享契约、规则、内核和 Node 标准库；没有数据库、宿主 JWT、Stripe、Redis、S3、邮件或模型连接。

当前有两项可运行能力：

1. `GET /health` 返回独立本地服务状态，明确 `executionEnabled: false`。
2. `GET /api/v1/automation/rules-release` 用同一规则解释器严格校验已迁移规则的 schema、映射和摘要，再返回参考规则。它不发布可授权执行的 runtime bundle。

`src/security/` 提取七个纯模块：轮换公钥解析、规范 issuer origin、ES256 signer、严格 V1 verifier、执行摘要、档案字段注册表和 JCS。密钥只能由调用方显式注入，不从环境文件自动读取。签名类只是密码学 primitive，没有用户或任务授权能力；服务没有签发 HTTP 路由。

### 双仓契约确实存在漂移

父任务对两个最新 main 的同名契约做了比较：56 个文件有差异，其中部分只是 import 扩展名，部分改变实际协议。Argoland 后端已增加 `ExecutionIntentClaimsV3` 与 `applicationForm`；扩展当前共用契约仍是 V1/V2。档案工作授权快照也存在不同表示。

本次保持扩展现用契约为活跃单一来源，后端原版本留在快照。独立 verifier **仅支持 V1**，V2/V3及未知字段都拒绝，不用 cast 或忽略字段伪装兼容。没有实现 V2/V3 claim、材料或回执。

下一段迁移需要逐字段确定新契约，配合同一端到端测试升级服务与扩展。把两个契约目录机械覆盖，或者只把 API base 改成 localhost，都不能解决此问题。

## 必须重建的服务边界

建议申请领域服务拥有“本次要填什么、依据哪份资料、允许怎样执行、结果如何记录”。网站和浏览器扩展分别实现 UI 和浏览器 adapter；职业规划、networking 和练习随后可以共用职业档案与任务账本。

| 边界 | 应保留的语义 | 尚未在独立服务接入 |
| --- | --- | --- |
| 身份/安装 | 独立会话、一次性 handoff、owner 校验、rebind 后撤销旧 owner 权限 | 登录、会话、账户和安装持久化 |
| 用户档案 | 来源、用户确认、版本与删除 epoch；工作授权按明确记录使用 | Profile repository 与敏感数据加密 |
| 材料 | 审批时的简历/求职信版本与实际提供版本一致 | 材料 repository、PDF/文件读取 |
| 执行政策 | capability 天花板、网站/path allowlist、kill switch、有效期 | 可发布的政策及新产品配置 |
| 审批/许可 | 目标、页面扫描、字段、资料、材料、安装、用户与短期意图绑定 | Mission/approval repository、可信批准路径 |
| claim/租约 | 单次兑换、并发互斥、到期、撤销；claim 不等于无限执行 | 事务及唯一约束、租约 repository |
| 回执/账本 | 幂等结果、失败恢复、取消后仅允许记录；配额随事务一致 | 结果 repository、事务生命周期 |
| 模型 | 页面是非可信数据；不能编造经历；输出受结构限制，敏感字段需用户参与 | 模型 port、质量评估与独立使用配额 |

源实现的 ES256 意图最多有效 120 秒，claim 租约为 300 秒。签名证明内容没有被更改，但不能代替安装所有权、用户审批、资料 currentness、单次 claim 或租约校验。

## 架构中值得调整的地方

**复制式契约和内核镜像会让两端漂移。** 新 workspace 已把契约与内核放进共享 package。原后端较小的镜像保留作参考；活跃规则编译使用扩展同一内核。后续应继续拆小契约领域，而不是让规划聊天、付费、部署等所有类型永久共用一个大 index。

**申请许可被宿主产品绑得很深。** `ExecutionIntentModule` 跨 quota、Mission、规范岗位、档案、简历、遥测和数据库。新服务应明确这些 ports，再逐段迁移；不继承旧产品的订阅资格与产品开关。

**claim 事务成本较高。** 源码说明一次 claim 涉及约 70 个数据库语句；原有 5 秒默认事务曾超时，当前源码改为 10 秒。独立实现应以并发/重放/过期测试证明一致性，同时减少重复读取和锁占用。不能为了变快去掉 owner、审批、版本或租约检查。

**“规则能填”与“用户允许执行”需要明确分开。** 规则包中的厂商或控件仅描述技术能力。没有当前政策和本次授权，规则能被解释也不能写入页面。新只读接口刻意不叫旧 runtime-bundle 路径，避免被误用为授权替代。

**最终提交能力存在，但不是无人值守自动投递。** 源运行政策包含多页连续填写、继续下一步和用户点击后的最终提交；源码要求最终提交来自用户的那次可信点击并命中规则声明的唯一最终控件。手机端的一次审阅不能直接当作桌面扩展的可信点击。验证码、登录、无法确认的字段与敏感授权仍需用户参与。

## 验证与限制

本次验证目标是纯迁移 seam 和本地只读接口。新测试覆盖真实内存 EC 密钥签名/验签、错误主体/issuer/audience、过期/TTL、篡改、配置匹配、未知版本/字段、稳定摘要和 HTTP 执行路由不可用。规则发布调用真实共享解析器，不以 mock 返回值替代。

没有启动旧主模块、运行旧数据库 migration、调用付费模型、发送邮件或提交真实申请。没有证明新服务能够完成登录、用户档案、授权、claim、材料或回执的完整闭环；这些是接下来的实现工作。手机审阅到桌面执行的产品体验也尚未设计完成。

验证结果：`pnpm --filter @career/application-service check` 通过 TypeScript 检查；`pnpm --filter @career/application-service test` 的 12 项测试全部通过。另在 `/private/tmp` 的独立副本中把 verifier 改成错误地接受 V2 为 V1，版本拒绝测试按预期失败；活跃源码没有被修改。这证明新契约降级边界的测试可以捕获该回归。

参考快照的旧完整测试因 fixture/语料明确省略而不执行。以上结果不代表旧产品生产健康，也不代表新产品的端到端申请后端完成。
