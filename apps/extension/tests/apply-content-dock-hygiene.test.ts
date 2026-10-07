// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_SIGNING_CONSENT_PURPOSE, APPLICATION_SIGNING_CONSENT_VERSION } from '@edaix/contracts';

import { parseDockRunOutcome } from '../lib/runOutcome';
import { KERNEL_BRIDGE_PORT_NAME, type BridgePortLike } from '../lib/bridgeProtocol';
import { EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY } from '../lib/executionRuntimeBundleStore';
import { readAssistantExecutorState } from '../assistant/features/autofill/executor-installation';

/**
 * 真内容脚本（entrypoints/apply.content.ts 的 main()）跑在 happy-dom 里，四周换成桩：worker 的答复、浮层（只记下交给它的
 * 处理器与它被叫了什么）、扫描、填写本身。2026-10-03 前端体检那几件「平时测不出来」的事——焦点、撤回授权、孤儿页、
 * 一轮填写的收尾——都在内容脚本的接线里，源码形状闸看不出时序，所以在这里按用户的那几下点一遍。
 *
 * 桩只到边界为止：发给 worker 的消息照真的拼、真的解析；浮层那一侧只看内容脚本叫了它什么。
 */

type Handle = Record<string, ReturnType<typeof vi.fn>> & { face: () => string; faceKey: () => string; isOpen: () => boolean };
type Mounted = { face: { kind: string; reason?: string }; handlers: Record<string, any>; handle: Handle };

const H = vi.hoisted(() => ({
  /** 这一页的内容脚本和插件之间还连着（插件更新、重载之后 runtime.id 读出来是 undefined）。 */
  runtimeId: 'argoland-test-extension' as string | undefined,
  /** worker 怎么答每一条消息；默认答法在 beforeEach 里。 */
  worker: (_message: Record<string, unknown>): unknown => undefined,
  sent: [] as Record<string, unknown>[],
  onMessage: [] as Array<(raw: unknown, sender: unknown) => unknown>,
  onConnect: [] as Array<(port: BridgePortLike & { name: string }) => void>,
  onStorageChanged: [] as Array<(changes: Record<string, unknown>, areaName: string) => void>,
  earlySubmissionCaptures: 0,
  retainedScanInvalidations: 0,
  mounts: [] as Mounted[],
  fills: [] as Record<string, unknown>[],
  fill: (_input: Record<string, unknown>): Promise<unknown> => Promise.resolve({ ok: true, outcomes: [] }),
  /** 连填的桩：这一页是不是连填的一页、这一页填完往不往下翻。 */
  chain: { begin: [] as unknown[], end: 0, kind: 'SINGLE' as 'SINGLE' | 'CHAIN', afterPage: (): Promise<boolean> => Promise.resolve(false) },
  /** 扫描答什么；null = 默认那张 Greenhouse 表。 */
  scan: null as null | (() => unknown),
  /** 数据同意页那一步（#154 D7）每一次问「两把钥匙在不在」时的答案。 */
  consentGateAllowed: [] as boolean[],
}));

vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: <T>(config: T): T => config }));
vi.mock('wxt/browser', () => {
  const dead = (): never => { throw new Error('Extension context invalidated.'); };
  return {
    browser: {
      runtime: {
        get id() { return H.runtimeId; },
        getManifest: () => (H.runtimeId === undefined ? dead() : { version: '1.1.1' }),
        // 与 Chrome 一样：和插件断了线时不是交回被拒的 promise，而是当场就抛。
        sendMessage: (message: Record<string, unknown>) => {
          if (H.runtimeId === undefined) dead();
          H.sent.push(message);
          try {
            return Promise.resolve(H.worker(message));
          } catch (error) {
            return Promise.reject(error);
          }
        },
        connect: () => dead(),
        onMessage: { addListener: (listener: (raw: unknown, sender: unknown) => unknown) => { H.onMessage.push(listener); } },
        onConnect: { addListener: (listener: (port: BridgePortLike & { name: string }) => void) => { H.onConnect.push(listener); } },
      },
      storage: {
        local: {
          get: () => (H.runtimeId === undefined ? dead() : Promise.resolve({})),
          set: () => (H.runtimeId === undefined ? dead() : Promise.resolve()),
        },
        onChanged: { addListener: (listener: (changes: Record<string, unknown>, areaName: string) => void) => { H.onStorageChanged.push(listener); } },
      },
    },
  };
});
vi.mock('../lib/autofillDock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/autofillDock')>();
  return {
    ...actual,
    mountAutofillDock: (face: { kind: string; reason?: string }, handlers: Record<string, any>) => {
      const base: Record<string, unknown> = {
        face: () => face.kind,
        faceKey: () => actual.affordanceFaceKey(face as never),
        isOpen: () => handlers.autoOpen === true,
        hasFocus: vi.fn(() => false),
      };
      const handle = new Proxy(base, { get: (target, key: string) => (target[key] ??= vi.fn()) }) as Handle;
      H.mounts.push({ face, handlers, handle });
      return handle;
    },
  };
});
vi.mock('@edaix/apply-kernel/grant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@edaix/apply-kernel/grant')>()),
  // 那一下是不是我们浮层里的真点击，有自己的测试（dom、grant）；这里只当它是。
  captureTrustedShadowGesture: () => Object.freeze({ kind: 'test-click-proof' }),
}));
vi.mock('../lib/executionRuntimeAuthority', () => ({
  installApplyAdaptersFromRules: async () => {},
  parseRuntimeExecutionAuthorization: (value: unknown) => value,
  resolveStoredDiscoveryRuntimeAuthority: async () => ({ ok: true, value: { fillPolicy: { capabilities: { 'sign-on-behalf': true } } } }),
  resolveStoredExecutionRuntimeAuthority: async () => ({ ok: false }),
}));
vi.mock('../lib/kernelScanner', () => ({
  genericApplyFormEvidence: () => 'NONE',
  openVerifiedHostShadowRoot: () => null,
  scanCurrentPageWithRuntimeAuthority: async () => null,
  scanCurrentPageWithDiscoveryAuthority: async () => (H.scan === null ? {
    scan: { descriptor: { vendor: 'greenhouse', fields: [], finalSubmitControl: null }, fieldKeys: ['firstName'] },
    vendor: 'greenhouse',
  } : H.scan()),
}));
vi.mock('../lib/consentGatePass', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/consentGatePass')>()),
  // 选哪一项、怎么写、网站怎么走各有测试（consent-gate-pass）；这里只看两把钥匙是哪一份。
  passConsentGate: async (input: { allowed: () => boolean }) => {
    H.consentGateAllowed.push(input.allowed());
    return 'STILL_HERE';
  },
}));
vi.mock('../lib/gestureFill', () => ({
  fillFromGesture: (input: Record<string, unknown>) => { H.fills.push(input); return H.fill(input); },
}));
vi.mock('../lib/fillToReview', () => ({
  createFillToReview: () => ({
    begin: (input: { root: unknown }) => {
      H.chain.begin.push(input.root);
      return H.chain.kind === 'CHAIN' ? { kind: 'CHAIN', proof: input.root, page: { number: 1 } } : { kind: 'SINGLE', proof: input.root };
    },
    end: () => { H.chain.end += 1; },
    pageOf: () => null,
    afterPage: () => H.chain.afterPage(),
    noForm: () => null,
  }),
  chainDockState: () => null,
  requiredNeedsIn: () => 0,
}));
vi.mock('../lib/wizardAdvanceController', () => ({
  createWizardAdvanceController: () => ({
    arm: () => {}, disarm: () => {}, label: () => null, nextState: () => 'NONE',
    advance: async () => 'NOT_ADVANCED', advanceInRun: async () => 'NOT_ADVANCED',
  }),
  finalSubmitOnPage: () => false,
  isRenderedControl: () => true,
  nextControlState: () => 'NONE',
}));
vi.mock('../lib/jobCardFromPage', () => ({
  createNearbyPostingReader: () => ({ summary: async () => null, location: async () => '', job: async () => undefined }),
  detailPageUrl: () => null,
  hasJobPosting: () => false,
  readJobCardFromPage: () => ({ title: '', company: '', location: '' }),
  readJobSummaryFromPage: () => ({ title: '', company: '', facts: null }),
}));
vi.mock('../lib/accountAccessPage', () => ({
  createAccountAccessPage: () => ({ handlers: {}, wallOnPage: () => false, run: async () => {}, start: () => {}, dispose: () => {} }),
}));
vi.mock('../lib/samePagePathChange', () => ({ onSamePagePathChange: () => () => {} }));
// 整轮之后的复查（2、5、10、20 秒）各有测试；这里不让它在测试之后接着跑。
vi.mock('../lib/lateRecheck', () => ({ startLateRecheck: () => () => {} }));
vi.mock('../lib/contentBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/contentBridge')>();
  return {
    ...actual,
    invalidateRetainedContentScanState: () => {
      H.retainedScanInvalidations += 1;
      actual.invalidateRetainedContentScanState();
    },
  };
});
vi.mock('../lib/submissionGestureGate', () => ({
  addExactReviewInvalidationListener: () => () => {},
  captureExactFormValueSeal: () => null,
  createSubmissionGestureGate: () => null,
  installEarlySubmissionCaptureBroker: () => {
    H.earlySubmissionCaptures += 1;
    return { addActivationListener: () => () => {}, addSubmitListener: () => () => {}, dispose: () => {} };
  },
  resolveFinalSubmissionTarget: () => null,
}));

