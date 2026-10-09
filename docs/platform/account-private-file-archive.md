# 账户归档的私有文件暂存

对应产品 09 §11 的「JSON 加私有文件」。`AccountFileArchive` 已把既有账户 JSON 捕获与实际文件读取接在同一份本人快照里，产出一个服务器私有目录，包含 `account.json`、`uploads/<upload UUID>` 和 `birth/<asset UUID>.svg|png`。这是后续归档 worker 和下载交付的内部输入；现在可通过 captureZip 打包为 ZIP，但仍不是上线下载接口或完整账户导出。

## 数据与文件

`uploads` 保存每份仍有效的本人文件的原名称、MIME、大小、创建时间和归档相对路径；实际文件名只用服务器验证过的 UUID，重名、中文或带路径符号的原名称不会变成磁盘路径。`privateFiles` 列出实际写入的相对路径、来源 ID、大小及本次读取的 SHA-256。不会把存储 key、存储目录、bucket、ETag、凭据或签名 URL写进清单。

`artifacts` 保存原材料记录及现有工作流、浏览器和 MCP 的公开来源元数据，关联同一份已复制的 upload，不重复复制字节。按材料自己的 user_id 枚举，再检查关联的 job 和 upload 都属于本人；跨账号引用直接拒绝整包。没有文件附件的历史材料保留记录并标为 `not_attached`，不推断它是已删除还是从未附带。已撤销的文件不会从删除日志或残存 blob 中被恢复。

当前所有活跃材料写入方都保存本地 upload 引用、external_url 为 NULL。旧材料若有非空 external_url，或者保存了当前无法识别的 metadata 结构，捕获会明确失败；不会访问外链或悄悄丢字段。未来支持这些旧结构需要另行审阅投影，不能绕过这个检查。

出生印章从已认证的出生回执和加密资产中读取原 SVG/PNG，复核对应 JSON 中的摘要和长度；不重新渲染，也不依赖当前模型或字库。只有确实写入这些字节，`companionBirthAssetMetadata.bytesIncluded` 才变为 true。

普通 `AccountCoreExport.capture` 继续只生成 JSON：145 张表已有投影、7 张排除、23 张待处理，`filesIncluded=false`。通过 `AccountFileArchive.capture` 成功捕获文件时，额外覆盖 uploads、artifacts、companion_birth_assets 三张表，即 148 张已投影、7 张排除、20 张待处理，`filesIncluded=true`。两种方式始终 `complete=false`，不会把其余数据表的缺口藏起来。以上当前计数包含后续加入的五张[执行历史表](account-execution-export.md)、六张[任务历史表](account-task-export.md)及四张[文件写入与删除日志](account-upload-journal-export.md)，这些日志在两种模式中都只导出元数据。

## 身份、事务与临时文件

捕获调用开始时即固定 userId/tokenHash；仍需有效学生账号和新的账户导出密码复核凭证。文件清单、原字节与 `account.json` 都在现有 5 秒 REPEATABLE READ 事务完成前生成，最后重新验证会话，数据库提交成功后才返回目录。

工作目录必须为真实、非符号链接的私有目录（不允许其他用户访问）。每次生成随机暂存目录，权限 0700；JSON 和文件权限 0600。源文件按实际记录大小和强 ETag 条件读取，流式写入并计算摘要，校验完整长度和源流结束；提交前再核对源对象版本。现有 uploads 没有原上传时的内容摘要，因此这些检查证明本次捕获的版本一致和字节完整，不能声称检测了捕获开始前的所有历史篡改。

默认总文件字节上限 256 MiB、文件数上限 10,000，JSON 沿用 16 MiB 上限；只允许调低。仍受现有 5 秒数据库期限约束。超限、文件缺失、版本变化、未知格式、跨账号关联或取消都会使捕获失败，不能返回部分文件。事务内失败会回滚复核凭证；若 COMMIT 已成功但应答丢失，则不保证凭证可复用，应重新复核。

事务超时会中断仍在进行的文件 I/O，等待流和文件句柄收尾，再清理暂存目录。JSON 已经写好但事务随后失败也清理整个目录。清理失败返回 `ACCOUNT_ARCHIVE_CLEANUP_REQUIRED`，不谎称清理完成。成功后调用者持有 `{snapshot, directory, dispose}`；directory 是服务器内部坐标，不能当作公共响应。打包或交付完成后必须调用 dispose，重复调用安全。

