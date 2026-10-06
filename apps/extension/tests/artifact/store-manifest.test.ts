import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AUTOFILL_EXCLUDE_MATCHES, AUTOFILL_WIDE_MATCHES, applyHostMatchPatterns } from '@edaix/apply-kernel/vendors';
import { ADAPTERS } from '@edaix/apply-kernel/bundledAdapters';

/**
 * 上架包 manifest 的**产物级**门禁——读真构建出来的文件，不读源码也不喂合成对象。
 *
 * 为什么单独存在（2026-08-18 逐条核查发现的最后一格）：
 * `tests/injection-scope-gate.test.ts` 已经很硬——真 import `wxt.config.ts`、
 * 真取出 `build:manifestGenerated` 钩子、真跑一遍再断言。但它喂给钩子的是一份
 * **合成的** manifest。全仓没有任何东西读过真产物，而 CI 的 `mv3-build` 只构
 * dev flavor——`VIBE_DIST=store` 在整个流水线里零命中，**商店包从未被产出过**。
 *
 * 也就是说：WXT 升级改了钩子调用时机、或者有人在别处又往 manifest 塞了权限，
 * 那道测试仍会全绿，而真正上传到 Chrome 商店的 zip 里可能带着全网权限。
 *
 * ⚠️ **本文件刻意不在默认 `pnpm test` 里跑**（`tests/artifact/` 被 vitest.config
 * 排除），因为它需要先有构建产物。跑法：`pnpm check:store`（先构建再断言）。
 * 产物缺失时它**直接失败而不是跳过**——跳过就成了恒真门禁
 * （`docs/64-审查清单.md` 第 1 项点名的假保护形态之一）。
 */

const OUT_DIR = resolve(__dirname, '..', '..', '.output-store');

/** 全域通配闭集——与 injection-scope-gate 同口径，别只查一种写法。 */
const WIDE = ['https://*/*', 'http://*/*', '*://*/*', '<all_urls>', 'file:///*', 'file://*'];

function loadStoreManifest(): Record<string, unknown> {
  expect(
    existsSync(OUT_DIR),
    `找不到 ${OUT_DIR}——本门禁要读真产物。先跑 pnpm --filter @edaix/extension check:store`,
  ).toBe(true);
  const flavor = readdirSync(OUT_DIR).find((d) => existsSync(join(OUT_DIR, d, 'manifest.json')));
  expect(flavor, `${OUT_DIR} 下没有任何 manifest.json——构建没出产物`).toBeTruthy();
  return JSON.parse(readFileSync(join(OUT_DIR, flavor!, 'manifest.json'), 'utf8'));
}

/**
 * 递归扫全份 manifest 找全域通配——权限可能从任何新字段漏出去，不只 matches。
 *
 * 2026-09-24 起唯一的例外：隔离世界 apply 内容脚本的 `content_scripts[i].matches` 里的 `https://*​/*`
 * （负责人决定第一版上架就开全网，见 RULE-EXT-OPTIONAL-HOST-ONLY）。别处（host_permissions、
 * web_accessible_resources、externally_connectable……）出现一样是扩权；http、*://、<all_urls>、file 任何地方都不许。
 */
