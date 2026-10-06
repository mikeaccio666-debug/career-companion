/**
 * 契约漂移比对的**纯逻辑**——不碰 git、不碰文件系统、不调 process.exit。
 *
 * 从 CLI 里抽出来的唯一理由：Yiwen 审 PR #17（2026-08-18）第 4 条——
 * 「新门禁没有自动测试，CI 连解析逻辑都未执行」。原实现把 git/fs/解析/退出码
 * 全揉在一个脚本里，而 CI 又固定走「缺后端 → 跳过」分支，
 * 于是端点、章节、闭集三层解析在 CI 里**零执行**。
 *
 * 抽成纯函数之后，`packages/contracts/tests/contract-drift.test.ts` 用 fixture
 * 直接驱动它，解析逻辑每次 CI 都真跑一遍，与后端 clone 在不在无关。
 */

/** JWKS 住在 `.well-known`，只由专用结构化门禁管理。 */
const NOT_COMPARED = new Set([
  'GET /.well-known/edaix-execution-intent-jwks.json',
]);

/**
 * forgot/reset 是 §2.1 明确保留的 credential-less old-Auth draft exception。
 * source 必须说明它们的边界，但它们继续消费
 * `packages/contracts/src/draft/account.ts`，不属于已批准的 `AUTH_SESSION_ENDPOINTS`。
 * 豁免只应用于 source prose；如果 mirror 真加入它们，仍必须报 extra。
 */
const SOURCE_DRAFT_EXCEPTIONS = new Set([
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
]);

const ENDPOINT_IN_PROSE =
  /(GET|POST|PATCH|DELETE|PUT)\s+(\/(?:api\/v1\/agent|admin|auth|extension|internal\/auth|users|waitlist)[A-Za-z0-9:/_.-]*)/g;

