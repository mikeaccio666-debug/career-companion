# 04 蔓藤资产如何变成体验

> 状态：v2，依据共享产品简报 v3 与总编辑裁决｜日期：2026-10-06｜本文只交叉引用：分期 07；队员、工具白名单、待确认、交接包 03；技能与知识层 15；流程 05；价格、订单、内推商业与法务 06；视觉 08；迁移 09；Discord 10；插件 11；声线 12。
> 代码以 `965db09` 之后的 main 为准（MCP 按 `1c26b3a`），引用写文件和函数名。示例用户林舟（01 Persona A），「墨」是他给主理人起的名字。标「假设」的数字，验证方法见第 9 节。

## 这份文档回答什么问题

1. 蔓藤的十类资产由哪位队员使用，出现在哪个时刻、哪个界面，用户感受到什么（第 2、3 节）。
2. 每类资产进系统时的形态：字段、授权与去标识化、质量控制、风险（第 3 节）。
3. 怎样落到现有代码：组织共享库、检索、prepare 闸门、接口、账号删除与导出（第 4 节）。
4. 结果回流飞轮怎么转，同时不越过隐私线、不为了卖而卖（第 5 节）。
5. 可以直接拿去和蔓藤对接的数据与资源需求清单（第 6 节）。

**结论**

- P0 只上题库与 rubric、第一批 5 张方法卡、对话模式卡、真人入口最小版（意向表，没有交接包），加导入脚本、访问日志、配额和运营只读列表。面经与作战简报在 P1a（P1-4）；交接包、预约、评阅回流、用户贡献、写法样本、路径统计、小企业机会、导师网络在 P1b。
- 没有书面授权的内容不发布（`license_id` 必填，学员来源另加 `consent_id`）。内推评估在法务审核通过前线上线下都不提供（D6）。
- 篇数、比例和出处标签只由服务端按工具结果和 citation 渲染，模型不能自己写「蔓藤面经」或频率（D2）。
- 付费推荐全部按 06 §7：只由主理人在对话里提出；信件卡片、晨报、三件事和作战简报里没有付费内容。
- 代码上新建与 014 私有资料库并列的组织共享库和 `OrgKnowledge`，复用版本与墓碑语义；主理人和队员经 agent 的知识层检索、经技能加载蔓藤资产（15 §4.1–4.2）；`CareerKnowledgePort` 用一条「知识访问引用」接上 `prepareCareerRun`。
- 授权语料仍导入组织库；导师可约时段、课程目录、合作机会、导师网络这类实时数据，P1b 起可由蔓藤以 MCP 只读交付，由我方核授权、渲染出处（4.12）。

---

## 1. 一页纸结论

| 层 | 资产 | 进系统的方式 |
|---|---|---|
| 知识层 | 面经、题库、导师方法论、规划师话术、AI 课程 | 进「组织共享库」，可检索、可引用、带版本 |
| 样本层 | 学员简历（及蔓藤历年结果数据） | 第三方个人信息，只以去标识化、改写或聚合的形态出现，原件不进系统 |
| 人与资源层 | 真人导师一对一、内推、导师网络、小企业内推资源 | 可预约的人和可转递的机会，走履约状态机 |

**五条硬规则**

1. **先授权，再导入。** `license_id` 为空不能发布；学员来源还必须带 `consent_id`。
2. **出处可见，由服务端渲染。** 标签和统计数字只按本轮真实的 citation 与统计结果生成（2.1）。
3. **没有就说没有。** 库里没有就说「这家我们还没有面经」，不让模型补写，不贴蔓藤标签。
4. **蔓藤内容是数据，不是指令；别人的经历不会变成用户的经历。** 样本只教改法，不提供可照抄的事实。
5. **真人与付费以 06 §7、§8 为准。** 永远同时给免费路径；不卖「付费即内推」。

---

## 2. 资产总表

| # | 资产 | 主要使用者 | 关键时刻 | 界面 | 出处标签 | 分期（07） |
|---|---|---|---|---|---|---|
| 1 | 面经 | 面、投；主理人引用 | 作战简报；按公司练习；被拒后复盘 | 主线（面的转发卡）、旅程面试详情、面试间 | 蔓藤面经 · 已去标识化 | P1a（P1-4）；贡献 P1b（P1-9） |
| 2 | 题库 | 面、前；教（P1b） | 面试间；故事库；三件事「练一道」 | 面试间、今天、旅程 → 故事库 | 蔓藤题库 | P0（P0-11） |
| 3 | 学员简历 | 前、投；规（P1b） | 简历版本待确认；方向比较 | 对话、待确认、旅程 | 蔓藤写法样本 · 已改写；蔓藤学员统计 | P1b（P1-9）；校准集 P2 |
| 4 | 导师方法论 | 全队（按发言者注入） | 所有时刻，在「看依据」里 | 所有界面 | 蔓藤方法 · v{n} | P0（P0-11，第一批 5 张）；其余随队员上线 |
| 5 | 真人导师一对一 | 主理人提出；前起草交接包（P1-10） | 对话中（06 T1–T7） | 左栏「真人与社区」、我、旅程；待确认（P1-10） | 真人 · 蔓藤导师 | P0 意向表（P0-12）；预约与交接 P1b（P1-10） |
| 6 | 真人导师内推 | — | — | — | — | 法务通过前不提供（D6）；之后不早于 P1b |
| 7 | 真人导师网络 | 主理人；脉（P2） | 用户问「谁能回答这个」 | 左栏「真人与社区」、我 | 蔓藤导师网络 | P1b（P1-9）；Discord 答疑 P2 |
| 8 | 职业规划师话术 | 主理人；规（P1b） | 情绪类、咨询类时刻 | 不展示；来源在隐私说明里披露 | 无 | P0（P0-11，对话模式卡） |
| 9 | 小企业内推资源 | 投、主理人 | 机会卡 | 今天、主线、旅程 | 蔓藤合作企业 · 书面说明 {yyyy-mm} | P1b（P1-9） |
| 10 | AI 课程 | 教（P1b） | 三件事只放 `included`；`paid` 只在对话中按 06 T8 | 今天、对话、旅程 | 蔓藤课程 | P1b（P1-7）；转写稿 P2 |

另有支撑规划和飞轮的**蔓藤历年学员投递与结果数据**，见 3.3、第 5 节。

### 2.1 出处标签的统一文案

视觉见 08 的 `SourceLabel`，文案在此定死；品牌前缀「蔓藤」做成配置项。**标签只由服务端按 citation 或数据对象渲染，模型正文不得自己写。**

| 标签 | 用于 | 附加规则 |
|---|---|---|
| 蔓藤面经 · 已去标识化 | 已发布的面经 | 超过 12 个月加「较旧」 |
| 蔓藤面经 · 后来者贡献 | 用户贡献、经审核发布的面经 | 同上 |
| 蔓藤题库 | 题目、rubric | — |
| 蔓藤方法 · v{n} | 方法卡 | 版本号必显示 |
| 蔓藤写法样本 · 已改写 | 简历写法样本 | 永远附「非真实个人」 |
| 蔓藤学员统计 · n={n} · {期间} | 路径统计 | n < 5 不显示；固定附「不代表你的结果」 |
| 蔓藤课程 | 课程单元 | `paid` 单元同时显示价格 |
| 蔓藤合作企业 · 书面说明 {yyyy-mm} | 合作机会 | 日期必显示 |
| 真人 · 蔓藤导师 | 真人导师的消息和评阅 | 与 AI 队员样式明确区分（08） |
| 公开资料 | 岗位原文、公司公开页 | 带观察时间 |
| {来源名} · 查询于 {MM-DD HH:mm} | 外部实时来源（03 §2.8）；蔓藤 MCP 来源沿用对应的蔓藤标签 | 由目录条目配置 |
| 你的资料 | 用户私人资料库 | — |
| 通用（没有蔓藤依据） | 模型的一般知识 | 主要依靠一般知识时必须标出 |

---

## 3. 逐项设计

面向用户的文案里，提到真人一律写「蔓藤导师（真人）」或「真人导师」，不单写「导师」；AI 专家是「前 · 前辈」。

### 3.1 面经（P1a，P1-4）

**谁用**

- **面**：作战简报讲「这家常考什么」；面试间按面经出题和追问。
- **投**：材料包读「这家看重什么」（如「HM 很在意 on-call 经验」），提醒用户**有据地**强调，不编造。
- **主理人**：晨报一句带过「周四 Acme Pay 的 VO，面已经备好了作战简报」，篇数由服务端填入。
- **被拒之后**（P1-5）：满 24 小时后主理人在晨报里提一次复盘（可选），用户接受后由面的转发卡带进面的单聊；只描述考点和难度，不给通过率。

**用户感知**（任务卡，样式见 08）

```
作战简报 · Acme Pay（示例公司）· New Grad SWE · Virtual Onsite
时间   10-15 周四 13:00 ET（你录入的）
依据   蔓藤面经 6 篇（2025 下半年–2026 上半年，已去标识化）· 公开资料 2 条
常见考点
  API / 支付流程设计      6 篇中 4 篇提到
  Bug bash：读代码找问题  6 篇中 3 篇提到
  Behavioral：ownership   6 篇中 5 篇提到
面经里反复出现的提醒
  面试官更看重边写边讲清楚取舍                [蔓藤面经 · 已去标识化]
面已排好 3 轮练习，每轮 40 分钟
[开始第一轮]  [调整计划]  [看依据]
```

`none` 档的固定文案（服务端插入）：

> 面：Rippling 的 new grad 面经，我们库里还没有。下面的准备依据这家公开的招聘页和同类岗位的常见题型，都标了「通用」，参考价值低一些。你面完如果愿意，可以把这次经历匿名留给后来的人。

**渲染规则（D2）**

- 服务端按结构化 JSON 渲染整张卡：`{interview, coverage, reminders[], practicePlan}`。`interview` 取自旅程；`coverage`（篇数、n/m、档位、时间段）原样取自本轮 `summarize_interview_coverage`；`practicePlan` 只放免费练习，不放付费推荐（06 §7.2）。
- 模型只填 `reminders[]`：`{text, citation:{sourceId, revision, passageId}}`，citation 必须是本轮工具真实返回、且在本轮访问日志里的段落。`SourceLabel` 由服务端按 citation 渲染。
- 输出校验器：本轮正文（含 `reminders[].text` 与同轮普通消息）出现「蔓藤面经」「蔓藤题库」「蔓藤方法」「面经里」，而本轮没有对应 citation 或 citation 不在访问日志里 → 拒绝并重写一次；再失败 → 改发 `none` 档固定文案。

