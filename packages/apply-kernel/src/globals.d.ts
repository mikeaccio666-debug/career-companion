/**
 * WebExtension `browser` 全局的**最小结构化声明**。
 *
 * 源仓库里这个全局由 wxt（webextension-polyfill 类型）提供；本包脱离扩展
 * 工程后，只声明源码实际用到的成员，逐个对照真实调用点写出：
 *   storage.local（get/set/remove/getBytesInUse）→ policy.ts / profileDraft.ts
 *   runtime.getManifest → policy.ts
 * 任何新用法都会被 tsc 拦下，届时再补。
 *
 * 2026-08-15 债务清偿：旧 support/ API 面删除后，runtime 端口/消息成员与
 * storage.session 整段移除，原"onMessage any"债务随其唯一成因消失。
 * `storage.local.get` 返回值取 `Record<string, unknown>`（比上游 polyfill
 * 的 any 更严），调用点全部以窄化/断言消费。
 */

interface VibeMinimalStorageArea {
  get(keys: string | readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  getBytesInUse(keys: string | readonly string[]): Promise<number>;
}

declare const browser: {
  readonly storage: {
    readonly local: VibeMinimalStorageArea;
  };
  readonly runtime: {
    getManifest(): { version: string };
  };
};
