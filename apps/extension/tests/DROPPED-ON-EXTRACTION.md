# 抽仓时丢下的测试（2026-09-15）

以下四个测试直接 import `apps/api/src/...`——它们测的是**插件与 job-agents 后端
实现的契合**，不是插件自己的行为：

- `pilot-ua2-choice-context.test.mjs`
- `pilot-ua5-content-entrypoint-deadline.test.mjs`
- `pilot-ua5-original-source-roundtrip.test.mjs`
- `pilot-ua5-profile-primary-links.test.mjs`

本仓只装插件，`apps/api` 不在这里；而目标后端 argoland 也没有 `pilot/ua5/*`
这三条路由（只有 `pilot/ua2/classify`）。所以它们在这里没有对象可测，一并裁掉。

UA5 那块能力如果 argoland 产品要，届时在那边重建对应的联合测试；插件侧的
`pilot*` 运行时代码仍在仓里，没有一并删除。
