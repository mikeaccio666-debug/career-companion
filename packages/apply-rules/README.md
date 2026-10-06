# @edaix/apply-rules — ATS 适配规则（纯 JSON 数据）

每家 ATS 一份规则文件（`rules/<vendor>.json`），由后端下发热更新，扩展内只留解释器。
理由：Chrome 商店审核最坏 28 天（docs/20-技术架构.md §3）；MV3 禁远程可执行代码、
不禁远程配置数据。站点改版当天改 JSON 下发，不过商店。

## DOM 知识只在规则数据

- selector、正则与厂商 DOM 知识只存在于 `rules/*.json`。schema 类型与不可信输入校验在
  `apply-kernel/src/rules/schema.ts`，解释器在 `apply-kernel/src/rules/interpreter.ts`。
- `runtime-release.ts` 只做 value-free 的发布装配：递归剥离 `$comment*`、深冻结发布对象并提供
  exact `(atsProvider,pathRuleId)` 查找；它不包含 selector 字面量，也不执行页面逻辑。
- 铁律 3 的完整表述：宿主站点 DOM 知识只能位于本包（数据）与 kernel 的解释器。
  例外是 `apply-kernel/src/vendors.ts` 的主机名表——它生成 manifest 注入范围，
  商店审核期内本来就改不了，热更新对它没有意义。
- JSON 没有注释语法，实测记录与判断依据写在 `$comment` 打头的键里，
  校验器会忽略它们。**改数据必须同步改注释**——这些注释保存各家真实页面的只读实测来源与日期。

## 改规则的纪律

1. 任何行为改动先过 `@edaix/apply-kernel` 的特征测试
   （`pnpm --filter @edaix/apply-kernel test`，只认退出码）。
   已具备 fixture 的适配器各有行为回归；schema 本身由
   `tests/apply-rules-schema.test.ts` 锁。
2. 校验是 fail-closed：整份拒收 + 稳定原因码（`RULES_MALFORMED` /
   `RULES_SCHEMA_TOO_NEW` / `RULES_REGEX_INVALID` / `RULES_VENDOR_UNKNOWN` /
   `RULES_FIELD_KEY_UNKNOWN`）。远程 release 还必须逐 ruleset 与整包验证 JCS/SHA-256；任何一层
   不匹配都关闭执行，不得退回随包内置份恢复授权。运行时拒收一份规则只停**那一家**（见下面
   「前向兼容」）；发布侧（`buildApplyRulesRelease`、随包规则的严格测试）照旧整份拒。
3. 正则 flags 只放行 `i`。锚点必须是厂商声明的容器（form id / 语义 class /
   data-ui），绝不能用稳定输入 id 兜底——页脚订阅框也常拥有 `#email`。
4. 新增匹配语义（新的 step 类型）= 解释器变更 = 要过商店，同时 bump
   `schemaVersion`；旧解释器对新版本 fail-closed。
5. `schemaVersion: 2` 要求每家规则显式声明 `finalSubmitControl`：只有已在多个真实 posting
   复验且能在 verified application container 内解析为唯一、enabled、同 form 的原生 submit control
   才能提供 `{selector, activation:"native-submit"}`；未证实的 vendor 必须写 `null`。selector 只由
   kernel 解释，Extension 只接收 selector-free exact element descriptor。
   2026-10-04 起两处补充（形状不变，旧内核读到同一份数据只会更保守）：
   · **表外、用 `form` 属性认领这张表的那一颗**（BambooHR：提交钮在表下方的操作栏里，
     `<button type="submit" form="job-application-form">`）。扫描根里一颗都没有时，内核只认整棵树里恰好一颗、
     `form` 属性正好写着这张表的 id、而且是这张表名下唯一一颗原生提交的那一颗；选择器要自己带上那个 `form` 属性。
     更早的内核只在根里找，找不到就是 `null`（与没声明一样，不按）。
   · **扫描时被网站禁用着的那一颗**（Rippling：必填填好之前 `aria-disabled`）：扫描交出的是 `null`，描述符另带
     `resolveFinalSubmitControl()`，扩展填完之后按同一套判据再认一次。判据一条没放松。
   哪几家声明了、哪几家为什么没声明，见各家 `$comment.finalSubmitControl`（2026-10-04 一轮：Dover、Rippling、
   BambooHR 声明；Lever、Ashby、SmartRecruiters、Jobvite、Workday 照旧 `null`）。