**覆盖档位**（确定性统计，同一公司 × 岗位家族，近 18 个月）：`rich` ≥ 5 篇、`some` 3–4 篇，显示篇数和「n 篇中 m 篇提到」；`thin` 1–2 篇，只说「有少量面经」，不显示比例和时间段（避免反推作者）；`none` 0 篇，固定文案，不出现蔓藤标签。

**字段**（`asset_class = interview_report`）

| 字段 | 取值 / 说明 |
|---|---|
| `company_key` | 规范化公司键（域名），公司字典由我们维护 |
| `role_family` | career-core 常量（03 列出，04、09 只引用）：`swe` / `mle` / `ds` / `da` / `de` / `hw` / `other`；PA、BA 归 `da`，EE、ME 归 `hw` |
| `level` | `new_grad` / `intern` / `entry` |
| `season` | `2026H1` 这样的半年粒度，不存精确日期 |
| `location_mode` | `onsite` / `virtual` / `mixed`，可选 |
| `stages[]` | 每个环节一个对象，见下 |
| `outcome` | `advanced` / `not_advanced` / `offer` / `unknown` / `withheld`；默认 `withheld`，只进内部聚合，不展示；代码和导出里不出现 rejected |
| `tips_zh` | 中文心得，可选 |
| `source_type` | `student_debrief` 学员口述 / `mentor_compiled` 蔓藤导师整理 / `community_contribution` 用户贡献 |
| `consent_id` | 学员来源必填 |
| `deid_status`、`deid_version` | `pending` / `passed` / `failed`，`passed` 才能发布 |
| `review_status` | `draft` / `in_review` / `published` / `retired` / `withdrawn` |
| `valid_until` | 默认 `season` 结束后 18 个月 |

`stages[]`：`stage`（`resume_screen` / `oa` / `recruiter_call` / `tech_phone` / `vo_round` / `team_match` / `offer_call`，映射到 05 §3.1 看板的 `oa` 或 `interview`）、`round_type`（`coding` / `system_design` / `ml_design` / `sql` / `stats` / `product_case` / `behavioral` / `hiring_manager` / `bug_bash` / `take_home`）、`duration_min`、`topics[]`（与题库共用受控词表）、`question_refs[]`（指向题库）、`paraphrase_en`（改写后的题意，不是原题）、`notes_zh`。

**隐私与授权**

- 学员本人授权三件事：去标识化后用于检索、展示摘录、发送给第三方模型供应商处理（M0-2）。
- 拿不到授权的历史面经，原文不导入；蔓藤导师可以凭经验重写「蔓藤导师整理」版，不含原文（**需法务确认**）。
- 去标识化：删姓名、学校、面试官姓名、组名和精确日期；少见组合泛化；季度合并成半年。
- **决定**：涉及签证、担保的句子入库时剥离，不进检索（4.7）。
- 面试保密：只存考点和改写后的题意，不存原题和 OA 截图；收到公司或平台要求就下架（**需法务审核**）。

**质量控制**：抽取字段（工具辅助加人工核对）→ 蔓藤内容审核员发布，编辑与发布不能是同一人；自动检查字段完整、受控词表、PII（邮箱、电话、URL、人名表、学校表）、近似重复（`content_hash` 加相似度阈值）；命中反馈降权（5.1）；到 `valid_until` 自动 `retired`；更新频率（假设）招聘季（8–12 月、1–4 月）每两周、淡季每月。

**风险**：小样本反推作者（`thin` 不显示比例；不足 3 篇按年合并）；公司主张保密（只存改写题意，通知后 48 小时内下架，假设）；过期（`valid_until`、「较旧」、命中反馈）；编造频率（数字只来自统计；D2 校验器；禁用短语，3.8）；批量抓取（全文配额、无导出、访问日志）。

### 3.2 题库（P0，P0-11）

**谁用**：面在面试间出题、追问、按 rubric 评分（07 P0-10），P1-4 起把面经考点链接到具体题目；前在故事库里标注每个故事能回答哪些 behavioral 题型；教（P1b）把技能缺口转成三件事的「练一道」，P0 期间「练一道」来自面的练习计划。

**用户感知**

- 三件事：「练一道 SQL：找出连续 3 天登录的用户（蔓藤题库 · 中等 · 约 20 分钟）」。
- 面试间：题面英文；复盘逐项列出 rubric 结果，如「Clarifying questions ✓ · Edge cases △ · Complexity analysis ✗（依据蔓藤 rubric v3）」。「我不同意评分」「这题有问题」在 P1-4 随反馈表上线。
- 故事库：「你的『实习时修复支付对账 bug』这个故事能回答题库里 12 道题，最常见的是 *Tell me about a time you dealt with ambiguity*。」

**字段**（`asset_class = question`）：`type`（`coding` / `sql` / `stats` / `ab_testing` / `ml_concept` / `ml_system_design` / `system_design` / `product_sense` / `case` / `behavioral` / `domain_hw`）、`role_families[]`、`difficulty`（1–4）、`topics[]`（受控标签，如 `window_function`）、`prompt_en`（必填）、`prompt_zh`（只用于讲解）、`external_ref`（公开平台题号和链接，**只存引用不存原文**）、`rubric`（3–6 维，每维 0–3 分，每档一句描述）、`key_points`（要点，不写整段范文）、`follow_ups[]`、`time_budget_min`、`company_links`（P1-4 起由面经 `question_refs` 反向统计）、`license_id`、`review_status`、`revision`。

**规则**：behavioral 题不提供范文；面按 rubric 评分，前帮用户从故事库组织**他自己的**回答，不借范文编造经历。蔓藤自编题只有授权含 `display_full` 时才存全文。练习分数只描述这一次回答，禁止说成「通过概率」。

**质量控制**：rubric 由蔓藤导师审核；P1-4 起收「这题有问题」「我不同意评分」进审核队列，反馈注明 rubric 版本；同一份回答评两次，每维分差 ≤ 1（假设）；coding 参考解配可运行测试（P2）；每月一批。

### 3.3 学员简历（P1b，P1-9；校准集 P2）

**原始简历不进入我们的系统**，也永远不把完整简历展示给任何用户。只有三种派生形态：

| 形态 | 是什么 | 谁用 | 分期 |
|---|---|---|---|
| 写法样本 `resume_pattern` | 蔓藤导师在蔓藤侧从已授权简历挑出 bullet，改写成去标识化的「改前 / 改后」：数字区间化，公司和项目名泛化 | 前、投 | P1b（P1-9） |
| 路径统计 `pathway_stat` | 背景类型 × 目标岗位 × 半年 → 时间类指标，n ≥ 5 才展示 | 规、主理人 | P1b（P1-9；规 P1-6） |
| 评审校准集 | 去标识化简历加导师打分，只在内部校准前的简历评审 | 内部评测 | P2 |

**用户感知**（P1b 起）

> 前：这条 bullet 只写了你做了什么，没写规模和结果。蔓藤导师改过很多类似的后端实习 bullet，常见改法是「动作 + 规模 + 结果」。参考（已改写，非真实个人）：
> Before: *Responsible for order service APIs.*
> After: *Built 6 REST endpoints for the order service (~2K QPS); cut p95 latency by 40% with a Redis cache.*
> 你的版本要用你自己的真实数字。你不记得的话我们就先空着，我不会帮你编。

> 规：你问到背景相近的人一般多久拿到第一个面试。过去两季，一年制 CS 硕士、没有美国实习的蔓藤学员，从开始投递到第一个面试多数在 3–8 周（四分位区间；蔓藤学员统计 · n=23 · 2025 下半年–2026 上半年；示例数字）。这只是参考，不代表你的结果。

**路径统计的展示规则**（避免同届比较）

- 只在用户主动问、或规做方向比较时出现；不进晨报、信件卡片和三件事。
- 用四分位区间，不给单一中位数；只展示时间类，不展示 offer 率或面试率（比率只在内部用）。
- 用户自己的已用时长超过中位数时，不显示时长数字，改讲这个阶段常见的卡点和下一步。
- 已录入 OPT 待业日期的用户默认不展示，用户明确要看才给。
- 首批期间只用蔓藤历史数据（M1-2）。

**字段**

- `resume_pattern`：`role_family`、`experience_type`（`intern` / `project` / `research` / `full_time`）、`skill_tags[]`、`before_text`、`after_text`、`principle`（对应方法卡 `resume.bullet_rewrite`）、`numbers_generalized`、`consent_id`、`deid_version`、`reviewer_id`、`review_status`。
- `pathway_stat`：分组键 `degree`（`ms_1y` / `ms_2y` / `phd` / `bs`）、`major_family`、`us_internship`、`target_role_family`、`season`；指标 `n`、`p25_weeks_to_first_interview`、`median_weeks_to_first_interview`、`p75_weeks_to_first_interview`、`median_weeks_to_offer`（只内部用）。任一分组 n < 5 时合并或不发布。

**隐私与授权**：授权主体是学员本人；蔓藤现有协议是否覆盖「用于另一个产品」**需法务审核**，默认假设不覆盖，重新取得 opt-in 授权，可随时撤回。去标识化和改写在蔓藤侧完成。学员撤回后样本 7 天内下架（假设），聚合下个周期重算，已出现在对话里的引用不追溯删除（写进隐私说明）。永远不把一位用户的简历当样本给另一位用户看，不展示可识别个人的组合（01 §8.12）。

**质量与风险**：每条样本由蔓藤导师二审并过 PII 扫描，改法原则与方法卡一致，每季度更新。再识别（泛化、n ≥ 5、不带学校年份公司名）；照抄样本（前只给改法，进待确认前提示「这句和样本高度相似」）；被读成承诺（固定附「不代表你的结果」、按上面规则收窄）。

### 3.4 导师方法论（P0 第一批 5 张）

方法论整理成「方法卡」：带版本的结构化工作方法，不是长提示词（结构沿用 docs/career/product-research.md §4）。

