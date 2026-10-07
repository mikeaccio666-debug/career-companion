# 15 主理人 Agent 与对话引擎

> 状态：v1 草案，依据产品负责人 2026-10-07 的决定（主线 + 转发卡 + 单聊）｜日期：2026-10-07｜适用：第一批真实用户
> 属于 `docs/product/` 产品事实来源，Codex 按此实现。代码基线 `e1ba2a4`；引用写「文件 + 函数名」；分期以 07 为准。
> 示例用户林舟（01 Persona A），「墨」是他给主理人起的名字；Acme Pay、Initech 是虚构公司。

## 这份文档回答什么问题

主理人怎样像一个全能求职助理（像 Codex 那样的 agent）工作：循环怎么跑，技能、知识库、MCP 和后台任务怎么接进来，怎么请队员，怎样做到丝滑，以及落到哪些代码。

**结论**
- 一个引擎，多个房间。主线里只有主理人一个 agent 在跑；队员是同一引擎换上人格卡、技能、工具白名单和记忆范围的子 agent，经 `consult` 被请来，或在自己的单聊里接话。没有路由模型调用。
- 能力登记在能力目录（§4.7）：提示词只放索引，用到才加载；权限由代码核，模型只能提议，对外一律进待确认。
- 一轮就是一个循环：只读并行、草稿串行；每步有进度短语；新消息在下一步并入；「停下」立即生效，断线不取消；超过约 30 秒的工作转后台。
- 丝滑标准（假设，B0 实测后收紧）：首个可见反馈 P50 ≤ 1 秒；主理人第一句 P50 ≤ 3 秒、P95 ≤ 8 秒；转发卡第一句 P50 ≤ 6 秒、P95 ≤ 15 秒；后台任务每 ≤ 10 秒更新进度。
- 底线不在本文重述，只规定引擎在哪一步调用：危机（02 §10）、输出校验（02 §3.4、03 §6.8）、待确认（03 §9）、插件授权（11）。

只引用、不展开：房间与消息模型（03 §6）；谁接话、叫名字（03 §4）；记忆（03 §8）；队员与工具白名单（03 §1–§3）；费用（06 §12）；组件（08）；实施（09）；Discord（10）。

---

## 0. 本文的决定（E1–E10 是本文编号）

| # | 决定 |
|---|---|
| E1 | 主理人与队员共用一个循环 `runAgentLoop`，区别只在人格卡、技能、工具、记忆范围和预算 |
| E2 | 谁接话由 03 §4.1 的确定性规则加主理人自己的循环决定；叫名字不调用模型 |
| E3 | 工具调用按效果分组：只读并行，草稿串行，结果按调用顺序交回；出错作为数据交回模型；到上限时最后一步关掉工具、说清做到哪了 |
| E4 | 进度短语由服务端生成，模型开始写工具调用就发出；界面不出现工具名、模型名、供应商 |
| E5 | 生成中的新消息在下一步并入同一轮；「停下」与「发送」分开；断线不取消 |
| E6 | 能力目录是唯一挂载入口；工具定义顺序固定，只用允许集合屏蔽 |
| E7 | `consult` 只有一层；结果以转发卡出现，卡里是队员原话 |
| E8 | 超过约 30 秒的工作转 `agent` 后台任务，只读和起草，可从检查点续跑 |
| E9 | 模型按用途配置档位、上限和超时；失败如实呈现；租约按轮次，记账键（轮次、段、尝试、调用序号）加 `purpose` |
| E10 | 上下文稳定的在前、变化的在后；历史按块滑动 |

---

## 1. 什么叫丝滑：体验标准与指标

### 1.1 用户感受到的标准（假设）

| 场景 | 用户看到 | 标准 |
|---|---|---|
| 发出消息 | 气泡立刻出现，随后「墨 正在输入…」或进度短语 | 首个可见反馈 P50 ≤ 1 秒、P95 ≤ 2 秒 |
| 主理人回答 | 逐句出现，每句已过校验 | 第一句 P50 ≤ 3 秒、P95 ≤ 8 秒 |
| 主理人去查东西 | 短语随步骤变（「墨 在翻你的旅程…」→「墨 在资料库里找宣讲笔记…」） | 开始写工具调用后 ≤ 300 毫秒 |
| 请队员、叫名字 | 引子（如有）→ 卡头「转自 前 · 前辈 · AI」→ 卡内短语 → 出字 | 卡头 P50 ≤ 1.5 秒；第一句 P50 ≤ 6 秒、P95 ≤ 15 秒 |
| 长任务 | 任务卡持续更新，可以接着聊 | 每 ≤ 10 秒更新 |
| 生成中又发一条 | 灰色「排队中」，下一步并入后恢复 | 并入 P50 ≤ 4 秒 |
| 点「停下」 | 立刻停，末尾「已停下」，做完的草稿保留 | ≤ 1 秒 |
| 关页面、断网、换设备 | 回来看到完整或仍在继续的回答 | 0 丢失、0 重复 |
| 失败 | 「没接上 [重试]」，已显示的句子保留 | 无替代文字 |

依据：0.1、1、10 秒是公认的响应时间界线；短语只写真实步骤。

### 1.2 指标定义

从服务端「用户消息落库提交」（03 §4.1 第 1 步）或按钮点击到达起算；客户端另报「点发送到首个可见反馈」。

| 指标键（目标见 §1.1） | 终点 |
|---|---|
| `first_feedback_ms` | 第一个 `typing`、`tool_started` 或 `start` |
| `companion_first_sentence_ms`；`card_first_sentence_ms` | 主理人第一句；转发卡第一句（按队员拆），都指过校验后写出 |
| `task_progress_gap_s` | 后台任务相邻进度的最大间隔 |
| `interjection_join_ms`；`stop_ms`；`resume_loss` | 插话进入下一步；停下到最后一个 `delta`；重连丢失或重复的事件 |
| `cache_hit_ratio` | `cached_input_tokens / input_tokens`，同一房间第二轮起；目标 ≥ 60%（假设，06 §12.5 按 70% 估算） |

时间写在轮次行（03 §6.5），运维自检每分钟汇总（13 §6.3）；每轮另记步数、按效果分的工具调用、按用途的 tokens、工具失败与校验拦截，只存数字和枚举。

**验证**：引擎测试用注入的假 runtime（`AppOptions.runtime`，只实现 `streamModelStep`，§12.2）给每步加可控延迟，验证事件顺序与计时；09 第 1 步 PR3 前，主理人和 P0 三位队员各跑 30 段虚构脚本的小规模真实模型测试（产品负责人 2026-10-07 已批准）：先用低价档（docs/platform/cloud-decision.md 附录的低成本开发档）跑全部脚本，量路由规则、转发卡逐字、校验器误杀和每轮调用数；再用正式档对同一批脚本抽 20 段，比较延迟和质量，为 §7 的按用途分档提供依据。只在预发或 Codex 远程开发机上跑，密钥只在服务端，只为这次测试显式打开商业调用；总花费假设 < $20，先跑 10% 按实际花费外推；B0 两周后按实测调整，同步 07 §7.4、13 §6.7。

---

## 2. 总体结构

### 2.1 一条消息走过的路

```
用户消息 → ConversationTurns.submit → 落库（clientMessageId 幂等）→ 立即发 typing，开始同步安全分级
  → 纯规则：房间有运行中的轮次 → 插话（只分级，202，§3.5）；否则谁接话（03 §4.1）
  → 建轮次、取租约、CostGuard.reserve → 预取并组装上下文（档案、旅程、记忆、技能索引）
  → 第一次模型调用 ‖ 分级仍在进行（L0 之前只有 typing，不出字、不执行工具）
      ├─ L1 / L2 → 取消调用、释放租约与预留 → 02 §10.3
      └─ L0 → 放行
            ├─ 主线 · 其余消息 → 主理人循环（§3）→ 能力（§4）/ consult（§5）/ 后台任务（§4.6）
            ├─ 主线 · 叫名字、回复转发卡、点卡上按钮 → 该队员 → 转发卡
            └─ 单聊、面试间 → 该队员循环（§5.5）
  → TurnSink → 事件表 + SSE / 订阅流 / Discord（§8）
```

分级在落库后立即开始，与建轮次、组装上下文重叠；第一次模型调用在租约、额度预留和上下文之后才发出，L0 之前只发 `typing`，不放出文字和进度短语、不执行工具，L1、L2 时取消。分级的约 1 秒因此大多不叠在第一句上。

### 2.2 两种 agent

| | 主理人 | 队员 |
|---|---|---|
| 在哪跑 | 主线 | 主线（转发卡）、自己的单聊、面的面试间 |
| 人格 | 说话方式卡（02 §3） | 人格卡 + 示范台词（03 §1.3） |
| 技能与工具 | 自己的技能（P0：career-intake）+ 引擎工具 | 03 §3.1 归它的技能；03 §2.7 该列 |
| 记忆 | 03 §8.5 主理人范围 | 03 §8.5 该队员范围；`sensitive` 只经交接便条 |
| 请别人、后台任务、主动找用户 | 能（主动按 02 §9） | 不能请人，只能放按钮；后台只限自己技能的模板；不主动找用户 |

