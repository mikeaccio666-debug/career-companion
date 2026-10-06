# T5 规划老师 · 算法与运行时说明（v1）

> 作者：张浩宇 · 2026-08-21；2026-08-29 按正式契约与实现同步。
> 本文是 `gap-strength*.ts`、`skill-library.ts` 与 API contract §5.17 的非权威说明；发生差异时，
> 以上 executable contract、source contract 与测试优先。本文不另行定义 endpoint、wire 或治理门槛。
> 本文回答「怎么算」——领导指出 schema 已定但缺算法逻辑的 11 个问题。
>
> **接口 authority 提示（2026-08-29）：**本文只保留算法背景，不再定义 executable wire、HTTP route、
> runtime gate 或读时重算语义。正式 source authority 是
> `apps/api/docs/AGENT-API-CONTRACT.md` §5.17，executable mirror 是本包的 `http.ts`、
> `gap-strength.ts`、`gap-strength-planner.ts` 与 `profile-strength.ts`。下方 Q11 已同步当前接口，其他
> `targetRoleKey` 仅表示 server-side normalized identity，不是 client request field。
>
> **贯穿原则（20-技术架构 §1）**：确定性引擎负责所有**判分/匹配/门槛/排序**；
> LLM 只负责**自由文本 → 规范技能 id 的语义抽取**和**最终措辞**，绝不做决策。
> 这样才能满足验收铁律「同一 profile + target role 稳定得到同一结构化结果」。

---

## 0. 核心枢纽：Canonical Skill Taxonomy（一切匹配的基础）

一张**规范技能表** `SkillId`（版本化 `taxonomyVersion`），每个技能带：
- `aliases[]`：同义词/拼写变体（"Postgres"→`sql`；"熊猫/Pandas"→`python-data`）
- `parent / children`：技能层级（`pandas` 是 `python-data` 的 child）
- `remediationType`：默认补齐方式（见 Q6）
- `category`：SOFT / HARD / BACKGROUND

**候选人技能**和**岗位要求技能**都先映射到同一套 `SkillId`，匹配就从"模糊比字符串"变成"确定性的集合/图运算"。**LLM 唯一的活**就是把自由文本对齐到这张表里的 id。

内部再定两个**序数量表**（0–4，比 A+~C- 更适合计算，最后再映射成字母）：
- `ProficiencyLevel`（候选人绝对水平）：0 无 / 1 接触(课程) / 2 应用(项目/竞赛) / 3 职业(实习产出) / 4 精通(带队+产出，如 Kaggle Top1%)
- `RequiredLevel`（岗位要求水平）：0–4，由版本化岗位要求库提供

---

## Q1. 如何从 Profile 找出现有技能与程度

**输入**：Profile V2（T3）的 confirmed collections：`skills[] / experiences[] / projects[] / achievements[] / educations(courses)[]`。

**三步（确定性为主，LLM 只抽取）**：
1. **确定性直取**：`skills[]` 里用户已确认的技能 → 经 alias 表映射成 `SkillId`。用户若填了自评水平就用，没填进第 3 步推。
2. **LLM 语义抽取（temp=0、结构化输出、版本化 prompt）**：逐条 experience/project/achievement/course，抽出提到的技能 → 输出 `{skillId, profileRef, signalTags[]}`。`signalTags` 是**客观信号**（"internship-output" / "coursework-only" / "competition-win" / "leadership"），**不打分**。`profileRef` 必须指向该 confirmed item（做 evidence）。
3. **确定性聚合**：把同一 `SkillId` 的所有信号按规则合成 `ProficiencyLevel`：
   - 有 `competition-win` 或 `production/leadership` → 4
   - 有 `internship-output` → 3
   - 有 `project`/`competition-participation` → 2
   - 仅 `coursework-only` → 1
   - 无信号 → 0
   取各来源**最高档**，evidence = 全部 profileRef。

**可复现**：第 2 步 LLM 结果按 `(profileRevision, promptVersion, modelVersion, taxonomyVersion)` 缓存 → 同一 Profile 命中缓存 → 同一结果。

---

## Q2. 如何从岗位技能库取得 required skills

**输入**：`MarketRequirementInput`（可为「无资料」）+ targetRole。本切片不接收 JD。
`available=false` → 直接跳过，全程 UNKNOWN（Q5/Q4 兜底）。

当前实现把慢变的 skill taxonomy 与快变的 role requirements 分开，并以同一 `skillId` 对齐。source
闭集为 `CURATED | MARKET_AGGREGATE | EXTERNAL_TAXONOMY`；#113 使用经 parser 校验的 curated seed。
未来市场聚合或外部 taxonomy 可替换对应 provider，但不得改变当前 wire 或让 unknown role 回退到近似岗位。

