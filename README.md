# AI 网页工作台

先搭建可组合的通用 AI 工作台，再设计具体产品方向。网页包含文字、陪伴练习、Agent、语音、图片、视频、可审阅的浏览器操作、终端 harness 和多步工作流。求职伙伴仍是重点产品方向；原浏览器插件是未来可接入的执行端。

2026-10-06：开发 API、worker、网页、数据库及 CPU 模型服务已迁到 edaix-dev 的独立环境。Mac 的 http://localhost:4321 通过 SSH 预览，原本地数据保留并停写；当前 Codex 会话仍在 Mac，编辑与远端代码同步需明确执行。连接、验证、重启边界和回退见 [远端开发说明](docs/platform/remote-development.md)。本次是开发环境迁移，没有生产云部署。项目固定 Node 24.21.0、pnpm 11.13.1。

声音方向已确认：先专业训练本人的声音，目标是尽量逼近真人；短样本只用于筛选设备与风格。已准备 [本人声线录制手册](docs/platform/personal-voice-recording.md)，包含中英文试读、专业语料计划和独立验收句。ElevenLabs 已有语音合成接入代码，可通过服务端配置选择已有声线，并用于直接朗读、任务与工作流；协议测试和类型检查通过。尚未录音、购买套餐、上传、创建或训练声线，也未调用真实商业接口或验证其音质。远端仍使用 Kokoro 验证开发链路，ElevenLabs 未配置、付费调用关闭；配置与限制见 [语音接入说明](packages/ai-core/README.md)。

