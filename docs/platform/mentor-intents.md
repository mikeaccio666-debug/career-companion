# 真人预约意向与运营只读入口

对应 [04 §3.5](../product/04-manteng-assets.md)、[06 §6.3](../product/06-business-model.md)、[07 P0-12](../product/07-first-cohort-mvp.md) 和 [08 ServiceCard](../product/08-design-system.md)。前置为 [实际服务目录](mentor-service-offers.md)。

## 实际流程

学生先读 entry：服务端提供当前真实邮箱、版本化的隐私说明和合作机构的有效价目。提交时填写自己希望运营使用的称呼和想聊的内容，显式确认可见范围；不推断确认，不预填需求或读取任何聊天、记忆、身份日期。邮箱由真实账号读取，不能指定其他收件地址。

create 复核学生、验证邮箱、当前法律协议、真实 session、当前配置的机构、实际审核文件、目录版本和数据库时间。服务或可约时段已变就拒绝，并要求重新查看。源目录和提交共用真实事务与组织锁，不创建另一个持有相同账号锁的连接。

成功只建立 requested 意向，mentorId / orderId 为 null。用户可在 requested 阶段取消；这不是已匹配导师、排期、报价或收款。重复 nonce 只确认原操作，读取当前状态；已取消后重试创建不会恢复 requested。取消、原操作观察和分页都按真实账号隔离。

## 存储与可见范围

068 迁移建立 platform_mentor_sessions 和 platform_mentor_intent_operations。sessions 不含价格或支付字段；称呼、邮箱、本人文字和完整状态以密文保存。SQL 留归属、服务引用、版本、状态和数据库时间等索引元数据。mentor / order / packet / scheduled / review 坐标留空，本层不写入后续履约。

第一次不可变操作回执密文保存当时实际展示的 offer，作为后续人工报价不得高于当时展示价格的证据；**没有创建 quoted 订单**。回执不通过学生或运营列表返回。所有回执认证 owner、操作、记录、版本、内容摘要和实际时间；读取核对当前记录、创建操作与最新操作，不能恢复旧有效密文来撤销已确认的取消。

运营只能用实际 ops / org_admin 员工账号、当前有效机构角色读取本机构。列表只返回称呼、邮箱、本人写的需求、类别、时长、状态、请求 ID 和提交时间；没有用户资料、对话、记忆、身份日期、审核材料、账单或可用于房间访问的 token。每次成功或权限拒绝写已有员工审计；审计提交失败不返回任何读取结果。没有运营发言者、销售 CRM、微信/邮件外发或用户资料导出。

个人数据随账号删除级联清除，包括不可变回执；机构实际删除也清除本机构意向。公共操作只取消意向，不提供绕过不可变回执的物理删除接口。

## 配置与接口

PLATFORM_MENTOR_ORG_ID 是服务端可选 UUID 配置，不接受客户端组织选择。未配置时 entry 明确 configured=false、无价目，提交失败，不种默认机构或免费诊断权益。它不会启用模型、付费建议或外部发送。

学生接口挂真实登录、账号窗口与 api 限流；实际服务内部仍检查邮箱、学生身份、当前法律同意和密文配置。响应 private, no-store：

- GET /career/mentor-intents/entry：实际邮箱、隐私说明和可约服务。
- GET /career/mentor-intents：本人意向，最多 50 条；after 只能指向本人现有记录。
- GET /career/mentor-intents/:id：本人记录。
- GET /career/mentor-intents/operations/:id：原操作回执坐标与记录的当前状态。
- POST /career/mentor-intents：operationId、offerId、offerRevision、contactName、intentNote、privacyVersion 和 confirmVisibility=true。
- POST /career/mentor-intents/:id/cancel：operationId、expectedRevision=1。
- GET /staff/orgs/:id/mentor-intents：经审计的运营只读列表，同样最多 50 条，分页锚点限本机构。

路由前缀为 /api/platform。除列表的 after 外，附加查询字段、重复查询数组、伪造邮箱、价格、状态、组织、导师、记忆附件及未支持的免费/内推输入都拒绝。契约在 packages/platform-contracts/src/mentor-intents.ts；请求客户端在 apps/web/src/mentor-intent-api.ts，绑定调用开始时的账号，解析闭合响应并核对原操作、本人、服务版本和输入，不包含 UI 或本地存储。

## 仍需完成

真人与社区 / 我 的入口、ServiceCard 和意向表页面、异步确认的 controller 尚未加入本轮页面。现有预览和主要数据库没有更新，不把请求端口当成可见 UI。

P0-12 还缺真实人工匹配、订单与线下收款外部引用、scheduled / completed、未完成阶段取消、旅程预约卡、系统通知、1–5 分评分、免费诊断真实 cohort 权益及明确激活来源、排满队列，以及 PaidSuggestionPolicy。匹配/报价时仍必须再次复核实际可约时段，报价不高于保存的展示价格。导师行为准则、合作条款、运营隐私和实际响应时限仍是上线前的人工确认项。本层不承诺真人已阅读、48 小时履约、实际可约名额预留或付费建议闸门已经通过。

## 验证

虚构学生、机构和审核文件穿过实际 PostgreSQL、文件存储、密码 cookie HTTP 与 Web 请求客户端；0 外部供应商请求。覆盖真实源和可约时间、明确可见信息确认、并发与重试、本人/机构隔离、取消不复活、51 条完整分页、密文/旧版本破坏、账号/机构删除、审计失败、SQL 实际插入后的 abort 回滚，以及真实时段在读取中失效。浏览器表单、真人履约、真实价格、法律批准与生产容量未做验收。

本轮 90 项不同的相关 API 验证和 5 项 Web 请求边界验证通过；完整 workspace 类型检查通过。新页面和浏览器交互没有在本轮实现或验收。