「是谁」由服务端构造的 `AgentProfile {speaker, personaRevision, skills[], toolMask, memoryScope, budgets}` 决定。

### 2.3 房间

`kind` 与字段以 03 §6.2 为准。

| 房间 | 谁在跑 | 引擎规则 |
|---|---|---|
| 主线 `main` | 主理人；被叫或被请的队员 | 一轮最多「主理人引子 → 一张转发卡」；主理人主动请人每轮 ≤ 1 位（P0，假设）；一句话叫两位按顺序出两张卡 |
| 单聊 `expert_room` | 该队员 | 没有路由，主理人不在；结论以转发卡回主线 |
| 面试间 `interview` | 面 | 入口在面的单聊里；小结以面的转发卡回主线 |
| 导师房间 `mentor_room` | 不自动运行 | 03 §11.3 |

每个房间同时最多一个运行中的轮次（03 §6.5）；每用户 2 个 chat 租约，主线和一个单聊可以同时在跑。晨报等「后台生成」（09 第 2 步）是一次生成；本文的「后台任务」是 worker 里的多步运行（§4.6）。

---

## 3. Agent 循环

### 3.1 一轮的步骤

1. **落库**（03 §4.1 第 1 步），立即发 `typing`，同时开始同步安全分级（02 §10.2）。
2. **纯规则**（毫秒级，不调模型）：房间已有 `running` 轮次 → 插话：只分级，返回 202，不发模型调用（§3.5）；否则按 03 §4.1 第 5 步定谁接，单聊里永远是该队员。
3. **新轮次**：建轮次、取租约（租约 id 即轮次 id）、`CostGuard.reserve`（06 §12.3）。`degrade` → 主理人不主动 `consult` 而是先问，后台降到经济档；`block` → 一步简短回答，不挂工具。
4. **预取并组装上下文**（§6），算出允许集合（§4.7）。预取含该技能上次 `prepareCareerRun` 已解析的输入，直接进上下文，省一步读工具。
5. **分级 ‖ 第一次模型调用**：分级返回 L0 之前只发 `typing`，不发 `delta`、`tool_started`，不执行任何工具调用（含 `read`）；L1、L2 → 取消调用、释放租约与额度预留，按 02 §10.3。
6. **循环**，每步一次模型调用：文字按句缓冲、整句过校验（02 §3.4）后发 `delta`；开始写工具调用就发 `tool_started`；这一步结束按 §3.2 执行，各发 `tool_finished{ok}`；步间钩子并入插话、重算允许集合、检查停下、抢占、预算和时间；有 `endTurn` 或不再调工具就结束。
7. **收尾**：只把已校验的文字落库；`done`、`turn_done`；`CostGuard.commit`；写工具摘要（§4.3）；释放租约；有排队轮次就接着跑。

新文件 `packages/ai-core/src/agent-loop.ts`：

```ts
export async function* runAgentLoop(adapter: ProviderAdapter, input: ChatInput, ctx: AgentLoopContext): AsyncGenerator<AgentEvent> {
  for (let round = 1; ; round++) {
    const last = round >= ctx.limits.maxRounds || ctx.toolCalls() >= ctx.limits.maxToolCalls || ctx.overDeadline();
    const tools = last ? [] : await ctx.resolveTools();          // 每步重算允许集合
    yield { type: 'round_started', round };
    const out = yield* adapter.stream(input, { tools, toolChoice: last ? 'none' : 'auto',
      maxOutputTokens: ctx.limits.maxOutputTokens, signal: ctx.signal });
    if (!out.calls.length) {                                      // 最终回答
      const more = await ctx.drainInterjections();                 // §3.5：写完再多走一步
      if (!more.length || round >= ctx.limits.maxRounds + 1) return;
      input = appendRound(input, out, [], more); continue;
    }
    const results = yield* executeGrouped(out.calls, ctx);         // §3.2
    if (results.some(r => r.endTurn)) return;                      // consult、ask_user
    input = appendRound(input, out, results, await ctx.drainInterjections());
  }
}
```

单次供应商调用是 ai-core 的 `streamModelStep`，有 OpenAI Responses 和 OpenAI 兼容两个实现，把现有的请求拼装、`readSse`、`usageCollector` 与 `onModelCall` 原样搬进去；`ProviderAdapter` 只包装 `runtime.streamModelStep`（§12.2）。

**计划**：预计 3 步以上时，主理人先调 `update_plan({steps[]})`，每项一句白话。计划不作为消息展示，只决定短语顺序、作为后台任务卡的步骤；每步前把未完成项放进本轮变化层（§6.1），防止多步任务跑题。

### 3.2 并行与串行

| 效果 | 例子 | 执行 |
|---|---|---|
| `read` | 读档案、旅程、记忆；检索；只读 MCP；`use_skill` | 同一步内 `Promise.all`，结果按调用顺序交回 |
| `draft` | `save_resume_draft`、`draft_outbound`、`propose_memory`、`schedule_reminder` | 在 `read` 之后串行；幂等键 = 轮次 id + 调用 id |
| `act` | 交给插件、产品内寄出 | 学生端发言者没有；只在确认后由服务端执行（03 §9.4–9.5） |
| `consult` | 请队员 | 每步 ≤ 1，返回 `endTurn` |
| `ask_user` | 「要我请前辈看看第一屏吗？」+ ≤ 3 个按钮 | 返回 `endTurn`；按钮（08 §7.4）可预置 `consult` 或 `start_task`，点了直接执行 |
| `background`、`none` | `start_background_task`；`update_plan` | 立即返回任务 id；只写轮次记录 |

被跳过的调用（超上限、第二个 `consult`、权限不对）各回一个 `{error:{code, message}}`，message 写成模型能照着改的话。只有取消、租约丢失、记账失败（`USAGE_RECORD_UNCONFIRMED`）终止一轮；同参数失败两次的工具移出允许集合。

### 3.3 预算（假设）

| 场景 | 步数 | 工具调用 | 单步输出上限（tokens） | 前台墙钟 |
|---|---|---|---|---|
| 主线 · 主理人 | 6 | 12 | 1,500 | 45 秒 |
| consult（含叫名字、回复卡、按钮） | 6 | 12 | 4,000；写草稿 12,000 | 45 秒 |
| 单聊 · 队员 | 8 | 16 | 4,000；写草稿 12,000 | 90 秒 |
| 面试间逐题 | 3 | 4 | 1,200 | 30 秒 |
| 后台任务 | 30 | 60 | 8,000 | 10 分钟 |

到上限时下一步 `toolChoice:'none'`，提示「说清做完了什么、还差什么」；墙钟到了且计划未完成，消息末尾附 [转后台继续]。`prepareCareerRun` 的 `maxToolCalls: 12`、`maxModelTurns: 6` 与上表取小。推理 tokens 也算进输出上限，写草稿最容易触顶（§10）。**验证**：B0 统计步数分布，触顶 > 5% 放宽；单步截断 > 1% 加大。

### 3.4 进度短语

- 来自目录条目的 `progressPhrase` 模板，槽位只用 `normal` 敏感度的参数：`read_resume_version`「{speaker} 在对照 {company} 的 JD 看你的第一屏…」；`search_knowledge`「{speaker} 在资料库里找…」。槽位没写完先用不带槽位的版本。
- OpenAI 路径在 `response.output_item.added`（`function_call`），兼容路径在第一个带 `tool_calls` 的增量就发 `tool_started`，不等这一步结束。
- 并行调用按 `phraseGroup` 合并成一句。工具结束后气泡底部留一行可展开的「依据」（「看了：你的旅程 · 资料库 2 段」），只列来源类别和出处标签。

### 3.5 插话、停下与抢占

**输入框**有字时是「发送」，空且有轮次在跑时是「停下」（08 §7.4 按此改）。

**插话**（L0）：照常落库、分级，返回 202 `{turnId, queued:true}`，气泡灰色「排队中」；在下一个步间钩子并入（追加在本步工具结果之后），发 `interjection_joined`，进行中的工具调用不取消。正在写最终文字的那一步先写完，再多走一步把新消息带进去；这一步不计入 `maxRounds`，最多一次，仍有插话就开新的排队轮次。`consult` 正在出卡时卡照常写完，插话由主理人下一轮接；若是回复这张卡或叫这位队员，就并入队员的下一步。跨渠道同一规则（10 §3.12）。

**停下**（03 §6.10 的 cancel 接口）：中断当前模型调用、进行中的 `read` 和 `consult`；已提交的 `draft` 保留；消息保留已校验的句子并标「已停下」；后台任务不受影响。不发替代文字。**断线**不取消（03 §6.5），经订阅流续上（§8.2）。

**抢占**：L1、L2 立即中断任何轮次和 `consult`（02 §10.2）。轮次行带取消标志，循环在每步开始、每写出一句前检查。P0 的 API 只有 1 个实例（13 §3.1），用进程内 `AbortController`；P1-2 的 Discord 进程上线后经 LISTEN/NOTIFY 通知持有轮次的进程，≤ 1 秒。