## 前向兼容：后端先发、已装的包还没跟上（2026-09-28）

规则由后端热更新下发，商店包的更新是异步的（审核 + 用户升级），两边**永远**有一段版本不一致的窗口。
2026-09-24 那一次：Workday 的规则加了顶层键 `searchPromptComboboxes`，旧包整份 release 拒收，所有厂商约
5 分钟内一起停。从 2026-09-28 这一版内核起，运行时（`createRuntimeApplyRegistry` 一类）的口径是：

| 送达的东西 | 这一版内核 | 诊断码（`APPLY_RULES_INSTALL_` 前缀） |
|---|---|---|
| 一份规则多了不认识的**顶层键**（小驼峰标识符） | 不解释、不保留，这份规则照常装上 | `RUNTIME_RULESET_UNKNOWN_KEY_IGNORED` |
| keySteps / 行内映射指向不认识的档案键或行内角色 | 只那一条不生效 | `RUNTIME_RULESET_UNKNOWN_FIELD_KEY_SKIPPED` |
| 已知结构**里面**的陌生东西（条目多一个键、新的 step 类型、新的枚举值）、比内核新的 `schemaVersion`、别的解不开 | 这一份规则读不了：**只停这一家**，别家照常 | `RUNTIME_RULESET_SKIPPED_<RULES_*>` |
| 不认识的厂商（映射） | 它的映射与规则一行都不解释 | `RUNTIME_RULES_UNKNOWN_VENDOR_SKIPPED` |
| 摘要不符、release 骨架（映射表、ruleset 信封）不对、注解没剥 | 整份拒，所有厂商停（完整性问题，不是版本窗口） | `REJECTED_<RUNTIME_RULES_*>` |

为什么条目里的陌生键不「只跳过那一条」：条目之间不独立。`rowScopes` 的 `insertsAt` 决定新行插在哪一头
（忽略它，旧包会把新值写进已有的那一行）；`maskedCells` 是「这几格不许写」；一条 typeahead 绑定往往同时把
那个字段移出了 `widgetNames`（丢掉绑定，旧包就把它当普通文本框整串写进去）。丢一条或忽略一个属性都可能
让旧包多写、写错地方，所以单位是整份规则。顶层键不同：它们在这份 schema 里是互相独立的一项能力。

**对规则作者的约束**（从此以后改规则都要守）：

1. **新的、独立的能力放进新的顶层键**，而且必须是纯加法：去掉这个键，这份规则对不认识它的内核仍然正确。
2. **联动的改法不是纯加法**：把一个字段移出 `widgetNames` 改由新键驱动、给已有语义加限制……旧内核看得见
   「移出」、看不见「接管」。要么保留旧的那一半，要么 bump `schemaVersion`（旧内核只停这一家）。
3. **已知结构里加键**（例如给 `listboxComboboxes` 的条目加一个属性）：本版起的包只停这一家，但——
4. **2026-09-28 之前构建的包（包括商店 1.0.0）仍然是旧口径**：任何一个它们不认识的键都让整份 release
   拒收、所有厂商停。在这些包退场之前，带新键的规则照旧走「先合并 → 重打重装所有内部包 → argoland 才发布」。
   服务端按插件版本挑规则的提案见本仓 PR 说明。

发布侧照旧严格：`buildApplyRulesRelease` 对陌生顶层键与读不了的规则整份拒收，
`apply-kernel/tests/apply-rules-bundled-keys-strict.test.ts` 对每一份随包规则的陌生顶层键与陌生档案键都拒收——
本仓是规则的作者，拼错的键在这里就该红。

## Account steps（账号墙：替用户注册、登录，可缺省，2026-09-28）

`accountSteps` 是可缺省的新顶层键（缺省 / `null` = 这一家没有账号墙）。它声明申请之前那一道账号墙的每一步，内核
（`rules/accountWall.ts`）只按它认、只在它声明的格与控件上动手，插件在用户按下「注册并自动填写」「登录并自动填写」
之后才走（根 AGENTS.md RULE-GLOBAL-HUMAN-AUTHORIZATION 例外三）。形状：

