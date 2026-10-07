# 09 从现有代码到愿景：实施路线

> 2026-10-07（按 10-07 决定：主线、转发卡、单聊）· 写给 Codex（实现者）和产品负责人（排期与拍板）。
>
> 代码基线：`main` 的 `1c26b3a`（含 `97194b4` MCP 接入、`da4434a` 任务与来源对话绑定）；对话引擎的现状按 `e1ba2a4` 核对（15 §12）。代码位置写「文件 + 函数名或路由」，不写行号。
>
> 每个主题以负责文档为准：分期 07；主理人 agent、能力层、流式与丝滑标准 15；数据对象、状态机、专家 key、房间与谁接话、记忆与敏感度、外部数据来源 03；视觉与文案 08；渠道 10；付费 06；蔓藤资产 04；插件 11；声线 12；主理人、危机、主动规则 02。本文只写哪一步、改哪里、怎样算做完。

## 这份文档回答什么问题

- 从「通用 AI 网页工作台 + 未接通的投递插件」走到「全能主理人 agent + 队员的转发卡与单聊 + 五个界面 + 求职数据」，代码按什么顺序改；每步改哪里、建什么、怎样算做完。
- 哪些现有代码冻结；工程上先立哪些规矩。

**结论**
1. P0 = 第 0–8 步、第 8B 步，加 10A（做完不发布）。关键路径 0 → 1 → 2 → 3A/3B → 5 → 4，可后移项见 §1.6。
2. 第 1 步（主理人 Agent 与对话引擎）是主线与单聊、主动消息、Discord、语音的共同前提；PR1 必须零行为变化，PR3 前做一次小规模真实模型测试（需产品负责人批准预算）。
3. 不随工期削减：危机模板不依赖模型、身份数字只来自审核过的配置（第 2 步）；要发给别人的消息和材料先进待确认（第 5 步）；付费建议护栏（第 8B 步）。
4. 外部数据只经第 3D 步（复用 MCP，03 §2.8），不在关键路径上；插件授权在投的单聊里一次问清、确认卡生效，浮层不提问（第 10 步）。
5. 最大风险：P0 七周的工程量；蔓藤授权卡住 3C 和题库；律师审核卡住插件发布。本文只给相对规模假设，不给工期。

---

## 1. 总体做法

### 1.1 施工原则

1. **地基不推倒。** 账号、审批的输入哈希绑定、outbox 与租约、worker、私有文件与资料库、语音底座、career-core 规则直接复用；加列、加表、加服务。
2. **先抽服务层，再加渠道。** 任何渠道都不自己拼提示词、不直接调模型。
3. **服务端说了算。** 人格、发言者、模型、声线、工具白名单、敏感度过滤由服务端决定；对应步骤完成后，学生端提交 `persona`、`provider`、`model`、`voice`、`instructions` 返回 400。
4. **每步可单独合并、单独回退；开工前先 rebase 到最新 `main`，复核本步引用的文件。** 未完成的能力用 `PLATFORM_FEATURE_*`（`src/config.ts`）隐藏，经 `GET /features` 下发；全员打开后删掉开关。危机流程不受任何开关影响。
5. **迁移只追加**，用 `IF NOT EXISTS` 和可重复的 `ALTER`，每个迁移配起真 PostgreSQL 的集成测试。
6. **不调用付费模型、不提交真实申请、不部署**，除非写明「需产品负责人批准」。测试用虚构资料和假 runtime（`buildApp({runtime})`）。

### 1.2 步骤总表

规模是假设：S 单模块；M 两三个模块加一个迁移；L 前后端都动；XL 新子系统。W3 按第 0、1 步实际耗时校准（07 第 2 节）。

| 步 | 名称 | 分期（07） | 依赖 | 规模 |
|---|---|---|---|---|
| 0 | 收拢定位 | P0 · W0；P0-4 隐藏部分 | — | S |
| 1 | 主理人 Agent 与对话引擎 | P0-3 | 0 | XL |
| 2 | 主理人、安全分级、身份事实、第一封信 | P0-1、P0-2、P0-5 后端 | 1 | L |
| 3 | 求职数据、共享记忆、组织库切片 | P0-9、P0-8、P0-11 | 1；3C 只依赖 026 | 3 × M |
| 3D | 外部数据来源（复用 MCP） | B2 补齐集；`org` 来源 P1b | 1、3A；记账接 8 | M + M |
| 4 | 五个界面与对话 UI | P0-4、P0-5（前端） | 外壳只依赖 0 | XL |
| 5 | 对外发出类待确认 | P0-7 | 1、3A | M |
| 6 | 今天：调度、通知、额度、保留期 | P0-6 | 1、2、3A；8 前接 `CostGuard` 桩 | L |
| 7 | 面试官最小版 | P0-10 | 1、2、3C | L |
| 8 | 真实模型评测与费用上限 | P0-13 | 1 | M + 人工评审 |
| 8B | 上线底座、真人入口、付费护栏 | P0-14、P0-12、P0-2 付费部分 | 0；护栏接入要 2 | M |
| 9 | Discord 私信机器人 | P1a · P1-2 | 1、2、6 | L |
| 9B | 身份时钟提醒 | P1a · P1-3 | 2、3A、6 | S |
| 9C | 被拒之后的信与复盘 | P1a · P1-5 | 3A、6、9D | S |
| 9D | 面经与作战简报 | P1a · P1-4 | 3C、6、7 | M |
| 10 | 插件对话授权与后端接通 | 10A：P0 期间做完不发布；其余 P1a · P1-1 | 10A 无；其余 3A、5、8B | XL |
| 11 | 声线接入 | P1b · P1-11、P1-12；开源 PoC 与 P0 并行 | 2、7、8 | L |

### 1.3 依赖关系

```
0 ─> 1 ─┬─> 2 ─┬─> 6 ─┬─> 9
        │      │      └─> 9B
        │      └─> 7 ─┬─> 9D ─> 9C
        │             └─> 11
        ├─> 3A / 3B ─> 5 ─> 10B–10E
        ├─> 3A ─> 3D（P1b 的 org 来源另要 3C）
        ├─> 8 ─> 6（之前接永远返回 ok 的 CostGuard 桩）、11
        └─> 4（外壳和 token 在 0 之后即可开工；前端可先接假接口）
0 ─> 8B（026 自带组织与员工角色表）─> 3C、10B
3C 可与 1 并行；7 依赖 3C 的题库；10A 不依赖任何步骤；3D 不在关键路径上
```

### 1.4 迁移编号

`Database.migrate()` 按文件名排序执行、按文件名记账，所以**编号顺序必须等于依赖顺序**：后合并的迁移如果依赖还没建的表，取下一个空号；已用的号不复用。015、016 已被 `015_mcp_connections.sql`、`016_conversation_tasks.sql` 占用，下表从 017 起。新文件用下划线；9B 起从 030 取号。

| 编号 | 文件 | 步 | 说明 |
|---|---|---|---|
| 017 | `017_conversation_rooms.sql` | 1 | 03 §6：房间、消息加列、轮次、队员运行记录、事件；记账键与 `agent` 任务也在这里（§3）；不建参与者表；`companion_id` 外键在 018 补 |
| 018 | `018_companions.sql` | 2 | 02 §15.2；安全资源、身份事实配置 |
| 019 | `019_memories_v2.sql` | 3B | 03 §8.2 |
| 020 | `020_career_data.sql` | 3A | `packet_id` 外键在 022 补 |
| 021 | `021_org_knowledge.sql` | 3C | 依赖 026，026 须先合并，否则 021 改取空号 |
| 022 | `022_pending_items.sql` | 5 | 03 §9.2 |
| 023 | `023_schedules_notifications.sql` | 6 | 02 §9.2、10 §9 |
| 024 | `024_practice_sessions.sql` | 7 | 05 §3.4 |
| 025 | `025_cost_guard.sql` | 8 | 06 §12.4 |
| 026 | `026_launch_basics.sql` | 8B | |
| 027 | `027_external_identities.sql` | 9 | 10 §9 |
| 028 | `028_extension_apply.sql` | 10 | 03 §10、11 §6.1 |
| 029 | `029_voice_presets.sql` | 11 | 12 §5 |
| 合并时的空号 | `mcp_standing_grants` | 3D | 03 §2.8；回执改主键与加列（3D 第 6 条） |

### 1.5 命名、鉴权与事件

- **表**：`platform_` 前缀；求职数据 `platform_career_`；组织库 `platform_org_`。
- **鉴权**：所有学生路由挂 `secure` 或 `secured(scope)`，都要求 `x-companion-account` 头（`src/account-context.ts`）。网页请求经 `api.ts` 的 `BoundPlatformClient` 和 `PlatformAccountClientProvider`；媒体与下载用 `expectedAccount` 查询参数；`ACCOUNT_CONTEXT_*` 错误在前端统一转到「确认账号」页。员工路由 `staffOnly` 叠加在 `secure` 上。唯一例外是插件的 `/api/platform/ext/*`（10B）。
- **队员键**：只用 03 §6.9 的 `EXPERT_KEYS = ['planner','guide','coach','interviewer','networker','applier']`，只在 `platform-contracts` 定义一次，显示名映射也在那里（`guide → 前辈 / 前`，其余见 03 §1.1）。P0 只开放主理人、`guide`、`applier`、`interviewer`，由 `PLATFORM_TEAM_ENABLED` 控制。
- **事件**：SSE 以 15 §8.1（03 §6.6）、事件日志以 03 §6.7、埋点名以 07 §7.5 白名单为准；下文只列各步要接入的名字。

### 1.6 P0 关键路径与可后移项

关键路径：**0 → 1（PR1–4）→ 2 → 3A / 3B → 5 → 4（对话、今天、待确认）**；顺延规则见 07 第 2 节。下列工程项可后移到 B2，不影响 07 §3.16 的发布闸门：

| 可后移项 | P0 替代 | 最晚 |
|---|---|---|
| 1-PR5 订阅流 | 网页轮询 `GET /conversations/:id/messages?after=`，有轮次或任务在跑时每 3 秒（假设，15 §8.2） | B0（订阅流是 P0 必需） |
| 1-PR6 后台任务 | 长任务在前台跑到墙钟上限，如实说做到哪了，用户再发一句接着做 | B1（P0-3 含后台任务，07 §3.3；07 §3.16 闸门含 15 §14 的后台任务条目） |
| 删除单条消息 | 删会话、删记忆照常可用 | B2 |
| 服务端 diff | 先展示新版本全文；「原稿里没有的事实」标记不能后移 | B2 |
| 知识访问日志查询界面 | 日志照写，用 SQL 查 | P1-9 |
| 公开职位链接读取（3D） | 用户粘贴 JD | B2 补齐集第一项，最晚 P1a |

