import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserAction, ProviderStatus } from '@companion/platform-contracts';
import { browserActionText, browserAgentDraft, browserExecutionPresentation, browserFixtureOrigins, browserPlanJob, browserPlanReadiness, browserUrl, hasBrowserObservation, newBrowserAction, parseBrowserAction, parseBrowserApprovalPlan, parseBrowserTaskOptions, serializeBrowserDraft } from '../src/browser-plan.ts';

const ready: ProviderStatus = { id: 'browser', name: 'Browser', keyConfigured: true, enabled: true, capabilities: ['browser'], models: [], envVariables: [] };
const url = 'https://example.com/public';
const click: BrowserAction = { type: 'click', target: { by: 'role', role: 'link', name: 'Fictional details' } };
const fill: BrowserAction = { type: 'fill', target: { by: 'label', name: 'Fictional search' }, value: '  Fictional first line.\nSecond line.  ' };

test('read-only plans omit empty actions and produce a task needing no model or upload fields', () => {
  const plan = serializeBrowserDraft({ url, prompt: '  Read a fictional public page.  ', actions: [] });
  assert.deepEqual(plan.options, { url });
  assert.deepEqual(browserPlanJob(plan), { kind: 'browser', provider: 'browser', prompt: 'Read a fictional public page.', options: { url } });
  assert.deepEqual(browserPlanReadiness(plan, ready), []);
});

test('browser plans accept only bounded public URLs or server-approved exact local fixture origins', () => {
  assert.equal(browserUrl('https://[2001:4860:4860::8888]/'), 'https://[2001:4860:4860::8888]/');
  for (const blocked of ['http://example.com/', 'https://user:password@example.com/', 'https://127.0.0.1/', 'https://localhost./', 'https://2130706433/', 'https://[::1]/', 'https://[fd12::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/']) assert.throws(() => browserUrl(blocked));
  const provider = { ...ready, browserFixtureOrigins: ['http://127.0.0.1:4671', 'http://localhost:4672', 'https://example.com', 'http://127.0.0.1:4671/path'] };
  assert.deepEqual(browserFixtureOrigins(provider), ['http://127.0.0.1:4671', 'http://localhost:4672']);
  assert.equal(browserUrl('http://127.0.0.1:4671/fixture', browserFixtureOrigins(provider)), 'http://127.0.0.1:4671/fixture');
  assert.throws(() => browserUrl('http://127.0.0.1:4673/fixture', browserFixtureOrigins(provider)));
  assert.deepEqual(browserFixtureOrigins(undefined), []);
  assert.deepEqual(browserFixtureOrigins({ ...ready, browserFixtureOrigins: 'invalid' } as unknown as ProviderStatus), []);
});

test('action schemas reject hidden selectors, unsupported methods and arbitrary extra settings', () => {
  assert.deepEqual(parseBrowserAction(click), click);
  assert.throws(() => parseBrowserAction({ ...click, selector: '#hidden' }), /不支持的字段/);
  assert.throws(() => parseBrowserAction({ type: 'click', target: { by: 'selector', name: '#hidden' } }));
  assert.throws(() => parseBrowserAction({ type: 'click', target: { by: 'role', role: 'link', name: 'Details', exact: false } }), /不支持的字段/);
  assert.throws(() => parseBrowserTaskOptions({ url, headers: { authorization: 'fictional' } }), /不支持的字段/);
  assert.throws(() => parseBrowserAction({ type: 'submit', target: click.target }));
});

test('action-target roles match execution capabilities and target names exclude control characters', () => {
  for (const [type, role] of [['click', 'textbox'], ['fill', 'button'], ['select', 'link']] as const) assert.throws(() => parseBrowserAction({ type, target: { by: 'role', role, name: 'Fictional control' }, ...(type === 'fill' ? { value: 'fixture' } : type === 'select' ? { optionLabel: 'fixture' } : {}) }), /需要选择/);
  assert.throws(() => parseBrowserAction({ type: 'click', target: { by: 'role', role: 'link', name: 'Fictional\nlink' } }), /控制字符/);
  assert.throws(() => parseBrowserAction({ type: 'fill', target: { by: 'label', name: 'Fictional\u0000field' }, value: 'fixture' }), /控制字符/);
});

test('fill values preserve exact whitespace and full review text while bounded action values are enforced', () => {
  assert.deepEqual(parseBrowserAction(fill), fill);
  assert.equal(browserActionText(fill).detail, fill.value);
  assert.equal(browserActionText({ ...fill, value: '' }).detail, '填入空字符串，清空该字段。');
  assert.throws(() => parseBrowserAction({ ...fill, value: 'x'.repeat(2001) }), /2,000/);
  assert.throws(() => parseBrowserAction({ type: 'select', target: { by: 'role', role: 'combobox', name: 'Choice' }, optionLabel: 'x'.repeat(201) }), /200/);
  assert.throws(() => parseBrowserAction({ type: 'scroll', direction: 'down', pixels: 1201 }));
  assert.throws(() => parseBrowserAction({ type: 'scroll', direction: 'down', pixels: 1.5 }));
  assert.deepEqual(parseBrowserAction({ type: 'scroll', direction: 'up', pixels: 1200 }), { type: 'scroll', direction: 'up', pixels: 1200 });
});

