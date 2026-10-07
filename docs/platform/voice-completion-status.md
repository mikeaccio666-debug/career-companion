# 实时语音摘录的完成状态与限制

记录日期：2026-10-06。本说明记录通用网页语音底座的当前实现，不表示已完成商业 Realtime、真人麦克风或手机验收。

## 哪些文字可以保存

用户音频的 `conversation.item.input_audio_transcription.completed` 独立产生用户转写摘录。AI 的 `response.output_audio_transcript.done` 只说明转写流结束，不能单独证明回答成功完成。

AI 片段必须关联到 `response.done` 事件的 `response.status=completed`，没有关联冲突、未完成 item 状态或截断，才会成为 `complete` 并产生可保存输入。只有 `complete` 且输入非空的片段可保存；实时连接结束前，保存及带回草稿按钮保持禁用。

| 收到的状态或事件 | 网页处理 |
|---|---|
| 未收到成功完成回执 | 保留文字，标为 `unconfirmed`，不能保存为完整 AI 摘录 |
| `cancelled`、`failed`、`incomplete` | 不生成完整摘录；冲突终态降为 `incomplete`，撤销旧保存输入 |
| `conversation.item.truncated` | 标为 `truncated`，撤销保存输入；不猜测文字与已播放音频的精确对应关系 |
| `conversation.item.deleted` | 清除该 item 的文字，并阻止晚到转写恢复它 |
| 已识别响应的终态输出含无效 ID、错误形状、超量 output 或超出 item 容量 | 完整预检后拒绝关联，不部分更新 item；该响应降为 `incomplete`，撤销旧保存输入 |

接收限额退出时，已识别的状态撤销必须先写回草稿，再断开连接。跨实时会话累计超量时，保留已有的有界文字并同步撤销被降级片段的保存输入，不把新增超量文字写入草稿，也不因此升级其他片段。未确认文字同样计入 500 个摘录分块及 1 MiB 文本上限。

旧 `response.audio_transcript.done` 事件名仍可识别。缺 `response_id` 的旧形状只能通过完成回执中精确的 `output[].id` 关联；没有成功回执则继续未确认。导航保留状态和已生成的重试 UUID，账号离开或认证代次变化清空草稿，旧 editor 不能更新或关闭新的作用域。

实现见 [转写状态缓冲](../../apps/web/src/voice-history.ts)、[草稿更新与限额退出](../../apps/web/src/voice-draft.ts) 和 [实际语音页面](../../apps/web/src/VoicePanel.tsx)。

## 保存的含义与上下文缺口

摘录保存为服务端明确标注的 `client_submitted`，不能因角色写为 assistant、附有供应商和模型名，就视为服务端验证过的模型正文。保存不证明说话者身份、音频全部播放、用户能力或外部执行授权。服务端仍核对账号、会话、签发的语音 session、附件所有权和保存限额，见 [语音摘录存储](../../services/platform-api/src/voice-history.ts)。

逐回合语音把用户审阅后发送的问题及完整 AI 回复保存到普通会话。实时语音仍是独立摘录：当前 `/voice/session` 没有完整文字会话上下文注入，普通聊天的历史组装也不会自动读取这些 voice records。保存或带回草稿不自动发送消息；尚不能声称文字聊天与 Realtime 已无缝延续同一上下文。相关入口与历史读取见 [独立 API](../../services/platform-api/src/app.ts)。

## 本轮验证

七个相关网页测试文件共 **74 项通过、0 失败**：`voice-history`、`voice-draft`、`voice-personality`、`voice-account-boundaries`、`voice-conversation`、`voice-session`、`voice-playback`。网页类型检查和 `git diff --check` 通过。

回归覆盖完成片段收到失败／取消及畸形或超量终态、无部分 item 关联、先更新草稿再关闭的实际公共处理函数、累计限额、旧 editor、事件顺序、去重、截断与删除。使用虚构协议事件及现有本地测试 fixture；本轮没有商业 Realtime 调用、真人录音、真实设备通话或新的浏览器语音验收，也未验证声音自然度。