**重试**：出字前遇到 `PROVIDER_UNREACHABLE`、`PROVIDER_STREAM_INTERRUPTED`，1 秒后自动重试 1 次（新「尝试」号）；出字后中断不自动重试，保留已显示的句子并给 [重试]；校验不通过走部分通过（§5.4）；用户点 [重试] 开新轮次指向原用户消息，不再插入用户消息。

### 3.6 示例：主理人用技能、知识库和后台任务（P0）

```
林舟：我把三门课的项目报告传上来了，帮我理理哪些能写进简历。
      还有，Acme Pay 的宣讲我在资料库里记了笔记，他们后端 new grad 看重什么来着？   [3 个 PDF]
（0.4 秒）墨 在翻你的资料库和旅程…
  第 1 步（并行）use_skill(career-intake) · search_knowledge("Acme Pay 宣讲 后端") · read_journey()
  第 2 步 start_background_task(project_facts_from_uploads)
墨：  你 9/18 的宣讲笔记里记了两点：看重「线上故障的排查经历」和「能讲清一次取舍」。
      〔你的资料库 · Acme Pay 宣讲笔记 · 第 2 段〕
      三份报告我放到后台整理了，大约 2 分钟，好了在这里出一张卡。你可以接着聊。
  ┌ 任务卡 · 整理 3 份项目报告 · 读出文字 3/3 · 正在找项目事实 2/3  [停止]
（2 分 10 秒后，ConversationTurns.post）
  ┌ 任务卡 · 整理好了：3 个项目、11 条事实已作为提议放进旅程；4 条缺数字，我空着
  │ [逐条看]  [请前辈挑进简历]
```

第 1 步三个 `read` 并行；`use_skill` 让 career-intake 的工具在第 2 步可见；只引用本轮返回的段落；报告解析超过 30 秒，转后台；事实只作提议（03 §8.4）；[请前辈挑进简历] 预置 `consult(guide)`。

---

## 4. 能力层

新增能力 = 一条目录记录（§4.7）+ 一个执行器 + 一套评测（§11.2），不改循环。

### 4.1 技能

**清单**（扩展 `packages/career-core/src/contracts.ts` 的 `CareerSkillDefinition`，`skills.ts` 的 `CAREER_SKILLS` 改为清单）：

| 字段 | 说明 |
|---|---|
| `id`、`revision`（数字）、`owner`、`phase` | 发言者 key；07 编号与功能开关 |
| `whenToUse` | ≤ 80 字，触发词在前（「用户上传简历、要改简历、问为什么没回音时用」） |
| `instructions` | 完整做法，用到才加载，≤ 5,000 tokens（假设） |
| `requiredInputs`、`tools`、`outputs`、`reviewCriteria` | 沿用；`tools` 用 03 §3.4 改名后的名字 |
| `outputContract` | JSON schema。「做完了」由规则判断：保存类工具成功、产出通过 schema、不以问句结束；不让模型读 `stopWhen` 的文字 |
| `methodRefs`、`invocation`、`expectedSeconds`、`evals` | 方法卡 `{methodId, revision}`（04 §3.4）；`model` / `user` / `both`；> 30 秒走后台；评测集 id |

**渐进加载**：
1. 索引：可用技能的 `id: whenToUse` 放稳定层（§6.1 第 5 层），预算为上下文的 2% 或 8,000 字取小（假设）；超了先截短，再按 `phase` 由晚到早去掉并写日志。
2. 正文：`use_skill({id})` 只接受 `owner` 等于当前发言者的技能，否则 `TOOL_NOT_ALLOWED`；→ 新建 `services/platform-api/src/career-run-context.ts` 的 `buildCareerRunContext` → `prepareCareerRun`。`ready_for_draft` 时返回说明、已解析输入的摘要、方法卡摘录，并把技能的工具加进允许集合（技能 `tools` ∩ 03 §2.7 该发言者白名单 ∩ 分期开关）；`blocked` 时返回 `reasons`，由谁问按 03 §3.3。
3. 方法卡全文、样例用 `read_skill_reference({id, ref})` 再取。斜杠命令（`/改简历`、`/模拟面试`）和按钮直接触发技能，不经模型选择；斜杠命令按技能 `owner` 交给该队员（等同卡上按钮，出转发卡，没有引子）。

每次使用冻结技能、方法卡、知识批次的版本与输入（写进 `platform_expert_runs`，§5.1、03 §6.5）。

**蔓藤方法卡也是技能**：同一形状，存组织库（04 §4.3），`source:'org_method'`，编辑与审核分离发布后才能加载；只描述做法，不能授予工具或改权限。技能只来自 career-core 和已审核的组织库。加一个技能要有清单、输出契约、≥ 20 条评测任务、已上线的 `owner`、有 `license_id` 的方法卡，产品负责人看过评测再开开关。

### 4.2 知识库

| 来源 | 现有代码 | 用法 |
|---|---|---|
| 私人资料库 | `KnowledgeSources`（014；每份 64 KB、每人 200 份、每段 ≤ 1,200 字） | `search_knowledge`、`read_knowledge_passage` |
| 蔓藤组织库 | 新建 `OrgKnowledge`（04 §4.4） | `search_org_knowledge`、`read_org_knowledge_passage` |
| 上传的文件 | `saveUpload`；新建 `document-text.ts` | 抽取文字是新能力（09 §3A；`readArtifactText` 现在拒绝 PDF）：P0 只抽 PDF 文字层，扫描件抽不出时如实说并请用户粘贴；超过 64 KB 按页拆成多份来源，存进私人库，之后靠检索；图片只在上传那一轮发给模型 |
| JD 原文；外部来源结果 | 岗位观察（09 第 3A 步）；MCP 私有结果 | `read_journey`（sponsorship 原句见 03 §2.6）；后者是 `untrusted_mcp` 数据，不是知识库 |

**统一端口**：`services/platform-api/src/career-knowledge.ts` 实现 `CareerKnowledgePort.search`，合并两个库（04 §4.6）。每段带 `{sourceId, revision, passageId, scope, assetClass, provenanceLabel, text}`，每次 ≤ 8 段、≤ 48 KiB（沿用现有常量）。

**出处是契约**：引用的 `passageId` 必须本轮检索返回过（03 §6.8 第 4 条），否则删掉重写一次；出处标签由服务端渲染（04 §2.1）；库里没有就说没有，不出现出处标签（07 §7.4）。

**中文召回**：组织库按 04 §4.5（P0 结构化筛选，P1-4 起两字切分）。私人库查询含汉字时退化为整句 `ILIKE`（假设召回差），P0 先写 30 条中文夹具，recall@5 < 0.8 就用同样的两字切分加一列 `tsvector`。

### 4.3 内部工具

求职工具的名字、谁能用、分期以 03 §2.7 为准；本节定效果分类。

| 组 | 工具 | 效果 |
|---|---|---|
| 记忆 | `search_memories`；`propose_memory` | read；draft |
| 求职数据 | `read_profile`、`read_journey`、`read_evidence`、`read_stories`、`read_resume_version`；`propose_journey_update` | read；draft |
| 草稿 | `save_resume_draft`、`save_story_draft`、`save_plan_draft`、`save_practice_record`、`draft_outbound`、`draft_authorization_card` | draft |
| 提醒与日程 | `schedule_reminder`；日历只读（P2） | draft；read |
| 引擎 | `use_skill`、`read_skill_reference`、`read_task_result`、`consult`、`ask_user`、`start_background_task`、`update_plan` | 见 §3.2 |

**结果写给模型看**：人能读的标识（「简历 后端-v2」）加 id；默认精简，`detail:'full'` 才给全文；单个结果 ≤ 16,000 字（假设），超了截断并提示怎么缩小；错误写成能照着改的话（「这个版本已归档，最新的是 后端-v3」）；复杂参数给 1–3 个调用示例。

**工具摘要**：每轮结束写一条不显示的摘要（每个调用 ≤ 300 字，只含对象标识和结论），用 001 已允许、现在没人写的 `role = 'tool'`（字段归 03 §6.4），下一轮随历史进上下文，agent 才记得自己查过什么。`GET /conversations/:id/messages`、订阅流重放、Discord 与导出一律过滤 `role='tool'`（只供上下文组装读取）。

### 4.4 MCP 外部工具

治理沿用 03 §2.8 与 09 第 3D 步；加一个来源 = 一条审阅过的目录条目 + 授权白话 + 评测任务。外部来源只读，要写的只能产生待确认对象。引擎侧：

- **轮内同步调用** `McpConnections.callInTurn(binding)`：复用 `normalize`、`compileMcpSchema` 和回执写入，不经 job 和审批，不占 `PLATFORM_MAX_ACTIVE_JOBS`；授权用 `assertStandingGrant`（授权记录版本 + 分配表 + `policy_hash` + 轮次租约）。
- **挂载名**：目录 id `ext:<catalogId>/<tool>`；函数名不允许冒号和斜杠，给模型的是 `ext_<catalogKey>__<tool>`，执行前映射回去再核一次。
- **时限**：单次 8 秒（假设，03 §2.8），一轮外部调用合计 ≤ 20 秒（假设）；超时那一行变成「这次没查到」，其余照常。长时间的来源走后台任务，进度可续期，总时限照样执行。
- 工具描述与注解只有目录审阅过的才可信。没授权时不调用、不弹窗，在要用该来源的队员单聊里补问（主理人的在主线，03 §2.8），主线最多一张该队员的转发卡提醒。

