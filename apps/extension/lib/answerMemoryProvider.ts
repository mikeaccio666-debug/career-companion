import type { AnswerMemoryClient } from './answerMemoryClient';
import {
  parseAnswerMemorySettings,
  type AnswerMemorySettings,
  type DockAnswerMemoryIntent,
  type DockAnswerMemoryReply,
} from './answerMemoryIntent';

/**
 * worker 侧：把内容脚本的四步变成对记忆 API 的读写与两个本地开关的读写（P1-6）。
 *
 * 开关存在插件本地（`browser.storage.local`，由调用方注入 get/set）：后端没有这两个开关的
 * 端点（记忆 API 的读写也不看任何服务端开关），所以「默认打开」就是这里的缺省，不是在客户端冒充服务端。
 *
 * 2026-09-28 负责人：**没设过就算开着**（记住、下次自动带出）。第一次在浮层里答上、记住了的时候说一句
 * 「已记住，下次自动填 · 可在菜单里关」（`disclosureVersion` 记下说过的那一版）；他关过的照旧关着。读不出来
 * （存储出错、存着一个认不得的形状）说不准他是不是关过，按关着算。
 */
export interface AnswerMemoryProviderDeps {
  readonly client: AnswerMemoryClient;
  readonly storage: Readonly<{ get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }>;
  readonly onDiagnostic?: (code: string) => void;
}

export interface AnswerMemoryProvider {
  handle(intent: DockAnswerMemoryIntent): Promise<DockAnswerMemoryReply>;
}

export const ANSWER_MEMORY_SETTINGS_KEY = 'answerMemorySettings';
/** 没设过：开着（记住他答的、下次自动带出），说明还没说过。 */
const UNSET_SETTINGS: AnswerMemorySettings = Object.freeze({ enabled: true, autoReuse: true, disclosureVersion: null });
/** 读不出来：按关着算。 */
const UNREADABLE_SETTINGS: AnswerMemorySettings = Object.freeze({ enabled: false, autoReuse: false });

export function createAnswerMemoryProvider(deps: AnswerMemoryProviderDeps): AnswerMemoryProvider {
  const diag = (code: string): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };
  const readSettings = async (): Promise<AnswerMemorySettings> => {
    let stored: unknown;
    try {
      stored = await deps.storage.get(ANSWER_MEMORY_SETTINGS_KEY);
    } catch {
      diag('ANSWER_MEMORY_SETTINGS_READ_FAILED');
      return UNREADABLE_SETTINGS;
    }
    if (stored === undefined || stored === null) return UNSET_SETTINGS;
    const settings = parseAnswerMemorySettings(stored);
    if (settings === null) diag('ANSWER_MEMORY_SETTINGS_UNREADABLE');
    return settings ?? UNREADABLE_SETTINGS;
  };

  return Object.freeze({
    async handle(intent: DockAnswerMemoryIntent): Promise<DockAnswerMemoryReply> {
      switch (intent.step) {
        case 'SETTINGS_GET':
          return { kind: 'ANSWER_MEMORY_SETTINGS', settings: await readSettings() };
        case 'SETTINGS_SET': {
          try {
            await deps.storage.set(ANSWER_MEMORY_SETTINGS_KEY, intent.settings);
          } catch {
            diag('ANSWER_MEMORY_SETTINGS_WRITE_FAILED');
            return { kind: 'REFUSED', code: 'UNAVAILABLE' };
          }
          return { kind: 'ANSWER_MEMORY_SETTINGS', settings: intent.settings };
        }
        case 'LIST': {
          const result = await deps.client.list();
          if (!result.ok) {
            diag(`ANSWER_MEMORY_LIST_${result.code}`);
            return { kind: 'REFUSED', code: result.code };
          }
          return { kind: 'ANSWER_MEMORY_LIST', answers: result.value };
        }
        case 'PUT': {
          const result = await deps.client.put(intent.request);
          if (!result.ok) {
            diag(`ANSWER_MEMORY_PUT_${result.code}`);
            return { kind: 'REFUSED', code: result.code };
          }
          diag('ANSWER_MEMORY_REMEMBERED');
          return { kind: 'ANSWER_MEMORY_PUT', answerKey: result.value.answerKey, revision: result.value.revision };
        }
      }
    },
  });
}