**字段**：`method_id`、`revision`；`title`；`author_id`、`reviewer_id`（都是蔓藤导师，界面只显示「蔓藤导师」，本人同意才显示姓名）；`applies_to`（岗位家族、阶段、处境）；`prerequisites`（对应 `CareerInput`）；`steps[]`（目标、做法、允许的工具、产出）；`rubric_ref`；`stop_when`；`counterexamples`（**必填**，防止个案泛化）；`escalate_when`（何时建议真人，仍按 06 §7 放行）；`evidence_nature`（经验建议 / 公开数据 / 内部统计）；`bound_skills[]`（03 §3.1 的 skill id）；`when_to_use`（≤ 80 字，触发词在前，P1-9 起作独立技能时必填，15 §4.1）；`bound_speakers[]`（03 §1.1 的 key：`companion` / `planner` / `guide` / `coach` / `interviewer` / `networker` / `applier`）；`license_id`、`effective_from`、`superseded_by`。

| method_id | 名称 | `bound_speakers` | `bound_skills` | 分期 |
|---|---|---|---|---|
| `resume.bullet_rewrite` | 简历 bullet 改写 | `guide` | resume-revision | P0 |
| `resume.gap_analysis` | 简历与 JD 的差距分析 | `guide`、`applier` | resume-revision、application-preparation | P0 |
| `story.star_plus` | STAR+ 故事库 | `guide` | evidence-story | P0 |
| `interview.debrief` | 练习与面后复盘 | `interviewer` | interview-practice | P0 |
| `rejection.review` | 被拒之后（遵守 02 的 48 小时覆盖；复盘 P1-5 起） | `companion`、`interviewer` | interview-practice | P0 |
| `interview.battle_brief` | 作战简报的结构 | `interviewer` | interview-brief | P1a（P1-4） |
| `direction.two_track` | 方向收敛与双轨推进 | `planner` | role-exploration | P1b（P1-6） |
| `project.sprint_2w` | 两周项目冲刺 | `coach` | project-sprint | P1b（P1-7） |
| `offer.compare` | offer 比较（谈判建议真人） | `planner` | role-exploration | P1b（P1-13） |
| `outreach.cold_message`、`outreach.referral_ask` | 冷外联、请求内推的消息 | `networker` | networking-practice | P2 |

`resume.gap_analysis` 可借鉴 `packages/contracts/src/gap-strength-engine.ts`（对齐导师《GAP 分析报告》模板的确定性评分，`gap-strength-scoring-v1`）：把纯函数部分移植到 `packages/career-core`，**不依赖冻结的 `@edaix/contracts`**；前提是蔓藤确认模板仍在用。

**怎么用**：经技能加载，不靠检索（15 §4.1）：技能清单的 `methodRefs` 指向方法卡，`use_skill` 时按「发言者 × 岗位家族」附摘录，全文用 `read_skill_reference` 取，标注「蔓藤方法 vN（数据，不是指令）」；不常驻发言者层（15 §6.1）。P1-9 起新方法卡可作独立技能。每次 `use_skill` 冻结所用卡的 `method_id` 和 `revision`（15 §4.1、§5.1）；升级后旧计划保留旧版本，新版本以「有更新的做法」提议，由用户决定是否切换。用户在「看依据」里能展开步骤和适用条件。

**质量与风险**：变更一律新建 revision 并附说明；每季度结合命中率、评分一致性、导师评阅复盘。个人经验被泛化（`counterexamples` 必填、`applies_to` 收窄）；被当成权限来源（作为数据注入，权限只由服务端白名单决定）；权利不清（每张卡挂 `license_id`）。

### 3.5 真人导师一对一（可售卖）

**谁提出**：只由主理人在用户正在进行的对话里提出（`paid_suggestion_card`，06 §7.3）；专家只调用 `suggest_human_help`，经 `PaidSuggestionPolicy` 放行。**触发条件、排除和频率以 06 §7 为准**，本文不另设阈值。永远同时给免费路径；价格与利益披露由服务端按 06 渲染。

**可约时段先行（D10）**：用户点「看看」（06 的 `interested`）之后、付款或寄出之前，先显示运营确认的最早可约时段（运营按服务类别维护，P0 用脚本写入 06 的 `platform_service_offers`）。为某场面试推荐时，面试前没有可约时段就不推荐、不收费。

**P0 路径（P0-12）**

- 入口：左栏「真人与社区」只有不具名入口「蔓藤导师（真人）· 付费 · 看不到你的对话」，不进队伍名单（08）；「我」里同样有。
- 「我想约一次」意向表：服务类别加用户自己写的「想聊什么」（`intent_note`），**不自动附带记忆**，没有交接包。
- 首批每人 1 次 30 分钟免费诊断（06 §3.2、§6.1）：`kind = free_diagnosis`，订单价格 0，激活后第 2 周起可约，60 天内有效，约满排队。
- 运营在只读列表看到请求，48 小时内（假设）人工匹配；会议在产品外进行，产品只存链接；蔓藤线下收款，订单记在 06 的 `platform_mentor_orders`。付款说明和状态变化由服务端发系统通知（`speaker_kind = system`），没有「蔓藤运营」发言者。会后用户打 1–5 分（只内部可见）。

**P1b 路径（P1-10）**：前起草交接包 `mentor_packet`，用户确认后寄出（`final_action = in_product`）。内容、默认勾选、`platform_mentor_grants` 和访问窗口见 03 §11.1–11.2；导师只进 `mentor_room` 房间（03 §11.3）。交接包只含用户已确认的资料和勾选项，不得写入这之外的事实（D2）。会后评阅以「真人 · 蔓藤导师」信件卡片发进主线，写成长证据 `mentor_reviewed`（`CareerEvidence.mentorReview`：`reviewerId` 必须是登录的导师账号，`rubricRevision` 取方法卡版本）。

**履约状态**（`platform_mentor_sessions.status`；订单与退款在 06）

```
P0：  requested → matched → scheduled → completed
P1b： packet_drafting → packet_pending_confirm → requested → … → completed → review_recorded
分支：任意未完成状态 → cancelled；P1b 加 no_show_user / no_show_mentor
```

`requested` 时用户看到「收到了，运营会在 48 小时内为你匹配蔓藤导师（真人）」（假设时限）；`matched` / `scheduled` 由运营推进，旅程里出现预约卡（导师称呼、时间、会议链接）；`completed` 后请用户评分。

**数据** `platform_mentor_sessions`（09 的 026）：`id`、`user_id`、`mentor_id`（匹配后填）、`kind`（`free_diagnosis` / `mock_interview` / `resume_direction` / `offer_negotiation`）、`intent_note`、`order_id`（→ 06 `platform_mentor_orders`）、`packet_id`（P1b）、`status`、`scheduled_at`、`duration_min`、`meeting_url`、`review_id`、时间戳。不含价格和支付字段。

**导师守则**（06 §8.5 之外再加）

- 在一对一中不承诺、不讨论为该学员内推，不收取任何与内推相关的费用（D6）。
- 身份与签证问题一律转学校 DSO 或移民律师。
- 出现危机信号：按 02 §10.3 直接问「你现在安全吗？」，给资源卡上的热线（988、911、741741、学校心理咨询中心）；会后由运营「安全上报」给 `safety_reviewer`。不替学员联系任何人。
- 导师可见内容里不出现第三方联系人姓名（D9）。
- 会议默认不录音，录音须双方同意；录音不得用作声线样本，12 的「不克隆任何真人」适用于蔓藤导师（D14）。
- 签保密协议；不提供个人联系方式、不私下接单（合同约束）。

**风险**：销售施压（06 §7 频率与排除，推荐卡附「这像推销」）；卖出约不上的服务（可约时段先行）；真人与 AI 混淆（「真人 · 蔓藤导师」标识，AI 永不使用）；导师建议与 AI 冲突（交接包附 AI 队伍建议摘要，以导师为准，主理人向用户说明）。

### 3.6 真人导师内推（D6：法务通过前不提供）

**决定**：法务审核通过前，线上线下都不提供内推评估，运营也不人工处理；一对一辅导照常可售。法务通过后开启，不早于 P1b（P1-10）。门槛、服务说明卡固定段落（只在 06 §8.3）、退款与法务问题见 06 §8。

**卖什么**：「内推评估」。用户付的是辅导和准备度评估；内推是否发生由导师按准备度和所在公司规定判断，**不和付费挂钩，也不承诺结果**。

**评估结果文案**

- 准备好了：「蔓藤导师（真人）认为你可以被内推到这个岗位。是否提交由这位蔓藤导师按公司规定决定，提交后会在这里告诉你。」
- 还没准备好（不用红色）：「蔓藤导师（真人）认为还差两点：system design 的取舍讲不清楚；项目里缺少可量化的结果。教和面已经把这两点排进接下来两周的计划。30 天内可以免费复评一次。」

**状态**（`platform_referral_assessments.status`，法务通过后启用）

```
requested → packet_confirmed → assessing → assessed_ready | assessed_not_yet
assessed_not_yet 复评：新建一条 requested，reassessment_of 指向原评估（30 天内限一次，价格 0）
assessed_ready → mentor_deciding → referral_submitted | referral_not_possible
任意阶段 → cancelled
```

`referral_submitted` 是导师自报，成长证据记 `observed`；`referral_not_possible` 的原因对用户可见。

**明确不复用**：`packages/contracts/src/referrals.ts` 的 `ReferralGuaranteeView`、72 小时 SLA 退款和重新匹配，本质是「付费即内推」，禁止使用，只借工作流状态形状参考。

### 3.7 真人导师网络（P1b，P1-9）

「网络」指导师目录加免费或低门槛的接触方式（答疑时段、coffee chat 撮合；同期伙伴 P2）。一对一建在网络之上。主理人和左栏入口使用（P1b）；规在方向探索时找做过该方向的人（P1b）；脉准备 coffee chat（P2）。

> 墨（P1b 起）：你想知道 DE 和后端 SWE 的日常差别在哪。蔓藤导师网络里有 3 位做 DE 的蔓藤导师（真人），每周四晚上 8 点（ET）有一场免费的线上答疑，用会议链接参加。要我先帮你把问题写好吗？