const flush = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
};
const SHADOW = {} as ShadowRoot;
const click = (): MouseEvent => new MouseEvent('click');
const asked = (want: string): number =>
  H.sent.filter((message) => message.kind === 'dock/apply-materials-intent' && message.want === want).length;
const latest = (): Mounted => {
  const mounted = H.mounts.at(-1);
  if (mounted === undefined) throw new Error('浮层没挂上');
  return mounted;
};
/** 这一页的内容脚本跑起来，等 worker 答完第一次报到、浮层挂上。 */
async function boot(): Promise<Mounted> {
  const { default: entry } = await import('../entrypoints/apply.content');
  (entry as unknown as { main: () => void }).main();
  await flush();
  return latest();
}
/** worker 发给这个标签页的一条广播（不带 tab：是 worker 自己发的）。 */
const broadcast = (message: unknown): void => {
  for (const listener of [...H.onMessage]) listener(message, { id: 'argoland-test-extension' });
};

let face: { kind: string; reason?: string } = { kind: 'READY' };
/** worker 那一侧此刻读到的代填授权：同意着、撤回了，或者读不出来（worker 没答上）。 */
let consent: 'GRANTED' | 'REVOKED' | 'UNREADABLE' = 'GRANTED';
const consentText = (granted: boolean): string => JSON.stringify({
  schemaVersion: 1,
  consent: { purpose: APPLICATION_SIGNING_CONSENT_PURPOSE, policyVersion: APPLICATION_SIGNING_CONSENT_VERSION, granted, grantedAt: granted ? '2026-10-01T00:00:00.000Z' : null, revoked: !granted },
});

