import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseSafetyResponseRenderResult, renderSafetyResponse, SafetyResponseRenderError } from '../src/companion/safety-response.ts';
import type { SafetyResponseRenderInput, SafetyResponseRenderResult } from '../src/companion/safety-response.ts';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Fixture = Mutable<SafetyResponseRenderInput>;
const at = '2026-10-07T12:00:00.000Z';
const ids = ['lifeline_988', 'emergency_911', 'crisis_text_line'];
/** All prose, review references, destinations, and identities below are fictional, non-clinical fixtures. */
function fixture(level: 'L1' | 'L2' = 'L2', locale: 'zh' | 'en' = 'zh'): Fixture {
  return {
    level, locale, companionName: '虚构伙伴', userName: '虚构同学', askSafetyQuestion: level === 'L2',
    templateFromBundle: {
      L1: { text: locale === 'zh' ? '虚构 L1 正文：{{userName}}，这里是{{companionName}}。' : 'Fictional L1 body: {{userName}} / {{companionName}}.' },
      L2: { text: locale === 'zh' ? '虚构 L2 正文：{{userName}}。\n{{companionName}}：这不是实际临床模板。' : 'Fictional L2 body: {{userName}}.\n{{companionName}}: this is not a clinical template.',
        safetyQuestion: locale === 'zh' ? '虚构问题：{{userName}}，准备好这个合成测试了吗？' : 'Fictional question: {{userName}}, is this synthetic test ready?' },
      resourceCard: {
        title: locale === 'zh' ? '虚构资源卡' : 'Fictional resource card',
        footer: locale === 'zh' ? '此虚构测试不会联系任何人。' : 'This fictional fixture does not contact anyone.',
        schoolUnknown: locale === 'zh' ? '虚构指引：没有学校信息。' : 'Fictional instruction: no school has been supplied.',
        outsideUsLabel: locale === 'zh' ? '虚构境外按钮' : 'Fictional outside label',
      },
    },
    contactsFromBundle: [
      { id: 'lifeline_988', verifiedAt: at, reviewRef: 'fictional-review-a-not-professional-approval',
        name: { zh: '虚构资源甲', en: 'Fictional resource A' }, description: { zh: '虚构资源说明甲。', en: 'Fictional resource description A.' },
        actions: [
          { kind: 'call', number: '+15550100100', label: { zh: '虚构拨号甲', en: 'Call synthetic A' } },
          { kind: 'sms', number: '+15550100100', body: 'SYNTHETIC', label: { zh: '虚构短信甲', en: 'Text synthetic A' } },
          { kind: 'web', url: 'https://resources.example.com/fictional-a', label: { zh: '虚构链接甲', en: 'Open synthetic A' } },
        ] },
      { id: 'emergency_911', verifiedAt: at, reviewRef: 'fictional-review-b-not-professional-approval',
        name: { zh: '虚构资源乙', en: 'Fictional resource B' }, description: { zh: '虚构资源说明乙。', en: 'Fictional resource description B.' },
        actions: [{ kind: 'call', number: '+15550100101', label: { zh: '虚构拨号乙', en: 'Call synthetic B' } }] },
      { id: 'crisis_text_line', verifiedAt: at, reviewRef: 'fictional-review-c-not-professional-approval',
        name: { zh: '虚构资源丙', en: 'Fictional resource C' }, description: { zh: '虚构资源说明丙。', en: 'Fictional resource description C.' },
        actions: [{ kind: 'sms', number: '+15550100102', body: null, label: { zh: '虚构短信丙', en: 'Text synthetic C' } }] },
    ],
    outsideUsTranslation: locale === 'zh' ? '虚构测试：未提供境外联系方式。' : 'Fictional fixture: no outside contact has been supplied.',
  };
}
const invalid = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof SafetyResponseRenderError
  && error.code === 'SAFETY_RESPONSE_INVALID_INPUT' && error.message === 'The safety response could not be rendered.');
const badFixture = (change: (value: Fixture) => void) => { const value = fixture(); change(value); invalid(() => renderSafetyResponse(value)); };
const decoded = (value: SafetyResponseRenderResult): Mutable<SafetyResponseRenderResult> => JSON.parse(JSON.stringify(value));

