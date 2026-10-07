# 插件自动投递：在对话里一次授权

## 这份文档回答什么问题

浏览器插件替学生做哪些事；这些事怎样在投的单聊里一次问清、确认后全部自动；无论怎么回答都不做的底线；授权记录、回执的数据结构，以及内核、插件、后端要改的代码。其他文档涉及插件、代签、代注册登录、自动翻页、批量预填时，以本文为准。

- **已确认**（产品负责人，2026-10-06；问答位置按 2026-10-07 的决定改为投的单聊）：插件投递过程中不弹任何授权提问。第一次用插件投递前，主线里投的一张转发卡发起，投在自己的单聊（Web）里分组问清，学生在「投递授权确认卡」上点「确认这些授权」，之后插件按授权记录全部自动处理。每项只有「可以替我勾」和「不要，留给我自己」，不预选、不推荐，没有「每次问我」。
- **留给你**：学生选了「不要」、记录里没有、文案版本对不上的项，插件不做，在浮层里高亮成「留给你」；新问题由投攒在一起，在投的单聊里补问（§4.4）。
- **按话题合成**：一段文字涉及几个问题，全部「可以」才代勾，任一「不要」或没有记录就留给学生（§6.1 的 `FACET_TO_QUESTION`）。
- **对用户的承诺**：要发给别人的消息和材料，都先进待确认；表单里哪些项可以替你做，由你在对话里逐项确认（§3）；最终提交永远由你本人点。
- **分期**：安全修正在 P0 期间做完、不发布（09 10A）；对话授权与后端接通是 P1a 的 P1-1；批量预填 P2。
- 文中的法律内容不是法律意见，上线前须请美国执业律师审核（§7）。外部事实截至 2026-10-06，需核实，不进用户可见文案。

## 1. 结论

插件保留，继续尽量替学生做事，改的是授权方式（01 §8.2 引用本文）：

- 授权只在第一次投递前问一次，之后只就新问题或改版的问题补问。投递中浮层不打断，填完停在提交前，学生点一下提交。
- 学生选「不要」的项在页面上高亮，由他自己处理；这一页有「留给你」的项时不自动翻页（§4.7）。各类出现率还没统计：P1-1 验收前用 field-lab 固定页面和首批真实投递统计，写回本节。

| 处理 | 能力 | 理由 |
|---|---|---|
| 在对话里逐项授权（四组 16 项） | 常规条款、签名与声明、放弃权利或接受调查的条款（§3.2）；代注册、代登录、自动翻页（§3.4） | 每一项由学生本人在对话里确认、确认卡留档，最终提交由本人按，代勾能清楚归属到本人 |
| 照资料作答 | EEO 自愿问卷、标准的工作授权与 sponsorship 题、能否联系现雇主或推荐人（§3.3） | 同一次对话里由学生逐项给出答案，存进档案，插件照抄 |
| 不进问答，插件不做 | 营销订阅；措辞不标准或复合的身份题；别国岗位而档案里没有那个国家的身份 | 营销对求职没有帮助；复合身份题、别国身份按默认作答容易不实 |
| 底线，任何回答都不改变 | §5.1 | — |

ESIGN 只规定电子代理的行为能归属到本人时不影响效力，并不要求逐项授权。逐项授权、确认卡留档是为了归属清楚、减少争议的产品选择，也符合 CPRA 对「同意」的要求（不捆绑、不预勾）；CPRA 是否适用看公司规模门槛，按它设计更稳妥。

## 2. Muse 与其他自动投递做法（调研摘要）

### 2.1 结论

1. 「Muse」已确认为 Meta Muse（2026-09-08 发布的通用云端 AI 代理）。每个用户一台云端虚拟机；独立审批进程对每个联网动作判「允许 / 拒绝 / 问用户」；凭据单独保管。官方没有求职投递流程，「Muse 自动投递」来自个人帖子的转述，没有成功率数据。
2. 外部做法：插件填写、用户提交（Simplify 等，即我们现在的形态）；云端代理代投（转化低、口碑差）；插件内全自动连投（口碑最差）；云端调度、本地浏览器执行（Manus Browser Operator，与我们最接近）；官方 API（只能与具体雇主合作）。可借鉴的：事前审批、凭据隔离、审计记录、遇到拦截就退回给用户、每日上限。
3. 外部约束：LinkedIn 禁止第三方插件在站内自动操作；Indeed 条款禁止在官方渠道外自动化 Indeed Apply；Greenhouse、Ashby、Workable 在识别自动投递，云端代投更容易被识别。
4. 来源与竞品全表见 `docs/automation-options-research.md`（10-05）和本文最初版本（commit `d7479fc`）的 §2.1–2.3。

### 2.2 与 Meta Muse 的对照

| Muse 的能力 | 我们现在 | 本方案之后 | 再往前一步需要什么 |
|---|---|---|---|
| 关掉 App 也继续干活 | 不能，需要用户电脑和浏览器开着 | 不变 | 服务端排队、等用户电脑在线时由插件执行；或云端浏览器（要改执行边界） |
| 自己点提交 | 用户在浮层点一下（Greenhouse、BambooHR、Dover、Rippling、Workable），其他家在网页上点 | 不变；扩大浮层提交要改内核和规则（§6.2 第 22 条） | 改 AGENTS.md「不后台提交申请」 |
| 审批 | 一句话全开 | 事前在对话里逐项确认，过程中不再问；没授权的留给学生 | — |
| 凭据隔离 | 本机加密保险箱，所有网站共用一个密码 | 每家独立密码，仍只在本机 | 接入 1Password 等（可选） |
| 审计记录 | 浮层当场写「已替你…」，不留存 | 授权记录可查；每份申请一张回执，可查看、导出 | — |

我们的优势：用用户自己的浏览器、IP 和登录上网，不容易被识别（云端方案会失去它）；有 H-1B 担保过滤、各招聘系统的填写规则、主理人和蔓藤资源。「关电脑也能投」「连提交都不用点」要改执行边界，还有被识别和托管密码的风险，仍不做（§5.1、§8 第 1 条）。

## 3. 授权清单

### 3.1 两个选项与「留给你」

- **可以替我勾**：插件直接替你勾选、选择或填写，回执里写明做了什么。
- **不要，留给我自己**：插件不碰这一项，在浮层里把它高亮成「留给你」，你在网页上自己决定。

授权记录里没有、值不认识、文案版本对不上、读不到授权记录的项，一律按「留给你」处理，不弹窗提问，由投事后在单聊里补问（§4.4）。

### 3.2 代签与同意类（第一至三组，sign-on-behalf）

「话题」是内核 `dict/signOnBehalf.ts` 的 `WidenedFacet`，映射见 §6.1。英文是常见写法的示意，界面上放在可展开的「看看英文原文长什么样」里。

