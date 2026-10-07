import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const ROOT_BARREL = 'packages/contracts/src/index.ts';
const WIZARD = 'packages/apply-kernel/src/rules/wizardIdentity.ts';
const PACKAGE = 'packages/contracts/package.json';
const HOST_RESTRICTIONS = 'packages/apply-kernel/src/gate/hostRestrictions.ts';
const HOST_VETO = 'packages/apply-kernel/src/gate/hostVeto.ts';
const BROWSER_POLICY = 'packages/apply-kernel/src/policy.ts';
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

/** These two rules consume input data; browser/storage/env capabilities belong elsewhere. */
function assertPureHostRules({ edges, sources }: Awaited<ReturnType<typeof runtimeGraph>>): void {
  expect(sources.has(BROWSER_POLICY), 'FIELD_LAB_BROWSER_POLICY_REACHABLE').toBe(false);
  for (const [file, approvedImports] of [
    [HOST_RESTRICTIONS, []],
    [HOST_VETO, [`import-statement:${HOST_RESTRICTIONS}`]],
  ] as const) {
    expect(edges.find(([entry]) => entry === file), `FIELD_LAB_HOST_RULE_IMPORTS:${file}`)
      .toEqual([file, approvedImports]);
    expect(sources.has(file), `FIELD_LAB_HOST_RULE_MISSING:${file}`).toBe(true);
    const ast = ts.createSourceFile(file, sources.get(file)!, ts.ScriptTarget.Latest, true);
    const forbidden: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && [
        'browser', 'chrome', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
        'window', 'document', 'location', 'navigator', 'self', 'globalThis', 'global',
        'process', 'fetch', 'XMLHttpRequest', 'WebSocket',
      ].includes(node.text)) forbidden.push(node.text);
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
        forbidden.push('import.meta');
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(forbidden, `FIELD_LAB_HOST_RULE_CAPABILITY:${file}`).toEqual([]);
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
    assertPureHostRules({ edges, sources });
    expect(edges, 'FIELD_LAB_RUNTIME_EDGE_DRIFT').toEqual(APPROVED_EDGES);
  });

  it('ignores unrelated root exports and comments, without loading their modules', async () => {
    const { edges, sources } = await runtimeGraph(new Map([
      [ROOT_BARREL, "export * from './unrelated-module-does-not-exist.ts';\n"],
      [WIZARD, `${read(WIZARD)}\n// A comment does not change the execution dependency ceiling.\n`],
    ]));
    expect(sources.has(ROOT_BARREL)).toBe(false);
    assertStaticRuntime(sources);
    assertPureHostRules({ edges, sources });
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

  it('rejects browser policy entering through the pure host rules', async () => {
    const graph = await runtimeGraph(new Map([
      [HOST_VETO, `${read(HOST_VETO)}\nexport * from '../policy';\n`],
    ]));
    expect(graph.sources.has(BROWSER_POLICY)).toBe(true);
    expect(() => assertPureHostRules(graph)).toThrow('FIELD_LAB_BROWSER_POLICY_REACHABLE');
    expect(() => expect(graph.edges).toEqual(APPROVED_EDGES)).toThrow();
  });

  it.each([
    'export const probe = () => browser.storage.local.get("probe");',
    'export const probe = () => localStorage.getItem("probe");',
    'export const probe = () => import.meta.env.PROBE;',
  ])('rejects ambient capability in either pure host rule: %s', async (probe) => {
    for (const file of [HOST_RESTRICTIONS, HOST_VETO]) {
      const graph = await runtimeGraph(new Map([[file, `${read(file)}\n${probe}\n`]]));
      // Ambient access creates no import edge, so the source guard must catch it.
      expect(graph.edges).toEqual(APPROVED_EDGES);
      expect(() => assertPureHostRules(graph)).toThrow(`FIELD_LAB_HOST_RULE_CAPABILITY:${file}`);
    }
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
