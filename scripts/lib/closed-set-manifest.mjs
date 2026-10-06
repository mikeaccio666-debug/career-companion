/**
 * 哪些闭集由**后端源契约治理**——显式登记，不靠目录递归猜。
 *
 * ## 为什么必须显式
 *
 * Yiwen 审 PR #17 第二轮【高1】（2026-08-18）实测：改成「递归扫描整个
 * `packages/contracts/src`」之后，在最新真实双仓上门禁**直接退出 1**，
 * 报 `draft/channel.ts` 的五个闭集在源契约里找不到。
 *
 * 她的诊断准确：**递归范围扩大了，但语义范围没有定义。**
 *
 * `src/draft/channel.ts` 是 chat↔扩展的**浏览器内通道**协议——
 * 它「跑在用户浏览器内部（web 页 ↔ 扩展），**不经后端**」（该文件头注原话）。
 * 它的闭集是前端自己的 wire truth，后端源契约里当然找不到，
 * 也**不应该**要求后端逐字登记。把它们当成漂移是判据错，不是真漂移。
 *
 * ## 两个方向都要挡
 *
 * 1. **登记了却找不到** → 真漂移（后端删了成员/改了名）。
 * 2. **后端面新增了闭集却没登记** → 覆盖面被静默缩小。
 *    所以顶层 `src/*.ts` 里出现未登记的闭集**一律报错**，
 *    要么登记、要么显式豁免并写明理由。
 *    没有这一条，manifest 会随着时间悄悄变成一张过期清单。
 */

/**
 * 判据很简单：**顶层 `src/*.ts` 是后端面镜像，默认受治理；
 * 子目录必须在 `GOVERNED_NESTED` 或 `EXEMPT` 里显式登记。**
 *
 * 不用「白名单登记每一个受治理的闭集」，是因为那张表会随后端加字段而不断漏登，
 * 漏登的方向恰好是**静默缩小覆盖面**——最危险的那个方向。
 * 改成「顶层默认受治理 + 子目录必须显式说明」，漏登的方向变成报错。
 */

/**
 * 位于子目录、但仍由后端源契约逐项治理的闭集。
 *
 * draft/default-off 只限制 activation，不取消 source ↔ executable taxonomy
 * 的 parity。显式登记也避免为了通过目录判据而把 draft public surface
 * 误搬进稳定 `@edaix/contracts` root。
 */
export const GOVERNED_NESTED = {
  'draft/sensitiveWriteProposal.ts PENDING_L2P_SENSITIVE_ASSISTED_WRITE_CLASSES':
    'PR #77 pending L2-P proposal taxonomy，由 API 源契约 §5.9.1 逐项定义',
  'draft/sensitiveWriteProposal.ts PENDING_L2P_SENSITIVE_MANUAL_ONLY_CLASSES':
    'PR #77 pending L2-P manual-only taxonomy，由 API 源契约 §5.9.1 逐项定义',
  'draft/pilotUa1Discovery.ts PILOT_UA1_FILE_ACCEPT_SHAPES':
    'UA-1 packet 的 file-accept 闭集随 UA-2 endpoint 过线，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_FAILURE_CODES':
    'UA-2 default-off backend response taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_CLASSIFICATION_KINDS':
    'UA-2 default-off backend classification taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_CANONICAL_FIELDS':
    'UA-2 default-off backend canonical-field taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_CONFIDENCE_LEVELS':
    'UA-2 default-off backend confidence taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_PROVENANCE_SOURCES':
    'UA-2 default-off backend provenance taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa2Classification.ts PILOT_UA2_REASON_CODES':
    'UA-2 default-off backend reason taxonomy，由 API 源契约 §5.18 逐项定义',
  'draft/pilotUa3CandidateRule.ts PILOT_UA3_FAILURE_CODES':
    'UA-3 default-off exact-page ephemeral candidate failure taxonomy，由 API 源契约 §5.20 逐项定义',
  'draft/pilotUa4WriteAuthority.ts PILOT_UA4_FAILURE_CODES':
    'UA-4 default-off exact-page write-authority failure taxonomy，由 API 源契约 §5.21 逐项定义',
  'draft/pilotUa4WriteAuthority.ts PILOT_UA4_CONTROL_KINDS':
    'UA-4 generic writer control taxonomy，由 API 源契约 §5.21 逐项定义',
  'draft/pilotUa4WriteAuthority.ts PILOT_UA4_ANSWER_AUTHORITIES':
    'UA-4 provenance-bound answer authority taxonomy，由 API 源契约 §5.21 逐项定义',
  'draft/pilotUa5Certification.ts PILOT_UA5_FAILURE_CODES':
    'UA-5 default-off exact-page vertical composition failure taxonomy，由 API 源契约 §5.23 逐项定义',
  'draft/pilotUa5Certification.ts PILOT_UA5_ADMISSIONS':
    'UA-5 panel admission taxonomy，说明每题终态由谁负责，由 API 源契约 §5.23 逐项定义',
  'draft/pilotUa4WriteAuthority.ts PILOT_UA4_TERMINAL_STATES':
    'UA-4 final-disposition terminal taxonomy，由 API 源契约 §5.21 逐项定义',
  'draft/pilotUa4WriteAuthority.ts PILOT_UA4_UNOBSERVED_REGION_REASONS':
    'UA-4 terminal ledger v2 未观察区域原因 taxonomy（中性：扫描未检查也不声称跨域），由 API 源契约 §5.21 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_FAILURE_CODES':
    'Answer Resolution default-off fail-closed result taxonomy，由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_DISPOSITIONS':
    'Answer Resolution default-off 五档来源处置 taxonomy，由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_ANSWERABILITY':
    'Answer Resolution 可答性 taxonomy（区分「没有答案」与「不该有答案」），由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_WRITE_OBLIGATIONS':
    'Answer Resolution 三项写入前提 taxonomy，由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_RUNTIME_OBLIGATIONS':
    'Answer Resolution 解析期不可兑现的运行时义务子集，由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_REASON_CODES':
    'Answer Resolution default-off reason taxonomy，由 API 源契约 §5.22 逐项定义',
  'draft/answerResolution.ts ANSWER_RESOLUTION_HUMAN_ACTIONS':
    'Answer Resolution human-action taxonomy，与 §5.21 UA-4 MANUAL_REQUIRED 原因逐项一致，由 API 源契约 §5.22 逐项定义',
};