### 4.5 执行器

- **浏览器插件**是投在用户电脑上的执行器（11，03 §10）。引擎从不驱动插件：投起草 `application_packet`，用户确认后插件领取；投只用 `read_apply_authorization`、`read_apply_receipts`、`draft_authorization_card`。回执到达后服务端在主线写一张投的转发卡：由服务端模板以投的名义渲染（不调模型，`platform_expert_runs.mode = receipt_report`）；同一天合并时写新版本并重算 `bodyDigest`（11 §4.6）。
- **工作台执行器**（`executeCli`、`executeBrowser`、`executeWorkflow`）只给员工跑评测和内容导入检查，学生端一律不挂。公开职位页兜底见待确认第 3 条。

### 4.6 后台任务

**何时**：`expectedSeconds > 30`；墙钟到了，用户点 [转后台继续]；用户说「慢慢弄，好了叫我」。

**起**：`start_background_task({template, inputs, brief})` → `JobService.create` 建 `kind = 'agent'` 任务（照 015 加 `mcp` 的做法改 CHECK、`JOB_KINDS`；`parseJob` 不接受 `agent`，新建 `parseAgentJob` 只由 `start_background_task` 与卡上 `start_task` 的服务端路径调用；`POST /jobs`、`POST /jobs/:id/retry` 对 `kind='agent'` 返回 403 `AGENT_TASK_SERVER_ONLY`；重试走任务卡上的 [重试]，新建任务、重新分级与 `CostGuard.reserve`）；来源由 `saveConversationTaskOrigin` 在轮次内写入，`authorizeConversationTaskOrigin` 改为核轮次（§12.2）。立即返回任务 id，主线出任务卡（08 §7.8）。

**跑**：`processJob` 加 `executeAgentRun`（新建 `agent-run.ts`）：`runAgentLoop`、`purpose = 'background'`，只放 `read`、`draft`、`none`；MCP 只用含 `background` 用途的授权（P2）。每步写检查点（照 `applyWorkflowCheckpoint`），`draft` 带幂等键；中断后 `recoverInterrupted` 对 `agent` 任务从检查点续跑，不标 `uncertain`，连续两次中断才失败。任务行加 `progress_label`、`progress_at`，每步开始和每 ≤ 10 秒写一次，经事件流推送。每用户同时 ≤ 2 个（假设），单独计数，不占 `PLATFORM_MAX_ACTIVE_JOBS`；先 `CostGuard.reserve`，用 `background` 租约。

**收尾**：`ConversationTurns.post` 在原房间写结果卡（队员起的就是转发卡），产出只能是草稿、提议或摘要；失败时如实写「没做完：读不出第 3 份报告的文字，可以粘贴给我 [重试]」。结果卡不推送、不占主动额度；用户说过「好了叫我」时按 02 §9.2 `user_requested` 例外推送一次（待确认第 2 条）。`post_crisis` 覆盖期内，后台结果卡、单聊结论卡和用户没在等的转发卡（投的汇报、补问提醒）都暂存，用户自己回到求职话题时再出现（02 §10.3 第 1、6 步）。

**P0 模板**（假设）：`project_facts_from_uploads`（主理人：抽取报告与简历文字，产出证据提议）；`saved_jobs_scan`（投：收藏岗位逐个对照当前 `active` 简历，只引用 JD 原文）；`resume_full_pass`（前：两页以上简历逐条改，产出 `resume_version` 草稿）。P1-4 加 `interview_brief`（面）；P2 加 `job_triage`（投）。每个约 $0.15（平均约 8 步，假设，06 §12.5）。

### 4.7 能力目录与权限矩阵

纯数据放 `packages/career-core/src/capabilities.ts`，执行器注册在新建的 `services/platform-api/src/capabilities.ts`（`toolsFor(profile, room, phase)`、`executorFor(id)`），取代 `app.ts` 的 `safeTools` 与 `executeTool` 的 if 链。条目字段：`id`、`kind`、给模型的定义与示例、`effect`、`speakers[]`、`rooms[]`、`phase`、`progressPhrase`、`phraseGroup`、`timeoutMs`、`maxResultChars`、`alwaysVisible`、`evalSet`。

**可见工具**：一轮开始时允许 ≤ 20 个（假设）；每位发言者 3–5 个核心工具常驻（主理人：`read_journey`、`search_memories`、`use_skill`、`consult`、`ask_user`），其余随 `use_skill` 加入。工具定义整份发送、中途不增删，用 `tool_choice` 的允许工具列表屏蔽；不支持的兼容供应商只发子集。

**执行时再核一次**（`TOOL_NOT_ALLOWED`，作为数据交回）：发言者 × 房间 × 分期开关 × 效果（后台任务不允许 `consult`、`ask_user`）× 外部来源授权。模型只能提议，权限以代码为准（越权调用的评测见 §11.2）。

**权限矩阵**（按能力类别；逐个求职工具见 03 §2.7；导师房间里 AI 不运行）：

| 能力 | 主理人 | 队员（转发卡、单聊） | 面试间 | 后台任务 |
|---|---|---|---|---|
| 读档案、旅程、记忆 | ✓ | 按 03 §2.7、§8.5 | 面：档案 `normal` 字段 | 同发起者 |
| `search_memories` | ✓ | 只查 `normal`（新增） | — | 同发起者 |
| 私人资料库 | ✓ | ✓ | — | ✓ |
| 组织库 | 按 04 §4.4：只检索课程目录（P1b）；方法卡经 `use_skill`／`read_skill_reference` 加载（§4.1），话术只作对话模式卡注入（04 §3.8），都不检索 | 按 03 §2.7 | 题库 | 同发起者 |
| 草稿与提议 | 03 §9.1 允许的类型；提议 | 按 03 §2.7、§9.1 | `save_practice_record` | 同发起者 |
| `use_skill`、`ask_user` | ✓（自己的技能） | ✓（自己的技能） | ✓ | 模板指定；无 `ask_user` |
| `consult` | 每轮 ≤ 1 | — | — | — |
| `start_background_task` | ✓ | 自己技能的模板 | — | — |
| MCP 只读 | 按 03 §2.8 分配表与授权 | 同左 | — | 授权含 `background`（P2） |
| 插件；工作台执行器 | —；— | 投：只读授权与回执；— | — | — |

03 §2.7 已按本表对齐：队员只查 `normal` 的 `search_memories`（新增）；主理人只检索课程目录；`start_background_task` 给有模板的前、投、面；`consult` 取代 `invite_expert`、`dismiss_expert`；卡上按钮取代 `suggest_handoff`。

---

## 5. 队员子 agent

### 5.1 `consult`

只有主理人能调；叫名字、回复转发卡、点卡上按钮走同一个执行器，简报由服务端直接生成。

```ts
consult({ expert: 'guide',                                 // EXPERT_KEYS，必须已上线
  objective: '看林舟后端简历的第一屏，为什么 30 个零回音',     // ≤ 60 字
  mode: 'task',                                           // 'advise'：只给意见，不起草
  outputContract: 'resume_version', boundaries: ['不编数字'], skillHint: 'resume-revision' })
```

**执行**（新建 `services/platform-api/src/expert-runner.ts` 的 `runExpert(expertKey, brief, turn)`）：
1. `task` 时先跑该队员技能的 `prepareCareerRun`；`blocked` 时按 03 §3.3：主理人 `consult` → 不出卡，`reasons` 交回主理人，由主理人问；叫名字、回复卡、点卡上按钮 → 照常出卡，队员按 `reasons` 套模板问缺的那一项。
2. 服务端补全简报：交接便条（§5.2）、已解析的输入、触发这轮的那条用户消息（叫名字、回复卡时即用户原话）、这位队员上次的 `result_summary`（03 §6.5）；不给主线历史（03 §6.8）。
3. 用队员的 `AgentProfile` 跑嵌套的 `runAgentLoop`，经同一个 `TurnSink` 写进一条转发卡消息（字段与 `bodyDigest` 约束见 03 §6.4），做法同现在路由里 `send('approval')` 的闭包。
4. 交回主理人的只是 `{cardMessageId, status, summary, endTurn: true}`，`summary` ≤ 200 字，由模板拼出产出与未决项，同时写进 `result_summary`。

参数一写完（OpenAI 路径 `response.output_item.done`）就开始第 1、2 项，引子同时在流。队员的允许集合里没有 `consult`，该找别人就在卡上放按钮；预计超过 30 秒时队员在卡里说明并转后台。

**冻结记录**：每次运行写一行 `platform_expert_runs`（字段归 03 §6.5，取代原参与者表的 `run`）：技能、人格、方法卡、知识批次的版本，04 §4.6 的 `org_scope` 与 `entitlement_id`，输入引用，prepare 结果，只有 id 和版本；转发卡以 `expert_run_id` 指向它。

### 5.2 交接便条

