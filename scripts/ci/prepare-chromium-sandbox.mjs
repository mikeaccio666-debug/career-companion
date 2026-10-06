import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Ubuntu's downloaded Chromium builds need a per-binary userns profile.
// This helper is restricted to ephemeral GitHub-hosted Linux test runners.
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
export function chromiumProfile(executable) {
  if (!/^\/home\/runner\/\.cache\/ms-playwright\/chromium-\d+\/chrome-linux(?:64)?\/chrome$/.test(executable)) {
    throw new Error('Expected the exact installed Playwright Chromium executable.');
  }
  return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile career-companion-ci-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`;
}

export function sandboxUnavailable(error) {
  const message = error instanceof Error ? error.message : '';
  return /No usable sandbox|Failed to move to new namespace|userns.*(?:denied|restricted)/i.test(message);
}

async function verifySandbox(chromium, executablePath) {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath, timeout: 10_000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  await browser.close();
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Linux') {
    throw new Error('Chromium sandbox setup requires an ephemeral GitHub-hosted Linux runner.');
  }
  const require = createRequire(new URL('../../packages/ai-core/package.json', import.meta.url));
  const { chromium } = require('playwright');
  const executable = await realpath(chromium.executablePath());
  try {
    await verifySandbox(chromium, executable);
    console.log('Chromium sandbox preflight passed; no policy change needed.');
    return;
  } catch (error) {
    if (!sandboxUnavailable(error)) throw new Error('Chromium sandbox preflight failed with an unclassified startup error. No policy changed.');
  }
  const restriction = (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim();
  if (restriction !== '1') throw new Error('Chromium sandbox unavailable without the expected Ubuntu userns restriction. No policy changed.');
  const profile = chromiumProfile(executable);
  const directory = resolve('.local/ci-chromium-sandbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'career-companion-ci-chromium');
  await writeFile(file, profile, { mode: 0o600 });
  try { execFileSync('sudo', ['apparmor_parser', '-r', file], { timeout: 10_000, stdio: 'pipe' }); }
  catch { throw new Error('The exact Chromium userns profile could not be loaded.'); }
  try { await verifySandbox(chromium, executable); }
  catch { throw new Error('Chromium sandbox still unavailable after its exact userns profile was loaded.'); }
  console.log('Chromium sandbox preflight passed with an exact-binary userns profile; Chromium sandbox and global restrictions remain enabled.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Chromium sandbox setup failed.'); process.exitCode = 1; });
}