/**
 * 明确**不受**后端源契约治理的闭集，以及理由。
 *
 * 每一条都要写清「为什么后端源契约里不该有它」。写不出理由的，
 * 说明它其实该受治理。
 */
export const EXEMPT = {
  // ── 浏览器内通道：不经后端，前端自己的 wire truth ──
  'draft/channel.ts RUN_STEPS': 'chat↔扩展通道的运行阶段，不经后端',
  'draft/channel.ts RECEIPT_REASON_CODES': '填写摘要的原因码，后端有自己的三级 outcome 分类',
  'draft/channel.ts RECEIPT_OUTCOME_SOURCES': '通道摘要里「这一条不是从档案填的」的来源标注，§5.7 durable receipt 没有这一维',
  'draft/channel.ts SUBMISSION_STATES': '通道内的提交态摘要，正式回执走后端 §5.7',
  'draft/channel.ts CHANNEL_CONNECTION_STATES': '通道自身的连接态，后端看不见这条链路',
  'draft/channel.ts CHANNEL_ERROR_CODES': '通道协议错误，不是 HTTP 契约错误',
  'draft/channel.ts CHANNEL_CAPABILITIES': 'Portal↔Extension 的本地能力证明，不经后端 HTTP wire',
  'draft/channel.ts EXTENSION_CONNECTION_READINESS_STATES': 'Extension 对本地 session/install readiness 的闭集投影，不是后端响应 taxonomy',
  'draft/channel.ts NEEDS_USER_INPUT_KINDS': '三类语义源自契约 b2e589b1，但常量本身是通道内表达',
  'draft/channel.ts DISCOVERY_UNAVAILABLE_CODES': '零写入 discovery 的浏览器内失败码，不经后端',

  // ── UA-1 Extension 本地草案：不经后端 HTTP wire ──
  'draft/pilotUa1Discovery.ts PILOT_UA1_DETECTION_OUTCOMES':
    'UA-1 exact-page 只读发现的 Extension 本地 outcome，无 apps/api endpoint 或后端 wire',

  // 注：单值常量（AGENT_API_BASE_PATH、EXECUTION_INTENT_VERSION 等）
  // **不需要登记豁免**——它们不是 `= [...] as const` 形态，解析器压根看不见。
  // 我第一版把它们写进 EXEMPT，被下面的「过期豁免」检查当场咬住（实测）。
};

/** `受治理` | `豁免` | `未登记`。 */
export function classifyClosedSet(path, name) {
  const key = `${path} ${name}`;
  if (key in GOVERNED_NESTED) return { governed: true, reason: GOVERNED_NESTED[key] };
  if (key in EXEMPT) return { governed: false, reason: EXEMPT[key] };
  // 顶层文件默认受治理；子目录默认未分类，并由 findUnclassified 拦截。
  return { governed: !path.includes('/'), reason: null };
}

/**
 * 找出「在子目录里、又没被显式豁免」的闭集。
 *
 * 这些是**判据说不清的**——本函数的存在是为了让它们报错而不是被默默跳过。
 * 新增一个 `draft/` 闭集却忘了登记，会在这里被拦下。
 */
export function findUnclassified(sets) {
  return sets
    .filter((s) => {
      const key = `${s.path} ${s.name}`;
      return s.path.includes('/') && !(key in GOVERNED_NESTED) && !(key in EXEMPT);
    })
    .map((s) => `${s.path} ${s.name}`);
}

/** 显式受治理登记已经没有对应代码闭集——防止 parity 覆盖面静默腐化。 */
export function findStaleGovernedRegistrations(sets) {
  const present = new Set(sets.map((s) => `${s.path} ${s.name}`));
  return Object.keys(GOVERNED_NESTED).filter((k) => !present.has(k));
}

/** 登记在 EXEMPT 里、但代码里已经不存在的条目——防止 manifest 变成过期清单。 */
export function findStaleExemptions(sets) {
  const present = new Set(sets.map((s) => `${s.path} ${s.name}`));
  return Object.keys(EXEMPT).filter((k) => !present.has(k));
}