test('L2 renders the complete external body, separate question and all localized resources', () => {
  const input = fixture(), before = structuredClone(input), result = renderSafetyResponse(input);
  assert.equal(result.text, '虚构 L2 正文：虚构同学。\n虚构伙伴：这不是实际临床模板。');
  assert.equal(result.question, '虚构问题：虚构同学，准备好这个合成测试了吗？');
  assert.equal(result.text.includes(result.question!), false);
  assert.deepEqual(result.resourceCard.contacts.map(contact => contact.id), ids);
  assert.equal(result.resourceCard.contacts[0].name, '虚构资源甲');
  assert.equal(result.resourceCard.contacts[0].actions[0].label, '虚构拨号甲');
  assert.equal(result.resourceCard.contacts[0].verifiedAt, at);
  assert.equal(result.resourceCard.contacts[0].reviewRef, 'fictional-review-a-not-professional-approval');
  assert.deepEqual(result.resourceCard.outsideUs, { label: '虚构境外按钮', text: input.outsideUsTranslation });
  assert.deepEqual(input, before);
});

test('L1 renders only the external lifeline resource and the unchanged school-unknown explanation', () => {
  const input = fixture('L1', 'en'), result = renderSafetyResponse(input);
  assert.equal(result.text, 'Fictional L1 body: 虚构同学 / 虚构伙伴.');
  assert.equal(Object.hasOwn(result, 'question'), false);
  assert.deepEqual(result.resourceCard.contacts.map(contact => contact.id), ['lifeline_988']);
  assert.equal(result.resourceCard.contacts[0].name, 'Fictional resource A');
  assert.equal(result.resourceCard.contacts[0].actions[2].label, 'Open synthetic A');
  assert.equal(result.resourceCard.schoolUnknown, input.templateFromBundle.resourceCard.schoolUnknown);
  assert.equal(result.resourceCard.footer, input.templateFromBundle.resourceCard.footer);
  assert.deepEqual(Object.keys(result), ['text', 'resourceCard']);
});

test('trusted ask flag is explicit: no clock/history inference or L1 question is accepted', () => {
  const input = fixture(); input.askSafetyQuestion = false;
  const result = renderSafetyResponse(input); assert.equal(Object.hasOwn(result, 'question'), false);
  input.askSafetyQuestion = true;
  assert.equal(renderSafetyResponse(input).question, renderSafetyResponse(input).question);
  badFixture(value => { value.level = 'L1'; value.askSafetyQuestion = true; });
  for (const patch of [{ askSafetyQuestion: undefined }, { askSafetyQuestion: 'yes' }, { priorAskedAt: at }, { now: at }, { newHighSignal: true }]) {
    invalid(() => renderSafetyResponse({ ...fixture(), ...patch } as never));
  }
});

test('an absent real user name stays empty and all supplied Unicode names remain literal', () => {
  const input = fixture(); input.userName = ''; input.companionName = 'Your companion';
  assert.equal(renderSafetyResponse(input).text, '虚构 L2 正文：。\nYour companion：这不是实际临床模板。');
  input.userName = 'E\u0301 👩‍💻'; input.companionName = "$& $$ $` $'";
  const result = renderSafetyResponse(input);
  assert.equal(result.text, "虚构 L2 正文：E\u0301 👩‍💻。\n$& $$ $` $'：这不是实际临床模板。");
  badFixture(value => { value.companionName = ''; });
  badFixture(value => { value.userName = ' '; });
});

test('template substitution permits exactly two variables and never interprets resource text or names', () => {
  for (const source of ['{{school}}', '{{ userName }}', '{userName}', '{{UserName}}', '{{{{userName}}}}', '{{companionName}', '{{userName}}{']) {
    badFixture(value => { value.templateFromBundle.L2.text = source; });
  }
  badFixture(value => { value.templateFromBundle.L1.text = '{{unknown}}'; });
  badFixture(value => { value.templateFromBundle.L2.safetyQuestion = '{{country}}'; value.askSafetyQuestion = false; });
  for (const change of [
    (value: Fixture) => { value.userName = '{{companionName}}'; },
    (value: Fixture) => { value.templateFromBundle.resourceCard.title = '{{userName}}'; },
    (value: Fixture) => { value.contactsFromBundle[0].name.en = '{{userName}}'; },
    (value: Fixture) => { value.contactsFromBundle[0].reviewRef = '{review}'; },
    (value: Fixture) => { value.outsideUsTranslation = '{{country}}'; },
  ]) badFixture(change);
});

