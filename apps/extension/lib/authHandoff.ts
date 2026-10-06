/**
 * 门户 ↔ 扩展的登录交接消息面（刀八；契约 §2.3 的扩展侧编排）。
 *
 * 三条外部消息（chat/门户页经 externally_connectable 的 sendMessage 调用）：
 *  - { kind: 'auth/handoff-begin' }
 *      → { ok: true, extensionId, state }
 *    扩展生成 ≥128bit 一次性 state 并短时挂起；门户拿它调
 *    POST /auth/extension-handoffs（用户自己的 web 会话）换交接码。
 *  - { kind: 'auth/handoff-complete', code }
 *      → { ok: boolean }
 *    扩展拿 码+挂起的 state 走 redeem 兑换登录态（authClient）。
 *  - { kind: 'auth/connection-status', expectedOwnerId, correlationId }
 *      → fresh owner/install/protocol/capability ACK，任一不可证明即 {ok:false}。
 *
 * ## 门户实际说的 wire（2026-09-21 实测，连接门 #15 开门之后第一次真连）
 *
 * `/extension-auth/complete` 是 VibeID 时代的页面，发的是
 *  - { type: 'VIBE_AUTH_HANDOFF_CODE', code, state }   —— 等价于 auth/handoff-complete，多带一个 state
 *  - { type: 'VIBE_OPEN_OPTIONS' }                     —— 握手落地后请扩展打开设置页并关掉这个标签页
 * 这里原来只认 `kind: 'auth/*'`：sendMessage 没有任何监听器应答，门户判「无法联系到扩展」，
 * 连接从来没通过。两种叫法都认；带来的 state 必须等于我们挂起的那一个，否则不兑换。
 *
 * 安全性质：state 只在扩展自己的上下文里挂起（不回给页面之外的任何地方）、
 * 短 TTL、一次性（成功即清）；码本身也是短时效一次性（服务端保证）。
 * manifest 的 externally_connectable 已把发信 origin 收窄到门户，这里再
 * 做一层 sender origin 复核（defense-in-depth，纵深不靠单点）。
 *
 * ## 挂起要跨 SW 重启（2026-09-23）
 *
 * 从前 state 只在 SW 内存里。MV3 SW 空闲约 30 秒就被回收，而连接页上的人往往要先注册或
 * 登录——回来时门户唤起的是一个新 SW，内存里的挂起已经没了，握手必败
 * （HANDOFF_NO_PENDING_STATE）。装完第一次连接的新用户几乎全走这条路。所以挂起的同时写一份
 * 进 `pendingStore`（background 接的是 storage.session：跨 SW 重启存活、浏览器退出即清、
 * 内容脚本读不到），新实例兑换时从那里读回；TTL 与一次性不变。
 */

import {
  EXTENSION_CONNECTION_CAPABILITIES,
  EXTENSION_CONNECTION_PROTOCOL_VERSION,
  parseExtensionConnectionStatusRequest,
  parseExtensionConnectionStatusResponse,
  type ExtensionConnectionStatusResponse,
} from '@edaix/contracts';
import type { AuthClient } from './authClient';

export const AUTH_HANDOFF_DIAG_CODES = [
  'HANDOFF_SENDER_REJECTED', // 发信 origin 不在门户白名单
  'HANDOFF_NO_PENDING_STATE', // 没有挂起的 state（顺序错乱/已用/超时）
  'HANDOFF_STATE_MISMATCH', // 门户带来的 state 不是我们挂起的那一个（陈旧的标签页／别人的请求）
  'HANDOFF_MALFORMED',
  'HANDOFF_PENDING_STORE_FAILED', // 挂起写不进／读不出 pendingStore（同一个 SW 实例里仍可兑换）
] as const;

/** 挂起中的 state 与它的到期时刻（unix 秒）。 */
export interface PendingHandoff {
  readonly state: string;
  readonly expiresAt: number;
}

/** 挂起的持久那一份：background 接 storage.session，测试接内存。 */
export interface PendingHandoffStore {
  read(): Promise<unknown>;
  write(value: PendingHandoff | null): Promise<void>;
}

export interface AuthHandoffDeps {
  readonly authClient: AuthClient;
  readonly extensionId: string;
  /** 允许发起交接的门户 origin（生产 + 可选覆盖）。 */
  readonly allowedOrigins: readonly string[];
  readonly now?: () => number;
  readonly newState?: () => string;
  readonly onDiagnostic?: (code: string) => void;
  /** 不给 = 只在内存里挂起（SW 被回收就丢）。 */
  readonly pendingStore?: PendingHandoffStore;
}

export type AuthHandoffResponse =
  | { readonly ok: true; readonly extensionId: string; readonly state: string }
  | ExtensionConnectionStatusResponse
  | { readonly ok: boolean };

/** state 挂起窗口：覆盖"门户换码 + 用户看一眼确认"的耗时即可。 */
const PENDING_STATE_TTL_SECONDS = 600;

function defaultState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 与门户 `readExtensionAuthRequest` 的 STATE_RE 同一个形状。 */
const PENDING_STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/;

/** 从 pendingStore 读回来的值：形状不对就当没有（fail closed）。 */
export function parsePendingHandoff(value: unknown): PendingHandoff | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'state' && key !== 'expiresAt')) return null;
  const { state, expiresAt } = record;
  if (typeof state !== 'string' || !PENDING_STATE_RE.test(state)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { state, expiresAt };
}

/**
 * 返回外部消息处理器；无关消息返回 undefined（让给其他监听器）。
 * senderOrigin 传 sender.origin（或 sender.url 的 origin）。
 */
export type AuthMessageKind =
  | 'auth/handoff-begin'
  | 'auth/handoff-complete'
  | 'auth/connection-status'
  | 'auth/open-options';

