import { describe, expect, it, vi } from 'vitest';
import { ANSWER_MEMORY_NOTICE_VERSION, createDockAnswerMemoryIntent } from '../lib/answerMemoryIntent';
import { ANSWER_MEMORY_SETTINGS_KEY, createAnswerMemoryProvider } from '../lib/answerMemoryProvider';

const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;
const ANSWER = { answerKey: 'cat:relocation', categoryKey: 'relocation', controlType: 'SINGLE_CHOICE' as const, value: { kind: 'CHOICES' as const, optionTexts: ['Yes'] }, revision: '1', confirmedAt: '2026-09-21T00:00:00.000Z' };

function harness(over: { list?: () => Promise<unknown>; put?: (r: unknown) => Promise<unknown>; stored?: unknown } = {}) {
  const store = new Map<string, unknown>();
  if (over.stored !== undefined) store.set(ANSWER_MEMORY_SETTINGS_KEY, over.stored);
  const list = vi.fn(over.list ?? (async () => ({ ok: true, value: [ANSWER] })));
  const put = vi.fn(over.put ?? (async () => ({ ok: true, value: { answerKey: 'cat:relocation', revision: '2' } })));
  const diagnostics: string[] = [];
  const provider = createAnswerMemoryProvider({
    client: { list, put } as never,
    storage: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); } },
    onDiagnostic: (code) => diagnostics.push(code),
  });
  return { provider, list, put, store, diagnostics };
}

describe('两个本地开关', () => {
  it('没设过就算开着（负责人 2026-09-28：默认打开）；那一句说明还没说过', async () => {
    const h = harness();
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')!))
      .toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: true, autoReuse: true, disclosureVersion: null } });
  });
  it('他关过的照旧关着（旧的存法也认）', async () => {
    const h = harness({ stored: { enabled: false, autoReuse: false } });
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')!))
      .toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: false, autoReuse: false } });
  });
  it('设了就存在本地，再读读得回来（连同说过的那一版）', async () => {
    const h = harness();
    const settings = { enabled: true, autoReuse: true, disclosureVersion: ANSWER_MEMORY_NOTICE_VERSION };
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_SET', settings)!)).toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings });
    expect(h.store.get(ANSWER_MEMORY_SETTINGS_KEY)).toEqual(settings);
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')!)).toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings });
  });
  it('读不出来（存着一个认不得的形状、存储出错）：说不准他是不是关过，按关着算，记稳定码', async () => {
    const stale = harness({ stored: { enabled: 'yes' } });
    expect(await stale.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')!))
      .toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: false, autoReuse: false } });
    expect(stale.diagnostics).toEqual(['ANSWER_MEMORY_SETTINGS_UNREADABLE']);
    const diagnostics: string[] = [];
    const broken = createAnswerMemoryProvider({
      client: { list: vi.fn(), put: vi.fn() } as never,
      storage: { get: async () => { throw new Error('storage down'); }, set: async () => {} },
      onDiagnostic: (code) => diagnostics.push(code),
    });
    expect(await broken.handle(createDockAnswerMemoryIntent(...PAGE, 'SETTINGS_GET')!))
      .toEqual({ kind: 'ANSWER_MEMORY_SETTINGS', settings: { enabled: false, autoReuse: false } });
    expect(diagnostics).toEqual(['ANSWER_MEMORY_SETTINGS_READ_FAILED']);
  });
});

describe('清单与记住', () => {
  it('LIST 原样交回清单；读不到把那一档交回去并记稳定码', async () => {
    const h = harness();
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'LIST')!)).toEqual({ kind: 'ANSWER_MEMORY_LIST', answers: [ANSWER] });
    const dead = harness({ list: async () => ({ ok: false, code: 'AUTH_REQUIRED' }) });
    expect(await dead.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'LIST')!)).toEqual({ kind: 'REFUSED', code: 'AUTH_REQUIRED' });
    expect(dead.diagnostics).toEqual(['ANSWER_MEMORY_LIST_AUTH_REQUIRED']);
  });
  it('PUT 把契约请求原样交给客户端；答复只带键与版本', async () => {
    const h = harness();
    const request = { schemaVersion: 1 as const, answerKey: 'cat:relocation', controlType: 'SINGLE_CHOICE' as const, value: { kind: 'CHOICES' as const, optionTexts: ['Yes'] } };
    expect(await h.provider.handle(createDockAnswerMemoryIntent(...PAGE, 'PUT', request)!)).toEqual({ kind: 'ANSWER_MEMORY_PUT', answerKey: 'cat:relocation', revision: '2' });
    expect(h.put).toHaveBeenCalledWith(request);
    expect(h.diagnostics).toEqual(['ANSWER_MEMORY_REMEMBERED']);
  });
});