**两步**：
1. **严格库解析**：校验 skill/role identity、alias 唯一性、引用完整性与 requirement 唯一性。
2. **确定性读取**：normalized target role 精确命中 role entry 后返回 required skills；未知岗位返回 unavailable。

**可复现**：`libraryVersion`、market snapshot 与模型/策略版本共同进入 planner cache key。

---

## Q3. Profile skill 与 market requirement 如何 matching

**纯确定性**，在 `SkillId` 上做（含 parent/child 图）：

对每个 required 技能 R：
- 找候选人同 `SkillId`（或其 child，child 满足 parent 时乘衰减系数 0.8）的 `ProficiencyLevel = cand`
- `delta = R.requiredLevel − cand`
- 分类：`delta ≤ 0` 覆盖(可能是 strength) / `0 < cand < required` 部分 / `cand = 0` 完全缺失
- 产出逐技能 match 记录 `{skillId, requiredLevel, candidateLevel, delta, importance}`

零 LLM、可完全复现。

---

## Q4. A+～C- 的评分规则

分两层（关键区分）：

**(a) 逐技能候选人水平** = `ProficiencyLevel 0–4`（Q1 已算，绝对值）。

**(b) 品类字母评分**（软性/硬性各一个，对应模板「综合评价」）= **相对岗位要求的达标度**：
```
categoryScore = Σ( w_R · min(1, cand/required) ) / Σ w_R      // w_R: MUST=2, NICE=1
```
`categoryScore ∈ [0,1]` → 字母（版本化 `scoringPolicyVersion`，可调）：
| 区间 | 字母 | 语义 |
|---|---|---|
| ≥0.90 / 0.83 / 0.75 | A+ / A / A- | 非常优秀（超出） |
| 0.65 / 0.55 / 0.45 | B+ / B / B- | 基本符合 |
| 0.30 / 0.15 / <0.15 | C+ / C / C- | 未达到 |

**无市场资料 → 字母 = UNKNOWN**（不算、不假装）。
> ⚠️ 建议 schema 微调：字母评分挂在**品类 rollup**，逐技能存 `candidateLevel/requiredLevel` 序数。当前 v1 把字母放在 GapItem 上，需在 v2 契约里调整（走评审）。

---

## Q5. CRITICAL／MAJOR／MINOR 的判定门槛

只对"有差距"(`delta>0`)的技能产 GapItem。`gapScore = delta × importanceWeight`（MUST=2, NICE=1）：
| 条件 | severity |
|---|---|
| MUST 且 `candidateLevel=0`（必备完全缺失） **或** `gapScore ≥ 4` | **CRITICAL** |
| `2 ≤ gapScore < 4` | **MAJOR** |
| `0 < gapScore < 2` | **MINOR** |
| `delta ≤ 0` | 不是 gap（覆盖/strength 候选） |
| 无市场资料 | **UNKNOWN** |

确定性决策表，版本化。

---

## Q6. recommended action 如何选择

**确定性决策表**，键 = (skill.remediationType, severity, 是否"有能力但没展示")：
- 缺硬技能(SQL/BI) CRITICAL → `COURSE` 或 `CERTIFICATION`（最快到门槛）
- 缺项目/实战证据 MAJOR → `PROJECT`
- 软性/沟通 gap → `MOCK_INTERVIEW`（+活动老师）
- **candidateLevel ≥ required 但 evidence 弱/没写进简历** → `RESUME_REWRITE`（会而没展示）
- 内推/人脉缺口 → `NETWORKING`
- 其余 → `OTHER`

`kind` 由表**确定性**决定；`detail` 文案由 Persona Renderer 润色（措辞可 LLM，动作不可）。多个 gap 按 severity → 时间敏感度排序。

---

## Q7. Career Direction 三个 tier 如何生成

1. **候选角色集** = targetRole ∪ **角色邻接图**邻居（确定性图：Data Analyst→Business/Financial Analyst；MLE→Data Scientist…）∪（可选 LLM 补冷门角色，须过 taxonomy 门，不静默采用）。
2. **逐角色打分**：对每个角色复用 Q3/Q4 算 `fitScore∈[0,1]`（候选人 vs 该角色要求），再叠加市场 demand/access 信号。
3. **分档**：按 fitScore 排名分档（版本化 band）：最高→PRIMARY，中→SECONDARY，低但可行→TERTIARY。每档角色数 1–3（对齐模板 + 导师批注"每档 1-3 个"）。

确定性图 + 打分排序，可复现。

---

## Q8. 投递比例如何计算

模板已给band：PRIMARY 75-80% / SECONDARY 15-20% / TERTIARY 5-0%。
设计：**band 是策略默认**，不是自由数：
- 策略基点 `PRIMARY 0.78 / SECONDARY 0.17 / TERTIARY 0.05`（和=1）
- 按各档 fitScore 置信度**微调**，再**夹回模板 band**、归一化到 100%
- schema 里 `ApplyRatio{minPct,maxPct}` 存的就是模板 band；派生的单点建议值落在 band 内
- 无市场资料：仍可用策略默认，但标低置信度，或只给 band 不给单点

