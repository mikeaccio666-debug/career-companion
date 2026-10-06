import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountUsage } from '@companion/platform-contracts';
import { ApiError } from '../src/api.ts';
import { UsageAccountController, UsageAccountView, accountUsageResponse, usageCountText, usagePeriodText, visibleAccountUsage, type UsageAccountState } from '../src/usage-account.ts';

function usage(overrides: Partial<AccountUsage['chat']> = {}): AccountUsage {
  return {
    period: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', timeZone: 'UTC' },
    chat: { calls: 3, reportedCalls: 1, missingCalls: 1, invalidCalls: 0, pendingCalls: 1, inputTokens: 0, outputTokens: 8, coverage: 'partial', outcomes: { complete: 2, failed: 0, cancelled: 0, interrupted: 0, running: 1 }, providers: [{ provider: 'fictional-provider', model: 'fictional-model', calls: 3, reportedCalls: 1, inputTokens: 0, outputTokens: 8 }], legacyReports: 0, ...overrides },
  };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const responses: ReturnType<typeof deferred<unknown>>[] = [], signals: AbortSignal[] = [], paths: string[] = [], states: UsageAccountState[] = [];
  const controller = new UsageAccountController((path, init) => { paths.push(path); signals.push(init.signal!); const response = deferred<unknown>(); responses.push(response); return response.promise; }, (state) => states.push(state));
  return { controller, responses, signals, paths, states };
}

test('the current usage request carries cancellation and publishes the server statistics without substituting zero', async () => {
  const context = harness(), operation = context.controller.activate('fictional-a');
  assert.deepEqual(context.paths, ['/usage']); assert.equal(context.signals[0].aborted, false);
  assert.deepEqual(context.states, [{ accountId: 'fictional-a', status: 'loading' }]);
  const reported = usage({ inputTokens: null, outputTokens: null, reportedCalls: 0, coverage: 'none' });
  context.responses[0].resolve({ usage: reported }); assert.equal(await operation, 'applied');
  assert.deepEqual(context.states.at(-1), { accountId: 'fictional-a', status: 'ready', usage: reported });
});

test('a newer account aborts the former request and discards its late data after current data has loaded', async () => {
  const context = harness(), older = context.controller.activate('fictional-a'), current = context.controller.activate('fictional-b');
  assert.equal(context.signals[0].aborted, true); assert.equal(context.signals[1].aborted, false);
  const newest = usage({ calls: 7 }); context.responses[1].resolve({ usage: newest }); assert.equal(await current, 'applied');
  const final = context.states.at(-1); context.responses[0].resolve({ usage: usage() }); assert.equal(await older, 'discarded');
  assert.equal(context.states.at(-1), final); assert.equal(context.states.at(-1)?.accountId, 'fictional-b');
});

test('a stale 401 cannot publish an error, clear new account data or affect its authentication', async () => {
  const context = harness(), previous = context.controller.activate('fictional-a'), current = context.controller.activate('fictional-b');
  context.responses[1].resolve({ usage: usage() }); await current; const final = context.states.at(-1);
  context.responses[0].reject(new ApiError('Fictional expired account.', 401)); assert.equal(await previous, 'discarded');
  assert.equal(context.states.at(-1), final); assert.equal(context.states.some((state) => state.status === 'failed'), false);
});

test('retry aborts a slower response and only the latest response or error may publish', async () => {
  const context = harness(), old = context.controller.activate('fictional-a'), current = context.controller.refresh();
  assert.equal(context.signals[0].aborted, true);
  context.responses[0].reject(new Error('Fictional stale failure.')); assert.equal(await old, 'discarded');
  assert.deepEqual(context.states.at(-1), { accountId: 'fictional-a', status: 'loading' });
  context.responses[1].resolve({ usage: usage() }); assert.equal(await current, 'applied');
  assert.equal(context.states.at(-1)?.status, 'ready');
});

test('a current failure stays local and a subsequent successful retry clears it', async () => {
  const context = harness(), first = context.controller.activate('fictional-a');
  context.responses[0].reject(new ApiError('Fictional unauthorized request.', 401)); assert.equal(await first, 'failed');
  assert.deepEqual(context.states.at(-1), { accountId: 'fictional-a', status: 'failed', error: '无法读取本月用量，请重新登录后再试。' });
  const retry = context.controller.refresh(); assert.equal(context.states.at(-1)?.status, 'loading');
  context.responses[1].resolve({ usage: usage() }); assert.equal(await retry, 'applied'); assert.equal(context.states.at(-1)?.status, 'ready');
});

