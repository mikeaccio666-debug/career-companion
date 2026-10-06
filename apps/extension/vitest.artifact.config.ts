import { defineConfig } from 'vitest/config';

/** 只跑产物级门禁（`pnpm check:store` 用）；默认 `pnpm test` 用 vitest.config.ts。 */
export default defineConfig({
  test: { // 覆盖 vitest 的全部正常后缀——审查实测：只收 *.test.ts 时，
    // tests/artifact/ 下的 *.spec.ts 会被两套 config 同时忽略、永远不跑。
    include: ['tests/artifact/**/*.{test,spec}.?(c|m)[jt]s?(x)'], },
});
