import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const webRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'interview-markup-test-')); await chmod(directory, 0o700);
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { CareerInterviewScene, CareerInterviewPage } from './src/career-interview-view'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const owner = '11111111-1111-1111-1111-111111111111', id = '22222222-2222-2222-2222-222222222222', at = '2026-10-08T10:00:00.000Z';
const record = (patch: object = {}) => ({ id, ownerId: owner, revision: 1, lastOperationId: '33333333-3333-3333-3333-333333333333', createdAt: at, updatedAt: at,
  source: 'user_recorded', application: { id, ownerId: owner, revision: 1, employer: 'Fictional Company', title: 'Fictional Analyst', roleFamily: 'da' },
  roundType: 'sql', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 60, status: 'scheduled', briefId: null, debrief: null, ...patch });
const state = (patch: object = {}) => ({ records: [], nextAfter: null, detail: null, detailMissing: false, applications: [], applicationNext: null,
  applicationsReady: true, loaded: true, busy: false, pending: null, uncertain: false, needsRefresh: false, error: '', sourceError: '', lastResult: null, ...patch });
const editor = (patch: object = {}) => ({ kind: 'create', record: null, applicationId: '', roundType: '', duration: '', localTime: '', timeZone: '', selectedInstant: '', confirmed: false, ...patch });
const props = (patch: object = {}) => ({ state: state(), editor: null, setEditor() {}, decision: null, setDecision() {}, inputError: '', setInputError() {},
  viewerZone: 'America/Los_Angeles', setViewerZone() {}, controller: { refresh() {}, loadMore() {}, loadApplications() {}, begin() {}, observe() {}, retry() {} }, ...patch });
const markup = (patch: object = {}) => renderToStaticMarkup(createElement(views.CareerInterviewScene, props(patch)));
test('new form has no invented application, round, time, zone, duration or pre-checked confirmation', () => {
  const html = markup({ editor: editor() });
  assert.match(html, /<option value="" selected="">请选择你自己的投递记录/);
  assert.match(html, /<option value="" selected="">请按邀请选择/);
  assert.match(html, /type="datetime-local"[^>]*value=""/);
  assert.match(html, /面试时区（必须明确选择）/); assert.match(html, /还没有投递记录/);
  assert(!/type="checkbox"[^>]*checked/.test(html));
  assert(!html.includes('value="45"')); assert.match(html, /<button type="submit" disabled="">确认并保存/);
});
test('owned rows show both named zones with distinct offsets, source and neutral cancellation; text stays escaped', () => {
  const html = markup({ state: state({ records: [record({ revision: 2, updatedAt: '2026-10-08T11:00:00.000Z', status: 'cancelled',
    application: { ...record().application, employer: '<img src=x onerror=alert(1)>' } })] }) });
  assert.match(html, /America\/New_York · UTC-04:00/); assert.match(html, /America\/Los_Angeles · UTC-07:00/);
  assert.match(html, /2026-10-31 22:30 ·/); assert.match(html, /已取消/); assert.match(html, /创建时的投递记录/);
  assert.match(html, /\/journey\/interviews\/22222222/);
  for (const text of ['<img', '通过率', '<progress', '打开作战简报', '开始练习', '已发送提醒']) assert(!html.includes(text));
});
test('ambiguous local time presents two unselected radio choices; a gap has no savable instant', () => {
  const overlap = markup({ editor: editor({ localTime: '2026-11-01T01:30', timeZone: 'America/New_York' }) });
  assert.equal((overlap.match(/type="radio"/g) ?? []).length, 2);
  assert(!/type="radio"[^>]*checked/.test(overlap)); assert.match(overlap, /UTC-04:00/); assert.match(overlap, /UTC-05:00/);
  assert.match(overlap, /这个时间出现了两次/); assert.match(overlap, /<button type="submit" disabled="">/);
  const gap = markup({ editor: editor({ localTime: '2026-03-08T02:30', timeZone: 'America/New_York', confirmed: true }) });
  assert.match(gap, /跳过了这一时刻/); assert(!gap.includes('保存的 UTC：')); assert.match(gap, /<button type="submit" disabled="">/);
});
test('uncertain operations keep forms locked and offer only explicit original-operation reconciliation', () => {
  const html = markup({ state: state({ pending: { action: 'create', id: null, body: {} }, uncertain: true, error: '还在确认，先别关页面。' }),
    editor: editor({ localTime: '2026-10-08T12:00', timeZone: 'UTC', confirmed: true }) });
  assert.match(html, /核对这次操作/); assert.match(html, /用原操作重试/); assert.match(html, /先别关页面/);
  assert.match(html, /type="datetime-local"[^>]*disabled/); assert.match(html, /<button type="submit" disabled="">/);
});
test('actual missing detail uses the common neutral wording; deleting/status changes require an explicit decision scene', () => {
  const missing = markup({ initialInterviewId: id, state: state({ detailMissing: true }) });
  assert.match(missing, /这条内容不存在或已经处理/); assert(!missing.includes('你还没有记下面试'));
  const html = markup({ decision: { kind: 'delete', record: record() } });
  assert.match(html, /aria-label="确认面试操作"/); assert.match(html, /删除这条记录？/); assert.match(html, /确认删除/); assert.match(html, /先保留/);
});
test('stale editor cannot save and offers an explicit latest-version restart; a record outside the first page still renders detail', () => {
  const latest = record({ revision: 2, updatedAt: '2026-10-08T11:00:00.000Z' });
  const html = markup({ state: state({ records: [latest] }), editor: editor({ kind: 'edit', record: record(), roundType: 'sql', duration: '60', confirmed: true }) });
  assert.match(html, /用最新记录重新开始/); assert.match(html, /<button type="submit" disabled="">/);
  const detail = markup({ initialInterviewId: id, state: state({ detail: latest, records: [] }) });
  assert.match(detail, /Fictional Company/); assert(!detail.includes('你还没有记下面试'));
});
test('shell identifies AI; a stale captured account cannot render private rows or recording controls and SSR never fetches data', () => {
  const current = { account: { accountId: owner, generation: 1 }, isCurrent: () => true, subscribe: () => () => {},
    request() { throw Error('Fictional SSR does not request private services'); } };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: current }, createElement(views.CareerInterviewPage, { onLogout() {} })));
  assert.match(html, /AI 主理人和队伍/); assert(!html.includes('记一场面试'));
  const stale = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: { ...current, isCurrent: () => false } }, createElement(views.CareerInterviewPage, { onLogout() {} })));
  assert(!stale.includes('interview-panel')); assert(!stale.includes('记一场面试'));
});