保证与导师模板一致、可解释、有界。

---

## Q9. StrengthTag 如何由 Achievement 推导

（41-能力地图：derived tag **必须**引用 confirmed collection）
1. **确定性候选筛选**：`candidateLevel ≥ 3` 且有 achievement/award/职业 evidence 的技能 → strength 候选。
2. **LLM 提议标签（temp=0）**：从 achievements/awards → `{label, evidenceRefs[](必须是 confirmed 的 profileRef), rationale}`。
3. **确定性门禁**（与 parser 的 DERIVED 规则一致）：
   - 每个 tag 必须 ≥1 个指向 confirmed item 的 profileRef，否则**丢弃**
   - 与 user-confirmed/freeform 去重；映射到 StrengthTag taxonomy + category
   - 结果 `source=DERIVED`
用户还可加 `USER_FREEFORM`（免 evidence）或把 derived 确认成 `USER_CONFIRMED`。

---

## Q10. 用哪个模型／prompt／tool／deterministic

**明确边界**：
| 确定性（无 LLM，版本化 `scoringPolicyVersion`+`taxonomyVersion`） | LLM（有界、结构化、temp=0、版本化 `promptVersion`+`modelVersion`） |
|---|---|
| 匹配、评分 band、severity 门槛、action 决策表、tier 排序、投递比例、strength 门禁、失效、缓存、岗位要求库读取 | 未来可插拔 provider 的有界语义抽取与文案润色；#113 runtime 不用 LLM 从 Profile/JD 原文推断 |

- **当前 runtime**：Profile V2 adapter 只消费 fully `USER_CONFIRMED` 的结构化字段；岗位要求来自版本化库，未收录岗位明确 UNKNOWN。
- **未来模型边界**：若加入 LLM，只能作为受严格 schema 校验的可替换 provider，钉死 model/prompt 版本，且不能越过 taxonomy、evidence 与 unknown-role 门禁。
- **可复现保证**：确定性内核 + 完整版本缓存键 → 同一 `(profileRevision, targetRoleKey, marketSnapshot/libraryVersion, policyVersion, promptVersion, modelVersion)` 得到同一 report。

---

## Q11. 报告如何缓存／哪个 endpoint 触发／如何重算

**当前储存**：durable 表 `gap_strength_reports`（owner-scoped，immutable 行，新算即新 revision）；
repository schema mirror 已存在，production DDL deploy/ledger 仍是独立 default-off blocker。report evidence
只存 profileRef，**不落 Data-L1 原文**。

**缓存键**：`(userId, targetRoleKey, profileRevision, strengthRevision, marketSnapshotVersion, scoringPolicyVersion, promptVersion, modelVersion)`。命中即返回旧行 → 稳定结果；所有 lookup 仍须显式携带 authenticated owner predicate，不能只依赖 cache key。

**endpoint（apps/api，agent 模块；正式口径见 API contract §5.17）**：
- `POST /api/v1/agent/planner/gap-strength/compute` —— exact body `{targetRole}`；服务端归一化 role，按完整缓存键幂等计算或返回命中报告。
- `POST /api/v1/agent/planner/gap-strength/latest` —— exact body `{targetRole}`；取 authenticated owner + normalized role 的最新 report，无记录时读穿 compute。

**触发**：
- 用户点 chat 快捷提问「差距分析」（PD-2026-08-19-CHAT-INLINE-RUN 已有入口）
- Orchestrator（T4）在 Profile 首次完成 / 简历解析后 / 新建 target role 时安排

**重算/失效**：
- `compute` 的 cache key 包含 profile / strength / market / policy / prompt / model 版本；任一变化自然换键并产生新 revision。
- `latest` 只读取该 owner + role 的 durable latest；无记录时才读穿 compute，不承诺在普通读取上隐式判断 stale 并重算。
- T5 runtime 另受 source contract §5.17 的独立 feature/schema/release exact gate 约束；Profile V2 ready 不代表 T5 DDL ready。

---

## 后续演进边界

1. Q4/Q5 的评分 band 与 severity 门槛已经由 versioned executable policy 固定；调整时按现行 SOP 重新分级与评审。
2. repository schema mirror 与 durable DML 不等于 production DDL 已部署；deployment ledger、市场数据 provider 与 taxonomy 热更新仍是独立后续门禁。
3. additive endpoint 契约按现行 L1 atomic 规则在同一 PR 收口 source、mirror、runtime 与测试；只有 L2-P／L2-T 变更才升级到对应矩阵，不存在一般性的“三人拍板”门槛。