左栏：「真人与社区 · 蔓藤导师答疑（周四 20:00 ET）· 找蔓藤导师一对一」。Discord 答疑频道在 P2（10）。

**字段**（`platform_mentor_profiles`）：`mentor_id`（员工账号，角色 `mentor`）、`display_name`（本人选择的称呼）、`consented_fields[]`（逐项同意公开）、`role_family`、`seniority_bucket`（`3–5y` / `5–10y` / `10y+`）、`current_company`（本人同意且公司允许才显示，否则「行业 + 公司规模」）、`expertise_tags[]`、`languages[]`（zh / en）、`offerings[]`（`office_hours` / `one_on_one` / `resume_review` / `referral_assessment`（法务通过后））、`referral_policy_ack`（所在公司内推政策声明与日期）、`capacity_per_month`、`timezone`、`earliest_slot_at`（运营维护）、`status`（`active` / `paused` / `offboarded`）、`internal_rating`（不对用户显示）。

**匹配**：确定性匹配服务按岗位家族、专长、语言和剩余容量筛选；模型只能引用服务返回的导师 id，**不能推荐库里不存在的导师**。导师本人也是个人信息主体，公开字段逐项同意，可随时下线。容量满了提示排队。

### 3.8 职业规划师话术（P0，对话模式卡）

话术**不作为内容展示**，只用来塑造主理人（P0）和规（P1b）在情绪类、咨询类时刻的做法，改写成「对话模式卡」。

**主动披露**：隐私说明和「我 → 队伍是怎么工作的」写明「主理人在情绪类时刻的做法参考了蔓藤规划师的咨询与陪伴经验，销售内容已全部剔除」，并附下面的剔除规则。

**剔除规则**：每段话术由蔓藤规划师和我们的产品负责人各自独立标注，只保留前三类：`consult` 诊断提问、`companion` 陪伴共情（去掉同届比较）、`inform` 信息解释；剔除 `sales_pressure` 销售施压、`sales_qualify` 为销售做的预算摸底。

| 原话术（虚构示例） | 类别 | 处理后 |
|---|---|---|
| 「很多同学在这个阶段都会这样，比你晚的大有人在。」 | companion 混入同届比较 | 「很多人在这个阶段都会这样，这不说明你不行。」 |
| 「冲刺班只剩最后两个名额。」 | sales_pressure | 剔除 |
| 「家里大概能支持多少预算？」 | sales_qualify | 剔除；经济压力只在用户主动提起时作为情绪话题接住 |
| 「投了 400 份没回音，说明方法有问题，不是你有问题。」 | companion 加 consult | 改为提问：「我们一起看看是哪一步卡住了，是简历、岗位选择，还是面试？」 |

**字段**：`pattern_id`、`situation`（`overwhelmed` / `direction_stuck` / `family_pressure` / `post_rejection` / `long_unemployment` / `peer_comparison` / `considering_quit` / `considering_agency`）、`goal`、`do[]`、`dont[]`、`example_lines_zh[]`、`escalate`（危机信号转 02 §10）、`source_segment_refs`（内部）、`reviewer_id`、`revision`。

**`considering_agency`**（用户在考虑报求职机构）：必须给免费路径（学校 career center、面和前的练习、公开资料），不得推荐蔓藤或任何付费服务；用户主动问蔓藤时按 06 T1。

**怎么用**：在对应处境由上下文组装放进主理人或规的本轮变化层（15 §6.1 第 9 层，不改发言者层），作为「怎么做」的参考；不改变主理人性格（02），不会被检索后原样发给用户。原始咨询录音和聊天记录**不导入**，蔓藤只提供去标识化的文本或模板。

**质量控制**：02 的评测集加 20 个相关处境，其中 `considering_agency` 至少 5 个（检查给了免费路径、没推荐蔓藤）。禁用短语只有一份配置，放在 `packages/career-core`，用短语级规则（如「名额只剩」「最后 N 个」「错过就没」「再不……就」「保 offer」「包内推」「上岸率」「必考」「一定会考」「稳过」），只在主动消息、付费相关消息和模式卡里检查；销售类由 06 维护，界面文案类由 08，主理人表达类由 02，本文引用。监控「这像推销」反馈率；每半年复审。

### 3.9 小企业内推资源（P1b，P1-9）

蔓藤合作的中小企业中，愿意接收蔓藤推荐的岗位。投准备材料，主理人在晨报里一句带过。

**机会卡**（任务卡，今天页汇总）

```
机会 · 蔓藤合作企业
[公司名] · Data Analyst（New Grad）· Columbus, OH · 现场办公 · $65–75K
企业书面说明（2026-09，蔓藤留档）：接受 OPT；STEM OPT 与 H-1B：未说明
和你的匹配：SQL ✓ · Tableau △ · 零售数据经验 ✓（来自你确认的档案）
由蔓藤运营把你确认的材料用邮件转给企业招聘联系人。转递不等于录用。
蔓藤可能从这家企业获得推荐费用。        ← 仅当蔓藤向企业收费时固定出现
[让投准备材料]  [不感兴趣]  [看依据]
```

**转递方式（写死）**

- 投准备材料包 → 待确认 → 用户「确认这一版」→ 蔓藤运营转递。材料包是 05 的 `application_packet`，`final_action = in_product`，`delivery_route = manteng_ops`。
- 运营只把用户确认的那一版（摘要与确认时一致）**用邮件**发给企业的招聘联系人；不登录企业招聘系统，不代填，不代点提交。
- 企业要求走招聘系统时，只把链接给用户，由用户本人或插件按 11 完成，最终提交由用户本人点。
- 这是否算 AGENTS.md 的「后台提交申请」由产品负责人确认（待确认第 3 条）。

**利益披露**：蔓藤向企业收费时，机会卡固定加「蔓藤可能从这家企业获得推荐费用」；「我」里有「不接收合作企业机会」开关；机会排序不高于用户自己收藏的岗位。

**规则**：每周最多 3 条、只推匹配的（假设），不替用户海投；工作授权只引用企业书面说明的原文和日期，没写就显示「未说明」。

**字段**（`asset_class = partner_opportunity`）：`company`（法定名称、域名、规模区间、行业、所在地）、`role_title`、`role_family`、`level`、`employment_type`（只收 `full_time` 和有薪 `contract`）、`pay_range`（必填，无薪不收）、`requirements[]`、`written_statement`（原文、日期、签署人职位，OPT / STEM OPT / H-1B 接受情况）、`everify_self_reported`（STEM OPT 通常要求雇主参加 E-Verify，**需核实，由专业人士审核**）、`vetting`（`checked_at`；公司注册、真实官网、不向候选人收费、有薪、合同审阅）、`referral_fee`（蔓藤是否向企业收费）、`recruiting_contact`（只给运营）、`capacity`、`valid_until`、`status`（`draft` / `vetted` / `open` / `paused` / `closed`）。

**落到代码**：映射为 `CareerJobObservation`，`source` 新增 `'partner'`；`sponsorship` 仍只由岗位原文决定；企业书面说明放进单独的 `authorizationStatements[]`（4.7）。用户材料只在确认后才转给企业，转递记录写进旅程，企业不能浏览用户库。

**风险**：挂靠雇主、收费「实习」、无薪岗位对 OPT 用户后果严重（严格审核，有举报入口，被举报就暂停）；转递变成代投（只发邮件）；以为转递等于录用（固定文案）；推荐费的利益冲突（披露行、开关、排序）。

### 3.10 AI 课程（P1b，P1-7；转写稿检索 P2）

理解为蔓藤现有的 AI 和数据方向技能课（需蔓藤确认）。教把技能缺口转成「一节课 + 一个小练习 + 项目冲刺」；规可以建议「先试一节」。

- 三件事（P1b 起，只放 `included`）：「看一节：Feature Store 是什么（蔓藤课程 · 18 分钟）。为周四 MLE 面试的 ML system design 补一个概念。」
- 教：「看完不算数，做完才算。这节课后面有个 30 分钟的小练习，做完我帮你把它写进项目冲刺。」

**付费单元**：三件事、晨报和信件卡片只放 `included` 单元。`paid` 单元只能按 06 T8 由主理人在对话里推荐，计入 06 §7.2 的频率上限，并同时给免费资料或 `included` 单元；目录里的 `paid` 单元显示价格。

看完课只记作活动，**不产生成长证据**；完成练习并经评阅才记 `practice_review` 或 `project`（`careerProgress`）。不显示连续学习天数和完成率。

**字段**（`course_unit`）：`course_id`、`unit_id`、`title`、`language`、`duration_min`、`format`（`video` / `text` / `notebook` / `live`）、`skill_tags[]`、`role_families[]`、`level`、`prerequisites[]`、`exercise_ref`、`access`（`included` / `paid` / `cohort`）、`price_ref`（`paid` 时指向 06 价目）、`hosted_url`、`transcript`（授权允许检索时才导入）、`license_id`、`revision`、`valid_until`（默认 12 个月）。

**授权**：视频由蔓藤托管，只放外链；转写稿只有授权含 `retrieve` 和 `model_context` 时才进库（P2），只用于文字检索；课程讲师的录音和视频不得用作声线样本（12，D14）。

---

## 4. 落到现有代码

### 4.1 现状（只读核实，`965db09`）

