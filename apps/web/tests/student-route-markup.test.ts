import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const webRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'student-route-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const bundle = await build({ stdin: { contents: "export { StudentRoutes } from './src/app/StudentRoutes'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, bundle.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'synthetic@example.invalid', name: 'Synthetic', emailVerified: true };
const route = { kind: 'missing', returnHref: '/pending', returnLabel: '回到待确认' };
let calls = 0;
function markup(current: boolean, accountId = user.id) {
  const client = { account: { accountId, generation: 1 }, isCurrent: () => current,
    subscribe: () => () => {}, request() { calls++; throw Error('No private read expected'); } };
  return renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: client },
    createElement(views.StudentRoutes, { route, user, onLogout() {} })));
}
test('an invalid detail renders a useful accessible destination without chat, private content or network reads', () => {
  const html = markup(true);
  assert.match(html, /<main[^>]*aria-labelledby="student-route-title"/);
  assert.match(html, /这条内容不存在或已经处理/); assert.match(html, /都是 AI/);
  assert.match(html, /href="\/pending">回到待确认/);
  assert.doesNotMatch(html, /synthetic@example|Synthetic|textarea|发送消息/); assert.equal(calls, 0);
});
test('expired and mismatched account captures render nothing, even for the fallback page', () => {
  assert.equal(markup(false), ''); assert.equal(markup(true, '20000000-0000-4000-8000-000000000002'), '');
});
test('App dispatch stays after account, consent and first-letter gates', async () => {
  const app = await readFile(path.join(webRoot, 'src/App.tsx'), 'utf8');
  const dispatch = app.indexOf('const route = studentRoute(window.location.pathname)');
  for (const gate of ['if (!user) return <AuthView', 'if (!accountReady) return <AccountGate', 'if (!consentCurrent) return <AccountConsentView', 'if (!privateAllowed) return <StudentOnboarding']) {
    const index = app.indexOf(gate); assert.ok(index >= 0 && index < dispatch, gate);
  }
  assert.match(app, /<StudentRoutes key=\{`\$\{user.id\}:\$\{requestAccount.generation\}:\$\{window.location.pathname\}`\}/);
});
