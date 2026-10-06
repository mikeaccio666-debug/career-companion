#!/usr/bin/env node
// The historical Argoland build governor is preserved under imports/. This
// workspace guards its local execution defaults and verifies its own CI.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_REQUIRED = [
  'VIBE_DIST=local',
  'VIBE_API_BASE=http://localhost:3000',
  'VIBE_WEB_BASE=http://localhost:3100',
  'VIBE_LIVE_HOST_WRITES=0',
  'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED=0',
  'VIBE_TRUST_TELEMETRY_ENABLED=0',
];

export function assertExtensionPackageScripts(source) {
  const { scripts } = JSON.parse(source);
  for (const name of ['dev', 'build:default', 'build:local']) {
    const command = scripts?.[name];
    if (typeof command !== 'string') throw new Error(`missing local command: ${name}`);
    const tokens = command.trim().split(/\s+/u);
    for (const expected of LOCAL_REQUIRED) {
      const key = expected.split('=')[0];
      const values = tokens.filter(token => token.startsWith(`${key}=`));
      if (values.length !== 1 || values[0] !== expected) {
        throw new Error(`${name} must contain exactly ${expected}`);
      }
    }
    if (/argoland\.ai|edaix\.io|\|\||[;]|&&/u.test(command)) {
      throw new Error(`${name} contains a legacy host or alternate execution command`);
    }
  }
  for (const name of Object.keys(scripts)) {
    if (/staging|store/u.test(name)) throw new Error(`legacy release task must be archived: ${name}`);
  }
  if (scripts.build !== 'pnpm check:default-artifact') {
    throw new Error('build must verify its actual local artifact');
  }
}

export function assertExtensionWorkflowWiring(source) {
  const code = source.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  for (const command of ['pnpm check', 'pnpm test', 'pnpm build:extension', 'pnpm build:extension-ui']) {
    if (!code.split('\n').some(line => line.trim().replace(/^-\s*/u, '') === `run: ${command}`)) {
      throw new Error(`CI missing exact required command: ${command}`);
    }
  }
  if (/continue-on-error:\s*true|secrets\.|run:.*(?:deploy|publish|gh\s)/u.test(code)) {
    throw new Error('verification CI must not skip failures or publish artifacts externally');
  }
}

export function assertExtensionFieldLabWiring(workflow, pkg) {
  assertExtensionPackageScripts(pkg);
  assertExtensionWorkflowWiring(workflow);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assertExtensionFieldLabWiring(
    readFileSync(resolve(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'),
    readFileSync(resolve(REPOSITORY_ROOT, 'apps/extension/package.json'), 'utf8'),
  );
  console.log('Local execution defaults and verification CI checked.');
}
