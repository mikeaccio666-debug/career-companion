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
const directory = await mkdtemp(path.join(webRoot, '.local', 'identity-markup-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { CareerIdentityScene, CareerIdentityPage } from './src/career-identity-view'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs');
await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const owner = '11111111-1111-1111-1111-111111111111', id = '22222222-2222-2222-2222-222222222222', at = '2026-10-08T10:00:00.000Z';
const record = (patch: object = {}) => ({ id, ownerId: owner, field: 'program_end_date', value: '2028-02-29', label: null, source: 'user_entered', sensitivity: 'sensitive', confirmedAt: at, remindBeforeDays: null, revision: 1, createdAt: at, updatedAt: at, lastOperationId: '33333333-3333-3333-3333-333333333333', ...patch });
const state = (patch: object = {}) => ({ entry: { kind: 'available', ownerId: owner, stage: 'opt', source: { draftId: id, revision: 10 } }, records: [], busy: false, uncertain: false, pending: null, error: '', lastResult: null, ...patch });
const editor = (patch: object = {}) => ({ record: null, field: '', text: '', booleanChoice: '', year: '', outcome: '', label: '', ...patch });
const props = (patch: object = {}) => ({ state: state(), editor: null, setEditor() { }, deleting: null, setDeleting() { }, inputError: '', setInputError() { }, controller: { refresh() { }, observe() { }, retry() { }, begin() { } }, ...patch });
const markup = (patch: object = {}) => renderToStaticMarkup(createElement(views.CareerIdentityScene, props(patch)));
test('declined/skipped/unproven entry renders no identity clock, values, prompts, recording button or footer even with supplied private records', () => {
    const html = markup({ state: state({ entry: { kind: 'hidden', ownerId: owner }, records: [record()] }) });
    for (const text of ['身份时钟', '2028-02-29', '记录一项', '没有保存记录', '法律意见', '<form'])
        assert.equal(html.includes(text), false);
    const loading = markup({ state: null });
    assert(!loading.includes('记录一项'));
    assert(!loading.includes('身份时钟'));
});
test('owned records display the literal calendar day and fixed footer, not a legal countdown or progress chart', () => {
    const html = markup({ state: state({ records: [record()] }) });
    assert.match(html, /2028-02-29/);
    assert.match(html, /只在网页显示/);
    assert.match(html, /信息与提醒，不是法律意见/);
    assert.match(html, /学校 DSO 或移民律师/);
    for (const text of ['倒数', '还剩', '超限', '还有资格', '<progress', '设置提醒', '开启提醒'])
        assert(!html.includes(text));
});
test('a new boolean or count editor does not preselect an answer or silently fill zero; unknown H1B outcome is a deliberate choice', () => {
    const bool = markup({ editor: editor({ field: 'employment_reported' }) });
    assert.match(bool, /<option value="" selected="">/);
    assert(!/value="(?:true|false)" selected/.test(bool));
    const count = markup({ editor: editor({ field: 'unemployment_days_reported' }) });
    assert.match(count, /<input[^>]*inputMode="numeric"[^>]*value=""/);
    assert(!count.includes('value="0"'));
    const h1b = markup({ editor: editor({ field: 'h1b_registration' }) });
    assert(!h1b.includes('value="2026"'));
    assert(!/value="unknown" selected/.test(h1b));
});
test('self-reported unemployment count is folded until explicitly opened and escaped owner text cannot become active markup', () => {
    const a = markup({ state: state({ records: [record({ field: 'unemployment_days_reported', sensitivity: 'restricted', value: { days: 0, reportedAt: at } })] }) });
    assert.match(a, /<details>/);
    assert(!/<details[^>]*open/.test(a));
    assert.match(a, /2026-10-08 记的：0 天/);
    const b = markup({ state: state({ records: [record({ field: 'custom_status_date', sensitivity: 'restricted', label: '<img src=x onerror=alert(1)>', value: '2027-01-01' })] }) });
    assert(!b.includes('<img'));
    assert(b.includes('&lt;img'));
});
test('uncertain writes keep editing locked and offer only explicit original-operation observation/retry', () => {
    const html = markup({ state: state({ uncertain: true, pending: { action: 'create', id: null, body: {} }, error: '还在确认，先别关页面。' }), editor: editor({ field: 'program_end_date', text: '2028-02-29' }) });
    assert.match(html, /核对这次操作/);
    assert.match(html, /用原操作重试/);
    assert.match(html, /还在确认，先别关页面/);
    assert.match(html, /<button type="submit" disabled="">确认并保存/);
});
test('personal profile shell carries the actual AI disclosure and a stale captured account produces no private scene', () => {
    const current = { account: { accountId: owner, generation: 1 }, isCurrent: () => true, subscribe: () => () => { }, request() { throw Error('SSR must never read private services'); } };
    const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: current }, createElement(views.CareerIdentityPage, { onLogout() { } })));
    assert.match(html, /AI 主理人和队伍/);
    assert(!html.includes('记录一项'));
    const stale = { ...current, isCurrent: () => false };
    const out = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: stale }, createElement(views.CareerIdentityPage, { onLogout() { } })));
    assert(!out.includes('身份时钟'));
    assert(!out.includes('2028-02-29'));
});