function findWide(node: unknown, path = ''): string[] {
  if (typeof node === 'string') {
    const allowedIsolatedMatch = node === 'https://*/*' && /^content_scripts\[\d+\]\.matches\[\d+\]$/u.test(path);
    return WIDE.includes(node) && !path.includes('exclude_matches') && !allowedIsolatedMatch ? [`${path} = ${node}`] : [];
  }
  if (Array.isArray(node)) return node.flatMap((v, i) => findWide(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => findWide(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function artifactFiles(path = OUT_DIR): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    return entry.isDirectory()
      ? artifactFiles(fullPath)
      : [fullPath.slice(OUT_DIR.length + 1)];
  });
}

describe('上架包 manifest（真产物，不是合成对象）', () => {
  it('隔离世界的 apply 内容脚本：matches 恰好是全网 https，exclude_matches 恰好是排除表（2026-09-24 开全网）', () => {
    const scripts = (loadStoreManifest().content_scripts ?? []) as Array<{ matches?: string[]; exclude_matches?: string[]; world?: string }>;
    expect(scripts.length, '产物里没有 content_scripts').toBeGreaterThan(0);
    const isolated = scripts.filter((script) => script.world !== 'MAIN');
    expect(isolated.length, '产物里没有隔离世界的内容脚本').toBeGreaterThan(0);
    for (const [i, script] of isolated.entries()) {
      expect(script.matches, `content_scripts[${i}].matches 不是全网 https——上传到商店的包和我们以为的不是一个东西`)
        .toEqual([...AUTOFILL_WIDE_MATCHES]);
      // WXT 生成 manifest 时会重排 exclude_matches，比集合、不比顺序。
      expect([...(script.exclude_matches ?? [])].sort(), `content_scripts[${i}] 丢了排除表（验证码、追踪、广告域）`)
        .toEqual([...AUTOFILL_EXCLUDE_MATCHES].sort());
    }
  });

  it('MAIN world 的内容脚本（若有）只用窄主机表，不跟着开全网', () => {
    const scripts = (loadStoreManifest().content_scripts ?? []) as Array<{ matches?: string[]; world?: string }>;
    for (const script of scripts.filter((one) => one.world === 'MAIN')) {
      expect(script.matches).toEqual(applyHostMatchPatterns(ADAPTERS));
    }
  });

  it('版本号：CI 给了就逐字等于它，没给就是 package.json 的 0.0.0', () => {
    const manifest = loadStoreManifest();
    const assigned = process.env.VIBE_EXTENSION_VERSION;
    expect(manifest.version).toBe(assigned === undefined ? '0.0.0' : assigned);
    expect(String(manifest.version)).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/u);
    expect(manifest, '商店包不得带 version_name').not.toHaveProperty('version_name');
  });

  it('整份 manifest 任何位置都不出现全域通配', () => {
    const hits = findWide(loadStoreManifest());
    expect(hits, `上架包产物出现全域通配：\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  /**
   * 权限面必须是**精确闭集**，不是"不含通配"这种弱断言。
   *
   * 审查（PR #14，2026-08-18）用变异探针证伪了初版：往产物的 host_permissions
   * 里加 `https://evil.example/*` 和 `https://*.evil.example/*`，
   * 3/3 仍然全绿——「只点名生产 origin」这句声称当时没有被任何东西证明。
   *
   * 弱断言漏掉的四类：任意额外的精确域名、非全域子域通配、缺失某个获准站点、
   * 重复或漂移的匹配项。所以这里和 matches 一样用逐项相等。
   *
   * 三个字段一起锁：权限面是同一条信任边界，新增 `tabs` 权限或多一个
   * 可连接网站，与多一个 host 一样是扩权。
   */
  it('权限面是精确闭集：host_permissions / permissions / externally_connectable', () => {
    const manifest = loadStoreManifest();
    expect(
      manifest.host_permissions,
      'host_permissions 不等于精确 allowlist——多一个域名就是多一份用户授权',
    // 2026-09-16：本仓服务 argoland.ai 那个产品；edaix.io 是同仓另一个产品，
    // 由已上架的 vibeID-frontend 那支插件服务，不该出现在本包的授权面里。
    ).toEqual(['https://api.career-companion.invalid/*']);
    expect(
      manifest.permissions,
      'permissions 不等于精确闭集——新增权限会改变商店审核面与用户看到的提示',
    ).toEqual(['storage', 'alarms']);
    expect(
      manifest,
      'UA-1 只允许显式 development flag；store 产物不得带 browser action',
    ).not.toHaveProperty('action');
    expect(
      (manifest.background as { service_worker?: unknown } | undefined)?.service_worker,
      'content trigger pins sender.url to the one exact WXT service-worker artifact',
    ).toBe('background.js');
    for (const forbidden of ['activeTab', 'tabs', 'scripting']) {
      expect(manifest.permissions).not.toContain(forbidden);
    }
    expect(
      (manifest.externally_connectable as { matches?: string[] } | undefined)?.matches,
      'externally_connectable.matches 不等于精确闭集——多一个 origin 就多一个能对扩展说话的站点',
    ).toEqual(['https://career-companion.invalid/*']);
  });

  it('does not contain the unpacked-only Field Lab entrypoint or permission', () => {
    const manifest = loadStoreManifest();
    expect(manifest).not.toHaveProperty('side_panel');
    expect(manifest).not.toHaveProperty('sidebar_action');
    expect(manifest.permissions).not.toContain('sidePanel');
    const files = artifactFiles();
    expect(files.filter((file) => /sidepanel|field-lab/iu.test(file))).toEqual([]);
    const text = files
      .map((file) => readFileSync(join(OUT_DIR, file), 'utf8'))
      .join('\n');
    for (const marker of [
      'DEV FIELD LAB',
      'EdAIX Field Lab',
      'field-lab/value-free-probe',
      'FIELD_LAB_DISCOVERY_BOUNDARY_VIOLATION',
      'FIELD_LAB_ADAPTER_UNAVAILABLE',
      'field-lab.invalid',
      'UA-4_PUBLIC_SEAM',
      'NOT_CONNECTED',
      'Run value-free adapter probes',
      'product-panel/interaction-prototype',
      'EdAIX Connected Lab',
      'edaix-pilot-ua5-panel-v1',
      'edaix-pilot-ua5-panel-v2',
      'edaix-pilot-ua5-content-v1',
      'edaix-pilot-ua5-content-v2',
      'pilot-ua5/profile-payload-request',
      '--fl-',
      '.fl-',
    ]) expect(text, marker).not.toContain(marker);
  });
});

describe('store identity', () => {
  // The store assigns this artifact's identity itself. A developer key here would
  // pin a private identity onto the listing. Now that non-store builds may carry
  // one, the invariant worth proving is that this one never does.
  it('never carries manifest.key', () => {
    expect(loadStoreManifest().key).toBeUndefined();
  });
});

it('does not ship the default-off assistant read bridge', () => {
  const text = artifactFiles().map(file => readFileSync(join(OUT_DIR, file), 'utf8')).join('\n');
  expect(text).not.toContain('assistant/read-v1');
  expect(text).not.toContain('edaix/assistant-read-v1');
});

/**
 * RULE-EXT-NEVER-SUBMIT 管的是随包字节，新依赖带进来的也算：商店包里每一个 JS
 * （background、内容脚本、以后出现的 chunks）都不得有 `.submit(` 或 `requestSubmit`。
 * 模式与 assistant-manifest 那道闸逐字相同。那道闸为 React 的一句报错文案开了口子；
 * 商店包今天不带 React，这里不开——哪天依赖把这类字节带进商店包，这一条就该红，由人来定。
 */
it('每个随包 JS 都不含 .submit( 与 requestSubmit（RULE-EXT-NEVER-SUBMIT）', () => {
  const scripts = artifactFiles().filter((file) => file.endsWith('.js'));
  // 先证明两个入口真的在扫描范围里，免得目录不对时「什么都没扫」而恒绿。
  expect(scripts).toEqual(expect.arrayContaining(['chrome-mv3/background.js', 'chrome-mv3/content-scripts/apply.js']));
  const hits = scripts.filter((file) => /requestSubmit|\.submit\s*(?:\?\.\s*)?\(/u.test(readFileSync(join(OUT_DIR, file), 'utf8')));
  expect(hits, `随包 JS 出现提交调用：\n  ${hits.join('\n  ')}`).toEqual([]);
});

/**
 * 商店包的规则通道必须有终点。
 *
 * 这一格是空的，于是一条结构性的死路一路走到了要上架的那个包里：
 * `EXECUTION_RUNTIME_BUNDLE_ENABLED` 对商店包**写死为 true**，而
 * `resolveApiBaseOverride({ storeBuild: true })` 按设计**恒为 null**——商店包拿不到
 * 任何 origin 覆盖。两条各自都对的规矩合起来，把规则通道的终点定成了 null：
 * `executeRefresh` 第一行就答 `RUNTIME_BUNDLE_CONFIG_UNAVAILABLE`，规则永远取不到，
 * 装入表永远是空的，`hasApplyAdapter` 对每一页都答 false，**浮层在任何申请页上都
 * 不出现**。没有报错、没有红字，看起来就像"这一页不支持"。
 *
 * 2026-09-18 在真实 Greenhouse 申请页上实测：装商店包、等 50 秒，
 * `chrome.storage.local` 是空的——一个字节的规则都没拉到。
 *
 * 按产物字节判，而不是读逻辑：开关与终点都由 Rollup 折成字面量，所以这一条能直接
 * 看出「要上架的这些字节，规则通道指向哪里」。
 */
describe('上架包的规则通道', () => {
  it('终点是生产 origin，不是 null', () => {
    const flavor = readdirSync(OUT_DIR).find((d) => existsSync(join(OUT_DIR, d, 'background.js')));
    expect(flavor, `${OUT_DIR} 下没有 background.js——构建没出产物`).toBeTruthy();
    const source = readFileSync(join(OUT_DIR, flavor!, 'background.js'), 'utf8');
    const worker = ts.createSourceFile('background.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    // 按 AST 找，不按正则：压缩产物的属性次序与写法都不保证，
    // 而 `assistant-manifest` 那道闸早就用同一种找法（见它的 locate）。
    let apiBase: ts.Expression | undefined;
    let found = 0;
    const locate = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const props = options.properties.filter(ts.isPropertyAssignment);
          const has = (name: string) => props.some((p) => p.name.getText(worker) === name);
          if (has('apiBase') && has('store') && has('extensionVersion')) {
            found += 1;
            apiBase = props.find((p) => p.name.getText(worker) === 'apiBase')!.initializer;
          }
        }
      }
      ts.forEachChild(node, locate);
    };
    locate(worker);

    expect(found, 'background.js 里找不到 bundle client 的构造点').toBe(1);

    /**
     * 折叠之后它可能是字面量，也可能是一个 Rollup 提出去的常量——
     * 同一个 origin 串在产物里出现多次时它就会这么做。顺着那个名字回去读一层，
     * 读不到就如实答 null（那会让下面那条断言红，而不是悄悄放过去）。
     */
    const asText = (node: ts.Expression | undefined): string | null => {
      if (node === undefined) return null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (!ts.isIdentifier(node)) return null;
      let bound: string | null = null;
      const find = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === node.text &&
          n.initializer !== undefined
        ) {
          if (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) {
            bound = n.initializer.text;
          }
        }
        ts.forEachChild(n, find);
      };
      find(worker);
      return bound;
    };
    const literal = asText(apiBase);

    expect({ kind: apiBase!.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'literal', literal })
      .toEqual({ kind: 'literal', literal: 'https://api.career-companion.invalid' });
  });
});