```json
{
  "container": "账号墙的容器（唯一）",
  "path": null,
  "steps": [
    { "kind": "choice", "marker": "…", "useEmail": "…" },
    { "kind": "createAccount", "marker": "…", "email": "…", "password": "…", "verifyPassword": "…", "terms": "…", "submit": "…", "toSignIn": "…" },
    { "kind": "signIn", "marker": "…", "email": "…", "password": "…", "submit": "…", "toCreateAccount": "…" }
  ],
  "banners": "网站说话的地方（横幅、错误提示）",
  "outcomes": [{ "kind": "accountExists", "text": { "source": "…", "flags": "i" } }]
}
```

- `kind` 只有四种：`choice`（选怎么登录，只按「用邮箱」）、`identify`（先报邮箱，iCIMS）、`signIn`、`createAccount`；
  同一种至多一步、至多四步。每一步必填的键见 schema（`ACCOUNT_STEP_KEYS`），多一个、少一个整份规则读不了。
- `marker` 在容器里恰好一个时才是这一步；每一格、每一颗也要恰好一个，认不出就当没有账号墙（照旧交还本人）。
- `password` / `verifyPassword` 必须落在 `type=password` 上；`terms` 必须是勾选框，而且只是**注册本身**要的条款——掺了
  营销、订阅、短信、人才库的不要声明（内核的点击策略也会拒）。`submit` 声明人真正点到的那一层（Workday 是罩在隐藏的
  原生按钮上的 `click_filter`），内核用原生激活去点，走网站自己的提交处理。
- `path`：只有账号墙、没有申请表的那一页的路径（iCIMS 的 `…/login`），没有就 `null`。
- `outcomes`：按了注册／登录之后，`banners` 里看得见的字说明了什么——`accountExists`（改登录）、`wrongPassword`（请用户输
  这一家的密码）、`verifyEmail`（请他去邮箱验证）、`blocked`（被锁、只能单点登录）。都对不上就当网站没接受。

版本纪律：新的独立能力、纯加法（去掉它，这份规则对不认识它的内核仍然正确），不 bump `schemaVersion`。**但商店 1.0.0 与
2026-09-28 之前的内部包不认识它，会整份拒收、所有厂商停**：带 `accountSteps` 的规则只能在下一个商店版本上架、所有内部包
重打重装之后，才由 argoland 发布（见上面「前向兼容」第 4 条）。2026-09-28：workday-rules-v14、icims-rules-v10，release
`apply-rules-2026-09-28.1`。Workday 的三步照 nvidia.wd5 只读实测（没有输入、没有提交）；iCIMS 只声明了实测过的「先报邮箱」
那一步，密码与注册那两步要等有人真走一遍再补。

## Email verification（邮件里的验证码：他在浮层里输，插件写进那一格，可缺省，2026-10-04）

`emailVerification` 是可缺省的新顶层键（缺省 / `null` = 这一家没有声明）。它说两件事：网站发来的那一封验证邮件长什么样
（只给人看，插件不读邮件），以及网站要验证码时页面长什么样。验证码由用户本人在我方浮层那张卡上输入或粘贴，插件只在他按下
「填进网站」那一下之后写进声明的那一格或那几格，写完不提交（根 AGENTS.md RULE-GLOBAL-HUMAN-AUTHORIZATION「邮件里的验证码」）。

```json
{
  "mail": { "from": ["发件地址", "…"], "subject": "标题的开头或 null" },
  "codePrompts": [
    {
      "container": "提示的容器（整页恰好一个、看得见）",
      "inputs": "容器里验证码那一格或那几格",
      "length": 8,
      "charset": "alphanumeric",
      "recipient": "容器里写着发到哪个邮箱的那一处，或 null",
      "errors": "网站说验证码不对、过期的地方（整页），或 null",
      "outcomes": [{ "kind": "expired", "text": { "source": "…", "flags": "i" } }],
      "next": "resubmit"
    }
  ]
}
```

- `inputs` 命中的格数只能是 1（一格收整串，`maxlength` 装得下）或正好 `length`（每格一个字符）；每一格必须是文本、电话、数字或
  没写 type 的 `<input>`，可写、看得见。任何一样不对就当认不出——浮层照旧请他去网站上输。
