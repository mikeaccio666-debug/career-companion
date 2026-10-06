# 声线方案

> 这份文档回答什么问题：主理人（中文陪伴）和面试官（英文实时面试）分别用什么声音、怎么让每位用户的主理人声音独特、开源与商用方案如何取舍、怎么验证。结论待盲测决定，盲测与付费调用需产品负责人批准。

检索与核实日期：2026-10-06。所有排名、价格、延迟都变化很快，以下以当天官方页面为准；凡标「未公布」的，是官方没有给出数字。厂商自报的延迟和质量数字只能当参考，最终以我们自己的盲听和压测为准。本文不是法律意见，合规部分需要律师确认。本次没有调用任何付费接口，也没有改仓库代码。

---

## 1. 结论

### 1.1 首版推荐组合

| 角色 | 推荐方案 | 链路 | 声线怎么来 |
|---|---|---|---|
| **面试官**（英文实时模拟面试） | OpenAI Realtime `gpt-realtime-2.1`（仓库已经接好 WebRTC 和短期凭据） | 语音到语音，semantic VAD 轮转和打断 | 固定一个官方预置声线：`cedar` 或 `marin`，盲听后二选一。所有用户的面试官用同一个声线，不进主理人声线池 |
| **主理人**（中文陪伴） | 首选 **ElevenLabs `eleven_v4_turbo` + Voice Design v3**；第二候选 **Gemini 3.8 Flash TTS**；隐私最稳的备选 **Azure zh-CN HD Flash** | 链式：语音识别 → 大模型 → 流式 TTS。逐回合朗读和语音对话走同一个 TTS，保证一个主理人只有一个声音 | 运营用「文字描述设计声音」预先做 40–60 个中文声线，按温度、语速、直接度打标签；每个用户按性格推荐 3 个，默认第 1 个 |
| **开源并行线** | **Qwen3-TTS-12Hz-1.7B**（先用 VoiceDesign 生成参考音，再固化成克隆提示复用），经 vLLM-Omni 自托管 | 同上 | 首版只进盲测；通过后作为第二阶段「每个用户一个独有声线」和降成本的方案 |
| **开发 / 离线兜底** | 现有本地 Kokoro `af_heart` | 只支持英文 | 只用于开发环境，不用于真实用户的主理人 |

最终选哪家，以第 7 节的一周盲测结果为准。上表是有依据的假设，还没有经过验证。

### 1.2 为什么这样选

1. **面试官继续用 OpenAI Realtime。** 它的轮转和打断是现成最成熟的。仓库已经能签发短期凭据（`packages/ai-core/src/media.ts:52-64`），也接好了 semantic VAD（`packages/ai-core/src/voice-input.ts`）。英文本来就是它的强项。`/v1/realtime` 可以申请零数据保留（ZDR，需要审批）。面试官全员共用一个固定声线，没有「每人独特」的需求，所以不必走自定义声线。新出的 GPT-Live-1（全双工，$0.05/分钟，后端模型另计）放到第二阶段评估。来源：https://developers.openai.com/api/docs/guides/realtime-conversations ，https://developers.openai.com/api/docs/guides/your-data ，https://developers.openai.com/api/docs/models/gpt-live-1.md
2. **主理人的难点是中文像真人、能大量造声线、供应商最好在美国。** ElevenLabs 同时满足这三点：
   - Artificial Analysis 综合榜上，v4 Turbo 排第 1（1334），v4 排第 2（1321）。这个榜以英文为主，没有中文专项。
   - 官方模型页列出支持普通话（cmn）和粤语。v4 Turbo 中位推理延迟约 100ms；官方自测的首个可听语音约 150ms，属于厂商自测。
   - Voice Design v3 可以用文字描述造声线。Scale 和 Business 套餐可存 660 个自有声线。
   - 是美国公司，可以谈企业版零保留（ZRM）。

   来源：https://artificialanalysis.ai/text-to-speech/leaderboard ，https://elevenlabs.io/docs/overview/models ，https://elevenlabs.io/v4 ，https://elevenlabs.io/docs/api-reference/text-to-voice/design
3. **Gemini 3.8 Flash TTS 作为第二候选。** 它也能按描述造声线，价格低：音频输出 $9/1M tokens，约 $0.0135/分钟，2027 年起翻倍。付费层的数据不用于改进产品。短板有三个：每个项目最多存 200 个声线；实时延迟没有公布；Cloud TTS 价格页上仍标为 Preview。来源：https://ai.google.dev/gemini-api/docs/speech-generation ，https://cloud.google.com/text-to-speech/pricing ，https://ai.google.dev/gemini-api/terms
4. **Azure 作为隐私兜底。** 用预置声线做实时合成时，微软不存储输入文本和输出音频。zh-CN HD Flash 有 14 个中文声线，带 chat、empathetic、comforting、encouraging 等陪伴类风格。它的缺点是不能设计声线，声线池小。来源：https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security ，https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices
5. **为什么不沿用产品文档里「主理人用 OpenAI 预置声线」的做法**（`docs/product/02-companion.md` §6.1）：Realtime 只有 10 个预置声线，而且不能设计；中文自然度官方没有评测；如果面试官也用 OpenAI，主理人能用的声线就更少了。它不用改代码，所以仍然放进盲测，作为「零改造」对照组。
6. **为什么中文效果很好的国产云服务不做主力：** 阿里 Qwen-Audio-3.1 在 AA 榜排第 3，豆包 2.0 只要 3 元/万字符，但美国司法部规则 28 CFR 202 把「身处美国的任何人」都算作 U.S. person，在美留学生也在内。把用户数据交给与受关注国家相关的实体处理，需要先做法务评估。这两家首版只用于虚构台词的质量对照。来源：https://www.law.cornell.edu/cfr/text/28/202.256
7. **为什么开源不做首版主力：** 我们目前没有 GPU 运维。官方宣传的首包延迟和高并发下的实测差得很远：vLLM 博客实测 Qwen3-TTS 在 H20×2 上，并发 1 时首包 70.61ms，并发 64 时约 1128ms。但从长期看，开源是唯一能做到「声线数量不受供应商上限限制 + 数据留在自己环境」的路线，而且 Qwen3-TTS 的代码和权重都是 Apache-2.0。所以首版就把它拉进盲测，提前积累数据。来源：https://vllm.ai/blog/2026-06-23-vllm-omni-tts ，https://github.com/QwenLM/Qwen3-TTS
8. **最大的不确定性：** 没有一家供应商公布中文自然度评测，AA 榜也没有中文专项。所以第 7 节的盲测决定最终选择，需要预算和付费调用授权。