test('browser action opt-in is separate from read-only readiness and missing flags fail closed', () => {
  const plan = { prompt: 'Fictional action goal.', options: { url, actions: [click] } };
  assert.match(browserPlanReadiness(plan, ready)[0], /尚未启用/);
  assert.match(browserPlanReadiness(plan, { ...ready, browserActionsEnabled: false })[0], /尚未启用/);
  assert.deepEqual(browserPlanReadiness(plan, { ...ready, browserActionsEnabled: true }), []);
  assert.match(browserPlanReadiness(plan, undefined)[0], /待配置/);
  assert.match(browserPlanReadiness(plan, { ...ready, enabled: false, browserActionsEnabled: true })[0], /停用/);
});

test('reviewed plans and task inputs are independent of later editor changes', () => {
  const action = { ...newBrowserAction('fill'), by: 'label' as const, name: 'Fictional search', value: 'Original fixture text.' };
  const draft = { url, prompt: 'Original fictional goal.', actions: [action] };
  const plan = serializeBrowserDraft(draft);
  const job = browserPlanJob(plan);
  draft.actions[0].value = 'Changed after review.'; draft.url = 'https://example.org/'; draft.prompt = 'Changed fictional goal.';
  assert.equal((plan.options.actions![0] as Extract<BrowserAction, { type: 'fill' }>).value, 'Original fixture text.');
  assert.equal(plan.options.url, url);
  assert.equal(plan.prompt, 'Original fictional goal.');
  (plan.options.actions![0] as Extract<BrowserAction, { type: 'fill' }>).value = 'Changed after task snapshot.';
  assert.equal((job.options!.actions as Extract<BrowserAction, { type: 'fill' }>[])[0].value, 'Original fixture text.');
  assert.equal('editorId' in (job.options!.actions as object[])[0], false);
});

test('plans enforce the action count and preserve exact action order', () => {
  const actions = Array.from({ length: 12 }, (_, index) => ({ type: 'scroll', direction: 'down', pixels: index + 1 }));
  assert.equal(parseBrowserTaskOptions({ url, actions }).actions?.length, 12);
  assert.deepEqual(parseBrowserTaskOptions({ url, actions }).actions?.map((action) => (action as Extract<BrowserAction, { type: 'scroll' }>).pixels), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.throws(() => parseBrowserTaskOptions({ url, actions: [...actions, click] }), /12/);
});

test('approval parsing retains complete fill content and blocks malformed or mismatched action plans', () => {
  const args = { kind: 'browser', provider: 'browser', prompt: 'Fictional reviewed goal.', options: { url, actions: [fill] }, browserDefinitionHash: 'a'.repeat(64), attachmentIds: [] };
  assert.deepEqual(parseBrowserApprovalPlan(args).options.actions?.[0], fill);
  assert.throws(() => parseBrowserApprovalPlan({ ...args, options: { url, actions: [{ type: 'fill', target: { by: 'role', role: 'button', name: 'Fictional button' }, value: 'fixture' }] } }));
  assert.throws(() => parseBrowserApprovalPlan({ ...args, options: { url, actions: [{ ...fill, hiddenExecution: true }] } }));
  assert.throws(() => parseBrowserApprovalPlan({ ...args, attachmentIds: ['fictional-private-file'] }));
});

test('Agent handoff uses an owned job reference with untrusted-page attribution, never raw page content', () => {
  const draft = browserAgentDraft({ id: '8d0f0129-48e3-46f1-89a2-66f00353ca18' });
  assert.match(draft, /get_browser_observation/);
  assert.match(draft, /8d0f0129-48e3-46f1-89a2-66f00353ca18/);
  assert.match(draft, /未经验证/);
  assert.match(draft, /审阅/);
});

test('Agent handoff requires a stored observation record and does not treat legacy text or screenshots as one', () => {
  const artifact = (name: string, mime: string) => ({ id: name, name, mime, url: `/api/platform/artifacts/${encodeURIComponent(name)}` });
  const legacy = { artifacts: [artifact('page.txt', 'text/plain'), artifact('screenshot.png', 'image/png'), artifact('result.txt', 'text/plain')] };
  assert.equal(hasBrowserObservation(legacy), false);
  assert.equal(hasBrowserObservation({ artifacts: [] }), false);
  assert.equal(hasBrowserObservation({ artifacts: [artifact('browser-observation.json', 'text/plain')] }), false);
  assert.equal(hasBrowserObservation({ artifacts: [artifact('unrelated.json', 'application/json')] }), false);
  assert.equal(hasBrowserObservation({ artifacts: [...legacy.artifacts, artifact('browser-observation.json', 'application/json')] }), true);
});

test('unexpected browser status metadata is contained in that job without claiming completion', () => {
  assert.equal(browserExecutionPresentation(undefined), undefined);
  assert.deepEqual(browserExecutionPresentation({ completedActions: 1, totalActions: 4, state: 'ready', reviewRequired: false }), { progress: '已完成 1 / 4 个步骤', state: '等待执行', reviewRequired: false });
  assert.equal(browserExecutionPresentation({ completedActions: 99, totalActions: 2, state: 'uncertain', reviewRequired: false })?.reviewRequired, true);
  assert.deepEqual(browserExecutionPresentation({ completedActions: 0, totalActions: 0, state: 'unknown', reviewRequired: false } as any), { progress: '只读网页观察', state: '状态待确认', reviewRequired: true });
});