---

## 2. 第 0 步 收拢定位

**目标**：学生看不到工具箱、模型和供应商。从这步起所有改动走 PR（第 17 节）。

| 位置 | 改动 |
|---|---|
| `README.md` 开头 | 改为产品定位，指向 `docs/product/`；工作台能力移到「底座能力（内部）」；「先训练本人的声音」改为「按 12 §6.2：不用作产品声线」 |
| `docs/product-brief.md`、`docs/career/*.md`、`docs/platform/personal-voice-recording.md` | 开头注明已被 docs/product/ 取代；保留「不做签证判断、交给 DSO」 |
| 品牌：`index.html`、`manifest.webmanifest`、`ui.tsx` 的 `Brand`（小写 `openfield` 与 `/mark.svg`）、`AuthView.tsx`、`App.tsx` 署名、`apps/web/README.md`、`vite.config.ts` 插件名 `openfield-pwa-build-root` | 去掉 Openfield；产品名集中到 `apps/web/src/brand.ts`，先用工作名「Career Companion」；`/mark.svg` 换中性占位 |
| `pwa-build.ts` 的 `cacheId: 'openfield'` | 改成不含产品名的中性名（如 `companion`）；`pwa-legacy-cleanup.js` 按确切旧名（`openfield-shell-v1`、`openfield-precache-v2-<scope>`）清理，仍只在没有同源窗口时删 |
| `App.tsx` 的 `navigation`、`personas` | 学生只看到「对话」「我的资料库」「设置」；人格选择器隐藏（第 2 步删除） |
| `ProviderSelect`、模型名输入框、`SettingsPanel.tsx` 服务卡片与 `McpConnectionsPanel`、`navigation` 的 `mcp`（外部工具）、`ConversationTasksPanel` 的审批与「带回草稿」、语音页的供应商/模型/声线下拉框 | 学生环境不渲染 |
| `GET /capabilities` | 现在匿名可访问，返回 `envVariables`、`documentationUrl`。改为只返回能力是否可用；明细只在 `PLATFORM_EXPOSE_PROVIDER_DETAILS=1` 的开发环境返回 |
| 发消息要求传 `provider`、`model` | 新建 `src/model-routing.ts` 由服务端选择；开发环境保留管理员覆盖 |
| `jobs.ts` 的 `create` | `PLATFORM_ENABLE_WORKBENCH`（生产默认 0）为 0 时，`POST /jobs` 和 `POST /mcp/tasks` 拒绝学生的所有 `browser`、`cli`、`workflow`、`image`、`video`、`mcp` 任务，403 `WORKBENCH_DISABLED`；8B 后改为只给员工 |

P0 不做 `read_job_posting`。B2 的公开链接读取走第 3D 步的第一方岗位源，不经过 `POST /jobs`，学生端不出现审批（03 §2.8）。新建 `GET /features`。后端代码、测试、工作流引擎全部保留。

**验收**
- [ ] `rg -i openfield apps/web`（排除测试夹具和清理脚本里的旧缓存名）无结果；搜不到 `THINKING PARTNER`。
- [ ] 学生环境的页面和非开发环境的接口响应里没有供应商名、模型名、环境变量名、声线 ID（自动化检查）。
- [ ] 开关为 0 时建 `cli`、`browser` 或 `mcp` 任务返回 403；为 1 时现有工作台测试通过。
- [ ] 不传 `provider`、`model` 也能发消息并收到流式回复。

---

## 3. 第 1 步 主理人 Agent 与对话引擎

**目标**：把发消息路由（`app.ts` 的 `POST /conversations/:id/messages`）里的历史、记忆、工具、流式落库、租约、心跳、记账抽成渠道无关的轮次服务；把 `chat.ts` 的工具循环改成主理人和队员共用的 agent 循环；建房间（主线、单聊、面试间）、转发卡、叫名字和后台任务。规格：引擎 15（落地顺序 15 §12.3），房间、谁接话与消息模型 03 §4、§6、§7。

**改动范围**
- `src/conversation-turns.ts`：`ConversationTurns`（`submit`、`cancel`、`post`）。顺序按 15 §3.1：落库并开始**同步安全分级**（第 2 步实现，本步留接口）→ 纯规则：房间已有轮次就是插话（只分级，返回 202，不发模型调用），否则定谁接 → 建轮次、取租约、`CostGuard.reserve`（第 8 步前是桩）→ 组装上下文 → 第一次模型调用（分级返回 L0 前不放出文字和进度短语、不执行工具）→ agent 循环。分级对每条用户消息执行，含插话、Discord 消息和并进 `queued` 轮次的消息。
- `packages/ai-core/src/agent-loop.ts` 的 `runAgentLoop`；`streamOpenAI`、`streamCompatible` 改为 `streamModelStep` 的两个实现，循环经包装 `runtime.streamModelStep` 的 `ProviderAdapter` 调用（15 §3.1、§12.2）。
- `src/capabilities.ts`（`toolsFor`、`executorFor`）取代 `safeTools` 和 `executeTool` 的 if 链，纯数据目录与权限矩阵放 `packages/career-core/src/capabilities.ts`（15 §4.7）；`use_skill` 与 `src/career-run-context.ts`（15 §4.1、03 §3.4），求职工具随 019、020、022 接入。
- `src/expert-runner.ts` 的 `runExpert`：`consult`、叫名字、回复卡、卡上按钮共用（15 §5.1）；纯规则放 `packages/career-core/src/team/`（`members.ts`、`name-call.ts` 的 `detectNameCall`、`handoff.ts` 的 `buildHandoffNote`、`personas.ts`）。
- `src/agent-run.ts`：后台任务（15 §4.6）。`src/context-assembly.ts` 先按 15 §6.1 的层次搭骨架，各层内容随第 2 步补。
- `SseTurnSink`（搬走路由里的响应头和心跳）、`CollectingTurnSink`（测试和 worker）、`DiscordTurnSink`（第 9 步）。
- `platform-contracts` 按 03 §6.9、15 §12.2 改类型；`ai-core/src/chat.ts` 的 `instruction()` 改为分层组装（第 2 步完成）。
- `consult` 或单聊任务前调 `prepareCareerRun`；`blocked` 时按 03 §3.3（主理人请人时不出卡、自己先问；被叫名字、回复卡、点按钮或在单聊里时队员自己问缺的那一项）。

**ai-core 改动**按 15 §12.2、§3.1–3.4（含 `streamModelStep`、`tool_started` 提前、按调用的上限与超时、按 `purpose` 记账）。

**六个 PR**（每个都用假 runtime 测，不需要付费调用；只有 PR3 前的实测例外）
1. **纯抽取**（不变）：行为零变化，现有测试一行不改通过；给 platform-api 加 `@companion/career-core` 的 workspace 依赖。
2. **Agent 循环与能力目录**：ai-core 改动；能力目录与权限矩阵；技能清单与 `use_skill`。不改表。
3. **轮次服务**：合并迁移 017（第 1 步的全部表，PR4、PR6 只用不改）；租约按轮次；记账键改造；插话取代 409 `CONVERSATION_BUSY`，返回 202 `{turnId, queued:true}`，在 agent 的下一步并入，进行中的工具不取消（L1、L2 立即中断）；`queued` 轮次拿不到租约重试 3 次，仍失败标 `failed`；`POST /conversations/:id/turns/:turnId/cancel`；断线不取消。**开工前**做 15 §1.2 的小规模真实模型测试（主理人与前、投、面各 30 段虚构脚本），**需产品负责人批准预算**；不批准就按假设继续，B0 实测再调。
4. **房间与转发卡**：`GET /rooms`、`POST /rooms`（打开单聊、进面试间）；`runExpert` 写转发卡消息（`kind = forward_card`，做法同现在路由里 `send('approval')` 的闭包）；`detectNameCall`；引用回复与卡上按钮（`POST .../messages/:messageId/actions`）；交接便条；单聊结论回主线；`platform_expert_runs`。
5. **订阅流**：`GET /conversations/:id/events`、`GET /rooms/events` + `platform_conversation_events`（只存 `{type, message_id, card 引用}`，`seq` 在会话行锁内分配；`/rooms/events` 按 15 §8.2 用快照加通知）+ LISTEN/NOTIFY。网页用 fetch 流读取（复用 `readMessageStream`），带 `x-companion-account` 和 `Last-Event-ID`，不用原生 `EventSource`。最晚 B0（§1.6）。
6. **后台任务卡**（15 §4.6、§12.2）：`agent` 任务只由服务端路径建（`parseAgentJob`；`POST /jobs`、重试对 `agent` 返回 403）；`authorizeConversationTaskOrigin` 改为核轮次；检查点续跑，进度每 ≤ 10 秒。

**017 的表**：字段见 03 §6.2–6.5，不建参与者表；另含 `platform_chat_calls` 改键（重建 010 的约束，`message_id` 可空）、`platform_jobs.kind` 加 `agent` 与 `progress_label`、`progress_at`、016 的 `tool` CHECK 加 `start_background_task`、`start_task`（15 §12.2）。回填：user → `user`，assistant → `legacy_assistant`，会话 `kind='legacy'`。

**接口与事件**：03 §6.10；SSE 按 15 §8.1（学生端不发 `tool`、`approval`、`usage`）；埋点 `message_sent`、`expert_consulted`、`forward_card_shown`、`forward_card_action`、`expert_room_opened`、`name_call_detected`、`interjection_joined`、`turn_stopped`、`skill_used`、`background_task_started`、`background_task_finished`（07 §7.5）。

**保留**：每用户 2 个 chat 租约（主线和一个单聊或面试间可同时在跑；租约 id 改为轮次 id，L1 抢占时在轮次锁内交接，03 §6.5）、租约每 15 秒续期、已校验文字每 ≤ 2 秒写库（15 §8.2）、`recoverStaleStreams`（扩展为把过期 `running` 轮次标 `failed`，含 L2 的除外）、附件上限、`platform_one_stream_per_conversation`。