### 1.3 需要产品负责人拍板的事

- **盲测预算与授权。** 按 `AGENTS.md`，商业调用需要服务端显式开启，本轮也不调用付费模型。盲测需要单独批准；台词全部用虚构内容，不含用户数据。
- **是否修改 `docs/product/02-companion.md` §6.1 和 §6.2。** 改动有两处：一是主理人声线从「OpenAI 预置声线池」改为「TTS 供应商的设计声线池 + 链式语音对话」；二是 §6.2 的说明文案「来自服务商提供的预设声线」改为「AI 生成的声音」。按 `AGENTS.md` 的约定，改产品方向要先提出，所以等您确认后再改文档。
- **是否启动两项商务谈判：** ElevenLabs 企业版零保留（ZRM）和 OpenAI 的 ZDR 申请。
- **是否批准一台 GPU，做开源 PoC。** 用于 Qwen3-TTS、CosyVoice3、VoxCPM2 的盲测和压测。
- **创始人声音的定位。** `docs/platform/personal-voice-recording.md` 写的是「目标已确定：专业训练本人声音」，但 `docs/product/02-companion.md` §6.3 已把它降级到后续。两份文档互相矛盾，需要您确认以哪份为准。本方案按 §6.3 处理：首版主理人不用任何真人的声音。

---

## 2. 「每位用户一个独特的主理人声音」怎么实现

### 2.1 三条路线对比

| 路线 | 做法 | 独特程度 | 成本 | 主要风险 |
|---|---|---|---|---|
| A. 预设声线库挑选 | 从供应商的现成声线里挑，按性格匹配 | 低：很多用户会听到同一个声音 | 几乎为零 | 中文声线少（Azure zh-CN HD 约 16 个，OpenAI Realtime 共 10 个）；换供应商时声音会跟着变 |
| B1. 声音设计 · 预制声线池（**首版推荐**） | 运营写性格描述，用文字描述生成 40–60 个声线，试听筛选后打标签入池；每个用户在池里匹配，再叠加语速、表达指令、名字和人设 | 中：声线会被多人共用，但组合起来基本唯一 | 一次性设计费用加运营试听人力；声线名额占用固定 | 设计结果每次都有波动，需要挑选；要保存「声线配方」，以便迁移 |
| B2. 声音设计 · 每个用户现做（第二阶段） | 根据系统生成的主理人性格，自动写出声音描述，生成 3 个候选，用户试听选 1 个后锁定 | 高：音色本身就是独有的 | 商用 API 受声线名额限制；自托管开源没有上限，只有 GPU 成本 | 偶然生成出和某位真人相似的声音；生成失败或不好听；自动生成的描述可能带出偏见 |
| C. 微调（LoRA 或 少样本） | 用获得授权的配音演员录音微调出几个「招牌声线」，例如 VoxCPM2 只需 5–10 分钟音频，GPT-SoVITS 约 1 分钟 | 低，但每个声线质量最高 | 配音演员合同、授权管理、训练和托管 | 必须有书面授权和撤回机制（见第 6 节）；数量少，做不到每人一个 |

### 2.2 各家声线名额（决定 B 路线能走多远）

| 供应商 | 自定义声线上限 | 设计 / 克隆费用 | 来源 |
|---|---|---|---|
| ElevenLabs | Creator 30 / Pro 160 / Scale 660 / Business 660 | 设计调用费用未在本次核实范围内 | https://elevenlabs.io/docs/api-reference/text-to-voice/design |
| Gemini 3.8 Flash TTS | 每个项目 200 个（描述生成和复刻共用），最后一次使用后保留 1 年，用了就续期 | 未公布单独费用 | https://ai.google.dev/gemini-api/docs/speech-generation |
| OpenAI 自定义声线 | 每个组织 20 个，只开放给符合条件的客户，必须由声音提供者照固定文本录同意书 | 需联系销售 | https://developers.openai.com/api/docs/guides/custom-voices |
| 阿里云 Model Studio | 每账户每模型族 1000 个，一年不用自动删除 | Qwen 声音设计 $0.2/个 | https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-design |
| Inworld | On-Demand 100 / Creator 500 / Growth 最高约 3 万 | 未核实 | https://inworld.ai/pricing |
| MiniMax | 未公布 | 声音设计 $3/个，快速克隆 $1.5/个；克隆声线 7 天不用会被删 | https://platform.minimax.io/docs/guides/pricing-paygo.md |
| 自托管 Qwen3-TTS / VoxCPM2 | 没有上限：参考音和克隆提示存在我们自己的数据库 | 只有 GPU 成本 | https://github.com/QwenLM/Qwen3-TTS ，https://github.com/OpenBMB/VoxCPM |

结论：真正做到「每个用户一个独有音色」，商用 API 里只有 Inworld Growth（约 3 万个）和阿里（1000 个）的名额勉强够用，而阿里有合规顾虑。可持续的做法是自托管开源模型。首版先用 B1，并把以下「声线配方」存进我们自己的数据库：

- 设计描述文本；
- 供应商和模型版本；
- 供应商的声线 id；
- 参考音的哈希；
- 试听标签（温度、语速、直接度）；
- 表达指令模板。

有了这份配方，换供应商或迁到自托管时，可以按同一份描述重新生成，再做人工比对，尽量让声音接近原来的样子。

### 2.3 推荐的落地流程（B1 → B2）