test('closed records reject state, approval, school, provider and quota interfaces without invoking getters', () => {
  let getterCalls = 0;
  for (const field of ['provider', 'quota', 'approval', 'school', 'safetyBarrier', 'sendContact']) {
    const input = fixture(); Object.defineProperty(input, field, { enumerable: true, get() { getterCalls++; throw new Error('not called'); } });
    invalid(() => renderSafetyResponse(input));
  }
  for (const change of [
    (value: Fixture) => Object.defineProperty(value, 'userName', { enumerable: true, get() { getterCalls++; return 'unsafe'; } }),
    (value: Fixture) => Object.defineProperty(value.templateFromBundle.L2, 'text', { enumerable: true, get() { getterCalls++; return 'unsafe'; } }),
    (value: Fixture) => Object.defineProperty(value.contactsFromBundle[0].name, 'zh', { enumerable: true, get() { getterCalls++; return 'unsafe'; } }),
    (value: Fixture) => Object.defineProperty(value.contactsFromBundle[0].actions[0], 'kind', { enumerable: true, get() { getterCalls++; return 'call'; } }),
  ]) badFixture(change);
  assert.equal(getterCalls, 0);
  badFixture(value => Object.assign(value.templateFromBundle.resourceCard, { languageSupport: 'invented' }));
  badFixture(value => Object.assign(value.contactsFromBundle[0], { approved: true }));
  badFixture(value => Object.assign(value.contactsFromBundle[0].actions[0], { delivered: true }));
});

test('records and arrays must be closed, dense own data; caller proxy property reads are avoided', () => {
  badFixture(value => { Object.setPrototypeOf(value, { school: 'fictional' }); });
  badFixture(value => { Object.defineProperty(value, 'userName', { value: value.userName, enumerable: false }); });
  badFixture(value => { Object.defineProperty(value, Symbol('hidden'), { value: true }); });
  badFixture(value => { delete value.contactsFromBundle[1]; });
  badFixture(value => { Object.assign(value.contactsFromBundle, { trigger: 'unexpected' }); });
  badFixture(value => { Object.defineProperty(value.contactsFromBundle, '0', { enumerable: true, get() { throw new Error('never evaluate'); } }); });
  badFixture(value => { Object.setPrototypeOf(value.contactsFromBundle, Object.prototype); });
  const input = fixture(); Object.setPrototypeOf(input, null); assert.equal(renderSafetyResponse(input).resourceCard.contacts.length, 3);
  let propertyReads = 0;
  const proxy = new Proxy(fixture(), { get() { propertyReads++; throw new Error('not a data descriptor'); } });
  assert.equal(renderSafetyResponse(proxy).resourceCard.contacts.length, 3); assert.equal(propertyReads, 0);
});

test('plain strings reject HTML, invalid Unicode, controls and bidi formatting in every rendering surface', () => {
  for (const marker of ['<b>fictional</b>', 'fictional>value', '\u0000', '\t', '\r', '\u001f', '\u007f', '\u0085', '\u061c', '\u200e', '\u202e', '\u2066', '\ud800', '\udfff']) {
    badFixture(value => { value.userName = `synthetic${marker}`; });
    badFixture(value => { value.templateFromBundle.L2.text = `synthetic${marker}`; });
    badFixture(value => { value.contactsFromBundle[0].description.en = `synthetic${marker}`; });
  }
  badFixture(value => { value.templateFromBundle.L2.safetyQuestion = 'synthetic\nquestion'; });
  badFixture(value => { value.contactsFromBundle[0].name.zh = 'synthetic\nname'; });
  const input = fixture(); input.templateFromBundle.L2.text = 'Synthetic\nbody';
  assert.equal(renderSafetyResponse(input).text, 'Synthetic\nbody');
});

test('Unicode codepoint bounds cover all external fields and preserve a 100-codepoint auth name', () => {
  const input = fixture(); input.userName = '😀'.repeat(100);
  assert.equal(renderSafetyResponse(input).question?.includes(input.userName), true);
  const changes: ((value: Fixture) => void)[] = [
    value => { value.userName = '😀'.repeat(101); }, value => { value.companionName = 'a'.repeat(101); },
    value => { value.templateFromBundle.L1.text = 'a'.repeat(4001); }, value => { value.templateFromBundle.L2.text = 'a'.repeat(4001); },
    value => { value.templateFromBundle.L2.safetyQuestion = 'a'.repeat(501); },
    value => { value.templateFromBundle.resourceCard.title = 'a'.repeat(161); }, value => { value.templateFromBundle.resourceCard.footer = 'a'.repeat(501); },
    value => { value.templateFromBundle.resourceCard.schoolUnknown = 'a'.repeat(1001); }, value => { value.templateFromBundle.resourceCard.outsideUsLabel = 'a'.repeat(161); },
    value => { value.contactsFromBundle[0].name.en = 'a'.repeat(161); }, value => { value.contactsFromBundle[0].description.en = 'a'.repeat(1001); },
    value => { value.contactsFromBundle[0].reviewRef = 'a'.repeat(401); }, value => { value.contactsFromBundle[0].actions[0].label.en = 'a'.repeat(161); },
    value => { const action = value.contactsFromBundle[0].actions[1]; if (action.kind === 'sms') action.body = 'a'.repeat(161); },
    value => { value.outsideUsTranslation = 'a'.repeat(1001); },
  ];
  changes.forEach(badFixture);
});