| 问题 id | 学生看到的问法 | 典型英文原句 | 话题；其他类别 | 条件与说明 | 法律依据要点（需律师审核） |
|---|---|---|---|---|---|
| **第一组 申请表里的常规条款** | | | | | |
| `TERMS_PRIVACY` | **申请条款与隐私**：申请表要你同意公司的申请条款、隐私政策时，我可以替你勾吗？（进入申请表前按居住地选隐私条款的页面也算） | "I have read and agree to the Terms of Use and Privacy Policy." | TERMS；`PRIVACY_NOTICE_TITLE` | 几乎是申请的前提。只有标题、读不到正文的隐私声明也归这一问。 | 雇主按 CCPA 要向求职者提供收集告知；代勾能归属本人时有效（ESIGN 7001(h)、UETA §14）。 |
| `DATA_SHARING` | **招聘数据处理与共享**：公司要你同意他们和招聘系统服务商为这次申请处理你的资料，包括交给同集团的公司、存到美国以外的服务器时，我可以替你勾吗？（用途仍只限招聘） | "I consent to the processing of my personal data, including transfer to affiliates and service providers in other countries, for recruitment purposes." | SHARING；Jobvite 数据同意页（`consentGate`，与上一问合成） | 出售资料、为营销分享不在这一问里，按底线留给你。 | CPRA：捆绑在宽泛条款里或经暗黑模式取得的同意无效（Cal. Civ. Code 1798.140(h)）。 |
| `AT_WILL` | **随意雇佣确认**：表上要你确认「知道这是随意雇佣（at-will），双方都可以随时解除」时，我可以替你确认吗？ | "I understand that my employment will be at-will." | AT_WILL | 不增加你的义务。 | 各州雇佣法；蒙大拿等州有例外（未核实）。 |
| `VERIFICATION` | **核实学历经历与 E-Verify 告知**：公司说要核实你填的学历、工作经历、身份，或告知会用 E-Verify 核实工作资格时，我可以替你同意吗？ | "I authorize the Company to verify my education and employment history." / "This employer participates in E-Verify." | VERIFICATION | 联系现雇主或推荐人的句子不在这一问里，照资料作答（§3.3）。 | 通过第三方背景调查公司核实时可能落入 FCRA（见 `BACKGROUND`）。 |
| `FUTURE_CONTACT` | **日后联系与人才库**：公司问以后有合适职位能不能联系你、能不能把你放进人才库（包括同集团的其他公司）时，我可以替你同意吗？ | "You may contact me about future opportunities and keep my profile in your talent community." | FUTURE、GROUP | 可能收到更多招聘邮件。 | CCPA 下求职者可以随时要求删除资料。 |
| **第二组 签名与声明** | | | | | |
| `TRUTH_STATEMENT` | **属实声明**：申请表最后要你声明「以上信息真实完整」时，我可以替你勾吗？ | "I certify that the information in this application is true and complete." | TRUTH | 只有本轮插件写入的每一条都来自你确认过的资料或已确认的材料包、没用未确认的 AI 回答时才代勾，否则这一份留给你。内容不实可能被撤 offer 或解雇。 | ESIGN 7006 要求「签署意图」，没见过具体文书时是否成立有争议；政府职位不代签（§5.1）。 |
| `SIGNATURE` | **签名栏姓名与日期**：签名栏要你输入姓名和日期时，我可以替你填吗？ | "Electronic signature (type your full legal name)" | `SIGNATURE_NAME`、`SIGNATURE_DATE` | 替你签名在法律上等同于本人签字。条件同上；只填资料里「与护照一致的法定姓名」（`identity.fullName`），为空时留给你。提交卡第一行写「属实声明和签名是替你签的」。 | 同上。 |
| **第三组 放弃权利或接受调查的条款** | | | | | |
| `ARBITRATION` | **仲裁协议**：公司要求你同意「以后有纠纷走仲裁、不上法院」时，我可以替你同意吗？ | "Any dispute arising from my application or employment will be resolved by final and binding arbitration." | ARBITRATION | 同意就等于放弃上法院的权利，而且不可逆。同一段里的免责、不追责、赔偿仍留给你。 | 雇佣仲裁协议按 FAA 可以执行（Epic Systems，2018）；涉及性骚扰、性侵的争议本人可以选择不受仲裁约束（9 U.S.C. 402）；在线条款成立需要醒目告知和明确同意（Berman，第九巡回，2022）。 |
| `CLASS_JURY_WAIVER` | **放弃集体诉讼和陪审团**：仲裁协议里还要求你放弃参加集体诉讼、放弃陪审团审判时，我可以替你同意吗？ | "I waive any right to participate in a class or collective action and any right to a jury trial." | WAIVER | 后果最重的一类。 | 集体诉讼弃权可以执行（Epic Systems）；各州对争议前放弃陪审团的规定未核实。 |
| `BACKGROUND` | **背景调查与各类筛查**：公司要做背景调查时，我可以替你授权吗？包括犯罪记录、信用记录、药检、驾驶记录、社交媒体审查，以及在职期间的定期复查。 | "I authorize the Company to obtain consumer reports, including criminal and credit history, for employment purposes." | BACKGROUND、SCREENING | 公司可以查信用、要求药检；多数在 offer 之后出现。调查式消费者报告与医疗健康类授权留给你。加州 ICRAA「是否索取报告副本」的勾选框归这一问，代勾时固定选「要」。 | FCRA 要求在只含披露内容的独立文件上取得本人书面授权（15 U.S.C. 1681b(b)(2)），FTC 原话是「不能写在申请表里」。 |
| `AI_RECORDING` | **面试录音与转写**：面试会被录音、录像，或由 AI 转写成文字时，我可以替你同意吗？ | "I consent to my interview being recorded and transcribed." | RECORDING | 你的声音和影像会被保存。 | 加州 Penal Code 632：录音保密通话需全体当事人同意；伊利诺伊 AI Video Interview Act（820 ILCS 42）。 |
| `AI_ANALYSIS` | **AI 评估面试**：公司要用 AI 分析你的面试、给你打分时，我可以替你同意吗？ | "I consent to the use of AI tools to evaluate my interview responses." | AI_ANALYSIS | AI 评分会影响录用。人脸、声纹等生物特征，分析情绪，拿录音训练 AI，都留给你。 | 伊利诺伊要求面试前告知并取得同意（820 ILCS 42/5）；马里兰规定面试中使用人脸识别须本人签署（HB 1202）；伊利诺伊 BIPA 要求书面授权。 |
| `NOTIFICATIONS` | **申请相关的短信电话**：公司想用短信、电话（可能是自动拨号或预录语音）或 WhatsApp 通知你面试安排和申请进度时，我可以替你同意吗？（只留你自己的手机号） | "I agree to receive text messages and automated calls about my application." | SMS、CALLS | 可能收到较多短信和电话；不同意可能漏掉面试通知。营销不在这一问里。 | TCPA（47 CFR 64.1200）：非营销的自动拨号电话需要本人事先同意；Facebook v. Duguid（2021）收窄了「自动拨号系统」的范围。 |
| 一段文字涉及多个问题（不单独问） | — | — | 任意多个话题 | 按 §6.1 合成：全部「可以」才代勾，任一「不要」或没有记录就留给你。不只是 `COMBINED_CONSENT`：仲裁加弃权的整段（`ARBITRATION_WAIVER`）、录音加 AI 分析的整段（`AI_INTERVIEW_ANALYSIS`）也各涉及两个问题。 | CPRA：捆绑在一起的同意本身可能无效。 |

