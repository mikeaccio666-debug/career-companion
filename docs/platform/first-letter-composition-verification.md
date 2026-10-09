# 第一封信组装验证

验证环境：edaix-dev，Node 24.21.0 / pnpm 11.13.1，2026-10-09。本批无数据库结构变更；使用测试独立 schema，测试清理已确认。未读取真实用户资料，未调用付费模型，未修改主服务环境、迁移主库、部署或重启预览。

## 检查

- platform-api 类型检查通过。
- first-letter-sources.integration、companion-planning-source.integration、companion-context-source.integration 三组共 32/32 通过，无跳过。
- git diff --check 通过。

测试覆盖：实际出生及完成来源认证、本人会话/协议/邮箱与当前安全检查、O2 跳过/零条/一条/未定方向、损坏/重新密封/跨用户来源拒绝、欢迎选择与主线绑定、读操作无模型调用和业务状态写入；新增真实名字/印章/说话方式投影、模型输入不包含内部坐标及身份字段、显式队员名单与空名单、日期及配置版本变化、异步等待期间配置不能被改写、数据中的指令不进入 system 策略、引用映射与数量/重复/超长/未知引用拒绝。

使用真实来源准备结构及注入的虚构 HTTP 响应验证 first_letter_generation 接受 schema，保留 tools=none、store=false、独立用途和终态回调。该测试不代表供应商可用性、真实费用持久化或模型质量通过。

## 修复记录和证据边界

首轮 31 项中 30 项通过，配置快照测试发现读取 await 期间调用方能改写队员名单。修复为读取前克隆冻结配置后，全组复测 32/32 通过，包含新增 runtime 格式验证；最终类型检查再次通过。

候选稿解析测试明确证明：给错误事实附上存在的 ref，并不能验证事实含义。解析结果始终为 requires_full_output_check。这里没有实现完整信件语义与必含规则校验、实际发布配置、费用/租约/重试/持久化任务、post 发布、唯一送达或界面完成。没有据此解除真实模型评测或 PR3 顺序门槛。

私有日志在远端 .local/verification/ci-regression-20261008/，不提交：
first-letter-composition-types.log、first-letter-composition-db.log、
first-letter-composition-final-types.log、first-letter-composition-final-db.log。
