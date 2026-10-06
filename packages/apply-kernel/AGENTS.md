# AGENTS.md — 确定性填表内核

本目录迁自 argoland-extension。架构与契约归本项目根 AGENTS.md 管理；下方保留源代码运行安全约束与历史说明。
旧仓的产品名、批准日期、发布记录只描述来源，不能视为本产品已经获得生产放行。
修改 UI 可独立于内核；不得因此绕过授权、用户真实点击、隐私、写策略与 fail-closed 检查。

<!-- BEGIN:D5-SCOPED-RULES -->

## RULE-KERNEL-DETERMINISTIC-BOUNDARY · Kernel 保持确定性与无浏览器依赖

apply-kernel 是确定性、可测试的纯解释器；不得引入 Chrome API、UI 状态或网络副作用。对 host page 的实际写入仍由 Extension adapter 承担，并遵守声明的恢复模式、最窄字段与不自行 submit 的边界（内核只交出规则声明的 `finalSubmitControl`，从不按它；按不按只在根 AGENTS.md RULE-EXT-NEVER-SUBMIT 规定的用户点击之后由内容脚本决定）；fill-first 路径冻结 Undo／自动恢复，但保留验证与写后失败如实报告。

## RULE-KERNEL-RULE-DATA-SEPARATION · 站点规则数据与解释器分离