1. **写描述。** 运营按 `docs/product/02-companion.md` §6.1 的三个维度，写 40–60 条中文声音描述，例如「二十多岁的普通话女声，语速偏慢，温和但不甜腻，句尾干脆」。描述里**不写任何真人的姓名、明星或角色名**。
2. **生成。** 每条描述生成 3 个候选。VoxCPM2 官方说明，设计结果每次都有波动，可能要生成 1–3 次；Qwen3-TTS 同理。
3. **试听筛选。** 用固定试听句「我是墨。今天我们先把一件事做完。」加上第 7 节的测试句做内部试听。发音错误、听起来像某位知名人物、或情绪不稳的候选全部淘汰。
4. **固化。** 商用 API 存下声线 id；自托管走 Qwen3-TTS README 推荐的流程：用 VoiceDesign 合成参考片段 → `create_voice_clone_prompt` → `generate_voice_clone`，之后反复使用同一份克隆提示。README 原文说这个流程「especially useful when you want a consistent character voice across many lines」。来源：https://github.com/QwenLM/Qwen3-TTS
5. **匹配。** 按 §6.1 的规则推荐 3 个，用户可以随时更换。
6. **第二阶段（B2）。** 开源盲测和压测通过后，把第 1–4 步自动化，为每个新用户现做。仍保留「用户试听后确认」这一步，并加相似度检查：新声线和池内已有声线、内部禁用名单的说话人相似度过高时就重新生成。

### 2.4 让它「更像真人」：模型之外可以借鉴的做法

听起来像不像真人，不只取决于选哪个 TTS 模型。开源界和头部产品的共同做法有这些：

- **先固定声线，再实时合成。** 用设计或获得授权的录音得到参考音，固化后交给流式模型实时合成，同时用指令控制情绪和语气。Qwen3-TTS、VoxCPM2、CosyVoice3 都支持语气、语速、情绪指令，CosyVoice3 还能用拼音或 CMU 音素纠正发音。来源：https://github.com/FunAudioLLM/CosyVoice ，https://github.com/OpenBMB/VoxCPM
- **让语气跟上下文走。** MOSS-TTS-Realtime 专为多轮语音 Agent 设计，生成时会参考历史文本和用户上一轮的语音来保持语气一致；Sesame CSM 也会参考上下文音频。这类思路值得借鉴，但 CSM 只支持英文。来源：https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Realtime ，https://github.com/SesameAILabs/csm
- **写给耳朵听的文本。** 让大模型直接输出「口语稿」：短句、少括号、不用列表；数字、日期、金额先规范化；英文公司名和岗位名保持原样，并维护一份发音词典，例如 SWE、OA、OPT、LeetCode。中英混读出错，大多数是文本侧的问题。
- **轮转节奏。** 链式方案按句子或分句切分，把文本流式送进 TTS（vLLM-Omni WebSocket 的 `split_granularity=sentence/clause` 就是做这个的）；用户一开口就立刻停止播放。端到端延迟一旦超过 1 秒左右，再好的音色也会显得「不像人」，需要实测校准。
- **一致性优先于花哨。** 同一个主理人在不同天、不同通道里的声音必须一样。所以 TTS 出故障时，**宁可退回文字，并提示「语音暂时不可用」，也不要临时换成另一个声音**，否则用户会以为换了一个人。

---

## 3. 开源方案

### 3.1 前几名（可商用、中英文都好、能流式）

| 模型 | 中文质量 | 英文质量 | 代码许可 | 权重许可 | 流式与延迟 | GPU 需求 | 造声线能力 |
|---|---|---|---|---|---|---|---|
| **Qwen3-TTS 12Hz 1.7B / 0.6B**（阿里通义，2026-01-22） | Seed-TTS-eval 中文 CER 1.22；第三方论文中 UTMOSv2 3.86 排第 1，多轮迭代后自然度最稳（4.27→3.79） | 英文 WER 1.23 | Apache-2.0 | Apache-2.0 | Dual-Track 流式。官方称「端到端合成延迟低至 97ms」，未说明测试硬件，属于理想值。vLLM 博客实测（H20×2，克隆模式）：并发 1 首包 70.61ms，并发 64 约 1128ms | 官方未公布；推荐使用 FlashAttention2 | VoiceDesign 只有 1.7B 版有；Base 版 3 秒克隆；CustomVoice 版有 9 个预置声线（中文 5 个）；可用指令控制语气、语速和情绪 |
| **Fun-CosyVoice3-0.5B-2512**（阿里 FunAudioLLM，2025-12） | 中文 CER 1.21%；第三方 UTMOSv2 3.58 排第 2；RL 版说话人相似度最高；支持 18 种以上中文方言和口音 | 英文 WER 2.24% | Apache-2.0 | Apache-2.0 | 双向流式，宣传延迟低至 150ms（单路理想值）。仓库里由 NVIDIA 工程师贡献的 TensorRT-LLM 方案，在单卡 L20、4 路并发下首包平均 750ms，P99 1002ms。两个数字的测试条件不同 | 官方未公布 | **不能用文字设计声线**；可零样本克隆；可用指令控制方言、情绪、语速；支持拼音纠音 |
| **VoxCPM2**（面壁 OpenBMB，2026-04，2B） | 官方自报中文 CER 0.97，相似度 79.5 | 英文 WER 1.84；InstructTTSEval-EN 84.2，表中最高 | Apache-2.0 | Apache-2.0（README 写明可商用） | 提供 `generate_streaming` API。RTX 4090 上 RTF 约 0.30，加速后约 0.13。**首包延迟官方未公布** | 约 8GB 显存；输出 48kHz | 可用文字设计声线，也可以可控克隆；用 5–10 分钟音频即可做 LoRA；设计结果每次都有波动 |
| **MOSS-TTS-Realtime 1.7B + MOSS-VoiceGenerator 1.7B**（OpenMOSS，备选第 4） | 家族中文 CER 1.37–1.44%（官方） | 英文 WER 1.84–1.93% | Apache-2.0 | Apache-2.0 | L20 上首字节 180ms，RTF 0.51；会参考上一轮用户语音保持语气 | 未公布 | VoiceGenerator 可用文字设计声线 |
| **GLM-TTS**（智谱，以中文为主） | RL 版 CER 0.89（官方自报） | 以中文为主，整段英文不是强项 | Apache-2.0 | MIT（示例音频仅限研究） | 支持流式，延迟未公布 | GPU 或昇腾 NPU | 3–10 秒克隆；不能用文字设计声线 |