## ZIP 打包

`AccountFileArchive.captureZip` 先完成同一套真实身份、密码复核和事务捕获，再通过 `packageAccountCapture` 将已经保存的 `account.json` 和清单中的私有文件写入同一暂存目录的 `account.zip`。返回原快照、内部文件路径、ZIP 字节数、SHA-256、MIME 和 `dispose`；这些内部路径不能直接序列化为公共响应。ZIP 中的 JSON 与捕获时完全一致，保留 `complete=false`、`remainingTables` 等覆盖信息，不把打包成功等同于完整导出。

采用固定版本 yazl 3.3.1 的流式 ZIP writer，逐项延迟打开文件，不递归扫描目录。只允许 `account.json`、`uploads/<UUID>` 和 `birth/<UUID>.svg|png`，并检查来源 ID、重复路径、文件数量和字节上限；额外文件不会自动加入。打开时拒绝符号链接、硬链接、非普通文件和其他用户可访问的文件，读取过程中再次核对大小和 SHA-256。JSON 也与内存中的已认证快照逐字节摘要核对。

当前使用 ZIP 的 STORE 模式（不压缩），避免打包增加压缩计算负担；这是可正常解压的 ZIP，不承诺缩小体积。附件流式处理，JSON 仍受既有 16 MiB 上限约束。ZIP 上限是 16 MiB JSON + 256 MiB 附件 + 4 MiB 目录开销；暂存原文件和 ZIP 同时存在，因此磁盘预留应按约两份数据计算。ZIP 权限 0600，目录权限 0700。

数据库捕获已经提交后才开始打包，因此打包失败不会恢复已消费的密码复核凭证，重试需重新复核。打包层等待活跃 I/O 收尾再删除本次未完成输出，`captureZip` 再清理整个本次暂存目录。取消返回 `ACCOUNT_EXPORT_CANCELLED`，清理失败明确返回 `ACCOUNT_ARCHIVE_CLEANUP_REQUIRED`；不会返回部分 ZIP 或删除其他任务目录。成功后调用者必须调用 `dispose` 清理 ZIP 和暂存原文件。进程强制退出的遗留清理仍未实现。

## 剩余交付

还需覆盖剩余个人数据表、持久化归档任务与租约、较大账户的后台处理、下载交付、下载时再次检查当前权限，以及进程被强制终止后遗留私有目录的清理策略。当前没有自动清理其他任务目录，没有修改上传/删除服务、主数据库、预览或公开下载路由。

## 验证

首轮新增 13 项测试通过；进一步加入 JSON 已物化后的实际事务回滚、S3 条件读取与版本变化，以及 105 个生成材料的分页核对。测试使用隔离 PostgreSQL、真实 UploadWrites/UploadRemovals、本地文件及真实 S3 适配器配虚构 SDK 响应；出生资源使用仅访问 loopback 的虚构运行时。没有真实对象存储、付费模型或第三方请求。

最终新增 15/15 项通过。相关回归共 271 项不同测试均已有通过结果：首轮 270/271，唯一失败是测试 ETag 恰与虚构法律条款版本相同；换用独立随机 ETag 后，文件归档 15/15 定向复跑通过。API 类型检查与 git diff --check 通过，无跳过。生产代码未因该夹具问题改动。

覆盖计数核对于 2026-10-09，包含日常偏好、休息和计划记录，以及[共享记忆分类与待处理记录](account-memory-safety-export.md)、[模型调用记录](account-model-audit-export.md)及[主理人名字与选择历史](account-companion-identity-export.md)。

### ZIP 验证（2026-10-09）

新增 8 项打包测试和 2 项真实数据库集成测试，并将既有 105 附件分页用例扩展为 ZIP 解压核对。通过独立 yauzl 3.4.0 reader 验证 JSON、上传字节、出生 SVG/PNG、空文件和中文原名称。故障覆盖同长度篡改、缺失、JSON 变化、路径越界、符号链接、硬链接、共享权限、超限、打开中取消、流式读取中取消、输出失败及清理失败；确认失败时不会返回 ZIP、未影响源附件，提交后失败的复核凭证确实已消费。

最终定向回归 35/35 通过（ZIP、私有文件导出、账户核心导出），API 类型检查通过；隔离 PostgreSQL 夹具清理已确认。无公共下载路由、主数据库迁移、部署、主预览重启或模型调用。
