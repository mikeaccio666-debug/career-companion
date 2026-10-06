# 外部工具的 MCP 接入

本次实现服务器审阅目录中的工具发现、账号连接授权、待审阅任务、worker 调用与私有结果读取。它使用锁定的 `@modelcontextprotocol/client` 2.3.1；不是任意 MCP URL 输入框，也尚未接入 Gmail、蔓藤服务或第三方 OAuth。网页和手机网页共用平台账号与任务接口。

## 用户路径与执行边界

1. 设置或“外部工具”页读取服务器目录。目录未配置时显示空状态。
2. 用户点击连接，服务器实际执行工具发现。只有名称和完整输入／输出 schema hash 与目录一致的工具才可选择；发现失败不会显示已连接。
3. 用户填写 JSON 参数并准备任务。服务器保存账号、连接、授权版本、工具定义和参数快照，返回待审阅审批；准备不调用工具。
4. 审批卡显示固定参数，用户明确批准后任务才进入队列。worker 再检查账号、审批、授权版本、定义与租约，并在实际调用前写入 durable started 回执。
5. 结果保存为私有 JSON，可分页读取或把引用带回 Agent 草稿。引用不复制正文、不自动发送、不加载结果中的链接；发送后模型通过专用读取工具获得 `untrusted_mcp` 内容。

目录只容许运营方审阅的读取工具。MCP annotations、描述与工具结果不能证明工具无副作用或授予新权限；服务本身仍需验证。当前不支持写邮件、提交申请、任意终端命令、sampling、自动补充登录信息或额外权限。连接只表示本平台 grant；服务凭据不代表用户自己的 Gmail OAuth。

撤销增加授权版本，旧审批和排队任务不能继续执行。已经开始的远端操作可能无法撤回；取消也不保证远端回滚。任何工具调用已经写入 started 回执后，普通重试和队列恢复都不再重复调用。未开始调用的中断任务可在重新审阅后恢复。配置变化需要明确重新连接；已移出目录的服务不再提供连接操作。历史已保存结果仍按原审批、回执和账号读取。

## 服务器配置

默认不配置目录，不建立连接。`PLATFORM_MCP_CATALOG_FILE` 只在后端显式设置为私有 JSON 文件路径；API 和 worker 必须读取相同文件及凭据，变更后重启两者。不要把该文件、真实参数或凭据放入源码、网页变量或日志。

文件格式为 `{ "version": 1, "entries": [...] }`，最大 64 KiB、最多 20 个服务。每个服务包含：

| 字段 | 要求 |
| --- | --- |
| `id`、`name`、可选 `description` | 稳定目录标识和界面说明 |
| `url` | 明确 HTTPS endpoint；无用户名、密码、查询参数、fragment 或 IP literal |
| `tools` | 1–20 项 `{name, schemaHash}`，名称不可重复，schemaHash 为 64 位小写 hex |
| 可选 `bearerEnv` | 明确的 `MCP_` 环境变量名；值只在后端作为服务凭据使用 |

先人工审阅真实服务、权限和完整 schema，再使用 `services/platform-api/src/mcp-config.ts` 的 `mcpSchemaHash(inputSchema, outputSchema?)` 计算目录 hash。没有 output schema 时对输入 schema 使用现有 `workflowHash`；有 output schema 时对 `{inputSchema, outputSchema}` 一起计算。schema、endpoint、目录政策或凭据变化使旧绑定失效；不能用新发现的 schema 自动扩大授权。

`PLATFORM_MCP_FIXTURE_ORIGINS` 仅供非 production 下显式登记完整 HTTP loopback origins，production 拒绝该配置。正式 endpoint 的 DNS 解析须全部为公开地址，连接绑定已检查的 IP，TLS 仍验证原 hostname；禁止重定向、账户 Cookie 和未审阅的请求头。

每次 session 最多 15 秒、每个 HTTP 请求最多 5 秒、最多 24 请求；发现最多 3 页／128 工具／256 KiB。工具参数最多 16 KiB，保存结果最多 64 KiB，结果页默认 12 KiB／最大 16 KiB。只支持有界 JSON Schema draft-07 与 2020-12，不拉取外部 `$ref`，不补默认值或改写参数。HTTP wire 另有单请求 256 KiB／session 1 MiB 限制，压缩响应拒绝。MCP 服务自己的费用和内容保留条款需单独确认，商业模型开关不代表外部工具免费。

## 接口与分工

所有路径以 `/api/platform` 开头，采用真实 Cookie、固定账号断言、所有权校验和已有 Origin／限流规则：

| 接口 | 用途 |
| --- | --- |
| `GET /mcp/connections` | 目录与本账号连接状态；`connectable` 明确区分可重新连接和已移除服务 |
| `POST /mcp/connections` | `{catalogId}`；实际发现后创建／更新本账号 grant |
| `DELETE /mcp/connections/:id` | `{expectedGrantVersion}`；撤销当前 grant |
| `GET /mcp/connections/:id/tools` | 读取该账号已保存的工具定义 |
| `POST /mcp/tasks` | `{connectionId, grantVersion, toolName, schemaHash, arguments, goal}`；创建任务与审批 |
| `GET /mcp/tasks/:id/result` | 读取已保存结果；后续页须将返回的 `nextOffset` 作为 `offset`，并带同一 `version` |

Agent 工具为 `list_mcp_tools`、`prepare_mcp_task`、`read_mcp_result`。前两个分别读取保存的定义和准备审批，模型不能批准任务。MCP 结果不能通过通用文字成果工具绕过专用 provenance 校验。结果读取消费完整文件的 SHA256、源任务代次、原审批、回执与 artifact 绑定；跨账号在读取存储之前拒绝。

共享契约位于 `packages/platform-contracts/src/mcp.ts`；平台服务负责授权、回执和发布；transport 使用官方 SDK 与受限 HTTP；网页客户端、编辑／审批校验和 UI 分离。迁移 `015_mcp_connections.sql` 添加账号连接和开始／结果回执；本次源码发布不代表已给现有开发主库执行该迁移或完成生产部署。

## 验证范围

配置和 schema 单元测试、真实 Node loopback HTTP 的官方 SDK 协议测试、隔离 PostgreSQL 的账户／审批／任务／回执集成测试，以及网页类型检查、测试和构建分别验证不同层。具体已完成记录见 [验证记录](verification.md#外部工具-mcp)。本轮不访问真实邮箱、不调用商业模型或真实外部 MCP 服务。公开 HTTPS／真实 OAuth、组织知识权限、真实设备体验与服务成本仍需对应接入验收。

协议依据：[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。协议不替产品实施账号权限、持久化和审批。