来源：
- https://github.com/QwenLM/Qwen3-TTS ，https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign ，https://arxiv.org/abs/2601.15621
- https://github.com/FunAudioLLM/CosyVoice ，https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512 ，https://github.com/FunAudioLLM/CosyVoice/blob/main/runtime/triton_trtllm/README.Cosyvoice3.md
- https://github.com/OpenBMB/VoxCPM ，https://huggingface.co/openbmb/VoxCPM2
- https://github.com/OpenMOSS/MOSS-TTS ，https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Realtime ，https://huggingface.co/OpenMOSS-Team/MOSS-VoiceGenerator
- https://github.com/zai-org/GLM-TTS ，https://huggingface.co/zai-org/GLM-TTS
- 第三方比较（南大、小米、港科大，11 个开源模型）：https://arxiv.org/html/2603.24430
- vLLM-Omni 并发实测：https://vllm.ai/blog/2026-06-23-vllm-omni-tts

**排序理由：** Qwen3-TTS 第一。它在同一个模型家族里同时有「文字设计声线 → 固化 → 复用」的完整流程，这正是我们需要的预设声线库；第三方评测里它的自然度最高、多轮最稳；中文主理人和英文面试官可以共用一套服务。CosyVoice3 第二，中文流式最成熟，但必须借用别的模型来设计参考音。VoxCPM2 第三，单卡 8GB 就能跑，自托管成本最低，但首包延迟没有公开数据。

**需要注意的细节：**
- Qwen3-TTS README 的 vLLM 一节仍写着「只支持离线推理」，这已经过时，vLLM-Omni 现在已支持在线服务。
- vLLM-Omni 的两种流式模式都要求 `response_format` 为 pcm 或 wav，且 `speed` 必须是 1.0。WebSocket 端点默认要等 `input.done` 才开始合成，必须设置 `split_granularity=sentence` 或 `clause` 才能降低首包延迟。来源：https://github.com/vllm-project/vllm-omni （docs/serving/speech_api.md）

### 3.2 适合自托管的条件

满足以下条件中的大部分时，才建议把开源方案升为主力：

1. **有常驻 GPU，并有人负责运维。** 包括监控、扩缩容、模型版本固定和回滚。
2. **在我们目标并发下压测达标。** 例如首包 P90 在可接受范围内，具体目标见第 7 节。官方数字不能直接用。
3. **规模或需求上值得：** 「每用户独有声线」超出了供应商名额，或语音分钟数大到 API 费用超过 GPU 成本。这需要拿我们拿到的云 GPU 报价来测算，本次没有核实 GPU 价格。
4. **有数据驻留要求：** 希望用户文本不出自有环境。补充一点：在我们自己的美国机房跑中国机构发布的开源权重，并不把用户数据交给对方，和调用阿里云或火山引擎 API 是两回事。但是否构成 28 CFR 202 的数据交易，仍请法务一并确认。

### 3.3 只适合特定用途的开源模型

| 模型 | 许可 | 适合 | 不适合 |
|---|---|---|---|
| Kokoro-82M v1.1-zh（103 个音色） | 代码和权重 Apache-2.0 | CPU 兜底 | 主理人主声线：不能克隆、没有情绪控制；v1.0 的 8 个普通话音色官方评级全是 D。来源：https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh ，https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md |
| LongCat-AudioDiT（美团） | 代码和权重 MIT | 离线生成高质量参考音（说话人相似度最高） | 实时对话：扩散架构，没有流式说明。https://huggingface.co/meituan-longcat/LongCat-AudioDiT-3.5B |
| 腾讯 AuK / AuK-Flash | 代码和权重 MIT | 离线设计和编辑声线，例如把同一句话改成不同情绪 | 实时链路：流式未公布。https://huggingface.co/tencent/AuK |
| GPT-SoVITS | 代码和权重 MIT | 用约 1 分钟**授权录音**微调少量招牌声线，延迟低 | 高并发服务化。https://github.com/RVC-Boss/GPT-SoVITS |
| 英文专用：Chatterbox Flash / Turbo（MIT，Flash 首包 103ms，输出自带 Perth 水印）、Orpheus 英文版（Apache-2.0，约 200ms）、Dia2（Apache-2.0）、Sesame CSM（Apache-2.0）、Kyutai TTS（权重 CC-BY-4.0，不能克隆任意声音） | 均可商用 | 自托管英文面试官的备选 | 中文主理人。https://huggingface.co/ResembleAI/chatterbox-flash ，https://github.com/canopyai/Orpheus-TTS ，https://github.com/nari-labs/dia2 ，https://github.com/SesameAILabs/csm ，https://github.com/kyutai-labs/delayed-streams-modeling |

### 3.4 有条件可商用（使用前需法务通读）

- **IndexTTS2 / 2.5（bilibili）**：代码和权重都受 bilibili Model Use License 约束。上月 MAU 超过 1 亿，或上一年营收超过 10 亿元人民币，就必须另外申请授权。许可证还另有限制：禁止用于医疗诊断、军事、大规模生物识别监控；不得用它来改进其他 AI 模型；必须保留版权声明。官方代码有**按分段的流式返回**（`infer_v2.py` 的 `stream_return=True`），不是 token 级的低延迟流式，也没有官方流式服务端。中文情感表现力强，适合离线生成鼓励或安慰类的预录语音。来源：https://github.com/index-tts/index-tts/blob/main/LICENSE
- **Higgs TTS 2**（原名 Higgs Audio v2）：权重许可基于 Llama 3 社区许可证，上一年年活跃用户超过 10 万就要向 Boson 申请扩展许可。官方建议显存至少 24GB。来源：https://huggingface.co/bosonai/higgs-tts-2-3b-base/blob/main/LICENSE
- **VibeVoice（微软）**：2025-09-05 移除的只是长篇多说话人的 VibeVoice-TTS 1.5B 代码。之后开源的 Realtime-0.5B 仍在仓库里，MIT 许可，但只支持英语和单说话人，不能自行克隆。官方声明：未经进一步测试和开发，不建议用于商业或真实应用。来源：https://github.com/microsoft/VibeVoice
- **MegaTTS3（字节跳动）**：代码是 Apache-2.0，但编码器参数没有公开，无法自由定制声线。来源：https://github.com/bytedance/MegaTTS3
- **Step-Audio-EditX（阶跃）**：代码 Apache-2.0，权重卡没有声明许可证，商用与否暂记为 unknown；也不支持流式。来源：https://huggingface.co/stepfun-ai/Step-Audio-EditX
- **Orpheus 中文版**：模型名里标明是 research_release，不建议商用。来源：https://huggingface.co/canopylabs/3b-zh-ft-research_release