**验收**：03 第 13 节和 15 §14 中轮次、房间、工具、`prepareCareerRun` 的条目，另外：
- [ ] PR1 合并后现有测试一行不改通过；不经 HTTP 用 `CollectingTurnSink` 调 `submit` 能完成一轮。
- [ ] 假 runtime：同一步三个各 1 秒的只读调用总耗时 < 1.5 秒；工具出错不终止一轮；到上限时最后一步不带工具。
- [ ] 「引子 + 转发卡」一轮中途 SSE 断线：轮次照常完成，重连后两条消息完整；只有「停下」和 cancel 接口才取消。生成中发的消息返回 202 并在下一步并入。
- [ ] 主线里叫名字的轮次没有任何模型调用用于判断谁接；被叫的队员直接出卡、没有引子。
- [ ] worker 重启后 `agent` 任务从检查点续跑、草稿不重复；进度间隔 ≤ 10 秒；学生直接 `POST /jobs` 建 `agent` 任务返回 403。
- [ ] 传 `persona`、`provider`、`model`、`mode` 返回 400；缺 `x-companion-account` 返回 409。
- [ ] 订阅流带 `Last-Event-ID` 重连，不丢、不重复。

**风险**：流式链路和循环改造回归代价最高，PR1 的零变化和 PR2 的假 runtime 测试是护栏。其他发言者的输出和工具结果按 03 §6.8 作为数据处理，防止被当成指令。

---

## 4. 第 2 步 主理人、安全分级、身份事实配置与第一封信

**目标**：主理人成为服务端实体；每条用户消息先过安全分级；身份数字只来自审核过的配置；诞生后发第一封信。规格见 02 第 10、15 节。

**改动范围**
- `018_companions.sql`：`platform_companions`（含 `overlays` jsonb 数组，每项 `{kind, until, source_ref}`，`kind` 与合并规则见 02 §8.1；`paid_suggestions_mode`：`when_relevant`/`only_when_asked`）、`platform_companion_revisions`、`platform_companion_answers`、`platform_safety_events`（含 `retention_until`）、`platform_safety_resources`、`platform_immigration_facts`，其余按 02 §15.2；补 `companion_id` 外键。`voice_disclosed_at` 放用户级设置。
- **`src/data-crypto.ts`**：`account-mail.ts` 的封装只在配了邮件时才有密钥、只收邮件字段，不能复用。新模块用专用密钥 `PLATFORM_DATA_KEY`（生产缺失时拒绝启动），AAD 按「表、列、行 id」区分，密文首字节记密钥版本。主理人自由文本、身份字段、待确认正文、通知载荷都用它。
- `src/companion.ts`、`src/context-assembly.ts`（层次按 02 §15.4，排列按 15 §6.1：稳定层在前、变化层在历史之后；每次模型调用前组装）。纯逻辑放 `career-core/src/companion/`：情境题映射、互补规则、名字与印章字校验、说话方式卡、`canSendProactive`（读 `overlays`）、敏感度过滤（03 §8.5）、身份数字校验器。专家人格卡放 `career-core/src/team/`，带 `revision`；`apps/web/src/voice-personality.ts` 的面试官提示词迁来做初稿。
- `POST /conversations`、发消息、`/voice/session`（`persona`、`voice`）、`/voice/speech`（`voice`、`instructions`）收到客户端人格返回 400 `PERSONA_NOT_ACCEPTED`；前端删人格选择和语音页三个角色。
- **后台生成路径** `src/background-generation.ts`：上下文组装 + `runtime.streamChat`，不进会话轮次、不占轮次锁；`acquireRuntimeLease` 加租约种类 `background`，不占 chat 名额；先 `CostGuard.reserve`，完成后 `post()` 写入。`/companion/drafts`、第一封信、晨报、`room_summary`、被拒后的回应都走它。
- **第一封信**：`POST /companion/birth` 只建主线（`kind = main`）和诞生事件，不带 `voicePreset`。05 C6 之后（或用户选「直接写信吧」、离开超过 30 分钟）经后台生成写 `kind='letter'`：引用 ≥ 2 条用户本人提供的事实（记 `source_ref`），不足时写清下一步要了解什么；队伍介绍只列已上线的队员。
- **快速通道**：跳过情境题，按 02 §2 的默认性格诞生。

**安全分级（02 §10）**
1. 用户消息落库后立即同步执行，与插话判断、建轮次和上下文组装并行；第一次模型调用在这之后发出，返回 L0 前不放出文字和进度短语、不执行工具，L1、L2 时取消（15 §3.1）；诞生前的自由文本同样分级。检测器带版本号。
2. 关键词 + 模型分类。模型超时（假设 1 秒）、出错、供应商不可用或 `PLATFORM_ALLOW_PROVIDER_CALLS=0` 时只用关键词，按 ≥ L1 处理。
3. L1、L2 立即中断当前轮次（含进行中的 `consult`，任何房间）、清空排队、抢先处理；发生在单聊或面试间时按 03 §4.1 第 2 步。
4. L2 模板和资源卡由服务端确定性渲染（变量只有主理人名字和用户称呼），`post()` 直接写入；不调用模型，不受 `CostGuard`、`PLATFORM_FEATURE_*`、供应商状态、租约、限流影响；崩溃恢复时自动重放。
5. 资源卡：988、911、741741 加学校资源。`platform_safety_resources`（`school_key`、`name`、`phone`、`url`、`hours`、`verified_at`、`verified_by`）由运营维护；学校未知时显示 988 和查找本校心理咨询中心的通用指引。

**身份事实配置**：`platform_immigration_facts`（`key`、`value`、`unit`、`zh_text`、`reviewed_by`、`reviewed_at`、`next_review_at`、`status`：`draft`/`approved`/`retired`）。只有 `approved` 且未过复审日的行能作为模板片段注入，带「最近核实」日期和脚注「信息与提醒，不是法律意见」。每句输出过运行时校验，拦截不来自配置的天数、日期和政策数字，命中改用固定模板并记日志。P1-3 开关打开前，任何发言者都不计算待业天数和截止日期。

**接口与事件**：02 §15.3；埋点 `intake_completed`、`companion_rerolled`、`companion_born`、`first_letter_delivered`、`safety_level_assigned`。`persona` 列冻结，`mode='companion'` 不再可选。

**验收**：02 §15.6 全部满足，另外：
- [ ] 前端没有人格提示词；每个轮次行记「平台策略版本 + 发言者 revision + 主理人 revision」。
- [ ] 注入模型故障（分类超时、供应商 500、`PLATFORM_ALLOW_PROVIDER_CALLS=0`）时，危机消息仍在 2 秒内收到完整模板和资源卡；已到硬上限、开关关闭、流式中插话时同样；L2 轮次中途崩溃，重启后模板自动发出。
- [ ] 构造的「OPT 还剩 41 天」被拦截并换成固定模板；未审核或过期的配置行不进上下文。
- [ ] 换行或换表粘贴的密文无法解密。
- [ ] 非危机内容中依赖模型的生成在模型不可用时如实失败并可重试，不用固定文案冒充（AGENTS.md）。

**风险**：生成质量和分级误报率到第 8 步评测才能验证。

---

## 5. 第 3 步 求职数据、共享记忆、组织库最小切片

### 3A 求职数据表（`020_career_data.sql`）

本节是身份字段与看板字段的唯一字段表。每张表有 `user_id`（`ON DELETE CASCADE`）、`created_at`、`updated_at`。状态只能由用户操作或用户点击产生的回执改变，队员只能提议。

| 表 | 关键字段 |
|---|---|
| `platform_career_profiles` | `user_id` 主键；`program_type`（`12_month`/`16_month`/`24_month`/`other`，由毕业月推出）、`program_start_date`、`degree_field`、`recruiting_cycle`、`target_tracks[]`、`graduated` |
| `platform_career_identity_dates` | 每行一个身份字段：`field`、`value_ciphertext`、`source`（`user_entered`/`user_uploaded`/`derived`）、`confirmed_at`、`sensitivity`、`label` 与 `remind_before_days`（仅自定义日期）。`field`：`program_end_date`、`stem_designated`（二者 `sensitive`）；`opt_status`、`opt_start_date`、`opt_end_date`、`stem_opt_start_date`、`stem_opt_end_date`、`unemployment_days_reported`（含 `reported_at`）、`employment_reported`、`unemployment_reminder_days`、`h1b_registration`（每年一行，含 `outcome`：`selected`/`not_selected`/`unknown`）、`custom_status_date`（均 `restricted`）。不存待业开始日，不推算 |
| `platform_career_targets` | `role_family`（career-core 常量，取值见 03）、`title`、`locations[]`、`priority`、`status`（`exploring`/`proposed`/`active`/`paused`/`dropped`）、`proposed_by` |
| `platform_career_job_observations` | 对应 `CareerJobObservation`：`source`（P0 只有 `manual`）、链接、观察时间、`state`（P0 固定 `unknown`，界面标「你贴的 JD · 没核实是否还开放」）、`sponsorship`（`explicit_yes`/`explicit_no`/`unknown`，存服务端规则定位的英文原句与查看时间，03 §2.6）、证据段落 |
| `platform_career_applications` | 05 §3.1 的 `stage`、`closed_reason`、`closed_at_stage`、`offer_state`、`submitted_via`；`job_observation_id`、公司、岗位、`role_family`、地点、`packet_id`、`deadline_at`、私有备注（加密） |
| `platform_career_application_events` | 只追加：起止阶段、操作者（用户或回执）、时间 |
| `platform_career_interviews` | `application_id`、轮次类型（04 §3.1）、开始时间、时区、时长、`status`（`scheduled`/`rescheduled`/`done`/`cancelled`）、简报引用、复盘 |
| `platform_career_stories` | STAR 四段、题型标签、关联证据、中英文版、`status`（`proposed`/`draft`/`confirmed`）、`revision` |
| `platform_career_resume_versions` | `track`、`label`、`source`（`upload`/`paste`/`derived`）、`upload_id`、`derived_from`、`diff_summary`、`content_digest`、`status`（`draft`/`active`/`archived`），对应待确认被确认后才 `active` |
| `platform_career_evidence` | 与 career-core 的 `CareerEvidence` 逐字段对应，含 `mentor_review`、`withdrawn_at`；成长记录用 `careerProgress()` 计算 |

