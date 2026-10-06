import { createDirectoryRequest } from './directoryRequest';
import type { ProfileDirectoryOperation, ProfileDirectoryTransportResult } from './profileDirectoryTransport';

/**
 * 面板问资料的那一道门（2026-09-27 从内容脚本里提出来）。
 *
 * 后台只回答「报到过、而且还停在那一页」的标签页。报到表那一条丢了——别的标签页的写入冲掉、站内换路径没赶上
 * 报到——后台答 PAGE_NOT_REGISTERED。正确的动作是这一页重新报到一次、再问一次；从前这个码一路走到资料编辑器，
 * 画成「暂时读不到你的资料，稍后再试」，而稍后再试也没用：不重新报到，这一页永远是没登记。
 * 只重问一次；别的失败原样交回，它们各有各的话。
 */
export function createDirectoryRun(deps: {
  /** 把请求交给 worker（`browser.runtime.sendMessage`）。 */
  readonly send: (message: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** 这一页重新报到（不受节流，等后台答完）。 */
  readonly rehello: () => Promise<void>;
  /**
   * 内容脚本此刻认为登录的是谁（会话代号；还不知道是 undefined，2026-10-04）。存（写）的时候带上，worker 此刻登录的不是这个人
   * 就不写（SESSION_CHANGED）。读不带。
   */
  readonly session?: () => string | null | undefined;
}): (operation: ProfileDirectoryOperation, body?: unknown) => Promise<ProfileDirectoryTransportResult> {
  const ask = async (request: Readonly<Record<string, unknown>>): Promise<ProfileDirectoryTransportResult> => {
    try {
      const reply = await deps.send(request);
      // 没有回答也是一种回答，它只是不该伪装成结果。从前这里直接 `as` 成结果类型，于是 `undefined` 一路走到
      // `openedV2`，在那儿读 `.ok` 抛 TypeError，被上层一个 catch 兜成「稍后刷新」。
      if (reply === null || typeof reply !== 'object' || !('ok' in reply)) return { ok: false, code: 'NO_REPLY' };
      return reply as ProfileDirectoryTransportResult;
    } catch {
      return { ok: false, code: 'NO_REPLY' };
    }
  };
  return async (operation, body) => {
    const request = createDirectoryRequest(operation, body, operation.endsWith('_READ') ? undefined : deps.session?.());
    if (request === null) return { ok: false, code: 'UNAVAILABLE' };
    const first = await ask(request);
    if (first.ok || first.code !== 'PAGE_NOT_REGISTERED') return first;
    try {
      await deps.rehello();
    } catch {
      // 报到本身没答上来也照样再问一次：后台那一侧可能已经记下了。问不到就照实交回 PAGE_NOT_REGISTERED。
    }
    return ask(request);
  };
}
