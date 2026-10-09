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
const directory = await mkdtemp(path.join(webRoot, '.local', 'application-markup-test-')); await chmod(directory, 0o700);
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { CareerApplicationPage } from './src/career-application-view'; export { ApplicationBoard } from './src/application-board'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const id = '22222222-2222-2222-2222-222222222222';
const client = (current = true) => ({ account: { accountId: id, generation: 1 }, isCurrent: () => current, subscribe: () => () => {}, request() { throw Error('SSR must not read private data'); } });
const markup = (props: object, current = true) => renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: client(current) }, createElement(views.CareerApplicationPage, { onLogout() {}, ...props })));
test('detail route begins without a fabricated empty board or create action', () => {
  const html = markup({ initialApplicationId: id });
  assert.match(html, /这份投递记录/); assert.match(html, /重新读取这份记录/);
  for (const text of ['从收藏建立记录', '还没有申请记录', 'application-board', '这条内容不存在或已经处理', '确认改阶段', '保存备注']) assert(!html.includes(text));
});
test('invalid route renders neutral missing state without loading another record', () => {
  const html = markup({ invalidLink: true });
  assert.match(html, /这条内容不存在或已经处理/);
  assert(!html.includes('从收藏建立记录')); assert(!html.includes('重新读取这份记录'));
});
test('expired account renders neither private editing controls nor the application shell', () => {
  assert.equal(markup({ initialApplicationId: id }, false), '');
});

test('shared journey board preserves neutral closure, real detail links and the recorded deadline zone', () => {
  const oldZone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    const row = { id, stage: 'closed', closedReason: 'withdrawn', offerState: null, submittedVia: null,
      job: { employer: 'Fictional employer', title: 'Fictional role', location: 'New York', deadlineAt: '2026-11-01T05:30:00.000Z', deadlineTimeZone: 'America/New_York' } };
    const html = renderToStaticMarkup(createElement(views.ApplicationBoard, { rows: [row] }));
    assert.match(html, /closed-folded/); assert.match(html, /aria-expanded="false"/);
    assert.match(html, /我决定不继续/); assert.doesNotMatch(html, /Rejected|拒信数量/);
    assert.match(html, /2026-11-01 01:30 · America\/New_York · UTC-04:00/);
    assert.match(html, new RegExp('href="/journey/applications/' + id + '"'));
    assert.match(html, /你贴的 JD · 没核实是否还开放/);
    assert.doesNotMatch(html, /已结束[^<]*1|已投递成功|材料包已准备/);
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
});
