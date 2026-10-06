# 独立申请服务：第一段迁移

这是新产品的独立服务边界。当前提供本地规则检查和严格的纯函数，不是完整的申请后端。

从仓库根目录运行：

```sh
pnpm install
pnpm --filter @career/application-service dev
pnpm --filter @career/application-service check
pnpm --filter @career/application-service test
```

默认只监听 `http://127.0.0.1:4310`。`APPLICATION_SERVICE_PORT` 只修改本地端口；不读取旧仓 `.env`，不连接数据库、支付、邮件或模型。

| 接口 | 当前行为 |
| --- | --- |
| `GET /health` | 返回健康状态，以及 `referenceOnly: true`、`executionEnabled: false` |
| `GET /api/v1/automation/rules-release` | 校验规则解释、映射与摘要后返回参考规则，支持精确 ETag/304 |

`rules-release` 不是旧 `execution-runtime-bundle`：它没有政策、时效围栏、签名意图或执行租约，不能用作浏览器写入权限。旧签发、claim、资料、回执和登录路由均不挂载。

`src/security/` 提取了 Argoland 的 ES256 签名、V1 验签、轮换公钥配置、规范 origin、profile 字段注册表及摘要逻辑。只支持已共用的 **V1 验签**；V2/V3 必须拒绝，不能丢掉新字段后降级。签名类是内部密码学工具，不验证用户所有权、任务审批、资料版本、提交边界或租约，调用它不会获得申请授权。生产签发只能在这些检查完整迁移后实现。

后续实现应通过新产品自己的身份、档案、材料、授权、任务和执行账本适配器接入这些纯函数。`imports/argoland/` 保留旧实现和来源，不能作为服务运行时依赖。

详见 [后端审计与迁移边界](../../docs/backend-migration.md)。