test('dispose aborts the request and neither late success nor failure may publish, even after the same account remounts', async () => {
  for (const fail of [false, true]) {
    const context = harness(), first = context.controller.activate('fictional-a');
    context.controller.dispose(); assert.equal(context.signals[0].aborted, true); const events = context.states.length;
    assert.equal(await context.controller.refresh(), 'discarded'); assert.equal(context.paths.length, 1);
    const newSession = context.controller.activate('fictional-a');
    if (fail) context.responses[0].reject(new ApiError('Fictional previous login.', 401)); else context.responses[0].resolve({ usage: usage() });
    assert.equal(await first, 'discarded'); assert.equal(context.states.length, events + 1);
    context.responses[1].resolve({ usage: usage({ inputTokens: 31 }) }); assert.equal(await newSession, 'applied');
    assert.equal(context.states.at(-1)?.status, 'ready');
  }
});

test('an account render hides previous private values synchronously before its effect starts the new request', () => {
  const previous: UsageAccountState = { accountId: 'fictional-a', status: 'ready', usage: usage({ inputTokens: 987_654 }) };
  const visible = visibleAccountUsage(previous, 'fictional-b');
  assert.deepEqual(visible, { accountId: 'fictional-b', status: 'loading' });
  const html = renderToStaticMarkup(createElement(UsageAccountView, { state: visible, onRefresh() {} }));
  assert.equal(html.includes('987,654'), false); assert.match(html, /正在读取当前账号/); assert.match(html, /disabled=""/);
  assert.equal(visibleAccountUsage(previous, 'fictional-a'), previous);
});

test('zero tokens remain zero and absent tokens say unprovided in the actual production summary markup', () => {
  const state: UsageAccountState = { accountId: 'fictional-a', status: 'ready', usage: usage({ outputTokens: null }) };
  const html = renderToStaticMarkup(createElement(UsageAccountView, { state, onRefresh() {} }));
  assert.match(html, /已上报输入 token<\/dt><dd>0<\/dd>/); assert.match(html, /已上报输出 token<\/dt><dd>未提供<\/dd>/);
  assert.match(html, /本月文字对话用量/); assert.match(html, /2026-10-01 至 2026-11-01（不含结束日期），UTC/);
  assert.match(html, /部分上报/); assert.match(html, /1 \/ 3 次完整上报/);
  assert.match(html, /缺失上报<\/dt><dd>1<\/dd>/); assert.match(html, /无效上报<\/dt><dd>0<\/dd>/); assert.match(html, /待结束<\/dt><dd>1<\/dd>/);
  assert.match(html, /仅统计已接入的文字调用；语音、生成、工作流和代码任务另计/); assert.match(html, /不是费用账单/);
  assert.match(html, /fictional-provider/); assert.match(html, /fictional-model/); assert.match(html, /未提供不代表零消耗/);
  assert.equal(usageCountText(null), '未提供'); assert.equal(usageCountText(0), '0');
});

test('legacy reports are disclosed separately and no-call periods avoid presenting missing tokens as a zero bill', () => {
  const record = usage({ calls: 0, reportedCalls: 0, missingCalls: 0, pendingCalls: 0, inputTokens: null, outputTokens: null, coverage: 'none', providers: [], legacyReports: 2 });
  const html = renderToStaticMarkup(createElement(UsageAccountView, { state: { accountId: 'fictional-a', status: 'ready', usage: record }, onRefresh() {} }));
  assert.match(html, /暂无调用/); assert.match(html, /2 条旧版用量记录/); assert.match(html, /尚未回填完整的新统计/); assert.match(html, /未纳入上述调用与 token/);
  assert.equal(html.includes('查看供应商与模型明细'), false); assert.match(html, /未提供/);
});

test('local error markup offers retry without showing obsolete counts', () => {
  const html = renderToStaticMarkup(createElement(UsageAccountView, { state: { accountId: 'fictional-a', status: 'failed', error: '暂时无法读取本月用量，请重试。' }, onRefresh() {} }));
  assert.match(html, /role="alert"/); assert.match(html, />重试<\/button>/); assert.equal(html.includes('usage-metrics'), false);
});

test('malformed count or period responses fail closed instead of coercing them into reported usage', async () => {
  for (const invalid of [null, {}, { usage: usage({ inputTokens: -1 }) }, { usage: usage({ calls: NaN }) }, { usage: usage({ pendingCalls: 1.2 }) }, { usage: { ...usage(), period: { ...usage().period, from: 'invalid' } } }, { usage: usage({ coverage: 'fake' as 'none' }) }, { usage: usage({ providers: [{ provider: 'fictional', model: 'fictional', calls: 1, reportedCalls: 1, inputTokens: Infinity, outputTokens: 0 }] }) }]) assert.throws(() => accountUsageResponse(invalid), /没有返回有效统计/);
  const context = harness(), operation = context.controller.activate('fictional-a'); context.responses[0].resolve({ usage: usage({ inputTokens: -1 }) });
  assert.equal(await operation, 'failed'); assert.equal(context.states.at(-1)?.status, 'failed');
  assert.equal(accountUsageResponse({ usage: usage() }).chat.inputTokens, 0);
  assert.equal(usagePeriodText(usage().period).endsWith('UTC'), true);
});