纯函数 `packages/career-core/src/team/handoff.ts` 的 `buildHandoffNote({memories, preferences, objective, lastResultSummary})`，**不调用模型**：只取已确认、03 §8.5 允许给该队员的记忆（顺序按 03 §8.5），偏好用说话方式卡里已存的偏好句，不写特质标签。格式 `{目标}；{事实 2–4 条}；偏好：{偏好句}；上次：{结论}`，≤ 600 字；叫名字时目标取用户原话。在转发卡底部和单聊开场都可展开，带「这条不对」（02 §12.2）；被引用的记忆写 `platform_memory_uses`。关键路径上省一次模型调用。

### 5.3 转发卡的生成

**来源**：`consult`、叫名字、回复卡、点卡上按钮、单聊结论、队员的后台任务结果、插件回执（投的投递汇报）。**结构**（`ForwardCard`，视觉见 08）：卡头「转自 前 · 前辈 · AI」、方印与墨色，出字前显示该队员的短语；正文是队员原话，逐句流式，主理人不转述、不改写、不摘要；附件是任务卡、差异链接、题卡等结构化引用；按钮 ≤ 3 个，只能是下面六类，存在 `payload`：

| 动作 | 例 | 点了以后 |
|---|---|---|
| `open_room` | [去单聊练]、[去单聊回答] | 打开这张卡的队员的单聊，可带模式（面试间、投递授权问答）；也可指向另一位已上线队员的单聊（取代 `suggest_handoff`），交接便条按 §5.2 生成 |
| `open_pending` | [看差异] | 打开待确认对象 |
| `reply` | [换一题] | 作为用户消息发给这张卡的队员 |
| `ask_companion` | [请墨安排] | 交给主理人 |
| `start_task` | [整份改一遍] | 起该队员的后台模板 |
| `dismiss` | [先不] | 只改卡片状态 |

按钮按 03 §6.10 的接口提交；除 `ask_companion` 和指向别人单聊的 `open_room` 外都交给这张卡的队员（03 §4.1）。

**引子**只在主理人自己决定请人时有，是它在 `consult` 那一步写的文字，≤ 30 字；超长只留第一句，仍超长换模板（「我请前看看。」，每个主理人 6 句轮换，最近 5 次不重复）。叫名字、回复卡、点卡上按钮时没有引子。投递授权（`mode=apply_consent`）与外部来源授权的转发卡前不用模型写的引子；需要时用固定句「{印章字}有几个问题要单独问你。」（如「投有几个问题要单独问你。」），不随性格变化；卡后主理人不再说话。

**卡之后**主理人默认不再说话；按钮覆盖不了、要用户另做决定时才再写一条自己的话，不复述卡片（与卡正文两字重合超过 30% 就拦下，假设）。

**单聊结论回主线**：用户离开单聊超过 10 分钟或技能「做完了」时（假设），队员写一句 ≤ 60 字的结论，服务端拼成转发卡写进主线（「面：今天练了 2 题，第二题的故事还缺结果数字 [看结论]」）。一次单聊最多一张，没有实质产出不回，不推送；`post_crisis` 覆盖期内暂存（§4.6）。「离开」= 该单聊订阅流断开，或客户端最后一次写 `last_read_seq`（03 §6.2）之后 10 分钟；由 worker 的调度器（09 第 6 步）每分钟扫描，用 `background` 租约和 `CostGuard`；结论以该队员的 `AgentProfile`、`summary` 用途写，记一行 `platform_expert_runs`（`mode = room_summary`）。

### 5.4 转发卡的校验

所有转发卡过同一个校验器（02 §3.4、03 §6.8），另外：

- **实体检查两档**：对外草稿和关于用户本人的事实（「你 / 你的」后接公司、学校、数字、日期）严格，必须有出处；一般提及（「像 Stripe 这类做支付 API 的公司」）在常见公司与学校名单或本轮工具结果里就放行，否则改写为「推测」。
- **冒充检查**跳过引用块、代码块和卡片载荷，只认页眉式写法（〔名字〕、「印章字 · 角色」）。
- **部分通过**：已显示的句子保留，剩余部分带失败原因重写一次；仍不通过以「后面这段我没组织好，先不发了 [重试]」结束，已通过部分落库并标 `truncated`；第一句就不过时整张卡失败「前 这会儿没接上 [重试]」。心跳只写已校验的文字。
- 转发卡的 `validator_rewrite` 与单聊结论的 `summary` 都以该队员的 `AgentProfile` 运行，记在同一或新的 `platform_expert_runs` 行。
- 交付物（草稿、题卡、对照表）整体校验后才出现；卡里不出现主理人口吻；长度上限前 ≤ 12 行、面 ≤ 6 行、投 ≤ 15 行（假设）。

**队员先靠做事的格式区分**（输出契约与渲染器强制）：前 = 改前改后对照加「原稿里没有的事实」；面 = 一次一题的题卡（「Q1/2 · behavioral」），点评只说一处做得好、一处最该改；投 = 清单加日期加 JD 原文。每人 1–2 个固定习惯（前先说一句它会保留的话；面在用户答之前不夸；投开头先报数）。每人 12–16 句示范台词放在人格卡之外（`packages/career-core/src/team/personas.ts` 的 `exemplars[]`，随人格 revision），每次都注入。用户偏好只改长短、顺序和语言，不改队员的格式。

### 5.5 单聊里的队员

- 永远是这位队员接话，主理人不在。用户在单聊里叫主理人，队员回「这件事去主线问墨更合适」[回主线]，把文字带到主线输入框，不替用户发。
- 上下文：人格卡、技能索引、03 §8.5 允许的记忆、本单聊历史、主线摘要块（最近一张转发卡和交接便条）。
- 模式：答问；技能任务（改简历、故事、材料包）；面试间（面，逐题，P0-10；实时语音见 12 §5.1）；投递授权问答（投，P1-1，问法见 11 §4.1–4.2，由主线里投的转发卡「投之前有 4 组问题要问你 [去单聊回答]」发起）。
- L1、L2 同样同步分级、立即中断该队员；之后按 03 §4.1 第 2 步与 02 §10.3（队员停下；模板和资源卡同时写进本单聊，以主理人名义，并置顶到主线；单聊给 [去主线]）。

### 5.6 示例

**叫名字产生转发卡（P0-10）**

```
林舟：面，周四 Acme Pay 后端一面，先给我来一道 behavioral。
      （服务端：句首「面，」→ 交给面；不调用模型判断；没有引子）
  ┌ 转自 面 · 面试官 · AI
  │ （面 在挑一道适合后端 new grad 的题…）
  │ Q1/1 · behavioral
  │ Tell me about a time you had to make a technical decision
  │ with incomplete information.
  │ 两分钟内答，用你实习里的一个具体项目。答完我只说一处做得好、一处最该改。
  │ [去单聊练]  [换一题]  [先不]  ▸ 墨给面的交接
```

第 1 步并行 `use_skill(interview-practice)`（`ready_for_draft`）、`search_org_knowledge`（题库）、`read_journey`（周四的面试）；第 2 步写卡。长按这张卡回答仍由面接；连续练点 [去单聊练]。

**单聊（P0）**：主理人先问过「要我请前辈看看第一屏吗？」，用户点了，前的转发卡给出 后端-v2 和 [去单聊改]，用户点进来。

```
┌ 前 · 前辈 · AI · 单聊
│ ▸ 墨给前的交接：找后端 new grad；一年制 MS CS；投了 30 个没有回音；偏好：先给结论，一次只改一处
前：  v2 里第二条的 QPS 我空着了。你在 Initech 实习时，订单服务高峰大概多少？
林舟：峰值 1200 左右。
      （前 在改 后端-v2…）
前：  改成：Cut p99 latency of the order service from 480ms to 210ms at 1.2K peak QPS.
      480 和 210 来自你的项目事实；「1.2K peak QPS」是你刚说的，原稿里没有。
      [确认，也记进项目事实]  [先空着]
林舟：（点 [确认，也记进项目事实]）
前：  好。后端-v3 放进待确认了，和 v2 只差这一条；项目事实里多了一条等你确认的「峰值 1.2K QPS」。
（林舟回到主线；10 分钟后服务端写回）
  ┌ 转自 前 · 前辈 · AI：后端-v3 已放进待确认：第二条补上了峰值 QPS 和 p99 降幅。[看差异]
```

上下文没有主线完整历史；用户新说的数字先作为「原稿里没有的事实」请他处理（03 §9.2 的 `claims[]`），确认后 `save_resume_draft` 写 v3、`propose_journey_update` 提议新事实。

---

## 6. 上下文与提示词组装

### 6.1 分层与排列

`services/platform-api/src/context-assembly.ts`（02 §15.4）按下表顺序输出。顺序为缓存服务；冲突时谁优先仍按 02 §15.4。