专家经 `read_profile` 只拿到毕业年月；`restricted` 不进任何专家上下文，主理人只在用户自己提起或自设提醒时使用，且只出现在网页正文。

**被拒的最小处理（07 P0-9）**：`POST /career/applications/:id/stage` 在一个事务里写阶段和事件；当 `stage='closed'`、`closed_reason ∈ {not_advanced, rescinded}` 且 `closed_at_stage ∈ {oa, interview, offer}` 时，同一事务给 `overlays` 追加 `{kind:'post_rejection', until: now()+48h}`，提交后经后台生成路径由主理人回应一条（不推送，无红色和 Rejected，见 05 §2.7）。其他结束只静默归档，下一封晨报一句带过。

**接口**：`/career/profile`、`/career/identity`、`/career/targets`、`/career/applications`（含 `POST /:id/stage`）、`/career/interviews`、`/career/stories`、`/career/resume-versions`、`GET /career/progress`；补 `DELETE /uploads/:id`。专家工具按 03 §2.7。埋点 `application_stage_changed`、`story_saved`、`resume_version_created`。

**JD 与简历**：P0 由用户粘贴 JD。公开链接读取是 B2 补齐集第一项，走 3D 的第一方岗位源：只读 Greenhouse、Lever、Ashby 公开页，失败退回粘贴；LinkedIn、Indeed 链接只存不抓。简历文字抽取是新能力（现在 PDF 只能原样交给供应商），失败时请用户粘贴。

### 3B 共享记忆（`019_memories_v2.sql`）

`platform_memories` 按 02 §7.2、03 §8.2 加列（`confidence`、`revision`、`valid_until`、`content_fingerprint`、`review_due_at` 等），旧数据回填为 `goal_preference / user_saved / confirmed / normal`；新表 `platform_memory_events`、`platform_memory_uses`。接口按 03 §8.6（`PATCH /memories/:id` 带 `expectedRevision`、`confirm`、`dismiss`、`GET /memories/:id/uses`）。注入改为上下文组装按 03 §8.5 挑选，`read_saved_memories` 由注入和 `search_memories` 取代；删除记忆时按 03 §8.8 把原消息标 `excluded_from_context`。埋点 `memory_proposed`、`memory_decided`、`memory_edited`、`memory_deleted`。

### 3C 组织库最小切片（`021_org_knowledge.sql`）

按 07 P0-11，只做 04 §4.3、§4.6、§4.8 的子集（前置条件：蔓藤完成授权）：
- 表：`platform_content_licenses`（`license_id` 必填）、`platform_org_knowledge_sources`、`platform_org_knowledge_passages`、`platform_user_entitlements`（首批全部授予 `cohort`）、`platform_knowledge_access_log`、`platform_content_feedback`。`platform_orgs`、`platform_org_roles` 由 026 建；`platform_data_consents` 随 9D。
- `OrgKnowledge` 服务、导入脚本 `src/org-content-import.ts`、编辑与审核分离；只导入题库、方法卡、对话模式卡；检索只用结构化筛选。
- 04 §4.6 交来的三件事：`src/career-knowledge.ts` 实现 `CareerKnowledgePort`（合并查私人库与组织库）；`KnowledgeCitation` 的 `revision` 从字符串改为数字，加可选 `scope`、`assetClass`；私人库查询含汉字时先跑 30 条中文夹具，recall@5 < 0.8 就同样加两字切分的 `tsvector` 列（15 §4.2）；为 `prepareCareerRun` 生成知识访问引用 `{input:'knowledge', id:'knowledge-access:<userId>', revision:<publish_batch>, ownerId:<userId>, state}`；entitlement 撤销只让该运行冻结的引用 `withdrawn`，新运行只查私人库（04 §4.6）。

### 第 3 步验收

- [ ] 每张新表都有跨用户隔离测试：A 读、改、删 B 的任何一行都返回 404。
- [ ] 队员只能写 `proposed` 或草稿；确认前任何发言者的上下文里都没有未确认条目。
- [ ] 03 第 13 节的记忆条目全部通过。
- [ ] 身份字段在库里是密文；`restricted` 不进专家上下文；没有 `eligible`、「剩余可待业天数」这类字段，也没有待业开始日。
- [ ] 标记 `not_advanced` 后 48 小时内晨报只问候、不派任务；看板上没有红色和 Rejected；`no_response` 不触发覆盖。
- [ ] `GET /career/progress` 与 `careerProgress()` 对同一组证据输出一致。
- [ ] 3C：无 `license_id` 导入失败；审核人与编辑同一人时发布失败；跨权限返回 0；`consult` 面或在面的单聊里 prepare 返回 `ready_for_draft`；entitlement 撤销后冻结的引用 `blocked`、新运行仍 `ready_for_draft` 且只查私人库。

**风险**：蔓藤授权卡住 3C 和第 7 步题库；简历抽取不稳，必须保留粘贴退路。

### 3D 外部数据来源：复用 MCP

规格见 03 §2.8，现状见 `docs/platform/mcp.md`。复用 `97194b4` 的治理层（审阅目录、`policy_hash`、`platform_mcp_receipts`、私有结果、`untrusted_mcp`），不另写抓取与授权；题库、方法卡、面经仍按 3C、9D 导入。现在每次调用都要审批、只能排队，要补：

1. **目录**：`mcp-config.ts` 的 `readMcpConfig` 接受 03 §2.8 列出的条目与工具新键，另加 `transport`（`remote`/`first_party`）、`licenseId`、`provenanceLabel` 和运营方写的说明（取代远端描述）；一份目录不拆文件，走 PR，新键进 `mcpCatalogHash`。
2. **长期授权**：`platform_mcp_standing_grants` 与 `platform_apply_authorizations`（11 §6.1）同构、只追加，`items` 每项按 03 §2.8，加当前值视图；`external_grant` 卡确认时同一事务追加。
3. **轮内调用**：`McpConnections` 加 `callInTurn`（15 §4.4），按 03 §2.8「执行」第 1 条；新增 `assertStandingGrant`，以「授权记录版本 + 分配表 + `policy_hash` + 轮次租约」代替审批行，schema 哈希、调用前重新发现照旧；不经 job，不占 `PLATFORM_MAX_ACTIVE_JOBS`；挂进能力目录时目录 id 为 `ext:<catalogId>/<tool>`，给模型的函数名是 `ext_<catalogKey>__<tool>`；单次 8 秒、一轮合计 ≤ 20 秒（假设）。
4. **第一方岗位源**：`McpTransport`（`mcp-transport-port.ts`）加 `first_party` 实现，只对 Greenhouse、Lever、Ashby 的公开读取域名发只读请求，按单帖读取、只回紧凑字段（整板超过 64 KiB）；用户确认后存成岗位观察（3A）。
5. **出站过滤**：career-core 纯函数，规则表与 10 §3.9 共用。
6. **回执、上限、保留**：`platform_mcp_receipts` 迁移：加 `id uuid` 主键；`job_id` 去掉主键、改可空，加部分唯一索引 `(job_id) WHERE job_id IS NOT NULL`；加 `turn_id`、`conversation_id`、`speaker`、`purpose`、`grant_record_version`，`CHECK (job_id IS NOT NULL OR turn_id IS NOT NULL)`；`started`/`complete`/`interrupt`/`assertPublication` 改按回执 id；轮内结果存为按用户的私有文件（`private-files.ts`），回执记 `result_ref` 与 `response_hash`（15 §12.2）。照 `da4434a` 与调用同一事务写；按工具和全局每日上限计数（假设）；付费来源进成本账本（06 §12.4），单列 `external_tool`。
7. **进上下文**：`untrusted_mcp` 说明从只在 agent 模式追加改为平台策略层（03 §6.8 第 5 条）。
8. **蔓藤 MCP 服务**（04 §6.3）：蔓藤托管、公网 HTTPS、只读，凭据走 `bearerEnv`；调用前在我方核 entitlement（04 §4.12）；要按用户限流时只传 `HMAC(userId, catalogId)`。

**批次**：B2 补齐集做 1、3–7，只开 `system` 来源，没做完连同公开链接读取顺延到 P1a；P1b 做 2、8 和 `/me/connections`；P2 加后台用途（某来源失败就略过）、`user_account` 来源（Gmail metadata；日历评估）、M2-2 经 MCP 同步进组织库。

**接口**：`GET /external-sources`（来源、当前授权、最近 20 次查询，不含参数和原文）；`POST /external-sources/grant-cards`（设置页出卡，`web_settings`）；确认走 03 §9.6。埋点按 07 §7.5。

**验收**
- [ ] 03 §13 的外部来源条目全部通过；`policy_hash` 或 schema 变了不执行、不弹窗、进补问；失败时不出现来源标签，`uncertain` 不重放。
- [ ] 过保留期的结果文件被删；两个账号互读回执和结果都返回 404。

---

## 6. 第 4 步 五个界面的路由与对话 UI

**目标**：用「今天、对话、待确认、旅程、我」替换工具型导航；对话页是对话列表加当前房间（主线或某个单聊）；完成 token 迁移。流程见 05，组件、布局与文案见 08，事件与呈现见 15 §8。

**改动范围**
- **路由**：History API 最小路由 `apps/web/src/app/router.ts`；路径只在 05 §0.3 定名；`static-web.ts` 已回退到 `index.html`。深链打开时窗口账号与登录账号不一致，先显示「确认账号」。
- **拆 `App.tsx`**（568 行、66 KB）：`app/`、`surfaces/today|group|pending|journey|me/`（`group` 下分主线与单聊，路由见 05 §0.3）、`components/seal/`、`components/cards/`、`domain/`（沿用 `BoundPlatformClient`，解析 `TurnEvent`）。布局与组件（`ChatList`、`RoomHeader`、`ForwardCard`、`TaskCard`）按 08 §7。
- **消息流**（15 §8.3）：一条消息一个气泡，以 `messageId` 为键、按 `start` 新建，`error` 只结束那一条（现在 `App.tsx` 一次流只建一个占位、`error` 结束整条流）；进度条目在 `agent-tool-status.ts` 的 `upsertAgentToolStatus` 上改，显示短语、不显示工具名；任务进度由订阅流驱动，删掉 `account-polling.ts` 的 12 秒轮询；输入框「发送 / 停下」按 08 §7.4。
- **印章字形（08 §5.3 交来的决定）**：构建时离线生成《通用规范汉字表》一级 3,500 字的 SVG path 作为静态资源（宋体 700，确认字体许可，脚本放 `scripts/`），运行时只查表，表外的字在诞生页提示换一个；墨色取该消息 `speaker_snapshot` 里的 `ink_token`。Discord 的 PNG 在第 9 步生成。
- **token**：按 08 第 10 节集中到 `apps/web/src/styles/tokens.css`；旧 `styles.css`（57 KB、最小字号 5px）先换 token、删装饰，之后逐块删除。
- **PWA**：manifest 按 10 §2.3 改；`/sw.js` 由 Workbox `generateSW` 构建生成；离线只显示公共外壳和「没网了」，**不缓存晨报、三件事和任何私人接口**（docs/platform/mobile-web.md）。按界面分包。
- `AuthView`、`AccountActionView`、`KnowledgePanel`（并入「我」）、`VoiceRecords` 保留；`CreativePanel`、`WorkflowPanel`、`BrowserPanel`、`TaskPanel`、`McpToolPanel`、旧 `SettingsPanel` 只给员工，挂 `/workbench`。

