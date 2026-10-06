# AGENTS.md — 扩展执行适配器

本目录迁自 argoland-extension。架构与契约归本项目根 AGENTS.md 管理；下方保留源代码运行安全约束与历史说明。
旧仓的产品名、批准日期、发布记录只描述来源，不能视为本产品已经获得生产放行。
修改 UI 可独立于内核；不得因此绕过授权、用户真实点击、隐私、写策略与 fail-closed 检查。

<!-- BEGIN:D5-SCOPED-RULES -->

## RULE-EXTENSION-DOM-BOUNDARY · 宿主 DOM 知识边界

宿主站点选择器和 DOM 知识只能存在于 packages/apply-rules 的数据与 apply-kernel 的解释器；Extension UI、channel 和业务组件不得携带或泄漏站点选择器。

## RULE-EXTENSION-NEVER-SUBMIT · 写入与恢复按声明模式隔离，submit 只在用户按下浮层「提交」之后

2026-09-05 fill-first 路径冻结产品 Undo 与自动恢复；该路径不以 Undo 作为填表准入条件，仍须验证 exact target、权威答案、当前授权、readback、host validation 与 late recheck。写后失败以稳定原因和 MAY_HAVE_CHANGED 如实交还用户检查宿主页面，不清空页面；以下 journal／compensator／Undo 规则仅约束冻结的 legacy 恢复实现，不要求新 fill-first 路径接入它。对宿主页面的通用写入只可触及表单控件 value、selectedIndex、checked、files 并派发必要事件。唯一窄例外是 CAP-AF-004 专用 plain-text contenteditable primitive：必须同时具备受信 apply-rule 的 exact attrMap attestation、reviewed plan、direct 有效 contenteditable、纯文本结构、真正空目标（childNodes.length === 0）和当前 target identity；textContent 不得进入 generic property allowlist。写前由 journal 私有封存 exact node、ownerDocument、trusted ScanRoot、attestation、signature、label、空 prestate、mutation witness 与 trusted-user-edit epoch；写后 exact readback。唯一结构恢复例外只可由同一 transaction 的私有 compensator 恢复该封存空态，不接受调用方 HTML、节点、markup 或任意恢复值。必须重验 exact subtree receipt、原 attempted text、无用户后续编辑、无 detach/reattach、target/root/label/signature/attestation 漂移；当前只接纳同一次写入产生的无属性单 span 包裹单 Text 的 inert normalization，不开放 structured editor。同步补偿仅可使用仍有效的本次 Fill authority；microtask/C6/late 阶段不得后台写入，之后仅可由用户显式 Undo 与 fresh purpose=undo/set-richtext authority 触发一次性恢复。每次 setter 前再验全部 proof，settled semantic readback 成功后才清 journal；失败保留稳定失败记录，不重封存未来删除用户内容的权限。除该 transaction-bound 空态恢复外禁止结构节点增删；禁止 innerHTML、outerHTML、insertAdjacentHTML、execCommand、任意 markup、属性／样式修改、任意脚本；不绕过敏感分类、用户授权、policy、lease、runtime ceiling 或 Submit fence。私有 witness 与 Data-L1 不进入日志、错误、遥测或截图提交。不得自行决定替用户点击 submit：唯一例外是根 AGENTS.md 的 RULE-EXT-NEVER-SUBMIT（用户在我方浮层里按「提交」的那一次真实点击、写能力位 `submit-application`、只按规则声明的 `finalSubmitControl`，经 `lib/submitController.ts`）；任何写入原语、计划或自动流程都不得触发提交。

## RULE-EXTENSION-HUMAN-AUTHORIZATION · 敏感动作与实质授权由用户操作

Extension 对 pending sensitive proposal 每项初始必须无选择；dormant UI 只可返回本地 value-free promptItemId/decision，禁止接受或输出 backend confirmation/digest、credential ref、secret 或本地 mint authority。只有 production facade 私有绑定后端 durable per-item release、原 tab fresh revalidation 和逐项 current runtime ceiling 后才可形成 decision request。OTP／2FA／CAPTCHA、人机验证及混合／未知控件继续人工；营销等同意类与联系现任雇主只按下方例外代填、代答。密码只可来自 origin-bound 本地加密凭据库，绝不得进入 API／JWS／通用 bridge／receipt／日志。完整 final convergence 前能力位和 operator gate 固定 false。

