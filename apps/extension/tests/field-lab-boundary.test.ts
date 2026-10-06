import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

const AUTHORED_IMPORTS = new Map<string, readonly string[]>([
  ['entrypoints/sidepanel/main.ts', [
    '../../connected-dev/panelRuntimeClient#value:createPilotUa5PanelRuntimeClient',
    '../../field-lab/adapters/executionAdapter#value:probeExecutionPort',
    '../../field-lab/shell#type:FieldLabStageSnapshot',
    '../../product-panel/panel#type:ProductPanelIntentResult,value:PRODUCT_PANEL_PROTOTYPE_MARKER,value:mountProductPanel',
    '../../product-panel/prototypeAdapter#value:createProductPanelPrototypeAdapter',
    '../../product-panel/style.css#side-effect',
    '../../product-panel/ua5Adapter#value:createProductPanelUa5Adapter',
    'wxt/browser#value:browser',
  ]],
  ['field-lab/shell.ts', []],
  ['field-lab/adapters/executionAdapter.ts', [
    '../../lib/pilotUa4WriterRuntime#type:PilotUa4HostExecutor,type:PilotUa4WriterRuntimeInput,value:createPilotUa4WriterRuntime',
  ]],
  // The dock moved to lib/dock/ on 2026-09-23 (the design handoff rebuild); its glyphs,
  // theme, apply scenes and profile scene left product-panel/ with it. Its old copy table,
  // dockCopy.ts (import-free since 2026-09-16), was deleted on 2026-09-26: the English UI
  // (#120) had moved the last two strings still in use into lib/dock/copy.ts, likewise
  // import-free.
  ['product-panel/launcherPosition.ts', []],
  // 联调包那一行的措辞跟着浮层的界面语言走（2026-09-25）：文案取自浮层自己的 copy（同样不带任何 import）。
  ['product-panel/runProgress.ts', [
    '../lib/autofillDock#type:AutofillDockProgress',
    '../lib/dock/copy#type:DockCopy,value:COPY',
    '../lib/pilotUa5Orchestrator#type:PilotUa5ProgressEvent',
  ]],
  ['product-panel/affordance.ts', [
    '../lib/siteSupport#type:SiteGuidance,type:SiteSupportVerdict',
  ]],
  ['product-panel/runPhase.ts', [
    './model#type:ProductPanelQuestionStatus,type:ProductPanelViewModel',
  ]],
  ['product-panel/model.ts', [
    '../lib/pilotUa5Orchestrator#type:PilotUa5ProgressEvent',
    '@edaix/contracts/draft/pilot-local-wizard#type:PilotLocalWizardProjection,value:parsePilotLocalWizardProjection',
    '@edaix/contracts/draft/pilot-ua4-write-authority#type:PilotUa4TerminalState,type:PilotUa4WriteEffect,value:PILOT_UA4_TERMINAL_STATES',
    '@edaix/contracts/draft/pilot-ua5-certification#type:PilotUa5ReadOnlyScan,value:PILOT_UA5_COMPLETED_STATES,value:parsePilotUa5ReadOnlyScan',
  ]],
  ['product-panel/panel.ts', [
    '../lib/pilotUa5ConnectedProtocol#type:PilotUa5ReadinessStatus',
    './model#type:ProductPanelEntryState,type:ProductPanelQuestion,type:ProductPanelQuestionStatus,type:ProductPanelSummary,type:ProductPanelViewModel,value:PRODUCT_PANEL_VIEW_MODEL_INVALID,value:summarizeProductPanel,value:validateProductPanelViewModel',
    './state#type:ProductPanelContinueIntent,type:ProductPanelIntentResult>ProductPanelIntentResultFromState,type:ProductPanelState,value:createContinueIntentGate,value:normalizeProductPanelIntentResult,value:reduceProductPanelState',
  ]],
  ['product-panel/prototypeAdapter.ts', [
    '../lib/pilotUa5Orchestrator#type:PilotUa5ProgressEvent,type:PilotUa5RunResult',
    './panel#type:ProductPanelEntryIntent,type:ProductPanelIntentResult,type:ProductPanelViewAdapter',
    './state#value:normalizeProductPanelIntentResult',
    './ua5Adapter#value:createProductPanelUa5Adapter',
  ]],
  ['product-panel/state.ts', []],
  ['product-panel/ua5Adapter.ts', [
    '../lib/pilotUa5ConnectedProtocol#type:PilotUa5ContinueOffer,type:PilotUa5ReadOnlyScanResult,type:PilotUa5ReadinessStatus,value:PILOT_UA5_READINESS_STATUSES,value:ownDataValues,value:parsePilotUa5ContinueOffer,value:parsePilotUa5ReadOnlyScanResult,value:parsePilotUa5RunResult,value:readPilotUa5ResultWizard',
    '../lib/pilotUa5Orchestrator#type:PilotUa5ProgressEvent,type:PilotUa5RunResult',
    './model#type:ProductPanelViewModel',
    './model#value:validateProductPanelViewModel',
    './panel#type:ProductPanelEntryIntent,type:ProductPanelIntentResult,type:ProductPanelStartIntent,type:ProductPanelViewAdapter',
    './state#type:ProductPanelContinueIntent,value:normalizeProductPanelIntentResult',
    '@edaix/contracts/draft/pilot-local-wizard#type:PilotLocalWizardProjection',
    '@edaix/contracts/draft/pilot-ua5-certification#type:PilotUa5RunProjection',
  ]],
]);

