import { parseFullAiRequest, parseFullAiReviseRequest } from '@edaix/contracts';
import type { AiAnswersClient, AiAnswersClientFailure } from './aiAnswersClient';
import {
  aiTimingBucket,
  aiTimingBuckets,
  aiTimingCodes,
  noEvidenceIds,
  usableAiFills,
  type AiAnswersRefusal,
  type DockAiAnswersIntent,
  type DockAiAnswersReply,
  type DockAiStreamMessage,
} from './aiAnswersIntent';

/**
 * worker 侧的「AI 代答」（2026-09-23 负责人决定）：一个本地开关、一次规划请求、一条只带码的回报。
 * 2026-09-24 起规划只走流（`stream`，一次「自动填写」一条 `plan/stream`）：答案一批一批交回内容脚本。
 *
 * 开关缺省**开**（负责人：像 Jobright 一样直接写上、标出来），按登录的用户存在插件本地
 * （`browser.storage.local`，后端没有这个开关的端点）。关着的时候一条请求都不发——判在这里，
 * 发请求之前，内容脚本那一侧的缓存只是省一次消息。
 *
 * 诊断只记稳定码与个数（`AI_ANSWERS_DRAFTED` 带个数 3、`AI_ANSWERS_PAYWALL_REQUIRED`……）；题面、选项与答案
 * 是 Data-L1，不进诊断、不进日志。2026-10-04（体检 11-4）起码里不嵌数字：个数随码交出去（worker 的环形缓冲里照旧写成
 * `AI_ANSWERS_DRAFTED_3`），毫秒只上报固定的桶；逐个时刻的那一串（`AI_MS_…`、`AI_SERVER_MS_…`）只进本机。
 */
export interface AiAnswersProviderDeps {
  readonly client: AiAnswersClient;
  readonly storage: Readonly<{ get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }>;
  /** 当前登录的用户（开关按人存）；读不到就记在匿名那一格。 */
  readonly userId: () => Promise<string | null>;
  readonly newId?: () => string;
  /** 稳定码；数量码另带个数（上报的码不嵌数字）。 */
  readonly onDiagnostic?: (code: string, count?: number) => void;
  /** 只进本机环形缓冲与控制台、不上报的码（逐个时刻的计时串）。 */
  readonly onLocalDiagnostic?: (code: string) => void;
}

export interface AiAnswersProvider {
  handle(intent: DockAiAnswersIntent): Promise<DockAiAnswersReply>;
  /**
   * 一次「自动填写」的规划（`PLAN`，经长连接来）：打 `plan/stream`，按到达的先后把 `DockAiStreamMessage` 交给
   * `emit`——响应头、每一批答案，最后一条永远是 `AI_STREAM_END` 或 `REFUSED`。`signal` 断开（内容脚本走了）就中止。
   * 不抛。
   */
  stream(intent: DockAiAnswersIntent, emit: (message: DockAiStreamMessage) => void, signal: AbortSignal): Promise<void>;
}

export const AI_ANSWERS_SETTINGS_KEY = 'aiAnswersSettings';
/** 同一台机器上换着登录的人不会多；存满就丢最早的那一个（丢了等于回到缺省的「开」）。 */
const MAX_REMEMBERED_USERS = 16;

/** 浮层只分这几种；其余（开关在服务端关着、模型失败、资料刚变、超时……）一律当「这次没有」，不打扰用户。 */
function refusalOf(code: AiAnswersClientFailure): AiAnswersRefusal {
  return code === 'AUTH_REQUIRED' || code === 'PAYWALL_REQUIRED' || code === 'QUOTA_EXCEEDED' ? code : 'UNAVAILABLE';
}