**营销信息不进问答**（话题 MARKETING）：营销邮件、newsletter、产品推广的订阅，插件一律不勾；必须同意才能继续的留给你。营销对求职没有帮助；营销短信和自动拨号营销电话需要本人签署的书面同意（47 CFR 64.1200(a)(2)、(f)(9)），营销邮件按 CAN-SPAM 是退订制，但替用户订阅不符合他的利益。

### 3.3 照资料作答（敏感字段）

在同一次授权对话里由学生逐项给出答案，确认卡上一并列出，确认后存进档案，不进授权记录（§6.1）。材料包路径里 sponsorship、工作授权、公民身份、EEO 题的 `answer_source` 只能是 `profile_confirmed` 或 `user_required`（03 §9.2）；任何身份类答案都不由模型生成。档案里没有答案的题留给你。

| 题 | 对应代码 | 怎么问、怎么填 | 法律依据要点（需律师审核） |
|---|---|---|---|
| **EEO 自愿问卷**：性别、种族、退伍军人、残障 | 能力位 `set-self-identification`；EEO 答案上的 `reuseEnabled` | 对话里逐题给出答案（包括「不愿透露」），确认后 `reuseEnabled` 为真，插件照抄；不按姓名、国籍、照片推断。 | 自我披露永远是自愿的。OFCCP 2026-08-21 的规则：残障自我认定邀请（CC-305）9 月 21 日起不再强制，EO 11246 实施细则 10 月 26 日撤销，退伍军人自我认定保留（截至 2026-10-06，需核实）。种族、残障属于 CPRA 的敏感信息。 |
| **标准的工作授权与 sponsorship 题**：现在是否有在美国工作的授权、将来是否需要担保 | `WORK_AUTH_STANDARD`；能力位 `set-work-authorization`；`engine.ts` 的工作授权判据 | 对话里核对档案里的身份和这两题的答案。如实答「需要担保」会被部分公司筛掉，这是合法的；答错更严重。身份过期或没填时留给你。 | 美国司法部 2016 年技术协助函：对所有求职者问「现在或将来是否需要担保」并据此不录用，大概率不违法。F-1 学生不受「公民身份歧视」保护，仍受「国籍歧视」保护。 |
| **能否联系现雇主或推荐人** | `preferences.contactCurrentEmployer`；`EMPLOYER_CONTACT_*`、`REFERENCE_CONTACT_*` | 对话里答「可以 / 不可以」；只问以前的雇主或推荐人的题按同一个回答。题目里混进背景调查、学校、同事、亲友的留给你。 | — |
| **其他国家的岗位**（加拿大、英国等） | `profileV2WorkAuthorizations.ts` 的按国家记录；`engine.ts` 的 `withoutRecord` | 档案里有那个国家的记录才照填；没有就留给你，不写默认答（现在默认答「有权工作 = 是、需要担保 = 否」，对多数 F-1 学生是不实陈述，§6.2 第 7 条）。投补问时学生给的答案存成那个国家的记录。 | 不实陈述可能导致撤 offer 或解雇。 |
| 措辞不标准或复合的身份题（「无需任何担保即可长期工作」「是否 U.S. person」、出口管制身份、「citizen, permanent resident, or otherwise authorized」） | — | 固定留给你。 | 题意容易误读；复合题答「否」同样可能答错。 |
| 「是否美国公民或绿卡持有人」 | 现有内核不答这类题 | 任何路径都不自动答「是」。P1-1 起，整句只问公民或绿卡的题，身份为 F-1 时答「否」。 | 虚称美国公民可能导致永久不可入境（INA 212(a)(6)(C)(ii)）；USCIS 政策手册写明对雇主这类私人主体作出的声明也算。 |

### 3.4 账号与页面操作（第四组）

| 问题 id | 学生看到的问法 | 典型英文原句 | 条件与说明 | 法律或条款依据（需律师审核） |
|---|---|---|---|---|
| `ACCOUNT_REGISTRATION`（`account-access`） | **代注册账号**：遇到要先注册账号才能申请的公司（如用 Workday 的公司），我可以用你的邮箱替你注册吗？每家网站一个独立的随机密码，只存在这台电脑的插件里。 | "Create an account to apply. By creating an account, I agree to the Terms of Use." | 注册就是替你接受这家网站的条款。只用你本人的邮箱，绝不批量建号。验证码、邮箱验证链接、单点登录、账号被锁、重设密码仍交给你。目前只有 Workday 完整声明了注册流程，iCIMS 还没接通。 | 注册条款是「点击即同意」的合同（Berman 标准）；MyGreenhouse 用户协议禁止自动化手段、禁止替他人建账号（只覆盖 my.greenhouse.io）；Workday 网站条款是否覆盖雇主自己的招聘站点不明确。 |
| `ACCOUNT_LOGIN`（`account-access`） | **代登录**：以后再投这家，我可以用存着的密码替你登录吗？ | "Sign in" | 只登录插件替你注册的、或你自己存进插件的账号。 | 同上。 |
| `AUTO_ADVANCE`（`advance-step` + `advance-steps`） | **自动翻页**：一页填完后，我可以直接帮你点「下一步」或「保存并继续」吗？（不点最终提交） | "Save and Continue" | 由你点一次「自动填写」开启，每轮最多 10 页、10 分钟；遇到必填项缺失、网站报错、验证码、这一页有「留给你」的项就停（§4.7）。选「不要」时每页填完停下。 | 平台条款：LinkedIn、Indeed Apply 上不做。 |
| 最终提交（`submit-application`） | 不是问题：永远由你在浮层点（目前支持的 5 家见 §2.2），其他网站在网页上点 | — | 这一下是你对整张表、包括所有代勾的确认。 | 见 §5.1 第一行。 |
| 批量预填（P2，`L3_MANAGED_BATCH`，未实现） | P2 时在对话里单独问：要不要我一次把多份申请预填到检查页，你逐份看一眼再提交？ | — | `{enabled, dailyCap}`，系统上限每天 10 条（假设），用户只能调低；量大会触发招聘系统识别。不含提交。 | 平台条款；招聘系统的识别机制。 |
| LinkedIn 站内、Indeed Apply | 不是问题：插件只准备材料、打开页面，由你自己操作 | — | 有封号风险。 | LinkedIn 用户协议第 8.2 条和帮助中心明确禁止第三方插件自动操作；Indeed 条款 A.3.5 禁止在官方渠道外自动化 Indeed Apply（截至 2026-10-06，需核实）。 |

**每家独立密码的保护**（与独立密码一起在 09 10A 做完）。现在所有网站共用一个密码；退出登录会整份删除保险箱，换用户会整份作废，IndexedDB 里的密钥丢了也会删；超过 400 家按最旧淘汰；`REVEAL` 只返回共用密码。改为：

