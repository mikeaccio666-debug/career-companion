# 全能网页 AI 底座：开源项目与商业能力地图

核查日期：2026-10-05至2026-10-06，America/Los_Angeles。目标是先构建可持续扩展的网页能力底座，再设计陪伴、求职或创作产品。

## 结论与选型方向

现成项目已经覆盖聊天、多模型、陪伴、语音、浏览器操作、代码执行和视频生成。适合我们的方法是保留一个自己的产品外壳、账户与任务系统，将这些能力接入同一套可观察、可审阅的运行流程。多个完整产品的数据库、登录和执行引擎一起 fork，会增加后续 UI 和工作流调整成本。

建议优先组合：自有 React/Next.js 页面 + AI SDK 或独立 provider adapters + assistant-ui 等可组合界面 + Postgres 数据层 + 对象存储 + 持久化任务队列；文本和图片走模型 API，视频走异步任务，语音先支持录音/播放，再接 WebRTC；浏览器与 CLI agent 运行在隔离 worker，已有申请插件继续作为本地执行端。这里的组合是工程判断，不是对 Higgsfield、ChatGPT 或 Updream 内部技术栈的推测。

快速获得可使用的完整聊天产品时，LibreChat 是很有价值的 MIT 参考。长期要大幅修改品牌、产品目标和 UI 时，Vercel Chatbot/AI SDK/assistant-ui 提供的组件边界更适合作为起点。Open WebUI、LobeHub、TEN 的当前许可存在额外条件，不能按旧教程里的 MIT 或纯 Apache-2.0 处理。

## 本报告如何验证

- 实际打开官方仓库 README、LICENSE、产品或 API 文档；部分原始文件通过官方 GitHub raw/Hugging Face 页面读取。
- 下面编号的 31 个项目与后续补充候选的“已证”指其当前官方代码/文档提供相应接口或功能说明。各项实际接入与运行证据单独记入验证记录；只阅读官方资料不足以证明这些功能在我们的账户、手机或高并发环境中已可用。付费模型调用仍关闭。
- 许可证核查到主仓文件层级；依赖、模型权重、语音、角色图片、Live2D SDK 和商业云服务仍各自适用条款。不能用主仓 MIT 一句话覆盖所有素材。
- 不用 stars 作为成熟度证明。选型需要进一步看真实任务成功率、恢复能力、延迟、维护成本和多租户隔离。