export function createAiAnswersProvider(deps: AiAnswersProviderDeps): AiAnswersProvider {
  const diag = (code: string, count?: number): void => {
    try {
      if (count === undefined) deps.onDiagnostic?.(code);
      else deps.onDiagnostic?.(code, count);
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };
  const local = (code: string): void => {
    try {
      deps.onLocalDiagnostic?.(code);
    } catch {
      // 同上。
    }
  };
  const userKey = async (): Promise<string> => {
    try {
      return (await deps.userId()) ?? '';
    } catch {
      return '';
    }
  };
  const readAll = async (): Promise<Record<string, boolean>> => {
    try {
      const stored = await deps.storage.get(AI_ANSWERS_SETTINGS_KEY);
      if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {};
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
    } catch {
      diag('AI_ANSWERS_SETTINGS_READ_FAILED');
      return {};
    }
  };
  /** 缺省开：没存过（或读不出来）就是开。 */
  const enabled = async (): Promise<boolean> => (await readAll())[await userKey()] !== false;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return Object.freeze({
    async handle(intent: DockAiAnswersIntent): Promise<DockAiAnswersReply> {
      switch (intent.step) {
        case 'SETTINGS_GET':
          return { kind: 'AI_ANSWERS_SETTINGS', enabled: await enabled() };
        case 'SETTINGS_SET': {
          const key = await userKey();
          const all = await readAll();
          delete all[key];
          const next = Object.fromEntries([...Object.entries(all), [key, intent.enabled]].slice(-MAX_REMEMBERED_USERS));
          try {
            await deps.storage.set(AI_ANSWERS_SETTINGS_KEY, next);
          } catch {
            diag('AI_ANSWERS_SETTINGS_WRITE_FAILED');
            return { kind: 'REFUSED', code: 'UNAVAILABLE' };
          }
          diag(intent.enabled ? 'AI_ANSWERS_SWITCHED_ON' : 'AI_ANSWERS_SWITCHED_OFF');
          return { kind: 'AI_ANSWERS_SETTINGS', enabled: intent.enabled };
        }
        case 'REPORT':
          diag(`AI_ANSWERS_${intent.outcome}`, intent.count);
          return { kind: 'AI_ANSWERS_NOTED' };
        case 'TIMING':
          // 从点击起算的几个时刻：逐个时刻的那一串只进本机（一条码放不下就接着下一条）；上报的是两个固定的码、各一个桶。
          for (const code of aiTimingCodes(intent.marks)) local(code);
          for (const code of aiTimingBuckets(intent.marks)) diag(code);
          return { kind: 'AI_ANSWERS_NOTED' };
        case 'QUOTA': {
          const result = await deps.client.quota();
          if (!result.ok) {
            diag(`AI_QUOTA_${result.code}`);
            return { kind: 'REFUSED', code: refusalOf(result.code) };
          }
          const { unlimited, limit, remaining, resetsAt } = result.value;
          return { kind: 'AI_QUOTA', quota: { unlimited, limit, remaining, resetsAt } };
        }
        case 'REVISE': {
          // 用户在卡片里亲手按的「生成」也听这个开关：关着就是不用 AI。
          if (!(await enabled())) {
            diag('AI_REVISE_OFF');
            return { kind: 'REFUSED', code: 'SWITCHED_OFF' };
          }
          const request = parseFullAiReviseRequest({
            schemaVersion: 1,
            requestId: newId(),
            page: { origin: intent.origin, pathname: intent.pathname, title: intent.title },
            field: intent.field,
            currentValue: intent.currentValue,
            instruction: intent.instruction,
          });
          if (request === null) {
            diag('AI_REVISE_REQUEST_INVALID');
            return { kind: 'REFUSED', code: 'UNAVAILABLE' };
          }
          const result = await deps.client.revise(request);
          if (!result.ok) {
            diag(`AI_REVISE_${result.code}`);
            return { kind: 'REFUSED', code: refusalOf(result.code) };
          }
          diag(result.value.trim() === '' ? 'AI_REVISE_NOTHING_TO_WRITE' : 'AI_REVISE_DRAFTED');
          return { kind: 'AI_REVISED', value: result.value };
        }
        case 'PLAN':
          // 规划只走长连接（一次「自动填写」一条流）；一次性的消息不再发请求。
          diag('AI_ANSWERS_PLAN_NOT_STREAMED');
          return { kind: 'REFUSED', code: 'UNAVAILABLE' };
      }
    },
    async stream(intent: DockAiAnswersIntent, emit: (message: DockAiStreamMessage) => void, signal: AbortSignal): Promise<void> {
      if (intent.step !== 'PLAN') {
        emit({ kind: 'REFUSED', code: 'UNAVAILABLE' });
        return;
      }
      if (!(await enabled())) {
        diag('AI_ANSWERS_OFF');
        emit({ kind: 'REFUSED', code: 'SWITCHED_OFF' });
        return;
      }
      const request = parseFullAiRequest({
        schemaVersion: 1,
        requestId: newId(),
        snapshotId: newId(),
        page: { origin: intent.origin, pathname: intent.pathname, title: intent.title },
        fields: intent.fields,
        ...(intent.job === undefined ? {} : { job: intent.job }),
      });
      if (request === null) {
        diag('AI_ANSWERS_REQUEST_INVALID');
        emit({ kind: 'REFUSED', code: 'UNAVAILABLE' });
        return;
      }
      const released = new Set<string>();
      let drafted = 0;
      let noEvidence = 0;
      const result = await deps.client.planStream(request, (event) => {
        if (event.kind === 'OPEN') {
          emit({ kind: 'AI_STREAM_OPEN' });
          return;
        }
        if (event.kind === 'SKIPPED') {
          // 后端先发的加法，这一版读不了、跳过了：只记码（一轮里重复的由诊断通道自己计数）。
          diag(event.what === 'LINE_TYPE' ? 'AI_ANSWERS_UNKNOWN_LINE_SKIPPED' : 'AI_ANSWERS_UNKNOWN_INSTRUCTION_SKIPPED');
          return;
        }
        const { lane, instructions } = event.event;
        for (const instruction of instructions) released.add(instruction.id);
        const fills = usableAiFills(instructions, request);
        const none = noEvidenceIds(instructions, request);
        drafted += fills.length;
        noEvidence += none.length;
        emit({ kind: 'AI_STREAM_ANSWERS', lane, fills, noEvidence: none });
      }, signal);
      // 一行答案都没有就失败了：整轮的结局（付费墙、次数用完、要登录……）交给浮层。
      const failure = !result.ok ? result.code : result.done.ok ? null : result.done.code;
      if (failure !== null) diag(`AI_ANSWERS_${failure}`);
      if (released.size === 0 && failure !== null) {
        emit({ kind: 'REFUSED', code: refusalOf(failure) });
        return;
      }
      diag('AI_ANSWERS_DRAFTED', drafted);
      if (noEvidence > 0) diag('AI_ANSWERS_NO_EVIDENCE', noEvidence);
      // 一个答案都没拿到的题：那一道失败了、流断了、或一行不合格就不再读。服务端的 `done` 逐题说了为什么（契约保证
      // 恰好覆盖没放出来的那几题），按原因各记一条码与个数；没读到 `done` 的就只有总数。
      const unanswered = request.fields.map((field) => field.id).filter((id) => !released.has(id));
      if (unanswered.length > 0) diag('AI_ANSWERS_UNANSWERED', unanswered.length);
      if (result.ok && result.done.ok) {
        // 服务端自己量的（`done.metrics`）：两道各自最后一批答案在这一轮的第几毫秒放出来（那一道没有题是 NA）、整轮多久、
        // 几次模型调用——与内容脚本从点击起算的 AI_MS_… 对着看，分得清慢在模型还是慢在这一头。只有数字，不带模型名。
        // 逐项的那一串只进本机；上报整轮多久的桶与模型调用的次数。
        const { fastMs, longMs, planningMs, modelCalls } = result.done.metrics;
        const ms = (value: number | null): string => (value === null ? 'NA' : String(value));
        const timing = `AI_SERVER_MS_FAST${ms(fastMs)}_LONG${ms(longMs)}_ALL${planningMs}_CALLS${modelCalls}`;
        if (timing.length <= 64) local(timing);
        diag(`AI_SERVER_TIMING_${aiTimingBucket(planningMs)}`);
        if (modelCalls > 0) diag('AI_SERVER_MODEL_CALLS', modelCalls);
        for (const miss of result.done.unanswered) diag(`AI_ANSWERS_UNANSWERED_${miss.code}`, miss.fieldIds.length);
      }
      emit({ kind: 'AI_STREAM_END', unanswered });
    },
  });
}