- `length` 4–12；`charset` 只有 `digits` 与 `alphanumeric`；`next` 是 `resubmit`（再按一次提交）或 `verify`（网站上的验证钮），
  两种都由他按。`outcomes` 的 `kind` 是 `wrong` / `expired` / `tooMany`，每种至多一条，有 `outcomes` 就必须有 `errors`；认不出的
  原话浮层照登。
- `mail.from` 1–4 个、`subject` 可为 `null`，每一行至多 120 字。`codePrompts` 可以是空的（Workday 的邮箱验证是点链接，只用 `mail`
  给「去邮箱点一下验证链接」那张卡一行发件人）。

版本纪律：新的独立能力、纯加法，不 bump `schemaVersion`；2026-09-28 起的内核不认识它只是不解释。2026-10-04：greenhouse-rules-v23
（Security code，出处是 job-boards.greenhouse.io 公开的前端代码与文案包）、workday-rules-v17（只有 `mail`），release
`apply-rules-2026-10-04.2`（接在同日 Dover／Rippling／BambooHR 声明最终提交的 `.1` 之后）。

## Consent gate（申请表之前的数据同意页，可缺省，2026-10-04）

`consentGate` 是可缺省的新顶层键（缺省 / `null` = 这一家没有这一道）。它声明申请表之前那一道「数据同意」页：Jobvite 的
申请页第一步是 `form[name=consentForm]`，先选居住地，网站再给出隐私条款与「同意」，同意之后才出申请表。形状：

```json
{ "form": "同意页的容器（必填）", "residence": "选居住地的下拉", "text": "条款正文", "accept": "同意的那一颗" }
```

- `form` 必填：锚点没命中、它却在页面上时，内核答 `CONSENT_GATE`（`readRuntimeApplyFormResult` 的停因），浮层照实说要他先
  选居住地、同意条款，不再说「认不出申请表，请刷新」。锚点在页面上就不是同意页。
- `residence`、`text`、`accept` 可缺省（写了就得是非空字符串）。只有 `form` 时内核只认、不动手。
- `residence`（2026-10-04，负责人 D7）：那张表里的居住地下拉。代填授权成立（运行时包放行 `sign-on-behalf` ∧ worker 读到
  他同意着当前版本）时，插件替他选他资料里的居住国那一项（内核 `dict/consentGate.ts` 判选哪一项、`dict/signOnBehalf.ts`
  判那一项干不干净；写入走 `consentGate.ts` 的专用票）。网站选完多半当场自己提交、整页跳到申请表；把条款摆出来、要人点
  「Accept」的那几份交还本人——`text`、`accept` 这一版不声明，插件不按任何提交控件。

版本纪律：新的独立能力、纯加法（去掉它，这份规则对不认识它的内核仍然正确：照旧说认不出申请表），不 bump `schemaVersion`。
2026-09-28 之后的内核（含商店 1.1.0）不认识它只是不解释；更早的包整份拒收（见上面「前向兼容」第 4 条）。2026-10-04：
jobvite-rules-v11，release `apply-rules-2026-10-04.3`；加 `residence`：jobvite-rules-v12，release `apply-rules-2026-10-04.4`（同日 `.1`、`.2`
先合，这两份重新编号）。

## Whitelabel root（白标 B：客户自建前端的退路，可缺省）

`whitelabelRoot` 是「锚点绝不能用稳定输入 id 兜底」那条纪律的**唯一例外**，形状 `{ "container": "form", "minHooks": 3 }`。
钩子不另抄：从本家 keySteps 里 `attrMap` on `id` 的键派生（Greenhouse 是 first_name / last_name / email / phone）。
解释器只在**三道闸同时成立**时走它：调用方声明 `whitelabel: true`（指纹判定为该家、且主机不在任何厂商表里——
指纹那条红线不动，认厂商仍只靠厂商自己的产物）；容器里本家 id 钩子 ≥ minHooks；这样的容器**恰好一个**。
钩子 < minHooks 或两个容器都像 → 照旧 NO_ROOT。白标下 `isApplyPath` 也不看本家路径（别人的域名上不适用），
闸在 DOM 那一道。2026-09-21（插件 P2-11）Greenhouse 声明 `form` + 3；夹具 careers.duolingo.com
（`apply-kernel/tests/apply-greenhouse-custom-domain.test.ts`）。版本纪律同上：可缺省新键，不 bump schemaVersion；
greenhouse-rules-v11 → v12，release `apply-rules-2026-09-21.3`。

