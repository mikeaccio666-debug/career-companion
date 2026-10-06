# @edaix/contracts — 前后端共享契约

本 package 是单仓内正式 HTTP/SSE wire shape、稳定错误码、ExecutionIntent 与 owner Profile V2
定义的 executable authority。`apps/api/docs/AGENT-API-CONTRACT.md` 说明语义、安全、版本与 endpoint；
runtime 与 consumer 必须导入这里，不得各自手抄近似 shape。`scripts/check-contract-drift.mjs`
对端点、章节、闭集与严格切片做双向 parity。

Additive、向后相容的契约改动是 L1：domain owner 决定，一位 boundary reviewer，在同一 PR 同步
contract、runtime validation、consumer、测试与契约说明。破坏性、持久化、Auth/ownership 或公开兼容性
改动是 L2-T，按 SOP 提供 migration／rollback／release plan。只有同时改变产品七类红线时才加 L2-P 三人审批。

## 当前状态

- `src/index.ts` 及同级模块 —— 同仓 `apps/api/docs/AGENT-API-CONTRACT.md` 的稳定 HTTP/SSE
  类型镜像：25 个 Agent HTTP 端点、10 个既有
  auth/session/extension 端点、按目标职位建立的多个 Role Conversation 与多 Persona、Action Card、推荐 batch、
  Mission 闭合状态机、逐事件消息 SSE、ExecutionIntent/JWKS/claim/receipt，以及稳定错误码和
  逐端点 allowlist。`JobCardView` 的 `scoreScale` 固定为 100；reason／risk／missing code
  分别使用独立闭集，不允许跨栏混用。
  另含 §5.13 的 3 个 owner Profile V2 GET/PATCH/DELETE 端点、完整 snapshot/PATCH wire、
  固定 200 success、revision + deletionEpoch fence、逐字段 authority 闭集与 no-store/no-ETag policy；
  Profile schema version、request/collection limits 与 closed-set manifest 均由 parity 精确双向比对；
  closed set 由 source/mirror 动态发现并按名称、成员与顺序比较。
  这是静态 wire 类型，不替代 hostile network boundary 的运行时校验。
- `src/calendar.ts` —— T1-3 ATOMIC Calendar 候选的稳定类型和 strict parser；runtime 默认关闭，
  生产放行仍需本批 review／migration／release。旧 draft/calendar 保留相容 re-export。
- `src/draft/` —— 尚未完成正式评审的前端契约：T10 浏览器通道原型，以及
  account、application-profile 的阶段性 DTO。它们经明确的
  `@edaix/contracts/draft` 子路径提供，但不进入稳定根导出。

稳定 HTTP/SSE 入口只有 `@edaix/contracts` 根导出；调用 draft 子路径代表调用方
明确接受其待评审状态，避免原型形状被误当成后端 wire authority。

### Shared ledger validation and local MCP adapter results

`src/applicationLedgerWire.ts` owns the existing strict ledger/time-zone response decoders, moved from Chat without changing accepted HTTP shapes. Chat re-exports them; the read-only MCP server imports the same decoder. Existing decoder regression tests moved with the implementation.

`src/mcp.ts` exports the additive local `McpAdapterResult` and `MCP_ADAPTER_ERROR_CODES`. These describe historical adapter failures, not new platform REST endpoint errors. The active web MCP integration uses separate [platform contracts](../platform-contracts/src/mcp.ts) and [platform setup](../../docs/platform/mcp.md); there is no active `packages/mcp-adapters` workspace package.
