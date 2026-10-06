import { describe, expect, it, vi } from 'vitest';
import { createEeoAnswersProvider } from '../lib/eeoAnswersProvider';

/**
 * worker 侧：EEO 端点的答案原文 → 内核的自我认同码；用户没同意复用就一个字不带。
 */
const USER = '76000000-0000-4000-8000-000000000001';

const view = (over: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1,
  answers: { genderIdentity: ['Woman'], veteranStatus: ['I am not a protected veteran'], raceEthnicity: ['自行描述'] },
  reuseEnabled: true, disclosureVersion: '2026-09-10', revision: '2', updatedAt: null,
  ...over,
});

function harness(over: { run?: () => Promise<unknown>; userId?: string | null } = {}) {
  const diagnostics: string[] = [];
  const run = vi.fn(over.run ?? (async () => ({ ok: true, text: view() })));
  const provider = createEeoAnswersProvider({
    directory: { run: run as never },
    getUserId: async () => (over.userId === undefined ? USER : over.userId),
    onDiagnostic: (code, detail) => { diagnostics.push(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`); },
  });
  return { provider, run, diagnostics };
}

describe('答案原文译成内核的码', () => {
  it('同意复用 → 译得出的键带出来，译不出的（自行描述）没有那个键', async () => {
    const { provider, run, diagnostics } = harness();
    expect(await provider.read()).toEqual({ eeoGender: 'FEMALE', eeoVeteran: 'NOT_PROTECTED_VETERAN' });
    expect(run).toHaveBeenCalledWith('EEO_READ');
    expect(diagnostics).toEqual([]);
  });

  it('没同意复用 → 空，不记诊断：这是他的决定，不是故障', async () => {
    const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text: view({ reuseEnabled: false }) }) });
    expect(await provider.read()).toEqual({});
    expect(diagnostics).toEqual([]);
  });

  it('还没答过（服务端的空视图）→ 空', async () => {
    const { provider } = harness({ run: async () => ({ ok: true, text: JSON.stringify({ schemaVersion: 1, answers: {}, reuseEnabled: false, disclosureVersion: null, revision: '0', updatedAt: null }) }) });
    expect(await provider.read()).toEqual({});
  });
});

describe('读不到 → null，只记稳定原因码', () => {
  it('未登录不发请求；登录态过期记 AUTH；其余记 FETCH_FAILED', async () => {
    const out = harness({ userId: null });
    expect(await out.provider.read()).toBeNull();
    expect(out.run).not.toHaveBeenCalled();
    expect(out.diagnostics).toEqual(['EEO_ANSWERS_AUTH_UNAVAILABLE']);
    const expired = harness({ run: async () => ({ ok: false, code: 'LOGIN_REQUIRED' }) });
    expect(await expired.provider.read()).toBeNull();
    expect(expired.diagnostics).toEqual(['EEO_ANSWERS_AUTH_UNAVAILABLE']);
    const down = harness({ run: async () => { throw new Error('boom'); } });
    expect(await down.provider.read()).toBeNull();
    expect(down.diagnostics).toEqual(['EEO_ANSWERS_FETCH_FAILED']);
  });

  it('服务端答了非 2xx：码不嵌状态（体检 11-4），状态码与 x-request-id 另交给上报', async () => {
    const failed = harness({ run: async () => ({ ok: false, code: 'UNAVAILABLE', status: 503, requestId: 'req-0123456789' }) });
    expect(await failed.provider.read()).toBeNull();
    expect(failed.diagnostics).toEqual(['EEO_ANSWERS_FETCH_FAILED {"http":{"httpStatus":503,"requestId":"req-0123456789"}}']);
  });

  it('形状不对整份丢弃：不是 JSON、不是 1 版、answers 不是字符串数组', async () => {
    for (const text of ['nope', view({ schemaVersion: 2 }), view({ answers: { genderIdentity: 'Woman' } }), view({ answers: { genderIdentity: [1] } }), view({ reuseEnabled: 'yes' })]) {
      const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text }) });
      expect(await provider.read()).toBeNull();
      expect(diagnostics).toEqual(['EEO_ANSWERS_RESPONSE_MALFORMED']);
    }
  });
});
