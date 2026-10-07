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
const directory = await mkdtemp(path.join(temporaryRoot, 'student-entry-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { default as AuthView } from './src/AuthView'; export { default as AccountConsentView, ConsentCheckbox, StudentWelcome } from './src/AccountConsentView'; export { AccountGate } from './src/AccountActionView'; export { PlatformAccountClientProvider } from './src/account-client'; export { default as LegalDocumentPage, LegalDocumentContent } from './src/LegalDocumentPage'; export { default as App } from './src/App';", resolveDir: webRoot, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
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

test('actual O0 welcome states the remaining work and provides no workspace navigation or model input', () => {
  const html = renderToStaticMarkup(createElement(views.StudentWelcome, { user, onLogout() {} }));
  assert.match(html, /账号和协议确认已完成/); assert.match(html, /初见流程尚未开放/);
  assert.doesNotMatch(html, /<textarea|type="file"|class="sidebar|class="topbar|发送消息|创作工作室|终端工作区|浏览器 Agent/);
});

test('the preserved mailbox gate describes account verification without promising private workspace access', () => {
  const client = { isCurrent: () => true, subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: client }, createElement(views.AccountGate, { user: { ...user, emailVerified: false }, options, onVerified() {}, onLogout() {} })));
  assert.match(html, /验证邮箱，继续你的求职旅程/); assert.match(html, /退出并切换账号/); assert.doesNotMatch(html, /工作台|会话、作品与个人任务/);
});
