import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MENTOR_INTENT_PRIVACY, MENTOR_INTENT_PRIVACY_VERSION } from '@companion/platform-contracts';
const webRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'mentor-markup-test-')); await chmod(directory, 0o700);
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { MentorIntentScene, MentorIntentPage } from './src/mentor-intent-view'; export { MentorHumanEntry } from './src/mentor-human-entry'; export { MentorRatingScene } from './src/mentor-rating-view'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs'); await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);
const owner = '11111111-1111-1111-1111-111111111111', id = '22222222-2222-2222-2222-222222222222', at = '2026-10-08T10:00:00.000Z';
const offer = (patch: object = {}) => ({ id, organizationId: owner, revision: 1, kind: 'resume_direction', title: 'Fictional service',
  description: 'Fictional purchased purpose', exclusions: 'Fictional explicit exclusions', priceCents: 12700, currency: 'USD', durationMin: 47,
  collector: 'Fictional collector', refundVersion: 'fictional-1', refundRules: 'Fictional actual refund', appealInstructions: 'Fictional actual appeal',
  disclosureVersion: 'fictional-1', disclosure: 'Fictional actual relationship', intentPrivacy: MENTOR_INTENT_PRIVACY, updatedAt: at,
  validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2028-01-01T00:00:00.000Z', earliestSlotAt: '2027-01-01T00:00:00.000Z', availability: 'available', ...patch });
const entry = (patch: object = {}) => ({ configured: true, contactEmail: 'fictional@example.invalid', privacyVersion: MENTOR_INTENT_PRIVACY_VERSION,
  intentPrivacy: MENTOR_INTENT_PRIVACY, offers: [offer()], ...patch });
const state = (patch: object = {}) => ({ entry: entry(), records: [], nextCursor: null, loaded: true, busy: false, suspended: false,
  pending: null, uncertain: false, needsRefresh: false, error: '', lastResult: null, ...patch });
const editor = (patch: object = {}) => ({ offer: offer(), contactName: '', note: '', confirmed: false, ...patch });
const props = (patch: object = {}) => ({ state: state(), editor: null, setEditor() {}, cancelling: null, setCancelling() {}, inputError: '', setInputError() {},
  controller: { refresh() {}, loadMore() {}, begin() {}, observe() {}, retry() {}, loadOrder() {} }, ...patch });
const markup = (patch: object = {}) => renderToStaticMarkup(createElement(views.MentorIntentScene, props(patch)));
const record = (patch: object = {}) => ({ id, ownerId: owner, organizationId: owner, offerId: id, offerRevision: 1, kind: 'resume_direction', durationMin: 47,
  contactName: 'Fictional student', contactEmail: 'fictional@example.invalid', intentNote: '<img src=x onerror=alert(1)>', status: 'requested',
  orderId: null, mentorId: null, privacyVersion: MENTOR_INTENT_PRIVACY_VERSION, visibilityConfirmedAt: at, revision: 1, createdAt: at,
  updatedAt: at, lastOperationId: owner, ...patch });
test('ServiceCard keeps every source term expanded, showing actual price/duration/collector and no referral or named tutor promise', () => {
  const html = markup();
  for (const text of ['你付的是什么', '不包含什么', '价格、时长与收款方', '退款与申诉', '利益关系', '对方能看到什么',
      'Fictional purchased purpose', 'Fictional explicit exclusions', '$127.00', '47 min', 'Fictional collector',
      'Fictional actual refund', 'Fictional actual appeal', 'Fictional actual relationship', '我想约一次', '不承诺面试或 offer', '最早可约']) assert(html.includes(text));
  assert(html.includes(MENTOR_INTENT_PRIVACY)); for (const text of ['<details', '付款链接', '李老师', '确认购买', '内推评估', '免费诊断']) assert(!html.includes(text));
  assert.match(html, /dateTime="2027-01-01T00:00:00.000Z"/i);
});
test('initial form is empty with explicit unchecked visibility and a server-provided read-only email', () => {
  const html = markup({ editor: editor() });
  assert.match(html, /value=""/); assert.match(html, /<textarea[^>]*><\/textarea>/); assert(!/type="checkbox"[^>]*checked/.test(html));
  assert.match(html, /<button type="submit"[^>]*disabled/); assert(html.includes('我确认将上述称呼、邮箱和我写的需求提供给蔓藤运营。'));
  assert(html.includes('fictional@example.invalid')); assert(!html.includes('type="email"')); assert(!html.includes('type="file"'));
});
test('stale or unavailable terms cannot be submitted or scheduled; refreshed cards do not silently reconfirm an old form', () => {
  const unavailable = markup({ state: state({ entry: entry({ offers: [offer({ availability: 'unavailable', earliestSlotAt: null })] }) }) });
  assert.match(unavailable, /目前没有确认的可约时段/); assert.match(unavailable, /<button[^>]*disabled="">我想约一次/);
  const changed = markup({ state: state({ entry: entry({ offers: [offer({ revision: 2, priceCents: 12900 })] }) }),
    editor: editor({ contactName: 'Fictional', note: 'Own fictional note', confirmed: true }) });
  assert(changed.includes('$129.00')); assert.match(changed, /重新阅读上方最新说明/); assert.match(changed, /<button type="submit"[^>]*disabled/);
});
test('uncertain original operation remains recoverable even when catalog rereading fails; it is never shown as saved', () => {
  const pending = { action: 'create', sessionId: null, body: { operationId: owner } };
  for (const patch of [{}, { loaded: false, entry: null, needsRefresh: true }]) {
    const html = markup({ state: state({ ...patch, pending, uncertain: true, error: 'Fictional read failure' }), editor: editor() });
    assert.match(html, /核对这次操作/); assert.match(html, /用原操作重试/); assert(!html.includes('收到了')); assert(!html.includes('已匹配'));
  }
});
test('suspended and unloaded scenes conceal typed private data and prior service content, including passed-in editors', () => {
  for (const patch of [{ suspended: true }, { loaded: false, entry: null }]) {
    const html = markup({ state: state({ ...patch, records: [record()] }), editor: editor({ note: 'Fictional private editor note' }) });
    assert(!html.includes('Fictional private editor note')); assert(!html.includes('fictional@example.invalid')); assert(!html.includes('Fictional service'));
    assert(!html.includes('onerror')); assert(!html.includes('我想约一次'));
  }
});
test('real requested/cancelled history is literal escaped text with explicit cancel confirmation, without inferred match or order', () => {
  const actual = record(), html = markup({ state: state({ records: [actual] }), cancelling: actual });
  assert(html.includes('&lt;img')); assert(!html.includes('<img')); assert.match(html, /已提交意向/); assert.match(html, /等待人工匹配与报价/);
  assert.match(html, /aria-label="确认取消预约意向"/); assert.match(html, /确认取消这份意向/); assert.match(html, />保留</);
  for (const text of ['已匹配', '已排期', '已付款', '订单号', '看交接包', '导师房间']) assert(!html.includes(text));
  const cancelled = markup({ state: state({ records: [record({ status: 'cancelled', revision: 2 })] }) });
  assert.match(cancelled, /已取消/); assert(!cancelled.includes('取消这份意向')); assert(!cancelled.includes('等待人工匹配与报价'));
});
test('no partner configuration shows a truthful empty state without imaginary prices, entitlements or private editor defaults', () => {
  const html = markup({ state: state({ entry: entry({ configured: false, offers: [] }) }) });
  assert.match(html, /当前暂无可预约的安排/); assert(!html.includes('$')); assert(!html.includes('我想约一次')); assert(!html.includes('免费'));
});
test('anonymous human entry stays distinct from AI; account-bound SSR cannot load or expose private data', () => {
  const human = renderToStaticMarkup(createElement(views.MentorHumanEntry, { current: true }));
  assert.match(human, /href="\/community\/mentors"/); assert.match(human, /aria-current="page"/); assert.match(human, /付费 · 看不到你的对话/);
  const current = { account: { accountId: owner, generation: 1 }, isCurrent: () => true, subscribe: () => () => {}, request() { throw Error('SSR must not read'); } };
  const html = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: current }, createElement(views.MentorIntentPage, { onLogout() {} })));
  assert.match(html, /AI 主理人与队伍 · 真人服务入口/); assert.match(html, /真人与社区/); assert(!html.includes('Fictional service'));
  const stale = renderToStaticMarkup(createElement(views.PlatformAccountClientProvider, { value: { ...current, isCurrent: () => false } }, createElement(views.MentorIntentPage, { onLogout() {} })));
  assert(!stale.includes('mentor-loading')); assert(!stale.includes('mentor-panel'));
});

