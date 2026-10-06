/**
 * `import.meta.env` 的最小声明。源仓库由 vite/wxt 客户端类型提供；本包只声明
 * 源码实际读取的一个键（policy.ts）。
 *
 * 行为契约保持不变：测试环境（vitest 注入的 import.meta.env）里该键不存在，
 * 读到 undefined —— policy.ts 走 `?? ''` → Date.parse 失败 → 包内兜底时间戳。
 */
/*
 * 注：`__VIBE_APPLY_POLICY_BUILT_AT__` 的声明**不在这里**，在 policy.ts 里用
 * `declare global` 写。原因见那边的注释——放在 .d.ts 里，下游包从源码编译
 * kernel 时看不到它（CI 实测 TS2304，2026-08-18）。
 */

interface ImportMetaEnv {
  readonly VITE_VIBE_APPLY_POLICY_BUILT_AT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