test('only an explicit zh/en locale is accepted; no school, country, or language capabilities are guessed', () => {
  for (const patch of [{ locale: 'either' }, { locale: '' }, { locale: 'fr' }, { locale: undefined }, { level: 'L0' }, { level: 'L3' }, { school: 'Fictional School' }]) {
    invalid(() => renderSafetyResponse({ ...fixture(), ...patch } as never));
  }
  const input = fixture('L2', 'en'), result = renderSafetyResponse(input);
  assert.equal(result.resourceCard.contacts[0].description, input.contactsFromBundle[0].description.en);
  assert.equal(Object.hasOwn(result, 'approved'), false); assert.equal(Object.hasOwn(result.resourceCard, 'schoolContact'), false);
  assert.equal(Object.hasOwn(result.resourceCard.contacts[0], 'languageSupport'), false);
});

test('contact identities are exact and unique, output order canonical, and metadata proves no timeliness', () => {
  const input = fixture(); input.contactsFromBundle.reverse();
  input.contactsFromBundle[0].verifiedAt = '1999-01-01T00:00:00.000Z';
  assert.deepEqual(renderSafetyResponse(input).resourceCard.contacts.map(contact => contact.id), ids);
  assert.equal(renderSafetyResponse(input).resourceCard.contacts[2].verifiedAt, '1999-01-01T00:00:00.000Z');
  badFixture(value => { value.contactsFromBundle.pop(); });
  badFixture(value => { value.contactsFromBundle.push(value.contactsFromBundle[0]); });
  badFixture(value => { value.contactsFromBundle[1].id = 'lifeline_988'; });
  badFixture(value => { value.contactsFromBundle[1].id = 'school_clinic' as never; });
  for (const date of ['2026-02-30T00:00:00.000Z', '2026-10-07T12:00:00Z', '2026-10-07T12:00:00.000+00:00', 'unknown']) {
    badFixture(value => { value.contactsFromBundle[0].verifiedAt = date; });
  }
});

test('actions contain validated contact data only, with explicit nullable SMS body and no execution', () => {
  const result = renderSafetyResponse(fixture());
  assert.deepEqual(result.resourceCard.contacts[0].actions[0], { kind: 'call', number: '+15550100100', label: '虚构拨号甲' });
  assert.deepEqual(result.resourceCard.contacts[0].actions[1], { kind: 'sms', number: '+15550100100', body: 'SYNTHETIC', label: '虚构短信甲' });
  assert.deepEqual(result.resourceCard.contacts[2].actions[0], { kind: 'sms', number: '+15550100102', body: null, label: '虚构短信丙' });
  badFixture(value => { value.contactsFromBundle[1].actions = []; });
  badFixture(value => { value.contactsFromBundle[0].actions.push(value.contactsFromBundle[0].actions[0]); });
  badFixture(value => { value.contactsFromBundle[1].actions.push(value.contactsFromBundle[1].actions[0]); });
  badFixture(value => { Object.assign(value.contactsFromBundle[1].actions[0], { kind: 'execute' }); });
  badFixture(value => { Object.assign(value.contactsFromBundle[1].actions[0], { uri: 'tel:invented' }); });
  badFixture(value => { const action = value.contactsFromBundle[0].actions[1]; if (action.kind === 'sms') action.body = ''; });
  badFixture(value => { const action = value.contactsFromBundle[0].actions[1]; if (action.kind === 'sms') delete (action as Partial<typeof action>).body; });
  for (const number of ['12', '+', '1555-010-0100', ' 15550100100', '15550100100\n', '１５５５０１００１００', '1234567890123456', 'tel:15550100100']) {
    badFixture(value => { const action = value.contactsFromBundle[0].actions[0]; if (action.kind === 'call') action.number = number; });
  }
});

