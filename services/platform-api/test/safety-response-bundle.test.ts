import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expectedSafetyResponseBundleDigests, parseSafetyResponseBundle, readSafetyResponseBundle,
  SafetyResponseBundleError } from '../src/safety-response-bundle.ts';

// All text, contacts and review markers below are fictional integrity fixtures, never professional resources or approval.
const pair = (value: string) => ({ zh: value, en: value });
const action = () => ({ kind: 'call', number: '+15555550100', label: pair('Synthetic call label') });
const locale = () => ({ L1: { text: 'Synthetic L1 {{userName}} from {{companionName}}.\nSynthetic second paragraph.' },
  L2: { text: 'Synthetic L2 {{userName}} from {{companionName}}.', safetyQuestion: 'Synthetic question for {{userName}}?' },
  resourceCard: { title: 'Synthetic resources', footer: 'Synthetic no-contact-on-your-behalf fixture.',
    schoolUnknown: 'Synthetic unknown-school guidance.', outsideUsLabel: 'Synthetic outside-country label.' } });
const content = () => ({ schemaVersion: 1, revision: 7, retentionDays: 17,
  review: { reference: 'fictional-integrity-fixture-not-professional-approval', approvedAt: '2026-01-01T00:00:00.000Z' },
  locales: { zh: locale(), en: locale() }, resources: { outsideUs: pair('Synthetic local-help guidance only.'),
    contacts: ['lifeline_988', 'emergency_911', 'crisis_text_line'].map(id => ({ id, verifiedAt: '2026-01-01T00:00:00.000Z',
      reviewRef: 'fictional-contact-fixture-only', name: pair('Synthetic contact'), description: pair('Synthetic description.'), actions: [action()] })) } });
const document = () => { const value = content(); return { ...value, ...expectedSafetyResponseBundleDigests(value) }; };
const invalid = (error: unknown) => error instanceof SafetyResponseBundleError && error.code === 'SAFETY_RESPONSE_BUNDLE_INVALID'
  && error.message === 'The safety response bundle is not available.' && !Object.hasOwn(error, 'cause');
const resign = (value: unknown) => ({ ...(value as object), ...expectedSafetyResponseBundleDigests(value) });
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const entry of Object.values(value)) frozen(entry);
}

test('external bilingual text is copied, deeply immutable and never treated as proof of approval', () => {
  const original = document(), parsed = parseSafetyResponseBundle(original);
  assert.deepEqual(parsed, original); assert.notEqual(parsed, original); frozen(parsed);
  original.locales.zh.L1.text = 'Synthetic changed text'; original.resources.contacts[0]!.actions[0]!.number = '+15555550101';
  assert.notEqual(parsed.locales.zh.L1.text, original.locales.zh.L1.text); assert.equal(parsed.resources.contacts[0]?.actions[0]?.kind, 'call');
  assert.equal(parsed.review.reference, 'fictional-integrity-fixture-not-professional-approval'); assert.equal(parsed.retentionDays, 17);
  assert.equal(Object.hasOwn(parsed, 'activated'), false); assert.equal(Object.hasOwn(parsed, 'approved'), false);
  assert.throws(() => { (parsed.locales.zh.L1 as { text: string }).text = 'Synthetic mutation'; }, TypeError);
});

test('canonical content and review digests bind distinct fields independently of object key order', () => {
  const original = content(), expected = expectedSafetyResponseBundleDigests(original);
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
  assert.deepEqual(expectedSafetyResponseBundleDigests(reorder(original)), expected);
  for (const change of [
    (value: ReturnType<typeof content>) => { value.revision++; },
    (value: ReturnType<typeof content>) => { value.retentionDays++; },
    (value: ReturnType<typeof content>) => { value.locales.zh.L2.text += ' Changed.'; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.actions[0]!.number = '+15555550101'; },
  ]) { const value = content(); change(value); const next = expectedSafetyResponseBundleDigests(value); assert.notEqual(next.contentDigest, expected.contentDigest); assert.equal(next.reviewDigest, expected.reviewDigest); }
  for (const change of [
    (value: ReturnType<typeof content>) => { value.review.reference += '-changed'; },
    (value: ReturnType<typeof content>) => { value.review.approvedAt = '2026-01-02T00:00:00.000Z'; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.reviewRef += '-changed'; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.verifiedAt = '2026-01-02T00:00:00.000Z'; },
  ]) { const value = content(); change(value); const next = expectedSafetyResponseBundleDigests(value); assert.equal(next.contentDigest, expected.contentDigest); assert.notEqual(next.reviewDigest, expected.reviewDigest); }
  const reversed = content(); reversed.resources.contacts.reverse(); assert.notDeepEqual(expectedSafetyResponseBundleDigests(reversed), expected);
  for (const key of ['contentDigest', 'reviewDigest']) assert.throws(() => parseSafetyResponseBundle({ ...document(), [key]: '0'.repeat(64) }), invalid);
});

