import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ONBOARDING_SCENARIO_QUESTIONS } from '@companion/platform-contracts';

const webRoot = fileURLToPath(new URL('../', import.meta.url)), temporaryRoot = path.join(webRoot, '.local');
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(path.join(temporaryRoot, 'student-entry-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { default as AuthView } from './src/AuthView'; export { default as AccountConsentView, ConsentCheckbox } from './src/AccountConsentView'; export { default as StudentOnboarding, OnboardingAnsweredHistory } from './src/StudentOnboarding'; export { AccountGate } from './src/AccountActionView'; export { PlatformAccountClientProvider } from './src/account-client'; export { default as LegalDocumentPage, LegalDocumentContent } from './src/LegalDocumentPage'; export { default as App } from './src/App';", resolveDir: webRoot, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'fictional@example.invalid', name: 'Fictional student', emailVerified: true };
const options = { emailActionsEnabled: false, requireVerifiedEmail: false, requireInvite: true, legal: { status: 'unavailable' } };

test('actual registration has an unchecked disabled agreement and disabled continue when legal text is unavailable', () => {
  const html = renderToStaticMarkup(createElement(views.AuthView, { onUser() {}, options }));
  assert.match(html, /先建一个账号，你的求职小组马上就到/);
  assert.match(html, /邀请码/); assert.match(html, /minlength="10"/i);
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]; assert.ok(checkbox); assert.match(checkbox, /disabled/); assert.doesNotMatch(checkbox, /\schecked=/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/); assert.match(html, /尚未开放/);
  assert.doesNotMatch(html, /创建工作台|一个想法，无限可能|身份日期加密保存|法务已审/);
});

test('login and password recovery remain available before legal approval, while old-account consent stays unchecked', () => {
  const login = renderToStaticMarkup(createElement(views.AuthView, { onUser() {}, options, initialLogin: true }));
  assert.match(login, /忘记密码/); assert.match(login, /<button[^>]*type="submit">登录/); assert.doesNotMatch(login, /type="checkbox"/);
  const html = renderToStaticMarkup(createElement(views.ConsentCheckbox, { checked: false, onChange() {} }));
  assert.match(html, /href="\/privacy"/); assert.match(html, /href="\/terms"/); assert.doesNotMatch(html, /\schecked=/);
});

test('public legal pages select the public component directly with no authenticated bootstrap', () => {
  const previousWindow = globalThis.window;
  try {
    for (const [pathname, page] of [['/terms', 'terms'], ['/privacy', 'privacy']]) {
      Object.assign(globalThis, { window: { location: { pathname } } });
      const element = views.App(); assert.equal(element.type, views.LegalDocumentPage); assert.equal(element.props.page, page);
    }
  } finally { if (previousWindow === undefined) delete (globalThis as any).window; else globalThis.window = previousWindow; }
});

test('public legal rendering preserves supplied text and reports unavailable instead of fabricating policy', () => {
  const documents = { status: 'available', version: 'fictional-v1', digest: 'a'.repeat(64), terms: { title: 'Fictional terms', body: 'Fictional text <script>unsafe()</script>\n原样文本。' }, privacy: { title: 'Fictional privacy', body: 'Fictional privacy text.' }, dataNotice: 'Fictional data notice.' };
  const html = renderToStaticMarkup(createElement(views.LegalDocumentContent, { page: 'terms', documents }));
  assert.match(html, /Fictional terms/); assert.match(html, /fictional-v1/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  const unavailable = renderToStaticMarkup(createElement(views.LegalDocumentContent, { page: 'privacy', documents: { status: 'unavailable' } }));
  assert.match(unavailable, /尚未开放/); assert.doesNotMatch(unavailable, /fictional-v1|Fictional privacy text/);
});

test('actual initial onboarding identifies the unnamed AI and waits for real persisted entry before showing questions, input or resources', () => {
  let requests = 0;
  const client = { account: { accountId: user.id, generation: 1 }, isCurrent: () => true, subscribe: () => () => {},
    request() { requests++; throw new Error('A server-rendered initial boundary cannot fetch private progress.'); } };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: client }, createElement(views.StudentOnboarding, { user, onLogout() {} })));
  assert.match(html, /你的主理人 · 还没有名字/); assert.match(html, /class="onboarding-ai">AI</); assert.match(html, /aria-label="初见对话"/); assert.match(html, /重新读取进度/);
  assert.equal(requests, 0);
  assert.doesNotMatch(html, /<textarea|<form|type="file"|class="sidebar|class="topbar|发送消息|创作工作室|终端工作区|浏览器 Agent/);
  assert.doesNotMatch(html, /花 3 分钟认识一下|赶时间，先开始|当前问题|求助资源|我收到了这些支持资源|已经保存好了|诞生|第一封信/);
});

