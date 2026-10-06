import {
  APPLICATION_ANSWER_CONTROL_TYPES,
  parseApplicationAnswerKeyV1,
  parseApplicationAnswerValueV1,
  parsePutApplicationAnswerRequestV1,
  type ApplicationAnswerControlType,
  type PutApplicationAnswerRequestV1,
  type RememberedAnswerV1,
} from '@edaix/contracts';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * 手势填写路向 worker 要答案记忆（P1-6）。
 *
 * 与 `dock/apply-materials-intent` 同一条边界：内容脚本手上不该有 token，凭据只在 worker。
 * 四步：`LIST` 取用户记住的全部答案（内容脚本自己按契约的键比对本页题目）；`PUT` 记一条
 * 用户在补答面板里确认过的答案；`SETTINGS_GET` / `SETTINGS_SET` 读写两个本地开关
 * （要不要用记忆答题、要不要自动带出）——后端没有这两个开关的端点，它们存在插件本地。
 *
 * `PUT` 是这条消息里唯一带值的一步：那个值是用户刚刚在我们面板里亲手确认的答案，
 * 去向是第一方 API 的记忆表；它不进日志、不进遥测、不进回执。
 */
export type AnswerMemoryStep = 'LIST' | 'PUT' | 'SETTINGS_GET' | 'SETTINGS_SET';

export interface AnswerMemorySettings {
  readonly enabled: boolean;
  readonly autoReuse: boolean;
  /**
   * 他看过哪一版「记住答案」的说明（2026-09-28）。没设过的开关按开着算（负责人：默认打开），所以第一次在浮层里答上、
   * 记住了的时候说一句「已记住，下次自动填 · 可在菜单里关」，说过的那一版记在这里；他在菜单或补答面板里亲手开关过，
   * 也记当前这一版。没有这一项（旧的存法）就是还没说过。说明改了意思就升 `ANSWER_MEMORY_NOTICE_VERSION`——与补答面板
   * 的 `QUESTION_DISCLOSURE_VERSION` 同一个规矩：升了版，下一次记住时再说一次。
   */
  readonly disclosureVersion?: string | null;
}

/** 「已记住，下次自动填 · 可在菜单里关」那一句的版本（浮层文案 `memory.noted`）。改了意思就升。 */
export const ANSWER_MEMORY_NOTICE_VERSION = 'answer-memory-2026-09-28';

export type DockAnswerMemoryIntent =
  | Readonly<{ kind: 'dock/answer-memory-intent'; version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION; origin: string; pathname: string; documentPathname?: string; step: 'LIST' | 'SETTINGS_GET' }>
  | Readonly<{ kind: 'dock/answer-memory-intent'; version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION; origin: string; pathname: string; documentPathname?: string; step: 'PUT'; request: PutApplicationAnswerRequestV1 }>
  | Readonly<{ kind: 'dock/answer-memory-intent'; version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION; origin: string; pathname: string; documentPathname?: string; step: 'SETTINGS_SET'; settings: AnswerMemorySettings }>;

const BASE_KEYS = ['kind', 'version', 'origin', 'pathname', 'step'] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = keysBesidesDocumentPath(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function parseDockAnswerMemoryIntent(value: unknown): DockAnswerMemoryIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/answer-memory-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  const base = { kind: 'dock/answer-memory-intent' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin: ready.origin, pathname: ready.pathname, ...documentPathField(loaded, ready.pathname) };
  switch (candidate.step) {
    case 'LIST':
    case 'SETTINGS_GET':
      // 精确键集：多一个字段就是一种我们没约定过的形状，而这条消息会走到一次带凭据的读。
      return exactKeys(candidate, BASE_KEYS) ? Object.freeze({ ...base, step: candidate.step }) : null;
    case 'PUT': {
      if (!exactKeys(candidate, [...BASE_KEYS, 'request'])) return null;
      const request = parsePutApplicationAnswerRequestV1(candidate.request);
      return request === null ? null : Object.freeze({ ...base, step: 'PUT' as const, request });
    }
    case 'SETTINGS_SET': {
      if (!exactKeys(candidate, [...BASE_KEYS, 'settings'])) return null;
      const settings = parseAnswerMemorySettings(candidate.settings);
      return settings === null ? null : Object.freeze({ ...base, step: 'SETTINGS_SET' as const, settings });
    }
    default:
      return null;
  }
}