/** Any source drift here requires consciously re-reviewing the Field Lab dependency ceiling. */
const APPROVED_PRODUCTION_SOURCE_SHA256 = new Map<string, string>([
  // 2026-09-22 复核并重钉（第二次）：改动只有 VENDOR 对照表再加一行 GENERIC → generic
  // （argoland #584 的不绑厂商那条路，本仓镜像）。同上，只让解析器多认一个提供方，
  // 不改任何判定路径，也不给 Field Lab 任何新权限；而且那条路本身还是关着的
  // （随包适配器 null、内置 policy false、没有调用方打开开关）。
  ['packages/contracts/src/executionRuntimeAuthorization.ts', '3c23fe1dda9a667118cda33fff53be370bfba0b477f85a882f76b609f76ffd77'],
  ['packages/contracts/src/draft/pilotWizardContext.ts', 'd4fd8c3baecff03962be7ff9139b2f416df53c3431b8233240976c1dbf4c11ab'],
  ['packages/contracts/src/draft/pilotLocalWizard.ts', 'e34875ff7a53a108187e677aa03044d5f909b75a969bfae020589ef8387b0592'],
  ['apps/extension/lib/pilotUa4WriterRuntime.ts', '3f55d25b9f686d40e7b0e1b21d3c0c940804b20e3e97c7f15da76ae01a7b584f'],
  ['apps/extension/lib/pilotUa5ConnectedProtocol.ts', '4eabe140d087a9cb1c35f879d99e8cfbe3fb4ebcb7ae0a94225a3419544788d3'],
  ['apps/extension/lib/pilotUa5Orchestrator.ts', '7468f0565303be7504dd3db88ec05df8d3eca80a0669c28b36f2ff1652f88fa3'],
  // Incoming reviewed SEMANTIC_FILL_ONLY writer remains behind the same hard-disabled probe.
  ['packages/apply-kernel/src/pilotUa4Writer.ts', '3ba55e1d2e91585cf832a9eebf04eff6f33282778493e981fb770478c600c046'],
  ['packages/apply-kernel/src/semantic/graph.ts', '74893e3962400f3c85659fddd5fdb9fb8bd2a3b2394856027a64e4081cfab6c0'],
  ['packages/apply-kernel/src/semantic/classify.ts', 'cc0b886f2300beb5f690e677ccde68a01d819512fad4687d60340d8006f37880'],
  // Union of current main exports and the reviewed dormant fileFillOnly export; authored Field Lab imports stay unchanged.
  // 2026-09-15: adds only `./sites/workday`, the compiled Workday rule adapter the ATS lab
  // needs because `registry.ts` deliberately keeps `ADAPTERS.workday = null`. It is a new
  // export path, not a change to any path Field Lab imports, and it confers no write
  // authority: the adapter still parses nothing until a caller supplies a policy and a root.
  // 2026-09-15（第二次）：再加 `./bundledAdapters`。站点知识整个移出内容脚本产物后，
  // 随包内置的 11 个适配器从 `registry.ts` 切到了那个新模块；构建期推导注入范围、
  // 实验室与测试从它取，运行时识别改由后端 release 装配（`installApplyAdaptersFromRules`）。
  // 同样只是新增导出路径，没有改动 Field Lab import 的任何路径，也不授予写权限。
  // 2026-09-22：再加 `./wizardAdvance`（多页申请「继续到下一页」找宿主那颗翻页按钮的只读判据）。
  // 仍然只是新增导出路径：Field Lab 不 import 它，它本身不点任何东西、不授予写权限——
  // 真按由内容脚本在用户那一次真实点击里做，且要远程策略的 `advance-step` 位开着。
  // 2026-09-28：再加 `./signOnBehalf`（代填判据：哪一版同意覆盖哪几类，worker 与内容脚本只取类型与纯函数）与
  // `./profileV2EmployerContact`（从 Profile V2 读出确认过的「可以联系你现在的雇主吗」）。仍然只是新增导出路径：
  // Field Lab 不 import 它们，它们不点任何东西、不授予写权限——代填照旧要远程策略的 `sign-on-behalf` 位开着。
  // 2026-09-28（第二次）：再加 `./accountAccess`（账号墙上写邮箱与密码、勾注册条款、按规则声明的注册／登录，
  // 替用户注册、登录招聘网站）。仍然只是新增导出路径：Field Lab 不 import 它；它只认规则声明的账号墙，每一下都要
  // 专用票（`mintAccountAccessAuthority`，只有真实点击或那一下点击开出的一轮能铸）与远程策略的 `account-access` 位。
  // 2026-09-28（第三次）：再加 `./fieldContext`（看同一节才知道问什么的纯文本判据，与找一栏所在那一节标题的只读读法；
  // 内容脚本报「这张表里有没有只有求职才问的栏」时用）。仍然只是新增导出路径：Field Lab 不 import 它，它不点任何东西、
  // 不授予写权限。
  // 2026-10-04：再加 `./profileV2Travel`（从 Profile V2 读出确认过的「出差最多能接受多少」，argoland #738）。仍然只是新增
  // 导出路径：Field Lab 不 import 它，它只读快照里的一格、不点任何东西、不授予写权限。
  // 2026-10-04：再加 `./emailCode`（验证码第 1 步：把用户本人在浮层里输或粘贴的验证码写进规则声明的验证码格）。仍然只是
  // 新增导出路径：Field Lab 不 import 它；它只写规则 `emailVerification` 声明的那几格，只认用户那一下真实点击铸的票与远程
  // 策略的 `set-text` 位，写完不提交、不点任何东西。
  // 2026-10-04：多两个导出 `./consentGate`、`./dict/consentGate`（Jobvite 数据同意页，D7）。只是新入口，Field Lab 的运行时
  // 授权不变（它不 import 这两个）。
  ['packages/apply-kernel/package.json', '805293a69f78914ccb99764116a946d491c5ae44ca79862253ed0c17ddd0f9a4'],
  // Unreachable root exports are excluded by field-lab-runtime-boundary.test.ts.
  // Calendar adds optional sync metadata, then (C-4) optional reminder rules, revision and source
  // type — data-only additions; Field Lab imports and write authority are unchanged.
  ['packages/contracts/src/calendar.ts', 'dcc20fbedf71bd22201689813dd1fcd3288c24c28a2030a72fca3c05272c36e9'],
  // The draft root gained `export * from './pilotUa5ProfileCurrentness'` on main;
  // that file carries its own approved digest at the end of this map, so the
  // ceiling it widens was reviewed there rather than restated here.
  ['packages/contracts/src/draft/index.ts', '7a74a90a4e2e756b732b2b0f8736423a1919fac5a5e980ca9ac8f92f9632ba56'],
  // Combine the reviewed named-link enum with the reviewed S7 terminal decoder.
  // Both remain data-only; incoming authored imports and hard-disabled probe stay exact.
  ['packages/contracts/src/draft/pilotUa2Classification.ts', 'd27f17370bad41358625855b4f924afb66cccaf70b5f606733f06a77d170a1af'],
  ['packages/contracts/src/draft/pilotUa4WriteAuthority.ts', '5273a2ab5260aa692a2099363b903d7879a543d78242d89a28513aa470807cd4'],
  ['packages/contracts/src/draft/pilotUa5Certification.ts', '75a41f10a30c96a81c4f364a8b84a728d3dc6df40bea1a87e2b78686736e18ae'],
  ['packages/contracts/src/draft/pilotUa5ProfileCurrentness.ts', '4c4e531d602bc76c272ee5a81a3f3d05035033d288704e0e313b076c4c3394cd'],
]);

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function authoredTypescriptFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory()
      ? authoredTypescriptFiles(child)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [child]
        : [];
  });
}