**验收**
- [ ] 五个界面都能直接打开 URL；刷新不丢状态；未登录的深链先登录再回原路由。
- [ ] 390×844 和 1440×900 无横向滚动；CSS 无小于 12px 的字号、无 token 之外的十六进制颜色（CI 脚本）；墨色对比度通过 08 校验，深色模式可读。
- [ ] 主线和单聊渲染 15 §8.1 的全部事件，断线后能补齐；生成中发消息显示「排队中」，空输入框的「停下」1 秒内生效。
- [ ] 没有红点、连胜、打卡和红色 Rejected；任意截图都能看到 AI 标识；离线时不出现私人内容。

**风险**：最容易做两遍。先做主线、单聊、今天、待确认，旅程等 3A 接口稳定再做。

---

## 7. 第 5 步 对外发出类待确认

**目标**：要发给别人的消息和材料，都先进待确认；表单里哪些项可以替用户做，由用户在对话里逐项确认（见 11）；最终提交永远由用户本人点。确认绑定内容摘要，内容一改就作废，执行前复核。

**改动范围**
- `022_pending_items.sql`：`platform_pending_items`（含 `snoozed_until`）、`platform_pending_item_revisions`（正文经 `data-crypto.ts` 加密）、`platform_pending_item_decisions`，字段按 03 §9.2；补 `platform_career_applications.packet_id` 外键。
- **状态机只用 03 §9.3**；界面文案与色调只取 08 §7.10，单元测试保证每个枚举值都有映射。`final_action` 取 `user_sends`/`extension`/`in_product`/`none`；`none` 表示确认即终态（`resume_version` 确认后简历行变 `active`）。新简历版本只 supersede 同一 `track` 里还没确认的草稿；只有同一对象出了新 revision 才触发 `DEPENDENCY_CHANGED`。
- `src/pending-items.ts`（`PendingItems`）；载荷校验纯函数放 `career-core/src/pending/`。
- **事实可追溯**：载荷带 `claims[]` 和 `source_refs`（03 §9.2）；找不到来源的事实标「原稿里没有的事实」，差异视图逐条列出，处理完之前不能确认（03 §6.8）。
- **身份类答案**：sponsorship、工作授权、公民身份、EEO 类题的 `answer_source` 只允许 `profile_confirmed`（服务端从已确认档案确定性填入，注明确认日期）或 `user_required`，校验函数拒绝模型生成的这类答案（03 §9.2）。
- 摘要复用 `json-hash.ts` 的 `workflowHash`，执行前在 `FOR UPDATE` 事务里比对（照搬 `jobs.ts` 的 `approvalMatches`）；确认接口按 `(id, revision, payloadDigest)` 幂等。协议形状参考 `actionCards.ts`，在 `platform-contracts` 重写。
- 按钮按 08（用户自己发出的写「确认这一版」）；「缄」字动效可借鉴 `apps/extension/lib/dock/envelope.ts`，P0 可先用静态版本。

**P0 类型与起草者**按 03 §9.1：`resume_version`、`application_packet`、`email_draft`、`outreach_message`，都由用户本人发出；其余类型随 P1-1、P1-8、P1-9、P1-10。工期吃紧时 `outreach_message` 第一个砍。

**接口**：03 §9.6；错误码 `PENDING_ITEM_CHANGED`、`APPROVAL_REVOKED`、`DEPENDENCY_CHANGED`；每日上限按 03 §9.7。埋点 `pending_created`、`pending_decided`、`pending_finalized`、`pending_marked_sent`。`platform_approvals` 只服务内部任务。

**验收**：03 第 13 节的待确认条目，另外：
- [ ] 没有代码路径能不经确认就标为已发出；来自 Discord 或任何非网页会话的对外类确认被拒绝。
- [ ] 正文只以密文存在 revisions 表，不进日志、埋点和 SSE `card`（卡片只带 id、版本、状态）。
- [ ] 带编造事实的材料包不能直接确认；模型生成的工作授权答案被拒。
- [ ] `approved`（`user_sends`）显示「已确认这一版 · 等你发出」、pending 色调；只有 `sent` 用 done 色调。

---

## 8. 第 6 步 今天：调度器、通知、主动额度、保留期清理

**目标**：按用户时区发晨报和三件事；所有渠道共用一个额度。额度、免打扰、提前量、忽略 3 天的处理以 02 §9 为准，本文只写实现；流程见 05 §2.2。P0 只有网页和邮件提醒。

**改动范围**
- **调度器**：worker 进程里新建 `src/scheduler.ts`，每分钟领取到期计划，`pg_try_advisory_xact_lock` 防并发（同 `jobs.ts`），租约加 `generation` 防重复。
- **晨报**：先用纯函数 `pickTodayThree`（05 §2.2）选三件事，再走后台生成路径写正文（≤ 200 字），`kind='letter'` 用 `post()` 写入。生成失败或到降级档时用 05 §2.2 的简版模板，标 `generated_by='fallback'`，卡片落款处显示「简版」，不冒充模型生成。晨报和三件事只放免费或「已包含」的内容。
- **通知**：`src/notifications.ts`，照搬 `account-mail.ts` 与 `012_account_actions.sql` 的租约、重试、过期，载荷用 `data-crypto.ts`。P0 邮件只写「晨报写好了」和链接，可关。
- **保留期清理**：调度器加每天一次的 `retention` 任务；期限与隐私政策一致。

| 表 | 保留期 | 删除方式 |
|---|---|---|
| `platform_conversation_events` | 30 天（03 §6.7） | 删除 |
| `platform_memory_uses` | 90 天（03 §8.2） | 删除 |
| `platform_knowledge_access_log` | 180 天（04 §4.3） | 删除 |
| `platform_product_events` | 13 个月（07 §7.5） | 删除 |
| `platform_safety_events` | 到 `retention_until` | 删除 |
| `platform_notification_outbox` | 终态后 30 天（假设） | 删除 |
| `platform_external_identities`（`revoked`） | 解绑时清空身份字段，24 小时内删行 | 审计哈希留 90 天 |
| `platform_link_codes` / `platform_inbound_events` | 过期后 24 小时 / 7 天（假设） | 删除 |
| `platform_mcp_receipts` / MCP 结果文件（3D） | 365 天（假设）/ 按条目 `resultRetentionDays` | 删除，含对象存储 |

**023 的表**

| 表 | 关键字段 |
|---|---|
| `platform_schedules` | `user_id`、`kind`（唯一枚举在 02 §9.2）、`ref_id`、`recurrence`、`local_time`、`timezone`、`next_run_at`、`status`、`lease_token`、`lease_until`、`generation` |
| `platform_daily_plans` | `user_id`、`local_date`（联合唯一）、`brief_message_id`、`generated_by`（`rules`/`fallback`）、`accepted_at` |
| `platform_daily_plan_items` | `plan_id`、`title`、`owner`（队员键）、`minutes`、`link`、`rule`、`state`（05 §3.3） |
| `platform_proactive_ledger` | `user_id`、`local_date`、`kind`、`counts_toward_quota`、`message_id`、`channel` |
| `platform_notification_outbox` | 字段按 10 §9；`dedupe_key` 唯一（如 `user:morning_brief:2026-10-07`）；载荷加密 |

设置增加 `web_alert`（`none`/`email`/`push`）和 `notification_preview`（10 §9）。

**接口与事件**：`GET /today`、`POST /today/plan/accept`、`PATCH /today/plan/items/:id`、`POST /today/pause`；晨报时间等沿用 `PATCH /companion/settings`。埋点 `brief_delivered`、`brief_engaged{channel, action}`、`three_things_decided`、`today_opt_out`。

**验收**（`canSendProactive` 单元测试 + worker 集成测试）
- [ ] 02 §9.1 的额度跨渠道合并计算，同一条只投递一个渠道；例外超额时按 02 §9.2 的优先级保留。
- [ ] 免打扰内的消息顺延；夏令时切换当天时间正确（IANA 时区）。
- [ ] worker 生成到一半崩溃，重启后同一天不发第二封晨报（`dedupe_key`）。
- [ ] `overlays` 有效期内没有任务类主动消息，面试和截止提醒照发但不带准备任务。
- [ ] 用户正在聊天或练面试时晨报照常生成，不出现 `RUNTIME_CONCURRENCY_LIMIT`。
- [ ] 邮件不含晨报内容，不用追踪像素；「今天」页没有红点和未读徽标。
- [ ] 时间快进后，保留期表里各表只剩期限内的行。

**风险**：第 8 步前接永远返回 `ok` 的 `CostGuard` 桩，完成后替换，不能漏接。

---

## 9. 第 7 步 面试官最小版

**目标**（07 P0-10）：用户叫面，或在面的单聊里进面试间；面试官从蔓藤题库出题，逐回合练习（文字或英文语音），逐题按 rubric 反馈；小结以面的转发卡回主线，好的回答经用户确认后存进故事库。

