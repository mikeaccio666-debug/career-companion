import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT, assertExtensionFieldLabWiring, assertExtensionPackageScripts, assertExtensionWorkflowWiring } from './check-extension-field-lab-wiring.mjs';

const pkg = readFileSync(resolve(REPOSITORY_ROOT, 'apps/extension/package.json'), 'utf8');
const workflow = readFileSync(resolve(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8');

test('actual workspace builds remain local and CI verifies real artifacts', () => {
  assert.doesNotThrow(() => assertExtensionFieldLabWiring(workflow, pkg));
});

test('rejects accidental production host or enabled live writes in each default command', () => {
  for (const name of ['dev', 'build:default', 'build:local']) {
    for (const [before, after] of [
      ['VIBE_API_BASE=http://localhost:3000', 'VIBE_API_BASE=https://api.argoland.ai'],
      ['VIBE_LIVE_HOST_WRITES=0', 'VIBE_LIVE_HOST_WRITES=1'],
      ['VIBE_TRUST_TELEMETRY_ENABLED=0', 'VIBE_TRUST_TELEMETRY_ENABLED=1'],
      ['VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED=0', 'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED=1'],
    ]) {
      const changed = JSON.parse(pkg);
      changed.scripts[name] = changed.scripts[name].replace(before, after);
      assert.throws(() => assertExtensionPackageScripts(JSON.stringify(changed)));
    }
  }
});

test('rejects duplicate environment assignment that could override local safeguards', () => {
  const changed = JSON.parse(pkg);
  changed.scripts.dev = changed.scripts.dev.replace(' -- ', ' VIBE_LIVE_HOST_WRITES=1 -- ');
  assert.throws(() => assertExtensionPackageScripts(JSON.stringify(changed)));
});

test('rejects bypassing artifact verification and restored legacy release scripts', () => {
  const changed = JSON.parse(pkg);
  changed.scripts.build = 'wxt build';
  assert.throws(() => assertExtensionPackageScripts(JSON.stringify(changed)));
  const legacy = JSON.parse(pkg);
  legacy.scripts['build:career-staging'] = 'wxt build';
  assert.throws(() => assertExtensionPackageScripts(JSON.stringify(legacy)));
});

test('requires CI checks and refuses publishing or ignored failures', () => {
  assert.throws(() => assertExtensionWorkflowWiring(workflow.replace('run: pnpm build:extension\n', 'run: true\n')));
  assert.throws(() => assertExtensionWorkflowWiring(`${workflow}\n      - run: pnpm deploy\n`));
  assert.throws(() => assertExtensionWorkflowWiring(`${workflow}\n        continue-on-error: true\n`));
});
