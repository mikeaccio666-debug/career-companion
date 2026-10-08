# 真人预约的人工排期记录

对应产品 04 §3.5、05 §2.15、06 §6.3 与 07 P0-12；前置为 [真实匹配与报价](mentor-quotes.md) 和 [离线收退款记录](mentor-payments.md)。

## 实际路径

运营在产品外与用户、导师确认已有匹配时段和会议链接，用真实有效的本机构 ops / org_admin 账号记录 `matched → scheduled`。本层不自动创建会议、访问链接、发送消息或代操作日历。`scheduled_at` 是实际约定开始时间；密文保存双方确认时间与 HTTPS 会议链接，不把链接写入 SQL 索引、CLI 输出、审计或日志。原匹配的导师、时区、时长、开始时间不能通过排期命令替换；改期/重新匹配尚未实现。

排期命令须含双方明确确认和运营本人保存的实际 userConfirmationRef / mentorConfirmationRef。来源读实际上传表与文件字节、强 ETag；同一份双方共同确认文件可以提供两个引用，但服务器不独立判断文档内容是不是双方真实确认。运营必须保存真实依据，勾选不能替代文件。新记录重新核对当前导师角色、资料版本、服务时段及原容量证明，且时段必须在数据库当前时间之后；写入后再次核对时间与用户授权。

072 扩展原不可变操作回执：schemaVersion=3，捕获实际命令、记录摘要、运营与用户授权版本、文件版本、当前容量证明。账号/机构/操作编号隔离，原操作只发生一次；重试返回当前状态及原 appliedRevision。账号授权、真实员工身份、审计、意向记录和回执在同一事务里，失败或中止全部回滚。原 create / match / cancel 回执仍按旧 schema 读取，不改旧摘要或隐私默认值。

## 取消、付款和占用

用户在 requested / matched 阶段仍可自己取消；scheduled 阶段只能由运营根据真实取消凭据记录 `cancel_scheduled`，不提供公开排期或运营代签发接口。取消释放原时段占用；未支付 quote 作废，已支付/退款记录保留。退款以真实收款与实际退款凭据单独记录，不以取消自动退款。产品文档里的退款比例是待蔓藤确认的假设，本层没有把它当作实际退款承诺。

排期、付款是独立状态。quoted 订单也可以记录双方已确认的排期，随后补记真实线下付款（重新检查当前服务、导师及未来时段）；不会把排期视为付款。原报价、实际付款/退款不随履约版本一起改写。已排期的时段继续占用原完整窗口，不因源资料变化或后续读取自动释放。

## CLI 与 Web

`pnpm --filter @companion/platform-api mentor-scheduling record --org UUID --session-file PRIVATE_FILE --input-file PRIVATE_FILE`。

文件沿用本人所有、非软链接、600 权限与大小限制；session-file 必须是真实当前员工登录。本层不创造用户会话。schedule 输入含 action、operationId、sessionId、expectedRevision=2、confirmedAt、meetingUrl、两份确认引用与两项明确确认；cancel_scheduled 含 action、operationId、sessionId、expectedRevision=3、occurredAt、evidenceRef、confirmRecorded=true。无状态、价格、ownerId、外部通知或开始时间输入。

现有本人意向/订单/原操作 GET 同时支持 scheduled 与排期后 cancelled。公开接口仍受真实登录、当前账号、法律同意、限流和 private, no-store 保护；回包没有确认文件、容量凭据或运营权限。只读运营意向/订单不暴露会议链接。Web 显示「已约好」、实际时区的确认时间和会议链接；链接用 noopener、noreferrer 与 no-referrer。取消和暂停后不渲染链接；私人数据仍只存账号内存，不持久化到浏览器。

## 验收与未完成项

本分支 16 项新增排期场景、合计 138 项相关 API 检查、762 项完整 Web 测试、workspace 类型检查与 Web 构建通过。构建仍有现有入口超过 500 kB 的警告。检查使用 edaix-dev 上隔离的 PostgreSQL schema、虚构资料、私有实际文件、密码 cookie HTTP、真实私有文件 CLI 和 Web 静态渲染；商业调用为 0。主数据库、主预览没有迁移或刷新，本分支没有合并、部署或实际预约。

还缺 completed、会后 1–5 分与跳过、主线逐次系统通知、旅程预约卡、正式改期与申诉、专用付款入口、免费诊断/排队权益和 PaidSuggestionPolicy。浏览器视觉及真实履约尚未验收。

确认原始文件归运营上传账号；删除学生账号会清除意向、链接和私人回执，但不自动删除运营原始文件（与付款来源同一限制）。真实运营启用前需要确认文件最小化、按客户删除流程、期限/备份政策及合作方确认；本层未提供生产隐私/法律批准。