| 事实 | 位置 |
|---|---|
| 私有资料库 `platform_knowledge_sources`（按账号隔离）和 `platform_knowledge_passages`；每账号 ≤ 200 份、每份 ≤ 64 KiB、每段 ≤ 1200 字、≤ 128 段；删除留墓碑，旧引用返回 409 `KNOWLEDGE_REVISION_CONFLICT` | `migrations/014-private-knowledge.sql`；`src/knowledge-sources.ts` 的 `KnowledgeSources`、`splitKnowledgePassages` |
| 检索用 `plainto_tsquery('simple')`，查询含汉字时整句 `ILIKE`；最多 8 段、48 KiB | `KnowledgeSources.search`；`packages/platform-contracts/src/index.ts` |
| `search_knowledge`、`read_knowledge_passage` 只在 agent 模式挂载，返回标为 `untrusted_knowledge` | `src/app.ts` 的 `safeTools` 与 `POST /conversations/:id/messages` |
| `CareerKnowledgePort.search({ownerId, signal}, query)` 返回 `{text, citations}`；`KnowledgeCitation` 有 `sourceId`、`revision`（string）、`passageId`、`updatedAt`（版本登记时间）；没有实现 | `packages/career-core/src/contracts.ts` |
| `prepareCareerRun` 对每个必需输入要求**恰好一条** `ownerId` 相符、`state='current'`、`revision` 为正整数的引用，否则 `missing_input:` / `ambiguous_input:`；`CareerInputReference.revision` 是 number；role-exploration 需要 `knowledge` | `packages/career-core/src/prepare.ts`、`skills.ts` |
| `CareerJobObservation.source` 无 partner；`sponsorship` 为 explicit_yes / explicit_no / unknown；`CareerEvidence.mentorReview` 带 `reviewerId`、`scope`、`rubricRevision` | `contracts.ts` |
| 没有组织和员工角色；学生路由用 `secured(scope)`（认证、`x-companion-account` 账号上下文、邮箱验证、按 scope 限流） | `001_platform.sql`；`app.ts` 的 `secured` |
| 限流 scope 由 013 的两条 CHECK 写死（取代 011），按请求次数、固定窗口计数 | `013_account_action_limits.sql`；`src/request-limits.ts` 的 `UserRequestLimitScope` |
| 审批与输入哈希绑定 | `src/jobs.ts` 的 `inputHash`、`approvalMatches` |

### 4.2 三层知识的边界

组织共享库（面经、题目、方法卡、模式卡、写法样本、路径统计、课程、合作机会）归蔓藤，存新表（4.3）；用户私人库沿用 014，语义不变；用户结构化数据（档案、故事、简历版本、看板）存求职数据表（05、09）。组织内容不会变成用户的数据：「收藏」一篇面经存的是引用，不是副本。第四类外部实时数据（4.12）不进组织库，只存为有保留期的私有结果。

### 4.3 新建：组织共享库的数据模型

表名带 `platform_` 前缀，迁移编号由 09 分配。**P0 只建 09 §3C（021）和第 8B 步（026）列出的表。**

| 表 | 关键字段 | 分期 |
|---|---|---|
| `platform_orgs` | `id`、`slug`（`manteng`）、`display_name`；只有一行 | P0（026） |
| `platform_org_roles` | `org_id`、`user_id`、`role`（`content_editor` / `content_reviewer` / `mentor` / `ops` / `org_admin` / `safety_reviewer`）、`granted_by`、`granted_at`、`revoked_at`。**决定**：员工账号与求职账号分开 | P0（026） |
| `platform_content_licenses` | `org_id`、`asset_class`、`agreement_ref`（合同存私有文件）、`allowed_uses[]`（`retrieve` / `model_context` / `display_excerpt` / `display_full` / `aggregate`，没有「训练」）、`audience`（`all_users` / `cohort` / `entitled` / `staff_only`）、`valid_from`、`valid_until`、`revoked_at`、`revocation_reason` | P0（021） |
| `platform_org_knowledge_sources` | `org_id`、`asset_class`、`title`、`body`（≤ 64 KiB）、`structured` jsonb、`language`、`role_families[]`、`company_key`、`season`、`tags[]`、`license_id` NOT NULL、`consent_id`、`deid_status`、`deid_version`、`review_status`、`editor_id`、`reviewer_id`（CHECK ≠ `editor_id`）、`reviewed_at`、`valid_until`、`revision`、`content_hash`、`publish_batch`（全局单调递增整数）、`retired_at`、`withdrawn_at`；revision 与墓碑语义同 014 | P0（021） |
| `platform_org_knowledge_passages` | `source_id`、`revision`、`passage_id`、`passage_index`、`content`、`search_vector`；分段沿用 `splitKnowledgePassages` | P0（021） |
| `platform_user_entitlements` | `user_id`、`org_id`、`audience_grants[]`、`granted_at`、`expires_at`、`revoked_at`；首批全部授予 `cohort`，会员同步见 06 | P0（021） |
| `platform_knowledge_access_log` | `user_id`、`source_id`、`revision`、`passage_id`、`asset_class`、`speaker`、`conversation_id`、`message_id`、`purpose`（`battle_brief` / `practice` / `chat_answer` / `morning_brief` / `view_source`…）、`created_at`；保留 180 天（假设），由 09 的 `retention` 任务清理 | P0（021） |
| `platform_data_consents` | `org_id`、`subject_kind`（`student` / `mentor` / `user`）、`subject_ref`（蔓藤侧编号的哈希或 `user_id`）、`scopes[]`（`interview_report` / `resume_pattern` / `outcome_aggregate` / `profile_display`）、`consent_text_revision`、`granted_at`、`withdrawn_at`、`evidence_ref`；不存姓名 | P1a（P1-4） |
| `platform_content_feedback` | `user_id`、`source_id`、`revision`、`kind`（`hit` / `miss` / `wrong` / `outdated` / `disagree_score`）、`note`、`created_at`；个人数据（5.1）。「这像推销」记在 06 的 `platform_paid_suggestions` | P1a（P1-4） |
| `platform_contribution_reach` | `source_id`、`reach_count`；不含用户 id（5.3） | P1b（P1-9） |
| `platform_mentor_sessions` | 3.5；订单是 06 的 `platform_mentor_orders` | P0（026） |
| `platform_mentor_profiles` / `platform_referral_assessments` | 3.7 / 3.6 | P1b / 法务通过后 |

各 asset_class 的 `structured` schema 以纯函数校验器放在 `packages/career-core/src/assets/`（新目录），`role_family` 常量也在 career-core。

### 4.4 检索顺序与工具

新建 `services/platform-api/src/org-knowledge.ts` 的 `OrgKnowledge`，接口对齐 `KnowledgeSources`。`search(userId, input, signal)`：

1. `userId` 只来自服务端认证。
2. **先过滤授权**：license 有效且 `allowed_uses` 同时含 `retrieve` 和 `model_context`；audience 在用户 entitlements 内；`published`、未撤回、未过 `valid_until`（`includeOlder` 时可取 retired，标「较旧」）。
3. 结构化筛选：`asset_class`、`company_key`、`role_family`、`stage`、`type`、`tags`。
4. 文本排序（4.5，P1-4 起）。
5. 预算：最多 8 段、48 KiB。**每日全文配额**按访问日志统计当天读过的不同 `source_id`（面经 30 篇/天，假设），同一份简报反复打开不重复计数；超出时只返回摘要和覆盖统计，提示「今天的全文额度用完了，摘要还可以看」。
6. 写访问日志。
7. 返回段落带 `scope:'org'`、`assetClass`、`provenanceLabel`，保留 `provenance:'untrusted_knowledge'`。

| 工具 | 参数 | 返回 | 使用者与分期（白名单见 03 §2.7） |
|---|---|---|---|
| `search_org_knowledge` | `assetClass`、`query?`、`filters{company?, roleFamily?, stage?, questionType?, topics?, season?}`、`limit ≤ 8`、`includeOlder?` | 段落、引用、覆盖档位 | 面、前、投（P0）；教、规，主理人只查课程（P1b） |
| `read_org_knowledge_passage` | `sourceId`、`revision`、`passageId` | 单段；版本变化或撤回时返回安全错误 | 同上 |
| `summarize_interview_coverage` | `company`、`roleFamily` | **确定性统计**：篇数、半年范围、各考点 n/m、档位 | 面（P1-4） |
| `find_mentors` | `need`、`roleFamily`、`language` | 匹配服务返回的导师 id 和公开字段；P1b 起可由蔓藤 MCP 只读提供（4.12） | 主理人、前（P1b）；脉（P2） |
| `search_partner_opportunities` | `roleFamily`、`location?` | 合作机会；同上 | 投（P1b）；脉（P2） |

现有 `search_knowledge` 保持只查私人库；方法卡随技能加载、模式卡按处境注入，都不走检索。工具由能力目录按发言者 × 房间挂载，执行时再核（15 §4.7）。

### 4.5 中文检索

- **P0**：只用结构化筛选（岗位家族、题型、难度），不做中文全文检索（07 P0-11）。
- **阶段 A（P1a，P1-4，随面经）**：结构化筛选优先，文本只负责排序。入库时应用层生成检索词：拉丁文字按 `'simple'` 分词；连续汉字切成重叠两字词（「系统设计」→「系统」「统设」「设计」），写入同一个 `tsvector`；查询端同样切分，OR 召回，`ts_rank_cd` 排序。另维护中英受控标签与同义词表（「系统设计 ↔ system design」「行为面 ↔ behavioral」）。不需要新扩展或服务。私人库是否同样升级按 15 §4.2 的 30 条中文夹具决定（recall@5 < 0.8 时在 09 第 3C 步加同样的 `tsvector` 列）。
- **阶段 B（评测不达标时）**：评估 trigram 扩展或向量、混合检索，选型由 09 定；embedding 仍是可选能力（docs/career/data-integrations.md）。
- **评测集**：蔓藤审核员和我们写 120 条真实中英混合查询（如「Acme Pay new grad VO 考什么」「窗口函数 中等题」）并标注期望结果；recall@5 ≥ 0.8（假设，以 07 为准），跨权限返回为 0。

### 4.6 接入 `CareerKnowledgePort` 与 prepare 闸门

- 新建 `services/platform-api/src/career-knowledge.ts` 实现 `CareerKnowledgePort`：同时查私人库和组织库，合并返回 `{text, citations}`。
- `KnowledgeCitation` 新增可选 `scope?: 'private' | 'org'` 和 `assetClass?`，向后兼容（09 排期）。`updatedAt` 在界面显示为「收录于 2026-09」；面经发生时间看 `season`。
- **prepare 闸门**：组织内容过不了 `ownerId` 校验，私人库与组织库各给一条引用又会 `ambiguous_input:knowledge`。**决定**：每次运行只构造**一条** `knowledge` 引用，代表「私人库 + 组织库批次」：`{input:'knowledge', id:'knowledge-access:<userId>', revision:<当前全局 publish_batch，尚无发布时为 1>, ownerId:<userId>, state:'current'}`，私人库不再单独给引用。
- 有有效 entitlement 时，冻结记录 `platform_expert_runs`（03 §6.5）记 `org_scope:<audience_grants>` 和 `entitlement_id`；没有 entitlement（不在首批、已到期）时引用仍为 `current`，只查私人库，记 `org_scope = 'none'`，规（P1b）不会因此永远 blocked。
- 运行中 entitlement 被撤销：该运行冻结的引用转为 `withdrawn`，重新 prepare 返回 blocked，之后的组织库读取返回 `NOT_ENTITLED`；下一次新运行按「没有 entitlement」构造。
- 单元测试三条：私人库加组织库 → 一条引用、`ready_for_draft`；没有 entitlement → `ready_for_draft`、`org_scope = 'none'`、不返回组织段落；entitlement 撤销 → 冻结引用 blocked、新运行只查私人库。

