# 第一封信语义复核执行验证

2026-10-09，edaix-dev，Node 24.21.0 / pnpm 11.13.1。使用虚构资料、独立 PostgreSQL schema 与注入的供应商传输，无真实模型调用、主库迁移、部署或预览重启。schema 清理已确认。

## 检查结果

- 第一封信来源/组装/共用检查/复核执行集成测试最终 18/18 通过，无跳过。
- platform-api 类型检查通过。
- git diff --check 通过。

新增流程用真实诞生、O2 和欢迎选择准备来源，再使用实际 provider runtime 解析流式协议，覆盖：
初次复核支持；复核指出问题后的重写及第二次复核；规则明确拦截初稿时跳过首次复核；两次 uncertain 后失败；重写后仍违反规则；重写产生 invalid_format 后固定失败提示；供应商拒绝；最终记账回调失败；不完整复核 JSON；取消；缺少 admission；只有自报 delta 而无实际回调的伪 runtime。

每阶段核对指定路线、tools=none、store=false、token 上限、实际调用 ID、阶段顺序及最大请求数。验证最小模型数据不含内部来源坐标、旧稿不进入 system 指令、结果不包含 approved/delivered 标记、运行后欢迎状态仍是 C7。

## 证据限制

测试中的 supported/contradicted/uncertain 由虚构供应商返回，不证明真实模型语义判断准确。阶段记账使用测试回调，证明等待/失败传播协议，不代表第一封信的 CostGuard 已落库。独立源数据库验证也不证明后台任务恢复或主线发送已完成。

本模块的至多一次重写是单次调用内约束；崩溃重启必须由后续持久化阶段记录约束，不能直接重调函数重置计数。reviewed_draft 是非持久化模型判断，不能作为发送许可或学生入口解锁条件。

私有日志位于 .local/verification/ci-regression-20261008/，不提交：
first-letter-review-types.log、first-letter-review-db.log、
first-letter-review-final-types.log、first-letter-review-final-db.log、
first-letter-review-complete-types.log、first-letter-review-complete-db.log。
