# 学生组织关联与入口审计的本人导出

依据 09 §11、13 §4.5，AccountOrganizationHistoryExport 接入 platform_org_roles 和 platform_staff_audit。共享组织表不自动等于非个人数据；本人访问员工入口被拒绝也是真实历史。

## 内容和归属

organizationMemberships 保留 user_id 为本人的组织 ID、角色、状态、授予与撤回时间；不带 granted_by 或其他成员。kind=stored_membership_metadata 只表达保存过的状态。学生即使残留 active membership，真实 StaffAccess 仍因 account_kind=student 拒绝，不因导出获得员工权限。

organizationAccessEvents 保留原事件 ID、动作、结果、原因、目标、记录计数和时间，不输出其他账号 ID 或员工角色。actor=self 表示本人发起；other_account 表示其他账号，不断言对方当前或过去一定是员工。归属按实际 writer 的目标类型限定：

- 本人发起的所有审计记录：relation=own_action，保留真实请求的原目标，包含拒绝。
- org_entitlement_changed 的 target_id 等于本人：relation=account。仅原审计动作与结果，不带 entitlement ID、revision、audience grants 或权益内容。
- mentor_intent_matched、mentor_payment_recorded、mentor_schedule_recorded 的目标是本人 session 且 org_id 一致：relation=mentor_session。付款动作实际也以 sessionId 为目标，不能误当作 orderId。
- 组织、内容、目录、容量等目标不因 UUID 恰好等于用户或 session ID 就关联；没有具体学生目标的批量读取不被推断为查看过本人。

审计表是原数据库元数据，没有额外密文或签名，因此不声称验证了密码学证据或真人阅读。校验字段结构、allow/deny 组合、状态、时间、目标归属；原表计数防止遗漏完整页面。导出不生成新的访问事件或修改组织权限。

## 执行边界

复用账户的再验证与 REPEATABLE READ 事务。两张表按稳定 ID / 复合键每页 100 条，不取行锁；开始与结束验证固定会话。当前组织停用、角色撤回、模型同意撤回、邮箱未验证不会改写原历史。超限、损坏、跨用户坐标、取消或认证变化时整份捕获失败，并回滚再验证凭据消费。

04 §4.11 的权益与知识访问日志豁免保持不变；本实现不查询、解密或修改这些表，也不检索共享知识库。组织信息可能作为真实审计 metadata 出现，但不是完整知识或权益导出。两张混合历史凭据表仍在 remainingTables；具体范围提案见 [组织记录审阅](organization-export-review.md)，尚未用实现代替产品决定。

## 当前范围

JSON 当前覆盖 141 表、剩余 23；带文件 144、剩余 20；既有豁免 7，共 171。其余 20 张 organization_review 仍需处理，JSON 另有 3 张文件表。两种捕获保持 complete=false，完整自助下载、归档任务和删除协调仍未完成。本批无 schema、UI、部署或主预览修改。

专项使用虚构账号和真实隔离 PostgreSQL 的 StaffAccess/OrgKnowledge 路径，覆盖拒绝、明确本人目标、活跃/撤销 membership、105 行分页、未知/串户/缺页、取消与会话失效、UUID 命名空间冲突。原知识库用例继续断言豁免表不被读取、权益和授权全文不出现在归档中；真人服务用例验证匹配、排期及退款审计关联。最终结果见 [验证记录](verification.md)。