## Embedded apply path（官方嵌入帧承载同一张表的路径，可缺省）

`embeddedApplyPath` 是可缺省的顶层正则键（缺省 / `null` 归一化为 null = 没有这条路）。它声明**厂商官方
嵌入帧**（公司站点上 `#grnhse_app` 里的 `iframe#grnhse_iframe` 一类）加载同一张表的路径。解释器的
`isApplyPath(pathname, { embedded })` 只在调用方声明 `embedded: true`（内容脚本运行在子帧，
`window.top !== window.self`）时才让它参与判定；顶层帧上那条路径照旧不是申请页。

为什么不直接进 `applyPath`：Greenhouse 的 `/embed/job_app` 岗位身份在 query 里，pathname-only
authority（mission 那条路的 intent 绑定 origin + pathname）对它必须 fail closed——两个岗位共用一条
pathname 就分不开。手势路的授权根是用户在那一帧里的点击，帧身份（tabId + frameId + origin + pathname）
足以钉住「这一张表」。2026-09-21（插件 P2-10）Greenhouse 声明了 `^\/embed\/job_app\/?$`，
夹具 `apply-kernel/tests/fixtures/greenhouse/legacy-embed-application-form.html`（2026-07-30 只读核实）。

版本纪律与 `questionScopes` 相同：可缺省的新顶层键，**不 bump `schemaVersion`**；旧解释器对带这个键的
规则整份拒收（`RULES_MALFORMED`），所以数据只能在带新解释器的扩展过店之后下发。greenhouse-rules-v10 → v11，
release `apply-rules-2026-09-21.2`，摘要按 registry 测试的算法重算。

## Combobox semantic transaction（default-off）

`comboboxSemanticControls` 是可缺省的数据字段；缺省会被规范化为 `[]`，表示解释器不能铸造
semantic authority，runner 必须在打开下拉、setter/event、progress/receipt 之前返回
`CAPABILITY_DISABLED`。可见 input 的 `.value` 不属于选中态证明，也不属于 semantic Undo。

当前第一阶段描述符只表达一条最窄闭集：exact trigger selector 与 open/closed attribute、exact
option root、exact member selector、唯一 option identity attribute、显式 selected/unselected state，
以及 `exact-selected-option` snapshot + `native-click` restore activation。解释器只在 trigger selector
恰好命中当前一个 combobox、且没有第二条 descriptor 同时命中时，向 kernel 提供 selector-free
authority；readback、snapshot、restore 与 Undo 都会重读 root/membership/identity/text/selected state。
恢复 prior option 前还必须通过共享 click deny facts，Submit-looking、hidden、disabled、CAPTCHA 等
目标一律零点击。

`*-controlled-combobox-canary.json` 仅是四家 Data-L1-free synthetic controlled rehearsal 数据：
它们不在 `package.json#exports`、`runtime-release.ts` 或 `release-manifest.json`，不能作为真实 ATS
selector、E2E、production activation 或发布证据。现有 live vendor JSON 均不声明这组数据，保持
default-off。未来任何 live descriptor 都必须先有 exact posting evidence，并单独处理 release/schema
兼容；不得把这些 canary 接进 runtime release。

## Question scope（题干容器，可缺省）

`questionScopes` 是可缺省的数据字段（缺省归一化为 `[]`，一切照旧）。每条声明一个厂商的**逐题包装容器**
与容器内**承载题干的元素**：

```json
"questionScopes": [{ "container": "li.application-question", "label": ".application-label" }]
```

解释器语义（`apply-kernel/src/rules/interpreter.ts` 的 `resolveQuestionScope`），全部 fail closed：

- 按声明顺序试；一条只在 `element.closest(container)` 落在已验证的扫描根内、且该容器里 `label`
  **恰好命中一个**、命中元素**不包裹任何控件**、题干文字非空时才算命中。非法选择器按未命中处理；
  容器里两个题干元素说明容器比一道题大，跳过而不猜。
- 命中后也**永远不覆盖宿主声明给控件的名字**（显式/包裹 `<label>`、`aria-labelledby`、`aria-label`，
  即 `labelTextFor(el, { declaredOnly: true })` 非空的情况）。它只在控件本来会靠占位符、title 或
  附近文字**推断**标签时接手：Lever 自定义题只有 placeholder「Type your response」、Ashby 的
  location 自动完成框没有 id、Rippling 的长题干超出附近文字的 120 字上限、Dover 的题干是 styled div。