test('actual onboarding requires the provided account capture and cannot render private entry for an invalidated capture', () => {
  assert.throws(() => renderToStaticMarkup(createElement(views.StudentOnboarding, { user, onLogout() {} })), /账号请求上下文/);
  const staleClient = { account: { accountId: user.id, generation: 1 }, isCurrent: () => false, subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: staleClient }, createElement(views.StudentOnboarding, { user, onLogout() {} })));
  assert.equal(html, '');
});
test('actual answer history keeps each saved answer collapsed and expands its question without input, raw-text references or memory claims', () => {
  const summaries = [
    { questionId: 'study', prompt: 'Fictional study question?', label: 'CS · 两年', appliedRevision: 2, kind: 'answered' },
    { questionId: 'graduation', prompt: 'Fictional graduation question?', label: '已跳过', appliedRevision: 3, kind: 'skipped', reason: 'user' },
    { questionId: 'extra', prompt: 'Fictional extra question?', label: '补充已提交', appliedRevision: 15, kind: 'answered' },
  ];
  const html = renderToStaticMarkup(createElement(views.OnboardingAnsweredHistory, { summaries }));
  assert.match(html, /aria-label="之前的回答"/); assert.equal((html.match(/<details/g) || []).length, 3);
  assert.equal((html.match(/<summary>/g) || []).length, 3); assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.match(html, /<summary>CS · 两年<\/summary>/); assert.match(html, /Fictional study question/); assert.match(html, /你选择跳过了这一问/);
  assert.doesNotMatch(html, /<textarea|<input|<form|textId|长期记忆|已经记住|执行权限/);
  assert.equal(renderToStaticMarkup(createElement(views.OnboardingAnsweredHistory, { summaries: [] })), '');
});
test('actual fast-track history omits the eight unasked O3/O4 questions while preserving asked O2 answers and explicit skips', () => {
  const basics = [
    { questionId: 'study', prompt: 'Fictional asked study question?', label: 'CS · 两年', appliedRevision: 2, kind: 'answered' },
    { questionId: 'graduation', prompt: 'Fictional asked graduation question?', label: '已跳过', appliedRevision: 3, kind: 'skipped', reason: 'user' },
  ];
  const unasked = [...ONBOARDING_SCENARIO_QUESTIONS, 'extra'].map(questionId => ({ questionId, prompt: `Fictional unasked ${questionId} question?`,
    label: questionId === 'extra' ? '补充已跳过' : '快速通道，未作答', appliedRevision: 7, kind: 'skipped', reason: 'fast_track' }));
  const summaries = [...basics, ...unasked], before = JSON.stringify(summaries);
  const html = renderToStaticMarkup(createElement(views.OnboardingAnsweredHistory, { summaries }));
  assert.equal((html.match(/<details/g) || []).length, 2); assert.match(html, /CS · 两年/); assert.match(html, /Fictional asked graduation/);
  assert.match(html, /你选择跳过了这一问/); assert.doesNotMatch(html, /Fictional unasked|快速通道|补充已跳过/);
  assert.equal(JSON.stringify(summaries), before); assert.equal(unasked.length, 8);
  assert.equal(renderToStaticMarkup(createElement(views.OnboardingAnsweredHistory, { summaries: unasked })), '');
  const remaining = { questionId: 'Q1', prompt: 'Fictional explicitly skipped scenario?', label: '已跳过剩余情境题', appliedRevision: 8, kind: 'skipped', reason: 'remaining' };
  const standard = renderToStaticMarkup(createElement(views.OnboardingAnsweredHistory, { summaries: [remaining] }));
  assert.match(standard, /Fictional explicitly skipped scenario/); assert.match(standard, /你选择跳过剩下的情境题/);
});

test('the preserved mailbox gate describes account verification without promising private workspace access', () => {
  const client = { isCurrent: () => true, subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: client }, createElement(views.AccountGate, { user: { ...user, emailVerified: false }, options, onVerified() {}, onLogout() {} })));
  assert.match(html, /验证邮箱，继续你的求职旅程/); assert.match(html, /退出并切换账号/); assert.doesNotMatch(html, /工作台|会话、作品与个人任务/);
});
