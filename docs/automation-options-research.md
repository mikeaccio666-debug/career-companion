# 求职自动化执行方式调研

调研日期：2026 年 10 月 5 日。本文区分已核实的产品事实与对新产品的设计建议；未测试现有 Argoland 插件的实际成功率。

**结论：自动化不一定需要插件，电脑端填表插件仍是一条值得保留的路线。**产品可以组合官方 API、云端浏览器和本地插件。一个普通聊天网页不能直接读写用户在其他网站打开的页面；同源限制会限制跨网站脚本访问。后端可以另外运行浏览器，但那是另一套浏览器会话。[MDN 同源限制](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)

## Muse 和 Dots 怎样执行操作

**已核实：**Meta Muse 给用户提供独立云端虚拟机，包含浏览器、文件和运行环境；连接第三方服务时使用 API，浏览网页时使用专门的浏览器 agent。其浏览器通过独立 broker 管理，agent 读取可访问性树；凭据储存在独立安全区域，用户接管时暂停 agent。因此，这套云端代办能力不依赖用户安装 Chrome 插件。[Meta 技术说明](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

Muse 的设计还包含后台任务、活动记录、目标进度和结构化确认界面。这些是产品系统的一部分，不能靠一个聊天框或大模型自动获得。[Meta 产品设计](https://introducing.muse.ai/)

**已核实：**OpenAI Dots 同样有自己的云端电脑和浏览器，用户电脑关机后云端工作仍可继续。它不会继承用户本地网站登录；用户须在云端独立登录并完成验证码等验证。它也能连接个人电脑，但执行本地任务时，电脑必须在线且 ChatGPT 应用保持打开。手机可以发指令，不代表操作发生在手机上。[OpenAI Docs Dots 电脑与应用](https://learn.chatgpt.com/docs/dots/computers-and-apps)

**已核实：**OpenAI computer use API 提供模型决策和操作请求；开发者仍须提供浏览器或桌面环境、实际执行点击输入、返回截图、保存会话并检查结果。模型能看截图，不等于它已经获得执行权限或拥有浏览器。[OpenAI Docs computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

## 四种执行方式

下表的适用性和成本判断是设计推断。

| 方式 | 适合的求职任务 | 登录和设备边界 |
| --- | --- | --- |
| 官方 API 集成 | 已授权的邮箱、日历、文件操作，以及开放 API 的岗位信息 | 使用服务授权；后端可持续执行，手机只需使用产品网页。API 没开放的动作无法凭空完成 |
| 云端浏览器 | 在支持的网站上搜索、导航、多步填表 | 单独登录；需逐用户隔离会话和凭据，可在用户关机后执行；有运行成本和网站封锁风险 |
| 本地浏览器插件 | 用户已登录的申请页面，识别字段、填资料、显示核对结果 | 在获得站点权限的本地页面执行；主要面向电脑，浏览器和设备须可用 |
| 本地桌面 agent | 浏览器之外的软件、系统文件和跨应用操作 | 需安装本地程序及系统权限；电脑须在线；开发、发布和权限管理更复杂 |

API 的重要例子：Greenhouse 公开岗位查询不需要认证，但直接提交申请需要 Job Board API key，该 key 由招聘方的 Greenhouse 管理界面创建。**推断：求职者能看公开岗位，并不意味着我们的产品有权通过这个 API 向任意雇主投递。**[Greenhouse API](https://docs.greenhouse.io/job-board.html)、[创建 key 的权限](https://support.greenhouse.io/hc/en-us/articles/13446638483355-Create-a-job-board-API-key-for-an-integration)

插件的 content script 能读写获授权页面 DOM，通常在隔离的 JavaScript 环境运行。桌面 agent 则能在支持的目标应用中操作窗口和键盘；这是需要用户授权的另一层能力。[Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[OpenAI Docs 桌面操作](https://learn.chatgpt.com/docs/computer-use#safety-guidance)

## 手机和后台工作的边界

不能承诺现有 Chrome 插件直接支持所有手机。Google 的手机安装说明实际是 Add to Desktop，下次在电脑 Chrome 启用。iPhone Safari 支持自己的扩展，但需要对应的 Safari 分发、权限和兼容性适配。[Google 扩展安装](https://support.google.com/chrome_webstore/answer/2664769)、[Apple Safari 扩展](https://support.apple.com/en-ie/guide/iphone/iphab0432bf6/ios)

MV3 service worker 会因闲置而终止，不能当作永久运行的任务服务器；任务状态须持久化并支持恢复。[Chrome 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

**建议：**手机承担聊天、演练、资料准备、进度查看和确认；云端执行支持的任务。电脑插件补充本地已登录网站上的填表能力。手机控制电脑插件的任务，也仍要求那台电脑和浏览器在线。

## 有插件也不能保证完成的部分

- **CAPTCHA、2FA、网站封锁：**任何执行方式都不能保证无人介入。Dots 官方说明有的网站会阻止云浏览器或要求额外验证；我们的任务应暂停并请求用户接管，不能把插件包装成绕过验证的方法。[OpenAI Docs 登录边界](https://learn.chatgpt.com/docs/dots/computers-and-apps#staying-signed-in)
- **跨域 iframe：**顶层页面脚本不能任意读取跨域 iframe。扩展可以向匹配且获授权的 frame 分别注入脚本，须正确设置 all_frames、匹配范围和通信，不能只扫描顶层 DOM。[Chrome frame 说明](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#specify-frames)
- **自定义组件和动态表单：**可见文本框可能还涉及组件状态、事件、异步校验和页面切换。工程判断：须用站点适配和实际测试验证，不能把“写入 value”计作成功申请。
- **文件上传：**网页脚本不能用一个本地路径设置 file input。插件需要用户选择文件或取得已授权的文件内容并实现对应适配；云浏览器需要文件在其环境中可用。Playwright 支持从路径或内存上传，具体产品是否提供此能力须单独核实。[MDN file input](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)、[Playwright 上传](https://playwright.dev/docs/input#upload-files)
- **提交和敏感答案：**技术上能点击不等于应该自动提交。建议首次版本在投递和向他人发送消息前展示具体内容供用户确认。工作授权、身份等答案须来自用户确认的事实；敏感字段可能输入即自动发送，确认边界不能只放在最后一个按钮。[OpenAI Docs 操作确认](https://developers.openai.com/api/docs/guides/tools-computer-use#run-safely)

## 对新产品的建议

将插件保留为一个可替换的执行端。职业档案、材料、任务状态和审批记录放在产品核心；网页、插件、未来的云浏览器通过清晰接口共享它们。插件主要负责页面识别、执行和验证，避免再次承担完整业务后端。

先把“填写用户已打开的申请表，显示未完成项，用户核对后提交”做可靠，再逐站点评估云端代办。不要第一版就承诺任何网站、手机和关机后都能自动投递。迁移后仍需真实网站验证、运行成本估算和凭据隔离设计；本调研不能替代这些检查。
