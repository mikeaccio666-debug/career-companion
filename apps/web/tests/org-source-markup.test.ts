import { fictionalMethodDetails } from './fixtures/org-method.ts';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const webRoot = fileURLToPath(new URL('../', import.meta.url)); await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'source-markup-test-')); await chmod(directory, 0o700);
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { OrgSourceScene, OrgSourcePage, OrgSourceLabel } from './src/org-source-view'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href), id = '11111111-1111-4111-8111-111111111111';
const passage = { sourceId: id, revision: 2, passageId: '2:0', title: 'Fictional method', text: '<script>alert("fictional")</script>\nUntrusted words.',
  updatedAt: '2026-10-08T00:00:00.000Z', scope: 'org', assetClass: 'method_card', provenanceLabel: '蔓藤方法 · v7', provenance: 'untrusted_knowledge',
  deidentified: true, older: false, brand: '蔓藤', assetRevision: 7 };
test('actual scene renders server method version, collection month and literal escaped excerpt without provider or account metadata', () => {
  const html = renderToStaticMarkup(createElement(views.OrgSourceScene, { snapshot: { state: 'ready', passage }, onRetry() {} }));
  assert.match(html, /蔓藤方法 · v7/); assert.match(html, /收录于/); assert.match(html, /2026-10<\/time>/);
  assert.match(html, /&lt;script&gt;/); assert(!html.includes('<script>')); assert.match(html, /这里只展示本次引用的段落/);
  assert(!html.includes(id)); assert(!html.includes('untrusted_knowledge')); assert(!html.includes('author_id')); assert(!html.includes('provider'));
});
test('revoked, stale, loading and missing states never retain ready content or a source label', () => {
  for (const state of ['denied', 'stale', 'loading', 'missing', 'unavailable', 'account_inactive']) {
    const html = renderToStaticMarkup(createElement(views.OrgSourceScene, { snapshot: { state, passage }, onRetry() {} }));
    assert(!html.includes('Fictional method')); assert(!html.includes('Untrusted words')); assert(!html.includes('蔓藤方法'));
    assert.match(html, /role="status"/); if (state === 'loading') assert.match(html, /aria-busy="true"/);
  }
});
test('source label uses exact local reference and server label; malformed data cannot fabricate a branded source', () => {
  const html = renderToStaticMarkup(createElement(views.OrgSourceLabel, { passage }));
  assert.match(html, new RegExp('href="/sources/org/' + id + '/2/2%3A0"')); assert.match(html, /查看出处：蔓藤方法 · v7/);
  assert.throws(() => renderToStaticMarkup(createElement(views.OrgSourceLabel, { passage: { ...passage, provenanceLabel: '蔓藤面经' } })));
});
test('mounted page has visible AI identity and malformed-route recovery without invented content', () => {
  const html = renderToStaticMarkup(createElement(views.OrgSourcePage, { reference: null, onLogout() {} }));
  assert.match(html, /career-surface/); assert.match(html, /AI 主理人和队伍/); assert.match(html, /出处地址不完整/); assert.match(html, /回到对话/); assert(!html.includes('蔓藤题库'));
});

test('historical method version keeps the exact citation and explains that existing plans do not upgrade', () => {
  const html = renderToStaticMarkup(createElement(views.OrgSourceScene, { snapshot: { state: 'ready', passage: { ...passage, older: true } }, onRetry() {} }));
  assert.match(html, /蔓藤方法 · v7/); assert.match(html, /历史方法版本/); assert.match(html, /不会自动更新已有计划/);
  const current = renderToStaticMarkup(createElement(views.OrgSourceScene, { snapshot: { state: 'ready', passage }, onRetry() {} }));
  assert(!current.includes('历史方法版本'));
});

test('expanded method shows conditions, numbered steps, outputs and counterexamples as escaped text', () => {
  const method = fictionalMethodDetails(), { content: _content, ...header } = method;
  method.content.steps[0].method = '<script>fictional()</script>\n核对自己的贡献。';
  const html = renderToStaticMarkup(createElement(views.OrgSourceScene, {
    snapshot: { state: 'ready', passage: { ...header, text: '虚构摘录。' }, details: { state: 'ready', method } },
    onRetry() {}, onExpandMethod() {}, onCollapseMethod() {},
  }));
  for (const text of ['适用条件与完整方法', '数据／业务分析', '课程项目', '项目事实', '怎么做', '这一步的产出', '哪些情况不适用', '团队成果不能全部说成个人贡献', '真人帮助'])
    assert(html.includes(text), text);
  assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'));
  assert(html.includes('aria-expanded="true"')); assert(html.includes('收起完整方法'));
  assert(!html.includes('author_id')); assert(!html.includes('allowed_tools'));
});
test('closed, loading and full-permission-limited scenes never render retained full content', () => {
  const method = fictionalMethodDetails(), { content: _content, ...header } = method;
  for (const state of ['closed', 'loading', 'limited', 'unavailable']) {
    const html = renderToStaticMarkup(createElement(views.OrgSourceScene, {
      snapshot: { state: 'ready', passage: { ...header, text: '虚构摘录。' }, details: { state, method } },
      onRetry() {}, onExpandMethod() {}, onCollapseMethod() {},
    }));
    assert(!html.includes('核对一个真实判断')); assert(!html.includes('团队成果不能全部说成个人贡献'));
    if (state === 'limited') assert(html.includes('完整方法尚未授权展示'));
    if (state === 'closed') assert.match(html, /id="career-method-content" hidden=""/);
  }
});