/** 商店包里内容脚本的路径（找不到就红，不跳过）。 */
function applyScriptPath(): string {
  const flavor = readdirSync(OUT_DIR).find((d) => existsSync(join(OUT_DIR, d, 'content-scripts', 'apply.js')));
  expect(flavor, `${OUT_DIR} 下没有 content-scripts/apply.js——构建没出产物`).toBeTruthy();
  return join(OUT_DIR, flavor!, 'content-scripts', 'apply.js');
}

function readApplyScript(): string {
  return readFileSync(applyScriptPath(), 'utf8');
}

/**
 * 商店包 apply.js 的体积预算（2026-10-03 起）。
 *
 * 这一份注入每一个 https 页面的每一帧，在 document_start 同步跑完：体积直接就是每个网页上的编译与执行时间
 * （2026-10-03 全网注入实测：普通网页约 40 ms 主线程，其中编译约 16 ms，没有 V8 代码缓存）。从前只有 Assistant
 * 产物有预算（assistant-manifest.test.ts），带浮层、真正上架的这一份没人看着，长多少都是绿的。
 *
 * 2026-10-03：首次设为 912 KiB。336cd9d3 上 924,718 字节；同一轮的五处修补（HIDDEN 不重问、无关子帧不要规则也不装
 * 提交拦截、证据不重复探、touchstart 晚装、不往页面广播扩展 ID）+365 字节，实测 925,083 字节（903.4 KiB），留约 8.6 KB
 * （不到 1%）。碰线时照 Assistant 那一份的规矩：同基点实测、写明加了什么，能先压就先压，再调。
 * 下一步是拆包（全网只注入极小的加载器，整包按需加载）；拆完这个数应当大幅往下调。
 *
 * 2026-10-04：912 → 928 KiB。资料新鲜度七件（#146，2026-10-03 前端体检 P0／P1）：「我的资料」先显示上一份、后台换新，
 * 别处刚存过时逐项合并与冲突卡，教育「在读」，会话代号（换了账号丢掉上一个人的预取与编辑器里那一份），离开、回来就重取，
 * 读写时限与正在保存时等一秒再读——都在浮层这一侧。合进含 #141–#143 的 main 后实测 927,772 → 945,874 字节（+18,102），
 * 912 KiB 超出 11,986 字节。没有带进新的依赖。调到 928 KiB 留约 4.4 KB；再碰线时同样写明加了什么。
 *
 * 2026-10-04：928 → 948 KiB。内核按资料直接答五类题（#144：语言、到办公室上班、工作年限、现在在读吗、服过兵役吗）：判读与
 * 语言名表都在内核里，Assistant 那一份逐模块写在 assistant-manifest.test.ts（同一批 +20.5 KB）。合进含 #141–#143、#146 的
 * main 后实测 945,874 → 967,062 字节（+21,188），928 KiB 超出 16,790 字节。没有带进新的依赖。调到 948 KiB 留约 3.6 KB。
 *
 * 2026-10-04：948 → 964 KiB。线上可观测性（#147，前端体检 11-1…11-5）：记一轮结局的那一层（lib/runOutcomeTap.ts 与原因闭集，
 * 约 8 KB）、内容脚本入口与浮层按钮的异常包装（只交闭集码与错误类名）、站点知识要不到再要一次。合进含 #141–#146 的 main
 * （中间 #145 出差题 +2,938）后实测 970,000 → 981,121 字节（+11,121），948 KiB 超出 10,369 字节。没有带进新的依赖。
 * 调到 964 KiB 留约 5.9 KB（960 KiB 只留 1,919 字节）；再碰线时同样写明加了什么。
 *
 * 2026-10-04：964 → 976 KiB。验证码第 1 步（#149）：在商店包里这些都活着——浮层那张验证码卡（中英文案）、看着这一页的那一套
 * （lib/verificationCodePage.ts）、写入原语 write/emailCode.ts、认格的 rules/emailVerification.ts，加上任何构建都有的规则新键
 * `emailVerification` 的解析、扫描时排除验证码容器、提交控制器交回 CODE_REQUIRED。合进含 #141–#148 的 main（#148 浮层里提交
 * 再开三家 +856）后实测 981,977 → 996,491 字节（+14,514），964 KiB 超出 9,355 字节。没有带进新的依赖。调到 976 KiB 留约
 * 2.9 KB；再碰线时同样写明加了什么。
 *
 * 2026-10-04：976 → 992 KiB。浮层说实话（#150）：页面上还空着的必填（内核 pageGaps.ts 与扩展 lib/pageGaps.ts，约 9 KB）、连填
 * 往下翻之前把它们算进去与 SITE_ERRORS、没放行的厂商那张脸与 VENDOR_CLOSED、Jobvite 数据同意页的停因 `consentGate`、岗位卡
 * 还原转义过的简介与实体、代填行用选项那句话做标题，加上中英文案。合进含 #141–#149 的 main 后实测 996,491 → 1,010,228 字节
 * （+13,737），976 KiB 超出 10,804 字节。没有带进新的依赖。调到 992 KiB 留约 5.4 KB（988 KiB 只留 1,484 字节）；再碰线时同样
 * 写明加了什么。
 *
 * 2026-10-04：992 → 1000 KiB。Jobvite 数据同意页替他选居住地（#154 D7：lib/consentGatePass.ts、内核 consentGate.ts 与
 * dict/consentGate.ts）、BambooHR 先替他点开申请表（D8：lib/applyGateOpen.ts、规则适配器的 applyGateControl）、自动打开的浮层
 * 等页面安静下来再量、避开网站右侧的主要按钮（sitePrimaryActions 与浮层的收窄），加上中英文案。合进含 #141–#150 的 main 后
 * 实测 1,010,228 → 1,019,209 字节（+8,981），992 KiB 超出 3,401 字节。没有带进新的依赖。调到 1000 KiB 留约 4.8 KB（996 KiB
 * 只留 695 字节）；再碰线时同样写明加了什么。
 */