- 单选/复选：命中的容器就是这道题，容器内同类型成员一律归为一组——`name` 不同也算
  （Ashby 的「select all that apply」给每个 checkbox 起了自己选项文案的 name，按 name 归组会把一道
  7 选项的题拆成 7 道单项题）。题干取 `fieldset>legend` / 组 `aria-label`（宿主声明的组名）>
  scope 题干 > 单成员时它自己的标签。没有命中 = 与从前逐字相同（同名归组、legend 题干）。
- 反滥用 `denyLabels` 对题干与成员标签各查一次。

数据纪律：每条都要有 `$comment.questionScopes` 记录 posting URL、实测日期与量到的形态（哪些控件没
题干、哪些只剩 placeholder、哪些组被 name 拆开）。这是 2026-09-15 对 lever / ashby / rippling / dover
四家真实 posting 的只读实测结果；夹具 `apply-kernel/tests/fixtures/<vendor>/application-form.html`
同日追加了对应的真实题目结构，`tests/apply-question-scope.test.ts` 锁住「没有这条数据就读不到题干」。

版本纪律：这是一个**可缺省的新顶层键**，与 `listboxComboboxes` 同一性质，**不 bump `schemaVersion`**
（先例：greenhouse-rules-v3→v4 加 `listboxComboboxes` 时也没有）。旧解释器对带这个键的规则整份
拒收（`RULES_MALFORMED`）——与版本号太新的结果一样是 fail closed，所以数据必须在带新解释器的扩展
过店之后才能下发；把它塞进 v3 会和 wizard 的 v3 契约混在一起，故不这么做。凡是进
`release-manifest.json` 的 ruleset 改了内容，就要照 registry 测试的算法重算 annotation-free JCS/SHA-256
digest、`rulesetVersion` 单调递增（2026-09-15：lever-rules-v4、ashby-rules-v3）、`releaseVersion` 与
`releaseDigest` 同步更新；rippling / dover 不在 manifest 里，不涉及 digest。

## Listbox combobox 与 typeahead binding（fill-first，数据即声明）

`listboxComboboxes` 为 WAI-ARIA listbox combobox（react-select 一类）声明**只读回位置**：菜单与选项来自
ARIA（`aria-controls`/`aria-owns` → `[role=listbox]` → `[role=option]`），规则只写 `triggerSelector`、
`valueContainerSelector`、`selectedValueSelector`（多选再加 `multiValueContainerSelector` /
`multiValueLabelSelector`）。`selectedValueSelector` 命中一个 `input` 时回读它的 value——Rippling 与 Ashby
的搜索框本身就是显示位（2026-09-15 实测）。写入器只认「触发器所控制的 listbox 存在且 `aria-expanded`
不是 `false`」为打开；只在输入后才开列表的 typeahead（Ashby）由写入器自己输入候选再等列表；列表 portal 到
body 之外的选项，只有在触发器本身位于表单内、且选项落在其 `aria-controls` 所指 listbox 内时才被 click
policy 放行（`withinOwnedPopup`），其余目标照旧 `OUTSIDE_FORM`。凡是输入过文字却没有点中选项的退出，一律把
触发器恢复成写入前的值，搜索词绝不留在框里冒充选中值。

