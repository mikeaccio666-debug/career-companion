# 独立平台生产容器

状态：本地构建与配置，**尚未部署云端**。这套容器保留通用 Node／SQL／私有 S3 接口；Render 是一种托管入口，不改变求职领域规则。Vercel 前端＋独立 API 的推荐与未完成衔接见 [部署路线](../../../docs/platform/deployment-plan.md)。

## 镜像与进程

从根目录执行 `pnpm build:platform-image`。Node 24.21.0 固定官方 registry 的多架构 index digest（含Linux AMD64／ARM64），而非本地 image ID；pnpm 固定11.13.1，依赖按锁文件安装。pnpm11.12的上游已标记 broken；采用修复版的 [官方记录](https://github.com/pnpm/pnpm/releases/tag/v11.13.1)。构建阶段编译 React，运行阶段只包含生产依赖、平台源码、SQL迁移与静态产物，`tsx` 是明确的运行依赖。

容器以非root的 `node` 用户运行。代码不归该用户写入；`/app/.runtime` 仅是可丢弃的临时目录。生产附件必须使用私有S3兼容存储，不能让API和worker共享本地blob的假设成为部署依赖。镜像不含环境文件、Argoland历史仓、模型资产、Chromium、Python语音服务或Docker daemon。

三种独立角色使用同一镜像：

```sh
/app/infra/platform/production/entrypoint.sh web
/app/infra/platform/production/entrypoint.sh worker
/app/infra/platform/production/entrypoint.sh migrate
```

脚本通过 `exec` 将SIGTERM交给Node。数据库迁移在发布流程运行一次；web／worker不自动迁库。一个release应固定同一源码版本／image digest，并验证迁移对上一版本兼容，避免独立服务自动发布到不同版本。

网页默认同源。分离前端时，在Vercel网页构建环境显式设置公开的 `VITE_PLATFORM_API_ORIGIN=https://api.example.com`；API的 `PLATFORM_ALLOWED_ORIGINS` 必须精确包含网页HTTPS origin。Docker构建也支持同名build arg，仅进入web-build阶段；其中只能是公开origin，不放密钥。优先采用同站app／api自有子域，host-only＋HttpOnly＋Lax＋Secure的现有会话cookie保留；不同平台的默认域名并不因此获得可靠的第三方cookie。API／私人媒体不经CDN共享缓存，原生下载使用已鉴权的 `?download=1` 与服务端attachment头。

## 配置

生产必须明确提供 `PLATFORM_DATABASE_URL`、`PLATFORM_REDIS_URL`、精确HTTPS的 `PLATFORM_ALLOWED_ORIGINS`、私人存储bucket／region／server-only credentials。自定义S3 endpoint必须是精确HTTPS origin；AWS原生S3可省略endpoint。私有bucket的权限仍需在真实账号验证，配置存在不证明可连接。

`PLATFORM_HOST` 默认loopback；托管入口显式设 `0.0.0.0`。接受宿主提供的 `PORT`，如果同时设置 `PLATFORM_PORT` 必须相同。只有需要同源React时设置 `PLATFORM_WEB_STATIC_DIR=/app/apps/web/dist`；独立API可以省略。静态服务只读构建产物，API／缺失asset不回落HTML。健康端点只核数据库并报告队列是否配置，不能用它代替worker存活／队列滞后告警。

商业模型、浏览器动作及CLI在例子中均关闭。正式启用模型需分别设置已支持的provider key／model和开关；语音、浏览器及CLI需要其目标环境验收和独立执行边界。普通容器不因为使用Dockerfile就能运行嵌套Docker任务。

## Render 示例

[render.example.yaml](render.example.yaml) 采用 [官方Blueprint字段](https://render.com/docs/blueprint-spec)，默认不自动发布、不生成preview：付费web＋worker、内部Postgres／Key Value，队列明确noeviction＋journal-snapshot。私人R2／S3和HTTPS域名由用户提供；未选择真实region、资源预算或bucket。示例的oregon及实例尺寸是可审阅输入，应用前须重新确认价格与延迟。高可用未默认开启，不能称为多区生产HA。

API设置私人存储配置，worker通过服务变量引用在每次Blueprint sync后同步相同值；该引用不会在API密钥更换后即时更新。轮换时先验证新权限，再sync并重新部署两角色；provider key／model／gate也应有明确的共享配置与双角色轮换流程。Render的 `sync:false` 在创建时要求输入真实配置；此文件不含可用密钥或假生产签发接口。应用Blueprint会创建付费资源和公共API，当前任务仅交付本地文件。

web的pre-deploy只阻塞该web服务，不保证worker先等迁移完成。首次发布须先完成唯一迁移，再启动相同版本的两角色；升级先停止接新任务并排空旧worker，迁移成功后更新同commit／image的API和worker。示例Blueprint不提供跨服务原子发布保证。现worker SIGTERM等待 `worker.close()`，尚未主动取消所有运行中runtime；120秒后可能被宿主终止，空闲退出不证明长任务释放完成。保留lease／unknown边界，并在目标云验证中断与恢复。[Render发布语义](https://render.com/docs/deploys)、[变量引用与同步](https://render.com/docs/blueprint-spec)

## 验收边界

已在独立虚构PG／Redis的Linux ARM64容器通过迁移、web／worker启动、nonroot＋只读rootfs、同源静态／API边界、cookie／Origin及匿名文件拒绝。HTTP仅映射localhost，fixture随后清理；S3为虚构HTTPS配置，未证明bucket连接。本地Docker启动不能证明Render发布、真实HTTPS入口、目标AMD64、R2／S3、托管队列、负载或恢复目标已通过。目标环境仍需流式取消／恢复、私人媒体Range、运行中worker中断、PITR及发布回退验收。过程与结果记录在 [验证文档](../../../docs/platform/verification.md)。