当前已实现独立网页、真实账户和数据保存、任务审批与 worker，以及多个供应商的接入代码。本地模型 Ollama／Qwen 已真实返回文字回复并调用部分 Agent 工具，独立 Kokoro CPU 服务已真实生成英文 WAV；Faster Whisper CPU 服务已真实转写虚构中英文音频，静音返回空文字。独立 GPU 验证已通过真实 SDXL 图片生成、音频审阅后聊天及简单像素理解；完整 Agent 的工具选择仍未全面通过，不能作为默认生产模型。商业模型调用仍关闭；实时通话、真实视频生成和本人声音训练尚未验收。协议测试使用虚构资料和本地测试服务。公开上线还需要计费配额、账户邮件送达验收、部署与运维工作。Openfield 是临时界面名称，项目名称和公开许可证待定。已建立 [public GitHub 仓库](https://github.com/mikeaccio666-debug/career-companion)，经过检查的活跃源码已发布；历史参考、私人环境和运行数据保留在本地，没有生产部署。

“我的资料库”支持按账号保存纯文本或 Markdown，编辑、删除、按正文关键词检索，并把选定段落的版本引用带入 Agent 草稿。Agent 通过只读工具重新读取私有原文；来源网址只作记录，不会自动抓取。真实数据库／HTTP与网页检查已经通过，独立 16K 上下文的 CPU Qwen 也完成一次实际工具读取与回答；默认 4K 模型曾失败，模型稳定性和响应速度仍待改善，具体验证范围见 [验证记录](docs/platform/verification.md#私有知识来源与-agent-引用)。蔓藤资料批量整理、组织知识共享和语义检索属于后续工作。

完整14工具的早期真实CPU Qwen规划验收，修复前后均为0／3：错误参数现在可得到受限反馈并续轮，空答案也会明确失败，但该模型尚未保存合格草稿。它目前仅作开发测试模型；真实生产模型质量、视频生成与本人声线仍需独立验收。该轮结果见[真实模型规划记录](docs/platform/verification.md#已安装开源模型的真实规划与错误恢复)，后续9B GPU与SDXL验证见[本地模型验收](docs/platform/local-model-qualification.md)。

新增 [MCP 外部工具接入](docs/platform/mcp.md)：服务器审阅目录、真实工具发现、账号授权、明确审批、worker 租约与私有结果读取。默认目录为空；没有连接 Gmail、蔓藤或真实外部工具，也没有执行生产迁移。用户先准备并审阅调用，结果可带回 Agent 草稿；已开始的未知调用不自动重放。

Agent 准备的任务现在 [持久关联原对话](docs/platform/conversation-tasks.md)：刷新后可查看最新状态、审阅当前版本的审批和读取已保存成果。结果引用可以保留原会话、文字草稿与附件，再由用户明确发送继续；普通聊天需要明确确认在本对话启用 Agent。对话任务独立分页，超过100条仍可浏览更早记录。主开发预览已应用016，迁移账本为001–016；目标计划017–019、人工核对020、worker心跳021及音频转写022仅在隔离环境验证，尚未更新主开发预览。生产环境未部署。

未知或受阻的执行结果可通过[人工核对记录](docs/platform/job-outcome-reviews.md)保存用户观察。记录固定到精确任务版本，与服务器成功回执分开；不会自动重试或推进计划。[运行健康检查](docs/platform/operations-readiness.md)分别检查数据服务与执行服务，网页可提示执行降级；真实上线环境、容量与备份恢复仍需单独验收。

本地英文朗读已在网页实际生成、播放并明确保存，刷新后历史仍可读取。另一个已审阅并批准的两步工作流，真实完成 Qwen 生成英文介绍→Kokoro 朗读，文字与音频均私有保存；390×844 的音频控件已复验。手机尺寸网页已实际导入虚构音频、保留原稿并转写，明确保存后刷新仍可读取；静音不新增文字。完整实时通话和真实麦克风录音仍待验收。

聊天附件增加独立的音频审阅入口：主动上传后保存私人原音频，明确转写、编辑正文并勾选确认后才用于聊天；模型收到审阅的文字，不收到原音频。历史可对照不可改写的原始转写。真实 Kokoro→Whisper→GPU Qwen 链路与网页点击、编辑后取消确认、刷新恢复已通过，375×812 布局没有横向溢出；这不是本人录音、真机或实时通话验收。结果与严格模型评分见[本地模型验收](docs/platform/local-model-qualification.md)。

创作页支持选择已保存的图片，继续修改图片或以图生成视频，也可复用工作流里已保存的图片。先准备带预览的参考草稿，再审阅并确认新的创作；原作品保留。参考图通过当前账号的私有附件通道交给模型，选择作品本身不会调用模型。具体支持由所选服务决定。

私有视频与音频支持按需分段读取，网页提供原生播放控件、读取失败提示及手动重新载入。离开播放页会释放媒体资源；下载请求中断后，服务端停止读取对应文件。读取作品仍需登录并校验所属账号。

终端、工作流和创作任务中已保存的文字成果可以带回 Agent 草稿，保留原文字和附件。选择成果只追加来源引用；发送后，Agent 再通过当前账号的私有读取工具获取正文。工具状态区分已返回、失败及结果未确认。

语音练习的完整文字与朗读草稿按当前登录和会话保留，切到聊天后可回来继续；保存进历史仍需明确选择。刷新页面或退出登录会清空临时草稿。ComfyUI 创作和工作流固定服务器模板版本及图片/视频类型；同类型、同服务器的既有任务使用创建时的私有快照。输出类型改变或旧任务缺少类型声明时，未完成任务需重新审阅；已完成成果仍可查看。输出检查核对实际图片格式或视频容器与视频轨道，不能用缩略图代替视频。

语音合成、录音转写与实时对话分别检查所选服务的能力和启用状态；未配置时按钮禁用并说明原因。后端不会把显式选择的其他服务悄悄替换为 OpenAI。Kokoro 当前仅提供美式英语朗读，OpenAI 提供另行配置的转写、TTS 与实时接口，商业调用仍关闭；浏览器听写独立于模型服务。

语音页提供温柔陪练、轻松职业搭子和清晰面试官三种交流角色；服务实际支持时可选声线、朗读表达与实时接话节奏。Kokoro 固定声线，不支持角色情绪指令；界面明确标注服务默认表达。回答保留发送时的角色，切换选择不会改写旧回答。选项随临时草稿保留，刷新不恢复；商业声音自然度与实时交互仍需试听验收。

## 启动通用工作台

需要 Node 24.21.0、pnpm 11.13.1 和 Docker。数据库只使用新的独立本地容器，不读取 Argoland 的环境配置。

项目用 `.node-version`、`.nvmrc` 和活跃包的 `engines` 固定 Node 版本。Mac／Linux 推荐用 `./scripts/project.sh check:platform`、`./scripts/project.sh build:web` 或 `./scripts/project.sh dev:platform` 执行项目命令；安装依赖可用 `./scripts/project.sh install --frozen-lockfile`。入口检查实际 Node／pnpm 版本，使用当前 PATH、项目 `.local/toolchain` 或已安装的用户工具链，只在子进程调整 PATH；缺少工具时给出提示，不自动下载或修改系统配置。

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm dev:platform
```

打开 [本地工作台](http://localhost:4321/)。首次创建本地账号；会话、明确保存的记忆、审批和任务属于该账号。API 监听 localhost4320，独立 worker 从队列取任务，PostgreSQL 和 Redis 分别监听 localhost5442、6388。停止开发进程用 Ctrl C；`pnpm infra:stop` 停止本项目容器并保留数据卷。

模型配置只放在后端。首次配置且 `.env.platform` 尚不存在时，将根目录 `.env.example` 复制为忽略的 `.env.platform`；已有该文件时只补充需要的配置，保留本地模型设置。填写自己的供应商配置后重启。商业请求还受 `PLATFORM_ALLOW_PROVIDER_CALLS` 控制，默认关闭。[ChatGPT 订阅与开发者 API 分别计费](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform)，接入前确认对应账户有模型权限和预算；不要在聊天、浏览器存储或源码中放密钥。

初次正式接入建议先使用 OpenAI 的文字 API，确认聊天体验后再启用语音与图片，视频另接 Ark／Seedance 或 fal。创建开发者 API key 的流程见 [官方快速入门](https://developers.openai.com/api/docs/quickstart)。在现有本地配置中补充 `OPENAI_API_KEY` 与账号可用的 `OPENAI_CHAT_MODEL`，然后重启。保留 `PLATFORM_ALLOW_PROVIDER_CALLS=0` 时不会发出商业请求；真实试用属于下一阶段，需要明确允许付费调用再开启。先用同一组虚构求职场景检查事实、工具执行、失败处理、首段等待时间与用量，再决定默认模型；不要仅凭模型名称或接通成功判断产品质量。正式账户设置预算与用量限制的依据见 [官方生产接入说明](https://developers.openai.com/api/docs/guides/production-best-practices)。界面的“已配置”只描述配置，真实账号权限和质量仍需实测。

网页和手机使用同一个后端：客户端发送对话，后端检查账号和权限、读取已选择的上下文，再调用模型并将流式结果返回。模型提出工具计划，执行器在获得所需审批后执行；接通聊天模型不会自动获得浏览器、电脑或第三方账户操作能力。API key 只放在服务端，符合 [官方密钥安全说明](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)。商业接口仍使用本地协议 fixture 验证，未开启商业调用。

本机还可以先用已经安装的本地模型验证文字和 Agent，不需要开发者 API key。本次已确认 Ollama 0.33.2 的云功能关闭，并接通 `qwen2.5:7b`；忽略的 `.env.platform` 已保留下面三个值。其他机器必须先确认自己的 Ollama 实例、已安装模型及本地模式，平台不会自动下载权重。这次真实返回只证明链路可用，求职建议质量仍需单独评估。[Ollama 本地兼容接口](https://docs.ollama.com/api/openai-compatibility)、[本地模式说明](https://docs.ollama.com/faq)

```sh
PLATFORM_ALLOW_PROVIDER_CALLS=0
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_CHAT_MODEL=qwen2.5:7b
```

本地英文朗读使用独立的 Kokoro 服务，不需要 API key。先安装 uv 和 Python 3.12，显式准备锁定的依赖与约341 MB资产，再在单独终端启动服务。准备会下载；启动和生成请求不会下载。完整要求、许可证与验证范围见 [本地语音说明](services/local-speech/README.md)。

```sh
pnpm speech:prepare
pnpm speech:serve
```

在已有的忽略配置 `.env.platform` 中补充以下三项并重启工作台，保留商业开关0。网页和任务 worker 经身份及任务校验访问此服务；朗读结果通过私有文件通道播放与保存。当前固定英语音色不提供录音转写或实时通话。

```sh
KOKORO_BASE_URL=http://127.0.0.1:8880/v1
KOKORO_TTS_MODEL=kokoro-82m
KOKORO_TTS_VOICE=af_heart
```

本地音频转写另用 Faster Whisper 服务。显式准备约78.2 MB固定多语言 tiny 资产，再独立启动；运行时不下载。服务限制20 MiB、120秒音频，一次返回完整文字而非实时流。网页可导入音频，原文件不会自动保存。短虚构样本通过不代表一般中文、口音、噪声或多用户质量。见 [本地转写说明](services/local-transcription/README.md)。

```sh
pnpm transcription:prepare
pnpm transcription:serve
```

已有 `.env.platform` 增加下列两项并重启，商业调用开关保持0：

```sh
FASTER_WHISPER_BASE_URL=http://127.0.0.1:8881/v1
FASTER_WHISPER_MODEL=whisper-tiny
```

```sh
pnpm check:platform
pnpm test:platform
pnpm build:web
```

平台测试需要上述本地 PostgreSQL 和 Redis；浏览器测试使用安装在本机的 Playwright Chromium。可用 `pnpm --filter @companion/ai-core exec playwright install chromium` 安装浏览器，不会下载模型权重。

- [31 个开源项目与商业接口调研](docs/platform/open-source-landscape.md)：聊天、陪伴、语音、computer use、harness、MCP 和视频，附许可证边界。
- [平台架构与接入状态](docs/platform/architecture.md)：数据、任务、模型与扩容分工，以及尚未完成的能力。
- [目标计划与精确结果](docs/platform/goal-plans.md)：保存原会话的顺序步骤、逐项审批及只读分析；可明确绑定前序分析全文、文字成果或私人参考图，准备任务时固定实际输入与来源快照。
- [本地验证记录](docs/platform/verification.md)：平台测试、官方 Codex 隔离执行、语音摘录、手机尺寸界面和真实浏览器任务的结果，以及未验证的部分。
- [网页说明](apps/web/README.md)、[API 说明](services/platform-api/README.md)、[执行器说明](packages/ai-core/README.md)。

手机布局已提供抽屉导航；PWA 使用 Vite PWA／Workbox 生成、完整性校验公开资源及提示后自然更新，离线新页提供公共连接入口。两版真实生产构建的离线／更新／失败保留旧版已通过本地 Chrome 验收，详见 [手机网页与 PWA](docs/platform/mobile-web.md)。对话、资料、语音和生成仍需联网；真机 HTTPS、安装、麦克风、键盘与 WebRTC 仍待设备测试。

## 求职产品与迁移背景

- [求职 Agent 基础架构](docs/career/architecture.md)：七个 skill、共享成长证据、知识库与执行端分工，以及从网页开始的实施顺序。
- [产品与学习研究](docs/career/product-research.md)、[知识与岗位接入](docs/career/data-integrations.md)、[旧模块复用审计](docs/career/reuse-audit.md)：官方来源、job-radar PR 和学习系统提取边界。
- [生产部署建议](docs/platform/deployment-plan.md)：Vercel／Render 的服务分工、独立 worker、数据与备份要求；建议尚未部署。
- [云部署决策与成本模型](docs/platform/cloud-decision.md)、[实际产品案例](docs/platform/public-platform-stacks.md)：托管／大云／VM区别，Higgsfield等公开资料，按真实使用估算费用与后续调整路径。
- [生产容器与部署配置](infra/platform/production/README.md)：独立 Web／API、worker 与迁移角色，可本地审阅；应用云端配置前仍需目标环境验收。
- [career-core](packages/career-core/README.md)：独立领域基础与11项测试；尚未接入求职 API、真实私库或完整运行层。
- [本人声音录音准备工具](services/voice-dataset/README.md)：离线检查私人 WAV、审阅并导出训练候选索引；不上传或启动训练。
- [当前产品假设](docs/product-brief.md)：F1 学生的“我不知道怎么开始”入口，以及代办与学习的关系。
- [架构与迁移报告](docs/architecture-migration.md)：目录职责、已完成的改造、接口漂移、UI 调整难度与尚缺的后端。
- [自动化执行方式](docs/automation-options-research.md)：插件、云浏览器、官方 API 与 Muse/Dots 的实际边界。
- [原审阅队列方案评估](docs/review-queue-assessment.md)：手机审阅、电脑执行，以及批量提交仍需新增的部分。
- [后端迁移审计](docs/backend-migration.md)、[验证记录](docs/migration-verification.md)。
- [聊天底座调研](docs/research-2026-09-30.md)：Vercel Chatbot、LibreChat 等；这些聊天底座尚未在本项目安装。

## 原插件本地使用

需要 Node 24.21.0、pnpm 11.13.1。根 workspace 只包含 `apps/`、`packages/`、`services/`。

```sh
pnpm install --frozen-lockfile
pnpm preview:extension-ui
```

打开 `http://127.0.0.1:8871/`，可切换欢迎、资料对话、岗位和填写演示。`profile.html`、`session.html` 是独立资料与会话预览。**所有演示使用虚构资料，不连接模型或真实账号。**详见 [UI 说明](apps/extension/assistant/README.md)。

```sh
pnpm build:extension
pnpm build:extension-ui
pnpm dev:application-service
```

插件产物：`apps/extension/.output-local/chrome-mv3/`，默认 localhost API3000／网页3100，真实页面写入、签名执行与遥测关闭。未提供完整登录和投递后台，加载产物不会使它成为可用投递产品。旧发布构建已停用。

独立服务监听 `http://127.0.0.1:4310`，只有 `/health` 和 `/api/v1/automation/rules-release`。它是只读参考服务，不充当插件所需的3000端口业务 API；签发、claim、档案和回执路由没有实现。见 [服务说明](services/application-service/README.md)。

```sh
pnpm check
pnpm test
```

最终类型检查、构建、功能与安全测试通过；原内核性能基准曾在并发负载下失败，单独运行通过。完整执行情况见验证记录，不宣称最终整次 `pnpm test` 全绿。

## 源码来源

插件源 `edaix-official/argoland-extension`：1,437 tracked 文件中迁入1,434，3个历史运行数据 JSON 明确省略；实现文件无遗漏。后端源 `edaix-official/argoland`：保留1,712个参考文件、33项明确省略；另保留旧网页插件桥接及静态依赖闭包256文件。

来源 commit、每个文件的 hash、改造前参考与省略原因分别见 `imports/extension-reference/migration-manifest.json`、`imports/argoland/migration-manifest.json`、`imports/argoland-web/migration-manifest.json`。`imports/` 不参与运行；旧源码、配置、说明不能作为新产品部署指令。

源后端标记 `UNLICENSED`，部分人物和图标资产的公开使用来源还需明确；当前没有为复制源码指定新的公开许可证。本地原仓未改动。