## 1. 聊天产品和可组合网页组件

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 1. [Vercel Chatbot](https://github.com/vercel/chatbot) | Next.js + AI SDK 模板，模型切换、聊天历史、Auth.js、Postgres 与文件存储；原 ai-chatbot URL 已跳转 | [Apache-2.0](https://github.com/vercel/chatbot/blob/main/LICENSE)：可商用改造；分发保留许可、必要 notices 与修改说明；模型/托管另计 | 参考产品骨架，替换业务页面、存储和模型目录 |
| 2. [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 多模型、多用户、Agents、MCP、Skills、文件、代码工具与 artifacts；工作空间功能明确标为高度实验性 | [MIT](https://github.com/LibreChat-AI/LibreChat/blob/main/LICENSE)：可商用修改，保留版权和许可 | 最完整的通用聊天参考；整套 fork 会继承较多后端结构 |
| 3. [Open WebUI](https://github.com/open-webui/open-webui) | 自托管聊天、Ollama/OpenAI-compatible 接入、知识和工具管理 | [自定义 Open WebUI License](https://github.com/open-webui/open-webui/blob/main/LICENSE)：一般须保留 Open WebUI 品牌；去品牌例外包含滚动 30 天不超过 50 名用户、书面许可或企业许可；历史代码还须看 LICENSE_HISTORY | 内部评估方便；面向大量用户的独立品牌产品须先处理品牌许可 |
| 4. [LobeHub / 原 LobeChat](https://github.com/lobehub/lobehub) | 现主仓已是 agent/team 运营取向，包含聊天、团队和工具体验 | [LobeHub Community License](https://github.com/lobehub/lobehub/blob/main/LICENSE)：基于 Apache 的附加条件；可商业使用未修改服务，商业衍生开发与分发需要商业许可 | 可研究 UI 和工作流；不直接作为自由改品牌的默认底座 |
| 5. [AI SDK](https://github.com/vercel/ai) | TypeScript 多 provider 抽象、流式 UI、tool loop 与生成式界面；[真实主包 README](https://github.com/vercel/ai/blob/main/packages/ai/README.md) | [Apache-2.0](https://github.com/vercel/ai/blob/main/LICENSE)；SDK 开源不代表 Gateway 或模型请求免费 | 可作为模型接入与流式消息层；不同模态仍需各自 adapter |
| 6. [assistant-ui](https://github.com/assistant-ui/assistant-ui) | React/TypeScript chat primitives、消息/附件/工具卡片、审批交互、语音输入及自定义 backend adapter | [MIT](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE)；其托管服务另属商业产品 | 比整套聊天门户更容易接入自有设计系统 |

AI SDK 的视频接口当前仍被官方标为 experimental，不能将统一函数理解成所有视频供应商都具有相同参数与可靠的长期契约。[AI SDK 视频文档](https://ai-sdk.dev/docs/ai-sdk-core/video-generation)

## 2. 陪伴、角色与持续记忆

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 7. [AIRI](https://github.com/moeru-ai/airi) | 语音角色、Web/桌面、Live2D/3D、记忆相关子项目、游戏交互；README 明确移动设备和 PWA 支持 | [MIT 主仓](https://github.com/moeru-ai/airi/blob/main/LICENSE)；角色、模型和子项目另核；正确主仓是 moeru-ai/airi | 陪伴感、角色表现、音频交互的优先参考；不能由 demo 推导完整 SaaS 成熟度 |
| 8. [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 角色卡、世界设定、长期对话配置与可扩展模型前端；[官方功能概览](https://docs.sillytavern.app/) | [AGPL-3.0](https://github.com/SillyTavern/SillyTavern/blob/release/LICENSE)：可商用；修改版本向网络用户提供服务时须遵守对应源码提供义务 | 人设与记忆交互参考；嵌入闭源产品前需确定代码边界 |
| 9. [elizaOS](https://github.com/elizaOS/eliza) | 插件化 agent runtime；当前 monorepo 含 web/desktop/mobile 目标、chat/voice/memory、浏览器/桌面自动化与调度；具体能力依配置而变 | [MIT 主仓](https://github.com/elizaOS/eliza/blob/develop/LICENSE)；插件和本地模型分开核查 | 可选 agent runtime；范围很广，先验证最需要的能力 |
| 10. [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 实时语音、视觉输入、Live2D、web/desktop、本地或云模型；远程手机麦克风需要 HTTPS | [MIT](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE) 明确排除示例 Live2D 模型，模型另有 LICENSE-Live2D.md | 语音陪伴原型参考；不要复制示例角色当自己的商业品牌 |

“陪伴”与“能持续做事”是两个不同维度。头像、角色卡和语音不自动产生可靠的任务恢复、通知、记忆权限或执行能力。我们需要自己的用户可编辑记忆、任务状态和审批记录。

## 3. 语音、实时对话和多模态传输

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 11. [LiveKit Agents](https://github.com/livekit/agents) | 服务端实时音视频 agent、STT/LLM/TTS 或 realtime 模型插件、打断、turn detection、MCP、dispatch；有 JS/TS 实现 | [Apache-2.0](https://github.com/livekit/agents/blob/main/LICENSE)；Cloud、电话、模型服务另计 | 面向 web/mobile 的实时语音基础设施优先候选；[支持自托管](https://docs.livekit.io/transport/self-hosting/) |
| 12. [Pipecat](https://github.com/pipecat-ai/pipecat) | Python realtime voice/multimodal pipelines，传输与模型服务可替换，多 agent 组合；可本地运行后迁移云进程 | [BSD-2-Clause](https://github.com/pipecat-ai/pipecat/blob/main/LICENSE)：商用保留版权与免责声明 | 若重视可换 STT/TTS、音视频处理链，可作为语音 worker；[官方概览](https://docs.pipecat.ai/overview/introduction) |
| 13. [TEN Framework](https://github.com/TEN-framework/ten-framework) | 实时语音 agent 示例、RTC/WebSocket、VAD/turn detection 与扩展 | [附加条件的 Apache 型许可](https://github.com/TEN-framework/ten-framework/blob/main/LICENSE)：禁止把框架/衍生品托管在终端设备，限制与 Agora 竞争及供第三方开发应用；不能当纯 Apache | 可以评估，但默认不选择为自由部署的手机 SDK 底座 |

直接使用商业 realtime API 也是方案，不需要先部署上述框架。OpenAI 当前官方浏览器流程是服务端创建短期 client secret，前端 WebRTC，服务端可用 WebSocket；录音→转写→文本模型→TTS 的串联模式也应保留。浏览器原生 speechSynthesis 是设备功能，不能把它标记为已接通云端实时语音模型。[OpenAI Realtime 官方文档](https://developers.openai.com/api/docs/guides/realtime)

本地语音模型补充（2026-10-06）：

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 27. [Kokoro](https://github.com/hexgrad/kokoro) | 82M参数神经语音合成；官方Python库支持本地模型、voice tensor与24kHz音频，英文管道可在CPU运行 | 代码及 [官方权重](https://huggingface.co/hexgrad/Kokoro-82M) Apache-2.0；G2P、eSpeak NG与phonemizer依赖各自适用许可 | 新增独立本地speech worker，首版固定美式英语af_heart；本项目HTTP封装与上游推理库分开，运行证据见验证记录 |
| 28. [Piper](https://github.com/OHF-Voice/piper1-gpl) | 本地神经TTS，官方提供 [HTTP合成服务](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md)、CLI及Python接口 | 当前引擎GPL-3.0，具体voice须逐一查看 [MODEL_CARD许可](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md) | Linux轻量语音的另一候选；本机尚未安装或运行 |
| 29. [Faster Whisper](https://github.com/SYSTRAN/faster-whisper) | 用 CTranslate2 运行 Whisper，支持本地多语言 ASR 与可选 VAD | [MIT](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE)；本项目固定的 [Whisper tiny 权重](https://huggingface.co/Systran/faster-whisper-tiny) 另核模型许可 | 已接独立 loopback 转写服务；固定资产、有限时长、取消回收与真实虚构音频有本地证据，实时通话未接 |
| 30. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | C/C++ Whisper 推理，提供本地 CLI、server 和多平台实现 | [MIT](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)；模型与各硬件 backend 条款另核 | 另一条本地 ASR 路线；本项目尚未安装运行 |
| 31. [Silero VAD](https://github.com/snakers4/silero-vad) | 语音活动检测，提供 ONNX／PyTorch 模型；VAD 本身不生成文字 | [MIT](https://github.com/snakers4/silero-vad/blob/master/LICENSE) | 使用 Faster Whisper 随包的固定 VAD 资产，启动前校验 hash；与本地转写一起验证，不宣称独立实时产品已完成 |

### 语音自然度与可商用选型补充（2026-10-06）

本次补充核查官方源码、模型卡和产品文档，没有下载候选权重、调用收费语音服务或部署。当前本地链路提供录音/导入、转写、审阅文字、明确发送普通聊天回合，再单独朗读回答；实际验收使用导入的虚构音频，没有申请麦克风。Kokoro 接入仅开放英语，生成完整音频文件，仍是逐回合交互。真实双向实时语音、流式播放、自动轮次判断和说话打断尚未验证；下面新候选与收费声音的效果也未在本产品试听。本次本地验证使用的 af_heart 声音，不能代表所有 TTS 产品的自然度。

#### 三个可优先评估的开放模型

| 候选及官方依据 | 声音与表达能力 | 代码许可证 | 本次核查的权重许可证 | 16GB Mac 与上线资源边界 |
| --- | --- | --- | --- | --- |
| [Chatterbox Nano](https://huggingface.co/ResembleAI/chatterbox-nano) | 110M、英语，支持 `[laugh]`、`[chuckle]` 等副语言标签和参考音频；同家族原版 500M 有 CFG/exaggeration 调节，Multilingual 500M 支持中文等 23 种语言 | [MIT](https://github.com/resemble-ai/chatterbox/blob/master/LICENSE) | Nano 官方模型卡标 MIT；其他 checkpoint 接入时各自锁定核查 | Nano 官方明确支持 CPU，并报告 8 核 CPU 上 3 倍实时速度；不是我们的 Mac 测量结果。原版/Multilingual 官方示例列出 MPS，不能据此保证 Nano/Turbo 的 MPS 表现。英语本地 A/B 的优先候选；参考音频、依赖和水印机制须单独处理 |
| [Qwen3-TTS 1.7B CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) | 中英等 10 种语言、9 个预设声线；1.7B 可用自然语言控制语气和节奏。官方描述 Serena 为温柔中文女声、Uncle_Fu 为低沉成熟中文男声、Aiden 为明朗美式英语男声 | [Apache-2.0](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE) | 此 1.7B CustomVoice 官方模型卡标 Apache-2.0；Base、VoiceDesign 和后续版本仍按具体 checkpoint 核查 | 官方推荐示例使用 CUDA、BF16 与 FlashAttention 2；没有本次可用的官方证据保证 16GB Mac 实时运行。比 Nano 更重，需测量与聊天/转写并行时的内存、首音频及持续速度；不得把官方最低延迟直接当本机性能 |
| [CosyVoice3 0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) | 中英等 9 种语言、18+ 中文方言/口音；情绪、速度、音量指令；支持文本输入与音频输出双向流式 | [Apache-2.0](https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE) | 此 0.5B-2512 官方模型卡标 Apache-2.0 | 官方安装和优化部署主要面向 Linux/CUDA、vLLM/TensorRT；中文及双语伙伴的候选，Mac 适配和效果尚未验证。官方最低 150ms 不等于完整对话耗时，也不保证本机实现达到 |

Qwen 的轻量版本存在重要能力差异：官方表格只有 1.7B CustomVoice/VoiceDesign 标明 Instruction Control；[官方推理实现](https://github.com/QwenLM/Qwen3-TTS/blob/main/qwen_tts/inference/qwen3_tts_model.py) 对 0b6 强制将 `instruct` 置空。0.6B 可以选声线，但不能因界面填写“温柔、耐心”就宣称自然语言情绪指令已经生效。表内许可证是所列代码和权重的核查结果，不覆盖参考录音、语音素材、第三方依赖或所有后续 checkpoint。

#### 两个商用许可容易误读的项目

- [Fish S2 Pro 官方模型卡](https://huggingface.co/fishaudio/s2-pro) 提供细粒度情绪/停顿指令、80+ 语言和流式推理。当前 [Fish Audio Research License](https://github.com/fishaudio/fish-speech/blob/main/LICENSE) 同时覆盖软件和模型：研究/非商业用途可免费使用，商业用途须另签书面许可，不能继续按旧资料称当前主仓代码 MIT。官方约 100ms 首音频测试使用 NVIDIA H200；5B 级模型不作为这台 Mac 的首选，本机内存和速度并未测试。
- [F5-TTS 官方许可证说明](https://github.com/SWivid/F5-TTS#license) 明确代码 MIT、预训练权重 CC-BY-NC。即便有 Apple Silicon/MLX 推理路线，也不能把官方权重直接列为可自由商用的产品默认方案。

#### 两个成熟托管语音候选

| 服务 | 本次核查的官方版本与能力 | 接入时仍需验证 |
| --- | --- | --- |
| [Cartesia Sonic 3.6](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest) | 当前 GA、44 种语言，按文本语境调整语调和停顿；官方为 agent 推荐 Skylar、Daniel、Jacqueline 等声音。生产可以固定 `sonic-3.6-2026-08-27`，避免自动更新改变试听结果；`sonic-preview` 是 beta。官方 [WebSocket 接口](https://docs.cartesia.ai/api-reference/tts/websocket) 有音频分块和按 context 取消 | 商业 API，模型服务与调用费用另计；账户权限、区域网络、完整链路延迟、声音稳定性、中文效果和手机播放均未实测。长期密钥仅在服务端；客户侧短期访问也须经我们的身份和会话授权 |
| [ElevenLabs 当前模型目录](https://elevenlabs.io/docs/overview/models) | 当前推荐 `eleven_v4_turbo` 用于富有表现力的实时对话，`eleven_flash_v2_5` 用于优先低延迟的交互。官方列出的约 100ms/75ms 排除了应用和网络延迟；不应继续用旧教程推定当前旗舰或参数 | 商业 API，采用账户实际可用模型与声音。约 100ms 推理不等于转写→聊天→首音频总时间；收费声音自然度、条款、账号限制和失败回退均未验证 |

#### 自然感要分三个层面设计

官方 `gpt-4o-mini-tts` 支持通过 `instructions` 调整语气、情绪、语速和重音，推荐先试听 marin／cedar；声音主要针对英语优化，中文仍需另外试听。本轮已将实际支持的语气配置接入供应商声明、共享契约、严格验证、独立合成任务和工作流，旧TTS模型与Kokoro拒绝该参数。网页提供三角色和按服务能力展示的声线；协议验证通过，但未调用商业声音，不能据此判断自然度。[官方TTS指南](https://developers.openai.com/api/docs/guides/text-to-speech)

1. **说话内容**：用口语短句、自然衔接，一次讲一个重点；问答长度按语音场景设计，避免把整篇 Markdown 报告直接朗读。缩短说话长度不能删掉关键条件或改变回答含义。
2. **声学表达**：声线、语速、停顿、情绪、重音和发音。每个 provider 只传它实际支持的控制；给预设起亲切名字不代表新增情绪模型。少量自然停顿即可，笑声/呼吸标签不应机械地加到每句话。
3. **轮次与打断节奏**：流式首音频、判断用户有没有说完、允许用户打断、区别“嗯嗯”与实际插话。本轮已接入 OpenAI Realtime 的语义VAD接话偏好，供应商协议测试通过；真实WebRTC轮次、延迟和打断尚未验收。可以进一步采用 LiveKit 或 Pipecat；[LiveKit 官方轮次说明](https://docs.livekit.io/agents/logic/turns/) 提供 VAD、语义轮次检测、手动控制和打断处理。[轮次调优](https://docs.livekit.io/agents/logic/turns/tuning/) 说明端点等待和提前生成的取舍。语音输入不因此获得外部工具执行权限。

#### 三种亲切角色与盲听验收计划

以下是已接入的产品角色方向，界面名称分别为温柔陪练、轻松职业搭子、清晰面试官；尚未证明某个声音能达到目标。角色不按性别绑定，同一风格允许用户选择服务支持的不同声线。

| 角色 | 内容与表达目标 | 场景 |
| --- | --- | --- |
| 温柔伙伴 | 不催促，先接住具体困难，短句、留思考时间，再建议一个小行动 | 用户紧张、自我怀疑、准备第一次 networking |
| 沉稳导师 | 清楚、耐心、节奏稳定，解释依据并给可执行的下一步 | 比较职业方向、拆技能差距、安排课程与实习 |
| 轻快同伴 | 有活力但不夸张，回应自然、追问简洁，鼓励演练与尝试 | 英语破冰、模拟聊天、复盘今天的小进展 |

试听采用同一批虚构内容的中英对照，每家同语言使用相同文本。初始样例为中文“我们先不用把所有事情都决定好。你已经做过一个有价值的分析项目。今天，我们只比较两个方向，再选一个小行动去验证。”与英文“We don't need to decide everything today. You've already completed an analysis project with useful experience. Let's compare two career directions, then choose one small action to test.”；样例是验收材料，不是用户履历事实。另加一个澄清问题和包含公司缩写/数字的句子，检查语气、疑问停顿和发音。

计划先保留 Kokoro 英语基线，再试听 Nano 英语以及 Qwen/CosyVoice 中英候选；Kokoro 和 Nano 不伪装成中文路线。每段目标 15–25 秒，隐藏供应商与模型名，随机播放，用 1–5 分记录亲切程度、自然节奏、清晰度及长时间聆听舒适度，同时记录漏词、改词、不应出现的笑声、错误读音和重试失败。供应商所谓“最自然”的宣传不能替代用户试听。

性能验收分别记录冷启动、热请求首音频、整段生成时间、用户结束说话到听见回答的完整耗时、峰值内存，以及聊天/转写同时运行时的表现。流式与打断另做取消、旧回合不得继续播放、误打断恢复和手机浏览器测试；在实现前保持“未验证”。锁定模型/声音版本与参数，试听音频和截图仅放忽略的本地验证目录。后续收费 A/B 必须先显式开启商业调用，记录真实用量和费用；本次不产生收费请求。

## 4. 浏览器、电脑操作与隔离执行环境

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 14. [Browser Use](https://github.com/browser-use/browser-use) | 开源浏览器 agent、CLI/库、本地或云浏览器、托管 Agent API；云产品与开源库有不同能力 | [MIT](https://github.com/browser-use/browser-use/blob/main/LICENSE)；托管浏览器、代理、模型另属商业服务 | 网页研究和浏览器任务 worker；不据宣传承诺所有网站可操作 |
| 15. [Stagehand](https://github.com/browserbase/stagehand) | browser agent SDK，把代码控制与模型驱动动作结合，支持本地浏览器及 Browserbase | [MIT](https://github.com/browserbase/stagehand/blob/main/LICENSE)；Browserbase 服务和模型另计 | 若希望常规步骤确定性执行、少量复杂步骤用模型，适合做 browser adapter |
| 16. [OpenHands](https://github.com/OpenHands/OpenHands) | 当前 Agent Canvas 是自托管 coding-agent 控制中心，支持本地/Docker/VM/远程 backend 与 ACP agent | [MIT 主仓](https://github.com/OpenHands/OpenHands/blob/main/LICENSE)；外部 backend、Cloud/Enterprise 与第三方 agent 各自有条款 | 完整 coding 工作台/自动化参考；不能把它等同已隔离的多人平台 |
| 17. [Cua](https://github.com/trycua/cua) | desktop automation、SDK/CLI/MCP、VM/Spaces、computer-use 模型与评测；可结合用户自己的计算机/云机器 | [MIT 主仓](https://github.com/trycua/cua/blob/main/LICENSE.md)；VM 镜像、OS 和权重另核 | 更广的桌面操作执行端候选；不同平台支持边界要逐项测 |

网页聊天本身无法任意控制用户电脑：云端 worker 操作云电脑；浏览器插件操作用户授权的页面；本地 daemon 操作授权的本地环境。网页/手机可以发起、观察和审批，执行机器及其登录状态必须明确。多用户执行端不能共享浏览器 profile、系统目录或模型密钥。

## 5. CLI harness、工具协议与持久化 agent 流程

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 18. [OpenCode](https://github.com/anomalyco/opencode) | 可换模型的 coding agent、build/plan/subagent；[headless server](https://opencode.ai/docs/server/) 暴露 HTTP/OpenAPI，另有 [SDK](https://opencode.ai/docs/sdk/) | [MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE)；供应商模型/订阅条款单独适用 | 可做服务端 coding harness adapter；通过事件桥接自有网页 |
| 19. [Codex CLI](https://github.com/openai/codex) | 本地 coding agent，官方 SDK 可开启/恢复线程；app-server 支持客户端认证、历史、审批及流式事件 | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE)；模型和账户使用另有服务条款 | 可接独立隔离运行时；[官方 SDK](https://learn.chatgpt.com/docs/codex-sdk) 已明确旧 codex mcp-server 移除，应使用 app-server/SDK |
| 20. [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 标准化工具/resources/prompts 的客户端与服务端；main 现是 v2，v1.x 是单独维护分支 | [正在 MIT→Apache-2.0 过渡](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)：获同意贡献为 Apache，部分旧贡献仍 MIT，普通文档 CC-BY-4.0 | 工具接入协议，不是完整 agent runtime，也不自动提供账户授权或持久化 |
| 21. [LangGraph](https://github.com/langchain-ai/langgraph) | 有状态编排、durable execution、human-in-the-loop、记忆与流式运行 | [MIT](https://github.com/langchain-ai/langgraph/blob/main/LICENSE)；LangSmith 的托管/观测产品单独计费 | 复杂、可暂停恢复流程的候选；仍须配置持久化 store 和执行进程 |
| 22. [Mastra](https://github.com/mastra-ai/mastra) | TypeScript agents、workflows suspend/resume、memory、MCP、evals，能接 Next.js/React | [主代码 Apache-2.0，ee/ 目录例外](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) | 与现 TS workspace 接近；不能把企业 auth/editor 目录误当自由许可代码 |
| 23. [LiteLLM](https://github.com/BerriAI/litellm) | provider gateway、OpenAI 风格 API、多种模态端点、routing、预算/观测相关能力 | [主代码 MIT，enterprise/ 例外](https://github.com/BerriAI/litellm/blob/main/LICENSE) | 当多供应商、用量/预算集中管理变复杂时引入；早期可先使用薄 adapter |

OpenCode 官方 server 默认绑定 127.0.0.1:4096，支持 HTTP Basic Auth；它是 agent 控制面，不应直接作为公共多人 API。需要我们的认证、任务所有权、工作目录隔离及允许的操作范围。[OpenCode server](https://opencode.ai/docs/server/)

CLI harness 不应从网页直接接受任意 shell 字符串并在产品主服务器运行。自有任务系统应把指令、审批、执行事件、成果文件与取消/恢复统一起来，再由 adapter 调用 harness。

## 6. 图像、视频工作流和开放权重

| 项目 | 已证能力及定位 | 当前许可与商业使用要点 | 在我们产品中的位置 |
| --- | --- | --- | --- |
| 24. [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 可复用 node graph、图像/视频/音频/3D 工作流、队列和 API，支持开放模型及商业 partner nodes | [GPL-3.0](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE)：可商用；向外分发覆盖代码/衍生品需履行 GPL 义务；模型与 custom nodes 另核 | 将精选工作流封在隔离 media worker，通过 API 接自有 UI；不直接暴露安装任意 node 的权限 |
| 25. [Wan2.2](https://github.com/Wan-Video/Wan2.2) | 文生视频、图生视频、混合 TI2V，另有 audio-driven/animation 变体；这是推理代码与权重，不是完整 SaaS | [代码 Apache-2.0](https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt)，[官方 TI2V-5B model card](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) 也明确 Apache-2.0；不同 checkpoint/依赖另核 | 可选自托管视频后端；先比较托管 API 的成本和运维，不能把能在 4090 跑推导为高并发能力 |
| 26. [Open-Sora](https://github.com/hpcaitech/Open-Sora) | 视频训练/推理 pipeline 和 checkpoint，v2 为 11B；与 OpenAI Sora 无关 | [主代码 Apache-2.0，LICENSE 附第三方条款](https://github.com/hpcaitech/Open-Sora/blob/main/LICENSE) 包含 HunyuanVideo 的地域限制；[官方 v2 model card](https://huggingface.co/hpcai-tech/Open-Sora-v2) 标 Apache-2.0；不能据主仓标识忽略具体依赖 | 研究/定制推理参考；先评估 GPU、速度和所需组件许可 |

开放权重意味着可以下载或运行某个 checkpoint，不代表模型训练数据全部开放、不代表推理免费，也不代表 UI、运营、内容授权与服务能力已经齐备。商业模型 API 则通常不给权重；SDK 开源也不改变这一点。

OpenAI 官方当前明确：Sora 2 模型与 Videos API 已于 **2026-09-24 关闭**，且没有一对一替代 API。历史文档里的 /videos 示例不能作为当前可用接口；Open-Sora 项目不受这个同名混淆影响。[OpenAI 当前视频文档](https://developers.openai.com/api/docs/guides/video-generation)

## 7. Seedance、即梦、Dreamina、Updream 与 Higgsfield

| 名称 | 本次已核实 | API/开源状态 |
| --- | --- | --- |
| Seedance | 字节的视频模型家族；火山官方当前文档包含 2.5 与 2.0 系列能力 | 已核实官方 Ark 商业视频 API；没有本次可核实的官方 Seedance 权重开放证据 |
| 即梦 AI | [官方网页](https://jimeng.jianying.com/) 提供文/图生视频、图像、智能画布 | 消费者创作产品；API 接入应按火山模型/视觉服务文档处理，不复用网页会员或私有接口 |
| Dreamina | [CapCut 官方页面](https://dreamina.capcut.com/tools/seedance-2-0) 提供 Seedance 及图像创作入口 | 字节/CapCut 创作生态的消费者界面；不要把消费者产品、模型家族与 Ark API 当同一个契约 |
| Updream | [updream.bilibili.com](https://updream.bilibili.com/) 实际跳转 www.updream.cn；官方页面明确是哔哩哔哩自研 AI 视频创作产品 | 是与即梦不同的产品；本次未找到并核实其公开开发者 API/开源源码，不能编造接入路由 |
| Higgsfield | 官方提供自己的创作产品，也提供 [Higgsfield API](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api) | 商业服务；API 独立账户美元余额与网站订阅分账；公开多模型 API 不证明内部数据库/服务器栈 |
| fal | [官方异步推理 API](https://fal.ai/docs/documentation/model-apis/inference/queue) 支持 submit→status→result/webhook | 商业托管平台，模型 endpoint 和输入 schema 逐项验证；客户端 SDK 开源不能代替模型许可与账户额度 |

因此，Updream 和即梦不是同一产品。Seedance 是模型家族；即梦/Dreamina 是面向创作者的入口。网页“能用某模型”、官方“有该模型 API”和“我们的账户可以调用并已完成端到端测试”是三级不同证据。

### 已核实的 Ark 视频契约

下面只列官方已读取字段，不意味着本次发起过生成：

| 步骤 | 官方契约 |
| --- | --- |
| 认证与 base | 服务端 API Key；Authorization: Bearer；base 为 https://ark.cn-beijing.volces.com/api/v3 |
| 创建 | POST /contents/generations/tasks；必选 model:string 和 content:object[]；成功返回 id:string |
| 文本内容 | 元素包含 type:text、text:string |
| 图片内容 | type:image_url、image_url.url；用途可为 first_frame、last_frame 或 reference_image，按模型/任务限制 |
| 可选输出设置 | resolution、ratio、duration、seed、camera_fixed、watermark；各型号允许范围不同，不做无条件通用映射 |
| 查询 | GET /contents/generations/tasks/{id}；status 为 queued/running/cancelled/succeeded/failed |
| 成功结果 | content.video_url；可选 content.last_frame_url；还有用量及其他任务字段 |

来源：[创建 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[查询 API](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)。任务记录仅保留最近 7 天，输出 URL 有效期 24 小时；产品必须转存需要长期保留的成果。官方文档示例 model 为 doubao-seedance-2-5-260628，实际使用必须确认该账户已开通的 Model ID 或 Endpoint ID。

### Higgsfield 作为替代供应商

已实际读取 [Seedance 2.0 模型专属 API 页](https://open.higgsfield.ai/models/bytedance/seedance-2.0/text-to-video/api-reference)：POST https://api.higgsfield.ai/bytedance/seedance-2.0/text-to-video，必选 prompt，可选 duration（4–15）、resolution、aspect_ratio、generate_audio。提交后存 request_id，再查询生命周期；成功视频字段是 video.url，不能复用 Ark 的 content.video_url。[官方生命周期](https://docs.higgsfield.ai/docs/concepts/requests.md)

鉴权协议是服务端 Authorization: Key <credential>。当前模型/鉴权文档描述 KEY_ID:KEY_SECRET，最新 quick-start 强调让用户原样粘贴控制台复制出的完整 key；接入 UI 应接收完整值，避免自行拆分/拼装。供应商文档有新旧域名/示例并存，部署前须再按当前控制台核查。[鉴权](https://docs.higgsfield.ai/docs/authentication.md)、[Quick start](https://open.higgsfield.ai/quick-start)

## 8. 推荐组合与扩展顺序

下面是基于上述证据的设计建议，尚未代表全部依赖已经安装。

| 层 | 首选方向 | 保留的替代/扩展能力 |
| --- | --- | --- |
| 产品页面 | 自有 React/Next.js、可组合聊天/工具卡片、手机响应式布局 | 逐步 PWA、后续原生客户端；共享业务 API，避免移动端重写任务状态 |
| 模型网关 | typed provider registry；显式区分 chat/image/STT/TTS/realtime/video | AI SDK；供应商数量和治理需求增加后使用 LiteLLM |
| 文件/成果 | 自有对象存储、私有文件 URL、成果元数据与版本 | 导出、分享、素材库；供应商临时 URL 不作为永久文件记录 |
| 多用户数据 | Postgres 保存 users/workspaces/conversations/messages/tasks/approvals/assets/usage | Postgres 本地起步与托管均可；用户量增加依靠连接池、索引、worker 扩展，不能靠换一个“融资公司数据库”保证承载能力 |
| 长任务 | 持久化 job、幂等键、状态与取消；API 与 worker 分开 | 专用队列/工作流运行时；工具步骤恢复和媒体任务通知 |
| 语音 | 录音/转写/TTS + realtime adapter | LiveKit 或 Pipecat；人物口型与动画使用独立 avatar 层 |
| 视频 | Ark Seedance 或逐一验证的 fal endpoint，异步任务＋转存 | Higgsfield API；以后按成本与需求再考虑 ComfyUI/Wan worker |
| Agent 执行 | 工具 registry＋允许范围＋用户审批＋运行事件 | LangGraph/Mastra；Codex/OpenCode harness，browser/desktop adapter |
| 求职插件 | 已有插件作为本地 execution adapter | 与通用网页共享档案/任务契约，不把其旧门户架构当所有能力的基础 |

先让“对话→调用工具→异步任务→成果”形成同一个产品体验，再逐步提高各模态质量和执行范围。能力开关应明确“本地演示”“已配置”“官方文档支持”“账户实测通过”，不能用假的视频卡片或浏览器语音代替真实接通。

## 9. 已证 / 未证矩阵

| 要验证的结论 | 当前证据 | 状态及下一步 |
| --- | --- | --- |
| 有可商用修改的聊天/界面基础 | Vercel Chatbot、LibreChat、AI SDK、assistant-ui 当前 README 与 LICENSE | 已证文档/许可；具体组合由实现验证 |
| 开源陪伴与语音角色方案存在 | AIRI、elizaOS、Open-LLM-VTuber 与官方源码 | 已证；手机音频、效果、稳定性和素材权利尚未端到端实测 |
| browser/desktop/CLI 能被网页调度 | Browser Use/Stagehand/Cua、OpenCode server、Codex SDK/app-server | 已证接口；多租户 sandbox、真实权限、恢复和执行效果未因此自动成立 |
| Seedance 官方 API 可作为视频后端 | Ark 创建/查询 API 的实际 schema | 已证官方文档；用户账号开通、余额、地区、限流与生成结果未测 |
| Higgsfield 可作为 media API 供应商 | 官方 API 产品、模型专属 schema、鉴权及生命周期 | 已证官方文档；用户账户访问与付费生成未测 |
| Updream 就是即梦 | 两个独立官方入口与产品文字 | 证据相反，是不同产品 |
| Updream 提供公开可用 API | 本次没有找到可核实的官方开发者契约 | 未证；不添加猜测 endpoint |
| OpenAI Sora 视频 API 当前可调用 | 官方文首 shutdown 通知 | 不成立；2026-09-24 已关闭，历史示例不接入 |
| 开源模型可免费承载大量视频任务 | 开放 checkpoint、推理代码与硬件说明 | 未证；需要成本/排队/吞吐测试，开放权重不等于免费 GPU |
| 我们选的 stack 是 Higgsfield/ChatGPT 融资团队内部方案 | 没有官方内部部署证据 | 未证；不借品牌背书数据库/服务器选择 |
| 平台已经“什么都能做” | 项目功能目录或模型数量不能证明所有真实任务 | 未证；需要逐能力接受测试、凭据与授权边界 |

## 10. 本次检索版本记录

以下 SHA 来自本次官方 GitHub commits API，便于后续锁定核查版本；分支会继续变化。UTC 时间有些显示为 2026-10-06，但仍处于用户时区 2026-10-05 晚间。许可证详情以对应文件/具体发布版本为准。

| 仓库/分支 | 观察到的 commit |
| --- | --- |
| vercel/chatbot / main | c2f8235e1f3ea903ad8b7f61447c4f74164b5c58 |
| LibreChat-AI/LibreChat / main | f10b1d91f1eee3a2c82d5247bf620351486b7c1b |
| open-webui/open-webui / main | 8bd8b4fac5e059578ac0c74b3c18d11139f88b7d |
| lobehub/lobehub / main | 14dfc07b14eee1984e52c195df9319636d6b167b |
| moeru-ai/airi / main | 91953f0380bc9dca6a9d4082b91510aa4e030559 |
| SillyTavern/SillyTavern / release | 06bde939fb1e9c4c8d8641d810f0a916b5bce127 |
| elizaOS/eliza / develop | 65621da3a424f8fcdce760db5c9c414117082e18 |
| Open-LLM-VTuber/Open-LLM-VTuber / main | 992309c0aa19845960228f880013d4685fde93b5 |
| livekit/agents / main | 76de1759b3f1393ea813c8f55dedf3e68ff890a1 |
| pipecat-ai/pipecat / main | f612c0e2a3623bed9e29bd8c8751327095f24cff |
| TEN-framework/ten-framework / main | ad20a1735293d2c03af6eeb00940d45d889dd0b0 |
| browser-use/browser-use / main | 7be96ed8bafa8dfe1eef228b59cf5c884b8b2431 |
| OpenHands/OpenHands / main | 0ab2137ad529f2f5935edf152d25a3f8f5f59293 |
| browserbase/stagehand / main | 82ef425ee115dbd63bbff930f9f171fe892d231a |
| trycua/cua / main | ea763a110ff967e8caaea4ff551b1b083d113849 |
| anomalyco/opencode / dev | 652c090dc119b5f3dc1e5e0bf1c4b40d9721f0ef |
| openai/codex / main | 822e58cc3d666166c7446c5b1ea2e52f5d09594c |
| modelcontextprotocol/typescript-sdk / main | b022522089a0c8b632595c6e7b536453945ed5a9 |
| langchain-ai/langgraph / main | 2d942085e214ef6b99b6f54ed4d544a7c7c5ac56 |
| mastra-ai/mastra / main | a879630e3f8c696fdaa61e4103b8bb052b97730e |
| BerriAI/litellm / main | b8239a9873e201dc87859c9aea260937ffed417e |
| Comfy-Org/ComfyUI / master | 7c8fbc698b3c3dce0f525f6b5044b93d9395c5c9 |
| Wan-Video/Wan2.2 / main | 1ea34ff48f87168174e12956e200b1d908b1c5ff |
| hpcaitech/Open-Sora / main | 7ad6a96a135feb81f755c84fb391818718f6beb2 |
| vercel/ai / main | 3a1072d9b0e799e9005ae75970d1e38d3506a549 |
| assistant-ui/assistant-ui / main | c883dc0a7283e9c97e2887eb49178d5d8714c10b |