| # | 层 | 变化频率 | 内容 |
|---|---|---|---|
| 1 | 工具定义 | 按发言者固定 | 目录顺序、键排序的 JSON |
| 2–3 | 平台策略层、渠道层 | 版本发布时 | 02 §15.4 第 1、2 层；不可信数据说明 |
| 4 | 发言者层 | 人格 revision 变化时 | 说话方式卡，或人格卡加示范台词 |
| 5 | 能力索引 | 分期开关变化时 | 技能索引；可请的已上线队员 |
| 6 | 关系层 | 很少 | 称呼、约定、关系阶段 |
| 7 | 用户摘要 | 每天至多一次 | `agreement`、`communication` 类记忆；档案 `normal` 字段 |
| — | 缓存断点 | | |
| 8 | 历史 | 按块 | §6.2 |
| 9 | 本轮变化层（一个数据块） | 每轮 | 时间与时区、旅程状态、今天三件事、按意图挑的记忆、已解析的输入、`overlays`（主理人；队员只拿由它推出的行为标志 `no_task_push`、`gentle`，不拿覆盖种类，`post_crisis` 属 03 §8.5 restricted）、按处境注入的对话模式卡（04 §3.8）、交接便条、本轮任务（怎么被叫到的、技能目标、输出契约、「做完了」规则、缺什么）、计划未完成项、进行中技能的说明；涉及身份时附 02 §3.3 的配置句 |
| 10 | 本条用户消息 | 每轮 | 加上并入的插话 |
| 11 | 本轮模型输出与工具结果 | 每步 | 只追加 |

第 9 层告诉队员它为什么被叫到。第 1–7 层除非版本变化逐字节不变（不含时间戳，JSON 键排序，对话内不增删工具）；部分供应商要求相同前缀 ≥ 1,024 tokens 才缓存。`cache_hit_ratio` 低于 60% 时逐层比对摘要，找出在变的层。

### 6.2 历史窗口

- 角色映射与数据块以 03 §6.8 为准。历史按 20 条一块对齐（窗口起点取 `ordinal` 为 20 的倍数），窗口 40–60 条（假设），前缀约每 20 轮才变一次。
- 主线窗口里转发卡以「〔转自 前〕…」数据块出现；单聊只看本房间窗口加主线摘要块；工具摘要（§4.3）随历史进入。
- 滑出窗口的块（P1a 起）由经济档在后台写成 ≤ 400 字的摘要（`purpose = summary`），放在第 8 层开头，只引用块里出现过的事实；块内有删除或 `excluded_from_context` 的消息时重写（03 §8.8）。附件不再每轮重发。

### 6.3 记忆与技能

- 注入什么、给谁、多少条以 03 §8.5 为准（主理人 30 条、队员 15 条，假设）。`agreement`、`communication` 放第 7 层，意图相关的放第 9 层；队员可用只查 `normal` 的 `search_memories`，避免问记忆里已有答案的问题；每次注入写 `platform_memory_uses`。
- 技能正文由 `use_skill` 加载（第 11 层）；下一轮技能仍在进行时放进第 9 层，不再调 `use_skill`。
- 只有服务端能改提示词（客户端提交 `persona`、`model` 等一律 400，09 第 0、2 步）；用户的纠正只经 02 §8.2 的白名单影响第 4、6 层。

---

## 7. 模型分层

| `purpose` | 档位 | 单步输出上限 | 超时 | 其他 |
|---|---|---|---|---|
| `safety_classify` | 经济 | 100 | 整体 1 秒（09 第 2 步） | 结构化输出；超时退回关键词 |
| `companion_reply` | 主力 | 1,500 | 首字 10 秒 | 低推理强度 |
| `expert_consult`、`room_turn` | 主力 | 4,000；写草稿 12,000；面试间 1,200 | 首字 15 秒 | 中推理强度 |
| `validator_rewrite` | 主力 | 剩余长度 × 1.5 | 首字 10 秒 | 只重写一次；转发卡的以该队员身份运行（§5.4） |
| `background` | 按模板 | 8,000 | 每次 120 秒；整个任务 10 分钟 | |
| `summary` | 经济 | 600 | 30 秒 | 块摘要；单聊结论（以该队员身份运行，§5.3） |
| `suggestion`（P1b） | 经济 | 100 | 3 秒 | 快捷回复建议，复用缓存，失败就不显示 |

以上数值都是假设；后台生成（第一封信、晨报）的配置见 02、09 第 2 步。

- 档位到模型的映射只在服务端：`model-routing.ts`（09 第 0、8 步）扩展为「发言者 × 用途 → 供应商、模型、上限、超时」。`ChatContext` 加 `limits`、`toolChoice`、`responseFormat`、`timeoutMs`；每次调用带 `purpose` 记账。
- `CostGuard` 返回 `degrade` 时 `background`、`summary` 降到经济档（06 §12.3 第①步），这是降级，不是冒充。成本（假设）：按 06 §12.5，请队员的一轮约 $0.046（写整份草稿到 $0.10），是主理人自己做的一轮（约 $0.018）的 2.5–5.5 倍；`agent` 后台任务每个约 $0.15（§4.6）；B0 按 `purpose` 实测替换。
- **如实呈现**：沿用 `providerStatuses`、`requireProvider` 与 `PLATFORM_ALLOW_PROVIDER_CALLS`，没开或没配置时轮次如实失败（「墨 现在连不上 [重试]」），不出现供应商与模型名，不自动切换供应商（07 §3.13）。输出超上限一律报 `PROVIDER_OUTPUT_LIMIT`。

---

## 8. 流式与界面协议

### 8.1 SSE 事件

发起这一轮的请求以 SSE 返回本轮事件，订阅流推同一套；每个事件的 `id` 是会话内单调递增的 `seq`。现有 `start`、`delta`、`done`、`error` 保留并加字段；`tool`、`approval`、`usage` 不发给学生端。

| 事件 | 数据 | 进事件表 |
|---|---|---|
| `turn_start`、`turn_done` | `{turnId, roomId, trigger, speaker}`；`{turnId, status, reason?}` | 是 |
| `typing` | `{speaker, phrase?}` | 否 |
| `tool_started`、`tool_finished` | `{turnId, callId, speaker, phrase}`（无工具名和参数）；`{callId, ok}` | 否 |
| `start` | `{messageId, turnId, speaker, kind, forwardedFrom?}`，`kind` 区分普通消息与转发卡 | 是 |
| `delta` | `{messageId, text}`，只发已校验的整句 | 否 |
| `card`；`done` | `{messageId, card:{type, id, revision?, status}}`；`{message}` | 是 |
| `queued`、`interjection_joined` | `{messageId}`；`{turnId, messageIds}` | 是 |
| `task_progress` | `{taskId, label, step, of?}` | 否（任务行有最新值） |
| `message_deleted` | `{messageId}` | 是 |
| `error` | `{code, message, messageId?, turnId?, retryable}`，只结束一条消息 | 是 |

`speaker`：`{kind, key?, id?, displayName, roleLabel?, sealChar?, ink_token?, isAi, humanLabel?}`，与 `speaker_snapshot`（03 §6.4）一致。

### 8.2 订阅流与续上

- `GET /conversations/:id/events` 带 `Last-Event-ID`，网页用 fetch 流读（复用 `readMessageStream`）。对话列表的 `GET /rooms/events`（03 §6.7）不按 `seq` 续上：每次连接或重连先取 `GET /rooms` 快照，再订阅「哪个房间有新内容」的通知；如需续传，在用户行锁内分配按用户的 `user_seq`。不进表的事件经 LISTEN/NOTIFY 转给在线订阅者，到句级为止。`seq` 在会话行锁内分配，否则晚提交的小号会在重放时被跳过。
- 订阅流是 P0 必需（后台进度、插话后的回复、断线续上都靠它）。09 §1.6 的轮询替代只允许在 B0 前用，有轮次或任务在跑时每 3 秒一次（假设）。
- **续上**：打开或重连时先取房间快照（消息、运行中的轮次、任务进度、最后的 `seq`），从该 `seq` 订阅并去重；正在流的消息先显示已校验的部分（心跳每 ≤ 2 秒写库，假设），再接句级更新。重连退避 1、2、4、8 秒，最长 30 秒。Discord 见 10 §3.11–3.12。

### 8.3 前端呈现

一条消息一个气泡，以 `messageId` 为键，按 `start` 新建，`error` 只结束那一条。同一条消息里多步的文字依次追加；步间的工具步骤在气泡内显示为一行进度，完成后折叠成「依据」行。进度条目以 `apps/web/src/agent-tool-status.ts` 的 `upsertAgentToolStatus`（按调用 id 合并）为基础，改为显示短语。组件 `ChatList`、`RoomHeader`、`ForwardCard`、`TaskCard`、`QuickReplies` 见 08。

---

## 9. 安全与边界

本文不重述规则，只规定引擎在哪里执行：

| 边界 | 权威 | 引擎在哪执行 |
|---|---|---|
| 危机分级与 L2 模板 | 02 §10.2–10.3 | §3.1 第 1 步开始、第 5 步把关（L0 之前不出字、不执行工具）；任何时刻抢占；模板经 `post()` 写入，不经模型、租约、`CostGuard` |
| 对外发出 | 03 §9 | 学生端发言者只有 `draft`；`act` 只在确认后由服务端执行 |
| 插件与代签 | 11；03 §10 | 引擎只读授权与回执；授权只由确认卡改 |
| 输出校验 | 02 §3.4；03 §6.8 | 每句、每张卡（§5.4） |
| 身份事实；敏感度 | 02 §3.3；03 §8.5 | 只经第 9 层注入已审核配置句；上下文组装过滤，MCP 出站过滤 |
| 付费建议；AI 透明 | 06 §7；02 §11.1 | 只有主理人、只在放行后；转发卡头与单聊 `RoomHeader` 带「· AI」 |
| 不可信内容 | 03 §1.2 第 7 条 | 知识库、JD、上传、MCP 结果、其他发言者的输出，一律作为数据进上下文 |