beforeEach(() => {
  vi.stubGlobal('__VIBE_ASSISTANT_READ_ENABLED__', false);
  vi.stubGlobal('__edaixAssistantExecutorV1', undefined);
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('https://boards.greenhouse.io/acme/jobs/123');
  H.runtimeId = 'argoland-test-extension';
  H.sent.length = 0;
  H.onMessage.length = 0;
  H.onConnect.length = 0;
  H.onStorageChanged.length = 0;
  H.earlySubmissionCaptures = 0;
  H.retainedScanInvalidations = 0;
  H.mounts.length = 0;
  H.fills.length = 0;
  H.fill = () => Promise.resolve({ ok: true, outcomes: [] });
  H.chain.begin.length = 0;
  H.chain.end = 0;
  H.chain.kind = 'SINGLE';
  H.chain.afterPage = () => Promise.resolve(false);
  H.scan = null;
  H.consentGateAllowed.length = 0;
  face = { kind: 'READY' };
  consent = 'GRANTED';
  H.worker = (message) => {
    // 规则要到了（要不到时隔一会儿会再要一次，见 site-knowledge.test.ts；这里不让那个定时器跑进下一条测试）。
    if (message.kind === 'apply-site-knowledge/get') return { rules: {} };
    if (message.kind === 'bridge/hello') return { dock: face };
    if (message.kind === 'dock/apply-materials-intent' && message.want === 'DISCOVERY_AUTHORITY') {
      return { kind: 'DISCOVERY_AUTHORITY', authorization: { purpose: 'DISCOVERY' } };
    }
    if (message.kind === 'dock/apply-materials-intent' && message.want === 'PROFILE') {
      // 从前的 worker 在档案答复里带着「同意着」：预取的这一份留在内容脚本里一分钟。
      return { kind: 'PROFILE', profile: { firstName: 'Taylor' }, ...(consent === 'GRANTED' ? { signOnBehalf: true } : {}) };
    }
    if (message.kind === 'dock/apply-materials-intent' && message.want === 'SIGN_ON_BEHALF') {
      return consent === 'UNREADABLE' ? undefined : { kind: 'SIGN_ON_BEHALF', granted: consent === 'GRANTED' };
    }
    if (message.kind === 'profile-directory/run' && message.operation === 'SIGNING_CONSENT_REVOKE') {
      consent = 'REVOKED';
      return { ok: true, text: consentText(false) };
    }
    if (message.kind === 'profile-directory/run') return { ok: false, code: 'UNAVAILABLE' };
    return undefined;
  };
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('Assistant executor 与默认浮层的通知边界', () => {
  it('默认浮层仍接收本插件 worker 的进度，拒绝其他发送者', async () => {
    const mounted = await boot();
    expect(H.onMessage).toHaveLength(6);
    broadcast({ kind: 'dock/run-progress', step: 'SCANNING' });
    expect(mounted.handle.setStep).toHaveBeenCalledExactlyOnceWith('SCANNING');
    for (const listener of H.onMessage) {
      listener({ kind: 'dock/run-progress', step: 'FILLING' }, { id: 'other-extension' });
      listener({ kind: 'dock/run-progress', step: 'FILLING' }, { id: H.runtimeId, tab: { id: 7 } });
    }
    expect(mounted.handle.setStep).toHaveBeenCalledTimes(1);
  });

  it('Assistant 不注册三条旧通知，但保留内核端口、包失效与提前提交保护', async () => {
    vi.stubGlobal('__VIBE_ASSISTANT_READ_ENABLED__', true);
    const { default: entry } = await import('../entrypoints/apply.content');
    (entry as unknown as { main: () => void }).main();
    await flush();
    expect(readAssistantExecutorState()).toBe('READY');
    expect(H.onMessage).toHaveLength(3);
    expect(H.mounts).toHaveLength(0);
    expect(H.sent.filter((message) => message.kind === 'bridge/hello')).toHaveLength(0);
    expect(H.earlySubmissionCaptures).toBe(1);
    expect(H.onStorageChanged).toHaveLength(1);

    const changed = H.onStorageChanged[0];
    changed({ [EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY]: { newValue: null } }, 'sync');
    expect(H.retainedScanInvalidations).toBe(0);
    changed({ [EXECUTION_RUNTIME_BUNDLE_STORAGE_KEY]: { newValue: null } }, 'local');
    expect(H.retainedScanInvalidations).toBe(1);

    expect(H.onConnect).toHaveLength(1);
    const messages: unknown[] = [];
    const received: Array<(message: unknown) => void> = [];
    const disconnected: Array<() => void> = [];
    const port: BridgePortLike & { name: string } = {
      name: 'other-port',
      postMessage: (message) => { messages.push(message); },
      onMessage: { addListener: (listener) => { received.push(listener); } },
      onDisconnect: { addListener: (listener) => { disconnected.push(listener); } },
      disconnect: () => {},
    };
    H.onConnect[0](port);
    expect(received).toHaveLength(0);
    port.name = KERNEL_BRIDGE_PORT_NAME;
    H.onConnect[0](port);
    expect(received).toHaveLength(1);
    expect(disconnected).toHaveLength(1);
    // The real bridge cannot scan without a runtime authorization.
    received[0]({ kind: 'bridge/scan', requestId: 'fictional-unauthorized-scan' });
    await flush();
    expect(messages).toEqual([{ kind: 'bridge/scan-result', requestId: 'fictional-unauthorized-scan', scan: null }]);

    broadcast({ kind: 'dock/run-progress', step: 'SCANNING' });
    broadcast({ kind: 'dock/session-changed' });
    broadcast({ kind: 'dock/profile-changed' });
    await flush();
    expect(H.mounts).toHaveLength(0);
    expect(H.sent.filter((message) => message.kind === 'bridge/hello')).toHaveLength(0);
  });
});

describe('换脸重挂与焦点（2026-10-03 体检 P0-2）', () => {
  it('焦点在旧浮层里（他刚在浮层里点了退出登录之类）：新浮层挂上后把焦点交回面板', async () => {
    const first = await boot();
    first.handle.hasFocus.mockReturnValue(true);
    face = { kind: 'UNAVAILABLE', reason: 'NO_MISSION' };
    first.handlers.onRecheck();
    await flush();
    expect(H.mounts).toHaveLength(2);
    expect(latest().handle.openPanel).toHaveBeenCalledTimes(1);
  });

  it('焦点在旧浮层收着时的启动按钮上：新浮层照旧收着，焦点交给它的启动按钮，不替他打开面板', async () => {
    face = { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' };
    const first = await boot();
    expect(first.handle.isOpen()).toBe(false);
    first.handle.hasFocus.mockReturnValue(true);
    // 换成另一张收着的脸（职位详情页那一张：不自动打开，也不排重问）。
    face = { kind: 'DORMANT' };
    first.handlers.onRecheck();
    await flush();
    expect(H.mounts).toHaveLength(2);
    expect(latest().handle.openPanel).not.toHaveBeenCalled();
    expect(latest().handle.launcherButton).toHaveBeenCalled();
  });

  it('焦点在网页上（他正在网页上打字）：换脸重挂不碰焦点', async () => {
    const first = await boot();
    face = { kind: 'UNAVAILABLE', reason: 'NO_MISSION' };
    first.handlers.onRecheck();
    await flush();
    expect(H.mounts).toHaveLength(2);
    expect(latest().handle.openPanel).not.toHaveBeenCalled();
  });
});

describe('代填授权：填写开始那一刻现读，撤回即失效（2026-10-03 体检 P0-1）', () => {
  const signed = (fill: Record<string, unknown> | undefined): boolean => fill?.signOnBehalf === true;

  it('门户上撤回了（这一页预取的档案还说同意着）：紧接着按「自动填写」，不代签', async () => {
    const mounted = await boot();
    expect(asked('PROFILE'), '浮层一挂上就预取了档案').toBe(1);
    consent = 'REVOKED';
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(H.fills).toHaveLength(1);
    expect(signed(H.fills[0])).toBe(false);
    expect(H.fills[0]).not.toHaveProperty('signingDate');
    expect(asked('SIGN_ON_BEHALF'), '按下去那一刻现读了一次').toBe(1);
    // 档案本身照旧用预取的那一份：速度不丢。
    expect(asked('PROFILE')).toBe(1);
  });

  it('同意着：照常代签，签名日期是他本地的今天', async () => {
    const mounted = await boot();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(signed(H.fills[0])).toBe(true);
    expect(H.fills[0]?.signingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('现读读不出来（worker 没答上）：当没同意——预取的档案说什么都不算', async () => {
    const mounted = await boot();
    consent = 'UNREADABLE';
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(H.fills).toHaveLength(1);
    expect(signed(H.fills[0])).toBe(false);
  });

  it('在这一页的资料编辑器里撤回：预取的档案作废，下一轮重新取，也不代签', async () => {
    const mounted = await boot();
    await expect(mounted.handlers.profilePorts.signing.set(false)).resolves.toEqual({ ok: true, value: false });
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(asked('PROFILE'), '预取的那一份作废了，这一轮重新取').toBe(2);
    expect(signed(H.fills[0])).toBe(false);
  });

  it('在资料编辑器里存了自我认同（存没存上都算）：预取的档案同样作废', async () => {
    const mounted = await boot();
    await mounted.handlers.profilePorts.eeo.save({
      genderIdentity: '', hispanicLatino: '', raceEthnicity: [], veteranStatus: '', disabilityStatus: '', reuseEnabled: false,
    }, '1');
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(asked('PROFILE')).toBe(2);
  });

  it('别的标签页或门户改了资料、授权：worker 广播一声，这一页预取的档案作废', async () => {
    const mounted = await boot();
    broadcast({ kind: 'dock/profile-changed' });
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(asked('PROFILE')).toBe(2);
  });

  /**
   * 与 #154（Jobvite 数据同意页替他选居住地，D7）合起来之后（2026-10-04 合并演练）：那一步的「他同意着当前版本」也只认这一轮按下去
   * 那一刻现读的那一份。档案答复里不再带同意（带了也不认），照旧读档案就会永远是「没同意」，撤回之前也选不了。
   */
  it('Jobvite 数据同意页：同意着就替他选；门户上撤回了（预取的档案还说同意着）就不选', async () => {
    H.scan = () => ({ scan: null, stop: 'CONSENT_GATE', vendor: 'jobvite' });
    const mounted = await boot();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    consent = 'REVOKED';
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(H.consentGateAllowed).toEqual([true, false]);
    expect(H.fills, '同意页上不填表').toHaveLength(0);
  });

  it('广播只认 worker 发的、不带值的那一条', async () => {
    const mounted = await boot();
    for (const listener of [...H.onMessage]) {
      listener({ kind: 'dock/profile-changed' }, { id: 'argoland-test-extension', tab: { id: 3 } });
      listener({ kind: 'dock/profile-changed', revision: '7' }, { id: 'argoland-test-extension' });
      listener({ kind: 'dock/profile-changed' }, { id: 'some-other-extension' });
    }
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(asked('PROFILE')).toBe(1);
  });
});

/**
 * 插件更新之后的孤儿页（2026-10-03 体检 3e）。Chrome 不给开着的页面重新注入：旧的内容脚本还在跑，runtime.id 读出来是
 * undefined，sendMessage 当场就抛。从前：「自动填写」被说成「暂时连不上 ArgoLand」，登录、退出登录、打开 ArgoLand 的那一下
 * 抛出点击处理器、一声不吭；「插件没有响应」那句话从来没发出过。
 */
describe('插件更新之后的孤儿页（2026-10-03 体检 3e）', () => {
  const gone = (): void => { H.runtimeId = undefined; };

  it('登录、退出登录、打开 ArgoLand：不抛出点击，浮层换成「已更新，刷新这一页即可继续」', async () => {
    face = { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' };
    const mounted = await boot();
    gone();
    expect(() => mounted.handlers.onOpenPortal('CONNECT')).not.toThrow();
    expect(() => mounted.handlers.onSignOut()).not.toThrow();
    expect(() => mounted.handlers.onOpenEntry('RESUME')).not.toThrow();
    await flush();
    expect(mounted.handle.extensionUpdated).toHaveBeenCalled();
    expect(mounted.handle.toast, '不再说「暂时无法打开 ArgoLand」之类').not.toHaveBeenCalled();
  });

  it('按「自动填写」：换成「已更新」那张卡，不说「暂时连不上 ArgoLand」', async () => {
    const mounted = await boot();
    gone();
    expect(() => mounted.handlers.onAutofill(click(), SHADOW)).not.toThrow();
    await flush();
    expect(mounted.handle.extensionUpdated).toHaveBeenCalled();
    expect(mounted.handle.reportBlocked).not.toHaveBeenCalled();
    expect(H.fills).toHaveLength(0);
  });

  it('按「提交」「继续到下一页」：一下都不按网站的，换成那张卡', async () => {
    const mounted = await boot();
    gone();
    await expect(mounted.handlers.submission.send(click(), SHADOW, Promise.resolve())).resolves.toBe('UNAVAILABLE');
    await expect(mounted.handlers.nextStep.advance(click(), SHADOW)).resolves.toBe('UNAVAILABLE');
    expect(mounted.handle.extensionUpdated).toHaveBeenCalledTimes(2);
  });

  it('切回这个标签页（重新报到）：探到断了线就换成那张卡，不抛', async () => {
    const mounted = await boot();
    gone();
    expect(() => mounted.handlers.onRecheck()).not.toThrow();
    await flush();
    expect(mounted.handle.extensionUpdated).toHaveBeenCalledTimes(1);
  });

  it('收起、拖动启动按钮、换语言：要写插件存储的那几下也不抛出点击', async () => {
    const mounted = await boot();
    gone();
    expect(() => mounted.handlers.onCollapse()).not.toThrow();
    expect(() => mounted.handlers.onLauncherOpen()).not.toThrow();
    expect(() => mounted.handlers.onMoveLauncher(0.3)).not.toThrow();
    expect(() => mounted.handlers.onChangeLocale('en')).not.toThrow();
    await flush();
    expect(H.mounts, '断了线就不重挂浮层：新浮层也找不到插件').toHaveLength(1);
    expect(mounted.handle.extensionUpdated).toHaveBeenCalled();
  });

  it('还连着、但 worker 没有应答（发信被拒）：说「插件没有响应」（WORKER_UNREACHABLE），不说「暂时连不上 ArgoLand」', async () => {
    const mounted = await boot();
    const answer = H.worker;
    H.worker = (message) => {
      if (message.kind === 'dock/apply-materials-intent') throw new Error('Could not establish connection. Receiving end does not exist.');
      return answer(message);
    };
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(mounted.handle.reportBlocked).toHaveBeenCalledWith('WORKER_UNREACHABLE');
    expect(mounted.handle.extensionUpdated).not.toHaveBeenCalled();
  });
});

/**
 * 一轮填写的收尾（2026-10-03 体检 3a-1、3a-2）。
 *
 * 新的一轮开始时上一轮作废（轮次 +1、按下它的「停止」），可上一轮直到真开写之前才第一次看轮次：它迟到的拒绝会把新一轮的
 * 进度卡改成失败卡、它的连填会把新一轮开的那一轮结束掉、它会在 worker 里再记一条任务运行。半路抛一个错，进度卡和「停止」
 * 永远挂着，只能刷新页面，后台什么都看不到。
 */
describe('一轮填写：被取代的一轮不碰浮层，抛了就照「没有完成」收尾（2026-10-03 体检 3a）', () => {
  /** 第一次问授权先不答，交回答它的那一下；之后的照常答。 */
  const holdFirstAuthority = (): ((reply: unknown) => void) => {
    let release: (reply: unknown) => void = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    let first = true;
    const answer = H.worker;
    H.worker = (message) => {
      if (message.kind === 'dock/apply-materials-intent' && message.want === 'DISCOVERY_AUTHORITY' && first) {
        first = false;
        return held;
      }
      return answer(message);
    };
    return release;
  };
  const filledOne = (): Promise<unknown> => Promise.resolve({ ok: true, outcomes: [{ ok: true, key: 'firstName' }] });

  it('上一轮的授权迟到被拒：不把新一轮改成失败卡', async () => {
    const mounted = await boot();
    const release = holdFirstAuthority();
    H.fill = filledOne;
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(H.fills, '新的一轮照常填完').toHaveLength(1);
    expect(mounted.handle.finishRun).toHaveBeenCalledTimes(1);
    release({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    await flush();
    expect(mounted.handle.reportBlocked).not.toHaveBeenCalled();
  });

  it('上一轮的授权迟到但给了：不再接着扫、不开连填、不填，新一轮的连填与浮层原样', async () => {
    const mounted = await boot();
    const release = holdFirstAuthority();
    H.fill = filledOne;
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    const steps = mounted.handle.setStep.mock.calls.length;
    const ends = H.chain.end;
    release({ kind: 'DISCOVERY_AUTHORITY', authorization: { purpose: 'DISCOVERY' } });
    await flush();
    expect(H.chain.begin, '只开了新一轮的那一次').toHaveLength(1);
    expect(H.fills).toHaveLength(1);
    expect(mounted.handle.setStep.mock.calls.length, '旧的一轮不再报「正在读表单」').toBe(steps);
    expect(H.chain.end, '也不去结束新一轮的连填').toBe(ends);
    expect(mounted.handle.reportBlocked).not.toHaveBeenCalled();
  });

  it('准备的时候按了「停止」：之后迟到的拒绝不再弹出失败卡', async () => {
    const mounted = await boot();
    const release = holdFirstAuthority();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    mounted.handlers.onStop();
    release({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    await flush();
    expect(mounted.handle.reportBlocked).not.toHaveBeenCalled();
    expect(H.fills).toHaveLength(0);
  });

  it('填写半路抛了：照「这一轮没有完成」收尾（不让进度卡一直转），并交给 worker 一个稳定码', async () => {
    const mounted = await boot();
    H.fill = () => Promise.reject(new TypeError('kernel blew up'));
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(mounted.handle.reportBlocked).toHaveBeenCalledWith('RUN_FAILED');
    expect(H.sent).toContainEqual({ kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', errorClass: 'TypeError' });
    expect(H.chain.end, '连填到此为止').toBeGreaterThan(0);
  });

  it('被取代之后才抛的那一轮：只记码，不碰新一轮的浮层', async () => {
    const mounted = await boot();
    let fail: (error: Error) => void = () => {};
    H.fill = () => new Promise((_resolve, reject) => { fail = reject; });
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    H.fill = filledOne;
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    fail(new TypeError('late'));
    await flush();
    expect(mounted.handle.reportBlocked).not.toHaveBeenCalled();
    expect(H.sent).toContainEqual({ kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', errorClass: 'TypeError' });
  });

  it('这一页填完、收尾那一段（连填往不往下翻）抛了：记一个稳定码，不留没人接的拒绝', async () => {
    const mounted = await boot();
    // 真的一轮总会交回这一页的单子（连填据它判这一页还有没有要他处理的）。
    const view = { rows: [], filled: 1, requiredTotal: 0, requiredHandled: 0, needsAttention: 0, blockedByUs: 0, awaitingUser: 0 };
    H.fill = (input) => {
      (input.onAudit as (audit: unknown) => void)({
        view, questions: [], prefills: new Map(), prefillBasis: new Map(), canUndo: () => false, recheck: () => view,
      });
      return filledOne();
    };
    H.chain.kind = 'CHAIN';
    H.chain.afterPage = () => Promise.reject(new TypeError('chain blew up'));
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(mounted.handle.finishRun, '收尾照常').toHaveBeenCalled();
    expect(H.sent).toContainEqual({ kind: 'dock/diagnostic', code: 'GESTURE_RUN_CLOSE_THREW', errorClass: 'TypeError' });
  });
});

describe('每一轮怎么收场交给 worker（2026-10-04 体检 11-1）', () => {
  const runOutcomes = () => H.sent.filter((message) => message.kind === 'dock/run-outcome') as unknown as Array<{
    final: boolean;
    event: Record<string, unknown>;
  }>;

  it('一轮跑完：一条闭集消息（厂商、怎么认出来的、结局、桶），worker 认得；网址与资料一样都不带', async () => {
    const mounted = await boot();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    const sent = runOutcomes();
    expect(sent).toHaveLength(1);
    expect(parseDockRunOutcome(sent[0])).not.toBeNull();
    expect(sent[0]).toMatchObject({ final: false, event: { vendor: 'greenhouse', lane: 'host', outcome: 'NOTHING_FILLED', chainPages: 0 } });
    expect(JSON.stringify(sent)).not.toMatch(/greenhouse\.io|acme|Taylor|jobs\/123/u);
  });

  it('半路抛了：FAILED / RUN_FAILED 一次交终稿，另有一个只带类名的诊断码', async () => {
    const mounted = await boot();
    H.fill = () => Promise.reject(new TypeError('kernel blew up on https://boards.greenhouse.io/acme'));
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    expect(runOutcomes()).toEqual([expect.objectContaining({ final: true, event: expect.objectContaining({ outcome: 'FAILED', reason: 'RUN_FAILED' }) })]);
    expect(H.sent).toContainEqual({ kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', errorClass: 'TypeError' });
    expect(JSON.stringify(H.sent.filter((message) => message.kind === 'dock/diagnostic'))).not.toContain('greenhouse');
  });

  it('浮层里按了「提交」：这一轮的结局记下按了、结果如何；离开页面时交终稿', async () => {
    const mounted = await boot();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    // 测试里的点击不是真人点的：提交控制器答 UNTRUSTED（照「按不了」记）。
    await mounted.handlers.submission.send(click(), SHADOW, Promise.resolve());
    await flush();
    // 同一个 happy-dom 窗口上还挂着前几条测试里那几份内容脚本的 pagehide：只看这一轮的。
    const runId = runOutcomes()[0]?.event.runId;
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(runOutcomes().filter(({ event }) => event.runId === runId).map(({ final, event }) => [final, event.submitOutcome])).toEqual([
      [false, 'none'],
      [false, 'unconfirmed'],
      [false, 'unavailable'],
      [true, 'unavailable'],
    ]);
  });

  it('再按一次「自动填写」：上一轮交终稿，新的一轮另起一个 runId', async () => {
    const mounted = await boot();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    mounted.handlers.onAutofill(click(), SHADOW);
    await flush();
    const [first, finalized, second] = runOutcomes();
    expect(finalized).toMatchObject({ final: true, event: { runId: first?.event.runId } });
    expect(second?.event.runId).not.toBe(first?.event.runId);
  });
});
