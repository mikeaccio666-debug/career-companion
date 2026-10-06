# 抽仓时丢下的东西（2026-09-15）

本包是从 `edaix-job-agents` 抽过来的**过渡拷贝**：wire 权威最终归 argoland
（`src/career-team/contracts/`），本仓要收敛成消费发布包。在那之前，这里记下
抽仓时删掉了什么、为什么，免得以后当成凭空消失。

| 删掉的 | 为什么 | 收敛时怎么办 |
|---|---|---|
| `tests/indeed-read-only.test.ts` | 它读 `apps/api/docs/AGENT-API-CONTRACT.md` 来核对 Indeed 只读边界。那份文档跟 `apps/api` 走，不在本仓。 | 权威迁到 argoland 后，这条断言应该在 argoland 侧对着它自己的契约文档重建。 |
| `tests/daily-report-contracts.test.ts` | 它断言 contracts 的 CI job 接了官方 IANA 时区表的重新生成。那是 `edaix-job-agents` 的 CI 矩阵，本仓的 CI 没有那条。 | 同上：这是权威仓的 CI 责任，不是消费者的。 |

其余 81 个测试文件、842 条断言原样保留并通过。