`typeaheadComboboxes` 为**没有 ARIA listbox 的纯文本建议框**声明数据面：`triggerSelector`、
`containerSelector`（触发器最近祖先）、`suggestionSelector`（容器内的建议行，文字即选项）、
`selectedValueSelector`（点选后的显示位）、可选 `minTypedChars`（默认 1）与可选
`selectionWitnessSelector`（只有真正点选才被宿主写入的控件；声明后成功必须它非空）。解释器把命中的普通文本框
提升为 combobox 描述符（binding 与 listbox 共用 `listbox` 槽位、带 `typeahead` 子对象），runner 分派到
`write/typeaheadCombobox.ts`：只用白名单内的 `input` 事件输入、等建议集稳定、同一套候选阶梯匹配、只点容器内
命中 `suggestionSelector` 的行（click policy 的 `ruleDeclaredOption` 由 DOM 推导）、回读显示位与见证位。
Lever 的 location 于 2026-09-15 声明（`input#location-input` / `li.application-question[data-qa=
structured-contact-location-question]` / `.dropdown-results > div.dropdown-location` / 见证位
`input#selected-location`，实测出处见该文件 `$comment.typeaheadComboboxes`），同时从 `widgetNames` 移出、
并在 `attrMap` 里补上 `location` 键。它此前留在 `widgetNames`，是因为其脚本只在 `keydown` 里发起搜索
（原生 setter + `input` 事件 3.5s 内零建议、零 `/searchLocations` 请求），而 kernel 的宿主事件闭集不含键盘
事件；同日闭集显式扩权，`HOST_EVENTS` 增加 `keydown` / `keyup`，唯一的派发口是
`write/allowlist.ts` 的 `dispatchTypeaheadSearchKey`，唯一的调用方是 `write/typeaheadCombobox.ts`，
因此这一对事件只会落在**本表声明过的触发器**上，普通文本框一个都收不到
（锁在 `tests/s0/apply-host-mutation-allowlist.redgreen.test.ts`）。声明前仍必须先有实测证据。

## 版本化发布边界

S7 已获用户批准的 v3 reader/producer/consumer 实施使用 L2-T / ATOMIC / default-off；
[具体范围](../../docs/status/T10-wizard-versioned-implementation-decision-2026-09-06.md)不等于发布许可。
新 reader 接收 v2 与 v3；v2 原形不变且拒绝 wizard 字段，v3 显式声明 `wizard: null` 或由共享 contracts
parser 校验的只读线性步骤数据。mixed v2/v3 release 的 `compatibility.rulesSchemaVersion` 必须为 3。
当前源数据、manifest 和默认 publisher 仍为 v2；v3 publisher 还受默认 false 的
`AGENT_EXECUTION_RUNTIME_WIZARD_RULES_ENABLED` 及既有 readiness/时间/版本门控制。先部署 reader，
再由 release owner 指定兼容版本与旧客户端截止后发布 data；回滚用更高 revision 的 v2 release。

`release-manifest.json` 当前锁定一个八家 candidate release 的 exact mapping、ruleset version 与 content
digest；这个 manifest 是一份待发布 artifact，不是产品范围或全局 completeness 定义。
`runtime-release.ts` 导出 annotation-free immutable payload 给后端 publisher。Greenhouse 的 v1/v3
path rule 明确指向同一 v2 immutable ruleset；Ashby、BambooHR、iCIMS、Lever、SmartRecruiters、
Workable、Workday 各登记一个 v2 ruleset。`INDEED_APPLY` 无 mapping，Avature 不进入本 release；
Workday/iCIMS/SmartRecruiters/BambooHR 的 policy 位在当前 default-off batch 固定 false。

静态 registry 的既有 10 个 non-null adapter 仍全部保留，其中 Rippling、Dover、Jobvite 尚未进入这份
candidate remote snapshot 不等于未开发或降级。Workday static adapter 仍为 null，完成 canary/registry
接线后才可能成为第 11 个；Avature 仍为 null 且没有进入本包。

runtime parser 的独立可发布基线只有 Ashby、Greenhouse、Lever、Workable 四家；BambooHR、iCIMS、
SmartRecruiters、Workday 是 recognized optional candidates。候选 mapping 未随某次 release 发布时，只让
该 provider exact lookup 返回 unavailable，不得连带关闭 Greenhouse；候选 mapping 一旦出现，仍与基线一样
执行 vendor、pathRule、ruleset reference、digest 与 dangling ruleset 的整包严格校验。

该对象只是 default-off 发布 scaffolding，不是 production authority。正式执行必须拿到后端 fresh
runtime bundle，并由 `apply-kernel/runtimeRegistry` 对收到的完整 release 重新验证、动态编译；缺少四家
baseline、stale、annotation 泄漏或已提供 mapping/ruleset 的 digest/mapping 漂移一律 fail closed。
`compileBundledAdapter()` 只用于
显式 local rehearsal 与构建期兼容性测试，不能作为 remote authority fallback。规则 payload、mapping
或 digest 任一变化时，后端发布者还必须单调增加外层 runtime bundle 的 `releaseRevision`；inner digest
变化不能替代 rollback fence。