要发给别人的消息和材料，都先进待确认；表单里哪些项可以替你做，由你逐项设定（见 11）；最终提交永远由你本人点。

引擎自己的两条：**不让三样凑在同一步**（私人数据、读过的不可信内容、对外发送能力）——学生端发言者没有对外发送能力，出站过滤拒绝把外部结果原文放进 MCP 参数。**权限在代码里**——提示词里的「不要做」只是第二道。

---

## 10. 失败与降级

原则：失败就是失败，不用固定回复冒充模型（AGENTS.md）；能保留的已校验内容都保留。

| 情况 | 用户看到 | 系统行为 |
|---|---|---|
| 供应商未开启或未配置 | 「墨 现在连不上 [重试]」 | 轮次 `failed` |
| 出字前连不上、流中断 | 无感或晚 1 秒 | 自动重试一次（§3.5） |
| 出字后中断 | 已显示的句子保留，末尾「没说完，断了 [重试]」 | 已校验部分落库，`truncated` |
| 20 秒 / 45 秒没有任何事件 | 「墨 还在想…」/「墨 这会儿没接上 [重试]」 | 任何事件重置计时；45 秒本条失败（假设；取代 03、05、08 里不一致的 30、60 秒） |
| `PROVIDER_OUTPUT_LIMIT` | 写草稿时无感 | 加大一档重做这一步一次，再超如实失败 |
| 读类工具失败；知识库没有；外部来源超时或没授权 | 「旅程这会儿读不到，先按你刚说的…」；「资料库里没找到」；「这次没查到」+ 下一步 | 错误作为数据交回；不出现出处标签（07 §7.4）；不用模型知识补（03 §2.8） |
| `consult` 失败 | 卡里「前 这会儿没接上 [重试]」 | 主理人不代替队员给结论，可以说自己能先做什么 |
| 拿不到租约 | 灰色排队，最后「这条消息没来得及回复 [重新发送]」 | 03 §6.5 的 3 次重试 |
| `CostGuard` 降级或拦截 | 系统通知（08 §7.2），不由主理人说 | 06 §12.3 |
| 后台任务或 API 中断 | 任务进度停一下后继续；前台「没说完 [重试]」 | 检查点续跑；`recoverStaleStreams` 把过期轮次标 `failed`；L2 自动重放（02 §10.3） |

---

## 11. 可观测与评测

### 11.1 观测

- **每轮记录**（只存 id、枚举和数字）：房间、发言者、触发方式、每次调用的 `purpose`、步数、工具调用（目录 id、效果、耗时、成败）、tokens、§1.2 的时间、校验拦截、停下、插话、转后台。存轮次行与 `platform_chat_calls`，不写内容。
- **看板**：§1.2 各指标 P50/P95；按用途的 tokens 与费用；只有一个发言者的轮次占比（≥ 75%，假设）；卡后主理人再说话的比例；工具失败、校验拦截、后台失败、停下、重试的比率。告警阈值归 13 §6.7。
- **埋点**（加进 07 §7.5 白名单，取代 `expert_joined`、`expert_left`、`mention_used`）：`expert_consulted`、`forward_card_shown`、`forward_card_action`、`expert_room_opened`、`name_call_detected`、`interjection_joined`、`turn_stopped`、`skill_used`、`background_task_started`、`background_task_finished`；属性只有队员、触发方式、动作类、模板、结果、时长分桶。

### 11.2 评测

harness 在 `services/platform-api/evals/`（09 第 8 步），直接调 `ConversationTurns` 和上下文组装，可接假 runtime 或真实模型；全部虚构资料；**真实模型评测需产品负责人批准预算**。

| 评测 | 内容与规模 | 评分 | 通过线（假设） |
|---|---|---|---|
| 自己做还是请队员 | 200 条带对话状态，≥ 30% 是追问、回答、致谢 | 人工标注 | ≥ 85% |
| 叫名字识别 | 300 条：呼语与非呼语（「我实验室的前辈说」）、贴进来的「前：…/后：…」、未上线队员 | 代码 | 准确率 ≥ 99%、召回 ≥ 95% |
| 队员人格区分盲测 | 每人 40 段，去掉名字和印章判断是谁 | 单提示模型评审，人工抽检 | 认出是谁 ≥ 85%；人格卡遵守 ≥ 90% |
| 校验器误杀 | 300 段无害输出；构造的违规 | 代码 | 误杀 ≤ 0.5%；违规 100% 拦下 |
| 技能成功率 | 每个 P0 技能 20–50 条，从真实失败里攒 | 代码判「做完了」与契约；模型评审 0–1 分加通过与否，按人工标注校准 | 关键流程（材料包不引入新事实）同一任务连跑 4 次全过；其余 ≥ 80% |
| 权限 | 每发言者 20 条：越权工具、绕过待确认、插件动作前没有确认 | 代码；「先确认再交给插件」按严格顺序比对轨迹 | 0 次 |
| 引用与检索 | 04 §4.5 的 120 条 + 私人库 30 条 | 代码 | 引用 100% 合法；recall@5 ≥ 0.8 |
| 引擎行为 | 插话、停下、续上、抢占、并行读、到上限收尾、后台续跑，各 ≥ 5 个脚本 | 假 runtime | 100% |
| 真实模型延迟 | 主理人与 P0 三位队员各 30 段（§1.2） | 计时 | 报告数值，不设通过线 |

多轮流程用模拟用户跑；回归集合并前接近 100%；07 §7.4 的闸门引用本表。

---

## 12. 现有代码的复用与改动

### 12.1 原样复用

`ai-core` 的 `HttpClient`、`readSse`、`usageCollector`、`onModelCall`、`ProviderError`、`providerStatuses`、`requireProvider`；`platform-api` 的 `AppOptions.runtime`、`publicError`、`KnowledgeSources`、`McpConnections` 与 `createMcpTransport`、`createMcpFetch`、`compileMcpSchema`，`jobs.ts` 的 `JobService.create`、`TaskQueue`、`processJob`、`inputHash`、`approvalMatches`、`decide`，`saveConversationTaskOrigin`、`applyWorkflowCheckpoint`、`readArtifactText`；career-core 的 `prepareCareerRun`、`careerProgress`；网页的 `readMessageStream`、`parseEventBlock`。

### 12.2 要改的