例外（2026-09-23，2026-09-24、2026-09-28 两次扩大，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION）：条款同意、属实声明与签名；2026-09-24 起的 AI 面试记录／转写同意、申请相关短信、日后联系与人才库、营销信息、背景调查授权、仲裁协议；2026-09-28 起的招聘用途的资料处理与分享（招聘服务商、ATS、关联或集团公司）、核实所填信息（含 E-Verify）、背景调查其余几种（信用、药检、驾驶记录、社交媒体、定期复查）、at-will、同一份仲裁协议里的集体诉讼与陪审团弃权、AI 分析或评估面试录音、申请相关的电话与 WhatsApp 通知、集团公司日后联系、只有标题的隐私声明、只由放行类别组成的混合——在「运行时包放行 `sign-on-behalf` ∧ worker 读到用户在资料页同意过当前文案版本」时由内核代填，不经逐项 decision request。勾选框是一句话（2026-09-28），每一类写在 argoland 隐私政策里版本号与同意书相同的那一节（浮层的「隐私政策」点开它）；范围一改两者一起升版本，只有当前版本的同意算数，旧版本的同意不覆盖新加的类别。内核按 `SIGNING_CONSENT_KINDS` 放行、runner 写前按类别再核；读不到同意、版本不对一律当没同意。没同意当前版本、也没撤回过的，浮层一张卡请他一键同意（同意那一下当场验是我们 shadow 里的真实点击；暂不就什么都不改）。能不能联系现任雇主按资料里「可以联系你现在的雇主吗？」的回答答（只问以前的雇主或推荐人的题照同一个回答；没答交还本人），不看同意书，同样要 `sign-on-behalf`。出售资料或为营销分享、生物特征、免责／不追责／赔偿、竞业／不招揽／保密、医疗健康与残障信息、没有列明或混进这些的授权，仍交还本人。浮层逐条写明「已替你…」。

例外（2026-09-28，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION 例外三）：替用户在招聘网站上注册账号、登录，只在「运行时包放行 `account-access` ∧ worker 读到他同意着当前版本的代填授权（那一句写明「并替我注册、登录招聘网站」；`signingConsentCoversAccountRegistration`，只有当前版本算数）∧ 这一家的规则声明了账号墙（`accountSteps`）」时。本地加密凭据库只在 worker（`lib/accountVault.ts`：storage.local 里只有 AES-GCM 密文，不可导出的密钥在扩展自己 origin 的 IndexedDB；退出 ArgoLand 整份删掉，换了 ArgoLand 用户也作废）；共用密码没有就在第一次交出时生成（`lib/accountPassword.ts`）。worker 只在发信人是我们自己的内容脚本、这一页正是声明了账号墙的那一家的申请页或账号页、两把钥匙都在时交出邮箱与密码（`lib/accountAccessProvider.ts`，这里没有任何网络调用）；消息只在 worker 与内容脚本之间走（`lib/accountAccessIntent.ts`），不进 API、JWS、通用 bridge、receipt、日志与诊断。内容脚本只在用户按下浮层里的「注册并自动填写」「登录并自动填写」（或卡上「用这个密码登录」「我已验证，继续」）那一下之后要一次，写进规则声明的那几格就不再留（`lib/accountAccessController.ts`）；整套只在 `showFace` 里建（`lib/accountAccessPage.ts`），Assistant 构建里是死代码。某一家自己的密码由用户在我方关着的 shadow 里输（输入框的按键不往网页上冒）。验证码、人机验证、邮箱验证链接、单点登录、账号被锁、重设密码仍交还本人：浮层照实说要他做什么，他过了关才接着走。浮层逐条写明「已替你在…注册账号」「已替你登录…」「已替你同意…注册所需的网站条款」。

例外（2026-10-04，见全局 RULE-GLOBAL-HUMAN-AUTHORIZATION「邮件里的验证码」）：网站把验证码发到申请人的邮箱、要他填进这一页时，验证码由用户在我方浮层那张卡上自己输入或粘贴。`lib/verificationCodePage.ts`（只在 `showFace` 里建，Assistant 构建里是死代码）看着这一页、把规则声明的提示交给浮层；他按「填进网站」，在那一下真实点击里当场取证，用这一页的只读授权与写策略（整体、这一家、`set-text`）再认一次规则声明的那几格（`readRuntimeEmailCodePrompt`），铸一张只有 `set-text` 的票，经内核 `write/emailCode.ts` 写入。不读邮件、不经 worker、不进任何回报与诊断；写完不提交。提交控制器只经挂钩问「网站在不在要验证码」：提示在、没填满时不按，按了之后提示冒出来或网站新说一句「验证码不对」就交回 `CODE_REQUIRED`，浮层换成那张卡。

## RULE-EXTENSION-FAIL-CLOSED-RELEASE · 远程开关与商店包门禁

高风险能力默认关闭且 fail closed；远程开关必须有可验证取数通道。正式发布必须验证 store build 产物、窄 host registry、kill policy、版本与 hard-expiry；开发构建或单测绿不得解释为 production 已放行。

<!-- END:D5-SCOPED-RULES -->