**改动范围**
- `src/practice.ts`。**一个练习会话对应一个 `kind='interview'` 的房间**（03 §6.2），从面的单聊进入，`POST /rooms` 在同一事务里创建两者。每题的回答作为面试间消息走轮次服务（因此先过安全分级），由轮次服务写入 `platform_practice_answers`。出题用 `search_org_knowledge`（3C 题库）。
- 语音：逐回合走 `/voice/transcribe`、`/voice/speech`。转写加 `language` 参数并固定英文（`services/local-transcription` 不能指定语言，`VoicePanel.tsx` 写死 `zh-CN`，都要改）。
- **面试官声线唯一来源** `PLATFORM_INTERVIEWER_VOICE`（12 §5.1）：朗读和 P1-11 实时会话都只读它，不读 `OPENAI_TTS_VOICE`、`OPENAI_REALTIME_VOICE`；客户端不能指定。P0 前做同名声线在朗读与实时两个接口上的 AB 听测（需批准）。第一次播放前弹 12 §6.1 的说明。
- 小结：后台生成路径写 `room_summary` 进面的单聊，结论以面的转发卡 `post()` 进主线（03 §4.6）。

**024 的表**（语义按 05 §3.4）：`platform_practice_sessions`（`conversation_id` 唯一、模式 `turn`/`realtime`、题型、关联投递或面试、语言 `en`、`audio_retention` P0 固定 `none`）；`platform_practice_answers`（`message_id`、题目与 rubric 的引用和版本、转写引用、用时、各维度分数、做得好、最该改、是否不同意）。

**接口与事件**：`GET /practice-sessions/:id`、`POST /practice-sessions/:id/finish`、`POST /practice-sessions/:id/answers/:index/disagree`。埋点 `practice_started`、`practice_completed`、`feedback_rated`、`knowledge_cited`；复盘写 `platform_career_evidence`（`practice_review`）。

**验收**
- [ ] 假 runtime 跑完 5 道题：每题单独落库，复盘逐题显示 rubric 各维度；每题能追溯到题库版本，撤回后显示「来源已撤回」。
- [ ] 面试间里含自伤表达的回答收到 L2 模板和资源卡（模板和资源卡同时写进面试间和主线，面试间给 [去主线]，02 §10.3），练习暂停。
- [ ] 不保存录音；存进故事库前必须经用户确认；拒绝「在真实面试中替我答」；反馈不引入用户回答和已确认资料以外的经历与数字。
- [ ] 同名声线跨朗读与实时接口的 AB 听测通过。

**之后**：作战简报见 9D。P1-11 按 12 §5.1 改 `/voice/session`：指令、`turnTaking`、声线由服务端下发；客户端逐句上送输入转写由服务端分级，L1、L2 时立即结束实时会话并显示资源卡；转写不可用时不开放沉浸模式。

**风险**：评分一致性达不到 07 §7.4 时只给文字建议、不打分。WebRTC 从未在真机验证。

---

## 10. 第 8 步 真实模型评测与按用户费用上限

**目标**（07 P0-13）：上线前用真实模型跑评测；每位用户有费用上限，所有渠道和 worker 都受约束。数值与降级顺序以 06 §12.3 为准（首批按周计；软上限只通知运营；到硬上限只保留主理人简短对话、查看与确认、记忆管理和危机流程）。

**改动范围**
- **模型路由**：`model-routing.ts` 扩展为「发言者 × 用途 → 供应商、模型、输出上限、推理强度、超时」（15 §7）；不自动切换供应商。
- **评测 harness** `services/platform-api/evals/`：直接调轮次服务、上下文组装和后台生成；评测集来自 02 §15.6、03、05 和 15 §11.2（自己做还是请队员、叫名字识别、人格区分盲测、校验器误杀、技能成功率、权限、引擎行为），通过线按 07 §7.4，多轮流程用模拟用户跑，含「事实可追溯」（新增事实为 0）、≥ 10 条问签证情境（算剩余天数、cap-gap、Day-1 CPT）、口语夸张误报率、付费建议反例。**需产品负责人批准预算**，单独环境里 `PLATFORM_ALLOW_PROVIDER_CALLS=1`，数据全部虚构。
- **成本护栏**（06 §12.4）：`025_cost_guard.sql` 建 `platform_model_prices`、`platform_cost_ledger`，`platform_chat_calls` 加 `cached_input_tokens`；`src/cost-guard.ts`（`reserve` → `ok`/`degrade`/`block`，`commit` 结算）替换桩，挂在每一轮、每次 `consult`、后台任务、后台生成、`/voice/session`、朗读、转写之前。`degrade`：主理人不主动 `consult`、改为先问，后台降到经济档；`block`：只有主理人的一句简短回答，不挂工具（03 §4.1 第 4 步）；危机不经过护栏。实时语音改为按服务端时长记成本。
- **额度**：P0 不建会员表，额度检查把首批用户视为会员来源 `cohort`；会员表在 P1-C 收费前建（第 15 节）。
- 降级提示是系统通知（`speaker_kind = system`），不由主理人说，不写「明天 0 点恢复」。`GET /usage` 只给员工。埋点 `cost_cap_hit`。

**验收**
- [ ] 同一用户在两个渠道同时发起轮次，超出硬上限的部分不超过一轮的预留额；到硬上限后降级生效，危机流程照常。
- [ ] 学生端任何地方都看不到 token、金额、供应商名和模型名。
- [ ] 评测报告逐项给出通过与否；未通过项修改后再评测通过。

**风险**：价格表人工维护；价格行带生效日期，查不到时按最高单价计。

---

## 11. 第 8B 步 上线底座、真人入口与付费建议护栏

**目标**：07 P0-14、P0-12 的上线硬条件，以及 P0-2 的付费护栏。

| 项 | 改动（026 迁移） |
|---|---|
| 邀请与协议确认 | `platform_invites`（`code_hash`、`email_digest`、`batch`、`invited_by`、`expires_at`、`redeemed_at`、`redeemed_user_id`）；`POST /auth/register` 在 `PLATFORM_REQUIRE_INVITE=1` 时校验。`platform_terms_consents`（只追加：`user_id`、`terms_version`、`consented_at`）记 05 O0 不预勾的协议确认。`model-routing.ts` 是所有模型调用的唯一入口，在这里检查同意记录，没有就拒绝 |
| 员工角色 | `platform_orgs`、`platform_org_roles`（`content_editor`/`content_reviewer`/`mentor`/`ops`/`org_admin`/`safety_reviewer`），3C 复用；员工与学生账号分开；每次查看写 `platform_staff_audit`；安全复核只看被标记的那一轮及前后各 5 条（假设） |
| 埋点 | `platform_product_events`，按 07 §7.5 |
| 账号删除与导出 | `DELETE /account`：级联删库、删私有文件、撤销外部身份和插件令牌、清埋点，记一条不含 `user_id` 的计数。`GET /account/export`：JSON 加私有文件，覆盖所有带 `user_id` 的表（含两类授权记录与回执）；身份字段要重新验证身份才导出 |
| 隐私页与部署 | 隐私与协议页内容由律师和产品负责人提供（07 第 9 节），含安全复核、供应商与保留期；部署做 HTTPS、监控、备份恢复演练、日志脱敏，起点 `docs/platform/deployment-plan.md` |
| 真人入口 | `platform_service_offers`（06 §12.4，加 `disclosure_version`）；`platform_mentor_sessions`（04 §3.5，不含价格与支付，带 `order_id`、`intent_note`；P0 只开 `requested`/`matched`/`scheduled`/`completed`/`cancelled`）；`platform_mentor_orders`（`quoted`/`paid`/`refunded_partial`/`refunded_full`/`void`，`payment_ref` 只存外部引用）。意向表写 sessions，不附带记忆；履约状态由服务端生成系统通知。**不建任何内推评估表，不开相关开关** |

**付费建议护栏**（规则以 06 §7.1–7.2 为准）
- career-core 纯函数 `canSuggestPaid(settings, overlays, quietHours, history)`，由 06 §7.6 的 `PaidSuggestionPolicy` 调用，频率与禁推时段按 06 §7.1–7.2；P0 只开 T1、T2、T3、T5、T6。
- 只由主理人说（专家调 `suggest_human_help`，放行后由主理人提出）；只在正在进行的对话里出现，不主动推送，不进晨报、三件事和信件。
- 推荐卡是消息 `kind = paid_suggestion_card`，价格、收款方、利益披露由服务端从 `platform_service_offers` 渲染；固定带「为什么现在提 / 利益关系 / 这像推销？」，点击写 `salesy_flagged`。
- 同在 026：`platform_paid_suggestions`（06 §7.6）、`platform_paid_suggestion_mutes`（`user_id`、`service_kind`、`muted_until`）。埋点 `mentor_suggested`、`salesy_flagged`、`mentor_order_status_changed`、`mentor_session_rated`。

**验收**
- [ ] 无邀请码不能注册，邀请码只能用一次；同意协议前任何内容都不发往模型服务商（自动化测试：未同意用户的每条路径都在 `model-routing.ts` 被拒）。
- [ ] 学生访问员工接口返回 403；员工每次查看都有审计。
- [ ] 删除账号后所有个人数据、私有文件和埋点被清除；测试遍历所有带 `user_id` 的表，每张要么被导出覆盖，要么有写明理由的豁免。
- [ ] 埋点里没有消息内容、简历、JD 原文、身份日期和自由文本。
- [ ] 危机后 14 天内、被拒后 48 小时内、Offer 当天，付费推荐数为 0；推荐卡三个入口齐全。

---

## 12. 第 9 步 Discord 私信机器人

**目标**（P1a · P1-2，规格见 10 第 3 节）：主理人就是机器人；晨报推到私信，与网页共用额度；待确认只推摘要和「到网页确认」。

**改动范围**
- 新进程 `src/discord-main.ts`（结构同 `worker-main.ts`）：进程内直接调服务层，不走 HTTP，不涉及 `x-companion-account`，不持有用户的 cookie 或密码。
- `src/discord-turn-sink.ts`：按句缓冲、按条编辑，不逐 token 编辑；转发卡做成 embed（10 §3.11）。
- **出站过滤**（渠道层之外再加一道，按 03 §8.5）：只放行 `normal`；`sensitive` 只给摘要，不出现第三方联系人姓名；`restricted` 只说「有一个你设置的日期提醒」；另拦截简历片段、身份日期、证件号格式。
- **掉线恢复**：对全部未答消息逐条分级，不限时长；L0 按 10 §3.12 处理。
- **授权只收紧**：两类授权卡在 Discord 里只能确认每项都是「不要」的（10 §3.7）；补问只在晨报提一行。
- outbox 的 `discord` 发送器挂在这个进程，失败退回网页。绑定：OAuth2（`identify` + `guilds.join`）和一次性码（10 §3.2）。印章 PNG 按需生成并缓存。

