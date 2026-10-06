import { afterEach, describe, expect, it } from 'vitest';

import { leverAdapter } from '../src/sites/lever/applyForm';

/**
 * `stopNamePrefix`：厂商声明的命名空间高于标签文案。
 *
 * 这一步之前**一条测试都没有**，而 Lever 的规则正在用它挡一个真实的错映射：
 * `urls[Other]` 的标签文案是「Other website」，会命中下一步 labelPatterns 里的
 * portfolio 模式，于是一条用户随手填的不相干链接被映进作品集字段。
 *
 * Lever 给它认识的每个 url 槽都起了名（`urls[LinkedIn]`、`urls[GitHub]`、
 * `urls[Portfolio]`），所以「名字以 `urls[` 开头但上一步的 attrMap 没认出来」
 * 等价于**这是个真未知**，不该继续往下猜。
 *
 * 没有测试的门等于没有门：把 interpreter 里那三行删掉，在此之前没有任何东西会红。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function scan(html: string) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = leverAdapter.resolveRoot(document);
  expect(root, 'Lever form root not proven').not.toBeNull();
  return leverAdapter.scan(root!);
}

function keyOf(fields: ReturnType<typeof scan>, name: string): string | null {
  const field = fields.find((candidate) => candidate.element.getAttribute('name') === name);
  return field?.key ?? null;
}

describe('stopNamePrefix · 命名空间内的未知不许靠标签猜', () => {
  it('urls[Other] 不会因为标签写着 Other website 就被映成作品集', () => {
    const fields = scan(`
      <label for="other">Other website</label>
      <input id="other" name="urls[Other]" type="url" />`);
    expect(keyOf(fields, 'urls[Other]')).toBeNull();
  });

  it('同一份命名空间里认得的槽照常映射——终止的是未知，不是整个命名空间', () => {
    const fields = scan(`
      <label for="li">LinkedIn URL</label>
      <input id="li" name="urls[linkedin]" type="url" />
      <label for="gh">GitHub URL</label>
      <input id="gh" name="urls[github]" type="url" />`);
    expect(keyOf(fields, 'urls[linkedin]')).toBe('linkedinUrl');
    expect(keyOf(fields, 'urls[github]')).toBe('githubUrl');
  });

  it('命名空间之外的题照常走标签兜底', () => {
    // 逐 posting 的自定义题 cards[<uuid>][fieldN] 没有稳定名字，只能靠标签认。
    const fields = scan(`
      <label for="c1">LinkedIn Profile</label>
      <input id="c1" name="cards[9f3a][field0]" type="url" />`);
    expect(keyOf(fields, 'cards[9f3a][field0]')).toBe('linkedinUrl');
  });

  it('前缀是前缀，不是子串——名字里恰好含 urls[ 的字段不受影响', () => {
    const fields = scan(`
      <label for="x">LinkedIn Profile</label>
      <input id="x" name="cards[a][urls[x]]" type="url" />`);
    expect(keyOf(fields, 'cards[a][urls[x]]')).toBe('linkedinUrl');
  });
});
