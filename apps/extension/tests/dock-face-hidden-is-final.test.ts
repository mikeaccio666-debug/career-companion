// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://news.example/articles/1"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「这一页什么都不挂」（HIDDEN）是后台对这一页的结论，不是「没答上来」——内容脚本不为它重问（2026-10-03 全网注入实测）。
 *
 * 重问（`nextFaceRetryDelayMs`）只给两种暂时的情况：取不到规则（`RULES_UNAVAILABLE`），与后台压根没答上来（通道抖动、
 * worker 没醒）。从前内容脚本拿去判重问的是「能不能挂浮层」那个解析器（`parseAutofillDockInstruction`），HIDDEN 在那里
 * 返回 null，与「没答上来」是同一个值。于是每一个普通网页（百科、新闻、购物）都被当成没答上来：2.5、6、15 秒各重问
 * 一次，每次导航多 3 次 worker 往返、worker 一直醒到约 54 秒；回到这个标签页、pageshow、站内换路径又从头来一遍。
 *
 * 这里跑真内容脚本，只把 `browser` 换成桩、浮层换成空壳（这几条只数报到，不看浮层画成什么样），数 60 秒里发出的报到。
 * 后台答什么由桩照写：内容脚本只按答复办事，与这一页是什么网站无关。
 */

const fake = vi.hoisted(() => ({
  sent: [] as unknown[],
  /** 这一条用例里已经报到过几次。 */
  attempts: 0,
  /** 后台对第 n 次报到（从 0 数）的答复；抛出＝sendMessage 被拒（worker 没醒、通道断了）。 */
  answer: (_attempt: number): unknown => undefined,
}));

vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: <T>(config: T): T => config }));
vi.mock('wxt/browser', () => {
  return {
    browser: {
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '1.0.0' }),
        onConnect: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: (message: unknown) => {
          fake.sent.push(message);
          const kind = (message as { kind?: unknown } | null)?.kind;
          if (kind === 'apply-site-knowledge/get') return Promise.resolve({ rules: null });
          if (kind !== 'bridge/hello') return Promise.resolve(undefined);
          try {
            return Promise.resolve(fake.answer(fake.attempts++));
          } catch (error) {
            return Promise.reject(error);
          }
        },
      },
      storage: {
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        onChanged: { addListener: () => {} },
      },
    },
  };
});
vi.mock('../lib/autofillDock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/autofillDock')>();
  return {
    ...actual,
    mountAutofillDock: (face: { kind: string; reason?: string }) => ({
      faceKey: () => (face.kind === 'UNAVAILABLE' ? `${face.kind}:${face.reason}` : face.kind),
      isOpen: () => false,
      dismiss: () => {},
    }),
  };
});

const hellos = () => fake.sent.filter((message) => (message as { kind?: unknown }).kind === 'bridge/hello').length;

async function runFor60s(answer: (attempt: number) => unknown): Promise<number> {
  fake.answer = answer;
  const { default: entrypoint } = await import('../entrypoints/apply.content');
  (entrypoint as unknown as { main: () => void }).main();
  await vi.advanceTimersByTimeAsync(60_000);
  return hellos();
}

beforeEach(() => {
  fake.sent.length = 0;
  fake.attempts = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('HIDDEN 是结论，不重问', () => {
  it('后台答 HIDDEN：报到一次就停，不再为它重问', async () => {
    expect(await runFor60s(() => ({ dock: { kind: 'HIDDEN' } })), '普通网页上每一次导航只该报到一次').toBe(1);
  });

  it('先取不到规则、重问时答 HIDDEN：就停在那里', async () => {
    expect(await runFor60s((attempt) => (attempt === 0
      ? { dock: { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' } }
      : { dock: { kind: 'HIDDEN' } }))).toBe(2);
  });
});

describe('真正暂时的两种情况照旧按退避重问（2.5、6、15 秒）', () => {
  it('取不到规则（RULES_UNAVAILABLE）：再问三次', async () => {
    expect(await runFor60s(() => ({ dock: { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' } }))).toBe(4);
  });

  it('sendMessage 被拒（worker 没醒、通道断了）：再问三次', async () => {
    expect(await runFor60s(() => { throw new Error('Could not establish connection. Receiving end does not exist.'); })).toBe(4);
  });

  it('后台什么都没答（undefined，后台那段 `.catch(() => undefined)`）：再问三次', async () => {
    expect(await runFor60s(() => undefined)).toBe(4);
  });

  it('答复形状认不出：当没答上来，再问三次', async () => {
    expect(await runFor60s(() => ({ dock: { kind: 'HIDDEN', extra: true } }))).toBe(4);
  });
});