describe('上架包内容脚本的体积', () => {
  it('apply.js 不超过评审预算', () => {
    expect(statSync(applyScriptPath()).size).toBeLessThanOrEqual(1000 * 1024);
  });
});

/**
 * 内容脚本不往页面上广播扩展身份（2026-10-03 全网注入实测；为什么关得掉，见 tests/content-script-started-message.test.ts）。
 *
 * WXT 的 ContentScriptContext 一建起来就 `window.postMessage({ type: '<扩展 ID>:apply:wxt:content-script-started' }, '*')`，
 * 任何网站的 message 监听都收得到。按要上架的字节判，两件事：
 *  ①我们的内容脚本定义（带 `runAt: document_start` 与 `main` 的那一个对象）带着 `noScriptStartedPostMessage: true`；
 *  ②产物里每一处发 content-script-started 的 postMessage 都受这个开关管、方向也对（开关为真就不发）。
 * WXT 升级把开关改了名、或者改成无条件广播，②就红。
 */
describe('上架包不向页面广播扩展身份', () => {
  it('apply.js：定义关掉了 content-script-started 的 postMessage，产物里那一处 postMessage 受这个开关管', () => {
    const source = readApplyScript();
    const ast = ts.createSourceFile('apply.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const OPTION = 'noScriptStartedPostMessage';
    const strip = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? strip(node.expression) : node);
    const isTrue = (node: ts.Expression): boolean => {
      const value = strip(node);
      return value.kind === ts.SyntaxKind.TrueKeyword || (
        ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isNumericLiteral(value.operand) && value.operand.text === '0'
      );
    };
    const reads = (node: ts.Node): boolean => node.getText(ast).includes(OPTION);
    const negated = (node: ts.Expression): boolean => {
      const value = strip(node);
      return ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken && reads(value.operand);
    };
    const within = (inner: ts.Node, outer: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end;
    /** 这一处调用只在开关为假时才走得到。 */
    const guarded = (call: ts.Node): boolean => {
      for (let node: ts.Node = call; node.parent !== undefined && !ts.isFunctionLike(node); node = node.parent) {
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && within(call, parent.right)) {
          if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && reads(parent.left) && !negated(parent.left)) return true;
          if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && negated(parent.left)) return true;
        }
        if (ts.isIfStatement(parent)) {
          if (within(call, parent.thenStatement) && negated(parent.expression)) return true;
          if (parent.elseStatement !== undefined && within(call, parent.elseStatement) && reads(parent.expression) && !negated(parent.expression)) return true;
        }
        if (ts.isConditionalExpression(parent)) {
          if (within(call, parent.whenTrue) && negated(parent.condition)) return true;
          if (within(call, parent.whenFalse) && reads(parent.condition) && !negated(parent.condition)) return true;
        }
      }
      return false;
    };

    const definitions: ts.ObjectLiteralExpression[] = [];
    const broadcasts: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const named = (name: string) => node.properties.find((p) => p.name !== undefined && p.name.getText(ast) === name);
        const runAt = named('runAt');
        if (
          runAt !== undefined && ts.isPropertyAssignment(runAt) &&
          (ts.isStringLiteral(runAt.initializer) || ts.isNoSubstitutionTemplateLiteral(runAt.initializer)) &&
          runAt.initializer.text === 'document_start' && named('main') !== undefined
        ) definitions.push(node);
      }
      if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'postMessage' &&
        node.arguments.some((arg) => arg.getText(ast).includes('SCRIPT_STARTED_MESSAGE_TYPE'))
      ) broadcasts.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(definitions, 'apply.js 里应当恰好有一个内容脚本定义').toHaveLength(1);
    const option = definitions[0]!.properties.find((p) => p.name !== undefined && p.name.getText(ast) === OPTION);
    expect(option !== undefined && ts.isPropertyAssignment(option) && isTrue(option.initializer), `定义里没有 ${OPTION}: true`).toBe(true);
    // 先证明找到了 WXT 那一处广播，免得因为什么都没找到而恒绿。哪天 WXT 整条删掉了它，这一条会红：那时删掉这一条即可。
    expect(broadcasts.length, '产物里找不到 WXT 的 content-script-started postMessage').toBeGreaterThan(0);
    expect(broadcasts.filter((call) => !guarded(call)).map((call) => call.getText(ast).slice(0, 120)), '不受开关管的广播').toEqual([]);
  });
});
