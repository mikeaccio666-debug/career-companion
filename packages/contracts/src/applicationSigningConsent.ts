import type { AgentSchemaEnvelope, IsoDateTime } from './common.ts';

/**
 * 代填授权的同意——跟 argoland `contracts/consents.ts`（那边是权威）。
 *
 * 用户在资料页保存按钮旁**单独**勾选一句话（2026-09-28 负责人定稿）：「允许 ArgoLand 以我的名义处理申请表上的条款、
 * 声明和授权，并替我注册、登录招聘网站。详见隐私政策。」每一类具体是什么，写在 argoland 隐私政策里带版本号的那一节
 * （「ArgoLand 替你处理申请表的范围」，版本与这里的文案版本相同）；范围一改，那一节与这里的版本号一起升，旧版本的同意
 * 不覆盖新加的类别——而且只有当前版本算数（2026-09-28 起不再认旧版本，没有外部用户，内部用户直接换新包）。
 *
 * 读：`GET /api/v1/agent/consents/application-signing`。读不到、解不开、版本不对，一律当没同意；与运行时包里的
 * `sign-on-behalf` 写能力位**同时**成立才代填。插件资料编辑器里的开关与浮层里的一键同意也用同一对端点；同意时请求体
 * 带上**这一版**的版本号，服务端的当前版本不是它就拒——旧插件不会替用户同意一段它没显示过的文案。
 */
export const APPLICATION_SIGNING_CONSENT_PURPOSE = 'application-signing' as const;
/**
 * 资料页上那一格勾选的文案版本（与 argoland 逐字相同），也是隐私政策里那一节的版本。2026-09-24 升版：文案加上六类
 * 同意；2026-09-28 再升版：勾选框改成一句话，范围（加上第五刀的新类别与「替你注册、登录招聘网站」）写进隐私政策那一节。
 */
export const APPLICATION_SIGNING_CONSENT_VERSION = 'application-signing-2026-09-28' as const;

/** 同意时的请求体：用户看到的那一版文案。 */
export interface GrantApplicationSigningConsentRequest {
  readonly policyVersion: string;
}

export interface ApplicationSigningConsentView {
  readonly purpose: typeof APPLICATION_SIGNING_CONSENT_PURPOSE;
  /** 服务端当前要求的文案版本。 */
  readonly policyVersion: string;
  /** 这个用途最新的一条事件接受的正是这个版本。 */
  readonly granted: boolean;
  readonly grantedAt: IsoDateTime | null;
  /**
   * 这个用途最新的一条事件是他撤回（2026-09-28 起，additive）。浮层据此只请没撤回过的人同意当前版本：撤回过的不再问。
   * 它不改变同意的意思（是不是同意照旧只看版本号与 granted）；老服务端不发这个键，读成 false。
   */
  readonly revoked: boolean;
}

export interface GetApplicationSigningConsentResponse extends AgentSchemaEnvelope {
  readonly consent: ApplicationSigningConsentView;
}

/**
 * 门户与插件共用的解码。形状不对一律 null——调用方把 null 当「没同意」。
 *
 * 应答里多出来的成员不拒、不解释（2026-09-28 核对并钉进测试）：同意的**意思**只由 `policyVersion`
 * 定。所以任何改变意思的东西（按类别撤回、限定范围、新的类别……）都必须升版本号——旧插件见到新版本号
 * 一律当没同意；只加一个字段去收窄同意而不升版本号，旧插件看不见，那是失守的方向。`revoked` 不在此列：
 * 它只决定要不要请他同意，不改变同意本身。
 */
export function parseApplicationSigningConsentResponse(value: unknown): ApplicationSigningConsentView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const envelope = value as { schemaVersion?: unknown; consent?: unknown };
  if (envelope.schemaVersion !== 1) return null;
  const consent = envelope.consent;
  if (typeof consent !== 'object' || consent === null || Array.isArray(consent)) return null;
  const record = consent as Record<string, unknown>;
  if (
    record.purpose !== APPLICATION_SIGNING_CONSENT_PURPOSE ||
    typeof record.policyVersion !== 'string' ||
    record.policyVersion.length === 0 ||
    typeof record.granted !== 'boolean' ||
    !(record.grantedAt === null || typeof record.grantedAt === 'string') ||
    (record.granted && record.grantedAt === null) ||
    !(record.revoked === undefined || typeof record.revoked === 'boolean') ||
    // 「同意着当前版本」与「最新一条是撤回」不会同时成立。
    (record.granted && record.revoked === true)
  ) {
    return null;
  }
  return Object.freeze({
    purpose: APPLICATION_SIGNING_CONSENT_PURPOSE,
    policyVersion: record.policyVersion,
    granted: record.granted,
    grantedAt: record.grantedAt as IsoDateTime | null,
    revoked: record.revoked === true,
  });
}