export function createDockAnswerMemoryIntent(
  origin: string,
  pathname: string,
  step: 'LIST' | 'SETTINGS_GET',
): DockAnswerMemoryIntent | null;
export function createDockAnswerMemoryIntent(
  origin: string,
  pathname: string,
  step: 'PUT',
  payload: PutApplicationAnswerRequestV1,
): DockAnswerMemoryIntent | null;
export function createDockAnswerMemoryIntent(
  origin: string,
  pathname: string,
  step: 'SETTINGS_SET',
  payload: AnswerMemorySettings,
): DockAnswerMemoryIntent | null;
export function createDockAnswerMemoryIntent(
  origin: string,
  pathname: string,
  step: AnswerMemoryStep,
  payload?: PutApplicationAnswerRequestV1 | AnswerMemorySettings,
): DockAnswerMemoryIntent | null {
  const base = { kind: 'dock/answer-memory-intent', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, origin, pathname, step };
  if (step === 'PUT') return parseDockAnswerMemoryIntent({ ...base, request: payload });
  if (step === 'SETTINGS_SET') return parseDockAnswerMemoryIntent({ ...base, settings: payload });
  return parseDockAnswerMemoryIntent(base);
}

export function parseAnswerMemorySettings(value: unknown): AnswerMemorySettings | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const versioned = exactKeys(candidate, ['enabled', 'autoReuse', 'disclosureVersion']);
  if (!versioned && !exactKeys(candidate, ['enabled', 'autoReuse'])) return null;
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.autoReuse !== 'boolean') return null;
  if (!versioned) return Object.freeze({ enabled: candidate.enabled, autoReuse: candidate.autoReuse });
  const version = candidate.disclosureVersion;
  if (version !== null && (typeof version !== 'string' || version === '' || version.length > 64)) return null;
  return Object.freeze({ enabled: candidate.enabled, autoReuse: candidate.autoReuse, disclosureVersion: version });
}

export type AnswerMemoryRefusal = 'AUTH_REQUIRED' | 'PAYWALL_REQUIRED' | 'REJECTED' | 'UNAVAILABLE';

export type DockAnswerMemoryReply =
  | Readonly<{ kind: 'ANSWER_MEMORY_LIST'; answers: readonly RememberedAnswerV1[] }>
  | Readonly<{ kind: 'ANSWER_MEMORY_PUT'; answerKey: string; revision: string }>
  | Readonly<{ kind: 'ANSWER_MEMORY_SETTINGS'; settings: AnswerMemorySettings }>
  | Readonly<{ kind: 'REFUSED'; code: AnswerMemoryRefusal }>;

const REFUSALS: ReadonlySet<string> = new Set(['AUTH_REQUIRED', 'PAYWALL_REQUIRED', 'REJECTED', 'UNAVAILABLE']);

export function parseDockAnswerMemoryReply(value: unknown): DockAnswerMemoryReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case 'REFUSED':
      return typeof candidate.code === 'string' && REFUSALS.has(candidate.code)
        ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code as AnswerMemoryRefusal })
        : null;
    case 'ANSWER_MEMORY_SETTINGS': {
      const settings = parseAnswerMemorySettings(candidate.settings);
      return settings === null ? null : Object.freeze({ kind: 'ANSWER_MEMORY_SETTINGS' as const, settings });
    }
    case 'ANSWER_MEMORY_PUT':
      return typeof candidate.answerKey === 'string' && typeof candidate.revision === 'string'
        ? Object.freeze({ kind: 'ANSWER_MEMORY_PUT' as const, answerKey: candidate.answerKey, revision: candidate.revision })
        : null;
    case 'ANSWER_MEMORY_LIST': {
      if (!Array.isArray(candidate.answers)) return null;
      const answers: RememberedAnswerV1[] = [];
      for (const raw of candidate.answers) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const item = raw as Record<string, unknown>;
        const controlType = item['controlType'];
        if (
          typeof item['answerKey'] !== 'string' || parseApplicationAnswerKeyV1(item['answerKey']) === null ||
          typeof controlType !== 'string' || !(APPLICATION_ANSWER_CONTROL_TYPES as readonly string[]).includes(controlType) ||
          !(item['categoryKey'] === null || typeof item['categoryKey'] === 'string') ||
          typeof item['revision'] !== 'string' || typeof item['confirmedAt'] !== 'string'
        ) return null;
        const parsed = parseApplicationAnswerValueV1(item['value'], controlType as ApplicationAnswerControlType);
        if (parsed === null) return null;
        answers.push(Object.freeze({
          answerKey: item['answerKey'], categoryKey: item['categoryKey'] as string | null,
          controlType: controlType as ApplicationAnswerControlType, value: parsed,
          revision: item['revision'], confirmedAt: item['confirmedAt'],
        }));
      }
      return Object.freeze({ kind: 'ANSWER_MEMORY_LIST' as const, answers: Object.freeze(answers) });
    }
    default:
      return null;
  }
}
