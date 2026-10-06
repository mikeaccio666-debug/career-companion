import { defineConfig } from 'vitest/config';

/**
 * 与源仓库 vitest.config.ts 的对齐说明（搬运自 vibeid-ext-autofill@feat/autofill）：
 * 源配置里的 svelte 插件、browser/development resolve 条件与 server.deps.inline
 * 只为渲染级（.svelte 组件）测试而存在；本包一条组件测试都没搬，故全部不带。
 * environment / include / restoreMocks 三项保持原值，测试行为不变。
 */
export default defineConfig({
  test: {
    // Synthetic DOM fixtures must never fetch real ATS frames, scripts or CSS.
    // The iframe elements remain available for structural/identity simulation.
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: {
            disableChildFrameNavigation: true,
            disableChildPageNavigation: true,
            disableMainFrameNavigation: true,
          },
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          enableJavaScriptEvaluation: false,
          enableImageFileLoading: false,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