test('a stale cancellation decision cannot act on a refreshed cancelled record', () => {
  const html = markup({ state: state({ records: [record({ status: 'cancelled', revision: 2 })] }), cancelling: record() });
  assert.match(html, /请求已有变化/); assert.match(html, /<button type="button" disabled="">确认取消这份意向/);
});

test('actual matched history displays literal mentor and proposed time; genuine quote expands original terms without a payment or booking claim',()=>{
 const actual=record({status:'matched',revision:2,orderId:owner,mentorId:owner,assignment:{mentorDisplayName:'<b>Fictional mentor</b>',
  startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T10:47:00.000Z',timeZone:'America/New_York'}});
 const order={status:'quoted',priceCents:9500,shownOffer:offer({priceCents:12700})};
 const html=markup({state:state({records:[actual],quote:{session:actual,order}}),cancelling:actual});
 for(const text of ['已匹配 · 排期待确认','&lt;b&gt;Fictional mentor&lt;/b&gt;','America/New_York','查看报价','$95.00','Fictional actual refund','Fictional actual appeal','确认取消这份意向'])assert(html.includes(text));
 assert(!html.includes('<b>Fictional mentor'));assert(!html.includes('已付款'));assert(!html.includes('已排期'));assert(!html.includes('付款链接'));assert(!html.includes('handoffCode'));
 assert(!/<button type="button" disabled="">确认取消这份意向/.test(html));
});
test('void quote and suspended quote never imply payment; original unassigned cancelled state has no invented mentor',()=>{
 const html=markup({state:state({quote:{order:{status:'void',priceCents:9500,shownOffer:offer()}}})});assert(html.includes('这份报价已作废。'));assert(!html.includes('已付款'));
 const hidden=markup({state:state({suspended:true,quote:{order:{status:'quoted',priceCents:9500,shownOffer:offer()}}})});assert(!hidden.includes('$95.00'));
});

test('only actual settled order data renders system-labelled payment/refund amounts; private external references never appear in markup',()=>{
 for(const [status,refundedCents,text] of [['paid',0,'已记录线下收款'],['refunded_partial',2500,'已记录部分退款'],['refunded_full',9500,'已记录全额退款']] as const){
  const html=markup({state:state({quote:{order:{status,priceCents:9500,shownOffer:offer(),payment:{paidAt:at,refundedCents},paymentRef:'Fictional_private_reference',handoffCode:'Fictional_private_code'}}})});
  assert(html.includes('系统'));assert(html.includes(text));assert(html.includes('$95.00'));assert(!html.includes('Fictional_private_reference'));assert(!html.includes('Fictional_private_code'));assert(!html.includes('已排期'));
 }
});

test('confirmed schedule shows actual local time and private external meeting with no-referrer; does not offer direct student cancellation or imply payment',()=>{
 const actual=record({status:'scheduled',revision:3,orderId:owner,mentorId:owner,assignment:{mentorDisplayName:'Fictional confirmed mentor',
  startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T10:47:00.000Z',timeZone:'America/New_York'},
  scheduled:{confirmedAt:at,meetingUrl:'https://meet.google.com/fictional-meeting'}});
 const html=markup({state:state({records:[actual],quote:{session:actual,order:{status:'quoted',priceCents:9500,shownOffer:offer()}}})});
 assert(html.includes('已约好'));assert(html.includes('确认时间：'));assert(html.includes('America/New_York'));assert(html.includes('打开会议链接'));
 assert.match(html,/href="https:\/\/meet.google.com\/fictional-meeting"[^>]*rel="noopener noreferrer"[^>]*referrerPolicy="no-referrer"/i);
 for(const text of ['建议时段：','取消这份意向','已记录线下收款','排期待运营确认','已匹配 · 排期待确认'])assert(!html.includes(text));
 assert(html.includes('需要取消或改期时，请联系为你确认预约的运营'));
 const stale=markup({state:state({records:[actual]}),cancelling:record()});assert.match(stale,/<button type="button" disabled="">确认取消这份意向/);
});
test('cancelled or suspended scheduled content hides meeting link; settlement notice describes actual cancellation without claiming refund',()=>{
 const actual=record({status:'cancelled',revision:4,orderId:owner,mentorId:owner,assignment:{mentorDisplayName:'Fictional confirmed mentor',
  startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T10:47:00.000Z',timeZone:'America/New_York'},
  scheduled:{confirmedAt:at,meetingUrl:'https://meet.google.com/fictional-meeting'}});
 const quote={session:actual,order:{status:'paid',priceCents:9500,shownOffer:offer(),payment:{paidAt:at,refundedCents:0}}};
 const html=markup({state:state({records:[actual],quote})});assert(html.includes('预约已取消'));assert(!html.includes('https://meet.google.com/fictional-meeting'));
 assert(!html.includes('已记录全额退款'));assert(!html.includes('排期待确认'));assert(!html.includes('打开会议链接'));
 const hidden=markup({state:state({records:[actual],quote,suspended:true})});assert(!hidden.includes('Fictional confirmed mentor'));assert(!hidden.includes('$95.00'));
});

test('private completed-service feedback requires an actual read, starts with no selected score and supports explicit skip with optional one-line comment',()=>{
 const feedback={loaded:true,busy:false,suspended:false,rating:null,pending:null,uncertain:false,error:''};
 const controls={onSubmit(){},onRefresh(){},onObserve(){},onRetry(){}};
 const html=renderToStaticMarkup(createElement(views.MentorRatingScene,{state:feedback,...controls}));
 assert(html.includes('这次和蔓藤导师聊得怎么样？'));assert(html.includes('仅内部可见'));assert.equal((html.match(/type="radio"/g)||[]).length,5);assert(!html.includes('checked=""'));
 assert.match(html,/<button type="submit" disabled="">提交反馈/);assert(html.includes('跳过'));assert(html.includes('一句话反馈（可选）'));
 for(const state of [{...feedback,loaded:false},{...feedback,suspended:true},{...feedback,rating:{action:'skip'}},{...feedback,rating:{action:'rate',score:4,comment:'Fictional stored'}}]){
  const x=renderToStaticMarkup(createElement(views.MentorRatingScene,{state,...controls}));assert(!x.includes('type="radio"'));assert(!x.includes('提交反馈'));
 }
 const uncertain=renderToStaticMarkup(createElement(views.MentorRatingScene,{state:{...feedback,loaded:false,pending:{operationId:owner},uncertain:true,error:'Fictional unknown outcome'},...controls}));
 assert(uncertain.includes('核对这次反馈'));assert(uncertain.includes('用原操作重试'));assert(!uncertain.includes('你的反馈已记录'));
});
test('completed fulfillment renders its own status without the old meeting link or a false paid claim; feedback SSR does not fetch or assume a score',()=>{
 const actual=record({status:'completed',revision:4,orderId:owner,mentorId:owner,assignment:{mentorDisplayName:'Fictional completed mentor',startsAt:'2026-10-08T11:00:00.000Z',endsAt:'2026-10-08T11:47:00.000Z',timeZone:'America/New_York'},
  scheduled:{confirmedAt:at,meetingUrl:'https://meet.google.com/fictional-completed'},completedAt:'2026-10-08T11:47:00.000Z'});
 const current={account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request(){throw Error('SSR must not read');}};
 const html=renderToStaticMarkup(createElement(views.PlatformAccountClientProvider,{value:current},createElement(views.MentorIntentScene,props({state:state({records:[actual],quote:{session:actual,order:{status:'quoted',priceCents:9500,shownOffer:offer()}}})}))));
 assert(html.includes('已完成'));assert(html.includes('尚无收款记录'));assert(html.includes('正在读取会后反馈'));assert(!html.includes('type="radio"'));assert(!html.includes('https://meet.google.com/fictional-completed'));assert(!html.includes('取消这份意向'));assert(!html.includes('已记录线下收款'));
});
