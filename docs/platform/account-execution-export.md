# 浏览器与工作流执行历史归档

对应产品 09 §11，内部账户捕获新增 workflowTemplates、workflowCheckpoints、workflowStepEvents、browserCheckpoints、browserActionEvents，覆盖五张已有表。它们是底座已保存的本人历史，不扩展通用工作台，不向学生开放浏览器页或工作流编辑器。

普通 JSON 当前 100 张已投影、7 张明确排除、64 张待处理；带私有文件为 103 / 7 / 61。两者仍 complete=false。完整个人数据、归档 worker、公开下载、删除协调和其余 P0 仍需继续实现。

## 保留内容与边界

工作流模板保存实际最后一版名称、说明、steps、revision、创建/更新时间与 deletedAt，包括软删除记录；不使用只返回最多 100 个活跃模板的列表接口。没有旧模板版本表，因此不凭当前 revision 补造之前的内容，也不重新创建已删除模板。

工作流 checkpoint 保存实际已存在的步骤、原状态、完整已保存 text、文件引用和错误码。text 标记 saved_generated_output；不截为预览、不重新生成。文件引用保留原 attachmentId/name/mime/size，并核对现存 upload 的归属和元数据及关联 artifact 的任务、步骤和定义；存在但属于其他账号/任务的关联拒绝整包。已删除文件保留原引用并标 not_found，不恢复字节。文件字节由独立私有文件归档模式处理，当前 reader 不调用存储。

工作流事件保留原 revision、generation、stepIndex、eventType、错误码和时间。外部任务句柄只转换为 hasProviderTask，不输出原值，不生成恢复能力。旧服务在失败重试后的 started 事件中可能仍记录前一次句柄，而当前 checkpoint 已清空；两者分别保留原有布尔状态，不把旧事件解释为当前仍可恢复。

浏览器 checkpoint 保存 totalActions、revision、completedActions 与 ready/started/completed/uncertain。事件保留原 actionIndex、generation、类型和时间；按日志重放计数验证当前记录的一致性，不执行动作。部分完成后中断保留已完成数量，uncertain 也不被包装成任务成功。页面文本、截图和结构化 observation 仍是既有私有文件，不由这里读取或复制进 JSON。

所有事件编号是 PostgreSQL bigint，以精确十进制字符串导出，并用 bigint 游标分页；不能经过 JavaScript Number 损失高位。分页允许数据库序列的正常空洞，逐任务 revision 必须连续且与当前 checkpoint 对应。

## 历史校验

读取通过存活本人 job 归属，核对任务类型、原定义 hash、当前 steps/进度与完整事件列表。工作流每步旧 inputHash 必须与保存的该步一致，当前尾事件状态/错误与 checkpoint 匹配；不要求所有旧事件都等于当前状态。浏览器依原状态转换规则验证开始、完成和中断，再与当前 revision、nextIndex、state 对齐。

这些是既有普通 SQL 历史。旧事件不保存每个版本的完整输出正文、文件集或模板快照，也不是带认证签名的不可改写审计链。校验可发现结构/归属/定义/连续性不一致，但不能证明未发生过一致重写，也不声称能恢复缺失的过去结果。未知字段、错误定义、孤立事件、缺失/重复修订、错误文件绑定或不可能的进度使整个归档失败，不静默截断或虚构补全。

## 事务与验证

沿用本人会话、密码复核、5 秒 REPEATABLE READ 捕获和 JSON 容量限制。reader 只调用纯解析/摘要函数与数据库读取，不检查当前 provider 是否启用，不调用执行授权、恢复判断、模型、浏览器或对象存储。模板校验作用于副本，归档保留原保存字段。事务内取消/失败回滚复核消费，成功才返回整份快照。

新增测试使用真实 JobService 创建/审批、真实 checkpoint 更新和文件删除服务。执行租约为明确的隔离夹具；结果是虚构文本/文件，不启动浏览器或模型。覆盖模板更新/软删除、工作流和浏览器部分完成/中断、文件移除、未知字段/定义损坏/缺页/重复/跨账号与错任务引用、105 个模板及两类 checkpoint 与事件分页、大整数编号、异步句柄排除、取消/容量复核回滚、真实并发中断/完成和失败后的真实重试审批。完整结果见 verification.md。


最终新增 13/13 归档测试通过，API 类型检查与 git diff --check 通过。相关回归共 309 项：307 通过、0 失败、2 项 Chromium 测试因默认浏览器路径缺失而跳过。测试随后支持与 runtime 相同的 PLATFORM_BROWSER_EXECUTABLE 显式配置；指定远端已有 Chromium 后，原两项真实浏览器测试均在启动阶段失败。独立同配置启动复现 No usable sandbox，浏览器进程退出，临时目录已清理。因此不能将本轮描述为全部真实浏览器检查通过；远端沙箱环境仍需修复，运行时沙箱要求保持，没有加入 no-sandbox 或改变系统配置。

覆盖计数核对于 2026-10-09，包含日常偏好、休息和计划记录，以及本轮加入的[共享记忆分类与待处理记录](account-memory-safety-export.md)。