站点适配知识属于 packages/apply-rules/rules/*.json；kernel 只实现通用解释语义。不得把 board selector、站点分支或可执行远程代码硬编码进 kernel，规则 schema、provenance 与拒绝型 fixture 必须同步验证。

## RULE-KERNEL-SENSITIVE-WRITES · 敏感写入原语不等于放行

kernel 中存在 sensitive classifier、checked 或 password writer 不代表调用方或 production 获准使用。通用 gesture／lease 永远不得 mint reserved sensitive authority；每个条目必须绑定后端 durable release、exact occurrence、fresh target／rule／policy 和当前 capability ceiling，并在每次写前重验。OTP／2FA／CAPTCHA 及混合／未知控件始终拒绝；营销等同意类与联系现任雇主只按下方例外放行；完整 final convergence 前 sensitive capabilities 固定 false。

例外（2026-09-23，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION）：`sign-on-behalf` 放行的条款同意、属实声明与签名不走逐项 durable release，它的信任根是用户在门户单独勾过的同意（后端记录）加运行时包的能力位。约束仍在：通用铸造永远删掉这一位（保留集）；计划期只认 `dict/signOnBehalf.ts` 的整句判据，掺了别的授权一律拒；写前与每一下点击前重验策略与同意；勾选框只走原生点击，点击被拒不回落到属性写入。第二刀（2026-09-23）扩到选择题：单选组、原生下拉与 listbox 下拉只选肯定回答闭集里的那一项、或本身就是整句同意的那一项（恰好一项才选）；带代填标记的点击目标在点下去那一刻必须认得回来，认不回来就拒；原生下拉走属性写入，写前要求控件旁的文字与计划时逐字相同。第三刀（2026-09-24，负责人决定）扩大类别：AI 面试记录／转写同意、申请相关短信、日后联系与人才库、营销信息、背景调查授权、仲裁协议的阅读确认与同意，同一套信任根与约束；每一类都要有自己的整句判据与否决词（联系现任雇主、点名第三方、否定句、几类混在一起一律拒）；ARIA 代理选择题（Ashby 的是非按钮）只在认得出这些类别时走代理点击路径代填，点击策略的防提交约束不放松。第四刀（2026-09-24）不加类别，只补条款同意与属实声明的说法：申请者／候选人自己的政策与指引、「交的是本人的作品」、为这份申请处理人口统计问卷的回答；说到分享、披露、转出的照旧拒。第五刀（2026-09-28，负责人决定）再放宽一轮，前四刀的判据一字不动（只收紧：仍交还本人的几类在每一刀都拒），它们认不出的才轮到第五刀、第五刀只答新类别：招聘用途的资料处理与分享（招聘服务商、ATS、关联或集团公司，要说到招聘用途）、核实所填信息（学历、工作经历、身份、E-Verify；以前的雇主与学校可以出现在核实里）、背景调查其余几种（信用、药检、驾驶记录、社交媒体、定期复查）、at-will、同一段文字里说到仲裁的集体诉讼与陪审团弃权、AI 分析或评估面试录音、申请相关的电话与 WhatsApp、集团公司日后联系、只有标题的隐私声明（只配一个肯定回答）、只由放行类别组成的混合。同意书 2026-09-28 起是一句话，每一类写在 argoland 隐私政策里版本号与同意书相同的那一节；范围一改两者一起升版本，只有当前版本的同意算数（`SIGNING_CONSENT_KINDS` 是当前版本覆盖的类别），旧版本的同意不覆盖新加的类别。计划期只排这一轮获准的类别（`signOnBehalfKinds`；调用方不给，能力位本身就是「同意了当前版本」），runner 写前按类别再核（`signOnBehalfCurrent(kind)`）。仍一律拒：出售或为营销分享、生物特征、免责／不追责／赔偿、竞业／不招揽／保密、医疗健康与残障、调查式消费者报告、拿录音训练 AI、AI 分析情绪或做决定、营销电话、现任雇主／推荐人／同事混在同意里、否定句（at-will「不是劳动合同」、E-Verify「不会拿来预先筛人」、仲裁「不能提起集体诉讼」这几种固定的 not 除外）。核实类放行后，点击策略对认得回来的那一句按整句读验证码一类（verification code、verify your email、one-time、passcode、OTP 照旧绝对拒绝），认不回来的文字照旧整段判。能不能联系现任雇主（2026-09-28）按调用方交来的资料回答答（`employerContact`），方向写进类别（`EMPLOYER_CONTACT_YES/NO`；只问以前的雇主或推荐人的是 `REFERENCE_CONTACT_*`），点击当下「不可以」那一向只认否定回答的闭集、「可以」那一向只认肯定回答或正面许可的整句；单个勾选框只在答「可以」且那句话是正面许可时勾。

例外（2026-09-28，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION 例外三）：替用户在招聘网站上注册、登录。`account-access` 是保留位，通用铸造永远删掉它；只有 `mintAccountAccessAuthority` 铸得出、票上只有这一位，信任根是一次真实点击或那一下点击开出的一轮连填里「这一页」的凭证（账号墙是那一轮的第一页；账号墙之后的第一页可以换一次路径，`rebindAfterAccount`，同源同厂商、只许一次）。能碰的只有规则声明的账号墙（`accountSteps`，`rules/accountWall.ts`：每一步的格与控件都要唯一，认不出就是 null）：邮箱与密码只写进声明的那几格（密码格必须是 `type=password`，写完读回，`write/accountCredential.ts`）；点击走 `account-control` 这一支（`click/policy.ts`）——注册条款必须是勾选框、掺了营销／订阅／短信／人才库或别的同意的拒，别的控件不得是链接、付款、申请提交、隐藏、验证码、蜜罐或密码框；每一下之前重读策略位、重核这一步还是那一步（`accountAccess.ts`）。验证码与人机验证照旧拒绝，账号墙那一路的关卡判据只是不把密码框本身当关卡（`detectHumanCheckpoint` 的 `ignoreLogin`）。

例外（2026-10-04，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION「邮件里的验证码」）：规则 `emailVerification` 声明的验证码格，只经 `write/emailCode.ts` 写入用户本人在我方浮层里输入的那一串。`rules/emailVerification.ts` 认格（容器整页恰好一个、看得见；格数是 1 或等于位数；每一格是文本类、可写、看得见；认不出就是 null）；`normalizeEmailCode` 整理（全角转半角、去空白与横线，位数或字符不对就不写）；写入要那一下点击铸的、此刻活着的 `set-text` 票与写策略，写前 `isCurrent()`，写完读回；只发 `EVENT_PROFILES.text` 的事件，不点、不提交。计划期照旧拒绝验证码格（`OTP_OR_2FA`），内核从不自己取码，也没有任何从资料、答案记忆或 AI 到验证码格的路。

<!-- END:D5-SCOPED-RULES -->
