# 真人服务目录前置层

实现范围对应产品 [04 §3.5](../product/04-manteng-assets.md)、[06 §6.3 / §12.4](../product/06-business-model.md)、[07 P0-12](../product/07-first-cohort-mvp.md)、[08 ServiceCard](../product/08-design-system.md) 和 [09 第 8B 步](../product/09-implementation-roadmap.md)。

## 已实现

- 067 迁移建立 `platform_service_offers`，单个机构同一服务类别最多一个 active 价目；不预填价格、可约时段、合作收益关系或首批用户权益。
- 服务包含名称、用途、不承诺的结果、价格与币种、时长、收款方、退款规则版本及全文、申诉说明、利益披露版本及全文、有效期、最早可约时段。公共 DTO 固定带意向隐私说明，不包含审核凭据或员工身份。
- `MentorServiceOffers.set/withdraw/staffList` 只给实际 ops / org_admin 员工，复用真实 session、机构与角色锁；成功和权限拒绝写员工审计。配置和操作回执加密，版本证明与回执只追加。更新需 expectedRevision，重试只确认原操作，不重发旧版配置。
- set 要求运营本人已上传的私有审核凭据，检查实际文件存在和大小；记录 reviewedAt。凭据只证明运营登记了一份文件，**文件存在和解析通过不代表律师批准、合作协议成立或导师行为准则已签署**。正式配置需负责人确认实际服务条款、利益关系和审核材料。
- 学生 `GET /api/platform/career/mentor-services/:orgId` 挂 secure / 账号窗口校验与现有 api 限流，要求真实学生账号、验证邮箱、当前协议和加密配置；只接受路径机构 ID，拒绝附加查询条件，响应 `private, no-store`。前端接入时机构 ID 来自产品的实际合作方配置。
- 数据库时间决定有效性；没有时段、时段已过去时为 unavailable，过期或撤下不返回。机构停用、权限撤销、损坏的版本证明或文件不会被包装成可预约。available 是运营登记的最早可约时段，**没有预约名额预留、支付或执行权限**。后续提交还需按实际服务和面试截止时间重新检查。
- 每次读取最多检查 100 份目录记录，超限失败；日常更新沿用同一 offerId 与版本，避免无限追加目录。

## 运营 CLI

在远端受控环境执行 `./scripts/project.sh --filter @companion/platform-api mentor-services <set|withdraw|list> --org <organizationId> --session-file <privateSessionFile>`。set / withdraw 另需 `--input-file <privateInputFile>`，list 不接受输入文件。没有 HTTP 配置写接口。

文件须为本人所有的普通文件、权限 600，不接受符号链接、共享文件、重复参数或命令行 token。session 文件字段为 userId / token；命令输出只有 offerId / revision / status，不输出服务条款、审核文件或凭据。异常只输出固定提示，不打印输入或底层异常。

set 输入：operationId、offerId、expectedRevision（首次 0）、terms、reviewedAt、reviewEvidenceRef。terms 的闭合字段和类型见 `packages/platform-contracts/src/mentor-service-offers.ts`。withdraw 输入：operationId、offerId、expectedRevision、reason。审核凭据通过已有私有上传服务登记；此 CLI 不迁移数据库、不上传文件、不启动队列、不调用模型、不发送消息和不收款。

## 后续与上线闸门

本层没有完成 P0-12。接下来仍需：真人与社区 / 我 的 ServiceCard 与意向表、用户主动写 intent_note 和逐项可见信息确认、sessions 和 orders、运营审计读取、人工匹配 / 履约状态、服务端 system 通知、会后评分。意向不自动带对话、记忆或身份日期。

免费诊断的 cohort 身份、激活第二周与 60 天期限须接真实权益和明确激活来源；本层不把注册时间或主理人出生时间冒充权益激活。免费服务和内推评估不在此配置入口开放，不改变产品已规定的免费诊断范围或内推法律闸门。

付费建议仍需 PaidSuggestionPolicy、实际可约时段检查及推荐频率护栏；没有接入主理人引擎或营销推送。线下订单、handoff_code 专用付款链接、退款结果、导师行为准则、协议和隐私审查仍是后续工作。没有复用旧 Argoland commerce。

## 验证与限制

虚构机构、审核材料和学生穿过真实 PostgreSQL、文件存储、密码登录和 HTTP。测试覆盖版本与并发、重复请求、学生/员工角色、真实时间、撤下、证据缺失、密文/回滚破坏、abort、审计失败和账号窗口。它们不代表真实价格、导师容量、法律审核或线上履约验证。本轮没有 UI 改动、正式数据导入、付费模型调用、真实预约或部署。

本轮 72 项不同 API / 契约运行验证通过，完整 workspace 类型检查通过，新增 CLI 与组织删除验证后 API 类型检查再次通过；未改网页 UI，因此未重复 Web 构建或浏览器验收。
