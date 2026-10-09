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

生产必须提供同一release的 `PLATFORM_BUILD_ID`（1–128个ASCII字母数字及 `._-`，首位字母数字，不能为development／unknown）。API与worker应固定同commit／image，并共享这个标识；配置值只是部署绑定，不是镜像来源或执行成功的证明。`PLATFORM_DATABASE_POOL_MAX` 默认12，允许1–100；`PLATFORM_DATABASE_CONNECT_TIMEOUT_MS` 默认5000ms，允许100–5000ms。按各角色副本与数据库实际可分配连接数确定预算，并给迁移和诊断保留量；扩副本不会自动减小pool。

生产也要求启用账户邮件：`PLATFORM_ALLOW_ACCOUNT_EMAIL=1`、`RESEND_API_KEY`、已验证发信域下的 `PLATFORM_ACCOUNT_EMAIL_FROM`、与允许 origin 一致的 `PLATFORM_ACCOUNT_WEB_ORIGIN`，以及专用32字节AES-GCM密钥的64位十六进制 `PLATFORM_ACCOUNT_EMAIL_ENCRYPTION_KEY`。API与worker须共享相同配置和密钥。生产不能关闭邮箱验证；未验证账号只能读取自己账号、申请/完成验证及退出，不能访问工作台数据或调用模型。迁移不会把旧账号自动标成已验证。开发默认不发邮件、不强制邮箱验证。

生产还必须在服务端私下配置独立的 `PLATFORM_DATA_KEY`（32字节、64位十六进制），供初见草稿与操作输入的AES-256-GCM加密使用。API与worker必须配置同一个值；Render示例的两个 `sync:false` 项需要手动保持一致，不能各自生成不同密钥。不得复用账户邮件密钥、放入 `VITE_*`、源码或日志。开发未设置时初见存储拒绝读写；显式空值或非法值拒绝启动。当前密文格式为版本1，尚无密钥轮换或旧版本迁移流程；更换密钥会使已有记录无法解密。配置与迁移不开放学生初见入口，安全分级、主理人生成与第一封信仍需接线验收。

账户邮件由独立的数据库outbox发送，不进入模型任务队列。原始邮件正文与短期链接仅存于加密payload，成功提交供应商或过期/撤销后删除密文；供应商已接受不等于已送达。15分钟内的重试固定payload和幂等标识；创建邮件、确认发信域、实际投递与垃圾邮件表现仍须在真实供应商账户验证。配置错误会拒绝启动，不回退到日志输出或向网页返回找回秘密。详见 [账户流程](../../../services/platform-api/README.md)。

`PLATFORM_HOST` 默认loopback；托管入口显式设 `0.0.0.0`。接受宿主提供的 `PORT`，如果同时设置 `PLATFORM_PORT` 必须相同。只有需要同源React时设置 `PLATFORM_WEB_STATIC_DIR=/app/apps/web/dist`；独立API可以省略。静态服务只读构建产物，API／缺失asset不回落HTML。示例healthCheckPath使用 `/api/platform/ready`，只按数据库／迁移的就绪决定HTTP状态；执行服务降级不让整个API退出服务。另用 `/api/platform/execution-ready` 检查执行服务的连接及近期worker报告，不用它证明任务成功或供应商质量。私有运维可执行 `/app/infra/platform/production/entrypoint.sh operations`；不向普通用户提供全局诊断。详见 [运行检查](../../../docs/platform/operations-readiness.md)。

商业模型、浏览器动作及CLI在例子中均关闭。正式启用模型需分别设置已支持的provider key／model和开关；语音、浏览器及CLI需要其目标环境验收和独立执行边界。普通容器不因为使用Dockerfile就能运行嵌套Docker任务。

## Render 示例