### 3.5 看起来很好，但不能商用（明确排除）

| 模型 | 为什么吸引人 | 为什么不能用 | 来源 |
|---|---|---|---|
| **Breeze TTS 2** | AA 开源权重榜第 1（Elo 1216），支持中英，H100 上首音低于 40ms | BreezeBlue Research and Non-Commercial License，自托管生成的输出也受限 | https://huggingface.co/BreezeBlue/Breeze-TTS-2 |
| **Fish Audio S2 Pro / Fish Speech** | 开源质量可能最强之一（中文 CER 0.54），支持 15000 多种行内情绪标签 | FISH AUDIO RESEARCH LICENSE：任何商业用途都要另签书面许可，连企业内部使用也算商业用途 | https://github.com/fishaudio/fish-speech/blob/main/LICENSE |
| OpenAudio S1-mini | 体积小 | 权重 CC-BY-NC-SA-4.0 | https://huggingface.co/fishaudio/s1-mini |
| **F5-TTS** | 延迟低（L20 上 253ms） | 代码 MIT，但权重 CC-BY-NC（训练数据 Emilia 的限制） | https://github.com/SWivid/F5-TTS |
| **Spark-TTS** | 中英混读，可按性别和音高创建声音 | 代码 Apache-2.0，权重 CC-BY-NC-SA-4.0 | https://huggingface.co/SparkAudio/Spark-TTS-0.5B |
| **MaskGCT** | 零样本克隆 | 权重 CC-BY-NC-4.0 | https://huggingface.co/amphion/MaskGCT |
| **OmniVoice** | 支持 600 多种语言和文字设计，vLLM-Omni 已支持 | 代码 Apache-2.0，预训练权重 CC-BY-NC | https://huggingface.co/k2-fsa/OmniVoice |
| **XTTS-v2（Coqui）** | 社区常用，6 秒克隆 | CPML 只允许非商业使用，**输出也受限**；Coqui 已关闭，无处购买授权 | https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt |
| **Higgs TTS 3** | 支持 100 多种语言和流式 | Research and Non-Commercial License | https://github.com/boson-ai/higgs-audio |
| **Voxtral-4B-TTS（Mistral）** | 大厂出品 | CC-BY-NC-4.0，而且不支持中文 | https://huggingface.co/mistralai/Voxtral-4B-TTS-2603 |

共同的坑：这些模型的**代码**多半是 MIT 或 Apache，但**权重**受训练数据（Emilia 等）的限制。用同样的数据自己重训，也会继承同样的限制。挑选时必须把代码和权重分开看。

---

## 4. 商用方案对比

每分钟价格是按中文约每分钟 270 字估算的（4–5 字/秒），只用来比较量级。各家对汉字的计费口径要以账单核对。

| 供应商 / 模型 | 质量（AA Elo；中文情况） | 声音设计 | 实时与延迟 | 价格量级 | 数据保留 | 首版定位 |
|---|---|---|---|---|---|---|
| **ElevenLabs v4 Turbo / v4** | 1334（第 1）/ 1321（第 2）；支持 cmn、yue，没有中文评测 | 有：Voice Design v3（`eleven_ttv_v3`），可传参考音 | v4 Turbo 中位推理约 100ms，厂商自测首个可听语音约 150ms。API 文档里 v4 Turbo 写在 Text to Dialogue WebSocket，v4 写在 Text to Dialogue API；ElevenAgents 里也能用 | v4 Turbo $0.04/1K 字符（约 $0.011/分钟），v4 $0.08/1K；10-12 前打 72% 折扣 | 隐私政策写明可能把个人数据用于训练，可在 Data use 里退出，但只对之后生效。声音相关数据最长保留到最后一次互动后 3 年。ZRM（`enable_logging=false`）只开放给部分企业客户，不覆盖语音克隆 | **主理人首选** |
| **Gemini 3.8 Flash / Flash-Lite TTS** | 1275（第 5）/ 1242（第 9）；支持普通话和粤语 | 有：`POST /v1beta/voices`（type=prompted） | 可通过 Interactions API 或 WebSocket 流式输出；延迟未公布；Cloud 侧仍是 Preview | 输出 $9/1M 音频 tokens（约 $0.0135/分钟），2027-01-01 起 $18；Flash-Lite $6，之后 $12 | 付费层不用于改进产品，只为检测违规记录日志；免费层会用于改进产品，所以必须用付费层 | **主理人第二候选** |
| **Azure zh-CN HD Flash / DragonHD** | 不在 AA 前 15；有 14 个 zh-CN HD Flash 声线，带陪伴类风格 | 无 | HD 延迟低于 300ms，只支持实时合成 | Neural HD $22/1M 字符（约 $0.006/分钟）；注意自定义声线的 CNV Neural HD 是 $48/1M | 实时 API 不存储文本和音频；batch 和长音频合成会存储 | **隐私兜底和中文对照** |
| **OpenAI gpt-realtime-2.1** | 中文没有官方评测 | 无。自定义声线限符合条件的客户，每组织 20 个，需要同意书录音 | WebRTC，semantic VAD，打断成熟；会话开始出声后不能换声线 | 音频输入 $32/1M、输出 $64/1M tokens；mini 版 $10/$20 | API 数据默认不用于训练；滥用监控日志最长保留 30 天；`/v1/realtime` 和 `/v1/audio/speech` 可申请 ZDR | **面试官首选** |
| OpenAI gpt-4o-mini-tts | 中文没有官方评测 | 无，有 13 个预置声线 + instructions | 流式输出 pcm 或 wav（24kHz） | 第三方折算约 $0.015/分钟 | 同上 | 盲测里的「零改造」对照 |
| OpenAI GPT-Live-1 | — | 无 | 全双工，支持 WebRTC、WebSocket、SIP；Tier1 并发 25 | $0.05/分钟，后端模型另计 | 同上 | 第二阶段评估 |
| **Cartesia Sonic 3.6** | 1278（第 4）；支持中文，没有公开的中文评测 | 官方文档里没找到按文字设计声线的功能 | 官方称首段音频低于 90ms | Startup $49/月含 125 万 credits（英文约 $0.03/分钟） | ZDR 只开放给企业，且不覆盖克隆；有 SOC 2 Type II | 英文链式备选 |
| **Inworld TTS-2 / TTS-2 Flash** | 1251 / 1214；中文属于 15 个生产级语言之一 | 有，并支持克隆；声线上限最高约 3 万 | Flash 自称首段音频 20ms；有兼容 OpenAI 格式的 `/v1/audio/speech` | TTS-2 $25/M 字符（约 $0.007/分钟），Growth 档 $12.5 | ZDR 和保留政策都未核实 | 盲测备选（声线名额最宽松） |
| 阿里云 Qwen3-TTS-Flash / Qwen-Audio-3.x | Qwen-Audio-3.1-TTS-Plus 1292（第 3）；中文第一梯队 | 有，$0.2/个，上限 1000 个 | qwen-audio-3.0-tts-flash 首包低于 200ms | Flash $0.1/万字符（约 $0.003/分钟） | 国际站选新加坡区域，静态数据存在新加坡；隐私声明称不用客户数据训练，另一份 FAQ 写的是「未经明确同意」不用 | **只做中文质量对照**，只用虚构台词；法务通过后再考虑 |
| MiniMax speech-2.8 | 中文表现力强 | 有，$3/个 | WebSocket 流式；有美西接入点 | hd $100/M 字符（约 $0.027/分钟） | 第三方汇总称条款允许用输入和输出改进服务，没有公开的 ZDR；母公司在上海 | 只做原型和对照 |
| 火山引擎 豆包 TTS 2.0 / BytePlus | 国内口碑好，没有统一评测 | 声音复刻 2.0（音色费 138 元/个） | 双向 WebSocket | 3 元/万字符（计费页更新于 2026-09-29）；BytePlus $30/M | 火山引擎的数据在中国境内处理 | 首版不发送任何含个人信息的文本 |
| Fish Audio S2.1 Pro API | 质量高 | 有 | 厂商称首包约 70–90ms | $15/M UTF-8 字节。按字符算，中文是英文的 3 倍；按同样时长的音频算，两者成本大致相当（约 0.8–1.2 倍） | 条款明确允许用用户内容训练模型，看不到退出机制 | 只用于试听原型 |
| Hume Octave / EVI | — | — | — | — | 2026-11-13 关停，之后账户数据会被删除 | **排除** |

