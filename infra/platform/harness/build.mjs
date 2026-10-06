import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Only these two reviewed source files enter the Docker context. No .env, imports or user material.
const here = dirname(fileURLToPath(import.meta.url));
const context = await mkdtemp(join(tmpdir(), 'companion-harness-build-'));
try {
  await copyFile(join(here, 'Dockerfile'), join(context, 'Dockerfile'));
  await copyFile(resolve(here, '../../../packages/ai-core/src/relay-wrapper.mjs'), join(context, 'relay-wrapper.mjs'));
  const code = await new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '--pull=false', '-t', 'companion-codex-relay:local', context], { shell: false, stdio: 'inherit' });
    child.on('error', reject); child.on('close', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally { await rm(context, { recursive: true, force: true }); }
