#!/usr/bin/env node
/**
 * 跨平台的环境变量前缀。
 *
 * ## 为什么需要它
 *
 * `"check:store": "VIBE_DIST=store wxt build && ..."` 这种 POSIX 内联赋值
 * 在 Windows 的 cmd 下**跑不起来**——报
 * `'VIBE_DIST' is not recognized as an internal or external command`，退出码 1。
 *
 * Vivian 在 Windows 上实跑本仓 `pnpm --filter @edaix/extension check:store`
 * 复现了（2026-08-18 审查 PR #14 Blocking）。**Linux CI 全绿覆盖不到
 * 团队的开发环境**——这是本仓「绿灯 ≠ 能跑」的又一个形态。
 *
 * 不引 `cross-env`：本仓 `scripts/` 一律是无依赖的 `.mjs`，
 * 为一行环境变量加一个 npm 依赖不划算，且多一个供应链面。
 *
 * ## 用法
 *
 *   node scripts/with-env.mjs KEY=VALUE [KEY2=VALUE2 ...] -- <命令> [参数...]
 *
 * `--` 之前是赋值，之后是要跑的命令。命令通过 shell 执行，
 * 所以 `&&` 串联仍然可用。
 */

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');

if (split === -1 || split === argv.length - 1) {
  console.error('用法: node scripts/with-env.mjs KEY=VALUE [...] -- <命令> [参数...]');
  process.exit(2);
}

const env = { ...process.env };
for (const pair of argv.slice(0, split)) {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    console.error(`不是合法的赋值: ${pair}`);
    process.exit(2);
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const command = argv.slice(split + 1).join(' ');

// shell:true 让 `&&` 串联在两个平台上都按各自 shell 的语义工作。
const child = spawn(command, { env, stdio: 'inherit', shell: true });

// 只认退出码（铁律 7）：子进程什么码，我们就什么码；被信号杀掉记 1。
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (error) => {
  console.error(`启动失败: ${error.message}`);
  process.exit(1);
});
