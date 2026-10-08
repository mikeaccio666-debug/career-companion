# 本人身份日期记录：P0 存储与 API

依据产品 05 C5、08 身份时钟、09 §3A。当前仅实现本人显式录入的私有字段；未完成 C5 对话、身份时钟页面、提醒或身份规则审阅。

## 当前行为

- 每个字段一行，加密保存完整记录（含值、自定义标签、H1B 年份、本人确认时间）。数据库只保留字段键、强制敏感度、版本和记录坐标等存储元数据。H1B 每年最多一条，自定义日期可多条；其他字段每人一条。
- program_end_date、stem_designated 固定为 sensitive，其他支持字段固定为 restricted。所有来源均为 user_entered。客户端不能指定敏感度、来源、确认时间或提醒行为。
- 日期保留本人输入的日历日；不依据日期先后推断身份。就业与 STEM 指定只记录本人明确的布尔答案；没有回答就没有记录。opt_status 是本人措辞的短文本，不代表系统核验过的法律状态。
- 待业天数是本人给出的整数及本次服务端确认时间，0 也是真实回答。未回答不默认为 0。不推算待业开始日、经过天数、剩余额度或资格；数值上限只采用存储整数边界，不采用任何身份法规限额。
- H1B 只接受本人报告的年度和 selected / not_selected / unknown；不生成中签预测、注册承诺或身份结论。
- 本批不开放 unemployment_reminder_days 和 remind_before_days；所有记录的 remindBeforeDays 恒为 null，未接任何提醒执行器。
- 全部值不进入共享记忆、准备索引、主理人/专家模型上下文、语音、Discord、晨报或通知。之后主理人仅在本人提起等产品允许的场景使用，还需要真实意图来源、渠道过滤和正式运行通道。

## API 与回执

固定当前登录会话、student 账号、账号窗口、CSRF、实际账号锁、请求取消及 private/no-store。新增/修改还须当前协议及邮箱准入；准入撤回后本人仍能读取、观察原操作和删除。账号退出或撤销会话后不能读取。

- GET /api/platform/career/identity：完整本人列表，最多 100 个实际记录；没有记录返回空列表，不生成默认身份。
- POST /api/platform/career/identity：operationId、expectedRevision=0、field、value、label（非自定义字段必须 null）。
- GET /api/platform/career/identity/:id：本人完整记录。
- PATCH /api/platform/career/identity/:id：operationId、expectedRevision、原 field、新 value、label；字段类型及 H1B 年份不能改用另一种记录。
- DELETE /api/platform/career/identity/:id：operationId、expectedRevision，物理删除值与标签。
- GET /api/platform/career/identity/operations/:id：只读观察原操作和当前结果，删除后 record=null。

value：日期为 YYYY-MM-DD，两个布尔字段为 boolean；opt_status 为本人短文本；待业天数为 {days}；H1B 为 {year,outcome}。保存后待业天数附服务端 reportedAt，与 confirmedAt 一致。

不可修改的加密回执只存命令摘要和坐标，不保留原值或标签。独立最新回执校验拒绝真实旧密文回滚。原 operationId 只对应原请求，重试不再生效；删除后的迟到请求不会恢复记录。回执保留到账号删除，届时与记录一并级联删除。

100 条是实现资源上限，不是身份制度规则。全列表与唯一年度检查在同一账号锁下进行，独立回执批量读取，保持实际数据库事务限制。

## 验证与后续接线

虚构资料的真实 PostgreSQL、密码登录 HTTP、契约测试覆盖加密、强制敏感度、跨用户与员工隔离、CSRF/窗口边界、版本竞争、年度唯一性、原操作观察、删除后重试、旧密文回滚、准入撤回、会话失效回滚、100 条完整读取、重复迁移与账号级联删除。商业模型关闭。当前 35 项真实数据库 / HTTP 检查（含旧记忆与既有方向接口回归）、47 项契约测试、契约与 API 类型检查通过，无跳过。

未更新主预览数据库或页面；无付费调用、提醒、部署或 PR 合并。本批 API 不等同于完成 P0 的身份时钟体验。

下一批页面与 C5 必须读真实 O2 身份选择：other / prefer_not_say 或跳过时不展示 C5、身份时钟块或补填提示；今日仅显示本人确实填过的值。不得把这些值带入 C6 卡、第一封信或 Discord。正式身份正文使用产品规定页脚：“信息与提醒，不是法律意见。涉及你个人身份的决定，请先和学校 DSO 或移民律师确认。” P0 不显示倒计时或推算结果。专业审核与授权未完成前不启用提醒。