test('every object schema is closed and required fields cannot be silently defaulted', () => {
  const original = document();
  for (const key of Object.keys(original)) { const value: Record<string, unknown> = { ...original }; delete value[key]; assert.throws(() => parseSafetyResponseBundle(value), invalid); }
  const paths = ['', 'review', 'locales', 'locales.zh', 'locales.en', 'locales.zh.L1', 'locales.en.L2', 'locales.zh.resourceCard',
    'resources', 'resources.outsideUs', 'resources.contacts.0', 'resources.contacts.0.name', 'resources.contacts.0.description',
    'resources.contacts.0.actions.0', 'resources.contacts.0.actions.0.label'];
  for (const dotted of paths) {
    const value = structuredClone(original); let target: any = value;
    for (const key of dotted.split('.').filter(Boolean)) target = target[key];
    target.syntheticUnknown = true; assert.throws(() => parseSafetyResponseBundle(value), invalid);
  }
  for (const value of [null, [], new Date(), Object.create(original), { ...original, [Symbol('private')]: true },
    { ...original, locales: { zh: original.locales.zh } }, { ...original, locales: { ...original.locales, fr: locale() } }]) assert.throws(() => parseSafetyResponseBundle(value), invalid);
});

test('accessors, hidden fields, sparse arrays and nonstandard prototypes fail without evaluating getters', () => {
  let accessed = 0;
  for (const dotted of ['revision', 'locales.zh.L1.text', 'resources.contacts.0.actions.0.kind', 'resources.contacts.0.actions.0.label.zh']) {
    const value = document(); const keys = dotted.split('.'), key = keys.pop()!; let target: any = value;
    for (const part of keys) target = target[part];
    Object.defineProperty(target, key, { enumerable: true, get() { accessed++; throw new Error('Synthetic secret getter'); } });
    assert.throws(() => parseSafetyResponseBundle(value), invalid);
  }
  const arrayGetter = document(); Object.defineProperty(arrayGetter.resources.contacts, '0', { get() { accessed++; return {}; } });
  assert.throws(() => parseSafetyResponseBundle(arrayGetter), invalid); assert.equal(accessed, 0);
  const hidden = document(); Object.defineProperty(hidden.review, 'reference', { value: hidden.review.reference, enumerable: false });
  assert.throws(() => parseSafetyResponseBundle(hidden), invalid);
  const sparse = document(); delete sparse.resources.contacts[0]; assert.throws(() => parseSafetyResponseBundle(sparse), invalid);
  const extra = document(); Object.assign(extra.resources.contacts, { synthetic: true }); assert.throws(() => parseSafetyResponseBundle(extra), invalid);
  const inherited = document(); inherited.locales.zh = Object.create(inherited.locales.zh); assert.throws(() => parseSafetyResponseBundle(inherited), invalid);
});

test('revisions and explicit retention are bounded integers, with no inferred retention policy', () => {
  for (const revision of [0, -0, -1, 1.5, 2147483648, NaN, Infinity, '7', new Number(7)]) assert.throws(() => parseSafetyResponseBundle({ ...document(), revision }), invalid);
  for (const retentionDays of [0, -0, -1, 1.5, 3651, NaN, '17']) assert.throws(() => parseSafetyResponseBundle({ ...document(), retentionDays }), invalid);
  for (const retentionDays of [1, 3650]) assert.equal(parseSafetyResponseBundle(resign({ ...content(), retentionDays })).retentionDays, retentionDays);
  for (const schemaVersion of [0, 2, '1']) assert.throws(() => parseSafetyResponseBundle({ ...document(), schemaVersion }), invalid);
});