### 4.7 Sponsorship 与身份信息的来源边界

`CareerJobObservation.sponsorship` **只**由岗位原文写入（`explicit_yes` / `explicit_no` / `unknown`，原句定位见 03、09）。合作企业书面说明进 `authorizationStatements[]`，显示「企业书面说明（日期）」加原文；面经和学员口述里的相关句子入库时剥离；蔓藤历史结果只做聚合，不显示单家公司的担保历史。这三者都不能写入 `sponsorship`。队员永远不说「这家会 sponsor 你」，统一说法：「以岗位原文和雇主的书面答复为准；你自己的身份问题请问学校 DSO 或移民律师。」（01 §8.7）

### 4.8 内容导入与运营工具

流水线：蔓藤盘点（M0-1）→ 授权（licenses、consents）→ 按 6.2 模板导出 → 蔓藤侧去标识化、我们的扫描器复核 → 工具辅助结构化、人工核对 → 审核发布（审核员不能是编辑本人）→ 监控命中率与纠错 → 过期或撤回（墓碑）。

- **P0 导入脚本** `services/platform-api/src/org-content-import.ts`（运行方式参考 `src/migrate.ts`）：
  - `import <bundle> --license <id>`：导入为 `in_review`。模板的 `editor`、`reviewer` 列填员工账号邮箱，校验两人分别持有 `content_editor`、`content_reviewer` 角色且不是同一人，逐行写入 `editor_id`、`reviewer_id`；**有一行不符合就整批拒绝**。
  - `publish --batch <id>`：按行内 `reviewer_id` 发布，分配新的 `publish_batch`。审核在导出前的表格里完成。
  - `withdraw <source-id> --reason <text>`：紧急下架（墓碑），写审计。
  - `mentor-request set-status <id> <status> [--mentor --at --url]`：P0 运营推进真人请求。
- **P0 运营只读列表**：看真人请求、下架记录和安全上报；唯一的写操作是「安全上报」（转给 `safety_reviewer`）。
- **P1b（P1-9）运营台**：网页编辑、审核、版本差异；改状态、看交接包（P1-10）、下架、纠错队列。
- **P2（M2-2）**：蔓藤 MCP 只读导出工具也可作为来源（员工账号、逐次审批，03 §9.5），结果导入为 `in_review`，其余规则不变。

守卫：`app.ts` 新增按 `platform_org_roles` 判断的 `staffOnly`，**叠加在 `secure` 之上**（同样要求 `x-companion-account`）；员工操作写 `platform_staff_audit`（09 第 8B 步）。

### 4.9 审计与安全

- 组织内容是 `untrusted_knowledge`（蔓藤 MCP 结果是同级的 `untrusted_mcp`），永远不是指令；`app.ts` 现在只对 agent 模式生效的这条说明，并入平台策略层，对所有发言者生效。
- 不提供导出接口。突发限流新增 scope `org-knowledge`：同时改 013 的 `platform_request_limits_scope_check`、`platform_request_limits_check` 和 `UserRequestLimitScope`，建议随 021 一次做完（09）；每日全文配额按访问日志计，不挂在限流表上。
- 员工操作（发布、撤回、看交接包、改状态）写审计。员工看不到用户的私人库、记忆和对话；P1-10 起导师只看到用户确认寄出的交接包。
- 发给商业模型供应商：`allowed_uses` 必须含 `model_context`，写进隐私说明；学员来源段落发送前再做一次 PII 扫描。
- 撤回沿用墓碑语义；缓存键含 `revision` 和 `publish_batch`。
- **Discord 与导师可见内容**：蔓藤内容全文不进 Discord 私信，只发摘要和「到网页查看」；交接包只在网页确认；不出现第三方联系人姓名（D9）。其余见 10。

### 4.10 接口

前缀 `/api/platform`。学生接口挂 `secure`（要求 `x-companion-account`，经 `BoundPlatformClient` 发出，账号上下文错误统一转「确认账号」页），响应 `Cache-Control: private, no-store`，对象不属于当前账号一律 404。员工接口挂 `staffOnly`，无角色返回 403 `STAFF_ROLE_REQUIRED`，每次调用写 `platform_staff_audit`。

| 方法与路径 | 用途与参数 | 主要错误码 | 分期 |
|---|---|---|---|
| `GET /org-knowledge/passages/:sourceId/:revision/:passageId` | 「看依据」：正文、标签、来源类型、版本、收录时间、去标识化状态、是否较旧 | 403 `NOT_ENTITLED`；409 `STALE_REVISION`（变更或撤回，带 `withdrawn`）；429 `QUOTA_EXCEEDED`（仍返回摘要） | P0 |
| `POST /org-knowledge/feedback` | `{sourceId, revision, passageId?, kind, note?≤500, practiceId?}` | 400 `INVALID_FEEDBACK`；403 `NOT_ENTITLED`、`FEEDBACK_DISABLED`；409 `STALE_REVISION` | P1a（P1-4） |
| `POST /mentor-requests` | 意向表 `{kind, intentNote≤1000}` | 400 `INVALID_REQUEST`；409 `REQUEST_ALREADY_OPEN`、`FREE_DIAGNOSIS_USED` | P0 |
| `GET /mentor-requests`；`POST /mentor-requests/:id/cancel` | 自己的真人服务卡；取消 | 409 `INVALID_STATE` | P0 |
| `POST /org-contributions/:id/withdraw` | 撤回自己的贡献 | 409 `INVALID_STATE` | P1b（P1-9） |
| `GET /staff/mentor-requests?status=&cursor=` | 运营只读列表 | — | P0 |
| `POST /staff/safety-reports` | `{mentorSessionId, note}` | — | P0 |
| `POST /staff/mentor-requests/:id/status` | `{to, mentorId?, scheduledAt?, meetingUrl?}` | 409 `INVALID_TRANSITION` | P1b（P0 用脚本） |
| `GET /staff/mentor-requests/:id/packet` | 看交接包，只限匹配到的导师和运营 | 403 `NOT_GRANTED` | P1b（P1-10） |
| `POST /staff/org-sources/:id/withdraw` | 紧急下架 `{reason}` | 409 `ALREADY_WITHDRAWN` | P1b（P0 用脚本） |
| `GET /staff/content-feedback?kind=&cursor=` | 纠错队列 | — | P1b（P1-9） |

「这像推销」和推荐卡的接口在 06；`knowledge_contribution`、`mentor_packet` 走 03 §9.6 的待确认接口。

### 4.11 账号删除与导出

| 对象 | 删除账号时 | 导出 |
|---|---|---|
| `platform_knowledge_access_log` | 直接删除 | 否 |
| `platform_content_feedback` | 直接删除 | 是 |
| 已发布的贡献面经 | 默认按墓碑撤回，聚合下个周期重算；删除确认页可选「保留匿名版」，保留时断开与账号的关联 | 是 |
| 未发布的 `knowledge_contribution` | 删除 | 是 |
| `platform_data_consents`（`subject_kind = user`） | 保留 `granted_at`、`withdrawn_at`（记为删除时间）、`consent_text_revision`，删 `subject_ref` | 是 |
| `mentor_packet`、`platform_mentor_grants`、`platform_mentor_sessions`、`platform_user_entitlements` | 删除 | 前三项是 |
| `platform_mentor_orders`（06） | 只按 06 的财务保留期保留金额和 `payment_ref`，与账号断开 | 是 |

删除确认页文案：「你留下的面经默认会一起撤回；也可以保留匿名版，让后来的人继续看到。寄给蔓藤导师（真人）的交接包会删除，但对方已经看过的内容没办法收回。」

### 4.12 以 MCP 交付：选项与取舍

MCP 接入（`docs/platform/mcp.md`）是专家读外部数据的唯一通道（03 §2.8）：审阅过的目录、连接授权、调用回执、私有结果、`untrusted_mcp` 标记。限制：目录全局一份，服务凭据共用，远端看不到是哪位用户；每次调用前重新发现工具，会话上限 15 秒；只读。

| 资产 | 走法 | 理由 |
|---|---|---|
| 题库与 rubric、方法卡、对话模式卡、面经、写法样本、路径统计 | 导入组织库（4.3），查询不走 MCP；P2 起摄取可经 MCP（4.8） | 下列四点 |
| 导师可约时段（`find_mentors`）、导师网络（M1-3）、课程目录（M1-4）、合作机会（M1-5） | P1b 起，蔓藤有在用的系统时以 MCP 只读交付（`org` 来源）；没有就导入 | 每天在变，导出很快过期；不含学生数据。预约与订单仍在我方表（3.5、06） |

授权语料不走实时 MCP：
1. **授权与 `license_id`**：我方按条目的 license、`allowed_uses`、audience 和 entitlement 过滤（4.4），撤回走墓碑；远端结果没有逐条 `license_id` 和 `revision`，D2 的 citation 校验和 `STALE_REVISION` 都做不了。
2. **去标识化**：入库前蔓藤侧去标识化、我方扫描复核、编辑与审核分离；实时调用会绕过 `in_review`。
3. **统计与配额**：覆盖档位要对全量面经确定性计数，`thin` 档防反推；每日全文配额和访问日志都在我方。远端给的统计只能标「该来源称」，不进档位。
4. **回流与延迟**：命中反馈、纠错、贡献触达都挂在 `source_id` + `revision` 上；回流不经 MCP，仍按第 5 节。面试间同步出题要本地读取。