1. 新注册一律每家单独生成密码；已有的共用密码只用于此前注册的网站。
2. 插件浮层和插件设置里有「已注册的网站」列表，可以逐家查看密码（`REVEAL` 按网站返回）。
3. 退出登录、换用户之前先确认，并提供导出 CSV（可导入 1Password 或 Chrome 密码管理器）。
4. 有独立密码的网站不参与 400 家淘汰。
5. 迁到 platform-api 身份时，保险箱 `owner` 从旧 ArgoLand 用户 id 迁到新账号 id；同一人重新登录时保留。设置页写明「换电脑或清除浏览器数据前先导出」：本机密钥丢失时密文无法恢复，只能到网站上重设密码。

## 4. 授权体验设计

### 4.1 入口与什么时候问

**两条入口**（P1-1）：

- **材料包路径**：投准备 `application_packet`（带定制回答），用户在网页点「确认这一版，交给插件」，插件领取后按授权记录填写（03 §10.1）。计入投每天 10 份的上限（03 §9.7）。
- **页面直填**：用户在任何受支持的申请页直接点插件的「自动填写」。只用已确认的档案和已确认的 `resume_version`，不生成任何 AI 回答，停在提交前；回执回来时在看板上新建一条「已投（自己找的）」，不计入投的 10 份。默认开放、不另设上限（这条路径不调用模型），见 §8 第 3 条。

**什么时候问**：

- **第一次需要插件投递前**：学生第一次说要投、第一次把材料包交给插件，或第一次连上插件时，主线里出现投的一张转发卡：「投之前有 4 组问题要问你，大约 5 分钟。」[去单聊回答] [晚点]；主理人决定请投时，卡前只用固定引子「投有几个问题要单独问你。」，不随性格变化，卡后主理人不再说话（15 §5.3）。问答在投的单聊里进行（`/group/applier?mode=apply_consent`，05 §0.3），单聊里只有投和学生（03 §4.6、§10.2）。四组加照资料作答，预计 5 分钟（假设）。被拒或危机覆盖期、学生说过「今天不想」的当天不发起（03 §4.3）。
- **投保持中立**：学生问「你觉得该选哪个」时，投把这一项的后果再说一遍，说明选哪个都不影响插件替他填其他内容；不推荐、不劝、不用「大多数人都选」。
- **还没确认也能先用**：插件照常填写姓名、经历等普通字段，所有需要授权的项都留给你；浮层顶部一行「投递授权还没确认，代勾和代签都留给你 · 去投的单聊确认 ›」，不是弹窗，不拦着填写。
- **之后只补问**：新增问题、某一问的文案或范围变了，只就那几问补问（§4.4），不重做整套。
- **在哪里确认**：网页里投的单聊中的确认卡；Discord 只能收紧（§4.3）。插件浮层里不问、也不确认任何授权。

### 4.2 问法与确认卡

**分组问**（在投的单聊里）：每组一条投的消息，答完一组再问下一组；中途离开，下次进单聊接着问。

| 组 | 名称 | 包含 |
|---|---|---|
| 一 | 申请表里的常规条款 | `TERMS_PRIVACY`、`DATA_SHARING`、`AT_WILL`、`VERIFICATION`、`FUTURE_CONTACT` |
| 二 | 签名与声明 | `TRUTH_STATEMENT`、`SIGNATURE` |
| 三 | 放弃权利或接受调查的条款 | `ARBITRATION`、`CLASS_JURY_WAIVER`、`BACKGROUND`、`AI_RECORDING`、`AI_ANALYSIS`、`NOTIFICATIONS` |
| 四 | 账号与页面操作 | `ACCOUNT_REGISTRATION`、`ACCOUNT_LOGIN`、`AUTO_ADVANCE` |
| — | 照资料作答 | EEO、标准工作授权与 sponsorship、能否联系现雇主（§3.3） |
| — | 只能你自己来 | §5.1 的底线，投用一段话说明，不需要回答 |

- **每一项**：一句白话问法加一行后果（§3.2–3.4）；可展开「看看英文原文长什么样」；两个按钮「可以替我勾」「不要，留给我自己」，一样宽、一样重，都不预选。
- **整组**：组末「这一组都可以」只是一次填好这一组，确认卡上每一项仍单独列出、可单独改。第三组开头一句「这一组每项的后果都写在下面，选哪个都不影响插件替你填其他内容。」
- **固定提示**：「插件替你勾选，在法律上等同于你本人勾选。」
- **用自己的话回答也行**（「仲裁不要，其他都可以」）：投把理解的结果显示成按钮状态让学生核对；聊天里的自由文字本身不改设置，只有确认卡改。

**投递授权确认卡**（03 §9.1 的待确认对象 `apply_authorization`，原 `apply_setting_change`；样式见 08 §7.14）：问完后投在单聊里发一张卡，逐项列出四组 16 项的回答和照资料作答的答案，学生点「确认这些授权」才生效。卡面任何一项改了，旧卡作废、重出一张（03 §9.4 的输入哈希绑定）。确认后生成一条带版本号的授权记录 `ApplyAuthorizationRecord`（§6.1）：谁、何时、每一问的文案版本和回答、来源 `web_chat`、确认卡 id，追加保存不覆盖；照资料作答的答案写进档案。

### 4.3 修改与撤回

- 学生随时可以在投的单聊里说，或在主线里叫投（「投，以后仲裁别替我勾」），投回一张更新后的确认卡（列出改动的项；在主线里随投的转发卡出现），点了才生效，来源 `web_chat`。
- 网页「我 → 投递授权」（`/me/apply-consent`）列出当前每一项的回答、文案版本和确认时间，可以逐项改；改完同样出确认卡，来源 `web_settings`。
- Discord 可以收到「有几项需要补问」的提醒（链接到网页里投的单聊）；在 Discord 里只能收紧（改成「不要」），来源 `discord`。改成「可以替我勾」的确认卡只在网页上确认（投的单聊、主线或设置页）。
- 插件浮层和插件设置只读显示当前授权，「改授权 ›」跳到网页里投的单聊。
- 改动对正在填写的那一份申请不生效；插件下一次领取或开始填写时读新记录。撤回只对以后的申请有效，已提交的申请改不了，设置页写明。

### 4.4 版本化与补问

