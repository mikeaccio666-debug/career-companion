import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 规则的**校验与编译**这一支，必须能在没有浏览器的地方跑。
 *
 * 为什么这是一条要守的边：签发规则包的是 argoland 的服务端，它在把
 * `execution-runtime-bundle` 发出去之前，要先把每一份规则真的编译成适配器
 * （`createRuntimeApplyRegistry`）——编译不动的规则不该发出去。为此它 vendored
 * 了本仓的解释器这一支，跑在 Node 里。
 *
 * 2026-09-17 这条边断过一次，而且症状一点都不像「边断了」：
 * `rules/interpreter.ts` 为了装**一个数字**（厂商声明的简历标题往上找几层），
 * import 了 `write/setFile.ts`。那条链往下是 `undo.ts` → `policy.ts` →
 * `write/mainWorldBridge.ts`，于是 `import.meta.env` 和 WebExtension 的
 * `browser` 全局被拖进了一个 Node 进程，服务端 `tsc` 直接 TS2304。
 * 这一支要么跟着上游走、把浏览器依赖一起搬过去，要么停在原地——
 * 而停在原地就是那次 503：老 schema 判新规则 `RUNTIME_RULESET_REJECTED`。
 *
 * 所以这里按**导入闭包**来判，而不是只看解释器自己那几行 import：
 * 断的从来不是第一跳。
 */

const SRC = join(dirname(new URL(import.meta.url).pathname), '..', 'src');

/** 只跟着相对导入走；包引用由契约那一侧自己管。 */
function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const here = dirname(file);
  const out: string[] = [];
  for (const match of source.matchAll(/(?:from|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const spec = match[1]!.replace(/\.ts$/, '');
    out.push(join(here, spec.split('/').join(sep)) + '.ts');
  }
  return out;
}

function closureFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of localImports(file)) {
      try {
        if (statSync(next).isFile()) queue.push(next);
      } catch {
        // 解析不到的相对路径由 tsc 去报；这条闸只管它够得到的那些。
      }
    }
  }
  return seen;
}

/**
 * 注释不算数。
 *
 * 这道闸按源码文本判，而**解释这道闸为什么存在的那段注释**本身就要写出
 * `import.meta.env` 和 `browser.runtime` 这些词——不剥注释的话，第一个被它判红的
 * 就是它自己的说明文字（写完当场撞上，2026-09-17）。本仓别处的源码闸也吃过
 * 同一种亏：一个只出现在注释里的函数名把闸点红了。
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 只有浏览器里才有的东西。命中任何一个，这一支就不能在 Node 里跑了。 */
const BROWSER_ONLY = [
  /\bimport\.meta\.env\b/,
  /(?<![.\w])browser\.(?:runtime|storage|tabs|scripting)\b/,
  /\bchrome\.(?:runtime|storage|tabs|scripting)\b/,
  /\bdocument\.(?:createElement|querySelector)\b/,
];

describe('规则编译这一支跑得起来，不带浏览器', () => {
  const entries = [join(SRC, 'rules', 'schema.ts'), join(SRC, 'rules', 'interpreter.ts'), join(SRC, 'runtimeRegistry.ts')];

  it('闭包不是空的（这道闸不许是空转的）', () => {
    for (const entry of entries) {
      expect(closureFrom(entry).size).toBeGreaterThan(3);
    }
  });

  it.each(entries.map((entry) => relative(SRC, entry).split(sep).join(posix.sep)))(
    '%s 的导入闭包里没有浏览器专属的东西',
    (relEntry) => {
      const offenders: string[] = [];
      for (const file of closureFrom(join(SRC, relEntry.split(posix.sep).join(sep)))) {
        const source = codeOnly(readFileSync(file, 'utf8'));
        const hit = BROWSER_ONLY.find((pattern) => pattern.test(source));
        if (hit) offenders.push(`${relative(SRC, file).split(sep).join(posix.sep)} 命中 ${hit}`);
      }

      expect(offenders).toEqual([]);
    },
  );
});