走 MCP 的来源：目录条目登记 `orgId`、`licenseId`、`audience`，调用前在我方核 entitlement 和 `allowed_uses`（含 `retrieve`、`model_context`）；出站只发分配表列出的字段，不含学生个人信息；导师只返回本人同意公开的字段（3.7），不返回招聘联系人；结果存为私有结果（7 天，假设），不进组织库、不写 `sponsorship`（4.7），license 撤回后旧结果不可读。学生第一次用到时在要用该来源的队员单聊里授权（03 §2.8）。

---

## 5. 结果回流飞轮

用户确认的结果和面后复盘 →（用户按次同意、先预览匿名版）→ 蔓藤审核 → 组织共享库 → 作战简报和练习更准；同时给蔓藤不含个人数据的聚合报告 → 补内容、改方法卡、培训导师。

### 5.1 回流什么

| 回流项 | 来源时刻 | 产生什么 | 用户同意方式 | 分期 |
|---|---|---|---|---|
| 面后复盘 → 面经 | 投递标为「已面」后面邀请复盘；被拒 48 小时覆盖期内不邀请贡献 | `community_contribution` 面经 | 每次单独确认，走待确认 | P1b（P1-9） |
| 命中反馈 | 有作战简报的面试结束后 | hit / miss | **个人数据**（等于记录「此人面过这家这一轮」），写进隐私说明；标注时附一句「这会记下你面过这一轮，用来改进面经，蔓藤只看到不含你身份的汇总」和关闭入口；「我」里可关；删账号时一并删 | P1a（P1-4） |
| 阶段流转 | 投递看板 | 路径统计的时间指标 | 「匿名计入统计」开关，默认关闭，第一次标「面试」时问一次；首批期间不用于统计 | P1b |
| 练习评分 | 面试间 | 难度校准、rubric 一致性 | 内部质量改进，写进隐私说明 | P0 |
| 导师评阅 | 一对一之后 | 方法卡效果、导师质量 | 内部 | P1b（P1-10） |
| 纠错 | 「这条不对」 | 审核队列 | — | P1a |

### 5.2 贡献流程与文案（P1b，P1-9）

> 面：这场面完了，辛苦了。要不要花 5 分钟和我复盘一下？复盘内容只给你自己看。

> 面：这次的考点挺有代表性。要不要匿名留给后来面这家的人？我会先给你看去掉个人信息后的样子，你确认了才会交给蔓藤审核。
> [看看匿名版]  [不用了]

**决定**：贡献是待确认对象 `knowledge_contribution`（03 §9.1，主理人或面起草，`final_action = in_product`），沿用输入哈希绑定，匿名版任何改动都要重新确认。用户可以撤回，走墓碑语义，聚合下个周期重算。

### 5.3 激励

不给物质激励，以免有人为奖励编造面经。只在年鉴（P2）里致谢，如「你留下了 2 篇面经，被 31 位后来者用到」。数字来自 `platform_contribution_reach`：写访问日志时，如果该用户在日志里还没读过这篇贡献，`reach_count` 加 1；计数不含用户 id，不受访问日志 180 天保留期影响（超过 180 天再读可能重复计数，可接受）。n ≥ 5 才显示。

### 5.4 飞轮指标（假设；阈值以 07 为准，写进 P1-4 的闸门）

| 指标 | 定义 | 首批目标 |
|---|---|---|
| 面经覆盖率 | 首批用户**进入面试（OA 之后）**的「公司 × 岗位家族」中，近 18 个月有 ≥ 3 篇面经的比例 | ≥ 40%；6 个月后 ≥ 60% |
| OA 覆盖率（单列） | 进入 OA 的组合中，有含 `oa` 环节面经的比例 | 只观察 |
| 作战简报命中率 | hit / (hit + miss) | ≥ 60% |
| 贡献率 | 面过试的用户中贡献过 ≥ 1 篇的比例 | ≥ 20% |
| 从贡献到发布 / 纠错闭环 | 中位天数 | ≤ 7 天 / ≤ 5 天 |

上线前没有面试数据，用招募问卷的「目标公司前 10 家」（07 §6.2）× 岗位家族估算覆盖率。

### 5.5 给蔓藤的回流

首批期间每周、之后每月一份聚合报告，数据来自不含 `user_id` 的聚合表（公司规范名 × 岗位家族 × 周，n ≥ 3 才导出）：缺口清单（被查询但没有面经的「公司 × 岗位」前 20）、命中率最低的面经和题目、方法卡反馈、按终面数量预估的导师需求、纠错汇总。

**决定**：报告不含个人数据；蔓藤销售拿不到用户名单和任何个人的求职状态，意向表和订单数据不进销售 CRM。唯一例外是用户主动寄出的交接包（P1-10），只给匹配到的导师和运营。

### 5.6 护栏

没有方法说明和样本量，不对外宣传「上岸率」（06 §8.6）；首批不用用户或蔓藤数据训练模型（用户数据将来只凭单独同意，01 §8.12；蔓藤数据另需书面授权，`allowed_uses` 里没有「训练」）；贡献可撤回；「匿名计入统计」随时可关，下个周期起不再计入。

---

## 6. 给蔓藤的数据与资源需求清单

### 6.1 清单（按交付时间）

数量级是假设，依据首批集中在 SWE、DS、DA、MLE；实际以 07 的首批人数和招募问卷为准。

**B1 之前（P0）**

| 编号 | 需要什么 | 数量级（假设） | 对应功能 |
|---|---|---|---|
| M0-1 | 资产盘点表，每个资产集合一行：名称、十类中的哪类、负责人、存放位置与格式、数量、覆盖岗位与公司、时间范围、是否含个人信息、原始授权依据、能否检索 / 发送给模型供应商 / 展示摘录 / 聚合、撤回方式；之后每季度更新 | 1 份 | 全部 |
| M0-2 | 书面授权：每类资产一份内容授权（必须含「发送给第三方模型供应商处理」）；学员和导师个人信息的授权文本与收集方式（我们起草，蔓藤发起收集，法务审核） | 每类 1 份 | 全部 |
| M0-4 | 题库（模板 B）：behavioral ≥ 80，SQL ≥ 100，统计与 A/B ≥ 60，ML 概念 ≥ 80，ML 或系统设计 ≥ 40，product sense 与 case ≥ 40，coding 公开题号引用 ≥ 100；前 150 题带 rubric；每月更新 | 400–800 题 | 面试间、三件事、故事库 |
| M0-5a | 方法卡第一批（模板 C）：3.4 表中标 P0 的 5 张，每张一位作者、一位审核导师 | 5 张 | 主理人、前、投、面 |
| M0-6 | 规划师话术：去标识化的典型话术或片段（**不是**原始录音或聊天记录），外加一位规划师参加一次 2 小时标注会 | 20–40 段 | 对话模式卡 |
| M0-7 | 首批蔓藤导师：覆盖 SWE、DS/DA、MLE，至少 2 位做过面试官；人数按「60 天内消化每人一次免费诊断」加付费请求计算。每位提供服务类别、每月容量、时区、语言、所在公司内推政策声明、保密协议、签署的导师守则（3.5）；另需运营对接人与响应时限（假设 48 小时匹配） | 5–8 位起 | 真人入口（P0-12） |
| M0-8 | 联系人：内容负责人；内容审核员至少 2 位（编辑与发布分离，各配员工账号）；法务；运营对接人；下架联系人；安全上报对接人 | — | 流水线、运营列表 |

**B2 之前（P1a，P1-4）**

| 编号 | 需要什么 | 数量级（假设） | 对应功能 |
|---|---|---|---|
| M0-3 | 面经（模板 A，需 M0-2 的学员授权）：SWE、DS、DA、MLE 四类 new grad，2024 下半年起；公司名单由我们按招募问卷提供，按「new grad 实际面试量」排序，约 50 家；招聘季每两周、淡季每月更新 | 300–600 篇 | 作战简报、面试间 |
| M0-5b | 方法卡 `interview.battle_brief` | 1 张 | 作战简报 |

**P1b（首批上线后 4–8 周起）**

| 编号 | 需要什么 | 数量级（假设） | 对应功能 |
|---|---|---|---|
| M1-1 | 简历写法样本（模板 D），由蔓藤导师在蔓藤侧从已授权简历改写，按岗位家族分布 | 150–300 条 | 前、投的简历建议（P1-9） |
| M1-2 | 历年学员结果聚合：2023–2026 各半年，按「学位 × 专业族 × 有无美国实习 × 目标岗位家族」分组，给人数、开始投递月份、首个面试用时的四分位数与中位数、offer 用时中位数；n < 5 合并 | 每半年 1 张 | 路径统计（P1-6、P1-9）、飞轮基线 |
| M1-3 | 导师网络目录（3.7 字段）与每月答疑排期；有在用的系统时可改为 MCP 只读（6.3） | 30–100 位 | 左栏「真人与社区」 |
| M1-4 | AI 课程目录：课程 → 单元 → 技能标签 → 时长 → 练习 → `included` / `paid` 与价格；同上 | 以现有为准 | 教、三件事（P1-7） |
| M1-5 | 小企业内推资源（3.9 字段），含审核记录、招聘联系人、是否向企业收费；机会状态同上，联系人只交运营 | 10–30 家 | 机会卡（P1-9） |
| M1-6 | 内推评估的法务意见；导师雇主内推政策声明 | — | 内推评估（D6，法务通过后） |
| M1-7 | 方法卡第二批：`direction.two_track`、`project.sprint_2w`、`offer.compare` | 3 张 | 规、教 |

**P2**：M2-1 已授权、在蔓藤侧去标识化的学员简历 100–200 份加导师打分（前的评审校准）；M2-2 内部系统只读接口，以 MCP 服务交付（6.3；限定字段、ACL 映射、撤回同步）；M2-3 Discord 社区运营人力、答疑排期、同期伙伴人选池、`outreach.*` 方法卡；M2-4 EE、ME 方向的面经和导师（01 Persona C）；M2-5 授权允许检索的课程转写稿。

### 6.2 交付模板（列名可直接做成表格）

`editor`、`reviewer` 一律填员工账号邮箱，导入规则见 4.8。

**模板 A：面经**（一行一个环节，用 `report_ref` 串起同一篇）

`report_ref, company_name, company_domain, role_family, level, season, location_mode, stage, round_type, duration_min, topics, question_refs, paraphrase_en, notes_zh, outcome, tips_zh, source_type, consent_ref, editor, reviewer`

**模板 B：题库**

