/**
 * DRAFT 出口——评审定稿转正时此目录整体迁出 draft/（见包 README）。
 *
 * 原 draft/executionIntent.ts（intentId/userId/vendor/L0-L3 旧形状）已废除
 * （PR #4 评审 高2：与正式镜像形成第二套事实源）：ExecutionIntent 的唯一
 * 真相源是稳定包 `src/executionIntent.ts`（§5.3 完整 claims），扩展侧
 * 验签用它（apps/extension/lib/intentVerify.ts）。
 */
export * from './channel';
export * from './account';
export * from './application-profile';
export * from './calendar';
export * from './sensitiveWriteProposal';
export * from './pilotUa1Discovery';
export * from './pilotUa2Classification';
export * from './pilotUa3CandidateRule';
export * from './pilotUa4WriteAuthority';
export * from './answerResolution';
export * from './pilotUa5Certification';
export * from './pilotUa5ProfilePayloads';
export * from './pilotUa5ProfileCurrentness';
