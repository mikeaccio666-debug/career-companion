import { describe, expect, it } from 'vitest';
import bamboohr from '@edaix/apply-rules/bamboohr.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * BambooHR 真实形状（2026-09-16 于 nomadgcs.bamboohr.com 抓 DOM）。
 *
 * `Resume*` 这个标题**存在**，只是挂在祖先链更上面：
 *   Resume* → Flex → FileUpload → FileUploadInput → FileUploadToggle → input
 * 超出内核默认的 4 层，所以够不着、认不出身份。2026-09-16 全量批测里 126 个
 * 必填简历框卡在同一个病上（workable 48 / bamboohr 40 / ashby 38）。
 */
const FORM = `
  <div id="application">
    <div><div>Resume*</div>
      <div><div><div><div>
        <label>Choose File*</label>
        <input type="file" aria-label="file-input" data-bi-id="-file-input" required />
      </div></div></div></div>
    </div>
    <label for="first">First Name</label><input id="first" name="firstName" />
  </div>`;

const RULES = (extra: Record<string, unknown>) => ({
  ...(bamboohr as Record<string, unknown>),
  anchors: ['#application'],
  applyPath: { source: '^/careers/\\d+$' },
  keySteps: [{ type: 'attrMap', attr: 'name', confidence: 1, map: { firstname: 'firstName' } }],
  ...extra,
});

const scanWith = (extra: Record<string, unknown>) => {
  document.body.innerHTML = FORM;
  const adapter = compileBundledAdapter(RULES(extra));
  const root = adapter.resolveRoot(document);
  expect(root, '锚点必须解析出来，否则这条测试什么都没测到').not.toBeNull();
  return [...adapter.scan(root!)];
};

const code = (input: unknown) => {
  const parsed = parseVendorRuleset(input) as { ok: boolean; code?: string };
  return parsed.ok ? 'OK' : (parsed.code ?? '?');
};

describe('厂商声明的简历标题搜索深度', () => {
  it('默认 4 层够不着标题，file 栏拿不到身份', () => {
    const file = scanWith({ fileContextMaxDepth: null }).find((field) => field.kind === 'file');
    // 控件仍然被看见（存在、必填），但没有 canonical 身份，所以进不了计划。
    expect(file?.key ?? null).toBeNull();
  });

  it('抬到 6 层够得着，其余字段不受影响', () => {
    const fields = scanWith({ fileContextMaxDepth: 6 });
    expect(fields.find((field) => field.kind === 'file'), 'file 栏必须仍在扫描结果里').toBeDefined();
    expect(fields.find((field) => field.key === 'firstName'), '普通字段不受影响').toBeDefined();
  });

  it('抬深度不等于放宽判据：标题不说 Resume 就仍然不算', () => {
    document.body.innerHTML = FORM.replace('Resume*', 'Upload a photo of your badge*');
    const adapter = compileBundledAdapter(RULES({ fileContextMaxDepth: 6 }));
    const file = [...adapter.scan(adapter.resolveRoot(document)!)].find((f) => f.kind === 'file');
    expect(file?.key ?? null, '文案不说 Resume，抬多深都不该认').toBeNull();
  });

  it('非法深度整份拒收；缺省与 null 都等于用内核默认值', () => {
    expect(code(RULES({ fileContextMaxDepth: 0 }))).toBe('RULES_MALFORMED');
    expect(code(RULES({ fileContextMaxDepth: -1 }))).toBe('RULES_MALFORMED');
    expect(code(RULES({ fileContextMaxDepth: 5.5 }))).toBe('RULES_MALFORMED');
    expect(code(RULES({ fileContextMaxDepth: null }))).toBe('OK');
  });
});