function staticImports(contents: string): string[] {
  const file = ts.createSourceFile('field-lab.ts', contents, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  let dynamicImports = 0;
  let importTypes = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) {
        imports.push(`${source}#side-effect`);
      } else {
        const bindings: string[] = [];
        if (clause.name) {
          bindings.push(`${clause.isTypeOnly ? 'type' : 'value'}:default>${clause.name.text}`);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.push(
              `${clause.isTypeOnly ? 'type' : 'value'}:*>${clause.namedBindings.name.text}`,
            );
          } else {
            for (const binding of clause.namedBindings.elements) {
              const imported = (binding.propertyName ?? binding.name).text;
              const local = binding.name.text;
              const renamed = imported === local ? '' : `>${local}`;
              bindings.push(
                `${clause.isTypeOnly || binding.isTypeOnly ? 'type' : 'value'}:${imported}${renamed}`,
              );
            }
          }
        }
        imports.push(`${source}#${bindings.sort().join(',')}`);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      imports.push(`FORBIDDEN_EXPORT_FROM:${node.moduleSpecifier.getText(file)}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImports += 1;
    }
    if (ts.isImportTypeNode(node)) importTypes += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(dynamicImports, 'dynamic import is outside the authored dependency ceiling').toBe(0);
  expect(importTypes, 'ImportTypeNode is outside the authored dependency ceiling').toBe(0);
  return imports.sort();
}

function fixedPropertyName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) return expression.argumentExpression.text;
  return null;
}

function hostControlPropertyWrites(contents: string): string[] {
  const file = ts.createSourceFile('field-lab.ts', contents, ts.ScriptTarget.Latest, true);
  const protectedProperties = new Set(['value', 'checked', 'selected', 'files']);
  const writes: string[] = [];
  const recordWrite = (expression: ts.Expression): void => {
    const property = fixedPropertyName(expression);
    if (property !== null && protectedProperties.has(property)) writes.push(property);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) recordWrite(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) recordWrite(node.operand);
    if (ts.isDeleteExpression(node)) recordWrite(node.expression);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      node.expression.name.text === 'set'
    ) {
      const property = node.arguments[1];
      if (
        property !== undefined &&
        (ts.isStringLiteral(property) || ts.isNoSubstitutionTemplateLiteral(property)) &&
        protectedProperties.has(property.text)
      ) writes.push(property.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return writes.sort();
}

function authoredHtmlDependencies(contents: string): {
  resourceEdges: string[];
  scriptKinds: string[];
  linkRels: string[];
  refreshMeta: string[];
  inlineBlocks: number;
  eventAttributes: string[];
  styleAttributes: number;
  prohibitedElements: number;
} {
  const parserWindow = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      enableJavaScriptEvaluation: false,
      enableImageFileLoading: false,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  try {
    const document = new parserWindow.DOMParser().parseFromString(contents, 'text/html');
    type SelectorRoot = {
      querySelectorAll(selectors: string): Iterable<Element> & ArrayLike<Element>;
    };
    const roots: SelectorRoot[] = [document as unknown as SelectorRoot];
    for (let index = 0; index < roots.length; index += 1) {
      for (const template of roots[index]!.querySelectorAll('template')) {
        roots.push((template as unknown as HTMLTemplateElement).content);
      }
    }
    const elements = roots.flatMap((root) => Array.from(root.querySelectorAll('*')));
    const resourceAttributes = new Set([
      'action', 'data', 'formaction', 'href', 'manifest', 'ping', 'poster', 'src', 'srcset',
    ]);
    const resourceEdges = elements.flatMap((element) =>
      Array.from(element.attributes)
        .filter((attribute) => {
          const name = attribute.name.toLowerCase();
          return resourceAttributes.has(name) || name.endsWith(':href');
        })
        .map((attribute) =>
          `${element.tagName.toLowerCase()}.${attribute.name.toLowerCase()}=${attribute.value.trim()}`),
    );
    const scriptKinds = elements
      .filter((element) => element.tagName.toLowerCase() === 'script')
      .map((script) =>
        `${(script.getAttribute('type') ?? '').trim().toLowerCase()}:${script.getAttribute('src') ?? ''}`);
    const linkRels = elements
      .filter((element) => element.tagName.toLowerCase() === 'link')
      .map((link) => `${(link.getAttribute('rel') ?? '').trim().toLowerCase()}:${link.getAttribute('href') ?? ''}`);
    const refreshMeta = elements
      .filter((element) =>
        element.tagName.toLowerCase() === 'meta'
          && (element.getAttribute('http-equiv') ?? '').trim().toLowerCase() === 'refresh')
      .map((meta) => (meta.getAttribute('content') ?? '').trim());
    const inlineBlocks = roots.reduce(
      (count, root) => count + root.querySelectorAll('style,script:not([src])').length,
      0,
    );
    const eventAttributes = elements.flatMap((element) =>
      Array.from(element.attributes)
        .filter((attribute) => attribute.name.toLowerCase().startsWith('on'))
        .map((attribute) => `${element.tagName.toLowerCase()}.${attribute.name.toLowerCase()}`),
    );
    const styleAttributes = elements.filter((element) => element.hasAttribute('style')).length;
    const prohibitedElements = roots.reduce(
      (count, root) =>
        count + root.querySelectorAll('base,embed,form,frame,iframe,object,svg').length,
      0,
    );
    return {
      resourceEdges: resourceEdges.sort(),
      scriptKinds: scriptKinds.sort(),
      linkRels: linkRels.sort(),
      refreshMeta: refreshMeta.sort(),
      inlineBlocks,
      eventAttributes: eventAttributes.sort(),
      styleAttributes,
      prohibitedElements,
    };
  } finally {
    parserWindow.close();
  }
}

describe('Field Lab authored dependency boundary', () => {
  it('pins every authored TypeScript edge to the approved production ports', () => {
    const authoredFiles = [
      'entrypoints/sidepanel/main.ts',
      ...authoredTypescriptFiles('field-lab'),
      ...authoredTypescriptFiles('product-panel'),
    ].sort();
    expect([...AUTHORED_IMPORTS.keys()].sort()).toEqual(authoredFiles);
    for (const [path, expected] of AUTHORED_IMPORTS) {
      expect(staticImports(source(path)), path).toEqual([...expected].sort());
    }
  });

  it('pins the reviewed production donor and dependency sources', () => {
    for (const [path, expected] of APPROVED_PRODUCTION_SOURCE_SHA256) {
      const digest = createHash('sha256')
        .update(readFileSync(resolve(REPO_ROOT, path)))
        .digest('hex');
      expect(digest, `${path} changed; re-review its Field Lab runtime authority`).toBe(expected);
    }
  });

  it('pins HTML to two direct stylesheets and one module, including nested template content', () => {
    const html = source('entrypoints/sidepanel/index.html');
    expect(authoredHtmlDependencies(html)).toEqual({
      resourceEdges: [
        'link.href=../../field-lab/tokens.css',
        'link.href=./style.css',
        'script.src=./main.ts',
      ],
      scriptKinds: ['module:./main.ts'],
      linkRels: [
        'stylesheet:../../field-lab/tokens.css',
        'stylesheet:./style.css',
      ],
      refreshMeta: [],
      inlineBlocks: 0,
      eventAttributes: [],
      styleAttributes: 0,
      prohibitedElements: 0,
    });

    const hostile = html.replace(
      '</body>',
      '<template><template><meta http-equiv="refresh" content="0;url=https://field-lab.invalid/redirect"><script src="../../lib/pilotUa4WriterRuntime.ts"></script><link rel="modulepreload" href="https://field-lab.invalid/x.js"><svg><use xlink:href="https://field-lab.invalid/x.svg"></use></svg><iframe src="https://field-lab.invalid"></iframe><button onclick="void 0">x</button></template></template></body>',
    );
    const hostileDependencies = authoredHtmlDependencies(hostile);
    expect(hostileDependencies.resourceEdges).toContain(
      'script.src=../../lib/pilotUa4WriterRuntime.ts',
    );
    expect(hostileDependencies.resourceEdges).toContain(
      'link.href=https://field-lab.invalid/x.js',
    );
    expect(hostileDependencies.resourceEdges).toContain(
      'use.xlink:href=https://field-lab.invalid/x.svg',
    );
    expect(hostileDependencies.refreshMeta).toEqual([
      '0;url=https://field-lab.invalid/redirect',
    ]);
    expect(hostileDependencies.prohibitedElements).toBe(2);
    expect(hostileDependencies.eventAttributes).toEqual(['button.onclick']);
  });

  it('uses import-free CSS and carries no parallel engine, synthetic authority, or data sink', () => {
    const productCss = source('product-panel/style.css');
    const css = source('entrypoints/sidepanel/style.css') + source('field-lab/tokens.css') + productCss;
    expect(css).not.toContain('@');
    expect(css).not.toContain('\\');
    expect(css).not.toMatch(/url\s*\(/iu);
    expect(css).not.toMatch(/(?:expression|image-set)\s*\(/iu);
    expect(productCss).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(productCss).not.toMatch(/(?:rgb|hsl|lab|lch|color)\s*\(/iu);
    expect(productCss).not.toContain('--action-');
    expect(productCss).toContain('outline: 0.1875rem solid var(--fl-accent)');
    expect(productCss).toContain('#product-panel-progress-title:focus-visible');
    expect(productCss).toContain('#product-panel-entry-preview-title:focus-visible');

    const authored = [...AUTHORED_IMPORTS.keys()].map(source).join('\n');
    const authoredContractSources = new Set(
      [...AUTHORED_IMPORTS.keys()].flatMap((path) =>
        staticImports(source(path))
          .map((edge) => edge.slice(0, edge.indexOf('#')))
          .filter((edge) => edge.startsWith('@edaix/contracts')),
      ),
    );
    expect([...authoredContractSources].sort()).toEqual([
      '@edaix/contracts/draft/pilot-local-wizard',
      '@edaix/contracts/draft/pilot-ua4-write-authority',
      '@edaix/contracts/draft/pilot-ua5-certification',
    ]);
    expect(
      [...AUTHORED_IMPORTS.keys()].flatMap((path) => hostControlPropertyWrites(source(path))),
      'Field Lab may read parsed Result.value, but may not write host control properties',
    ).toEqual([]);
    expect(authored).not.toMatch(/jobright|turbo|get unlimited|credits left/iu);
    expect(authored).not.toMatch(/current job|autofill information|required fields filled/iu);
    for (const forbidden of [
      'field-lab/model',
      'field-lab/fixtures',
      'createPilotUa1ContentRuntime',
      'createProfileProvider',
      'createPilotUa2ClassificationClient',
      'createPilotUa3CandidateRuleRuntime',
      'EPHEMERAL_PAGE_CANDIDATE',
      'SYNTHETIC_',
      'field-lab.invalid',
      'enabled: true',
      'authorityId',
      'questionAuthorizations',
      'blockedQuestions',
      'createPilotUa4LeafHostExecutor',
      'preparePilotUa4WriterBatch',
      'buildPilotUa4TerminalLedger',
      'executePilotUa4Leaf',
      '@edaix/apply-kernel',
      '../../chat',
      'background.ts',
      'requestSubmit(',
      '.submit(',
      'formaction',
      '.click(',
      'createFakeLedger',
      'createFakeRun',
      'fakeUndo',
      '.checked',
      '.selected',
      '.files',
      'innerHTML',
      'outerHTML',
      'document.cookie',
      'console.',
      'fetch(',
    ]) expect(authored, forbidden).not.toContain(forbidden);
  });

  it('pins the one public UA-4 composition path through compiler, classification, writer, and terminal', () => {
    const runtime = source('lib/pilotUa4WriterRuntime.ts');
    expect(runtime).toContain('preparePilotUa4WriterBatch');
    expect(runtime).toContain('executePilotUa4Leaf');
    expect(runtime).toContain('buildPilotUa4TerminalLedger');
    expect(runtime.indexOf('if (!policy.enabled)')).toBeLessThan(
      runtime.indexOf('const prepared = preparePilotUa4WriterBatch'),
    );

    const kernel = readFileSync(
      resolve(REPO_ROOT, 'packages/apply-kernel/src/pilotUa4Writer.ts'),
      'utf8',
    );
    expect(kernel).toContain("import { classifyQuestions } from './semantic/classify.ts'");
    expect(kernel).toContain("import { compileGraph, type EpochInput } from './semantic/graph.ts'");
    expect(kernel).toContain('const compiled = compileGraph(input.semanticEpochs, input.semanticDigest)');
    expect(kernel).toContain('const classifications = classifyQuestions(graph, ua2ByDigest)');

    const authority = readFileSync(
      resolve(REPO_ROOT, 'packages/contracts/src/draft/pilotUa4WriteAuthority.ts'),
      'utf8',
    );
    expect(authority).toContain("submit: 'FORBIDDEN'");
    expect(authority).toContain("activationState: 'DEFAULT_OFF'");
    expect(authority).toContain("releaseState: 'NOT_RELEASED'");
  });
});