[render.example.yaml](render.example.yaml) 采用 [官方Blueprint字段](https://render.com/docs/blueprint-spec)，默认不自动发布、不生成preview：付费web＋worker、内部Postgres／Key Value，队列明确noeviction＋journal-snapshot。私人R2／S3和HTTPS域名由用户提供；未选择真实region、资源预算或bucket。示例的oregon及实例尺寸是可审阅输入，应用前须重新确认价格与延迟。高可用未默认开启，不能称为多区生产HA。

API设置私人存储配置，worker通过服务变量引用在每次Blueprint sync后同步相同值；该引用不会在API密钥更换后即时更新。轮换时先验证新权限，再sync并重新部署两角色；provider key／model／gate也应有明确的共享配置与双角色轮换流程。Render的 `sync:false` 在创建时要求输入真实配置；此文件不含可用密钥或假生产签发接口。应用Blueprint会创建付费资源和公共API，当前任务仅交付本地文件。

web的pre-deploy只阻塞该web服务，不保证worker先等迁移完成。首次发布须先完成唯一迁移，再启动相同版本的两角色；升级先停止接新任务并排空旧worker，迁移成功后更新同commit／image的API和worker。示例Blueprint不提供跨服务原子发布保证。现worker SIGTERM等待 `worker.close()`，尚未主动取消所有运行中runtime；120秒后可能被宿主终止，空闲退出不证明长任务释放完成。保留lease／unknown边界，并在目标云验证中断与恢复。[Render发布语义](https://render.com/docs/deploys)、[变量引用与同步](https://render.com/docs/blueprint-spec)

## 验收边界

已在独立虚构PG／Redis的Linux ARM64容器通过迁移、web／worker启动、nonroot＋只读rootfs、同源静态／API边界、cookie／Origin及匿名文件拒绝。HTTP仅映射localhost，fixture随后清理；S3为虚构HTTPS配置，未证明bucket连接。本地Docker启动不能证明Render发布、真实HTTPS入口、目标AMD64、R2／S3、托管队列、负载或恢复目标已通过。目标环境仍需流式取消／恢复、私人媒体Range、运行中worker中断、PITR及发布回退验收。过程与结果记录在 [验证文档](../../../docs/platform/verification.md)。


### 私有文件写入日志（迁移 079）

网页上传与 `/voice/speech` 文件保存现在也要求 API 和 worker 配置同一个 `PLATFORM_DATA_KEY`。未配置时返回明确的上传不可用错误，不先写出文件。写入前保存加密坐标与事件，成功发布在同一事务内登记 upload 并移除暂存日志；失败或中断后的日志由 worker 恢复。执行器的 job/workflow/browser 产物也接入同一日志；worker 在调用供应商前检查配置。暂存句柄仅在服务端内存中使用，发布仍在原任务/检查点事务内重新核验真实账号、认证版本、租约、审批及相应 MCP 授权；不会新增客户端签发接口。工作目录中的 CLI/浏览器临时文件不属于这条对象存储协议，仍需单独清理。

首次升级先迁移，再启动匹配版本的 API/worker；不要在这项账号删除准备工作中运行旧写入器。已确认完成、未发布的写入在确认物理文件消失后清除日志；供应商返回结果不明或进程失去回执的写入保留日志并重复清理，单次 404 不代表彻底完成。这些未知结果仍需要可信的存储/进程对账流程，不能靠超时删除日志或宣布账号删除完成。历史未登记文件、对象版本和备份也不在本次覆盖范围。


账号删除协调器还未开放。内部 `UploadRemovals.prepareAccountDeletion` 可在同一个删除事务内消费本人重新验证的 `account_delete` 凭据，把所有已发布文件转为加密清理日志，并撤销文件引用；调用方仍须在该事务内完成其他数据域和账号删除，失败时整体回滚。此方法不执行对象存储删除，也不返回“账号已彻底删除”。清理 worker 只会在事务提交后看到日志，实际确认文件消失后再清除已删除账号的记录。不能用直接级联删除账号替代完整协调流程。
