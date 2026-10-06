import {
  APPLICATION_SIGNING_CONSENT_VERSION,
  parseApplicationSigningConsentResponse,
  parseUuid,
} from '@edaix/contracts';
import type { ProfileDirectoryTransport } from './profileDirectoryTransport';
import type { HttpFailure } from './diagnosticsUploader';
import { directoryHttpFailure } from './httpFailure';

/**
 * worker 侧：用户在资料页单独勾过的「代填授权」同意（2026-09-23；负责人 2026-09-22 夜的决定）。
 *
 * 2026-09-28 起勾选框是一句话（「允许 ArgoLand 以我的名义处理申请表上的条款、声明和授权，并替我注册、登录招聘网站。
 * 详见隐私政策。」），每一类写在隐私政策里版本号相同的那一节；范围一改两者一起升版本，旧版本的同意不覆盖新加的类别。
 * 负责人同一天定：**只有当前版本算数**（没有外部用户，内部用户直接换新包），同意过旧版本的按没同意处理。
 *
 * 读 `GET /api/v1/agent/consents/application-signing`（argoland #600）。只有解得开、服务端要的正是这版插件显示的那一版、
 * 且 granted，才算同意——文案描述的是插件会替他做的事，服务端换了一版文案，这版插件就不该按它代填。读不到、登录失效、
 * 形状不对、版本不对，一律当没同意（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。诊断只记原因码，不记任何值。
 *
 * 另答要不要在浮层里请他一键同意（`reconsent`）：服务端要的正是这版插件显示的那一版、他没同意、也没撤回过（最新一条事件
 * 不是撤回）。同意过旧版本的、从没同意过的都请；撤回过的不再问——那是他的决定。
 */
export const SIGNING_CONSENT_DIAG_CODES = [
  'SIGNING_CONSENT_AUTH_UNAVAILABLE',
  'SIGNING_CONSENT_FETCH_FAILED',
  'SIGNING_CONSENT_RESPONSE_MALFORMED',
  'SIGNING_CONSENT_VERSION_MISMATCH',
] as const;
export type SigningConsentDiagCode = (typeof SIGNING_CONSENT_DIAG_CODES)[number];

export interface SigningConsentStanding {
  /** 他此刻同意着当前版本（这版插件显示的那一版）；其余一律 false。 */
  readonly granted: boolean;
  /** 浮层该不该请他一键同意：服务端要的正是这一版、他没同意、也没撤回过。 */
  readonly reconsent: boolean;
}

const NONE: SigningConsentStanding = Object.freeze({ granted: false, reconsent: false });

/**
 * 「在招聘网站上用你的邮箱替你注册账号和登录，并接受注册所需的网站条款」（2026-09-28 那一版的范围，另一路在做）：
 * 只看是不是同意着当前版本。那一路要判「他同意过没有」就用它，别自己比版本号。
 */
export function signingConsentCoversAccountRegistration(standing: SigningConsentStanding): boolean {
  return standing.granted;
}

export interface SigningConsentProviderDeps {
  readonly directory: Pick<ProfileDirectoryTransport, 'run'>;
  readonly getUserId: () => Promise<string | null>;
  /**
   * 取数失败时另交那一次请求的状态码与 x-request-id：旧后端没有这条路由（404）与服务出错要分得开（2026-10-04 起码里不嵌状态码，
   * worker 的环形缓冲里照旧写成 `SIGNING_CONSENT_FETCH_FAILED_HTTP_404`）。
   */
  readonly onDiagnostic?: (code: SigningConsentDiagCode, detail?: Readonly<{ http: HttpFailure }>) => void;
}

export interface SigningConsentProvider {
  /** 同意着当前版本、要不要请他同意；任何一样读不出都是 `{ granted: false, reconsent: false }`。 */
  read(): Promise<SigningConsentStanding>;
}

export function createSigningConsentProvider(deps: SigningConsentProviderDeps): SigningConsentProvider {
  const diag = (code: SigningConsentDiagCode, http?: HttpFailure): void => {
    try {
      if (http === undefined) deps.onDiagnostic?.(code);
      else deps.onDiagnostic?.(code, { http });
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };

  async function read(): Promise<SigningConsentStanding> {
    let userId: string | null;
    try {
      userId = await deps.getUserId();
    } catch {
      userId = null;
    }
    if (userId === null || parseUuid(userId) === null) {
      diag('SIGNING_CONSENT_AUTH_UNAVAILABLE');
      return NONE;
    }
    let answer: Awaited<ReturnType<ProfileDirectoryTransport['run']>> | null;
    try {
      answer = await deps.directory.run('SIGNING_CONSENT_READ');
    } catch {
      answer = null;
    }
    if (answer === null || !answer.ok) {
      if (answer?.code === 'LOGIN_REQUIRED') diag('SIGNING_CONSENT_AUTH_UNAVAILABLE');
      else diag('SIGNING_CONSENT_FETCH_FAILED', directoryHttpFailure(answer));
      return NONE;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(answer.text);
    } catch {
      diag('SIGNING_CONSENT_RESPONSE_MALFORMED');
      return NONE;
    }
    const consent = parseApplicationSigningConsentResponse(raw);
    if (consent === null) {
      diag('SIGNING_CONSENT_RESPONSE_MALFORMED');
      return NONE;
    }
    if (consent.policyVersion !== APPLICATION_SIGNING_CONSENT_VERSION) {
      diag('SIGNING_CONSENT_VERSION_MISMATCH');
      return NONE;
    }
    return consent.granted ? Object.freeze({ granted: true, reconsent: false }) : Object.freeze({ granted: false, reconsent: !consent.revoked });
  }

  return Object.freeze({ read });
}
