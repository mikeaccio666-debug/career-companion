# 平台 HTTP 安全响应策略

落实产品 13 §4.2；真实云端 HTTPS、代理和发布验收仍待完成。

`security-headers.ts` 生成启动时固定的响应策略，`configurePlatformHttp` 在路由、CORS 预检和鉴权之前设置。覆盖 HTML、静态资源、API、404、应用错误与预检；SseTurnSink 原有的 header 复制让被 hijack 的流式回复也保留这些头，不增加缓冲或改变取消语义。私有文件和印章图片继续用自己的 `default-src 'none'; sandbox`，全局策略不覆盖它们。

- CSP 默认拒绝资源，只允许同源构建脚本、样式、字体、manifest 和 worker；不允许内联脚本、eval、object、frame、base 或嵌套承载页面。保留 08 §3 与当前 CSS 使用的 Google Fonts 样式及字体两个固定来源。
- 图片允许同源、data 和 blob；音频／视频允许同源和 blob，保留私有媒体及本地录音预览。只有明确配置 realtime 的 OpenAI 路由时，连接策略才增加既有协商地址 `https://api.openai.com/v1/realtime/calls`；这不是声线或实时能力的启用授权。
- `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 全站生效。Permissions Policy 关闭相机、位置、支付、USB，麦克风只保留同源，实际录音仍需本人和浏览器授权。
- 生产配置的 secureCookies 为真时发送 `Strict-Transport-Security: max-age=15552000`；不包含 preload 或 includeSubDomains。开发 HTTP 不发送此头，不采信请求的 Host、Origin 或 X-Forwarded-Proto 来扩大策略。
- 不设置 CSP 上报端点，避免自动上传可能含私人路径的报告；当前没有新增遥测。

## 网页与 API 分离

同源生产拓扑不用设置 `PLATFORM_WEB_API_ORIGIN`。若由本 API 进程提供的网页构建绑定了另一 API origin，则此服务端变量须与公开的构建配置 `VITE_PLATFORM_API_ORIGIN` 一致。它只加入 connect/img/media，不允许那个 API origin 承载脚本，不代替 CORS、窗口账号或鉴权；`PLATFORM_ALLOWED_ORIGINS` 仍表示允许调用 API 的网页来源，二者不混用。

只接受无路径、凭据、查询、片段或 CSP 分隔符的精确 HTTPS origin；开发允许字面 loopback HTTP。未设置或空字符串表示同源，其他无效值使启动失败且不回显输入。服务器代码不能从用户输入或响应正文选择这个地址。

若网页由 Vercel 等独立主机提供，本服务的响应头不能替那个 HTML 主机配置策略；必须在该网页主机落实对应策略并验证实际构建地址。此批没有操作任何云端控制台或部署。

## PWA 与发布

HTML 同时增加 `no-referrer` meta，作为文档层的相同策略，并改变本次外壳内容与 Workbox precache revision。新的缓存 HTML 会保留服务端 CSP 和 Referrer-Policy。既有窗口仍遵循现有“等待更新、结束工作后关闭所有窗口再重开”的流程，不强制激活 worker、刷新页面或丢弃草稿。已缓存的旧响应不会被服务端头改动追溯更新；后续仅改变 header 的发布也必须核对外壳版本和真实更新路径。

## 验证（2026-10-09）

- 40 项 API/配置/静态资源/CORS/私有文件检查通过，包含真实 PostgreSQL、真实密码会话 HTTP、带私有文件 Range 的既有回归、304，以及完成前能读到首个事件的真实 SSE。
- 24 项 Web endpoint/PWA 检查通过；平台 API 类型检查、网页类型检查及生产构建通过。
- 隔离真实后端、虚构账号、实际生产构建的 Chromium：注册入口正常呈现；密码登录进入初见页；字体加载成功；正常流程 CSP violation 为 0；390 与 1440px 无横向溢出，截图已查看。
- 浏览器确认私有用途的本地 blob 图片可以解码、合成 WAV 可以读取时长；未采集麦克风或调用供应商。实际 fetch 不发送 Referer。
- 注入的内联脚本未运行，外站脚本被 CSP 阻止。独立 loopback HTTP 页面尝试嵌套应用，浏览器明确报告 `frame-ancestors 'none'` 并以 `ERR_BLOCKED_BY_RESPONSE` 拒绝；没有把 about:blank 场景的 Chromium 本地网络拒绝误算为此项通过。
- 实际 Workbox 缓存的 index.html 含 CSP 与 no-referrer 头。未新增 API 或私人正文缓存。

这些检查不代表真实 Render HTTPS/HSTS、跨站部署、完整 Safari/Firefox、声线质量、主对话或生产发布已经通过。没有付费调用、主数据库迁移、主预览重启或部署。

策略语义参考：[CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)、[HSTS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security)、[Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy)；具体通过范围以上述真实验证为准。