**027 的表**（字段按 10 §9）：`platform_external_identities`（`provider` 只有 `discord`；`external_user_id`、`display_name_snapshot`、`dm_channel_id` 解绑时置空；`link_method`：`oauth`/`code`；`status`：`active`/`unreachable`/`revoked`；`linked_at`、`revoked_at`、`last_delivered_at`、`last_failure_code`；CHECK 保证 `revoked` 时身份字段和私信频道为空；同一外部账号、同一用户各最多一条 `active`）；`platform_link_codes`（只存 `code_hash`，照搬 `platform_account_actions`；10 分钟有效，每码最多 5 次）；`platform_inbound_events`（`provider` + `event_id` 主键，交互去重）。解绑时同一事务置空身份字段，`retention` 任务 24 小时内删行。

**服务间信任**：用户身份只从 `platform_external_identities` 解析，再以该 `userId` 调 `ConversationTurns.submit`；机器人用单独的数据库账号，只授予需要的表权限。

**限流 scope**：`platform_request_limits` 的 CHECK 写死了 scope 和 subject（`011_request_limits.sql`），按 `013_account_action_limits.sql` 的写法换约束：subject_type 加 `external`（Discord 用户 id 的 SHA-256，每账号每小时 10 次验证码尝试）；scope 加 `discord-message`、`discord-interaction`、`link-code`、`org-knowledge`、`ext-api`、`ext-claim`，**建议随 021 一次做完**；同步 `src/request-limits.ts`。

**接口与事件**：`/integrations/discord`（查询、`oauth/start`、`oauth/callback`、`link-code`、`DELETE`）；斜杠命令按 10 §3.6。私信消息写进主线（`kind = main`），`channel='discord'`；单聊在私信里只给回网页的链接（10 §3.4）。埋点 `discord_linked`、`discord_button_used`、`brief_engaged`。

**验收**：10 第 10 节的 Discord 条目，另外：
- [ ] 出站断言：构造的简历片段、身份日期、第三方联系人姓名全部被拦截。
- [ ] 对外类待确认和放宽授权的卡在 Discord 里无法确认；按钮重复点击幂等；重启后不重复处理同一交互。
- [ ] 掉线 2 小时期间的 L2 消息，恢复后 1 分钟内收到资源卡。
- [ ] 解绑 24 小时后库里没有该用户的 Discord id 和私信频道 id。

**风险**：遵守 Discord 开发者条款；私信可达依赖「小组大厅」服务器（10 的待确认问题）。

---

## 13. 第 10 步 插件对话授权与后端接通

问题目录、问法、底线、数据结构和代码改动点以 11 为准，授权卡与回执以 03 §9.1、§10 为准；底线（11 §5.1）不随任何步骤放宽。授权只在网页里投的单聊确认，填写中浮层不提问（11 §4.1）。

### 10A 安全修正（P0 期间做完，不发布）

- 计划层不传授权时改为拒绝（`engine.ts` 的 `signOnBehalfKindAllowed`），与写入层一致。
- 别国岗位工作授权：档案里没有该国记录时，`withoutRecord` 返回**不带答案**的结果，与 `NO_RECORD` 同路、留给学生，不走 `PREFILLED_NEEDS_CONFIRMATION`。测试：「F-1、加拿大岗位、无记录」零写入、不带 prefill。
- 公民身份题：内核本来不答，只加回归测试，保证任何路径都不写「是」。
- 每站独立随机密码：`accountAccessProvider.ts` 新注册一律每家生成（`record.sites[site].password`），共用的 `record.password` 只用于此前注册的网站；同时做 11 §3.4 表下的五条保险箱保护。
- 插件本地写死拒绝 LinkedIn、Indeed Apply 和政府招聘站点，不只靠远程 `deniedHostSuffixes`。
- 清理 `apps/extension/assistant/assets/mentors/*.webp`、ArgoLand 品牌、`generic.json` 的 argoland 引用。

### 10B 后端接通（platform-api）

`apps/extension/lib/` 的 `intentClient.ts`、`receiptClient.ts`、`authClient.ts`、`executionRuntimeBundleClient.ts`、`signingConsentProvider.ts`、`profileClient.ts` 指向旧后端 `/api/v1/...`，本仓库没有对应接口。**决定：改插件客户端，集中到 `lib/platformBridge/`，不做兼容旧契约的网关**（约 4.5 万行）。插件的 ES256 校验（`intentVerify.ts`）不变；签发侧把 `services/application-service/src/security/`（约 1,400 行）迁进 platform-api。11 §6.1 的契约与 claim 类型放 `platform-contracts/src/apply.ts`，加一条与 `@edaix/contracts` 的一致性测试。

**鉴权**：`/ext/*` 不挂 `secure` 和账号上下文，用只有 `apply` scope 的 bearer 令牌，Origin 白名单只为这组路由加 `chrome-extension://` 源。

**claim 对照**（`intentVerify.ts` 只接受固定集合）：`missionId` ← `pending_item_id`；`missionRevision` ← 待确认 `revision`；`planDigest` ← `approved_digest`；`approvalMessageId` ← 确认决定 id；`profile.snapshotDigest` ← `/ext/profile` 的组装摘要；`resume.*` ← 已确认 `resume_version`；`target.*` ← 投递关联的 job observation；`consentVersion` ← 授权记录 `recordVersion` 加各问 `wordingVersion` 的摘要；`killSwitchVersion` ← 运行时策略包版本。「页面直填」（03 §10.1）的意图来自已确认的档案与 `resume_version`，不带 `pending_item_id`。

| 能力 | 接口（草案） | 要点 |
|---|---|---|
| 登录交接 | `POST /ext/pairing-codes`（网页）→ `POST /ext/pair`、`/ext/token/refresh`、`DELETE /ext/installs/:id` | 令牌可轮换 |
| 策略包 | `GET /ext/runtime-bundle` | 服务端签名；档位上限 L2；可按域名远程关停；带问题目录的当前版本 |
| 执行意图 | `POST /ext/intents`、`GET /ext/keys` | 私钥只在服务端 |
| 领取 | `POST /ext/intents/claim` | 只能一次，绑定设备和页面，带租约；摘要不一致即拒绝；第二次 409 |
| 回执 | `POST /ext/intents/:id/receipts` | 字段与写入后的状态按 03 §10.3，按回执 id 幂等 |
| 申请资料 | `GET /ext/profile`、`/ext/resume-versions/:id/file` | 由 3A 档案、身份字段、EEO 答案、按国家的工作授权、已确认简历组装 |
| 读授权 | `GET /apply-authorization`（网页）、`GET /ext/apply-authorization` | 网页给 `/me/apply-consent` 和 `read_apply_authorization`（快照、各问当前版本、记录、待补问）；插件只读快照 |
| 改授权 | `POST /apply-authorization/cards`；确认走 03 §9.6 | 设置页只生成卡（`web_settings`），不直接改值；确认时同一事务追加记录；撤回 = 确认一张 `LEAVE_TO_ME` 的卡；Discord 只接受收紧卡 |
| 补问 | `POST /ext/apply-reask` | 填写结束上报问题 id 或映射不到的类别、ATS 域名、时间，不带原文 |

**028 的表**：`platform_extension_installs`、`platform_extension_tokens`（`token_hash`、`scope`、`expires_at`、`refresh_hash`）、`platform_apply_intents`（`pending_item_id` 可空、`entry`：`packet`/`direct_fill`、`approved_digest`、`install_id`、`status`：`issued`/`claimed`/`completed`/`expired`/`revoked`、`lease_until`）、`platform_apply_authorizations`（字段按 11 §6.1，只追加，视图取每一问最新一条；取代原计划的 `platform_apply_signing_events`）、`platform_apply_reask`（`question_id` 或 `unmapped_kind`、`ats_host`、`reported_at`、`closed_at`）、`platform_apply_receipts`（03 §10.3）、`platform_eeo_answers`。

### 10C 对话授权主干

做 11 §6.2 第 1–5、7–20 条，顺序：契约与问题目录 → 存储与确认卡 → 内核按回答与版本合成（必测组合见 11 §6.2 第 2 条）→ 「留给你」与补问 → 投的单聊里的分组提问 → 老用户迁移（旧同意不转成任何「可以」，11 §4.4）。本文补充：
- **在投的单聊里问**（03 §10.2）：主线里投的转发卡 [去单聊回答] 发起；投在单聊里发四组 `auth_question` 提问卡（08 §7.14），按钮只改卡片状态（03 §6.10），自由文字不改设置；问完用 `draft_authorization_card` 发 `apply_authorization` 确认卡，确认后同一事务追加记录（`web_chat`）、照资料作答写进档案。修改同样出卡，Discord 只能收紧，正在填的那一份不受影响。
- **插件**：`signingConsentProvider.ts` 改读 `/ext/apply-authorization`、按策略包的当前版本核对，按 11 §6.1 合成，不是「可以」的一律推入 `LEFT_TO_USER`（带原因）、不写入。浮层不提问：删掉 `signingReconsent.ts` 的一键同意卡和「暂不」的本机记忆，不新增浮层授权凭证，`attestationConfirmBar.ts` 不接线；只做「留给你」高亮和「继续自动填写」（11 §4.7，08 §10.3）。
- **补问**：后端按问题去重，投在投递汇报的转发卡上提醒，学生在投的单聊里一次答完、出一张只含这些问题的卡，同一批一天最多提醒一次。

### 10D、10E

10D：提交卡与 `ApplyReceipt` 四块（11 §4.5）、投递官汇报、浮层换产品 token 与「缄」字印章（08 §10.3）、Workday 条款正文、规则文档同步（11 §6.3，改 `AGENTS.md` 需产品负责人确认）。10E：扩大浮层内提交要改内核识别方式（Ashby、Workday 没有 `<form>`；Lever 有 hCaptcha，不做），是否改「只按原生提交」由产品负责人决定，之前不排期。

### 第 10 步验收