test('web resources require canonical HTTPS without credentials, local destinations, fragments or ports', () => {
  const urls = ['javascript:alert(1)', 'data:text/plain,synthetic', 'http://resources.example.com/', 'https://resources.example.com',
    'https://user:password@resources.example.com/', 'https://resources.example.com/#part', 'https://resources.example.com:444/',
    'https://resources.example.com:443/', 'https://127.0.0.1/', 'https://127.1/', 'https://[::1]/', 'https://localhost/',
    'https://localhost./', 'https://service/', 'https://service.local/', 'https://service.internal/', 'https://service.home/',
    'https://service.lan/', 'https://resources.test/', 'https://resources.invalid/', 'https://resources.invalid./',
    'https://service.localhost/', 'https://resources.example.com./', ' https://resources.example.com/', 'https://resources.example.com/{x}',
    `https://resources.example.com/${'a'.repeat(2000)}`];
  for (const url of urls) badFixture(value => { const action = value.contactsFromBundle[0].actions[2]; if (action.kind === 'web') action.url = url; });
  const input = fixture(), action = input.contactsFromBundle[0].actions[2];
  if (action.kind === 'web') action.url = 'https://resources.example.com/fictional?source=synthetic';
  assert.equal(renderSafetyResponse(input).resourceCard.contacts[0].actions[2].kind, 'web');
});

test('outside-US explanation cannot introduce a numeric or URI contact; it stays external plain prose', () => {
  for (const value of ['Fictional 555', '虚构１２３', 'Fictional Ⅳ', 'https://resources.example.com/', 'tel:synthetic', 'sms:synthetic', 'www.example.com', 'test@example.com']) {
    badFixture(input => { input.outsideUsTranslation = value; });
  }
  const result = renderSafetyResponse(fixture());
  assert.deepEqual(Object.keys(result.resourceCard.outsideUs), ['label', 'text']);
  assert.equal(Object.hasOwn(result.resourceCard.outsideUs, 'actions'), false);
});

test('result is detached and deeply frozen, and rendering does not mutate a safety barrier or invoke contacts', () => {
  const input = fixture(), barrier = { level: 'L2', status: 'blocked' }, result = renderSafetyResponse(input);
  input.contactsFromBundle[0].description.zh = 'Changed fictional description';
  input.contactsFromBundle[0].actions.pop(); input.templateFromBundle.resourceCard.title = 'Changed';
  assert.equal(result.resourceCard.contacts[0].description, '虚构资源说明甲。');
  assert.equal(result.resourceCard.contacts[0].actions.length, 3); assert.equal(result.resourceCard.title, '虚构资源卡');
  for (const value of [result, result.resourceCard, result.resourceCard.contacts, result.resourceCard.contacts[0], result.resourceCard.contacts[0].actions,
    result.resourceCard.contacts[0].actions[0], result.resourceCard.outsideUs]) assert(Object.isFrozen(value));
  assert.throws(() => Object.assign(result.resourceCard, { approved: true }), TypeError);
  assert.deepEqual(barrier, { level: 'L2', status: 'blocked' });
});

test('a high-risk response has no provider/quota/tool port, runtime dependency, or network request', async () => {
  const source = await fs.readFile(new URL('../src/companion/safety-response.ts', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s+(?!type\b)/m.test(source), false); assert.equal(/\b(?:import|require|fetch)\s*\(/.test(source), false);
  let requests = 0; const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => { requests++; throw new Error('No provider or contact request is permitted.'); }) as typeof fetch;
    assert.equal(renderSafetyResponse(fixture()).resourceCard.contacts.length, 3);
    assert.equal(renderSafetyResponse(fixture('L1')).resourceCard.contacts.length, 1);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 0);
});

test('result codec round-trips localized data only, without rerendering or adding approval or visibility', () => {
  for (const level of ['L1', 'L2'] as const) {
    const original = renderSafetyResponse(fixture(level)), raw = decoded(original), parsed = parseSafetyResponseRenderResult(raw);
    assert.deepEqual(parsed, original); assert.notEqual(parsed, raw); assert(Object.isFrozen(parsed));
    raw.text = 'Changed synthetic result'; assert.notEqual(parsed.text, raw.text);
    assert.equal(Object.hasOwn(parsed, 'visibleAt'), false); assert.equal(Object.hasOwn(parsed, 'approved'), false);
  }
  const raw = decoded(renderSafetyResponse(fixture())); raw.text = 'Different complete fictional external body.';
  assert.equal(parseSafetyResponseRenderResult(raw).text, raw.text);
});