来源：
- AA 榜单：https://artificialanalysis.ai/text-to-speech/leaderboard
- ElevenLabs：https://elevenlabs.io/docs/overview/models ，https://elevenlabs.io/pricing/api ，https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode ，https://elevenlabs.io/privacy-policy
- Gemini：https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts ，https://ai.google.dev/gemini-api/docs/pricing ，https://cloud.google.com/text-to-speech/pricing
- Azure：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices ，https://prices.azure.com/api/retail/prices
- OpenAI：https://developers.openai.com/api/docs/guides/text-to-speech ，https://developers.openai.com/api/docs/pricing ，https://developers.openai.com/api/docs/guides/your-data
- Cartesia：https://docs.cartesia.ai/build-with-cartesia/tts-models/latest ，https://cartesia.ai/pricing ，https://docs.cartesia.ai/enterprise/zero-data-retention.md
- Inworld：https://docs.inworld.ai/docs/tts ，https://inworld.ai/pricing
- 阿里云：https://www.alibabacloud.com/help/en/model-studio/qwen-tts ，https://www.alibabacloud.com/help/en/model-studio/model-pricing ，https://www.alibabacloud.com/help/en/model-studio/privacy-notice
- MiniMax：https://platform.minimax.io/docs/guides/pricing-paygo.md ，https://standardcompute.com/providers/minimax
- 火山引擎和 BytePlus：https://docs.volcengine.com/docs/6561/1359370 ，https://docs.byteplus.com/en/docs/byteplusvoice/TTS_Billing
- Fish Audio：https://fish.audio/terms/ ，https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
- Hume：https://dev.hume.ai/docs/text-to-speech-tts/overview

---

## 5. 与现有代码的衔接

### 5.1 OpenAI Realtime（面试官）：继续用，改三处

- **现状：** `packages/ai-core/src/media.ts:52-64` 调 `/v1/realtime/client_secrets` 签发短期凭据，默认模型 `gpt-realtime-2.1`；Realtime 声线白名单在 `packages/ai-core/src/voice-input.ts:7`（10 个）。
- **要改的地方：**
  1. 按产品文档，`services/platform-api/src/app.ts:312-329` 不再接受客户端传入的 `persona` 和 `voice`，改由服务端按「面试官专家」固定指令和声线下发（`docs/product/02-companion.md` 第 858 行）。
  2. 面试官声线固定为 `cedar` 或 `marin`。会话开始出声后就不能再换声线，所以要在创建会话时一次定好。
  3. 申请 `/v1/realtime` 的 ZDR。在审批通过之前，用户须知里要写明 OpenAI 会保留最长 30 天的滥用监控日志。
- **第二阶段：** 评估 GPT-Live-1。它的接口是 `v1/live/sessions`，和现在的 client_secrets 流程不同，需要新的适配。

### 5.2 Kokoro（本地）：只作开发与英文兜底，不扩展成中文主声线

- **现状：** `services/local-speech` 是 CPU 上的 Kokoro 82M Python 服务，只接受 `kokoro-82m` + `af_heart`。`packages/ai-core/src/kokoro.ts` 有以下限制：
  - 只允许 loopback 地址（第 13 行）；
  - 拒绝非拉丁字母文本（第 62 行）；
  - 只接受 24kHz、单声道、16-bit 的 WAV（第 26 行）；
  - 不支持表达指令。
- **建议：** 保持现状，作为开发环境和商业调用关闭时的英文兜底。这和 `docs/product/02-companion.md` §6.4 一致。
- **不建议在 Kokoro 适配器上硬改，去接 vLLM-Omni。** 原因有三：GPU 服务通常不在本机，loopback 限制会挡住它；Qwen3-TTS 和 VoxCPM2 的采样率不同（VoxCPM2 是 48kHz）；流式需要全新的返回路径。
- 如果开发环境也想听中文，可以另外评估 Kokoro v1.1-zh。但需要改 `services/local-speech` 的模型和声线白名单、`assets.json` 哈希和中文 G2P，再放开适配器的拉丁字母限制。中文质量不够做主理人，优先级低。