test('canonical timestamps and digest strings reject bad dates, coercion and trailing controls', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => parseSafetyResponseBundle({ ...document(), contentDigest: document().contentDigest + suffix }), invalid);
    const value = document(); value.resources.contacts[0]!.verifiedAt += suffix; assert.throws(() => parseSafetyResponseBundle(value), invalid);
  }
  for (const approvedAt of ['2026-01-01', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00']) assert.throws(() => parseSafetyResponseBundle({ ...document(), review: { ...document().review, approvedAt } }), invalid);
});

test('templates have exactly two supported name placeholders; resources stay plain text', () => {
  for (const text of ['{{system}}', '{{ userName }}', '${userName}', '{userName}', '{{userName', '{{{userName}}}', '{{companionName}}}']) {
    const value = content(); value.locales.zh.L1.text = text; assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  }
  const value = content(); value.locales.en.L2.text = 'Synthetic {{companionName}} then {{userName}}, and {{userName}} again.';
  assert.equal(parseSafetyResponseBundle(resign(value)).locales.en.L2.text, value.locales.en.L2.text);
  for (const change of [
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.description.en = '{{companionName}}'; },
    (value: ReturnType<typeof content>) => { value.locales.zh.resourceCard.footer = '{{userName}}'; },
    (value: ReturnType<typeof content>) => { value.review.reference = '{{companionName}}'; },
  ]) { const value = content(); change(value); assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid); }
});

test('plain Unicode strings reject HTML, control/bidi and invalid UTF16; LF is a body-only formatting exception', () => {
  for (const text of ['', ' ', '<b>Synthetic</b>', 'Synthetic\0', 'Synthetic\ttext', 'Synthetic\rtext', 'Synthetic\x7ftext',
    'Synthetic\u0085text', 'Synthetic\u202etext', 'Synthetic\u2066text', 'Synthetic\u061ctext', '\ud800']) {
    const value = content(); value.locales.zh.L1.text = text; assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  }
  const lf = content(); lf.locales.zh.L1.text = 'Synthetic\nparagraph'; assert.equal(parseSafetyResponseBundle(resign(lf)).locales.zh.L1.text, lf.locales.zh.L1.text);
  lf.locales.zh.L2.safetyQuestion = 'Synthetic\nquestion'; assert.throws(() => expectedSafetyResponseBundleDigests(lf), invalid);
  const unicode = content(); unicode.locales.zh.L1.text = '😀'.repeat(4000); assert.equal(parseSafetyResponseBundle(resign(unicode)).locales.zh.L1.text, unicode.locales.zh.L1.text);
  unicode.locales.zh.L1.text += '😀'; assert.throws(() => expectedSafetyResponseBundleDigests(unicode), invalid);
  const joined = content(); joined.resources.contacts[0]!.name.zh = 'Synthetic 👩‍💻 café cafe\u0301'; assert.equal(parseSafetyResponseBundle(resign(joined)).resources.contacts[0]!.name.zh, joined.resources.contacts[0]!.name.zh);
});

test('contacts are exactly the three configured definitions and actions have closed, unique kinds', () => {
  for (const change of [
    (value: ReturnType<typeof content>) => { value.resources.contacts.pop(); },
    (value: ReturnType<typeof content>) => { value.resources.contacts.push(value.resources.contacts[0]!); },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.id = 'unknown'; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[1]!.id = value.resources.contacts[0]!.id; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.actions = []; },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.actions.push(action()); },
  ]) { const value = content(); change(value); assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid); }
  const original = content(); const actions = [action(), { kind: 'sms', number: '123000', body: 'SYNTHETIC', label: pair('Synthetic SMS label') },
    { kind: 'web', url: 'https://resources.example.com/support', label: pair('Synthetic web label') }];
  const allKinds = { ...original, resources: { ...original.resources, contacts: original.resources.contacts.map(contact => ({ ...contact, actions })) } };
  const parsed = parseSafetyResponseBundle(resign(allKinds)); assert.deepEqual(parsed.resources.contacts[0]!.actions.map(action => action.kind), ['call', 'sms', 'web']); frozen(parsed);
  const nullBody = { ...allKinds, resources: { ...allKinds.resources, contacts: allKinds.resources.contacts.map(contact => ({ ...contact, actions: [{ kind: 'sms', number: '123000', body: null, label: pair('Synthetic SMS label') }] })) } };
  assert.equal((parseSafetyResponseBundle(resign(nullBody)).resources.contacts[0]!.actions[0] as { body: unknown }).body, null);
});

