import { configDefaults, defineConfig } from 'vitest/config';

/** Artifact tests require actual builds. `pnpm build` verifies the local artifact;
 * historical store/assistant gates remain source references and are not releases.
 * Normal unit tests exclude build products and those artifact-only suites.
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
    // 继承默认排除表再追加——显式写死会丢掉 vitest 自带的项
    // （本版是 node_modules 与 .git），且将来新增的默认项不会自动继承。
    exclude: [...configDefaults.exclude, '**/.output*/**', 'tests/artifact/**'],
  },
});