- **每一问单独有文案版本**（`wordingVersion`），定义在问题目录里（§6.1）。某一问的文案或范围变了，只重问那一问，其他回答照旧有效。
- **放宽了才升版本。** 范围包括内核的匹配规则：某一问对应话题的判据放宽（能认出更多种句子），这一问升版本；收窄不需要重问。新的话题或类别新增一问。
- **插件按版本核对**：版本与策略包里的当前版本不一致、记录里没有这一问、类别对应不到问题时，留给学生，不弹窗（§6.1）。
- **攒在一起补问**：插件在每次填写结束时（不论是否提交）上报需要补问的问题 id 或类别，不带原文；后端按问题去重，投在当天投递汇报的转发卡上提醒一句（「另外有 2 项要问你」[去单聊回答]），学生在投的单聊里一次答完，出一张只含这些问题的确认卡。同一批没回答时一天最多提醒一次。学生选了「不要」的项不补问。
- **老用户迁移**：已同意 `application-signing-2026-09-28` 的用户不自动转成任何一问的「可以」：对话确认前全部留给他，投在第一次需要时发起授权对话。切换时旧端点返回新版本号或下线，旧版插件按没同意处理（它读到 09-28 版 `granted=true` 会继续放开 20 类）。

### 4.5 「替你做了什么」：提交卡与回执

- **提交之前**：提交卡列出这份申请里插件替你勾了什么、依据哪一问；有代签时第一行写「属实声明和签名是替你签的」；还有「留给你」的项时写明几项。点「提交」表示你确认了这些。
- **提交之后**：每份申请一张回执（08 的 `ApplyReceipt`），四块：替你同意了（`AGREED`）、替你拒绝了（`DECLINED`，如「不可以联系现雇主」）、留给你自己的（`HANDED_BACK`，写明原因：你选了不要、需要补问、底线）、替你注册或登录的网站。每条可展开原文快照、网址、时间，以及依据的是哪一问、哪一版、哪一条授权记录。字段以 03 §10.3 为准。
- **原文快照只存在本机插件里**，加密存放，保留 180 天（假设）或到用户删除为止；后端只存摘要、类别、话题、决定和时间。快照不进日志、诊断和接口载荷（AGENTS.md）。是否同步完整快照见 §7 第 11 条，默认不同步。
- 退出登录或换用户时，与保险箱一起先提示导出，再删除。回执页和插件设置里可以导出为本地 HTML 文件（含快照原文、网址、时间和依据）。

### 4.6 投递官在主线里怎么汇报

以投的一张转发卡写进主线（同一天合并成一张，挂任务卡，08 §7.1），不推送、不占额度、不镜像到 Discord；当天晨报由主理人一句带过（03 §10.3）。只说结果和待办，不带原文、密码和第三方姓名；原文在插件回执里。P1-1 的示例：

> **转自 投 · 投递官 · AI**：今天你在插件里填了 3 份，提交了 2 份（Acme、Globex）。这两份我按你的授权同意了申请条款和隐私政策，也替你签了属实声明（内容都来自你确认过的资料）。Initech 有一份仲裁协议，你选了留给自己，在插件里标出来了。另外有 1 项以前没问过你：AI 评估录像面试的一种新写法，要不要以后替你勾？[看回执] [去单聊回答]

- 「留给你」的项提醒一次，不重复刷屏。
- 插件替不了的情况（验证码、网站报错、LinkedIn 的岗位），说清楚要用户做什么。

### 4.7 「留给你」和自动翻页怎么配合

- 这一页有「留给你」的项时，插件填完其他字段后不翻页，浮层顶部显示「这一页有 N 项留给你」，并在页面上高亮这些项（样式见 08 §10.3）。不弹窗，不要求逐项点「同意」；插件不检查你怎么处理这些项。
- 你处理完点浮层的「继续自动填写」：这一下真实点击作为新一轮的凭证重新 `openAdvanceRun`，页数（10 页）和时限（10 分钟）重新计算；也可以自己点网页上的下一步，插件在下一页照常填写。只有 `AUTO_ADVANCE` 为「可以」、且这一轮是用户点「自动填写」开始的才续跑。

验收用例：

1. 一页上有条款（可以）和仲裁（不要）：条款写入，仲裁不碰并高亮，不翻页，显示「这一页有 1 项留给你」；点「继续自动填写」后翻到下一页。
2. 仲裁那一问的版本对不上：同上，不弹窗；填写结束上报补问，投在汇报的转发卡上提醒，在投的单聊里问一次。
3. 没有授权记录：普通字段照填，所有授权项留给你，浮层顶部一行提示，不弹窗。
4. 「留给你」出现 15 分钟后点「继续自动填写」：开新的一轮，不报 `RUN_EXPIRED`。
5. 自动翻页为「不要」：这一页填完停下，不翻页。
6. 仲裁加弃权的一整段，`ARBITRATION` 可以、`CLASS_JURY_WAIVER` 不要：整段不代勾，留给你。

## 5. 底线与效率补偿

### 5.1 无论学生怎么回答，插件都不做的事

这些不进入问答，任何回答都不改变。

| 底线 | 理由 |
|---|---|
| 替学生点最终提交 | AGENTS.md 的执行边界；本人点的那一下也是整张表、包括所有代勾归属于他的最强证据。 |
| 在服务器或云端后台代投 | 违反 AGENTS.md「不后台提交申请」；机房 IP 更容易被识别；还要托管用户密码。要做须产品负责人另行决定并改 AGENTS.md（§8 第 1 条）。 |
| LinkedIn 站内的任何自动操作，以及 Indeed Apply 的自动化 | 平台条款明文禁止，用户有被限制或封号的风险。现在没有任何默认否决，要写进内核包内基线（§6.2 第 21 条）。 |
| 绕过验证码、人机验证、邮箱验证、单点登录，或处理账号被锁 | 绕过访问控制有法律风险（CFAA、合同）。现有代码已交还本人，保持不变。 |
| 「是否美国公民或绿卡持有人」答「是」 | 虚称美国公民可能导致永久不可入境。 |
| 政府职位（USAJOBS、州和市政府招聘站点）上的属实声明和签名 | 适用联邦虚假陈述罪（18 U.S.C. 1001）。 |
| 生物特征（人脸、声纹）同意；出售资料或为营销分享；免责、不追责、赔偿；竞业、不招揽、保密；医疗健康与残障信息；调查式消费者报告 | 有的法律要求本人签署，有的对用户明显不利。现有 `KEPT_REFUSALS` 已拒绝，保持不变。 |
| 用 AI 编造或推断经历、学历、日期或身份类答案，再替学生签属实声明 | 对 F-1 学生是实质性的不实陈述；也是云端代投产品差评最集中的地方。 |
| 批量建号，或用学生本人以外的邮箱注册 | 违反招聘系统条款，也是识别的重点。 |
| 密码离开学生这台电脑 | 不进 API、日志、诊断。 |
| 收到平台停止通知后继续访问该平台 | 按 Power Ventures 案，收到停止通知后即使有用户许可，继续访问也可能违反 CFAA。必须能按域名远程关停。 |

### 5.2 效率上的补偿

