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

逐回合语音把用户审阅后发送的问题及完整 AI 回复保存到普通会话。实时语音仍是独立摘录，普通聊天的历史组装不会自动读取这些 voice records。保存或带回草稿不自动发送消息。

## 主动接续最近文字

现有 legacy／内部语音页面新增默认关闭的“继续当前对话的最近文字”。勾选后，`POST /voice/session` 接受当前 `conversationId`；客户端不能提交历史数组。服务端核对固定登录会话与会话所有权，返回 `serverContext`，不把它当系统指令传给凭据签发器。

快照只包含最近最多 20 条已完成、非空的 user／assistant 普通文字。携带附件或音频转写引用的整条消息、工具消息、未完成消息、语音摘录和保存的记忆不进入快照。每条最多 8,000 个 Unicode 码点，合计最多 24 KiB UTF-8；只保留完整消息，遗漏以 `truncated` 告知。AI 已在普通文字中写出的分析仍是文字，当前实现没有追溯其全部材料来源。

浏览器按原顺序发送文本 item，user 使用 `input_text`，assistant 使用 `output_text`。当前协议的 `conversation.item.added` 不放行麦克风；必须收到内容、角色、item ID 和次序匹配的 `conversation.item.done` 完成回执。旧协议中带完整内容与 completed 状态的 `conversation.item.created` 也可确认。参见 [官方客户端事件](https://developers.openai.com/api/reference/resources/realtime/client-events#conversation.item.create)与[官方完成事件](https://developers.openai.com/api/reference/resources/realtime/server-events#conversation.item.done)。

数据通道、传输连接和全部上下文同时准备好后才开启麦克风；建立连接与确认共用 20 秒期限。失败、停止、账号或草稿失效会关闭连接、停止麦克风并请求释放服务端租约；释放请求未到达时，租约按原时限到期。已导入的 item ID 在整个连接期间排除出新语音摘录，包含嵌套终态输出。绑定会话的 session 只能向原会话保存摘录；原会话删除会级联删除签发标记。

这是有界的 legacy 文字接续，不是产品主理人共享记忆或实时面试的验收。产品的小组、面试官和敏感度过滤仍按 `docs/product/03-team-and-orchestration.md`、`12-voice.md` 单独实现，不直接复用这个历史快照。

实现见 [上下文契约](../../packages/platform-contracts/src/voice-context.ts)、[服务端快照](../../services/platform-api/src/voice-context.ts)与[麦克风启动控制](../../apps/web/src/realtime-context.ts)。新增迁移为 `023_voice_session_context.sql`；产品路线图中的暂定迁移编号在落地前须按已占用序列重新分配，不能复用这个编号。

## 已有摘录状态验证

前一轮七个相关网页测试文件共 **74 项通过、0 失败**：`voice-history`、`voice-draft`、`voice-personality`、`voice-account-boundaries`、`voice-conversation`、`voice-session`、`voice-playback`。该轮网页类型检查和 `git diff --check` 通过。

回归覆盖完成片段收到失败／取消及畸形或超量终态、无部分 item 关联、先更新草稿再关闭的实际公共处理函数、累计限额、旧 editor、事件顺序、去重、截断与删除。使用虚构协议事件及现有本地测试 fixture。最近文字接续的验证另行记录在 [验证记录](verification.md)；商业 Realtime、真人录音、真实手机与声音自然度均未因此得到证明。
