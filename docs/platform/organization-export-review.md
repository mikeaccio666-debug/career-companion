# 学生账户的组织记录导出审阅

本文件记录实现审阅与待确认项，不修改 docs/product/ 的产品决定。学生导出保持 complete=false，未确认的记录继续在 remainingTables 中；不通过调整覆盖清单掩盖缺口。

## 已有规则

09 §11 要求本人关联记录有导出或写明豁免理由；04 §4.11 明确排除 platform_knowledge_access_log 与 platform_user_entitlements。04 §4.9 不提供组织知识批量导出；09 §11 要求学生与员工权限分离。是否属于学生资料，须根据实际字段与调用路径决定，不能只看表名有 org 或 policy。

## 可以直接实现的本人记录

platform_org_roles：只导出 user_id 为当前学生的已保存 membership 元数据（组织、角色、状态和时间）；不输出 granted_by 或其他成员。这些记录不授予学生员工权限。

platform_staff_audit：导出本人执行的入口访问记录，包括真实拒绝；以及 target_id 明确等于本人账号、本人 mentor session ID（匹配、付款或排期动作） 的事件。按实际动作类型确认 target_id 的命名空间，不把 organization/source/offer 等相同 UUID 误认成学生。输出 actor=self/other_account、关联类型、动作、结果、原因、原目标与计数、时间；排除其他账号 ID 和员工 role。没有具体本人目标的批量访问不被推断为看过本人资料，也不输出其他学生的记录。元数据是原数据库记录，不声称存在密码学签名或真人阅读证明。

## 待确认：被排除权益的历史凭据

实际实现中，platform_org_content_state_proofs 在 kind=entitlement 时含 user_id；platform_org_content_operations 的加密回执保存 entitlementId/revision。它们对应同一份被 04 §4.11 排除的用户权益，不能因表名不同而绕过原排除规则，也不应擅自把混合表整体豁免。

两种具体方案：

1. 延续权益不导出的语义（建议）：同一 entitlement 对象的 proof/operation 也不输出 ID、组织关系、revision 或摘要；记录明确的逐类豁免，并在删除时仍处理原始权益和历史关联。混合表内其他对象继续单独审阅，不豁免整个表。
2. 允许导出历史元数据：只输出属于本人的组织 ID、entitlement 对象 ID、operation ID、revision 与动作；不输出 audienceGrants、正文、员工身份、密文或 digest。需要先更新 04 §4.11 的范围说明。验证需要只读检查本人的当前权益密文和原 proof，并扫描相关组织的加密 operation 页面以关联对象；不调用知识检索，不写访问日志，不改变权限。旧历史没有原 grant payload，因此只能验证原凭据，不能重建历史授权详情。

尚未选择方案；当前活跃实现不导出这两张历史表，也不读取被排除的权益或知识访问日志。实验草稿仅在忽略目录内，不进入源码或公开 PR。

## 其余表的实际边界

| 表组 | 现有归属与待处理点 |
| --- | --- |
| companion_identity_assets / companion_identity_policy | 共享候选词与员工审核资料；本人实际候选和选择已由 identity 导出；需要区分使用者记录与审核人的历史 |
| safety_delivery_assets / safety_delivery_review_operations / safety_delivery_policy | 共享提示与员工审核/会话凭据；本人实际提示和展示已在安全历史导出，不能复制员工 session hash 与审核密文 |
| safety_detector_policy / safety_response_policy / terms_policy / cost_global_policy | 当前全局政策与 operator 身份，不替代本人的原同意、消费和安全记录；需审阅历史操作者关联 |
| content_licenses / org_knowledge_batches / org_knowledge_sources / org_knowledge_passages | 许可合同、共享内容和编辑/审核人，不是学生私有知识库；04 §4.9 不提供批量导出 |
| service_offers / service_offer_proofs / service_offer_operations | 共享目录、审核材料与配置历史；本人接受条款已在真人服务意向/订单导出，不能按当前目录改写 |
| mentor_capacity_records / mentor_capacity_proofs | 真人导师资料和时段属于员工与组织；本人匹配/预约已由 mentor 导出，不能泄露其他时段或其他学生预约 |

以上 18 张共享/员工表和两张混合历史表仍待完成逐表决定与实现；本批不将其直接改成 nonpersonal。学生目前不能使用员工账户导出；员工自己的数据导出不能从学生投影中推定已完成。