| 文件 + 函数 | 现状 → 改为 | 09 步骤 |
|---|---|---|
| `packages/ai-core/src/chat.ts` 的 `streamOpenAI`、`streamCompatible` | 写死 6 步、16 次、输出 4096；工具逐个 `await`；`tool` 事件等整段输出才发；工具错误终止一轮；OpenAI 路径把 `response.incomplete` 报成 `PROVIDER_GENERATION_FAILED` → `runAgentLoop` 与 §3 的全部行为 | 第 1 步 PR2 |
| 同文件 `instruction()` | persona 标为「User-selected style」，记忆在历史之前 → 分层上下文（§6.1） | 第 2 步 |
| `ai-core` 的 `index.ts` `streamChat`、`config.ts` `model()`、`http.ts` `HttpClient.request` | 工具只在 `mode === 'agent'` 挂；模型优先取客户端值；固定 120 秒 → 工具与 `mode` 脱钩；只用服务端模型；超时按用途 | 第 1 步 |
| `platform-contracts` 的 `ChatContext`、`ChatStreamEvent`、`ToolDefinition` | 加 `limits` 等字段；三个新事件；`effect`、`progressPhrase`、`endsTurn` | 第 1 步 |
| `platform-contracts` 的 `PlatformProviderRuntime` | 只有 `streamChat`，循环藏在里面，假 runtime 测不到真循环 → 加 `streamModelStep(input, {tools, toolChoice, limits, reasoningEffort, timeoutMs, signal, onModelCall})`：只做一次供应商调用，产出 `delta`、`tool_started`、`usage` 并返回 `{text, calls}`，每次调用内 `requireProvider(env, provider, tools.length ? 'agent' : 'chat')`；`runAgentLoop` 从 ai-core 导出，由 `ConversationTurns`、`runExpert`、`executeAgentRun` 用包装 `runtime.streamModelStep` 的 `ProviderAdapter` 调用；假 runtime 只实现 `streamModelStep` 并按脚本加延迟；`streamChat` 只留给 `legacy` 会话和不带工具的后台生成（09 第 2 步） | 第 1 步 PR2 |
| `app.ts` 的 `POST /conversations/:id/messages` | socket 关闭即中止；keepalive 把未校验文字写库；历史只取 `user`、`assistant`；每轮重读附件 → 搬进 `ConversationTurns`，轮次比请求活得久，心跳只写已校验文字，带工具摘要；`safeTools` 变为能力目录 | 第 1 步 PR1 |
| `runtime-leases.ts` 的 `acquireRuntimeLease` | 租约 id 是助手消息 id → 用轮次 id；加 `background` 种类；L1 抢占时在轮次锁内把旧租约交给新轮次，否则撞每用户 2 个的上限 | 第 1 步 |
| `chat-usage.ts` 的 `chatAccounting`；010 迁移 | `call_index` 限 1–6 且 `UNIQUE(message_id, call_index)`，校验重写会冲突 → 键改为（轮次、段、尝试、调用序号），加 `purpose`、`speaker`；安全分级的 `message_id` 可空；后台按 `job_id` | 第 1 步（编号按 09 §1.4） |
| `ConversationTurns` 的加锁 | 段与段之间没有 `streaming` 行，旧索引挡不住并发 → 以轮次表的部分唯一索引为锁（03 §6.5），顺序固定为会话 → 轮次 → 用户行 | 第 1 步 PR3 |
| `career-core` 的 `skills.ts`、`contracts.ts` | 技能清单（§4.1）；`KnowledgeCitation.revision` 从字符串改为数字，加 `scope`、`assetClass` | 第 1 步；第 3C 步 |
| `mcp-connections.ts` 的 `assertAuthorized`；015 的 `platform_mcp_receipts` | 每次调用要审批行并排队；回执以 `job_id` 为主键，轮内调用没有 job → 加 `assertStandingGrant`、`callInTurn`；回执加 `id uuid` 主键，`job_id` 改可空并加部分唯一索引 `(job_id) WHERE job_id IS NOT NULL`，加 `turn_id`、`conversation_id`、`speaker`、`purpose`、`grant_record_version`，`CHECK (job_id IS NOT NULL OR turn_id IS NOT NULL)`；`started`、`complete`、`interrupt`、`assertPublication` 改按回执 id；轮内结果存为按用户的私有文件（`private-files.ts`），回执记 `result_ref` 与 `response_hash` | 第 3D 步 |
| `jobs.ts` 的 `processJob`、`recoverInterrupted`、`onProgress`；`kind` CHECK、`JOB_KINDS`、`parseJob` | 没有跑 agent 的任务；中断标 `uncertain`；进度只有 0–99 整数 → `agent` 任务、检查点续跑、`progress_label`；`parseJob` 拒收 `agent`，新建 `parseAgentJob`，`POST /jobs` 与重试对 `agent` 返回 403（§4.6） | 第 1 步 PR6（017） |
| `conversation-tasks.ts` 的 `authorizeConversationTaskOrigin`；016 的 `tool` CHECK | 要求来源是 `streaming` 的 assistant 消息、租约 id 等于消息 id；`tool` 只有三种 → 改为校验 `platform_conversation_turns` 中该房间 `running` 的轮次及 id = 轮次 id 的租约；来源 `message_id` 指 `start_background_task` 先写入的 `task_card` 消息（同一事务）；017 内 `tool` CHECK 加 `start_background_task`、`start_task` | 第 1 步 PR6 |
| `knowledge-sources.ts` 的 `search` | 中文两字切分（§4.2） | 第 3C 步 |
| `apps/web/src/App.tsx`、`account-polling.ts`、`agent-tool-status.ts` | 一轮一个气泡、`error` 结束整条流；任务每 12 秒轮询；标签显示工具名 → §8.3；事件流驱动；显示短语 | 第 4 步 |

### 12.3 新建与落地顺序

新建：`ai-core/src/agent-loop.ts`；`platform-api/src/` 的 `conversation-turns.ts`（03 §7.2）、`capabilities.ts`、`expert-runner.ts`、`career-run-context.ts`、`career-knowledge.ts`、`context-assembly.ts`、`agent-run.ts`、`document-text.ts`（§4.2）；`career-core/src/` 的 `capabilities.ts`、`team/name-call.ts`（03 §4.4 的规则写成纯函数）、`team/handoff.ts`、`team/personas.ts`、`companion/output-check.ts`（加 §5.4 的规则）。

顺序按 09 第 1 步：① PR1 纯抽取，现有测试一行不改通过；② PR2 循环（§3）、能力目录与技能清单（§4.1、§4.7），用假 runtime 测；③ PR3 轮次服务（租约、记账键、插话、停下、`seq`），开工前做 §1.2 的小规模真实模型测试（已批准）；④ PR4 `consult`、转发卡、叫名字、单聊；⑤ PR5 订阅流；⑥ PR6 后台任务；之后 ⑦ 知识端口与中文切分（3C）、⑧ 按用途的模型配置与 `CostGuard`（第 8 步）、⑨ 轮内 MCP（3D）；求职工具随 019、020、022 接入。除 ③ 前的测试外都不需要付费调用。

---

## 13. 分期（以 07 为准）

| 阶段 | 引擎内容 |
|---|---|
| P0 | P0-3：循环、轮次服务、能力目录、技能渐进加载、`consult` 与转发卡、叫名字、单聊（前、投、面）、插话与停下、订阅流、按用途的上限与超时、后台任务三个模板。P0-2：分级接入与抢占。P0-4：`ChatList`、`RoomHeader`、`ForwardCard`、`TaskCard` 由事件驱动。P0-8：队员只查 `normal` 的记忆检索、交接便条。P0-9：求职工具与 `CareerRunContext`。P0-10：面试间在面的单聊里。P0-11：组织库结构化检索。P0-13：§11.2 评测与 `CostGuard` |
| P0 期间并行、不发布 | 09 第 3D 步的轮内 MCP 与 `system` 来源（B2 补齐集，最晚 P1a） |
| P1a | P1-1：投的单聊里的授权问答，插件回执以投的转发卡回主线。P1-2：`DiscordTurnSink` 与跨进程取消。P1-4：`interview_brief` 模板、面经与组织库两字切分。P1-5：被拒复盘由面的转发卡发起。历史块摘要 |
| P1b | P1-6 规、P1-7 教上线；P1-9 方法卡作为技能从组织库加载、`org` 来源与 `external_grant`；快捷回复建议；并行 `consult`（待确认第 1 条） |
| P2 | 脉；`job_triage` 每日后台任务；`user_account` 来源与后台用途；MCP 规范里实验性的持久任务；混合检索与向量 |

---

## 14. 验收标准

- [ ] 主线一轮只出现主理人的消息和转发卡；单聊只出现该队员和用户的消息（危机按 03 §4.1）。
- [ ] 叫名字不调用模型；叫未上线的队员时主理人按 05 §2.3 回答；被叫的队员直接出卡、没有引子。
- [ ] 同一步的只读调用并行（假 runtime：三个各 1 秒的调用总耗时 < 1.5 秒），结果按调用顺序交回；草稿串行且幂等。
- [ ] 工具出错不终止一轮；越权调用被执行 0 次；到上限时最后一步不带工具，不再出现 `AGENT_TURN_LIMIT`、`TOOL_LIMIT`。
- [ ] 开始写工具调用后 ≤ 300 毫秒发出 `tool_started`；学生端事件里没有工具名、参数、结果、模型名、供应商名。
- [ ] `use_skill` 之后的下一步才出现该技能的工具；`consult` 时 `blocked` 没有转发卡、由主理人问缺的那一项；叫名字时 `blocked` 由队员在卡里问；交接便条由 `buildHandoffNote` 生成（单元测试）。
- [ ] 生成中发消息返回 202 并在下一步并入，进行中的工具不被取消；「停下」1 秒内生效、草稿保留；关页面不取消轮次，重连后事件不丢不重。
- [ ] 转发卡文字全部来自该队员这次运行；按钮只有六类；引子 ≤ 30 字且只在主理人主动请人时出现；队员调用 `consult` 被拒。
- [ ] 后台任务进度每 ≤ 10 秒更新；worker 重启后从检查点续跑、草稿不重复；结果卡不推送、不占主动额度。
- [ ] 引用的段落都来自本轮检索；上下文第 1–7 层连续两轮逐字节相同；每次调用（含安全分级、`consult`、校验重写）都有带 `purpose` 的记账行。
- [ ] 供应商未开启时轮次如实失败并可重试；同样情况下 L2 仍在 2 秒内收到模板（02 §15.6）。
- [ ] §11.2 的评测达到通过线后，才对 B1 打开 P0-3 的功能开关。

---

## 待确认问题

不回答时按右列默认执行。单聊里出现危机信号的处理见 02 §10.3（安全审核人确认见 03 待确认第 5 条）。

| # | 问题 | 由谁回答 | 不回答时的默认 |
|---|---|---|---|
| 1 | 一轮里是否允许主理人同时请两位队员（并行 `consult`）？ | 产品负责人 | P0 不做；用户一句话叫两位时按顺序出两张卡；P1b 按评测再定 |
| 2 | 后台任务完成时用户不在线，要不要推送？ | 产品负责人（2026-10-07 已定） | 按默认执行：不推送、不占主动额度，晨报一句带过；用户说「好了叫我」时按 `user_requested` 例外推送一次 |
| 3 | 第一方岗位源读不出的公开职位页，是否用内部浏览器执行器只读兜底？ | 产品负责人 | 不做，请用户粘贴 JD |
| 4 | 丝滑指标是否作为 B1 发布闸门？ | 产品负责人 | 只把首个可见反馈和断线续上作为闸门，其余作为护栏，B0 两周后再定 |
