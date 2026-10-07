import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 128 * 1024, MAX_REVISION = 2147483647;
const CONTACT_IDS = ['lifeline_988', 'emergency_911', 'crisis_text_line'] as const;
export interface SafetyResponseLocalizedText { readonly zh: string; readonly en: string; }
export interface SafetyResponseLocale {
  readonly L1: Readonly<{ text: string }>;
  readonly L2: Readonly<{ text: string; safetyQuestion: string }>;
  readonly resourceCard: Readonly<{ title: string; footer: string; schoolUnknown: string; outsideUsLabel: string }>;
}
export type SafetyResponseContactAction =
  | Readonly<{ kind: 'call'; number: string; label: SafetyResponseLocalizedText }>
  | Readonly<{ kind: 'sms'; number: string; body: string | null; label: SafetyResponseLocalizedText }>
  | Readonly<{ kind: 'web'; url: string; label: SafetyResponseLocalizedText }>;
export interface SafetyResponseContact {
  readonly id: typeof CONTACT_IDS[number]; readonly verifiedAt: string; readonly reviewRef: string;
  readonly name: SafetyResponseLocalizedText; readonly description: SafetyResponseLocalizedText;
  readonly actions: readonly SafetyResponseContactAction[];
}
export interface SafetyResponseBundle {
  readonly schemaVersion: 1; readonly revision: number; readonly contentDigest: string; readonly reviewDigest: string;
  /** Explicit external policy value, not a default retention policy. */
  readonly retentionDays: number;
  readonly review: Readonly<{ reference: string; approvedAt: string }>;
  readonly locales: Readonly<{ zh: SafetyResponseLocale; en: SafetyResponseLocale }>;
  readonly resources: Readonly<{ contacts: readonly SafetyResponseContact[]; outsideUs: SafetyResponseLocalizedText }>;
}
export class SafetyResponseBundleError extends Error {
  readonly code = 'SAFETY_RESPONSE_BUNDLE_INVALID';
  constructor() { super('The safety response bundle is not available.'); this.name = 'SafetyResponseBundleError'; }
}
function invalid(): never { throw new SafetyResponseBundleError(); }
function bounded<T>(run: () => T): T { try { return run(); } catch { return invalid(); } }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string'
    || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= value.length))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(descriptors, index) || !descriptors[index]?.enumerable) invalid();
  return value;
}
function text(value: unknown, maximum: number, template = false, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum * 2 || Array.from(value).length > maximum
    || /[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(multiline ? value.replace(/\n/g, '') : value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid();
  const remainder = template ? value.replace(/\{\{(?:companionName|userName)\}\}/g, '') : value;
  if (/[{}]/.test(remainder)) invalid();
  return value;
}
function localized(value: unknown, maximum: number): SafetyResponseLocalizedText {
  const data = record(value, ['zh', 'en']); return { zh: text(data.zh, maximum), en: text(data.en, maximum) };
}
function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum || Object.is(value, -0)) invalid();
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.exec(value)?.[0] !== value
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function phone(value: unknown): string {
  if (typeof value !== 'string' || /^\+?[0-9]{3,15}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function web(value: unknown): string {
  const raw = text(value, 2000), url = new URL(raw), host = url.hostname;
  if (url.protocol !== 'https:' || url.href !== raw || url.username || url.password || url.hash || url.port
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.')
    || host === 'localhost' || /\.(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) invalid();
  return raw;
}
function action(value: unknown): SafetyResponseContactAction {
  // Read the discriminator through a data descriptor; never evaluate a getter.
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  const kind = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (kind === 'call') {
    const data = record(value, ['kind', 'number', 'label']);
    return { kind, number: phone(data.number), label: localized(data.label, 160) };
  }
  if (kind === 'sms') {
    const data = record(value, ['kind', 'number', 'body', 'label']);
    return { kind, number: phone(data.number), body: data.body === null ? null : text(data.body, 160), label: localized(data.label, 160) };
  }
  if (kind === 'web') {
    const data = record(value, ['kind', 'url', 'label']);
    return { kind, url: web(data.url), label: localized(data.label, 160) };
  }
  return invalid();
}
function locale(value: unknown): SafetyResponseLocale {
  const data = record(value, ['L1', 'L2', 'resourceCard']);
  const l1 = record(data.L1, ['text']), l2 = record(data.L2, ['text', 'safetyQuestion']);
  const card = record(data.resourceCard, ['title', 'footer', 'schoolUnknown', 'outsideUsLabel']);
  return { L1: { text: text(l1.text, 4000, true, true) },
    L2: { text: text(l2.text, 4000, true, true), safetyQuestion: text(l2.safetyQuestion, 500, true) },
    resourceCard: { title: text(card.title, 160), footer: text(card.footer, 500),
      schoolUnknown: text(card.schoolUnknown, 1000), outsideUsLabel: text(card.outsideUsLabel, 160) } };
}
function content(value: unknown, requireDigests: boolean) {
  const keys = ['schemaVersion', 'revision', 'retentionDays', 'review', 'locales', 'resources'];
  const data = record(value, requireDigests ? [...keys, 'contentDigest', 'reviewDigest'] : keys, requireDigests ? [] : ['contentDigest', 'reviewDigest']);
  if (data.schemaVersion !== 1) invalid();
  const revision = integer(data.revision, MAX_REVISION), retentionDays = integer(data.retentionDays, 3650);
  const review = record(data.review, ['reference', 'approvedAt']), locales = record(data.locales, ['zh', 'en']);
  const resources = record(data.resources, ['contacts', 'outsideUs']), seen = new Set<string>();
  const contacts = array(resources.contacts, 3, 3).map(value => {
    const entry = record(value, ['id', 'verifiedAt', 'reviewRef', 'name', 'description', 'actions']);
    if (!CONTACT_IDS.includes(entry.id as typeof CONTACT_IDS[number]) || seen.has(entry.id as string)) invalid();
    seen.add(entry.id as string);
    const actions = array(entry.actions, 1, 3).map(action);
    if (new Set(actions.map(item => item.kind)).size !== actions.length) invalid();
    return { id: entry.id as typeof CONTACT_IDS[number], verifiedAt: timestamp(entry.verifiedAt), reviewRef: text(entry.reviewRef, 400),
      name: localized(entry.name, 160), description: localized(entry.description, 1000), actions };
  });
  const outsideUs = localized(resources.outsideUs, 1000);
  // Only a non-contact explanation is accepted here. No outside-US action/number is manufactured.
  for (const value of [outsideUs.zh, outsideUs.en]) if (/\p{N}|(?:https?:\/\/|tel:|sms:|www\.|@)/iu.test(value)) invalid();
  const result = { schemaVersion: 1 as const, revision, retentionDays,
    review: { reference: text(review.reference, 400), approvedAt: timestamp(review.approvedAt) },
    locales: { zh: locale(locales.zh), en: locale(locales.en) }, resources: { contacts, outsideUs } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) invalid();
  return { result, data };
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** Fixed object-key order; contact/action order and exact external text are content-significant. */
export function expectedSafetyResponseBundleDigests(value: unknown): Readonly<{ contentDigest: string; reviewDigest: string }> {
  return bounded(() => {
    const { result } = content(value, false), { review, resources, ...rest } = result;
    const contacts = resources.contacts.map(({ verifiedAt, reviewRef, ...contact }) => contact);
    const contactReviews = resources.contacts.map(({ id, verifiedAt, reviewRef }) => ({ id, verifiedAt, reviewRef }));
    return Object.freeze({ contentDigest: sha(JSON.stringify({ ...rest, resources: { contacts, outsideUs: resources.outsideUs } })),
      reviewDigest: sha(JSON.stringify({ review, contacts: contactReviews })) });
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
/** Integrity only: review metadata establishes neither professional approval nor an active/account-bound policy. */
export function parseSafetyResponseBundle(value: unknown): Readonly<SafetyResponseBundle> {
  return bounded(() => {
    const { result, data } = content(value, true), expected = expectedSafetyResponseBundleDigests(result);
    if (digest(data.contentDigest) !== expected.contentDigest || digest(data.reviewDigest) !== expected.reviewDigest
      || Buffer.byteLength(JSON.stringify({ ...result, ...expected }), 'utf8') > MAX_BYTES) invalid();
    return freeze({ ...result, ...expected });
  });
}
/** Unconfigured is null. Explicit unreadable/non-UTF8/oversized/invalid files fail without leaking path or contents. */
export async function readSafetyResponseBundle(filename?: string): Promise<Readonly<SafetyResponseBundle> | null> {
  if (filename === undefined) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)) invalid();
    handle = await fs.open(filename, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    if (offset > MAX_BYTES) invalid();
    return parseSafetyResponseBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
  } catch { throw new SafetyResponseBundleError(); }
  finally { try { await handle?.close(); } catch { throw new SafetyResponseBundleError(); } }
}