`question_ref, type, role_families, difficulty, topics, prompt_en, prompt_zh, external_ref, rubric_dimensions（维度名|0分|1分|2分|3分，多个维度用 ; 分隔）, key_points, follow_ups, time_budget_min, editor, reviewer`

**模板 C：方法卡**（Markdown front matter）

```
---
method_id: story.star_plus
revision: 2
title: STAR+ 故事法
author: <导师编号>
editor: <员工邮箱>
reviewer: <员工邮箱>
applies_to: {role_families: [swe, ds], stages: [interview], situations: [behavioral_prep]}
prerequisites: [project-facts]
bound_skills: [evidence-story]
bound_speakers: [guide]
when_to_use: 用户要准备 behavioral、讲不出结果、想把一段经历存成故事时用
evidence_nature: 经验建议
escalate_when: [用户两次练习仍无法给出可量化结果, 涉及真实雇佣纠纷]
---
## 步骤
## 评价标准
## 什么时候不适用
```

**模板 D：写法样本**

`pattern_ref, role_family, experience_type, skill_tags, before_text, after_text, principle, numbers_generalized, consent_ref, editor, reviewer`

### 6.3 以 MCP 交付时的要求（可选）

适用于导师可约时段、M1-3、M1-4、M1-5（P1b）和 M2-2（P2）。M0-2 的授权和 `license_id` 照常，MCP 只改变交付方式（4.12）。

- 公网 HTTPS 域名，不能是 IP、内网或本机；只读工具。
- 每个工具的名称、完整输入与输出 schema、示例；schema 变更提前通知（一变旧连接即失效）。单次结果不超过 64 KiB，按单条或分页返回。
- 服务凭据经我们指定的密钥通道交付，不经聊天和邮件；写明限流、可用时段、故障与停用联系人、内容保留和费用条款。
- 不返回学生个人信息和招聘联系人；导师只返回本人同意公开的字段。

---

## 7. 分期汇总（以 07 为准）

| 资产 | P0 | P1a | P1b | P2 |
|---|---|---|---|---|
| 面经 | — | 导入（带 `consent_id`）、覆盖统计、作战简报（D2 渲染）、命中反馈（P1-4） | 用户贡献（P1-9） | 内部接口同步 |
| 题库 | 导入、rubric、面试间与三件事（P0-10、P0-11） | 「我不同意」「这题有问题」（P1-4） | — | coding 参考解测试 |
| 学员简历 | — | — | 写法样本、路径统计（P1-9；规 P1-6） | 校准集 |
| 方法论 | 第一批 5 张，随技能加载，冻结版本（P0-11） | `interview.battle_brief`（P1-4） | 第二批 3 张（P1-6、P1-7、P1-13）；升级时提议迁移 | `outreach.*`；gap 纯函数移植 |
| 一对一 | 入口、价格、意向表、免费诊断、只读列表（P0-12） | — | 交接包、预约、评阅回流、导师入 `mentor_room`（P1-10） | — |
| 内推评估 | 不提供（D6） | 不提供 | 法务通过后开启（P1-10） | — |
| 导师网络 | — | — | 目录、会议链接答疑、`find_mentors`（P1-9） | Discord 答疑、同期伙伴、脉 |
| 规划师话术 | 对话模式卡、`considering_agency` 评测、披露（P0-11） | — | 规使用（P1-6）；半年复审 | — |
| 小企业内推 | — | — | 机会卡、邮件转递（P1-9） | — |
| AI 课程 | — | — | 目录与外链（P1-7） | 转写稿检索 |
| MCP 来源（4.12） | — | — | 导师可约时段、导师网络、课程目录、合作机会（蔓藤提供时） | M2-2 同步进组织库 |
| 代码底座 | 021：授权、组织库表、entitlements、访问日志、`OrgKnowledge`、`career-knowledge.ts`、结构化筛选、导入脚本、配额；026：员工角色、`platform_mentor_sessions`、只读列表、`staffOnly` | `platform_data_consents`、`platform_content_feedback`、二元切分检索、`summarize_interview_coverage` | 运营台、`platform_mentor_profiles`、`platform_contribution_reach`；检索阶段 B（视评测） | 内部只读接口 |

---

## 8. 验收标准

- [ ] 没有 `license_id` 的内容无法发布；学员来源没有 `consent_id` 无法发布（约束加单元测试）。
- [ ] 导入时 `editor` 与 `reviewer` 为同一人或缺少对应角色，整批拒绝。
- [ ] 用户之间、员工与用户之间读不到对方私人库；员工看不到记忆和对话。
- [ ] 撤回授权或内容后，下一次检索不再返回；旧引用返回 `STALE_REVISION`。
- [ ] prepare 闸门三条单测通过（4.6）。
- [ ] 作战简报的篇数、n/m、档位、时间段都来自 `summarize_interview_coverage`；`thin` 档不出现 n/m。
- [ ] 单元测试：伪造的 citation（不在本轮访问日志里）被校验器拒绝；两次失败后 `none` 档文案由服务端插入，正文不出现蔓藤标签。
- [ ] 每条蔓藤内容都带服务端渲染的出处标签，点开可见来源类型、版本、收录时间、去标识化状态。
- [ ] `sponsorship` 只能由岗位原文写入；回复中不出现「这家会 sponsor 你」一类断言（单元测试加评测集）。
- [ ] 中文检索 recall@5 达到 07 的阈值，跨权限返回为 0（P1-4）。
- [ ] 交接包和面经贡献内容改动后必须重新确认。
- [ ] 三件事、晨报、信件卡片和作战简报里不出现 `paid` 课程单元或任何付费推荐（单元测试）。
- [ ] 付费推荐只由主理人在对话中发出并通过 06 §7 的判定；面试前没有可约时段时不出推荐卡。
- [ ] `considering_agency` 评测：100% 给免费路径，0 次推荐蔓藤；禁用短语配置在主动消息、付费消息和模式卡上生效。
- [ ] 隐私说明和「我 → 队伍是怎么工作的」含规划师经验的披露句和剔除规则；隐私说明写明命中反馈是个人数据。
- [ ] 每日全文配额按当天不同 `source_id` 计，同一份简报反复打开不消耗额度；没有批量导出接口。
- [ ] 内推评估在法务通过前，界面和运营流程都没有入口。
- [ ] `delivery_route = manteng_ops` 的材料包在服务端没有任何登录或提交招聘系统的代码路径。
- [ ] 删除账号按 4.11 处理；导出含贡献、反馈、交接包、授权记录和真人服务记录。
- [ ] 学生接口都要求 `x-companion-account`；员工接口无角色返回 `STAFF_ROLE_REQUIRED` 并写审计。
- [ ] Discord 私信和导师可见内容中不出现面经全文、交接包内容、身份信息或第三方联系人姓名。
- [ ] 蔓藤 MCP 来源调用前核 entitlement 与 `allowed_uses`；结果不进组织库、不写 `sponsorship`，license 撤回后不可读。

---

## 9. 假设与验证方法

| 假设 | 数值 | 如何验证 |
|---|---|---|
| 面经量 | 300–600 篇使覆盖率（5.4 口径）达 40% | 上线前用问卷前 10 家对照 M0-1 库存估算；P1-4 后每周跟踪 |
| 题库规模 | 400–800 题 | 「同题重复出现率」超过 20% 说明不够 |
| 首批导师数 | 5–8 位起 | 首批人数 × 1 次免费诊断，加真人请求率（假设每月 10–20%），对照容量；排队中位数 ≤ 7 天（07 批次闸门） |
| 检索阶段 A 足够 | recall@5 ≥ 0.8 | 120 条评测集在 P1-4 前测一次；之后抽样「没有命中」的查询 |
| 每日全文配额 | 30 篇不同面经/天 | 访问日志 P99；正常用户被限超过 1% 就上调 |
| 贡献率 | ≥ 20% | 首批数据加访谈 |
| 下架时限 / 运营匹配 | 48 小时 / 48 小时 | 下架记录；`requested → matched` 耗时 |
| 合作机会上限 | 每周 3 条 | 「不感兴趣」率与转递率 |

---

## 待确认问题

1. **蔓藤数据授权（问蔓藤）**：学员简历、面经、规划师话术、历年结果数据，原协议是否允许用于本产品、发送给模型服务商处理？不允许时是否愿意向往届学员重新取得授权（文本由我们起草）？P0 的题库与方法卡、P1-4 的面经都卡在这里；默认没有 `license_id` 的内容不发布。
2. **蔓藤交付与导师容量（问蔓藤）**：11 月中旬前能否交付题库与 rubric、第一批方法卡与对话模式卡？B2 前面经的数量、格式、时间范围，口述与整理各占多少，有无 EE、ME？历年结果能否按 M1-2 口径导出？首批导师人数与容量能否在 60 天内消化每人一次免费诊断？默认：P0 面试官只用公开题，免费诊断排队。
3. **合作企业转递（问产品负责人）**：蔓藤运营用邮件把用户确认的材料转给合作企业，是否不算 AGENTS.md 的「后台提交申请」？默认按 3.9 只发邮件。
4. **贡献类默认值（问产品负责人）**：面经贡献、「匿名计入统计」默认关闭，飞轮起步会慢，是否接受？默认接受。
5. **方法与模板（问蔓藤）**：导师的《GAP 分析报告》模板还在用吗？是否愿意让导师以方法卡形式写方法，并署名或匿名？
6. **规划师话术（问蔓藤）**：能否提供去标识化文本而非原始记录？是否接受「销售内容一律剔除，并在隐私说明里披露主理人参考了蔓藤规划师的咨询与陪伴经验」？
7. **AI 课程（问蔓藤）**：是 AI/ML 技能课还是 AI 辅助的课程？哪些单元对首批是 `included`，哪些单独收费、价格多少？托管在哪？能否授权转写稿用于检索？
8. **小企业内推资源（问蔓藤）**：现有多少家、什么行业？有无书面工作授权说明和招聘联系人？怎么审核？是否向企业或候选人收费（决定是否显示推荐费披露）？
9. **MCP 交付（问蔓藤）**：导师排期、课程、合作机会有没有可开放的在线系统？能否按 6.3 以 MCP 交付、由谁托管、是否收费？默认按 6.1 的表格导入。