1. **授权一次问清，投递中不打断。** 之后只补问新问题（§4.4）。
2. **页面直填。** 自己找的岗位不必先回网页建材料包（§4.1）。
3. **扩大能在浮层里提交的网站。** 不是补一行声明就能做（§6.2 第 22 条）；是否修改「只按原生提交」见 §8 第 2 条，决定前不排期。
4. **自动翻页。** Workday 这类多页表点一次就能连续填到检查页。
5. **代注册之后自动登录。** 不用再输密码。
6. **在 Greenhouse 托管页提示已在用 MyGreenhouse 的用户直接用它。** 那是平台自己的自动填写，不涉及第三方条款问题。
7. **批量预填队列（P2）。** 投选出当天的岗位后，插件依次打开、填好、翻到检查页，停在提交前；每一份材料包都已在网页上单独确认过（03 §10.4）。`{enabled, dailyCap}`，系统上限每天 10 条（假设），设操作间隔，遇到验证码或拦截就退回给用户。汇报示例：「今天准备的 5 份都已填到检查页，等你逐份看一眼再提交。」

## 6. 需要改的代码位置与数据结构（实施要点）

### 6.1 数据结构

新契约放在 `packages/platform-contracts/src/apply.ts`，加一条与 `@edaix/contracts` 的一致性测试；`packages/contracts/src/applicationSigningConsent.ts` 只用于读旧同意（09 10B）。

```ts
export type ApplyAuthorizationQuestionId =
  | 'TERMS_PRIVACY' | 'DATA_SHARING' | 'AT_WILL' | 'VERIFICATION' | 'FUTURE_CONTACT' // 第一组
  | 'TRUTH_STATEMENT' | 'SIGNATURE'                                                     // 第二组
  | 'ARBITRATION' | 'CLASS_JURY_WAIVER' | 'BACKGROUND'
  | 'AI_RECORDING' | 'AI_ANALYSIS' | 'NOTIFICATIONS'                                    // 第三组
  | 'ACCOUNT_REGISTRATION' | 'ACCOUNT_LOGIN' | 'AUTO_ADVANCE';                          // 第四组

export type ApplyAuthorizationAnswer = 'MAY_DO' | 'LEAVE_TO_ME'; // 可以替我勾 / 不要，留给我自己

export interface ApplyAuthorizationItem {
  readonly questionId: ApplyAuthorizationQuestionId;
  readonly wordingVersion: string; // 学生确认时看到的那一版
  readonly answer: ApplyAuthorizationAnswer;
}

/** 一张确认卡确认一次生成一条；只追加，不覆盖。 */
export interface ApplyAuthorizationRecord {
  readonly id: string;
  readonly userId: string;
  readonly recordVersion: number; // 每个用户从 1 递增
  readonly source: 'web_chat' | 'web_settings' | 'discord';
  readonly pendingItemId: string; // 那张确认卡（03 §9.1）
  readonly cardDigest: string;    // 卡面内容摘要（03 §9.4）
  readonly items: readonly ApplyAuthorizationItem[]; // 这张卡上确认的项；discord 只能是 LEAVE_TO_ME
  readonly confirmedAt: string;
}

/** 插件读到的当前授权：每一问取最新一条记录里的回答。 */
export interface ApplyAuthorizationSnapshot {
  readonly recordVersion: number;
  readonly items: Partial<Record<ApplyAuthorizationQuestionId, ApplyAuthorizationItem & { readonly confirmedAt: string }>>;
}
```

问题目录 `APPLY_AUTHORIZATION_QUESTIONS`（id、组、当前 `wordingVersion`、问法、后果、英文示例）放在同一文件，网页对话和插件共用；当前版本随运行时策略包（`GET /ext/runtime-bundle`）下发，插件以策略包为准核对。EEO 照填读 EEO 答案上的 `reuseEnabled`；联系现雇主读 `preferences.contactCurrentEmployer`；别国工作授权读档案的按国家记录。三者存档案，不进授权记录。

**话题到问题的映射 `FACET_TO_QUESTION`**（内核 `dict/signOnBehalf.ts` 的 16 个 `WidenedFacet`）：

| 话题 | 问题 |
|---|---|
| TERMS | TERMS_PRIVACY |
| SHARING（含交给集团公司、跨境传输） | DATA_SHARING |
| TRUTH | TRUTH_STATEMENT（另受 §3.2 的条件约束） |
| AT_WILL、VERIFICATION、BACKGROUND、ARBITRATION、AI_ANALYSIS | 同名的问题 |
| SCREENING（含犯罪记录、定期复查） | BACKGROUND |
| FUTURE、GROUP（集团公司日后联系） | FUTURE_CONTACT |
| SMS、CALLS | NOTIFICATIONS |
| RECORDING | AI_RECORDING |
| WAIVER | CLASS_JURY_WAIVER |
| MARKETING | 无：不进问答，一律留给学生，可选订阅保持不勾 |

不是话题的类别：`SIGNATURE_NAME`、`SIGNATURE_DATE` → SIGNATURE（同受 TRUTH_STATEMENT 的条件约束）；`PRIVACY_NOTICE_TITLE` → TERMS_PRIVACY；Jobvite 数据同意页 → TERMS_PRIVACY 加 DATA_SHARING；四个联系雇主类别 → `preferences.contactCurrentEmployer`。

**合成规则**（每一条代填都适用，不只是 `COMBINED_CONSENT`）：这一条命中的全部话题映射成问题集合；集合里每一问都是 `MAY_DO` 且版本与策略包当前版本一致，才代填；任一 `LEAVE_TO_ME`、没有记录、版本不对、映射不到问题、读取失败，都留给学生。不能按类别映射：内核把同一族的两个话题归成一个类别（仲裁加弃权 → `ARBITRATION_WAIVER`，录音加 AI 分析 → `AI_INTERVIEW_ANALYSIS`），按类别映射时仲裁「不要」+ 弃权「可以」会代勾仲裁协议，录音「不要」+ AI 评估「可以」会代勾录音同意。前三刀认出的类别也要对整段求话题：第三刀的 `ARBITRATION_AGREEMENT` 抹掉弃权说法后放行，可能同时带 WAIVER。

**其他要点**：

- 授权记录存在 platform-api 的 `platform_apply_authorizations`（只追加：`id`、`user_id`、`record_version`、`source`、`pending_item_id`、`card_digest`、`items` jsonb、`confirmed_at`），当前值用视图取每一问最新的一条；撤回就是追加一条 `LEAVE_TO_ME`（03 §10.2）。取代原计划的 `platform_apply_signing_events`。
- 补问队列 `platform_apply_reask`：插件上报的问题 id 或映射不到的类别、ATS 域名、时间，不带原文；投补问并确认后关闭。
- 网页的 `/api/platform/apply-authorization` 挂 `secure`，请求经 `BoundPlatformClient` 带 `x-companion-account`；写入只接受确认卡的确认决定（`web_chat`、`web_settings`）和 Discord 的收紧决定，不接受直接改值。插件的 `GET /api/platform/ext/apply-authorization` 只读，不经 cookie 和 `x-companion-account`，用只有 `apply` scope 的 bearer 令牌加 `chrome-extension://` Origin 白名单（09 10B）。
- 计划条目 `ApplyPlanEntry.signOnBehalf`（`packages/apply-kernel/src/contracts.ts`）旁边增加 `signOnBehalfFacets` 和 `authorizationQuestions`。
- 新增跳过原因 `LEFT_TO_USER`，带原因（`USER_DECLINED` / `NO_RECORD` / `VERSION_MISMATCH` / `UNMAPPED` / `CONDITION_UNMET` / `BASELINE`）、问题集合和话题；原文只在本地 shadow DOM 里显示。
- 回执条目字段以 03 §10.3 为准：`decision` 只剩 `AGREED` / `DECLINED` / `HANDED_BACK`，`HANDED_BACK` 带上面的原因，条目带授权记录版本。