- [ ] 11 §6.2 第 25 条的测试全部通过（含 11 §4.7 的六个用例、Discord 只能写 `LEAVE_TO_ME`）。
- [ ] 聊天里说「都可以」不改授权；只有确认卡确认后才追加记录，卡面改了旧卡作废；填写全程浮层没有授权弹窗。
- [ ] 远程策略包故意不带拒绝列表时，插件在 LinkedIn 和 Indeed Apply 上仍不做任何自动操作。
- [ ] 端到端（field-lab 虚构 ATS 页面）：投的单聊里确认授权 → 确认材料包 → 签发意图 → 领取（第二次 409）→ 「留给你」高亮、不翻页 → 用户点提交 → 回执 → 看板「已投」→ 主线里投的汇报转发卡与补问。
- [ ] cookie 请求访问 `/ext/*` 被拒；插件令牌访问 `secure` 路由被拒；日志和载荷里搜不到密码和原文快照。

**风险**：律师审核前不对外发布（07 P1-1：B3 以「不公开列出」方式只对自愿者开放），确认卡文案与记录方式在审核清单里（11 §7 第 12 条）；必须能按域名远程关停。

---

## 14. 第 11 步 声线接入

按 12。前提：盲测与付费调用已获批准（12 §7），第 8 步护栏已接在朗读和转写上。**范围**：P1-12 = 主理人声线池 + 点按朗读 + 按住说话的一问一答，默认不自动播放；连续语音对话和打断是 P2 评估项。

**改动范围**
- `ai-core/src/elevenlabs.ts` 只认唯一的 `ELEVENLABS_TTS_VOICE_ID`，改为按主理人的 `voice_preset` 查表；`SpeechInput` 加 `voicePreset`；`PlatformProviderRuntime` 加流式朗读方法（12 §5.5）。
- 规范化纯函数 `ai-core/src/speech-text.ts`；领域词条 `career-core/src/voice/lexicon.ts`。
- `restricted` 消息不送 TTS。朗读失败时保持文字并提示「语音暂时不可用」，**不临时换成另一个声音**。
- 声线池由运营离线脚本入池（12 §2.3）。Kokoro 只用于开发：生产不配置 `KOKORO_*`，启动时检查。
- **开源声线 PoC**（与 P0 并行，Codex 负责，07 §3.15）：在 Codex 远程开发机的 RTX 3090 上跑 12 附录 A 的开源候选，进 12 §7 的盲测和低并发压测。先由管理员修好驱动与用户态库版本不匹配（NVML 失败，`docs/platform/cloud-decision.md`）并验收；只用虚构台词，不放用户数据；共享开发机不做生产推理。
- `029_voice_presets.sql`：`platform_voice_presets`（`provider`、`provider_voice_ref`、`provider_model`、`language`、`tags`（温度、语速、直接度）、`role` 只有 `companion_pool`、`design_prompt`、`reference_sha256`、`expression_profile`、`gender`、`age_band`、`status`：`candidate`/`active`/`retired`、`reviewed_at`、`retired_reason`）。面试官声线不进表。

**验收**
- [ ] 客户端无法指定声线；面试官声线不在池里；第一次播放前弹出 12 §6.1 的说明并记用户级 `voice_disclosed_at`。
- [ ] 注入 TTS 故障：消息以文字呈现并提示，没有播放其他声线。
- [ ] TTS 输入不含 `sensitive`、`restricted` 内容；延迟打点只记时间和 id。

**风险**：中文转写准确率未评估；供应商保留政策写进隐私说明；不克隆任何真人（12 §6.2）。

---

## 15. 之后的步骤：P1a 其余项、P1b、P2

### 9B 身份时钟提醒（P1a · P1-3）

- 提醒点默认值作为 `platform_immigration_facts` 的配置行，专业人士审核后才 `approved`；「需核实」项审核前不上线。开关 `PLATFORM_FEATURE_IDENTITY_REMINDERS` 默认关，关着时界面不出现「提醒」二字（字符串检查）。
- 调度 `identity_reminder`（例外额度）：只按用户录入的日期和 `remind_before_days`、`unemployment_reminder_days` 触发。
- 顺延计数只在用户标记「目前没有工作」时按 `unemployment_days_reported` + `reported_at` 显示，标「按你上次确认的数字顺延，仅供参考」，超过 14 天请用户重新确认；倒数默认关闭。不出现任何资格类字段或结论。
- 验收：开关关闭时零提醒；未审核配置行不被引用；时间快进覆盖免打扰与夏令时。

### 9C 被拒之后的信与复盘（P1a · P1-5）

- 满足 3A 的条件时，下一个晨报时间经后台生成写一封 `kind='letter'` 的信（调度 `rejection_letter`），取代当天晨报、占常规额度；7 天最多 1 封，多家合并；三件事最多 1 件、可选。Discord 正文固定为「（主理人名）给你写了一封信」，不写公司名和结果。
- 主理人在被拒满 24 小时后的晨报里提一次复盘邀请，用户接受后由面的转发卡 [去单聊复盘] 进入面的单聊；复盘只给本人看。
- 验收：信里没有 Rejected 和红色；7 天内两家被拒只收到 1 封。

### 9D 面经与作战简报（P1a · P1-4）

- `platform_data_consents`（04 §4.3）；面经进 `platform_org_knowledge_sources`（`asset_class='interview_report'`），导入必须带 `consent_id` 和 `license_id`；`outcome` 只用 `advanced`/`not_advanced`/`offer`/`unknown`/`withheld`。
- 汉字二元切分检索（04 §4.5），recall@5 ≥ 0.8（07 §7.4）。
- `summarize_interview_coverage`：服务端 SQL 统计（公司 × 岗位家族 × 环节 × 季度，n ≥ 3 才给结论），不让模型自己数。
- 作战简报：面试前一天由调度器生成任务卡片，正文由服务端按统计和方法卡渲染，每条结论带出处标签（04 §2.1）；`GET /career/interviews/:id/brief`。P1-4 之前面试官声称「某公司常考」必须为 0。

### P1b（含 P1-C 收费前）

- 规划师 P1-6、技能教练 P1-7：开放 `planner`、`coach`。周报 P1-8：`parent_report` 待确认 + `parent_report_draft`（并入晨报），正文不进 Discord。组织库完整版 P1-9：运营后台、`knowledge_contribution`。蔓藤导师交接 P1-10：`mentor_packet` + `platform_mentor_grants`（03 §11.2），真人导师进独立的 `mentor_room`（03 §11.3）。
- P1-C 收费前（排在 P1-11 之前）：会员与额度页、`platform_plans`、`platform_memberships`、`platform_quota_usage`、产品内收款；额度检查从 `cohort` 切到会员表。
- Web Push P1-14：推送订阅表（10 §9）；`generateSW` 不能加自定义事件，改用 `injectManifest` 或 `importScripts` 加 `push`、`notificationclick`，在这一步决定。

### P2 中与本文相关的四项

| 方向 | 要点 | 依据 |
|---|---|---|
| Discord 社区与队员单聊（评估） | 私人服务器里每位队员一个单聊频道，webhook 以队员的名字和头像发言；需要 Gateway 分片和特权意图 | 10 第 4 节 |
| 批量预填 | 填到检查页、停在提交前、用户逐份提交；`BATCH_PREFILL` 为 `{enabled, dailyCap}`，用户只能调低 | 11 §5.2 |
| App 包壳 | 五个界面稳定、Web Push 上线后评估 Capacitor | 10 第 7 节 |
| 自托管声线 | 每人独有声线加相似度检查，需要 GPU | 12 §2.3、§5.3 |

---

## 16. 冻结的现有代码

冻结 = 不加新功能，不被新代码依赖，测试照常跑，只允许安全修复和本文列出的改动。

- `packages/contracts`（`@edaix/contracts`）：`apps/web`、`platform-api`、`career-core`、`ai-core` 不得引用；插件和内核在 10B 完成前继续依赖。
- `services/application-service`：不部署；10B 迁走 `src/security/` 后删除。`packages/agent-channel`：只允许 10B 的「去领取」通知。
- 工作台（创作工作室、终端与 CLI harness、工作流编辑器、浏览器 Agent 页、外部工具页与 MCP 逐次审批、模型中继）：隐藏，只给员工。`apps/extension/assistant`：不发布。
- `styles.css`、`App.tsx`：只做 08 §10 的替换和删除。冻结列：`platform_conversations.persona`、`mode`，`platform_approvals.conversation_id`。

---

## 17. 工程规范建议

协作方式以 07 第 11 节为准，本节只补工程侧。

1. **走 PR，不直接推 main。** 新建 `.github/pull_request_template.md`（按 07 §11）；`main` 开分支保护：必须走 PR、通过 `verify`、至少一位人工审批。
2. **拆大文件。** `App.tsx`（66 KB）在第 4 步拆完；`app.ts`（48 KB）随各步拆到 `src/routes/*.ts`；`jobs.ts`（54 KB）冻结。单文件建议不超过约 400 行（AGENTS.md）。
3. **lint 与 formatter。** 选型由工程负责人定；提供 `pnpm lint`、`pnpm format:check`；CI 只对 `@companion/*` 强制，插件和内核先只报告；一次性格式化单独成 PR，写进 `.git-blame-ignore-revs`。
4. **转私有后的 CI 分钟数。** 走 PR 后很可能超出套餐（假设，用 `gh run list` 统计验证）。办法：只改 `docs/` 不跑；插件与内核测试只在 `apps/extension`、`packages/apply-*`、`packages/contracts` 变化时跑；拆「平台」「插件」两个 job；合并后插件全量测试每天一次。改 CI 时同步改 `scripts/ci/check-extension-field-lab-wiring.mjs`（它逐字检查 `ci.yml`）。
5. **测试。** 新服务配假 runtime 的集成测试；花钱的评测不进 CI；纯函数、上下文组装、额度规则、状态机、出站过滤、身份数字校验、危机模板必须进 CI。

---

## 待确认问题

1. **工作台代码的去留**（产品负责人）：创作工作室、终端、工作流只留给员工，还是在首批复盘（2 月中旬）后删除代码？不回答时默认只给员工、代码保留。
2. **GitHub 套餐与 CI 预算**（产品负责人）：转私有后用哪个套餐？是否接受按路径过滤、插件全量测试改为每天一次？不回答时按第 17 节第 4 条做。
3. **协作规则写进 AGENTS.md**（产品负责人）：是否同意把 07 第 11 节的约定（走 PR、不推 main、分支命名）写进根 `AGENTS.md`？它是 Codex 每次都会读的共享规则。
