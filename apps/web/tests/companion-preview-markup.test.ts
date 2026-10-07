import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const webRoot = fileURLToPath(new URL('../', import.meta.url)), temporaryRoot = path.join(webRoot, '.local');
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(path.join(temporaryRoot, 'companion-preview-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { default as StudentCompanionPreview, CompanionPreviewContent } from './src/StudentCompanionPreview'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const preview = { companionId: '11000000-0000-4000-8000-000000000003', taskId: '11000000-0000-4000-8000-000000000004', revision: 1,
  generatedBy: 'model', summary: 'Fictional warm and clear style.', samples: ['Fictional first sample.', 'Fictional second sample.', '<script>Fictional inert text</script>'], inkToken: 'dai' };
function markup(entry: unknown, checking = false, error = '') {
  return renderToStaticMarkup(createElement(views.CompanionPreviewContent, { observation: { entry, checking, error }, refresh() {} }));
}

test('the saved O6 preview renders its original summary and exactly three examples with AI identity and an empty real ink seal', () => {
  const html = markup({ kind: 'preview', preview });
  assert.match(html, /这是会陪你走完这段路的主理人/); assert.match(html, /AI · 性格预览/); assert.match(html, /Fictional warm and clear style/);
  assert.match(html, /data-ink="dai" aria-hidden="true"/); assert.equal((html.match(/companion-preview-seal"/g) || []).length, 1);
  assert.match(html, /aria-label="说话方式示例"/); assert.equal((html.match(/Fictional (first|second) sample/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;Fictional inert text&lt;\/script&gt;/); assert.doesNotMatch(html, /<script|11000000|leaseToken|styleCard|dimensions|诞生|<textarea|<input/);
  assert.match(html, /起名、换一种感觉和刻章暂时还没有开放/);
  assert.equal((html.match(/<button/g) || []).length, 1); assert.match(html, />重新读取生成进度<\/button>/);
  assert.doesNotMatch(html, /根据你的回答，用规则生成/);
});

test('actual fallback provenance stays visible and is not disguised as a model-generated reply', () => {
  const html = markup({ kind: 'preview', preview: { ...preview, generatedBy: 'fallback' } });
  assert.match(html, /根据你的回答，用规则生成/); assert.match(html, /AI · 性格预览/); assert.match(html, /Fictional first sample/);
  assert.equal((html.match(/<button/g) || []).length, 1); assert.doesNotMatch(html, /试听|已起名|已刻章|它诞生了/);
});

test('pending distinguishes saved acceptance from actual generation and all execution failures offer only a read', () => {
  const task = { kind: 'generation', taskId: preview.taskId, companionId: preview.companionId, generation: 1, hold: null };
  const pending = markup({ ...task, generation: 0, status: 'pending' });
  assert.match(pending, /任务已保存，等待生成/); assert.match(pending, /离开页面不会取消已保存的任务/); assert.doesNotMatch(pending, /正在生成……|%|调用成功/);
  assert.match(markup({ ...task, status: 'running' }), /正在生成……/);
  for (const [status, message] of [['failed', '生成没成功，不是你的问题'], ['interrupted', '生成中断了'], ['uncertain', '结果还在核实']]) {
    const html = markup({ ...task, status }); assert.match(html, new RegExp(message));
    assert.equal((html.match(/<button/g) || []).length, 1); assert.match(html, />重新读取生成进度<\/button>/);
    assert.doesNotMatch(html, /companion-preview-seal-generating|再次生成|再试一次|新任务|<input/);
  }
});

test('accepted-request holds show the actual blocked state without a spinner, paid retry or replacement-session action', () => {
  for (const [hold, message] of [['authorization_required', '这项任务的授权已失效'], ['configuration_unavailable', '服务暂时不可用'], ['requires_review', '这项任务暂时需要核实']]) {
    const html = markup({ kind: 'generation', taskId: preview.taskId, companionId: preview.companionId, generation: 0, status: 'pending', hold });
    assert.match(html, new RegExp(message)); assert.match(html, /你的回答已经保存/);
    assert.equal((html.match(/<button/g) || []).length, 1); assert.match(html, />重新读取生成进度<\/button>/);
    assert.doesNotMatch(html, /companion-preview-seal-generating|等待生成|正在生成|再次生成|再试一次|换个账号|重新授权/);
  }
});

test('configuration and observation failures disclose actual availability without fixed preview or success', () => {
  const disabled = markup({ kind: 'not_prepared', intakeRevision: 7, generationAvailable: false });
  assert.match(disabled, /服务暂时不可用/); assert.match(disabled, /你的回答已经保存/); assert.doesNotMatch(disabled, /说话方式示例|性格预览|Fictional|正在生成/);
  const reading = markup(null, true); assert.match(reading, /aria-busy="true"/); assert.match(reading, /<button[^>]*disabled/);
  const failedRead = markup(null, false, 'Fictional observation failure.'); assert.match(failedRead, /role="alert"[^>]*>Fictional observation failure/);
  assert.match(markup({ kind: 'intake_required' }), /请先完成认识你的这几问/);
});

test('an invalidated account hides the entire preview entry before any asynchronous cleanup', () => {
  const stale = { isCurrent: () => false, subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: stale }, createElement(views.StudentCompanionPreview, { intakeRevision: 7 })));
  assert.equal(html, '');
});