### 6.2 代码位置

内核（`packages/apply-kernel/src`）：

1. `dict/signOnBehalf.ts` 的 `SIGNING_CONSENT_KINDS`：改为按授权回答求值，新增 `FACET_TO_QUESTION` 和合成函数。
2. `dict/signOnBehalf.ts` 的 `widenedConsentKind` / `facetsOf`：同时导出命中的话题集合；前三刀认出的类别也对整段跑 `facetsOf`；每一条代填按 §6.1 合成。必测：`ARBITRATION` 不要 + `CLASS_JURY_WAIVER` 可以时仲裁加弃权的整段不被代勾；`AI_RECORDING` 不要 + `AI_ANALYSIS` 可以时录音加 AI 分析的整段不被代勾；`FUTURE_CONTACT` 不要时集团日后联系不被代勾；MARKETING 一律不勾。
3. `engine.ts` 的 `BuildPlanOptions.signOnBehalfKinds` 与 `signOnBehalfKindAllowed`：改为传授权快照，修掉「不传就全部允许」。写入层 runner 不给就是没同意，计划层也改成拒绝，两层一致。
4. `engine.ts` 计划代填条目处：合成为可以的照旧排进计划；其余推入 `LEFT_TO_USER`，不写入。签名与属实声明的条件也在这里判：本轮条目里有来源不是已确认资料或已确认材料包的、或用了未确认 aiAnswers 的，TRUTH 与两格签名留给学生（`CONDITION_UNMET`）。签名栏改为只取 `identity.fullName`，不用推导出的 `resolved.fullName`。
5. `runner.ts` 的 `signOnBehalfCurrent` / `signOnBehalfStillAllowed`：写之前按问题与版本重核合成结果。
6. `grant.ts`：不再需要原计划的 `mintSignOnBehalfItemAuthority`（浮层逐条点击放行），也不新增任何浮层授权凭证；`sign-on-behalf` 的信任根是后端授权记录加运行时包能力位。审阅面板路径 `buildAnswerPlan` 对 `isNeverWritableControl` 判定的控件仍一律 `MANUAL_ONLY`。
7. `engine.ts` 的 `withoutRecord`：档案里没有那个国家的记录时返回不带答案的结果，与 `NO_RECORD` 同路（跳过行带 `regionWithoutRecord`），不走 `PREFILLED_NEEDS_CONFIRMATION`（那会把不实答案预选在面板上）。测试：F-1、加拿大岗位、无记录 → 零写入、无 prefill。
8. 公民身份题：现有内核没有这类判据（`packages/contracts/src/fullAiAutofill.ts` 也把 citizenship 排除在 AI 回答之外）。P0 只加回归测试：任何路径都不对公民身份题写「是」。「F-1 答否」是 P1-1 的新判据，只认整句只问公民或绿卡的题，复合题一律留给学生。
9. `click/policy.ts` 的账号墙条款勾选：读到条款正文（由规则声明正文选择器，或读 `aria-describedby`）再判；`packages/apply-rules/rules/workday.json` 的 `accountSteps` 补正文声明。

插件（`apps/extension`）：

10. `lib/kernelFiller.ts` 的 `signOnBehalfKindsFor` 及其调用处：传授权快照，不再传整组类别。
11. `lib/signingConsentProvider.ts`：改读 `/ext/apply-authorization` 的快照，并与策略包里的当前版本核对；`signingConsentCoversAccountRegistration` 改读 `ACCOUNT_REGISTRATION`、`ACCOUNT_LOGIN`。
12. `entrypoints/background.ts`：账号授权和签名同意的读取处同上；填写结束时上报补问（§4.4）。
13. `entrypoints/apply.content.ts`：浮层接「这一页有 N 项留给你」、页面高亮和「继续自动填写」（§4.7）；不接任何授权提问组件。
14. `lib/signingReconsent.ts`：删掉浮层里的一键同意卡和「暂不」的本机记忆；没有授权记录时改为浮层顶部一行提示和「去投的单聊确认」链接。
15. `lib/dock/profileEditor.ts`：去掉签名同意开关，改为只读显示（§4.3）；更新注释里过时的版本号。
16. `lib/dock/copy.ts`：「留给你」、补问提示、提交卡与回执文案；「已替你同意：仲裁协议…」这类文案按问题改写。
17. `lib/autofillDockProgress.ts`、`lib/dock/needs.ts`：增加「留给你」行。`lib/attestationConfirmBar.ts`（写入前的阻塞确认条，未接线）与本方案冲突，不再接线。
18. `lib/consentGatePass.ts`：`allowed()` 改读 `TERMS_PRIVACY` 与 `DATA_SHARING`。
19. `lib/accountAccessProvider.ts`、`lib/accountVault.ts`、`entrypoints/background.ts` 的退出登录处理：新注册一律每家单独生成（`record.sites[site].password`），共用的 `record.password` 只用于此前注册的网站；加 §3.4 表下的保护（09 10A）。
20. `lib/wizardAdvanceController.ts`：读 `AUTO_ADVANCE`；有「留给你」的页不翻，续跑按 §4.7。
21. `packages/apply-kernel/src/policy.ts` 的包内基线写入 linkedin.com、indeed.com（含 Indeed Apply 嵌入域）和政府招聘站点（usajobs.gov 及常见的州、市政府招聘平台），覆盖 generic 路径；远程下发的 `deniedHostSuffixes`（`packages/contracts/src/executionRuntime.ts`）只能再加。这是对 policy.ts「基线为空、否决只从远程来」的有意例外，注释里写明。
22. 扩大浮层提交（待 §8 第 2 条）：Ashby、Workday 页面没有 `<form>`，提交按钮没写 type，现行内核只认「扫描出的字段所在表单里的原生提交」，要改内核的识别方式，并改 RULE-EXTENSION-NEVER-SUBMIT「只按原生提交」；Workday 的 Review 页 DOM 还没拿到。Lever 不做：可见的提交按钮 type=button，点了先走 hCaptcha，唯一的原生提交是隐藏的 `hcaptchaSubmitBtn`（见三家规则文件的 `$comment.finalSubmitControl`）。

契约、后端与测试：

