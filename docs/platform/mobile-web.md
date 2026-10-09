# 手机网页与 PWA

网页以响应式 Web 和 PWA 为第一入口，共用现有账号、聊天、语音、资料和可审阅任务接口。2026-10-06 已完成公开界面的离线入口、构建版本校验、温和的更新提示及桌面 Chrome 浏览器验收；真机安装、HTTPS 麦克风和 WebRTC 仍待设备测试。手机上的任务审批继续遵守平台授权，不能替代插件需要的可信点击。

## 构建方案

采用维护中的 `vite-plugin-pwa` **2.0.0** 与 Workbox `generateSW`，锁定 `workbox-build`／`workbox-window` **7.4.1**。实际使用 Node **24.21.0**、Vite **8.2.2** 完成类型检查和生产构建，兼容性以锁文件及实际检查为依据。原手写 `public/sw.js` 已移除，新的固定 `/sw.js` 由构建生成；Workbox runtime 内联，不依赖运行时 CDN。配置与校验分别在 [vite.config.ts](../../apps/web/vite.config.ts) 和 [pwa-build.ts](../../apps/web/pwa-build.ts)。

构建读取 Vite 实际 `root`／`outDir`，只允许固定公开文件和带内容指纹的 JS、CSS、图片与字体。重复路径、query、外部 URL、私有路径、符号链接及缺少必需文件都会使构建失败，防止遗漏过大 bundle 后仍生成“可离线”的清单。每条预缓存记录均附上文件字节的 SHA-256 `integrity`，HTML 也检查；哈希 bundle 使用文件名版本，固定路径使用构建 revision。Workbox 安装时按此 integrity 获取资源，缺资源或实际字节不符使新版安装失败，旧版继续工作。[Workbox 预缓存与 integrity](https://developer.chrome.com/docs/workbox/modules/workbox-precaching)

这解决安装阶段收到 A 版 HTML、B 版 bundle 的混用问题。校验范围是预缓存资源获取，未覆盖 service worker 脚本自身或它执行前的 `importScripts`；上线仍须保证部署产物一致。独立静态服务对 HTML／`sw.js` 使用 `no-cache`，内容指纹资源使用长期 `immutable`，其他公开文件要求重新验证，详见 [static-web.ts](../../services/platform-api/src/static-web.ts)。

2026-10-06 PWA 阶段普通构建的 **12 条／700.11 KiB** 清单如下；指纹文件名随后续构建变化，列表是该阶段快照：

```text
index.html
mark.svg
manifest.webmanifest
pwa-legacy-cleanup.js
icons/icon-192.png
icons/icon-512.png
icons/maskable-512.png
icons/apple-touch-icon.png
assets/workbox-window.prod.es5-Bd17z0YL.js
assets/virtual_pwa-register-YTNlueIS.js
assets/index-DfGilTcS.css
assets/index-CklaSCN4.js
```

PNG 提供192／512标准图标、独立512 maskable 图标及180 Apple 图标，沿用现有 SVG 图形。提供这些资源不等于已通过 iOS／Android 安装验收。

## 私有数据与离线入口

产品 CacheStorage 只保存上述公开构建资源，没有 runtime cache、后台写入队列或请求重放。API、认证、知识来源、聊天、上传、语音和媒体都不进入此缓存。导航 fallback 只匹配无 query 的 `/` 与 `/index.html`；Workbox 默认还允许 `/index` 作为公共 HTML 的别名。`ignoreURLParametersMatching: []` 保留全部 query，带 token 或其他参数的 URL 不匹配预缓存或导航 fallback，不会被转换成产品缓存键。

成功安装离线入口后，离线新开页面展示公共连接入口；无法确认账号时不以缓存的私人内容恢复工作台。恢复网络后，用户点击“重试连接”重新读取账号与服务状态，不自动发送消息、重试任务或提交申请。这个策略限定的是产品 CacheStorage；它不承诺清空普通浏览器 HTTP 缓存或已打开页面的内存。账号接口与私人内容继续遵守原有鉴权和响应缓存边界。

## 跨窗口账号与私人资源

共享 Cookie 可能在另一扇窗口登录后改变，旧页面仍保留原账号的界面。因此私人请求现在携带固定账号断言：普通 HTTP／SSE 用 `x-companion-account`，原生图片、音视频和下载的 uploads／artifacts 字节 GET／HEAD 用 `expectedAccount` query。UUID 是窗口预期账号，不是认证令牌；服务器仍先验证 Cookie，再比较账号并检查文件所有者，缺少或不匹配时返回409，错误格式返回400，匿名返回401。私人 URL 不进入 PWA 缓存；匹配断言也不授权其他用户的文件。

组件树和每个异步操作持有固定的 `accountId + generation` 客户端，不能把旧 A 组件静默改绑到新 B。换号或同账号新登录使旧代次失效，中止请求／SSE并丢弃迟到正文；旧图片移除来源，原生媒体暂停、移除来源并重置解码，成果文本清除，语音结束 RTC、录音、轨道和播放。迟到的语音租约释放仍绑定 A；Cookie 已是 B 时服务器拒绝，不释放 B 的资源。外部 Realtime SDP 不携带平台 header。

BroadcastChannel 与 storage 备选消息仅通知 `authChanged`，收到后清空私人状态、回到公共连接入口；不从通知获取身份、不自动重新登录或重放请求。用户明确点击“重试连接”才由 `/auth/me` 确认当前真实账号。通知不可用时，每请求断言仍守住服务端账号边界。实现与验证范围见 [架构](architecture.md#从本地走向多用户服务) 和 [账号验证记录](verification.md#跨窗口账号断言与旧资源清理)。

## 更新与旧缓存

注册采用 `prompt`，`skipWaiting: false`、`clientsClaim: false`。网页丢弃注册函数返回的强制更新方法，不发送 `SKIP_WAITING`，也不自动刷新其他页面；新版安装后自然 waiting。提示要求用户“先保存或复制需要保留的内容，结束录音或对话，再关闭所有工作台窗口重新打开”。草稿仍在当前页面内存，关闭窗口前需要用户自行保存或复制。联网且页面可见时，每小时检查新版，连接／可见性恢复也受同一间隔约束。[Vite PWA 更新提示](https://vite-pwa-org.netlify.app/guide/prompt-for-update)、[Service Worker 生命周期](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

当前 Workbox 缓存命名为 `openfield-precache-v2-<registration.scope>`，自然激活时仅从自己的 precache 删除不再属于新版清单的条目。`cleanupOutdatedCaches` 关闭；额外兼容脚本只在没有同源窗口时删除确切旧名 `openfield-shell-v1`，检查包含未受控窗口，有任何窗口便保留、等待后续自然激活。外部命名空间不清理。这一策略依赖正常 waiting 生命周期，不承诺保护任意第三方脚本强制接管或删除缓存的行为。

## 本轮验收与下一步

PWA 阶段网页完整 **236／236** 测试通过，含新增8项构建及11项运行层测试。真实 Chrome 在 localhost:4391 使用五个隔离 session：核心 A／B 与两种安装故障分别使用三个 profile，另外两个用于布局诊断和最终源码验收。A／B 是两个私有、实际 Vite 生产构建，B 只加入虚构 HTML 标题、main 标记与 CSS 标记来产生不同指纹；浏览器逐一核对新版12份缓存资源的 SHA-256。核心 A／B 验收在最后的文案／CSS修正前完成，修正后的最终实际生产构建另行完成390×844布局验收。具体故障与布局结果见 [验证记录](verification.md#pwa-离线入口与自然更新)。该阶段没有调用模型／真实媒体服务、使用真人麦克风、修改主库或远端开发实例、部署产品。

已通过的关键场景包括：A 离线新页与显式联网重连；两扇旧 A 窗口保留各自草稿、B waiting 提示两窗可见；关闭全部同源窗口后自然切到 B 并离线打开；新版 JS 503 和新版 HTML 被旧版 HTML 200 替换均导致安装失败、旧版离线可用；私人接口、媒体故障 fixture 和带 token 的入口不进入产品缓存；旧 v1 sentinel 删除而其他缓存 sentinel 保留。

下一轮在目标 HTTPS 环境用真实 iPhone Safari 和 Android Chrome 检查安装／重新启动、麦克风容器实际解码、权限拒绝／取消、WebRTC、软键盘与 safe area、慢网和断网。录音或播放在切后台、`pagehide`、锁屏时如何暂停／结束／恢复，需先作独立 UX 决策，再做系统中断验收。现有390×844桌面视口和合成录音证据均不能替代这些检查。

PWA 阶段从源码发现的跨窗口账号漂移风险已由上述新方案覆盖。当前网页完整 **273／273** 测试、生产构建及真实 Cookie 的 HTTP 集成通过；本轮真实Chrome跨账号双窗、旧图片移除、合成SSE取消及显式重连通过；关闭BroadcastChannel时storage备用通知有效，完全无通知时旧A写请求在B Cookie下被409拒绝，随后清空页面。音视频及真实认证响应乱序仍需对应场景验收。历史两窗同一虚构账号的 PWA 验收也不证明账号隔离。当前主 JS **581.91 kB／gzip 178.43 kB** 仍触发 >500 kB 构建提示，后续按实际首屏网络与交互表现评估拆包。当前成果是可维护的生产构建层与有限验收，公开上线仍需 [部署与运维验收](architecture.md)。


## 2026-10-08：按界面加载代码

按 09 第 4 步，App 的 25 个求职页面和内部工作台面板改为 `lazyFeature` 包装的动态导入。账号入口、账号窗口 Provider、安全资源和现有权限判断保持原位置；动态模块只在实际渲染该界面时请求。缓存的是代码模块，不缓存 props、账号或私人响应。每块界面有自己的 Suspense / 错误边界，不用整页刷新恢复；等待超过八秒显示失败，用户可以手动重试。迟到模块不会重新打开已经关闭的界面，重新打开可以使用已成功加载的代码。

构建输出 `.vite/manifest.json` 供核对真实静态/动态依赖。对比上批 `b0f884f` 的生产构建：主入口由 731.35 kB 降至 308.16 kB；加上入口所有静态 JS 依赖后为 **463.59 kB / gzip 合计 144.24 kB**，相对旧单入口约减少 37% / 30%。数字来自构建产物，不是设备耗时或真实网络计费。25 个目标模块均不在入口静态闭包内；浏览器加载实际生产公共入口、后端用固定 503 的隔离检查中，仅请求静态闭包与 PWA 注册代码，未请求这些功能块。

**安装总量没有减少**：当前仍对全部带指纹的静态资源做完整性预缓存；清单由上一批 13 条 / 934.17 KiB 增至 85 条 / 1292.69 KiB，全部 JS 合计约 1090.43 kB。拆包改善入口解析范围，但增加完整安装体积与请求数量，后续仍需评估共享块与预缓存策略。本次不改运行时缓存、waiting 更新流程或私有接口边界；当前 cacheId 是 `companion`，上文 `openfield-*` 为历史阶段名称。构建没有单块超过 500 kB 的提示，不等于已通过真实设备性能验收。

806 项 Web 检查通过（新增 3 项），类型检查及实际生产构建通过，现有 PWA 完整性与更新策略回归包含在内。真实浏览器对实际 `lazyFeature` 和目标方向组件注入虚构加载故障：按需调用、手动重试、保留旁边未发送文字、等待时关闭、迟到后保持关闭、重新打开复用代码、无写请求均通过。生产入口 smoke test 的后端 503、离线 worker 不可用是隔离服务的已知条件，不冒充成功登录、完整新版 PWA 安装或真实 API E2E。本批不改变学生轮次开工门，不调用付费模型、不更新主预览、不部署；真机、主理人对话和完整 P0 验收仍待完成。
