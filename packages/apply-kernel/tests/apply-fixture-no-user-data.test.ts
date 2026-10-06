import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 夹具**不含真实资料**的强制证明。
 *
 * `scripts/check-no-l1-data.mjs` 允许把 fixture 登记进 ALLOWED，但要求
 * 「必须逐项登记并**由测试证明不含真实资料**」。这个文件就是那个证明。
 *
 * 为什么需要它：本仓的 ATS 夹具不是凭空合成，是照着**真实申请页转写结构**
 * （CAP-AF-024 的验收要求逐字匹配宿主选项文案，凭想象编的题干测不出租户差异，
 * 见 `docs/50-证据库.md` §F.5-e ④）。转写就有夹带个人资料的风险，
 * 所以必须有一道会红的闸门盯着。
 *
 * ⚠️ 断言只用**形状**，不写任何具体人的标识符。
 * 把某个真人的邮箱／电话写进 denylist，等于为了防 PII 而把 PII 提交进 git——
 * 那是自相矛盾的。形状断言同时也覆盖未来任何人的资料，比 denylist 更强。
 *
 * 目录是**动态枚举**的：新增夹具自动受这道闸门约束，不需要有人记得来加一行。
 */

const FIXTURE_ROOT = resolve(__dirname, 'fixtures');

function everyFixtureHtml(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return everyFixtureHtml(full);
    return entry.isFile() && entry.name.endsWith('.html') ? [full] : [];
  });
}

const FIXTURES = everyFixtureHtml(FIXTURE_ROOT).sort();

/** `<!-- ... -->` 注释里写出处与实测说明是允许的，但同样不许夹带资料。 */
function withoutHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

describe('ATS 夹具不含真实用户资料', () => {
  it('至少扫到了夹具，避免这道闸门因为路径写错而空转', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const path of FIXTURES) {
    const name = relative(FIXTURE_ROOT, path);
    const source = readFileSync(path, 'utf8');
    const body = withoutHtmlComments(source);

    describe(name, () => {
      it('没有邮箱形态的字符串', () => {
        expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
      });

      it('没有电话号码形态的字符串', () => {
        // +1 (585) 537-8485 / 585-537-8485 / 5855378485 都要挡住。
        expect(source).not.toMatch(/(?:\+?\d[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
      });

      it('没有街道地址形态的字符串', () => {
        expect(body).not.toMatch(
          /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way)\b/,
        );
      });

      it('文本类控件没有已填的 value —— 夹具只提供结构，不提供答案', () => {
        // `value` 有两种完全不同的含义，这里只查后一种：
        //  · **选项身份**：`<input type=radio value="yes">`、`<option value="3">`
        //    ——它是控件定义的一部分，没有它夹具就测不出选项匹配，必须保留。
        //  · **已填答案**：文本框上的 `value` ——那才是可能夹带真人资料的地方。
        // 「有没有被选中」由下一条 checked/selected 断言负责，两条互补。
        const TEXTUAL_TYPES = /^(?:text|email|tel|url|search|password|number|date|month|week|time)$/i;
        const filled = [...body.matchAll(/<input\b([^>]*)>/gi)]
          .map(([, attributes]) => attributes)
          .filter((attributes) => {
            const type = /\stype\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? 'text';
            return TEXTUAL_TYPES.test(type);
          })
          .map((attributes) => /\svalue\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '')
          .filter((captured) => captured.trim() !== '');
        expect(filled).toEqual([]);
      });

      it('textarea 内没有预填正文', () => {
        const bodies = [...body.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)]
          .map(([, inner]) => inner)
          .filter((inner) => inner.trim() !== '');
        expect(bodies).toEqual([]);
      });

      it('没有预先选中的选项或勾选框', () => {
        expect(body).not.toMatch(/\s(?:checked|selected)(?:\s|=|>)/);
      });

      it('没有 base64 内联资源（截图／附件不得夹带）', () => {
        expect(source).not.toMatch(/data:[a-z/+-]+;base64,/i);
      });
    });
  }
});