test('result codec closes resource/action shape, cardinality, conditional question and metadata', () => {
  const original = renderSafetyResponse(fixture());
  for (const mutate of [
    (value: Mutable<SafetyResponseRenderResult>) => Object.assign(value, { status: 'delivered' }),
    (value: Mutable<SafetyResponseRenderResult>) => Object.assign(value.resourceCard, { approved: true }),
    (value: Mutable<SafetyResponseRenderResult>) => Object.assign(value.resourceCard.contacts[0], { languageSupport: 'guessed' }),
    (value: Mutable<SafetyResponseRenderResult>) => Object.assign(value.resourceCard.contacts[0].actions[0], { contacted: true }),
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.contacts.pop(); },
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.contacts.reverse(); },
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.contacts[1].id = 'lifeline_988'; },
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.contacts[0].verifiedAt = '2026-02-30T00:00:00.000Z'; },
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.contacts[0].actions[0].label = '{{userName}}'; },
    (value: Mutable<SafetyResponseRenderResult>) => { value.resourceCard.outsideUs.text = 'synthetic 123'; },
    (value: Mutable<SafetyResponseRenderResult>) => { value.text = '{{companionName}}'; },
    (value: Mutable<SafetyResponseRenderResult>) => { value.question = undefined; },
  ]) { const value = decoded(original); mutate(value); invalid(() => parseSafetyResponseRenderResult(value)); }
  const l1 = decoded(renderSafetyResponse(fixture('L1'))); l1.question = 'Synthetic question'; invalid(() => parseSafetyResponseRenderResult(l1));
  const questionless = decoded(original); delete questionless.question;
  assert.equal(Object.hasOwn(parseSafetyResponseRenderResult(questionless), 'question'), false);
});

test('result codec validates actual machine contacts and does not evaluate payload getters', () => {
  let getterCalls = 0;
  const original = renderSafetyResponse(fixture());
  const raw = decoded(original); Object.defineProperty(raw.resourceCard.contacts[0].actions[0], 'kind', {
    enumerable: true, get() { getterCalls++; return 'call'; },
  });
  invalid(() => parseSafetyResponseRenderResult(raw)); assert.equal(getterCalls, 0);
  for (const value of ['https://localhost./', 'http://resources.example.com/', 'https://user@resources.example.com/', 'https://resources.invalid/']) {
    const raw = decoded(original), action = raw.resourceCard.contacts[0].actions[2]; if (action.kind === 'web') action.url = value;
    invalid(() => parseSafetyResponseRenderResult(raw));
  }
  const phone = decoded(original), action = phone.resourceCard.contacts[0].actions[0]; if (action.kind === 'call') action.number = 'tel:synthetic';
  invalid(() => parseSafetyResponseRenderResult(phone));
});

test('expanded content and decoded payload have explicit character and 64-KiB bounds', () => {
  const input = fixture(); input.userName = 'a'.repeat(100); input.templateFromBundle.L2.text = '{{userName}}'.repeat(200);
  assert.equal(renderSafetyResponse(input).text.length, 20000);
  input.templateFromBundle.L2.text += '{{userName}}'; invalid(() => renderSafetyResponse(input));
  input.templateFromBundle.L2.text = 'Synthetic'; input.templateFromBundle.L2.safetyQuestion = '{{userName}}'.repeat(41);
  assert.equal(renderSafetyResponse(input).question?.length, 4100);
  const raw = decoded(renderSafetyResponse(fixture())); raw.text = 'a'.repeat(20001); invalid(() => parseSafetyResponseRenderResult(raw));
  raw.text = 'Synthetic'; raw.question = 'a'.repeat(5001); invalid(() => parseSafetyResponseRenderResult(raw));
  raw.question = 'Synthetic question'; raw.text = '😀'.repeat(20000);
  invalid(() => parseSafetyResponseRenderResult(raw));
});

test('invalid data produces a bounded error without caller content, paths or secret-shaped fields', () => {
  const marker = 'fictional-private-marker';
  try {
    renderSafetyResponse({ ...fixture(), providerSecret: marker } as never); assert.fail('Expected bounded rejection');
  } catch (error) {
    assert(error instanceof SafetyResponseRenderError); assert.equal(error.message.includes(marker), false);
    assert.equal(Object.hasOwn(error, 'cause'), false); assert.equal(Object.hasOwn(error, 'input'), false);
  }
});
