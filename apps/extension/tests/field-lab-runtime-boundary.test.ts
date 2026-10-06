import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const ROOT_BARREL = 'packages/contracts/src/index.ts';
const WIZARD = 'packages/apply-kernel/src/rules/wizardIdentity.ts';
const PACKAGE = 'packages/contracts/package.json';
// Reviewed resolved edges, not source bytes. Changes require dependency-boundary review.
const APPROVED_EDGES = JSON.parse(readFileSync(resolve(__dirname, 'field-lab-runtime-edges.json'), 'utf8'));
const CONTRACT_EXPORTS = {
  './draft': './src/draft/index.ts',
  './draft/pilot-local-wizard': './src/draft/pilotLocalWizard.ts',
  './draft/pilot-ua4-write-authority': './src/draft/pilotUa4WriteAuthority.ts',
  './draft/pilot-ua5-certification': './src/draft/pilotUa5Certification.ts',
  './draft/pilot-ua5-profile-currentness': './src/draft/pilotUa5ProfileCurrentness.ts',
  './draft/pilot-ua5-profile-payloads': './src/draft/pilotUa5ProfilePayloads.ts',
  './draft/pilot-wizard-context': './src/draft/pilotWizardContext.ts',
  './execution-wizard': './src/executionWizard.ts',
};
const read = (file: string): string => readFileSync(resolve(REPO_ROOT, file), 'utf8');

/** Bundle without executing modules or pruning unused runtime branches. */
async function runtimeGraph(overrides: ReadonlyMap<string, string> = new Map()) {
  const sources = new Map<string, string>();
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: ['apps/extension/entrypoints/sidepanel/main.ts'],
    bundle: true,
    write: false,
    outdir: resolve(REPO_ROOT, 'node_modules/.cache/field-lab-boundary-unused-output'),
    metafile: true,
    treeShaking: false,
    format: 'esm',
    platform: 'browser',
    external: ['wxt/browser'],
    logLevel: 'silent',
    plugins: [{
      name: 'field-lab-source-observer',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
          const file = relative(REPO_ROOT, path).replaceAll('\\', '/');
          const contents = overrides.get(file) ?? read(file);
          sources.set(file, contents);
          return { contents, loader: 'ts' };
        });
      },
    }],
  });
  expect(result.warnings, 'FIELD_LAB_UNRESOLVED_RUNTIME').toEqual([]);
  const edges: Array<[string, string[]]> = Object.entries(result.metafile.inputs).map(([file, input]) => [
    file.replaceAll('\\', '/'),
    input.imports.map((edge) => `${edge.kind}:${edge.external ? 'external:' : ''}${edge.path.replaceAll('\\', '/')}`).sort(),
  ] as [string, string[]]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { edges, sources };
}

function assertStaticRuntime(sources: ReadonlyMap<string, string>): void {
  for (const [file, contents] of sources) {
    const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    const forbidden: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text))
      )) forbidden.push('DYNAMIC_CODE');
      if (ts.isImportEqualsDeclaration(node)) forbidden.push('COMMONJS_IMPORT');
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(forbidden, `FIELD_LAB_DYNAMIC_RUNTIME:${file}`).toEqual([]);
  }
}

function assertContractPackage(contents: string): void {
  const pkg = JSON.parse(contents);
  expect({ type: pkg.type, sideEffects: pkg.sideEffects, browser: pkg.browser, imports: pkg.imports }).toEqual({
    type: 'module', sideEffects: false, browser: undefined, imports: undefined,
  });
  for (const [entry, target] of Object.entries(CONTRACT_EXPORTS)) {
    expect(pkg.exports[entry], `FIELD_LAB_CONTRACT_EXPORT:${entry}`).toBe(target);
  }
}

describe('Field Lab resolved runtime boundary', () => {
  it('resolves the wizard through a dedicated contract entry without the root barrel', async () => {
    assertContractPackage(read(PACKAGE));
    const { edges, sources } = await runtimeGraph();
    expect(sources.has(ROOT_BARREL), 'FIELD_LAB_ROOT_BARREL_REACHABLE').toBe(false);
    assertStaticRuntime(sources);
    expect(edges, 'FIELD_LAB_RUNTIME_EDGE_DRIFT').toEqual(APPROVED_EDGES);
  });

  it('ignores unrelated root exports and comments, without loading their modules', async () => {
    const { edges, sources } = await runtimeGraph(new Map([
      [ROOT_BARREL, "export * from './unrelated-module-does-not-exist.ts';\n"],
      [WIZARD, `${read(WIZARD)}\n// A comment does not change the execution dependency ceiling.\n`],
    ]));
    expect(sources.has(ROOT_BARREL)).toBe(false);
    assertStaticRuntime(sources);
    expect(edges).toEqual(APPROVED_EDGES);
  });

  it('rejects reintroducing the contracts root from a transitive kernel dependency', async () => {
    const { edges, sources } = await runtimeGraph(new Map([
      [WIZARD, read(WIZARD).replace('@edaix/contracts/execution-wizard', '@edaix/contracts')],
    ]));
    expect(sources.has(ROOT_BARREL)).toBe(true);
    expect(() => expect(edges).toEqual(APPROVED_EDGES)).toThrow();
  });

  it('rejects an extra runtime dependency even when its export is unused', async () => {
    const { edges } = await runtimeGraph(new Map([
      [WIZARD, `${read(WIZARD)}\nexport * from '../../../contracts/src/deployment.ts';\n`],
    ]));
    expect(() => expect(edges).toEqual(APPROVED_EDGES)).toThrow();
  });

  it('rejects unresolved Node I/O in a browser runtime dependency', async () => {
    await expect(runtimeGraph(new Map([
      [WIZARD, `${read(WIZARD)}\nimport 'node:fs';\n`],
    ]))).rejects.toThrow('Could not resolve');
  });

  it.each([
    'export const probe = (target: string) => import(target);',
    'export const probe = (target: string) => require(target);',
    'export const probe = () => new Function("return 1");',
    'export const probe = () => eval("1");',
  ])('rejects dynamic runtime code: %s', (probe) => {
    expect(() => assertStaticRuntime(new Map([[WIZARD, `${read(WIZARD)}\n${probe}`]]))).toThrow();
  });

  it('ignores package version/scripts/unrelated exports while guarding consumed resolution', () => {
    const pkg = JSON.parse(read(PACKAGE));
    pkg.version = '0.0.1';
    pkg.scripts = { test: 'unrelated-task-test' };
    pkg.exports['./unrelated'] = './src/unrelated.ts';
    assertContractPackage(JSON.stringify(pkg));
    for (const entry of Object.keys(CONTRACT_EXPORTS)) {
      const changed = { ...pkg, exports: { ...pkg.exports, [entry]: './src/index.ts' } };
      expect(() => assertContractPackage(JSON.stringify(changed))).toThrow();
    }
    for (const override of [
      { type: 'commonjs' }, { sideEffects: true },
      { browser: { './src/executionWizard.ts': './src/index.ts' } },
      { imports: { '#wizard': './src/index.ts' } },
    ]) expect(() => assertContractPackage(JSON.stringify({ ...pkg, ...override }))).toThrow();
  });
});
