import { parseUuid } from '@edaix/contracts';
import { selfIdentificationCodesFromAnswers, type SelfIdentificationCodes } from '@edaix/apply-kernel/selfIdentificationAnswers';
import type { ProfileDirectoryTransport } from './profileDirectoryTransport';
import type { HttpFailure } from './diagnosticsUploader';
import { directoryHttpFailure } from './httpFailure';

/**
 * worker 侧：用户自己存的 EEO 自我认同答案 → 内核预填认的四个码（2026-09-21）。
 *
 * ## 为什么扁平档案里从来没有它
 *
 * argoland 的扁平档案端点对 `eeoGender / eeoRace / eeoVeteran / eeoDisability` 四个键**一律答
 * null**——它的答案源投影把 SELF_ID_* 四个概念判成「需要用户确认」，值不从那条路走
 * （`application-profile-answer-source.projector.ts`）。真正的答案在 `eeo-self-identification`
 * 自己的端点里，按用户在门户里选的**原文**存。这里读那个端点、译成码、交给内核；内核在能力位
 * 放行、页面上恰好一个选项对得上时直接写（2026-09-21 起：他在门户里选下并保存的那一下就是同意；
 * 此前排成 PREFILLED_NEEDS_CONFIRMATION 等第二次点头）。
 *
 * ## 用户没同意复用就一个字不带
 *
 * 那个端点带一位 `reuseEnabled`：用户在门户里是否同意把这些答案带进后续申请。为假时这里
 * 返回空——不是「读不到」，是「他没让带」，两者在诊断码上分开。
 *
 * Data-L1：答案原文只在这个进程里经过，出去的是闭集码；日志只记原因码。
 */
export const EEO_ANSWERS_DIAG_CODES = [
  'EEO_ANSWERS_AUTH_UNAVAILABLE',
  'EEO_ANSWERS_FETCH_FAILED',
  'EEO_ANSWERS_RESPONSE_MALFORMED',
] as const;
export type EeoAnswersDiagCode = (typeof EEO_ANSWERS_DIAG_CODES)[number];

export interface EeoAnswersProviderDeps {
  readonly directory: Pick<ProfileDirectoryTransport, 'run'>;
  readonly getUserId: () => Promise<string | null>;
  /**
   * 取数失败时另交那一次请求的状态码与 x-request-id（2026-10-04，体检 11-3/11-4：码里不再嵌状态码；worker 的环形缓冲里照旧
   * 写成 `EEO_ANSWERS_FETCH_FAILED_HTTP_503`，一个 FETCH_FAILED 分得清路由不存在与服务出错）。
   */
  readonly onDiagnostic?: (code: EeoAnswersDiagCode, detail?: Readonly<{ http: HttpFailure }>) => void;
}

export interface EeoAnswersProvider {
  /** 读不到 → null；没同意复用或没答 → `{}`；否则是内核认的码（只带译得出的键）。 */
  read(): Promise<SelfIdentificationCodes | null>;
}

const MAX_VALUES_PER_FIELD = 12;
const MAX_VALUE_LENGTH = 200;

function parseAnswers(value: unknown): Readonly<Partial<Record<string, readonly string[]>>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const answers: Record<string, readonly string[]> = {};
  for (const [field, values] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES_PER_FIELD) return null;
    if (!values.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_VALUE_LENGTH)) return null;
    answers[field] = Object.freeze([...values] as string[]);
  }
  return answers;
}

export function createEeoAnswersProvider(deps: EeoAnswersProviderDeps): EeoAnswersProvider {
  const diag = (code: EeoAnswersDiagCode, http?: HttpFailure): void => {
    try {
      if (http === undefined) deps.onDiagnostic?.(code);
      else deps.onDiagnostic?.(code, { http });
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };

  async function read(): Promise<SelfIdentificationCodes | null> {
    let userId: string | null;
    try {
      userId = await deps.getUserId();
    } catch {
      userId = null;
    }
    if (userId === null || parseUuid(userId) === null) {
      diag('EEO_ANSWERS_AUTH_UNAVAILABLE');
      return null;
    }
    let answer: Awaited<ReturnType<ProfileDirectoryTransport['run']>> | null;
    try {
      answer = await deps.directory.run('EEO_READ');
    } catch {
      answer = null;
    }
    if (answer === null || !answer.ok) {
      // 带上 HTTP 状态：2026-09-21 生产实测这里一直失败，一个 FETCH_FAILED 分不清是路由不存在还是服务出错。
      if (answer?.code === 'LOGIN_REQUIRED') diag('EEO_ANSWERS_AUTH_UNAVAILABLE');
      else diag('EEO_ANSWERS_FETCH_FAILED', directoryHttpFailure(answer));
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(answer.text);
    } catch {
      diag('EEO_ANSWERS_RESPONSE_MALFORMED');
      return null;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      diag('EEO_ANSWERS_RESPONSE_MALFORMED');
      return null;
    }
    const record = raw as Record<string, unknown>;
    const answers = parseAnswers(record['answers']);
    if (record['schemaVersion'] !== 1 || typeof record['reuseEnabled'] !== 'boolean' || answers === null) {
      diag('EEO_ANSWERS_RESPONSE_MALFORMED');
      return null;
    }
    if (record['reuseEnabled'] !== true) return {};
    return selfIdentificationCodesFromAnswers(answers);
  }

  return Object.freeze({ read });
}