23. 契约见 §6.1；端点（读当前授权、确认卡写入、补问队列、撤回）见 09 10B。
24. 迁移按 §4.4 最后一条。
25. 测试：更新 `signing-consent-provider`、`signing-reconsent`、`consent-round-5-classifier`（它把 `ALL_SIGN_ON_BEHALF_KINDS` 与条目键表逐项钉住）、`sign-on-behalf-runner`、`apply-consent-round-5-plan`、账号相关测试。新增：§6.1 合成（含第 2 条的组合）、没有记录与版本不对都留给学生且不弹窗、MARKETING 不勾、签名条件、公民身份回归、别国工作授权零写入、每家独立密码与退出前导出、Discord 只能写 `LEAVE_TO_ME`、§4.7 的六个验收用例。

### 6.3 文档与规则同步

改 AGENTS.md 需要产品负责人确认（09 10D）。

- 根目录 `AGENTS.md` 的执行边界一条按 2026-10-06 的决定改为：「不后台提交申请；最终提交、验证码由用户本人操作；代签、代注册登录与敏感字段只按用户在对话中确认过的逐项授权执行」（10-07 的决定去掉了「小组」二字）。子目录和代码（如 `lib/consentGatePass.ts`）引用的 `RULE-GLOBAL-HUMAN-AUTHORIZATION` 在根目录里不存在，一起补上。
- `apps/extension/AGENTS.md` 的 RULE-EXTENSION-HUMAN-AUTHORIZATION 例外段：从「同意当前文案版本即代填」「浮层一张卡请他一键同意」改为「按用户在对话中确认、后端记录的逐项授权代填」。信任根是后端授权记录（每一问的回答与文案版本）加运行时包能力位；版本不对、没有记录一律留给用户，浮层不提问。账号例外段改读 `ACCOUNT_REGISTRATION`、`ACCOUNT_LOGIN`。同时把犯罪记录（代码在 `SCREENING_CONSENT` 里）补进列明范围。
- `packages/apply-kernel/AGENTS.md` 的 RULE-KERNEL-SENSITIVE-WRITES：「同意当前文案版本」改为「按逐项授权与版本合成」，写明 `FACET_TO_QUESTION` 合成规则。
- `docs/product/01-vision-and-users.md` §8.2 按本文改写，底线引用 §5.1。

### 6.4 实施顺序

具体步骤以 09 §13 为准，顺序原则：

1. **P0 期间先做小而急的安全修正**（09 10A，不发布）：计划层默认拒绝；别国工作授权不带 prefill；公民身份回归测试；本地写死 LinkedIn、Indeed Apply 和政府站点的否决；每家独立密码与保险箱保护。
2. **对话授权主干**（P1-1；09 10B、10C）：契约与问题目录、后端存储、确认卡、内核按回答与版本合成、「留给你」与补问、老用户迁移。
3. **体验与安全收尾**（09 10D）：提交卡与回执、投递官汇报、Workday 条款正文、AGENTS.md 同步。
4. **效率补偿**（09 10E）：浮层提交等 §8 第 2 条；批量预填 P2。

## 7. 需要律师审核的问题

1. 学生在对话里（投的单聊）事先逐项确认、插件之后替他勾选，这些勾选能否归属于学生（UETA §9、代理法）？学生没看过具体那一份文书时，是否满足 ESIGN 的「签署意图」？
2. 求职申请算不算 ESIGN 和 UETA 意义上的「交易」（transaction）？
3. 属实声明与签名：一次性授权，加上本轮写入全部来自确认过的资料、没有未确认的 AI 回答、最终提交由本人点击这些条件，够不够？签名栏代填法定全名是否构成有效的电子签名？政府职位的识别范围划到哪里？
4. FCRA：背景调查授权是否必须由本人逐次签署（每家雇主、每份独立披露文件各签一次）？一次性长期授权、插件在具体雇主的披露文件上代勾，是否满足「书面授权」？如果不满足，`BACKGROUND` 是否应移入底线？ICRAA 报告副本勾选框固定选「要」是否可以？
5. 仲裁与陪审团弃权：一次性、长期的授权，对之后遇到的、学生没看过的具体仲裁协议代勾，是否构成有效同意（Berman 的醒目告知与明确同意）？加州等州对争议前放弃陪审团有什么特别规定？代勾以后我们会不会被卷入争议？
6. TCPA：申请相关的自动拨号和预录电话，一次性授权后插件代勾的「事先同意」是否有效？营销不进问答、一律不勾是否足够？佛罗里达等州的 mini-TCPA 有什么额外要求？
7. AI 面试：在伊利诺伊、马里兰、加州等州，求职者事先授权第三方插件代他同意录音或 AI 评估，是否有效？
8. 照资料作答的身份题：学生在对话里给出的工作授权答案由插件照填，陈述责任是否落在学生身上？除公民身份题外，还有哪些题必须留给本人？
9. 平台条款：雇主自己的 Workday 招聘站、Greenhouse 托管页、Lever、Ashby 的候选人条款是否禁止插件自动化？工具提供方是否可能面临「干扰合同」等主张？收到停止通知后的流程怎么定？
10. 代注册账号：以用户名义接受招聘网站条款的效力和风险？MyGreenhouse 禁止自动化的条款是否也适用于 Greenhouse 托管的申请页？
11. CCPA/CPRA：是否达到适用门槛？对话里分组问、可以「这一组都可以」、不预选、确认卡逐项列出，是否构成有效同意，会不会被认定为暗黑模式或捆绑同意？原文快照、EEO 答案、身份信息要怎样告知和存储，完整快照能否同步到服务器？
12. 确认卡文案与记录方式：逐项列出、点「确认这些授权」、记录带每一问的文案版本与来源、追加保存，是否足以作为同意的证据？只认确认卡、不认聊天里的自由文字，这条线是否合适？是否需要另发确认邮件或可下载副本？撤回的效力和范围；提交卡与回执的文案。
13. 用户协议如何约定插件代勾行为的责任分担。
14. 将来做云端代投时，CFAA 和合同风险怎样变化？Amazon v. Perplexity（第九巡回，2026-08-04，需核实）的结论依赖「经由用户电脑访问」这一事实。

## 8. 待确认问题

截止时间都是 P1-1 开发前（07 假设 11 月底）。律师审核（§7）上线前完成，没有答复的对应功能不发布。

| # | 问题 | 由谁回答 | 不回答时的默认 |
|---|---|---|---|
| 1 | 云端或后台代投已定不做（2026-10-06），要做须另行决定并改 AGENTS.md。仍待回答：蔓藤运营把用户确认过的材料用邮件转给合作企业（04，P1-9）算不算「后台提交」？ | 产品负责人 | 转递在答复前不上线 |
| 2 | 是否修改 RULE-EXTENSION-NEVER-SUBMIT「只按原生提交」，以扩大浮层内提交（Ashby、Workday；Lever 不做）？ | 产品负责人 | 不改，09 10E 不排期 |
| 3 | 是否开放「页面直填」入口，每天上限多少？ | 产品负责人 | 开放，不另设上限 |
| 4 | 批量预填（P2）的系统每日上限，是否按会员层级区分（06）？ | 产品负责人 | 每天 10 条（假设），用户只能调低 |
| 5 | 营销订阅按本文不进问答、一律不勾（§3.2 表下），是否同意？ | 产品负责人 | 按本文 |