### 5.3 新增：自托管 TTS 适配器（vLLM-Omni，用于开源线）

- **新建一个独立的适配器**，例如 `packages/ai-core/src/selfhosted-tts.ts`，和 Kokoro 分开。它要做到：
  - 指向带鉴权的私有 GPU 服务，不是 loopback；
  - 允许中文；
  - 按模型配置采样率；
  - 支持 PCM 流式，走 SSE 或 `/v1/audio/speech/stream` WebSocket，`split_granularity=sentence`；
  - 「声线」用服务端保存的克隆提示 id，不接受客户端传入的音频。
- vLLM-Omni 已用同一个 OpenAI 兼容接口 `/v1/audio/speech` 支持 Qwen3-TTS、CosyVoice3、VoxCPM2、MOSS-TTS-Nano，所以三家盲测只需要换模型和部署，不用改接口。来源：https://github.com/vllm-project/vllm-omni （docs/serving/speech_api.md）

### 5.4 ElevenLabs 适配器：要改造后才能用于主理人

现状（`packages/ai-core/src/elevenlabs.ts`）和要改的地方：

| 现状 | 问题 | 改造 |
|---|---|---|
| 全局只有一个 `ELEVENLABS_TTS_VOICE_ID`（第 14 行），请求里的 voice 必须等于它（第 87 行） | 不能做到每个主理人一个声线 | 服务端维护 `voice_preset → (provider, provider_voice_id, 表达模板)` 映射（`docs/product/02-companion.md` 第 877 行）；按发言者取声线，客户端不能指定 |
| `POST /v1/text-to-speech/{voice}`，整段 `mp3_44100_128`（第 91-92 行） | 不能流式，首句要等整段生成完才能播放 | 主理人实时链路改用流式：v4 Turbo 走 Text to Dialogue WebSocket，按句子推送文本，返回 PCM |
| 模型白名单没有 `eleven_v4_turbo`（第 10 行） | 首选模型不在白名单里 | 实测确认后加入，并单独写 WebSocket 调用路径 |
| `eleven_v4` 用在 `/v1/text-to-speech` 上 | **文档说法有冲突**：代码注释称 2026-10-06 已按 Create speech 文档核实，但官方模型页写的是 v4 走 Text to Dialogue API | 必须用一次真实调用来确认，在付费调用获批后做 |
| `enable_logging` 默认传 false（第 93 行） | 只有企业版 ZRM 才生效；非企业账号会返回什么不清楚 | 同样需要实测；如果商务上谈不下 ZRM，用户须知里要写明 ElevenLabs 会保留数据 |
| — | Voice Design 不该在用户请求时实时调用 | 做成运营侧的离线脚本：生成、试听、入池，把声线 id 写进服务端配置 |

### 5.5 共用的改造

- **TTS 接口抽象。** 在 `SpeechInput` 之外增加流式方法和 `voicePreset`，让 ElevenLabs、Gemini、Azure、自托管实现同一个接口，便于盲测和故障切换。故障切换只在**同一个声线有多份等价实现**时才切换，否则退回文字（见 2.4）。
- **主理人语音对话走链式方案。** 复用现有的 Faster Whisper 或 OpenAI 转写，再加上大模型和流式 TTS。逐回合朗读和语音对话都用同一个 `voice_preset`，自然满足 §6.1「同一主理人在两条链路里声音一致」的要求；面试官用 OpenAI Realtime 的声线，也自然满足「面试官声线不进主理人声线池」。现有的 Faster Whisper 是 tiny 模型，中文识别准确率需要另行评估，本文不展开。

---

## 6. 伦理与合规

### 6.1 始终标明是 AI 声音

- 沿用 `docs/product/02-companion.md` §6.2：
  - 第一次播放前弹出说明，记录 `voice_disclosed_at`；
  - 面试间和播放器的标题区始终显示「AI 声音」标签；
  - 用户问「你是真人吗」时，要如实回答。
- 如果改用设计声线，说明文案要从「来自服务商提供的预设声线」改成「AI 生成的声音，不是任何真人的声音」。
- 这不只是产品原则，也是供应商条款的硬性要求：ElevenLabs、OpenAI、Cartesia 都要求向用户明确告知对方是 AI。来源：https://elevenlabs.io/use-policy ，https://developers.openai.com/api/docs/guides/text-to-speech ，https://www.cartesia.ai/legal/disclosure-requirements
- **加州 SB 243**（2026-01-01 生效）：主理人有拟人人设、跨多次交互维持关系，可能落入「companion chatbot」的定义。它要求：显著告知是 AI；有自伤和自杀危机转介机制；2027-07-01 起每年向公共卫生部报告；有私人诉权，每次违规按实际损失或 $1,000 取高。我们是否能按生产力工具获得豁免，需要律师判断。来源：https://www.gunder.com/en/news-insights/insights/client-insight-california-sb-243-new-compliance-requirements-for-operators-of-ai-companion-chatbots

### 6.2 不克隆真人

- **默认不克隆任何真人的声音**，包括创始人、蔓藤真人导师、用户本人、明星或公众人物。设计声线的描述里也不写真人姓名。`docs/product/01-vision-and-users.md` 第 525 行已把「用某位真人导师的声音说 AI 生成的话」列为反例。
- **例外只能是**「非个性化的品牌旁白」这类场景（见 `docs/product/02-companion.md` §6.3），而且必须同时满足：
  1. 声音提供者签署书面同意，写明用途、范围、期限和报酬；
  2. 有**撤回机制**：撤回后删除供应商侧的声线和我们保存的参考音及克隆提示，停止新的生成，并预先决定历史音频是下架还是保留；
  3. 每次播放都标注「AI 合成的 ×× 的声音」；
  4. 不用于主理人，不对学生说个性化的话。
- **不收集用户的声纹。** 伊利诺伊州 BIPA 把 voiceprint 列为生物识别信息，收集前需要书面授权。28 CFR 202 也把「登记进生物识别系统的声纹」列为敏感数据，过去 12 个月累计超过 1000 人就构成批量数据。我们的语音识别只转文字，不做说话人识别，也不存声纹向量。来源：https://lig.ilga.gov/legislation/ilcs/documents/074000140K10.htm ，https://www.law.cornell.edu/cfr/text/28/202.204 ，https://www.law.cornell.edu/cfr/text/28/202.205

