import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'companion-naming-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { CompanionNameView, CompanionSealView } from './src/companion-naming-view';", resolveDir: webRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs');
await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const candidates = [{ char: '墨', reason: '你起的名字' }, { char: '稳', reason: '它说话的样子' }, { char: '启', reason: '你现在的阶段' }];
const nameMarkup = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(views.CompanionNameView, { value: '', onChange() {}, onSubmit() {}, ...props }));
const sealMarkup = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(views.CompanionSealView,
  { name: 'Fictional Juno', candidates, inkToken: 'dai', selectedChar: null, onChange() {}, onConfirm() {}, ...props }));

test('O7 keeps the complete controlled text, including rejected-length input, for server classification', () => {
  const raw = '  Fictional very long name <script>not executable</script>  ';
  const html = nameMarkup({ value: raw });
  assert.match(html, /value="  Fictional very long name &lt;script&gt;not executable&lt;\/script&gt;  "/);
  assert.doesNotMatch(html, /maxLength|maxlength|pattern=|<script|data-ink|已保存|已起名|诞生/);
  assert.match(html, /你的主理人 · AI/);
  assert.match(html, /companion-naming-seal-empty" aria-hidden="true"/);
  assert.match(html, /<label[^>]*for="[^"]+-name"/);
  assert.match(html, /<input[^>]*id="[^"]+-name"[^>]*aria-describedby="[^"]+-hint"/);
});

test('server rejection categories have actionable copy and same-name copy uses the actual escaped label', () => {
  const cases = [
    ['family_or_partner', '不是家人，也不是伴侣'],
    ['team_or_org', '队员或真实机构混淆'],
    ['abusive', '这个名字不太合适'],
    ['public_figure', '不能扮演真实的人'],
    ['length', '最多 6 个汉字或 16 个字母'],
  ];
  for (const [category, expected] of cases) {
    const html = nameMarkup({ value: 'Fictional input', issue: { category } });
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(expected));
    assert.match(html, /aria-describedby="[^"]+-hint [^"]+-error"/);
  }
  const same = nameMarkup({ issue: { category: 'same_as_user', userName: 'Fictional <label>' } });
  assert.match(same, /对话里会有两个『Fictional &lt;label&gt;』/);
  assert.doesNotMatch(same, /一然|<label>』/);
  assert.match(nameMarkup({ issue: { category: 'same_as_user' } }), /和你的称呼一样/);
});

test('pending and unavailable states keep controls focusable without reporting persisted success', () => {
  for (const props of [{ pending: true }, { available: false }, { value: '' }]) {
    const html = nameMarkup({ value: 'Fictional', ...props });
    assert.match(html, /<button[^>]*aria-disabled="true"/);
    assert.doesNotMatch(html, /<button[^>]*\sdisabled(?:=|\s|>)|已保存|诞生|保存成功/);
    if ('pending' in props || 'available' in props) assert.match(html, /<input[^>]*readonly=""/i);
  }
  assert.match(nameMarkup({ value: 'Fictional', pending: true }), /aria-busy="true"/);
  assert.match(nameMarkup({ available: false }), /服务暂时不可用/);
  assert.match(nameMarkup({ error: 'Fictional network error <unsafe>' }), /Fictional network error &lt;unsafe&gt;/);
});

test('O8 presents exactly the supplied candidates, their reasons and real ink without auto-selecting the first', () => {
  const html = sealMarkup();
  assert.equal((html.match(/type="radio"/g) || []).length, 3);
  assert.equal((html.match(/data-ink="dai"/g) || []).length, 3);
  assert.equal((html.match(/ checked=""/g) || []).length, 0);
  for (const candidate of candidates) assert.ok(html.includes(candidate.reason));
  assert.match(html, /<fieldset[^>]*aria-describedby="[^"]+-hint"/);
  assert.match(html, /<legend[^>]*>印章字<\/legend>/);
  assert.match(html, /<button[^>]*aria-disabled="true"/);
  assert.doesNotMatch(html, /<select|type="text"|诞生|已刻章|保存成功|lease|operationId|taskId/);
});

test('O8 accepts only an explicitly supplied current candidate and discards a stale selection visually', () => {
  const chosen = sealMarkup({ selectedChar: '稳' });
  assert.equal((chosen.match(/ checked=""/g) || []).length, 1);
  assert.match(chosen, /<input[^>]*checked=""[^>]*value="稳"/);
  assert.match(chosen, /<button[^>]*aria-disabled="false"/);
  const stale = sealMarkup({ selectedChar: '舟' });
  assert.equal((stale.match(/ checked=""/g) || []).length, 0);
  assert.match(stale, /<button[^>]*aria-disabled="true"/);
  assert.match(sealMarkup({ selectedChar: '稳', pending: true }), /aria-busy="true"/);
  assert.match(sealMarkup({ selectedChar: '稳', available: false }), /服务暂时不可用/);
});

test('server-provided display strings stay inert and a local candidate click is never described as a completed birth', () => {
  const html = sealMarkup({ name: 'Fictional <script>', candidates: [{ char: '墨', reason: '<img src=x onerror=alert(1)>' }, ...candidates.slice(1)], error: 'Fictional <b>failure</b>' });
  assert.match(html, /Fictional &lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Fictional &lt;b&gt;failure&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>failure|诞生|系统事件|恭喜/);
});