test('phone and HTTPS targets reject ambiguous or private routes without any network access', () => {
  for (const number of ['12', '1'.repeat(16), '+', '123 000', 'tel:123000', '123000\n', '１２３０００']) {
    const value = content(); value.resources.contacts[0]!.actions[0]!.number = number; assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  }
  for (const url of ['http://resources.example.com/support', 'https://user:private@resources.example.com/support',
    'https://resources.example.com/support#private', 'https://resources.example.com:444/support', 'https://localhost/',
    'https://localhost./', 'https://resource.local/', 'https://resource.local./', 'https://resource.invalid/', 'https://resource.invalid./',
    'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://10.0.0.1/', 'https://singlelabel/', 'https://resources.example.com',
    'https://resources.example.com/<private>', 'https://resources.example.com/support\n']) {
    const original = content(); const value = { ...original, resources: { ...original.resources, contacts: original.resources.contacts.map(contact => ({ ...contact, actions: [{ kind: 'web', url, label: pair('Synthetic label') }] })) } };
    assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  }
});

test('outside-US content is explanation only, with no number or contact action supplied', () => {
  for (const text of ['Synthetic call 123000', 'Synthetic call １２３０００', 'Synthetic https://resources.example.com/support', 'Synthetic tel:123000', 'Synthetic sms:123000', 'Synthetic www.example.com', 'Synthetic private@example.com']) {
    const value = content(); value.resources.outsideUs.en = text; assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  }
  const value = content(); value.resources.outsideUs.en = 'Synthetic local-help guidance only.';
  assert.deepEqual(parseSafetyResponseBundle(resign(value)).resources.outsideUs, value.resources.outsideUs);
});

test('per-field bounds and total UTF8 bound are enforced independently', () => {
  const oversized = content(), fill = (maximum: number) => '😀'.repeat(maximum);
  for (const locale of Object.values(oversized.locales)) {
    locale.L1.text = fill(4000); locale.L2.text = fill(4000); locale.L2.safetyQuestion = fill(500);
    locale.resourceCard = { title: fill(160), footer: fill(500), schoolUnknown: fill(1000), outsideUsLabel: fill(160) };
  }
  oversized.review.reference = fill(400);
  const contacts = oversized.resources.contacts.map(contact => ({ ...contact, reviewRef: fill(400), name: pair(fill(160)), description: pair(fill(1000)),
    actions: [{ kind: 'call', number: '+15555550100', label: pair(fill(160)) }, { kind: 'sms', number: '123000', body: fill(160), label: pair(fill(160)) },
      { kind: 'web', url: 'https://resources.example.com/support', label: pair(fill(160)) }] }));
  const value = { ...oversized, resources: { contacts, outsideUs: pair(fill(1000)) } };
  assert(Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024); assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid);
  for (const change of [
    (value: ReturnType<typeof content>) => { value.locales.zh.L2.safetyQuestion = 'x'.repeat(501); },
    (value: ReturnType<typeof content>) => { value.locales.zh.resourceCard.schoolUnknown = 'x'.repeat(1001); },
    (value: ReturnType<typeof content>) => { value.resources.contacts[0]!.reviewRef = 'x'.repeat(401); },
  ]) { const value = content(); change(value); assert.throws(() => expectedSafetyResponseBundleDigests(value), invalid); }
});

test('file loading supplies no default and rejects explicit missing, non-UTF8, invalid and oversized files with bounded errors', async () => {
  assert.equal(await readSafetyResponseBundle(undefined), null);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fictional-response-bundle-')); await fs.chmod(directory, 0o700);
  try {
    const filename = path.join(directory, 'fictional.json'); await fs.writeFile(filename, JSON.stringify(document()), { mode: 0o600 });
    const parsed = await readSafetyResponseBundle(filename); assert.deepEqual(parsed, parseSafetyResponseBundle(document())); frozen(parsed);
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('{"synthetic":'), Buffer.from('x'.repeat(128 * 1024 + 1))]) {
      await fs.writeFile(filename, bytes); await assert.rejects(readSafetyResponseBundle(filename), invalid);
    }
    for (const filename of [directory, path.join(directory, 'missing-secret-marker.json'), '', 'private\npath']) await assert.rejects(readSafetyResponseBundle(filename), invalid);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
