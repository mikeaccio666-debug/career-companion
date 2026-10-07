# 本人声音：离线录音清单检查与候选导出

这是专业训练本人声线的准备工具。它读取私人 WAV 和 JSON 清单，测量音频格式、时长、削波与近静音，检查训练和留出集是否混入同一句或同一段音频，再生成供本人审阅的候选清单。它不录音、不播放、不联网、不复制音频、不上传或启动训练。

数值通过只表示可以导出这份候选索引。是否像本人、自然、发音正确、房间噪声可接受以及是否符合供应商训练要求，仍需人工审听和供应商本人验证。`self_attested` 是本人对来源及用途的声明，工具不验证身份、其他说话者、法律授权、语言或口音。

使用 macOS / Linux 与 Python 3.10 及以上，只依赖标准库。录制脚本和人工质量标准见 [录制与验收手册](../../docs/platform/personal-voice-recording.md)。网页“录音转文字”用于转写，不作为专业训练母版导出器；请用录音软件保存未有损压缩的母版。

## 从空清单开始

在仓库根目录运行，先创建一个新的私人目录。已有目录不会被覆盖。

```sh
python3 services/voice-dataset/voice_dataset.py init \
  --root .local/voice-dataset/my-voice
```

目录为 `0700`，空清单 `.local/voice-dataset/my-voice/manifests/dataset.json` 为 `0600`。初始 `self_attested=false`，没有录音或训练候选。按手册录制自己的声音，保存母版后把筛选后的 PCM WAV 放在该目录的 `train/zh/`、`train/en/`、`train/mixed/` 中。试录和留出参考分别放在 `probe/`、`holdout/reference/`；不把后者改为训练片段。

清单最小形状如下。编号和文本仅作虚构示例；`usable_seconds` 必须改为人工核对过的实际净时长。声明、审听与转录检查完成后才把相应状态改为 `true` / `accepted` / `reviewed`，不能直接照抄示例状态作为验证。

```json
{
  "schema_version": 1,
  "dataset_version": "v001",
  "delivery_style": "natural-warm",
  "speaker": {
    "speaker_id": "self",
    "voice_source": "self_recorded",
    "self_attested": false,
    "permitted_use": "personal_voice_training",
    "attested_at": "2026-10-06T12:00:00Z"
  },
  "clips": [
    {
      "clip_id": "v001-zh-b01-t01",
      "relative_path": "train/zh/v001_zh_s01_b01_t01.wav",
      "phrase_id": "ZH-B01",
      "language": "zh",
      "style": "natural-warm",
      "split": "train",
      "quality_status": "pending",
      "transcript_review": "pending",
      "usable_seconds": 12.4
    }
  ]
}
```

`attested_at` 用实际声明时刻的 UTC 时间。单一清单对应一位声明的本人及一种稳定表演风格；训练片段 `style` 必须与 `delivery_style` 一致。中文、英文和混读分别导出，不自动推断英文达到美式口音，也不决定能否混合提交给供应商。

每个片段必填上例的字段；`split` 为 `probe` / `train` / `holdout_reference` / `evaluation`。质量状态为 `pending` / `accepted` / `rerecord` / `rejected`，转录审阅为 `pending` / `reviewed`。可在私人清单补充 `transcript`、`target_locale`、`script_id`、`take`、`session_id`、`device_profile`、`delivery_profile`、`rejection_reason`、`upload_status`、`training_status`。正文和设备资料不写入报告、导出或终端。可选 `sha256`、`duration_seconds`、`sample_rate`、`bit_depth`、`channels` 与实际文件比较，填错会阻止导出。

手册原来的 `script_id` 可继续标识内容块；新增 `phrase_id` 标识这段音频中说的内容。不同 take 或不同文件不能换一个编号来绕过同一句留出集检查。包含多个段落时，应先按明确内容边界拆分训练副本并记录对应编号。工具不自动听出错误编号或语义相同的改述。

输入根目录及清单须属于当前用户，目录 `0700`、文件 `0600`（只读 `0400` 也可）。对手动导入的文件设置权限，例如：

```sh
chmod 600 .local/voice-dataset/my-voice/train/zh/v001_zh_s01_b01_t01.wav
chmod 600 .local/voice-dataset/my-voice/manifests/dataset.json
```

## 检查、审阅、导出

输出目录必须是全新的目录，每次检查保留独立报告：