/** 两种叫法折成一种：我们自己的 `kind: 'auth/*'`，与门户 /extension-auth/complete 的 `type: 'VIBE_*'`。 */
export function normalizeAuthMessageKind(record: Readonly<Record<string, unknown>>): AuthMessageKind | undefined {
  const kind = record['kind'];
  if (kind === 'auth/handoff-begin' || kind === 'auth/handoff-complete' || kind === 'auth/connection-status') return kind;
  if (kind !== undefined) return undefined;
  const type = record['type'];
  if (type === 'VIBE_AUTH_HANDOFF_CODE') return 'auth/handoff-complete';
  if (type === 'VIBE_OPEN_OPTIONS') return 'auth/open-options';
  return undefined;
}

export function createAuthHandoffHandler(deps: AuthHandoffDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const newState = deps.newState ?? defaultState;
  const diag = (code: string) => deps.onDiagnostic?.(code);

  let pending: PendingHandoff | null = null;
  // 这个 SW 实例里兑换过的 state。内存里的挂起已清、pendingStore 的清除还在路上时，第二条
  // 消息会从 store 读到旧值——在这里拒掉，一次性不靠那一下写入赶在前面。
  const spent = new Set<string>();

  const persist = async (value: PendingHandoff | null): Promise<void> => {
    if (deps.pendingStore === undefined) return;
    try {
      await deps.pendingStore.write(value);
    } catch {
      diag('HANDOFF_PENDING_STORE_FAILED');
    }
  };

  /** 内存里没有（SW 换过实例）就从 pendingStore 读回。 */
  const readPersisted = async (): Promise<PendingHandoff | null> => {
    if (deps.pendingStore === undefined) return null;
    try {
      return parsePendingHandoff(await deps.pendingStore.read());
    } catch {
      diag('HANDOFF_PENDING_STORE_FAILED');
      return null;
    }
  };

  /**
   * 开门前预铸 pending state（2026-09-20，P0-2）。
   *
   * 连接门打的是门户的 /extension-auth/complete，那页用 URL 里的 state 建 handoff、
   * 再把 code 发回来；插件兑换用的是自己 pending 的 state。两者必须是同一个，所以
   * 开门那一刻就得铸好。语义与收到 `auth/handoff-begin` 完全相同：替换旧挂起、
   * 同一个 TTL、同样一次性。写进 pendingStore 之后才返回——调用方拿到 state 再开门。
   */
  const beginPending = async (): Promise<string> => {
    const next = { state: newState(), expiresAt: now() + PENDING_STATE_TTL_SECONDS };
    pending = next;
    await persist(next);
    return next.state;
  };

  async function handleAuthMessage(
    message: unknown,
    senderOrigin: string | undefined,
  ): Promise<AuthHandoffResponse | undefined> {
    if (typeof message !== 'object' || message === null) return undefined;
    const record = message as Record<string, unknown>;
    const kind = normalizeAuthMessageKind(record);
    if (kind === undefined) return undefined;

    if (senderOrigin === undefined || !deps.allowedOrigins.includes(senderOrigin)) {
      diag('HANDOFF_SENDER_REJECTED');
      return { ok: false };
    }

    // dock 没有设置页。应答 ok 让门户把这一页画成「已完成」；关掉它的事在 background 做。
    if (kind === 'auth/open-options') return { ok: true };

    if (kind === 'auth/connection-status') {
      const request = parseExtensionConnectionStatusRequest(message);
      if (request === null) {
        diag('HANDOFF_MALFORMED');
        return { ok: false };
      }
      const attestation = await deps.authClient.attestInstallLinked(request.expectedOwnerId);
      if (attestation === null) return { ok: false };
      return parseExtensionConnectionStatusResponse({
        ok: true,
        protocolVersion: EXTENSION_CONNECTION_PROTOCOL_VERSION,
        extensionId: deps.extensionId,
        userId: attestation.userId,
        installId: attestation.installId,
        correlationId: request.correlationId,
        capabilities: EXTENSION_CONNECTION_CAPABILITIES,
      }, {
        extensionId: deps.extensionId,
        expectedOwnerId: request.expectedOwnerId,
        correlationId: request.correlationId,
      }) ?? { ok: false };
    }

    if (kind === 'auth/handoff-begin') {
      // 新的开始替换旧挂起（用户重试的正常路径）；state 只出现在返回值里。
      const state = await beginPending();
      return { ok: true, extensionId: deps.extensionId, state };
    }

    const code = record['code'];
    if (typeof code !== 'string' || code === '') {
      diag('HANDOFF_MALFORMED');
      return { ok: false };
    }
    const held = pending ?? (await readPersisted());
    if (held === null || now() >= held.expiresAt || spent.has(held.state)) {
      pending = null;
      if (held !== null) await persist(null);
      diag('HANDOFF_NO_PENDING_STATE');
      return { ok: false };
    }
    // 门户带来的 state（VibeID wire）必须就是我们挂起的那一个；对不上不兑换，也不作废挂起的
    // ——正确的那一页还能完成，陈旧的标签页换不来任何东西。
    const claimed = record['state'];
    if (typeof claimed === 'string' && claimed !== held.state) {
      diag('HANDOFF_STATE_MISMATCH');
      return { ok: false };
    }
    const state = held.state;
    // 一次性：无论成败，这个 state 不再可用。先在内存里记下，再清持久那一份。
    spent.add(state);
    pending = null;
    await persist(null);
    const redeemed = await deps.authClient.redeemHandoff({
      code,
      state,
      extensionId: deps.extensionId,
    });
    return { ok: redeemed };
  }

  return Object.assign(handleAuthMessage, { beginPending });
}