### 6.3 平台条款对克隆和输出的限制

| 平台 / 模型 | 限制 |
|---|---|
| ElevenLabs | 未经同意不得复刻他人声音；**不得用输出去训练其他模型**；ZRM 不覆盖语音克隆。https://elevenlabs.io/use-policy |
| OpenAI 自定义声线 | 只开放给符合条件的客户；声音提供者必须照官方固定文本录同意书（有中文版），样本不超过 30 秒；每组织最多 20 个。https://developers.openai.com/api/docs/guides/custom-voices |
| Google 复刻声线（replicated） | 需要授权；第三方称在 IL、TX、EEA、英国、瑞士、印度受限。https://ai.google.dev/gemini-api/docs/speech-generation |
| Azure Personal voice | 受限访问，每位用户都要录同意声明，微软会做说话人验证。https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security |
| Cartesia | ZDR 不覆盖克隆。https://docs.cartesia.ai/enterprise/zero-data-retention.md |
| 开源模型 | Sesame CSM 和 Dia 的条款禁止冒充他人和欺骗性使用；Chatterbox 的输出自带 Perth 水印；XTTS-v2 和 Fish 的**输出**本身也受非商业或研究许可限制 |

**一个容易踩的坑：** 不要拿商用 API 设计出的声音（例如 ElevenLabs 的输出）当参考音，再去克隆或微调开源模型。ElevenLabs 禁止用输出训练其他模型；零样本克隆算不算「训练」有争议，LoRA 微调则基本可以确定算。开源线的参考音应该由开源模型自己的 VoiceDesign 生成，或者来自有授权的录音。

### 6.4 数据流向

- 首版 TTS 优先选美国厂商。阿里、火山、MiniMax、阶跃只接收虚构或不含个人信息的文本，要扩大使用范围必须先做 28 CFR 202 的法务评估。来源：https://www.justice.gov/nsd/data-security
- 主理人的台词里可能出现用户的学校、公司、签证状态等信息。选供应商时要看它的保留政策：ElevenLabs 非企业版会保留数据，可能用于训练；Azure 实时合成不保存；OpenAI 和 Gemini 付费层默认不用于训练。最终的用户须知要和实际选定的供应商对应。

---

## 7. 建议的验证方法

### 7.1 盲听评测（约一周）

- **候选组：**
  - 商用：ElevenLabs v4 Turbo、Gemini 3.8 Flash TTS、Gemini Flash-Lite、Azure zh-CN HD Flash、OpenAI gpt-4o-mini-tts（marin / cedar，零改造对照）、Inworld TTS-2（可选）。
  - 开源：Qwen3-TTS 1.7B（VoiceDesign → 克隆提示）、Fun-CosyVoice3、VoxCPM2。
  - 中文质量参照：Qwen-Audio-3.x，只送虚构台词。
- **测试句（全部虚构，不含真实用户资料），每组 12–15 句：**
  1. **中文陪伴句**：安慰、鼓励、催进度、给空间各若干句，混入数字、日期和金额。例如「被拒了三次，说明你在认真投，不是你不行。今晚先睡，明早我们只改一段。」
  2. **英文面试句**：behavioral 题、追问、技术题。例如「Walk me through a time you had to make a trade-off between latency and consistency.」
  3. **中英混读句**：例如「这周你投了 12 个 SWE new grad，Meta 那个 OA 记得 Friday 前做完，系统设计那轮多半会问 rate limiter。」重点听 OA、OPT、LeetCode、Kubernetes 这类词的读法。
- **流程：**
  - 所有候选合成同一批文本，统一响度，隐去供应商名称，随机打乱顺序；
  - 评审：8–12 位目标用户（在美留学生）加团队成员，每人至少听完一组；
  - 每条打分：自然度 1–5 分；「像真人吗」是/否；发音错误标记；情绪是否贴合；喜不喜欢这个声音；
  - 另做两两偏好对比，前三名之间做 A/B。
- **客观指标：**
  - 用较大的识别模型转写合成结果，计算中文 CER 和英文 WER，用来发现读错和漏字；
  - 用同一声线连续合成 20 句，检查音色漂移。开源模型尤其要查，第三方论文显示有些模型多轮之后会明显退化。
- **通过标准（建议值，可以调整）：** 中文陪伴句自然度均分 ≥ 4.0，且和最佳候选的差距 ≤ 0.3；混读句里关键英文术语读错率 ≤ 5%；评审中觉得「像真人」的比例过半。

### 7.2 延迟测量

- **测试位置：** 从美国东部和西部各测一次（贴近用户），记录供应商区域和网络路径。
- **TTS 单项：** 从请求发出到客户端收到第一段音频的时间（TTFA）。流式和非流式分开测，每个候选至少 100 次，记录 P50、P90、P99。
- **链式整轮：** 分段打点：用户说完 → VAD 判定结束 → 转写结果出来 → 大模型首个 token → TTS 首段音频 → 开始播放。看每段各占多少，以及整轮延迟。
- **自托管压测：** 并发 1、4、16、64 各测一组，记录 GPU 型号、显存占用、首包和实时率。对照 vLLM 博客的 H20×2 数据：并发 1 首包 70.61ms，并发 64 约 1128ms。
- **建议目标（待用户测试校准）：** TTS 首包 P50 低于 300ms、P90 低于 600ms；主理人链式整轮 P50 低于 1.5 秒。面试官走 Realtime，单独测「用户说完到听到回应」的时间。
- **成本核对：** 同时记录每分钟实际消耗的字符数或 token 数，用来校正第 4 节的估算。

### 7.3 前置条件

- 盲测和延迟测试都要调用付费接口。按 `AGENTS.md`，需要服务端显式开启商业调用（`PLATFORM_ALLOW_PROVIDER_CALLS`），并且由您明确批准预算。
- 开源候选需要一台 GPU：VoxCPM2 约 8GB 显存即可；Qwen3-TTS 1.7B 的显存需求官方没有给出，建议直接用 24GB 级别的卡。
- 结果出来后，再定主供应商，然后修改 `docs/product/02-companion.md` §6，并按第 5 节改造适配器。