```sh
python3 services/voice-dataset/voice_dataset.py validate \
  --root .local/voice-dataset/my-voice \
  --manifest .local/voice-dataset/my-voice/manifests/dataset.json \
  --output .local/voice-dataset/review-v001
```

终端只返回计数、固定错误代码和 `report_sha256`。打开私人 `review-v001/review.json` 检查每个片段的数值、问题和 `candidate`。`ok` 指没有阻断错误；`export_ready` 仅指候选索引能导出。只有 `split=train`、人工接受、转录已审阅且净时长大于零的片段进入候选；任何错误会阻止整个导出。警告需人工复查，不能靠数量和时长替代审听。

审阅后，把上一步返回的实际报告哈希传给导出命令；下列占位符不是可用哈希：

```sh
python3 services/voice-dataset/voice_dataset.py export \
  --root .local/voice-dataset/my-voice \
  --manifest .local/voice-dataset/my-voice/manifests/dataset.json \
  --review-report .local/voice-dataset/review-v001/review.json \
  --review-sha256 '<上一步的实际64位report_sha256>' \
  --confirm-reviewed \
  --output .local/voice-dataset/candidates-v001
```

导出会重新读取所有录音、清单和报告。任何变化都要求重新检查、审阅，旧报告不会批准新录音。生成的 `candidate-manifest.json` 按 `zh` / `en` / `mixed` 分组，含相对路径、实际格式、文件／PCM 哈希及人工净时长；不包含文稿或音频。状态固定为 `prepared_not_uploaded`，不是训练完成证明。以后真实上传前仍需重新检查候选文件哈希，并由本人在供应商完成身份验证和费用确认。

默认省略 `--output` 时，生成随机 `.local/voice-dataset/<操作>-<ID>/`，终端返回这个目录。当前仓库内只允许 `.local/` 或 `private/` 输入输出；也允许仓库之外的私人目录，但拒绝其他 Git 仓库、路径越界与符号链接。工具不会替你把真实清单、声音、授权资料或供应商回执加入源码。

## 检查的具体含义

- 只接受 RIFF WAVE 的整数 PCM（含明确 PCM 子格式的 WAVE_EXTENSIBLE）、8 / 16 / 24 / 32 位、1–2 声道、8–192 kHz。浮点、压缩或其他音频格式需先在录音软件导出训练副本，保留母版；本工具不转码。
- 每个文件最多 1 GiB、1 小时，清单最多 2,000 条 / 2 MiB，整份音频时长最多 12 小时。读取 WAV 头后即检查剩余时长预算，超出时停止，不先扫描超过预算的 PCM 或后续文件；报告会标记分析未完成，只统计实际分析过的时长。顺序、流式分析，不启动 GPU 或模型。FIFO 等非普通文件立即拒绝，不等待写入者。
- 文件 SHA 固定整个 WAV；PCM SHA 固定采样格式与音频内容。相同 PCM 即使 WAV 标签不同也按重复录音拒绝。相同 `phrase_id`（忽略大小写）或空白／大小写规范后相同的私人转录不能同时出现在训练和留出参考中。手册 `ZH-T01…24` / `EN-T01…24` 固定为留出材料，不能放到训练或试录筛选中。未提供转录时，工具依赖正确编号，不识别其他别名或改述。
- 削波按样本到达整数满量程统计；训练片段削波比例 ≥ 0.1% 阻止导出，少量满量程样本提示复查。近静音按一帧所有声道绝对幅值均不超过 −50 dBFS 的整数阈值统计，提供总比例及首尾时长；训练近静音 ≥ 99% 阻止导出，≥ 50% 提示复查。这些是保守的准备规则，不是感知自然度、语音活动检测或供应商合格证明。
- 报告还记录 RMS、峰值、格式及总时长。低于 44.1 kHz、低于 16 位或双声道提示复查，不静默重采样／混音。人工 `usable_seconds` 不能超过文件时长；工具不猜哪些话说错、不把静音比例简单扣成“有效训练时长”。

## 验证

```sh
python3 -m unittest discover -s services/voice-dataset/tests -p 'test_*.py'
pnpm --filter @companion/voice-dataset check
```

测试在临时私人目录生成虚构 PCM（不是真人语音），验证格式与指标、权限和符号链接、重复与留出污染、审阅后变化拒绝、导出边界及无正文终端输出。工具也通过本 workspace 的 `check` / `test` 脚本发现；没有 Node 或 Python 运行依赖包。