const ENDPOINT_IN_MIRROR =
  /endpoint\(\s*'(GET|POST|PATCH|DELETE|PUT)',\s*'([^']+)',\s*'([^']+)'/g;

/**
 * 源契约里出现过的**章节标题**集合。
 *
 * ⚠️ 这里必须解析 heading，**不能全文搜数字**——Yiwen 第 3 条实测：
 * 把真标题 `### 5.4 签发接口` 改成 `### 9.9 签发接口`，因为正文别处仍出现
 * `§5.4`，原实现继续报「32 个全部可定位 / ✓ 无漂移」，退出码 0。
 * PR 描述声称的「后端重排章节号时这条先红」当时**不成立**。
 */
export function parseHeadingSections(source) {
  const out = new Set();
  for (const m of source.matchAll(/^#{2,6}[ \t]+(\d+(?:\.\d+)*)(?=[ \t.)．。:：-]|$)/gm)) {
    out.add(m[1]);
  }
  return out;
}

/** 源契约散文里点名的端点。 */
export function parseSourceEndpoints(source) {
  const out = new Set();
  for (const m of source.matchAll(ENDPOINT_IN_PROSE)) {
    const key = `${m[1]} ${m[2].replace(/[.,;)`]+$/, '')}`;
    if (!NOT_COMPARED.has(key) && !SOURCE_DRAFT_EXCEPTIONS.has(key)) out.add(key);
  }
  return out;
}

/** 镜像里 `endpoint('POST', '/…', '5.4', …)` 的调用。 */
export function parseMirrorEndpoints(httpTs) {
  const calls = [...httpTs.matchAll(ENDPOINT_IN_MIRROR)].map((m) => ({
    method: m[1],
    path: m[2],
    section: m[3],
  }));
  return calls.filter((c) => !NOT_COMPARED.has(`${c.method} ${c.path}`));
}

/**
 * 镜像里的闭集成员。
 *
 * `files` 是 `{ 路径: 文本 }`——由调用方**递归**收集（Yiwen 第 5 条：
 * 原实现只扫 `packages/contracts/src` 顶层，`src/draft/*` 完全没查）。
 */
export function parseClosedSets(files) {
  const sets = [];
  for (const [path, text] of Object.entries(files)) {
    for (const m of text.matchAll(/export const ([A-Z_0-9]+)\s*=\s*\[([^\]]*)\]\s*as const/g)) {
      const members = [...m[2].matchAll(/'([A-Z][A-Z_0-9]{2,})'/g)].map((x) => x[1]);
      if (members.length) sets.push({ path, name: m[1], members });
    }
  }
  return sets;
}

const STRICT_V2_ENDPOINT_SPECS = [
  {
    id: 'createSensitiveWriteConfirmation',
    method: 'POST',
    path: '/api/v1/agent/missions/:missionId/sensitive-write-confirmations',
    section: '5.9.4',
    errorRow: 'POST /missions/:id/sensitive-write-confirmations',
    statuses: 'create-or-replay',
    callerConstraint: 'owner-bearer+exact-official-extension-origin',
    callerPatterns: [
      /endpoint 要求 owner access bearer、exact official extension Origin/,
    ],
  },
  {
    id: 'decideSensitiveWriteConfirmation',
    method: 'POST',
    path:
      '/api/v1/agent/missions/:missionId/sensitive-write-confirmations/:confirmationId/decisions',
    section: '5.9.5',
    errorRow: 'POST /missions/:id/sensitive-write-confirmations/:confirmationId/decisions',
    statuses: 'create-or-replay',
    callerConstraint:
      'owner-bearer+exact-official-extension-origin+decision-token',
    callerPatterns: [
      /endpoint 只接受 owner access bearer 与 exact official extension Origin/,
      /真正的extension-only proof是[\s\S]{0,80}一次性decision token/,
    ],
  },
  {
    id: 'issueExecutionIntent',
    method: 'POST',
    path: '/api/v1/agent/missions/:missionId/execution-intents',
    section: '5.4',
    errorRow: 'POST /missions/:id/execution-intents',
    statusChecks: [
      { label: 'ISSUE', section: '5.4', mode: 'fixed-success' },
    ],
  },
  {
    id: 'claimExecutionIntent',
    method: 'POST',
    path: '/api/v1/agent/execution-intents/claim',
    section: '5.6',
    errorRow: 'POST /execution-intents/claim',
    statusChecks: [
      { label: 'CLAIM', section: '5.6', mode: 'fixed-success' },
    ],
  },
  {
    id: 'fetchSensitiveExecutionMaterial',
    method: 'POST',
    path: '/api/v1/agent/execution-intents/sensitive-material',
    section: '5.9.7',
    errorRow: 'POST /execution-intents/sensitive-material',
    statuses: 'fixed',
    callerConstraint: 'owner-bearer+exact-official-extension-origin',
    callerPatterns: [/server 以 bearer owner \+ official extension Origin/],
    cache: true,
  },
  {
    id: 'submitApplicationReceipt',
    method: 'POST',
    path: '/api/v1/agent/missions/:missionId/receipts',
    section: '5.7',
    errorRow: 'POST /missions/:id/receipts',
    statusChecks: [
      { label: 'V1', section: '5.7', mode: 'receipt-v1' },
      { label: 'STANDARD', section: '5.9.8', mode: 'receipt-v2-standard' },
      {
        label: 'SENSITIVE_RELEASE',
        section: '5.9.8',
        mode: 'receipt-v2-sensitive-release',
      },
    ],
  },
];

const STRICT_V2_CLOSED_SET_SPECS = [
  {
    mirrorName: 'EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES',
    sourceType: 'ExecutionIntentExecutableAtsProviderV1',
  },
  {
    mirrorName: 'SENSITIVE_MANUAL_ONLY_CLASSES',
    sourceType: 'SensitiveManualOnlyClassV1',
  },
  {
    mirrorName: 'SENSITIVE_WRITE_CLASSES',
    sourceType: 'SensitiveWriteClassV1',
  },
  {
    mirrorName: 'SENSITIVE_WRITE_CONCEPTS',
    sourceType: 'SensitiveWriteConceptV1',
  },
  {
    mirrorName: 'SENSITIVE_WRITE_CONFIRMATION_STATUSES',
    sourceSection: '5.9.4',
    sourcePattern: /confirmation lifecycle 闭集为\s*`([^`]+)`/,
  },
  {
    mirrorName: 'SENSITIVE_WRITE_DECISIONS',
    sourceSection: '5.9.5',
    sourcePattern: /decision\s*\n?\s*闭集\s*`([^`]+)`/,
  },
  {
    mirrorName: 'SENSITIVE_WRITE_RELEASE_STATUSES',
    sourceSection: '5.9.5',
    sourcePattern: /release lifecycle 闭集\s*`([^`]+)`/,
  },
  {
    mirrorName: 'SENSITIVE_RECEIPT_OUTCOMES',
    sourceSection: '5.9.8',
    sourcePattern: /outer outcome 只允许\s*`([^`]+)`/,
  },
];

const STRICT_V2_ERROR_CODES = [
  'EXECUTION_CLIENT_UPGRADE_REQUIRED',
  'SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND',
  'SENSITIVE_WRITE_RELEASE_NOT_FOUND',
  'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT',
  'SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT',
  'SENSITIVE_WRITE_RELEASE_STALE',
  'SENSITIVE_WRITE_RELEASE_EXPIRED',
  'SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE',
  'SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH',
];

const STRICT_PROFILE_V2_ENDPOINT_SPECS = [
  {
    id: 'getOwnerApplicationProfileV2',
    method: 'GET',
    path: '/users/me/application-profile',
    section: '5.13',
    errorRow: 'GET /users/me/application-profile',
  },
  {
    id: 'patchOwnerApplicationProfileV2',
    method: 'PATCH',
    path: '/users/me/application-profile',
    section: '5.13',
    errorRow: 'PATCH /users/me/application-profile',
  },
  {
    id: 'deleteOwnerApplicationProfileV2',
    method: 'DELETE',
    path: '/users/me/application-profile',
    section: '5.13',
    errorRow: 'DELETE /users/me/application-profile',
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumberedSection(source, section) {
  const heading = new RegExp(
    `^(#{2,6})[ \\t]+${escapeRegExp(section)}(?=[ \\t.)．。:：-]|$)[^\\n]*$`,
    'm',
  ).exec(source);
  if (!heading) return null;
  const level = heading[1].length;
  const bodyStart = heading.index + heading[0].length;
  const rest = source.slice(bodyStart);
  const headings = /^((?:#{2,6}))[ \t]+\d+(?:\.\d+)*(?=[ \t.)．。:：-]|$)[^\n]*$/gm;
  for (const next of rest.matchAll(headings)) {
    if (next[1].length <= level) return rest.slice(0, next.index);
  }
  return rest;
}

function findMatchingParenthesis(text, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMirrorEndpointRecords(httpTs) {
  const records = new Map();
  const properties = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*endpoint\(/gm;
  for (const property of httpTs.matchAll(properties)) {
    const callStart = httpTs.indexOf('endpoint(', property.index);
    const open = httpTs.indexOf('(', callStart);
    const close = findMatchingParenthesis(httpTs, open);
    if (close < 0) continue;
    const call = httpTs.slice(callStart, close + 1);
    const args = splitTopLevel(call.slice('endpoint('.length, -1), ',')
      .map((argument) => argument.trim());
    if (args.at(-1) === '') args.pop();
    const literals = args.slice(0, 5).map(
      (argument) => /^'([^'\\]*)'$/.exec(argument)?.[1] ?? null,
    );
    if ((args.length !== 5 && args.length !== 6) || literals.some((value) => value === null)) {
      records.set(property[1], null);
      continue;
    }
    const policy = args[5] ?? null;
    const statusMatches = policy
      ? [...policy.matchAll(/\bsuccessStatuses\s*:\s*\[([^\]]*)\]/g)]
      : [];
    let statuses = null;
    if (statusMatches.length === 1) {
      const tokens = statusMatches[0][1].split(',').map((part) => part.trim());
      if (tokens.at(-1) === '') tokens.pop();
      if (
        tokens.length > 0 &&
        tokens.every((token) => /^\d{3}$/.test(token)) &&
        new Set(tokens).size === tokens.length
      ) {
        statuses = tokens.map(Number);
      }
    }
    const callerConstraint = /callerConstraint:\s*'([^']+)'/.exec(call)?.[1];
    const responseCacheName = /responseCache:\s*([A-Z][A-Z0-9_]+)/.exec(call)?.[1];
    if (records.has(property[1])) {
      records.set(property[1], null);
      continue;
    }
    records.set(property[1], {
      id: property[1],
      method: literals[0],
      path: literals[1],
      section: literals[2],
      auth: literals[3],
      media: literals[4],
      statuses,
      hasPolicy: policy !== null,
      callerConstraint: callerConstraint ?? null,
      responseCacheName: responseCacheName ?? null,
      hasResponseCache: /responseCache:\s*SENSITIVE_EXECUTION_MATERIAL_CACHE_POLICY/.test(call),
    });
  }
  return records;
}

function parseSourceStatuses(section, mode) {
  if (!section) return null;
  if (mode === 'fixed') {
    const fixed = /成功固定\s*`(\d{3}) (?:OK|Created)`/.exec(section);
    return fixed ? [Number(fixed[1])] : null;
  }
  if (mode === 'fixed-success') {
    const fixed = /成功：\s*`(\d{3}) (?:OK|Created)`/.exec(section);
    return fixed ? [Number(fixed[1])] : null;
  }
  if (mode === 'receipt-v1') {
    const firstAndReplay =
      /成功：首次\s*`(\d{3}) (?:OK|Created)`；幂等重放\s*`(\d{3}) (?:OK|Created)`/.exec(
        section,
      );
    return firstAndReplay
      ? [Number(firstAndReplay[1]), Number(firstAndReplay[2])]
      : null;
  }
  if (mode === 'receipt-v2-standard' || mode === 'receipt-v2-sensitive-release') {
    const standardMarker = 'STANDARD arm 除';
    const sensitiveMarker = 'SENSITIVE_RELEASE arm exact body';
    const standardStart = section.indexOf(standardMarker);
    const sensitiveStart = section.indexOf(sensitiveMarker);
    if (standardStart < 0 || sensitiveStart < 0 || standardStart >= sensitiveStart) return null;
    const arm = mode === 'receipt-v2-standard'
      ? section.slice(standardStart, sensitiveStart)
      : section.slice(sensitiveStart);
    const firstAndReplay =
      /首次\s*`(\d{3})(?: (?:OK|Created))?`、same digest replay\s*`(\d{3})(?: (?:OK|Created))?`/.exec(
        arm,
      );
    return firstAndReplay
      ? [Number(firstAndReplay[1]), Number(firstAndReplay[2])]
      : null;
  }
  const firstAndReplay =
    /首次成功\s*`(\d{3}) (?:OK|Created)`；相同[\s\S]{0,160}?replay\s*`(\d{3}) (?:OK|Created)`/.exec(
      section,
    );
  return firstAndReplay
    ? [Number(firstAndReplay[1]), Number(firstAndReplay[2])]
    : null;
}

function parseSourceCommonPrivate(source) {
  const definition = /`COMMON_PRIVATE` 固定展开为：([\s\S]{0,300}?)。本表/.exec(source)?.[1];
  return definition
    ? [...definition.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1])
    : null;
}

function parseSourceErrorCodes(source, endpoint, commonPrivate) {
  const row = source
    .split('\n')
    .find((line) => line.startsWith(`| \`${endpoint}\``));
  if (!row) return null;
  const cells = row.split('|');
  const codes = [...(cells[2] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(
    (match) => match[1],
  );
  return codes.flatMap((code) =>
    code === 'COMMON_PRIVATE' ? (commonPrivate ?? []) : [code],
  );
}

function parseMirrorCommonPrivate(closedSets) {
  return closedSets.find((set) => set.name === 'COMMON_PRIVATE_ERROR_CODES')?.members ?? null;
}

function parseMirrorErrorCodes(httpTs, endpointId, commonPrivate) {
  const commonOnly = new RegExp(
    `^\\s{2}${escapeRegExp(endpointId)}:\\s*common,?`,
    'm',
  ).exec(httpTs);
  if (commonOnly) return commonPrivate;
  const match = new RegExp(
    `^\\s{2}${escapeRegExp(endpointId)}:\\s*\\[([\\s\\S]*?)\\],?`,
    'm',
  ).exec(httpTs);
  if (!match) return null;
  const codes = [...match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(
    (code) => code[1],
  );
  return match[1].includes('...common') ? [...(commonPrivate ?? []), ...codes] : codes;
}

function recoveryPatternMatches(pattern, code) {
  if (!pattern.includes('*')) return pattern === code;
  const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
  return new RegExp(expression).test(code);
}

function parseSourceErrorDefinition(source, code) {
  const definitionRow = source
    .split('\n')
    .find((line) => line.startsWith(`| \`${code}\` |`));
  if (!definitionRow) return null;
  const cells = definitionRow.split('|');
  const statusCode = Number(cells[2]?.trim());
  const retryCell = cells[3]?.trim();
  if (!Number.isInteger(statusCode) || !['是', '否'].includes(retryCell)) return null;

  const recoverySection = /除下表外，`requiresUserAction=false,recommendedAction=NONE`([\s\S]*?)### 6\.2/.exec(
    source,
  )?.[1];
  if (!recoverySection) return null;
  const matchingRecovery = [];
  for (const row of recoverySection.split('\n')) {
    if (!row.startsWith('|')) continue;
    const recoveryCells = row.split('|');
    const patterns = [...(recoveryCells[1] ?? '').matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    if (!patterns.some((pattern) => recoveryPatternMatches(pattern, code))) continue;
    const requiresCell = recoveryCells[2]?.trim();
    const recommendedAction = /`([A-Z][A-Z0-9_]+)`/.exec(recoveryCells[3] ?? '')?.[1];
    if (!['是', '否'].includes(requiresCell) || !recommendedAction) return null;
    matchingRecovery.push({
      requiresUserAction: requiresCell === '是',
      recommendedAction,
    });
  }
  const recovery = matchingRecovery[0] ?? {
    requiresUserAction: false,
    recommendedAction: 'NONE',
  };
  if (matchingRecovery.some((candidate) => !sameWireValue(candidate, recovery))) return null;
  return {
    statusCode,
    retryable: retryCell === '是',
    ...recovery,
  };
}

function parseMirrorErrorDefinition(closedSetFiles, code) {
  const source = closedSetFiles['common.ts'];
  if (!source) return null;
  const match = new RegExp(
    `\\b${escapeRegExp(code)}:\\s*error\\(\\s*(\\d+)\\s*,\\s*(true|false)\\s*,\\s*(true|false)\\s*,\\s*'([A-Z][A-Z0-9_]+)'\\s*\\)`,
  ).exec(source);
  return match
    ? {
        statusCode: Number(match[1]),
        retryable: match[2] === 'true',
        requiresUserAction: match[3] === 'true',
        recommendedAction: match[4],
      }
    : null;
}

function parseSourceCachePolicy(section) {
  if (!section) return null;
  const match =
    /`Cache-Control: ([^`]+)`、`Pragma: ([^`]+)`、`Expires: ([^`]+)`，无 ETag/.exec(
      section,
    );
  return match
    ? {
        responseHeaders: {
          'Cache-Control': match[1],
          Pragma: match[2],
          Expires: match[3],
        },
        etag: 'forbidden',
      }
    : null;
}

function parseMirrorCachePolicy(closedSetFiles) {
  const source = closedSetFiles['sensitiveWrite.ts'];
  if (!source) return null;
  const block =
    /export const SENSITIVE_EXECUTION_MATERIAL_CACHE_POLICY\s*=\s*\{([\s\S]*?)\n\} as const;/.exec(
      source,
    )?.[1];
  if (!block) return null;
  const cacheControl = /'Cache-Control':\s*'([^']+)'/.exec(block)?.[1];
  const pragma = /Pragma:\s*'([^']+)'/.exec(block)?.[1];
  const expires = /Expires:\s*'([^']+)'/.exec(block)?.[1];
  const etag = /etag:\s*'([^']+)'/.exec(block)?.[1];
  return cacheControl && pragma && expires && etag
    ? {
        responseHeaders: {
          'Cache-Control': cacheControl,
          Pragma: pragma,
          Expires: expires,
        },
        etag,
      }
    : null;
}

function parseSourceProfileCachePolicy(section) {
  if (!section) return null;
  const cacheControl = /响应固定\s*`Cache-Control: ([^`]+)`、不发 ETag/.exec(section)?.[1];
  return cacheControl
    ? { responseHeaders: { 'Cache-Control': cacheControl }, etag: 'forbidden' }
    : null;
}

function parseSourceProfileSuccessStatuses(section) {
  if (!section) return null;
  const status = /三个 route 成功(?:都|均)固定\s*`([0-9]{3}) [^`]+`/.exec(section)?.[1];
  return status ? [Number(status)] : null;
}

function parseMirrorProfileCachePolicy(closedSetFiles) {
  const source = closedSetFiles['profileV2.ts'];
  if (!source) return null;
  const block = /export const PROFILE_V2_CACHE_POLICY\s*=\s*\{([\s\S]*?)\n\} as const;/.exec(
    source,
  )?.[1];
  if (!block) return null;
  const cacheControl = /'Cache-Control':\s*'([^']+)'/.exec(block)?.[1];
  const etag = /etag:\s*'([^']+)'/.exec(block)?.[1];
  return cacheControl && etag
    ? { responseHeaders: { 'Cache-Control': cacheControl }, etag }
    : null;
}

function parseStringLiteralMembers(body) {
  return body ? [...body.matchAll(/'([^']+)'/g)].map((member) => member[1]) : null;
}

function parseSourceProfileClosedSets(source) {
  const manifest = /const PROFILE_V2_CLOSED_SETS\s*=\s*\{([\s\S]*?)\n\} as const;/.exec(source)?.[1];
  const sets = new Map();
  if (!manifest) return sets;
  const properties = /^\s{2}(PROFILE_V2_[A-Z0-9_]+):\s*\[([\s\S]*?)\][ \t]*,?[ \t]*$/gm;
  for (const property of manifest.matchAll(properties)) {
    sets.set(property[1], parseStringLiteralMembers(property[2]) ?? []);
  }
  return sets;
}

function parseMirrorProfileClosedSets(closedSetFiles) {
  const source = closedSetFiles['profileV2.ts'];
  const sets = new Map();
  if (!source) return sets;
  const declarations = /export const (PROFILE_V2_[A-Z0-9_]+)\s*=\s*\[([\s\S]*?)\]\s*as const;/g;
  for (const declaration of source.matchAll(declarations)) {
    sets.set(declaration[1], parseStringLiteralMembers(declaration[2]) ?? []);
  }
  return sets;
}

function parseProfileIntegerExpression(expression) {
  if (!expression) return null;
  const factors = expression
    .split('*')
    .map((factor) => factor.trim().replaceAll('_', ''));
  if (!factors.length || factors.some((factor) => !/^[0-9]+$/.test(factor))) return null;
  return factors.reduce((product, factor) => product * Number(factor), 1);
}

function parseProfileNumericConstant(source, name) {
  const expression = new RegExp(
    `(?:export\\s+)?const ${escapeRegExp(name)}\\s*=\\s*([^;]+);`,
  ).exec(source)?.[1];
  return parseProfileIntegerExpression(expression?.replace(/\s+as const$/, '') ?? null);
}

function parseProfileNumericObject(source, name) {
  const body = new RegExp(
    `(?:export\\s+)?const ${escapeRegExp(name)}\\s*=\\s*\\{([\\s\\S]*?)\\n\\} as const;`,
  ).exec(source)?.[1];
  if (!body) return null;
  const entries = [];
  for (const member of body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*([^,]+),?\s*$/gm)) {
    const value = parseProfileIntegerExpression(member[2]);
    if (value === null) return null;
    entries.push([member[1], value]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function parseProfileWireLimits(source) {
  if (!source) return null;
  return {
    schemaVersion: parseProfileNumericConstant(source, 'PROFILE_V2_SCHEMA_VERSION'),
    maxRequestBytes: parseProfileNumericConstant(source, 'PROFILE_V2_MAX_REQUEST_BYTES'),
    collectionLimits: parseProfileNumericObject(source, 'PROFILE_V2_COLLECTION_LIMITS'),
  };
}

function parseSourceTypeMembers(source, typeName) {
  const body = new RegExp(
    `type\\s+${escapeRegExp(typeName)}\\s*=([\\s\\S]*?);`,
  ).exec(source)?.[1];
  return body
    ? [...body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((member) => member[1])
    : null;
}

function parseSourcePatternMembers(source, spec) {
  const section = parseNumberedSection(source, spec.sourceSection);
  const body = section ? spec.sourcePattern.exec(section)?.[1] : null;
  return body
    ? [...body.matchAll(/[A-Z][A-Z0-9_]{2,}/g)].map((member) => member[0])
    : null;
}

function sameWireValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatWireValue(value) {
  return value === null ? '<missing>' : JSON.stringify(value);
}

/**
 * Structured strict-v2 parity. Unlike the broad prose-presence check, this compares both
 * directions for behavior-bearing HTTP policy and the v2 closed sets explicitly published by
 * the source contract.
 */
export function compareStrictV2Contract({ source, httpTs, closedSetFiles, closedSets }) {
  const sourceActive = /^#### 5\.9\.4[ \t]/m.test(source);
  const mirrorRecords = parseMirrorEndpointRecords(httpTs);
  const mirrorActive = STRICT_V2_ENDPOINT_SPECS.some((spec) => mirrorRecords.has(spec.id));
  if (!sourceActive && !mirrorActive) return [];

  const drift = [];
  const sourceCommon = parseSourceCommonPrivate(source);
  const mirrorCommon = parseMirrorCommonPrivate(closedSets);
  const mirrorCache = parseMirrorCachePolicy(closedSetFiles);

  for (const spec of STRICT_V2_ENDPOINT_SPECS) {
    const sourceSection = parseNumberedSection(source, spec.section);
    const mirror = mirrorRecords.get(spec.id) ?? null;
    const sourceHasEndpoint = sourceSection
      ? parseSourceEndpoints(sourceSection).has(`${spec.method} ${spec.path}`)
      : false;
    const mirrorEndpoint = mirror
      ? { method: mirror.method, path: mirror.path, section: mirror.section }
      : null;
    const expectedEndpoint = {
      method: spec.method,
      path: spec.path,
      section: spec.section,
    };
    if (!sourceHasEndpoint || !sameWireValue(mirrorEndpoint, expectedEndpoint)) {
      drift.push(
        `[strict-v2] ${spec.id}.endpoint source=${sourceHasEndpoint ? JSON.stringify(expectedEndpoint) : '<missing>'} mirror=${formatWireValue(mirrorEndpoint)}`,
      );
    }

    const statusChecks = spec.statusChecks ?? [
      { label: null, section: spec.section, mode: spec.statuses },
    ];
    for (const check of statusChecks) {
      const statusSection = parseNumberedSection(source, check.section);
      const sourceStatuses = parseSourceStatuses(statusSection, check.mode);
      const mirrorStatuses = mirror?.statuses ?? null;
      if (!sameWireValue(sourceStatuses, mirrorStatuses)) {
        const label = check.label ? `.${check.label}` : '';
        drift.push(
          `[strict-v2] ${spec.id}${label}.successStatuses source=${formatWireValue(sourceStatuses)} mirror=${formatWireValue(mirrorStatuses)}`,
        );
      }
    }

    if (spec.callerConstraint) {
      const sourceCaller =
        sourceSection && spec.callerPatterns.every((pattern) => pattern.test(sourceSection))
          ? spec.callerConstraint
          : null;
      const mirrorCaller = mirror?.callerConstraint ?? null;
      if (!sameWireValue(sourceCaller, mirrorCaller)) {
        drift.push(
          `[strict-v2] ${spec.id}.callerConstraint source=${formatWireValue(sourceCaller)} mirror=${formatWireValue(mirrorCaller)}`,
        );
      }
    }

    const sourceErrors = parseSourceErrorCodes(source, spec.errorRow, sourceCommon);
    const mirrorErrors = parseMirrorErrorCodes(httpTs, spec.id, mirrorCommon);
    if (!sameWireValue(sourceErrors, mirrorErrors)) {
      drift.push(
        `[strict-v2] ${spec.id}.errorCodes source=${formatWireValue(sourceErrors)} mirror=${formatWireValue(mirrorErrors)}`,
      );
    }

    const sourceCache = spec.cache ? parseSourceCachePolicy(sourceSection) : null;
    const endpointUsesCache = mirror?.hasResponseCache ?? false;
    const endpointMirrorCache = spec.cache && endpointUsesCache ? mirrorCache : null;
    if (!sameWireValue(sourceCache, endpointMirrorCache)) {
      drift.push(
        `[strict-v2] ${spec.id}.responseCache source=${formatWireValue(sourceCache)} mirror=${formatWireValue(endpointMirrorCache)}`,
      );
    }
  }

  for (const spec of STRICT_V2_CLOSED_SET_SPECS) {
    const sourceMembers = spec.sourceType
      ? parseSourceTypeMembers(source, spec.sourceType)
      : parseSourcePatternMembers(source, spec);
    const mirrorMembers =
      closedSets.find((set) => set.name === spec.mirrorName)?.members ?? null;
    if (!sourceMembers || !mirrorMembers) {
      drift.push(
        `[strict-v2 closed-set] ${spec.mirrorName} source=${formatWireValue(sourceMembers)} mirror=${formatWireValue(mirrorMembers)}`,
      );
      continue;
    }
    const sourceOnly = sourceMembers.filter((member) => !mirrorMembers.includes(member));
    const mirrorOnly = mirrorMembers.filter((member) => !sourceMembers.includes(member));
    if (sourceOnly.length || mirrorOnly.length) {
      drift.push(
        `[strict-v2 closed-set] ${spec.mirrorName} sourceOnly=${sourceOnly.join(',') || '-'} mirrorOnly=${mirrorOnly.join(',') || '-'}`,
      );
    }
  }

  for (const code of STRICT_V2_ERROR_CODES) {
    const sourceDefinition = parseSourceErrorDefinition(source, code);
    const mirrorDefinition = parseMirrorErrorDefinition(closedSetFiles, code);
    if (!sameWireValue(sourceDefinition, mirrorDefinition)) {
      drift.push(
        `[strict-v2 error] ${code}.metadata source=${formatWireValue(sourceDefinition)} mirror=${formatWireValue(mirrorDefinition)}`,
      );
    }
  }

  return drift;
}

const DAILY_REPORT_ROUTING_REJECTION_SET =
  'DAILY_REPORT_ROUTING_REJECTION_REASONS';

const DAILY_REPORT_MIRROR_PATH = 'dailyReports.ts';

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  const depth = { '{': 0, '[': 0, '(': 0, '<': 0 };
  const opens = new Set(Object.keys(depth));
  const closes = new Map([['}', '{'], [']', '['], [')', '('], ['>', '<']]);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (opens.has(character)) depth[character] += 1;
    else if (closes.has(character)) depth[closes.get(character)] -= 1;
    else if (character === delimiter && Object.values(depth).every((value) => value === 0)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function normalizeDailyReportType(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\breadonly\b/g, '')
    .replace(/'([^'\\]*)'/g, (_, literal) => JSON.stringify(literal))
    .replace(/\s+/g, '')
    .replace(/;}/g, '}');
}

function propertyRecord(entries) {
  return Object.fromEntries(
    entries
      .map(([name, optional, type]) => [name, { optional, type: normalizeDailyReportType(type) }])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseTsProperties(body) {
  const entries = [];
  for (const segment of splitTopLevel(body, ';')) {
    const withoutComments = segment.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!withoutComments) continue;
    const property = /^(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)(\?)?\s*:\s*([\s\S]+)$/.exec(
      withoutComments,
    );
    if (!property) return null;
    entries.push([property[1], Boolean(property[2]), property[3]]);
  }
  return propertyRecord(entries);
}

function parseSourceProperties(body) {
  const entries = [];
  for (const segment of splitTopLevel(body.replace(/^\s*\{/, '').replace(/\}\s*$/, ''), ',')) {
    const property = segment.trim();
    if (!property) continue;
    const typed = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*([\s\S]+)$/.exec(property);
    if (typed) entries.push([typed[1], false, typed[2]]);
    else if (/^[A-Za-z][A-Za-z0-9]*$/.test(property)) entries.push([property, false, '<implicit>']);
    else return null;
  }
  return propertyRecord(entries);
}

function extractTsInterface(text, name) {
  const heading = new RegExp(
    `(?:export\\s+)?interface\\s+${escapeRegExp(name)}(?:\\s+extends\\s+([^\\{]+))?\\s*\\{`,
  ).exec(text);
  if (!heading) return null;
  const open = text.indexOf('{', heading.index + heading[0].length - 1);
  const close = findMatchingBrace(text, open);
  if (close < 0) return null;
  const properties = parseTsProperties(text.slice(open + 1, close));
  return properties
    ? {
        extends: heading[1]?.trim() ?? null,
        properties,
      }
    : null;
}

function extractTsTypeAlias(text, name) {
  const heading = new RegExp(`export\\s+type\\s+${escapeRegExp(name)}\\s*=`).exec(text);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  let quote = null;
  let escaped = false;
  const depth = { '{': 0, '[': 0, '(': 0, '<': 0 };
  const opens = new Set(Object.keys(depth));
  const closes = new Map([['}', '{'], [']', '['], [')', '('], ['>', '<']]);
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (opens.has(character)) depth[character] += 1;
    else if (closes.has(character)) depth[closes.get(character)] -= 1;
    else if (character === ';' && Object.values(depth).every((value) => value === 0)) {
      return text.slice(start, index).trim();
    }
  }
  return null;
}

function parseTsObjectUnion(alias) {
  if (!alias) return null;
  const variants = splitTopLevel(alias, '|').map((variant) => variant.trim()).filter(Boolean);
  const parsed = variants.map((variant) => {
    if (!variant.startsWith('{') || !variant.endsWith('}')) return null;
    return parseTsProperties(variant.slice(1, -1));
  });
  return parsed.every(Boolean) ? parsed : null;
}

function parseNumericConst(text, name) {
  const value = new RegExp(
    `export\\s+const\\s+${escapeRegExp(name)}\\s*=\\s*(\\d+)\\s+as\\s+const;`,
  ).exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

function parseAgentEnvelopeSchemaVersion(text) {
  if (!text) return null;
  const value = parseNumericConst(text, 'AGENT_HTTP_SCHEMA_VERSION');
  const alias = normalizeDailyReportType(extractTsTypeAlias(text, 'AgentHttpSchemaVersion') ?? '');
  const envelope = extractTsInterface(text, 'AgentSchemaEnvelope');
  return value !== null &&
      alias === 'typeofAGENT_HTTP_SCHEMA_VERSION' &&
      sameWireValue(
        envelope?.properties ?? null,
        propertyRecord([['schemaVersion', false, 'AgentHttpSchemaVersion']]),
      )
    ? value
    : null;
}

function parseStringArrayConst(text, name) {
  const body = new RegExp(
    `export\\s+const\\s+${escapeRegExp(name)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const;`,
  ).exec(text)?.[1];
  if (body === undefined) return null;
  const tokens = splitTopLevel(body, ',').map((token) => token.trim());
  if (tokens.at(-1) === '') tokens.pop();
  if (!tokens.length || tokens.some((token) => token === '')) return null;
  const members = tokens.map((token) => /^'([A-Z][A-Z0-9_]*)'$/.exec(token)?.[1] ?? null);
  return members.every((member) => member !== null) ? members : null;
}

function parseStringTupleArrayConst(text, name) {
  const body = new RegExp(
    `export\\s+const\\s+${escapeRegExp(name)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const;`,
  ).exec(text)?.[1];
  if (body === undefined) return null;
  const tupleTokens = splitTopLevel(body, ',').map((token) => token.trim());
  if (tupleTokens.at(-1) === '') tupleTokens.pop();
  if (!tupleTokens.length || tupleTokens.some((token) => token === '')) return null;
  const tuples = tupleTokens.map((token) => {
    if (!token.startsWith('[') || !token.endsWith(']')) return null;
    const members = splitTopLevel(token.slice(1, -1), ',').map((member) => member.trim());
    if (!members.length || members.some((member) => member === '')) return null;
    const parsed = members.map((member) => /^'([A-Z][A-Z0-9_]*)'$/.exec(member)?.[1] ?? null);
    return parsed.every((member) => member !== null) ? parsed : null;
  });
  return tuples.every((tuple) => tuple !== null) ? tuples : null;
}

function nonemptyOrderedSubsets(values) {
  const result = [];
  for (let mask = 1; mask < 2 ** values.length; mask += 1) {
    const tuple = values.filter((_, index) => (mask & (1 << index)) !== 0);
    result.push(tuple);
  }
  return result.sort((left, right) => {
    const leftFirst = values.indexOf(left[0]);
    const rightFirst = values.indexOf(right[0]);
    return left.length === right.length
      ? leftFirst - rightFirst || left.join().localeCompare(right.join())
      : left.length - right.length;
  });
}

function parseSourceItemVariants(section) {
  const header = '| `code` | exact section | exact `source` | exact `primaryAction` |\n' +
    '| --- | --- | --- | --- |\n';
  const headerIndex = section.indexOf(header);
  if (headerIndex < 0 || section.indexOf(header, headerIndex + 1) >= 0) return null;
  const tableStart = headerIndex + header.length;
  const tableEnd = section.indexOf('\n\n', tableStart);
  if (tableEnd < 0) return null;
  const table = section.slice(tableStart, tableEnd);
  const variants = [];
  const lines = table.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^\| `([A-Z][A-Z0-9_]+)` \| `([A-Z][A-Z0-9_]+)` \| `(\{[^`]+\})` \| `(\{[^`]+\})` \|$/.exec(
      line,
    );
    if (!match) return null;
    const sourceProperties = parseSourceProperties(match[3]);
    const actionProperties = parseSourceProperties(match[4]);
    const sourceType = sourceProperties?.type?.type;
    const action = actionProperties?.code?.type;
    if (!sourceProperties || !actionProperties || !sourceType || !action) return null;
    variants.push({
      code: match[1],
      section: match[2],
      itemFields: ['code', 'itemId', 'primaryAction', 'source'],
      sourceType: JSON.parse(sourceType),
      sourceFields: Object.keys(sourceProperties).filter((field) => field !== 'type').sort(),
      sourceProperties: Object.fromEntries(
        Object.entries(sourceProperties).filter(([field]) => field !== 'type'),
      ),
      action: JSON.parse(action),
    });
  }
  return variants.length ? variants : null;
}

function parseMirrorItemVariants(text) {
  const variants = [];
  for (const match of text.matchAll(/^export interface (DailyReport[A-Za-z0-9]+Item)\s*\{/gm)) {
    const declaration = extractTsInterface(text, match[1]);
    if (!declaration) return null;
    const properties = declaration.properties;
    if (!properties.code || !properties.source || !properties.primaryAction) continue;
    const sourceType = properties.source.type;
    const actionType = properties.primaryAction.type;
    if (!sourceType.startsWith('{') || !sourceType.endsWith('}') ||
        !actionType.startsWith('{') || !actionType.endsWith('}')) return null;
    const sourceProperties = parseTsProperties(sourceType.slice(1, -1));
    const actionProperties = parseTsProperties(actionType.slice(1, -1));
    if (!sourceProperties?.type || !actionProperties?.code) return null;
    variants.push({
      code: JSON.parse(properties.code.type),
      itemFields: Object.keys(properties).sort(),
      sourceType: JSON.parse(sourceProperties.type.type),
      sourceFields: Object.keys(sourceProperties).filter((field) => field !== 'type').sort(),
      sourceProperties: Object.fromEntries(
        Object.entries(sourceProperties).filter(([field]) => field !== 'type'),
      ),
      action: JSON.parse(actionProperties.code.type),
    });
  }
  return variants.length ? variants : null;
}

function keyedVariants(variants) {
  return variants
    ? Object.fromEntries([...variants].sort((left, right) => left.code.localeCompare(right.code)).map(
        (variant) => {
          const { section: _section, ...wireVariant } = variant;
          return [variant.code, wireVariant];
        },
      ))
    : null;
}

function sourceSectionVariants(order, variants) {
  if (!order || !variants) return null;
  const mapped = order.map((section) => [
    section,
    {
      fields: ['code', 'items'],
      itemCodes: variants.filter((variant) => variant.section === section).map((variant) => variant.code),
    },
  ]);
  return mapped.every(([, value]) => value.itemCodes.length) ? Object.fromEntries(mapped) : null;
}

function parseMirrorSectionVariants(text) {
  const variants = [];
  for (const match of text.matchAll(/^export interface (DailyReport[A-Za-z0-9]+Section)\s*\{/gm)) {
    const declaration = extractTsInterface(text, match[1]);
    const code = declaration?.properties.code?.type;
    const items = declaration?.properties.items?.type;
    if (!declaration || !code || !items) return null;
    const itemMatch = /^NonEmptyReadonlyArray<([\s\S]+)>$/.exec(items);
    if (!itemMatch) return null;
    const itemCodes = [];
    for (const itemType of splitTopLevel(itemMatch[1], '|').map((value) => value.trim())) {
      const itemDeclaration = extractTsInterface(text, itemType);
      const itemCode = itemDeclaration?.properties.code?.type;
      if (!itemCode) return null;
      itemCodes.push(JSON.parse(itemCode));
    }
    variants.push([
      JSON.parse(code),
      { fields: Object.keys(declaration.properties).sort(), itemCodes },
    ]);
  }
  return variants.length ? Object.fromEntries(variants) : null;
}

function parseMirrorItemUnionCodes(text) {
  const alias = extractTsTypeAlias(text, 'DailyReportItem');
  if (!alias) return null;
  const codes = [];
  for (const arm of splitTopLevel(alias, '|').map((value) => value.trim()).filter(Boolean)) {
    if (!/^DailyReport[A-Za-z0-9]+Item$/.test(arm)) return null;
    const declaration = extractTsInterface(text, arm);
    const code = declaration?.properties.code?.type;
    if (!code) return null;
    codes.push(JSON.parse(code));
  }
  return codes.length ? codes : null;
}

function parseMirrorSectionTypeSequences(text) {
  const alias = extractTsTypeAlias(text, 'DailyReportSectionSequence');
  if (!alias) return null;
  const sequences = [];
  for (const arm of splitTopLevel(alias, '|').map(normalizeDailyReportType).filter(Boolean)) {
    if (!arm.startsWith('[') || !arm.endsWith(']')) return null;
    const names = splitTopLevel(arm.slice(1, -1), ',').map((name) => name.trim()).filter(Boolean);
    const sequence = names.map((name) => {
      const declaration = extractTsInterface(text, name);
      const code = declaration?.properties.code?.type;
      return code ? JSON.parse(code) : null;
    });
    if (sequence.some((code) => code === null)) return null;
    sequences.push(sequence);
  }
  return sequences.length ? sequences : null;
}

function parseMirrorDeliveryUnionStatuses(text) {
  const alias = extractTsTypeAlias(text, 'DailyReportDeliveryView');
  if (!alias) return null;
  const statuses = [];
  for (const arm of splitTopLevel(alias, '|').map((value) => value.trim()).filter(Boolean)) {
    const variant = extractTsTypeAlias(text, arm);
    if (!variant) return null;
    const intersections = splitTopLevel(variant, '&').map((value) => value.trim());
    const object = intersections.find((value) => value.startsWith('{') && value.endsWith('}'));
    const status = object ? parseTsProperties(object.slice(1, -1))?.status?.type : null;
    if (!status) return null;
    statuses.push(JSON.parse(status));
  }
  return statuses.length ? statuses : null;
}

const DAILY_REPORT_DERIVED_TYPE_ALIASES = Object.freeze({
  DailyReportSectionCode: 'DAILY_REPORT_SECTION_CODES',
  DailyReportItemCode: 'DAILY_REPORT_ITEM_CODES',
  DailyReportSourceType: 'DAILY_REPORT_SOURCE_TYPES',
  DailyReportPrimaryActionCode: 'DAILY_REPORT_PRIMARY_ACTION_CODES',
  DailyReportDeliveryStatus: 'DAILY_REPORT_DELIVERY_STATUSES',
});

function expectedDerivedTypeAliases() {
  return Object.fromEntries(
    Object.entries(DAILY_REPORT_DERIVED_TYPE_ALIASES).map(([typeName, constantName]) => [
      typeName,
      `(typeof${constantName})[number]`,
    ]),
  );
}

function parseMirrorDerivedTypeAliases(text) {
  return Object.fromEntries(
    Object.keys(DAILY_REPORT_DERIVED_TYPE_ALIASES).map((typeName) => [
      typeName,
      normalizeDailyReportType(extractTsTypeAlias(text, typeName) ?? ''),
    ]),
  );
}

function parseSourceObjectUnion(source) {
  if (!source) return null;
  const variants = splitTopLevel(normalizeDailyReportType(source), '|')
    .map((variant) => variant.trim())
    .filter(Boolean);
  const parsed = variants.map((variant) => {
    if (!variant.startsWith('{') || !variant.endsWith('}')) return null;
    return parseSourceProperties(variant);
  });
  return parsed.length && parsed.every(Boolean) ? parsed : null;
}

function parseSourcePreferenceEnvelope(source) {
  const properties = parseSourceProperties(source ?? '');
  const schemaVersion = properties?.schemaVersion?.type;
  const variants = parseSourceObjectUnion(properties?.preference?.type);
  return schemaVersion && /^\d+$/.test(schemaVersion) && variants
    ? { schemaVersion: Number(schemaVersion), variants }
    : null;
}

function parseSourcePreference(section) {
  const getBlock = /GET 成功 `200` exact response：\s*```text\s*([\s\S]*?)\s*```/.exec(
    section,
  )?.[1];
  const requestBlock = /PATCH request 是 normal two-arm exact union，不包含 GET-only recovery variant：\s*```text\s*([\s\S]*?)\s*```/.exec(
    section,
  )?.[1];
  const updateBlock = /PATCH 成功 `200` normal-only exact response：\s*```text\s*([\s\S]*?)\s*```/.exec(
    section,
  )?.[1];
  const typeNames = /前两个 normal arm 的 executable type 是 `([A-Za-z][A-Za-z0-9]*)`；第三个 recovery arm 是\s*`([A-Za-z][A-Za-z0-9]*)`；GET 使用的 `([A-Za-z][A-Za-z0-9]*)` exact union\s*只由这两个 type 组成/.exec(
    section,
  );
  const get = parseSourcePreferenceEnvelope(getBlock);
  const request = parseSourceObjectUnion(requestBlock);
  const update = parseSourcePreferenceEnvelope(updateBlock);
  if (!get || !request || !update || !typeNames) return null;

  const normal = get.variants.filter((variant) => !variant.reconciliationState);
  const recovery = get.variants.filter((variant) => variant.reconciliationState);
  const stateType = recovery[0]?.reconciliationState?.type ?? '';
  const state = /^"([A-Z][A-Z0-9_]+)"$/.exec(stateType)?.[1] ?? null;
  if (
    get.variants.length !== 3 || normal.length !== 2 || recovery.length !== 1 ||
    request.length !== 2 || update.variants.length !== 2 || !state
  ) return null;

  return {
    getSchemaVersion: get.schemaVersion,
    updateSchemaVersion: update.schemaVersion,
    normal,
    recovery: recovery[0],
    readResponse: get.variants,
    request,
    updateResponse: update.variants,
    readUnionMembers: [typeNames[1], typeNames[2]],
    typeNames: {
      normal: typeNames[1],
      recovery: typeNames[2],
      read: typeNames[3],
    },
    reconciliationStates: [state],
  };
}

function parseTsTypeReferenceUnion(alias) {
  if (!alias) return null;
  const members = splitTopLevel(alias, '|').map(normalizeDailyReportType).filter(Boolean);
  return members.length && members.every((member) => /^[A-Za-z][A-Za-z0-9]*$/.test(member))
    ? members
    : null;
}

function parseMirrorPreference(text) {
  const normal = parseTsObjectUnion(extractTsTypeAlias(text, 'DailyReportPreferenceView'));
  const recovery = extractTsInterface(text, 'DailyReportPreferenceTimeZoneSnapshotDriftView');
  const readUnionMembers = parseTsTypeReferenceUnion(
    extractTsTypeAlias(text, 'DailyReportPreferenceReadView'),
  );
  const request = parseTsObjectUnion(extractTsTypeAlias(text, 'UpdateDailyReportPreferenceRequest'));
  const getWrapper = extractTsInterface(text, 'GetDailyReportPreferenceResponse');
  const updateWrapper = extractTsInterface(text, 'UpdateDailyReportPreferenceResponse');
  const reconciliationStates = parseStringArrayConst(
    text,
    'DAILY_REPORT_PREFERENCE_RECONCILIATION_STATES',
  );
  const readResponse = normal && recovery?.properties && sameWireValue(
    readUnionMembers,
    ['DailyReportPreferenceView', 'DailyReportPreferenceTimeZoneSnapshotDriftView'],
  )
    ? [...normal, recovery.properties]
    : null;
  const updateResponse = normal &&
      updateWrapper?.properties.preference?.type === 'DailyReportPreferenceView'
    ? normal
    : null;
  return {
    normal,
    recovery: recovery?.properties ?? null,
    readResponse,
    request,
    updateResponse,
    readUnionMembers,
    reconciliationStates,
    getWrapper: getWrapper
      ? { extends: getWrapper.extends, properties: getWrapper.properties }
      : null,
    updateWrapper: updateWrapper
      ? { extends: updateWrapper.extends, properties: updateWrapper.properties }
      : null,
  };
}

function parseSourceDelivery(section) {
  const unread = /本 endpoint 的 items 只允许：\s*```text\s*(\{[\s\S]*?\})\s*```/.exec(section)?.[1];
  const read = /成功 `200` exact response 为\s*`\{schemaVersion:(\d+),delivery:(\{[^`]+\})\}`/.exec(
    section,
  );
  if (!unread || !read) return null;
  const unreadProperties = parseSourceProperties(unread);
  const readProperties = parseSourceProperties(read[2]);
  if (!unreadProperties || !readProperties) return null;
  return {
    unread: {
      fields: Object.keys(unreadProperties).sort(),
      status: unreadProperties.status?.type ? JSON.parse(unreadProperties.status.type) : null,
      readAt: unreadProperties.readAt?.type ?? null,
    },
    read: {
      fields: Object.keys(readProperties).sort(),
      status: readProperties.status?.type ? JSON.parse(readProperties.status.type) : null,
      readAt: readProperties.readAt?.type === '<implicit>' ? 'IsoDateTime' : null,
    },
    schemaVersion: Number(read[1]),
  };
}

function parseMirrorDelivery(text) {
  const base = extractTsInterface(text, 'DailyReportDeliveryBase');
  const parseVariant = (name) => {
    const alias = extractTsTypeAlias(text, name);
    if (!alias) return null;
    const arms = splitTopLevel(alias, '&').map((arm) => arm.trim());
    if (arms.length !== 2 || arms[0] !== 'DailyReportDeliveryBase' ||
        !arms[1].startsWith('{') || !arms[1].endsWith('}')) return null;
    return parseTsProperties(arms[1].slice(1, -1));
  };
  const unread = parseVariant('DailyReportUnreadDeliveryView');
  const read = parseVariant('DailyReportReadDeliveryView');
  if (!base || !unread || !read) return null;
  const flatten = (variant) => ({
    fields: [...Object.keys(base.properties), ...Object.keys(variant)].sort(),
    status: variant.status?.type ? JSON.parse(variant.status.type) : null,
    readAt: variant.readAt?.type ?? null,
  });
  return { unread: flatten(unread), read: flatten(read) };
}

function parseSourceDailyReportStructure(section) {
  if (!section) return null;
  section = section.replace(/\r\n?/g, '\n');
  const partBlock = /`daily_report` part[\s\S]{0,160}?exact shape 为：\s*```text\s*(\{[\s\S]*?\})\s*```/.exec(
    section,
  )?.[1];
  const part = partBlock ? parseSourceProperties(partBlock) : null;
  const variants = parseSourceItemVariants(section);
  const order = /section code 闭集与唯一顺序为 `([^`]+)`/.exec(section)?.[1]
    ?.split('->').map((member) => member.trim()) ?? null;
  const caps = /每个 source query 固定 hard cap\s*(\d+)\s*facts[\s\S]{0,180}?归并后每组最多\s*(\d+)\s*items、整份 report 最多\s*(\d+)\s*items/.exec(
    section,
  );
  const unreadLimit = /GET \/api\/v1\/agent\/daily-reports\/unread\?cursor=<opaque>&limit=(\d+)[\s\S]{0,100}?limit 默认\s*(\d+)、最大\s*(\d+)/.exec(
    section,
  );
  const preference = parseSourcePreference(section);
  const delivery = parseSourceDelivery(section);
  const listResponse = /成功 exact response 为\s*`\{schemaVersion:(\d+),items:DailyReportUnreadDeliveryView\[\],page:\{nextCursor:OpaqueCursor\|null,hasMore:boolean\}\}`/.exec(
    section,
  );
  const readRequest = /request exact 为 `(\{conversationId:Uuid,messageId:Uuid\})`/.exec(section)?.[1];
  return {
    messagePart: part,
    schemaVersions: {
      constant: part?.reportSchemaVersion ? Number(part.reportSchemaVersion.type) : null,
      part: part?.reportSchemaVersion ? Number(part.reportSchemaVersion.type) : null,
      preference: preference && preference.getSchemaVersion === preference.updateSchemaVersion
        ? preference.getSchemaVersion
        : null,
      listUnread: listResponse ? Number(listResponse[1]) : null,
      recordRead: delivery?.schemaVersion ?? null,
    },
    caps: caps && unreadLimit
      ? {
          sourceFact: Number(caps[1]),
          groupItems: Number(caps[2]),
          totalItems: Number(caps[3]),
          unreadDefault: Number(unreadLimit[2]),
          unreadMax: Number(unreadLimit[3]),
          unreadExample: Number(unreadLimit[1]),
        }
      : null,
    sectionCodes: order,
    sectionSequences: order ? nonemptyOrderedSubsets(order) : null,
    sectionTypeSequences: order ? nonemptyOrderedSubsets(order) : null,
    sectionVariants: sourceSectionVariants(order, variants),
    itemCodes: variants?.map((variant) => variant.code) ?? null,
    itemUnionCodes: variants?.map((variant) => variant.code) ?? null,
    sourceTypes: variants ? [...new Set(variants.map((variant) => variant.sourceType))] : null,
    actionCodes: variants ? [...new Set(variants.map((variant) => variant.action))] : null,
    itemVariants: keyedVariants(variants),
    deliveryStatuses: delivery ? [delivery.unread.status, delivery.read.status] : null,
    deliveryUnionStatuses: delivery ? [delivery.unread.status, delivery.read.status] : null,
    derivedTypeAliases: variants && delivery ? expectedDerivedTypeAliases() : null,
    preference: preference
      ? {
          normal: preference.normal,
          recovery: preference.recovery,
          readResponse: preference.readResponse,
          request: preference.request,
          updateResponse: preference.updateResponse,
          readUnionMembers: preference.readUnionMembers,
        }
      : null,
    reconciliationStates: preference?.reconciliationStates ?? null,
    delivery: delivery ? { unread: delivery.unread, read: delivery.read } : null,
    preferenceResponse: preference
      ? {
          get: {
            extends: 'AgentSchemaEnvelope',
            properties: propertyRecord([['preference', false, preference.typeNames.read]]),
          },
          update: {
            extends: 'AgentSchemaEnvelope',
            properties: propertyRecord([['preference', false, preference.typeNames.normal]]),
          },
        }
      : null,
    listQuery: unreadLimit
      ? propertyRecord([
          ['cursor', true, 'OpaqueCursor'],
          ['limit', true, 'number'],
        ])
      : null,
    listResponse: listResponse
      ? {
          extends: 'AgentSchemaEnvelope',
          properties: propertyRecord([
            ['items', false, 'DailyReportUnreadDeliveryView[]'],
            ['page', false, '{nextCursor:OpaqueCursor|null;hasMore:boolean}'],
          ]),
        }
      : null,
    recordReadParams: /POST \/api\/v1\/agent\/daily-reports\/:reportId\/read/.test(section)
      ? propertyRecord([['reportId', false, 'DailyReportId']])
      : null,
    recordReadRequest: readRequest ? parseSourceProperties(readRequest) : null,
    recordReadResponse: delivery
      ? {
          extends: 'AgentSchemaEnvelope',
          properties: propertyRecord([['delivery', false, 'DailyReportReadDeliveryView']]),
        }
      : null,
  };
}

function parseMirrorDailyReportStructure(text, commonText) {
  if (!text) return null;
  const part = extractTsInterface(text, 'DailyReportMessagePart');
  const variants = parseMirrorItemVariants(text);
  const preference = parseMirrorPreference(text);
  const delivery = parseMirrorDelivery(text);
  const listQuery = extractTsInterface(text, 'ListUnreadDailyReportsQuery');
  const listResponse = extractTsInterface(text, 'ListUnreadDailyReportsResponse');
  const recordParams = extractTsInterface(text, 'RecordDailyReportReadParams');
  const recordRequest = extractTsInterface(text, 'RecordDailyReportReadRequest');
  const recordResponse = extractTsInterface(text, 'RecordDailyReportReadResponse');
  const schemaVersion = parseNumericConst(text, 'DAILY_REPORT_SCHEMA_VERSION');
  const responseSchemaVersion = parseAgentEnvelopeSchemaVersion(commonText);
  return {
    messagePart: part?.properties ?? null,
    schemaVersions: {
      constant: schemaVersion,
      part: part?.properties.reportSchemaVersion
        ? Number(part.properties.reportSchemaVersion.type)
        : null,
      preference: preference?.getWrapper?.extends === 'AgentSchemaEnvelope' &&
          preference?.updateWrapper?.extends === 'AgentSchemaEnvelope'
        ? responseSchemaVersion
        : null,
      listUnread: listResponse?.extends === 'AgentSchemaEnvelope' ? responseSchemaVersion : null,
      recordRead: recordResponse?.extends === 'AgentSchemaEnvelope' ? responseSchemaVersion : null,
    },
    caps: {
      sourceFact: parseNumericConst(text, 'DAILY_REPORT_SOURCE_FACT_QUERY_CAP'),
      groupItems: parseNumericConst(text, 'DAILY_REPORT_GROUP_ITEM_CAP'),
      totalItems: parseNumericConst(text, 'DAILY_REPORT_TOTAL_ITEM_CAP'),
      unreadDefault: parseNumericConst(text, 'DAILY_REPORT_UNREAD_DEFAULT_LIMIT'),
      unreadMax: parseNumericConst(text, 'DAILY_REPORT_UNREAD_MAX_LIMIT'),
      unreadExample: parseNumericConst(text, 'DAILY_REPORT_UNREAD_DEFAULT_LIMIT'),
    },
    sectionCodes: parseStringArrayConst(text, 'DAILY_REPORT_SECTION_CODES'),
    sectionSequences: parseStringTupleArrayConst(text, 'DAILY_REPORT_SECTION_CODE_SEQUENCES'),
    sectionTypeSequences: parseMirrorSectionTypeSequences(text),
    sectionVariants: parseMirrorSectionVariants(text),
    itemCodes: parseStringArrayConst(text, 'DAILY_REPORT_ITEM_CODES'),
    itemUnionCodes: parseMirrorItemUnionCodes(text),
    sourceTypes: parseStringArrayConst(text, 'DAILY_REPORT_SOURCE_TYPES'),
    actionCodes: parseStringArrayConst(text, 'DAILY_REPORT_PRIMARY_ACTION_CODES'),
    itemVariants: keyedVariants(variants),
    deliveryStatuses: parseStringArrayConst(text, 'DAILY_REPORT_DELIVERY_STATUSES'),
    deliveryUnionStatuses: parseMirrorDeliveryUnionStatuses(text),
    derivedTypeAliases: parseMirrorDerivedTypeAliases(text),
    preference: preference
      ? {
          normal: preference.normal,
          recovery: preference.recovery,
          readResponse: preference.readResponse,
          request: preference.request,
          updateResponse: preference.updateResponse,
          readUnionMembers: preference.readUnionMembers,
        }
      : null,
    reconciliationStates: preference?.reconciliationStates ?? null,
    delivery,
    preferenceResponse: preference
      ? {
          get: preference.getWrapper,
          update: preference.updateWrapper,
        }
      : null,
    listQuery: listQuery?.properties ?? null,
    listResponse: listResponse
      ? { extends: listResponse.extends, properties: listResponse.properties }
      : null,
    recordReadParams: recordParams?.properties ?? null,
    recordReadRequest: recordRequest?.properties ?? null,
    recordReadResponse: recordResponse
      ? { extends: recordResponse.extends, properties: recordResponse.properties }
      : null,
  };
}

function parseStrictBacktickedCodeList(body, allowedResidue) {
  const matches = [...body.matchAll(/`([A-Z][A-Z0-9_]*)`/g)];
  if (!matches.length) return null;
  const residue = body.replace(/`[A-Z][A-Z0-9_]*`/g, '');
  if (!allowedResidue.test(residue)) return null;
  const members = matches.map((match) => match[1]);
  return new Set(members).size === members.length ? members : null;
}

function parseStrictSourceCommonPrivate(source) {
  const matches = [
    ...source.matchAll(/`COMMON_PRIVATE` 固定展开为：([\s\S]{0,300}?)。本表/g),
  ];
  return matches.length === 1
    ? parseStrictBacktickedCodeList(matches[0][1], /^[\s、]*$/)
    : null;
}

function parseStrictSourceEndpointErrors(source, endpoint, commonPrivate) {
  const rows = source.split(/\r?\n/).filter((line) => {
    if (!line.startsWith('|')) return false;
    const cells = line.split('|');
    return cells[1]?.trim() === `\`${endpoint}\``;
  });
  if (rows.length !== 1) return null;
  const cells = rows[0].split('|');
  if (cells.length !== 4 || cells[3].trim() !== '') return null;
  const declared = parseStrictBacktickedCodeList(cells[2], /^[\s,]*$/);
  if (!declared || (declared.includes('COMMON_PRIVATE') && !commonPrivate)) return null;
  const expanded = declared.flatMap((code) =>
    code === 'COMMON_PRIVATE' ? commonPrivate : [code],
  );
  return new Set(expanded).size === expanded.length ? expanded : null;
}

function parseStrictMirrorCommonPrivate(text) {
  const matches = [
    ...text.matchAll(
      /export const COMMON_PRIVATE_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s+as const satisfies readonly AgentErrorCode\[\];/g,
    ),
  ];
  if (matches.length !== 1) return null;
  const tokens = splitTopLevel(matches[0][1], ',').map((token) => token.trim());
  if (tokens.at(-1) === '') tokens.pop();
  if (!tokens.length || tokens.some((token) => token === '')) return null;
  const members = tokens.map((token) => /^'([A-Z][A-Z0-9_]*)'$/.exec(token)?.[1] ?? null);
  return members.every((member) => member !== null) &&
      new Set(members).size === members.length
    ? members
    : null;
}

function parseStrictMirrorEndpointErrors(httpTs, endpointId, commonPrivate) {
  const commonBindings = [
    ...httpTs.matchAll(/^const common = \[\.\.\.COMMON_PRIVATE_ERROR_CODES\] as const;$/gm),
  ];
  if (commonBindings.length !== 1 || !commonPrivate) return null;
  const heading = /export const AGENT_ENDPOINT_ERROR_CODES\s*=\s*\{/.exec(httpTs);
  if (!heading) return null;
  const open = httpTs.indexOf('{', heading.index + heading[0].length - 1);
  const close = findMatchingBrace(httpTs, open);
  if (close < 0) return null;
  const properties = splitTopLevel(httpTs.slice(open + 1, close), ',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => /^([A-Za-z][A-Za-z0-9]*):\s*([\s\S]+)$/.exec(entry))
    .filter(Boolean)
    .filter((entry) => entry[1] === endpointId);
  if (properties.length !== 1) return null;
  const expression = properties[0][2].trim();
  if (expression === 'common') return [...commonPrivate];
  if (!expression.startsWith('[') || !expression.endsWith(']')) return null;
  const tokens = splitTopLevel(expression.slice(1, -1), ',')
    .map((token) => token.trim());
  if (tokens.at(-1) === '') tokens.pop();
  if (!tokens.length || tokens.some((token) => token === '')) return null;
  const members = [];
  let commonSpreads = 0;
  for (const token of tokens) {
    if (token === '...common') {
      commonSpreads += 1;
      members.push(...commonPrivate);
      continue;
    }
    const literal = /^'([A-Z][A-Z0-9_]*)'$/.exec(token)?.[1];
    if (!literal) return null;
    members.push(literal);
  }
  return commonSpreads <= 1 && new Set(members).size === members.length ? members : null;
}

function parseSourceDailyReportSuccessStatuses(block) {
  const explicit = [
    ...block.matchAll(/成功(?:固定|：)?\s*`(\d{3})(?:\s+(?:OK|Created))?`/g),
  ];
  if (explicit.length === 1) return [Number(explicit[0][1])];
  if (explicit.length > 1) return null;

  // §3.7's unread GET states one exact successful JSON response but omits the
  // redundant number. The endpoint registry's no-policy success is HTTP 200;
  // require the source success marker rather than silently defaulting any prose.
  const defaultSuccess = [...block.matchAll(/成功 exact response 为/g)];
  return defaultSuccess.length === 1 ? [200] : null;
}

function parseSourceDailyReportEndpoints(source) {
  const headings = [
    ...source.matchAll(/^###[ \t]+(3\.7)(?=[ \t.)．。:：-]|$)[^\n]*$/gm),
  ];
  const section = headings.length === 1 ? parseNumberedSection(source, headings[0][1]) : null;
  if (!section) return null;
  const normalized = section.replace(/\r\n?/g, '\n');
  const authStatements = [
    ...source.matchAll(/^- 除 JWKS 外，所有接口要求 `Authorization: Bearer <access-token>`/gm),
  ];
  const mediaStatements = [
    ...source.matchAll(/^- `\/api\/v1\/agent\/\*\*` 的 JSON response 与每个 SSE `data` object 默认都带/gm),
  ];
  const sourceAuth = authStatements.length === 1 ? 'bearer' : null;
  const sourceMedia = mediaStatements.length === 1 ? 'json' : null;
  const sourceCommon = parseStrictSourceCommonPrivate(source);
  const markers = [
    ...normalized.matchAll(
      /^`(GET|POST|PATCH|DELETE|PUT) (\/api\/v1\/agent\/[A-Za-z0-9:/_.-]+)(?:\?[^`\n]+)?`[ \t]*$/gm,
    ),
  ];
  if (!markers.length) return null;
  const records = new Map();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const method = marker[1];
    const path = marker[2];
    const key = `${method} ${path}`;
    if (records.has(key)) return null;
    const blockStart = marker.index + marker[0].length;
    const blockEnd = markers[index + 1]?.index ?? normalized.length;
    const errorRow = `${method} ${path.slice('/api/v1/agent'.length)}`;
    records.set(key, {
      method,
      path,
      section: headings[0][1],
      auth: sourceAuth,
      media: sourceMedia,
      successStatuses: parseSourceDailyReportSuccessStatuses(
        normalized.slice(blockStart, blockEnd),
      ),
      errorCodes: parseStrictSourceEndpointErrors(source, errorRow, sourceCommon),
    });
  }
  return records;
}

function isDailyReportEndpointPath(path) {
  return typeof path === 'string' &&
    (/^\/api\/v1\/agent\/preferences\/daily-report$/.test(path) ||
      /^\/api\/v1\/agent\/daily-reports(?:\/|$)/.test(path));
}

function sameUniqueMemberSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    new Set(left).size === left.length && new Set(right).size === right.length &&
    left.length === right.length && left.every((member) => right.includes(member));
}

function compareDailyReportEndpoints({ source, httpTs, closedSetFiles }) {
  const drift = [];
  const sourceRecords = parseSourceDailyReportEndpoints(source);
  const mirrorRecords = parseMirrorEndpointRecords(httpTs);
  const mirrorCommon = parseStrictMirrorCommonPrivate(closedSetFiles['common.ts'] ?? '');
  const mirrorCandidates = [...mirrorRecords.values()].filter(
    (record) => record && isDailyReportEndpointPath(record.path),
  );
  if (!sourceRecords) {
    drift.push('[strict-t12 endpoint] source=<unparseable> mirror=' +
      formatWireValue(mirrorCandidates.map((record) => record.id)));
    return drift;
  }

  const matchedMirrorIds = new Set();
  for (const [key, sourceRecord] of sourceRecords) {
    const matches = mirrorCandidates.filter(
      (record) => record.method === sourceRecord.method && record.path === sourceRecord.path,
    );
    const mirror = matches.length === 1 ? matches[0] : null;
    const label = mirror?.id ?? key;
    if (mirror) matchedMirrorIds.add(mirror.id);

    const fields = {
      method: mirror?.method ?? null,
      path: mirror?.path ?? null,
      section: mirror?.section ?? null,
      auth: mirror?.auth ?? null,
      media: mirror?.media ?? null,
      successStatuses: mirror
        ? (mirror.hasPolicy ? mirror.statuses : [200])
        : null,
    };
    for (const [field, mirrorValue] of Object.entries(fields)) {
      const sourceValue = sourceRecord[field];
      if (!sameWireValue(sourceValue, mirrorValue)) {
        drift.push(
          `[strict-t12 endpoint] ${label}.${field} source=${formatWireValue(sourceValue)} mirror=${formatWireValue(mirrorValue)}`,
        );
      }
    }

    const mirrorErrors = mirror
      ? parseStrictMirrorEndpointErrors(httpTs, mirror.id, mirrorCommon)
      : null;
    if (!sameUniqueMemberSet(sourceRecord.errorCodes, mirrorErrors)) {
      drift.push(
        `[strict-t12 endpoint] ${label}.errorCodes source=${formatWireValue(sourceRecord.errorCodes)} mirror=${formatWireValue(mirrorErrors)}`,
      );
    }
  }

  for (const mirror of mirrorCandidates) {
    if (!matchedMirrorIds.has(mirror.id)) {
      drift.push(
        `[strict-t12 endpoint] ${mirror.id}.endpoint source=<missing> mirror=` +
        formatWireValue({ method: mirror.method, path: mirror.path }),
      );
    }
  }
  return drift;
}

function parseDailyReportRoutingRejectionReasons(source) {
  const section = parseNumberedSection(source, '3.7');
  const body = section
    ? /`ROUTING_REJECTED` reason 的 exact 共享闭集是\s*`([^`]+)`/.exec(section)?.[1]
    : null;
  if (!body) return null;
  const members = body.split('|').map((member) => member.trim());
  if (
    members.length === 0 ||
    members.some((member) => !/^[A-Z][A-Z0-9_]{2,}$/.test(member)) ||
    new Set(members).size !== members.length
  ) {
    return null;
  }
  return members;
}

/**
 * T12 publishes the rejection reasons as one exact closure inside §3.7. A broad
 * whole-document token search is insufficient because several reasons also
 * appear in behavior prose. Compare the section-scoped source closure in both
 * directions with the one executable mirror. The source does not declare the
 * list order behavior-bearing, so parity is set-based while duplicates fail.
 */
export function compareStrictDailyReportContract({ source, httpTs, closedSetFiles, closedSets }) {
  const sourceActive = /^### 3\.7[ \t]/m.test(source);
  const mirrorMatches = closedSets.filter(
    (set) => set.name === DAILY_REPORT_ROUTING_REJECTION_SET,
  );
  const mirrorSource = closedSetFiles[DAILY_REPORT_MIRROR_PATH] ?? null;
  if (!sourceActive && mirrorMatches.length === 0 && !mirrorSource) return [];

  const drift = [];
  const sourceStructure = sourceActive
    ? parseSourceDailyReportStructure(parseNumberedSection(source, '3.7'))
    : null;
  const mirrorStructure = parseMirrorDailyReportStructure(
    mirrorSource,
    closedSetFiles['common.ts'] ?? null,
  );
  const components = [
    'messagePart',
    'schemaVersions',
    'caps',
    'sectionCodes',
    'sectionSequences',
    'sectionTypeSequences',
    'sectionVariants',
    'itemCodes',
    'itemUnionCodes',
    'sourceTypes',
    'actionCodes',
    'itemVariants',
    'deliveryStatuses',
    'deliveryUnionStatuses',
    'derivedTypeAliases',
    'preference',
    'reconciliationStates',
    'delivery',
    'preferenceResponse',
    'listQuery',
    'listResponse',
    'recordReadParams',
    'recordReadRequest',
    'recordReadResponse',
  ];
  for (const component of components) {
    const sourceValue = sourceStructure?.[component] ?? null;
    const mirrorValue = mirrorStructure?.[component] ?? null;
    if (!sameWireValue(sourceValue, mirrorValue)) {
      drift.push(
        `[strict-t12 structure] ${component} source=${formatWireValue(sourceValue)} mirror=${formatWireValue(mirrorValue)}`,
      );
    }
  }
  drift.push(...compareDailyReportEndpoints({ source, httpTs, closedSetFiles }));

  const sourceMembers = sourceActive
    ? parseDailyReportRoutingRejectionReasons(source)
    : null;
  const mirrorMembers = mirrorMatches.length === 1 &&
      new Set(mirrorMatches[0].members).size === mirrorMatches[0].members.length
    ? mirrorMatches[0].members
    : null;
  if (!sourceMembers || !mirrorMembers) {
    drift.push(
      `[strict-t12 closed-set] ${DAILY_REPORT_ROUTING_REJECTION_SET} ` +
      `source=${formatWireValue(sourceMembers)} mirror=${formatWireValue(mirrorMembers)}`,
    );
    return drift;
  }

  const sourceOnly = sourceMembers.filter((member) => !mirrorMembers.includes(member));
  const mirrorOnly = mirrorMembers.filter((member) => !sourceMembers.includes(member));
  if (sourceOnly.length || mirrorOnly.length) {
    drift.push(
      `[strict-t12 closed-set] ${DAILY_REPORT_ROUTING_REJECTION_SET} ` +
      `sourceOnly=${sourceOnly.join(',') || '-'} mirrorOnly=${mirrorOnly.join(',') || '-'}`,
    );
  }

  return drift;
}

/** Bidirectional parity for the owner Profile V2 source and its stable package mirror. */
export function compareStrictProfileV2Contract({ source, httpTs, closedSetFiles, closedSets }) {
  const sourceActive = /^### 5\.13[ \t]/m.test(source);
  const mirrorRecords = parseMirrorEndpointRecords(httpTs);
  const mirrorActive = STRICT_PROFILE_V2_ENDPOINT_SPECS.some((spec) =>
    mirrorRecords.has(spec.id),
  );
  if (!sourceActive && !mirrorActive) return [];

  const drift = [];
  const sourceSection = parseNumberedSection(source, '5.13');
  const sourceCommon = parseSourceCommonPrivate(source);
  const mirrorCommon = parseMirrorCommonPrivate(closedSets);
  const sourceCache = parseSourceProfileCachePolicy(sourceSection);
  const sourceSuccessStatuses = parseSourceProfileSuccessStatuses(sourceSection);
  const mirrorCache = parseMirrorProfileCachePolicy(closedSetFiles);
  const sourceProfileClosedSets = parseSourceProfileClosedSets(source);
  const mirrorProfileClosedSets = parseMirrorProfileClosedSets(closedSetFiles);
  const sourceWireLimits = parseProfileWireLimits(source);
  const mirrorWireLimits = parseProfileWireLimits(closedSetFiles['profileV2.ts']);

  if (!sameWireValue(sourceWireLimits, mirrorWireLimits)) {
    drift.push(
      `[strict-profile-v2] wireLimits source=${formatWireValue(sourceWireLimits)} mirror=${formatWireValue(mirrorWireLimits)}`,
    );
  }

  for (const spec of STRICT_PROFILE_V2_ENDPOINT_SPECS) {
    const mirror = mirrorRecords.get(spec.id) ?? null;
    const sourceHasEndpoint = sourceSection
      ? parseSourceEndpoints(sourceSection).has(`${spec.method} ${spec.path}`)
      : false;
    const mirrorEndpoint = mirror
      ? { method: mirror.method, path: mirror.path, section: mirror.section }
      : null;
    const expectedEndpoint = {
      method: spec.method,
      path: spec.path,
      section: spec.section,
    };
    if (!sourceHasEndpoint || !sameWireValue(mirrorEndpoint, expectedEndpoint)) {
      drift.push(
        `[strict-profile-v2] ${spec.id}.endpoint source=${sourceHasEndpoint ? JSON.stringify(expectedEndpoint) : '<missing>'} mirror=${formatWireValue(mirrorEndpoint)}`,
      );
    }

    if (!sameWireValue(sourceSuccessStatuses, mirror?.statuses ?? null)) {
      drift.push(
        `[strict-profile-v2] ${spec.id}.successStatuses source=${formatWireValue(sourceSuccessStatuses)} mirror=${formatWireValue(mirror?.statuses ?? null)}`,
      );
    }

    const sourceCaller =
      sourceSection && /三个 route 都要求 bearer owner auth/.test(sourceSection)
        ? 'owner-bearer'
        : null;
    if (!sameWireValue(sourceCaller, mirror?.callerConstraint ?? null)) {
      drift.push(
        `[strict-profile-v2] ${spec.id}.callerConstraint source=${formatWireValue(sourceCaller)} mirror=${formatWireValue(mirror?.callerConstraint ?? null)}`,
      );
    }

    const sourceErrors = parseSourceErrorCodes(source, spec.errorRow, sourceCommon);
    const mirrorErrors = parseMirrorErrorCodes(httpTs, spec.id, mirrorCommon);
    if (!sameWireValue(sourceErrors, mirrorErrors)) {
      drift.push(
        `[strict-profile-v2] ${spec.id}.errorCodes source=${formatWireValue(sourceErrors)} mirror=${formatWireValue(mirrorErrors)}`,
      );
    }

    const endpointMirrorCache =
      mirror?.responseCacheName === 'PROFILE_V2_CACHE_POLICY' ? mirrorCache : null;
    if (!sameWireValue(sourceCache, endpointMirrorCache)) {
      drift.push(
        `[strict-profile-v2] ${spec.id}.responseCache source=${formatWireValue(sourceCache)} mirror=${formatWireValue(endpointMirrorCache)}`,
      );
    }
  }

  const profileClosedSetNames = [...new Set([
    ...sourceProfileClosedSets.keys(),
    ...mirrorProfileClosedSets.keys(),
  ])].sort();
  for (const name of profileClosedSetNames) {
    const sourceMembers = sourceProfileClosedSets.get(name) ?? null;
    const mirrorMembers = mirrorProfileClosedSets.get(name) ?? null;
    if (!sameWireValue(sourceMembers, mirrorMembers)) {
      drift.push(
        `[strict-profile-v2 closed-set] ${name} source=${formatWireValue(sourceMembers)} mirror=${formatWireValue(mirrorMembers)}`,
      );
    }
  }

  return drift;
}

import {
  classifyClosedSet,
  findStaleExemptions,
  findStaleGovernedRegistrations,
  findUnclassified,
} from './closed-set-manifest.mjs';

/**
 * 三层比对。返回结构化结果，**由调用方决定怎么退出**。
 *
 * `closedSetFiles` 与 `source` 都是文本，所以这个函数在测试里可以用
 * fixture 完整驱动——这正是把它抽出来的目的。
 */
export function compareContract({ source, httpTs, closedSetFiles, checkStaleExemptions = false }) {
  const srcEps = parseSourceEndpoints(source);
  const mirrorCalls = parseMirrorEndpoints(httpTs);
  const mirrorEps = new Set(mirrorCalls.map((c) => `${c.method} ${c.path}`));
  const headings = parseHeadingSections(source);
  const closedSets = parseClosedSets(closedSetFiles);

  const missing = [...srcEps].filter((e) => !mirrorEps.has(e)).sort();
  const extra = [...mirrorEps].filter((e) => !srcEps.has(e)).sort();

  const badSection = mirrorCalls
    .filter((c) => !headings.has(c.section))
    .map((c) => `${c.method} ${c.path} → 声称 §${c.section}，源契约的标题集合里没有这一节`)
    .sort();

  // 闭集只比对**后端源契约治理**的那些。语义由 manifest 显式定义，
  // 不靠目录递归猜——Yiwen 二轮【高1】：递归扩大了范围但没定义语义，
  // 于是 draft/（浏览器内通道，不经后端）被当成漂移，真实双仓上门禁直接红。
  const governed = closedSets.filter((s) => classifyClosedSet(s.path, s.name).governed);

  const drifted = [];
  for (const set of governed) {
    const absent = set.members.filter((v) => !source.includes(v));
    if (absent.length) drifted.push(`${set.path} ${set.name} → ${absent.join(', ')}`);
  }
  drifted.push(
    ...compareStrictV2Contract({ source, httpTs, closedSetFiles, closedSets }),
    ...compareStrictDailyReportContract({ source, httpTs, closedSetFiles, closedSets }),
    ...compareStrictProfileV2Contract({ source, httpTs, closedSetFiles, closedSets }),
  );

  // 两个反方向，防 manifest 悄悄失真：
  const unclassified = findUnclassified(closedSets).map(
    (k) => `${k} —— 子目录里的闭集必须显式登记：受治理就写进 GOVERNED_NESTED，不受治理就写进 EXEMPT 并说明理由`,
  );
  // 过期豁免是**仓库级卫生检查**，只在扫的是真实全量 `packages/contracts/src`
  // 时才有意义——fixture 只含子集，一开就必然误报。所以要调用方显式打开，
  // CLI 打开、fixture 测试默认关（另有一条专门的用例开着它测）。
  const staleExemptions = checkStaleExemptions
    ? findStaleExemptions(closedSets).map(
        (k) => `${k} —— EXEMPT 里登记了，但代码里已不存在。删掉这条豁免，别让 manifest 变成过期清单`,
      )
    : [];
  const staleGovernedRegistrations = checkStaleExemptions
    ? findStaleGovernedRegistrations(closedSets).map(
        (k) => `${k} —— GOVERNED_NESTED 里登记了，但代码里已不存在。删除过期登记或恢复受治理闭集`,
      )
    : [];

  return {
    counts: {
      sourceEndpoints: srcEps.size,
      mirrorEndpoints: mirrorEps.size,
      headings: headings.size,
      closedSetsSeen: closedSets.length,
      closedSetsGoverned: governed.length,
      governedMembers: governed.reduce((n, s) => n + s.members.length, 0),
    },
    missing,
    extra,
    badSection,
    drifted,
    unclassified,
    staleExemptions,
    staleGovernedRegistrations,
    get failed() {
      return (
        missing.length +
        extra.length +
        badSection.length +
        drifted.length +
        unclassified.length +
        staleExemptions.length +
        staleGovernedRegistrations.length
      );
    },
  };
}
