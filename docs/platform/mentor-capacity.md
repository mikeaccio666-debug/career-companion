# 真人导师与可约时段的运营来源

对应 [04 §3.5 / M0-7](../product/04-manteng-assets.md)、[06 §6.3](../product/06-business-model.md) 和 [07 P0-12](../product/07-first-cohort-mvp.md)。前置是 [真人服务价目](mentor-service-offers.md) 和 [本人预约意向](mentor-intents.md)。这是 P0 人工匹配需要的私有来源，不是向学生开放的导师网络目录（M1-3）。

## 来源与权限

导师必须有真实员工账号、已验证的邮箱和本机构当前有效的 `mentor` 角色。运营通过自己的实际 `ops` / `org_admin` 账号录入姓名、时区、语言、三种已支持的付费服务，以及签署时间、守则版本和私有凭据。守则、保密协议与雇主政策均须逐项明确确认，不能省略或推断。只接受当前 `mentor-conduct-v1`；免费诊断与内推评估没有在本层开放。

审核凭据和时段确认凭据必须已经在操作者自己的实际私有上传中保存，且真实文件存在、大小与强 ETag 版本一致。资料和证明密文保存；文件来源 ID、上传者、文件版本、命令和修改者不返回目录。录入声明与文件存在**不等于系统验收了签字或法务批准**；M0-7 的真实导师守则、保密、雇主声明与运营流程仍须人工审核，不能用测试资料替代。

导师录入不会授予聊天、记忆、身份日期、学生意向或导师房间访问权限；没有外发通知、CRM、营销联系、支付或模型调用。

## 时段与版本

时段记录明确的 UTC 起止时间、显示时区、服务类别、导师资料 ID / 当前版本、本人确认时间和实际凭据。窗口须是 1–240 分钟整分钟，开始时间在最终数据库时间之后；不接受未带时区的本地时间。时段可用不等于已预订，也不保证学生已经获得名额。

导师资料更新、撤下、角色撤销、邮箱验证消失或凭据丢失，会使对应旧时段不可用。重新启用资料产生新版本，旧时段仍须重新引用新版本并由运营确认；重放旧命令不会恢复已撤下的资料或时段。

同一导师的窗口检查覆盖其多个机构，按导师的事务锁串行验证；重叠窗口拒绝，相邻窗口允许。比较前认证已提交窗口的密文、SQL 状态/时间投影及最新不可变证明；不会因为 SQL 状态或日期被修改就把真实窗口漏掉。冲突回复不含另一个机构的姓名、组织或排期。所有操作受现有数据库连接/锁/语句/事务时限约束；大量历史窗口的读取成本需要在上线容量测试中实测，本层未宣称生产容量达标。

## 存储、幂等与审计

069 迁移添加 `platform_mentor_capacity_records` 与 `platform_mentor_capacity_proofs`。记录索引只保留机构、实际导师账号、记录类型、当前版本/状态、时段范围与来源引用；姓名、语言、时区、签署/确认事实与原命令为密文。SQL 约束绑定同机构、同导师的真实 profile，以及 profile 的实际已接受版本。

每次变更有不可变证明和机构内唯一的操作 nonce。首次写入、原命令重试和观察均需真实当前员工身份；相同 nonce 与不同命令冲突。返回当前状态和版本，同时单独标明原操作的 `appliedRevision`，不将历史成功当成当前可用。资料 ID 不能跨机构 upsert，导师身份不能被替换。

查看、修改、撤下、观察都写员工审计。员工类型、机构状态或操作角色拒绝写现有 deny 审计；过期或失效会话不接受操作。审计提交失败不返回内容，并回滚同事务的来源/证明。真实导师账号或机构删除会级联清除该来源、时段及不可变证明；不提供公开物理删除或批量导出接口。

## 操作与读取

使用项目固定 Node / pnpm：`./scripts/project.sh pnpm --filter @companion/platform-api mentor-capacity ACTION ...`。

- `profile`、`slot`、`withdraw`：`--org ORG_ID --session-file PRIVATE_FILE --input-file PRIVATE_FILE`。
- `list`：`--org ORG_ID --session-file PRIVATE_FILE --kind profile|slot`，可附 `--after RECORD_ID`。
- `observe`：`--org ORG_ID --session-file PRIVATE_FILE --operation-id ORIGINAL_NONCE`。

session 文件是 `{userId, token}`；文件必须本人所有、普通文件、非符号链接、权限严格为 600；命令行不接受令牌、任意角色或任意审核状态。变更仅输出来源坐标、当前/应用版本与当前状态；不输出姓名、审核凭据、密文、邮箱或凭证。列表返回运营需要的资料或时段及当时的 eligible 判断，不返回学生信息。完整命令闭合契约在 `packages/platform-contracts/src/mentor-capacity.ts`；不要把真实输入存进仓库。

HTTP 只提供真实登录、`x-companion-account` 和员工组织授权下的读取，响应 `private, no-store`：

- `GET /api/platform/staff/orgs/:id/mentor-capacity/profiles`
- `GET /api/platform/staff/orgs/:id/mentor-capacity/slots`
- `GET /api/platform/staff/orgs/:id/mentor-capacity/operations/:operationId`

列表最多 50 条，有实际来源锚点分页；锚点必须属于同机构同类型。除列表 `after` 外，不接受额外、重复查询字段。没有 HTTP 写入或学生导师目录。

## 验收与仍需完成

虚构资料走真实 PostgreSQL、强版本的本地文件存储、密码 cookie HTTP 和实际 CLI，外部模型请求为 0。覆盖来源/身份/组织、明确签署确认、源版本失效、原操作观察、并发和跨机构冲突、篡改/旧密文回滚、51 条完整分页、审计失败、账号过期、SQL 插入后的取消回滚、导师/机构删除与重复迁移。实际导师与法律材料、学生匹配、订单、付款、履约和生产容量尚未验收。 本轮 91 项不同的相关 API 检查（其中新增 23 项）与完整 workspace 类型检查通过；路径解析修正后重新通过相关 31 项路由/容量检查及 API 类型检查。

本轮没有创建 `matched` / `scheduled` / `completed` 状态，没有改动意向表和主预览。下一步须将真实导师/时段与学生意向及当时显示的价目证据绑定，再推进报价、订单、排期、未完成阶段取消、系统通知、旅程预约卡和评分；免费诊断的真实 cohort 激活、一次权益/有效期/队列与付费建议政策仍是 P0 未完成项。
