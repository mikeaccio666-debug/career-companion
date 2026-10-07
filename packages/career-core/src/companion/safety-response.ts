const CONTACT_IDS = ['lifeline_988', 'emergency_911', 'crisis_text_line'] as const;

export interface SafetyResponseLocalizedTextDefinition { readonly zh: string; readonly en: string; }
export interface SafetyResponseLocaleTemplate {
  readonly L1: Readonly<{ text: string }>;
  readonly L2: Readonly<{ text: string; safetyQuestion: string }>;
  readonly resourceCard: Readonly<{ title: string; footer: string; schoolUnknown: string; outsideUsLabel: string }>;
}
export type SafetyResponseContactActionDefinition =
  | Readonly<{ kind: 'call'; number: string; label: SafetyResponseLocalizedTextDefinition }>
  | Readonly<{ kind: 'sms'; number: string; body: string | null; label: SafetyResponseLocalizedTextDefinition }>
  | Readonly<{ kind: 'web'; url: string; label: SafetyResponseLocalizedTextDefinition }>;
export interface SafetyResponseContactDefinition {
  readonly id: typeof CONTACT_IDS[number]; readonly verifiedAt: string; readonly reviewRef: string;
  readonly name: SafetyResponseLocalizedTextDefinition; readonly description: SafetyResponseLocalizedTextDefinition;
  readonly actions: readonly SafetyResponseContactActionDefinition[];
}
export interface SafetyResponseRenderInput {
  readonly level: 'L1' | 'L2'; readonly locale: 'zh' | 'en';
  readonly templateFromBundle: SafetyResponseLocaleTemplate;
  readonly contactsFromBundle: readonly SafetyResponseContactDefinition[];
  readonly outsideUsTranslation: string;
  readonly companionName: string; readonly userName: string;
  /** The trusted server owns prior-question evidence. This flag creates no such evidence. */
  readonly askSafetyQuestion: boolean;
}
export type SafetyResponseRenderedAction =
  | Readonly<{ kind: 'call'; number: string; label: string }>
  | Readonly<{ kind: 'sms'; number: string; body: string | null; label: string }>
  | Readonly<{ kind: 'web'; url: string; label: string }>;
export interface SafetyResponseRenderedContact {
  readonly id: SafetyResponseContactDefinition['id']; readonly verifiedAt: string; readonly reviewRef: string;
  readonly name: string; readonly description: string; readonly actions: readonly SafetyResponseRenderedAction[];
}
export interface SafetyResponseRenderResult {
  readonly text: string; readonly question?: string;
  readonly resourceCard: Readonly<{
    title: string; contacts: readonly SafetyResponseRenderedContact[]; schoolUnknown: string; footer: string;
    outsideUs: Readonly<{ label: string; text: string }>;
  }>;
}
export class SafetyResponseRenderError extends Error {
  readonly code = 'SAFETY_RESPONSE_INVALID_INPUT';
  constructor() { super('The safety response could not be rendered.'); this.name = 'SafetyResponseRenderError'; }
}
function invalid(): never { throw new SafetyResponseRenderError(); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = [...keys, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  // Snapshot data descriptors: no caller getter or replacement hook is evaluated.
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(descriptors, key)).map(key => [key, descriptors[key].value]));
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value), length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum
    || Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string'
      || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= length))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const entry = descriptors[index]; if (!entry?.enumerable) invalid(); result.push(entry.value);
  }
  return result;
}
function text(value: unknown, maximum: number, template = false, multiline = false, allowEmpty = false): string {
  if (typeof value !== 'string' || (!value.trim() && !(allowEmpty && value === ''))
    || value.length > maximum * 2 || Array.from(value).length > maximum
    || /[<>\ud800-\udfff\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /\p{Cc}/u.test(multiline ? value.replace(/\n/g, '') : value)) invalid();
  const remainder = template ? value.replace(/\{\{(?:companionName|userName)\}\}/g, '') : value;
  if (/[{}]/.test(remainder)) invalid(); return value;
}
function localized(value: unknown, maximum: number): SafetyResponseLocalizedTextDefinition {
  const data = record(value, ['zh', 'en']); return { zh: text(data.zh, maximum), en: text(data.en, maximum) };
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.exec(value)?.[0] !== value
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
function phone(value: unknown): string {
  if (typeof value !== 'string' || /^\+?[0-9]{3,15}$/.exec(value)?.[0] !== value) invalid(); return value;
}
function web(value: unknown): string {
  const raw = text(value, 2000), url = new URL(raw), host = url.hostname;
  if (url.protocol !== 'https:' || url.href !== raw || url.username || url.password || url.hash || url.port
    || host.includes(':') || /^[0-9.]+$/.test(host) || !host.includes('.') || host.endsWith('.')
    || host === 'localhost' || /\.(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) invalid(); return raw;
}
function action(value: unknown): SafetyResponseContactActionDefinition {
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
    const data = record(value, ['kind', 'url', 'label']); return { kind, url: web(data.url), label: localized(data.label, 160) };
  }
  return invalid();
}
function contacts(value: unknown): SafetyResponseContactDefinition[] {
  const seen = new Set<string>();
  return array(value, 3, 3).map(value => {
    const data = record(value, ['id', 'verifiedAt', 'reviewRef', 'name', 'description', 'actions']);
    if (!CONTACT_IDS.includes(data.id as SafetyResponseContactDefinition['id']) || seen.has(data.id as string)) invalid();
    seen.add(data.id as string); const actions = array(data.actions, 1, 3).map(action);
    if (new Set(actions.map(entry => entry.kind)).size !== actions.length) invalid();
    return { id: data.id as SafetyResponseContactDefinition['id'], verifiedAt: timestamp(data.verifiedAt), reviewRef: text(data.reviewRef, 400),
      name: localized(data.name, 160), description: localized(data.description, 1000), actions };
  });
}
function localeTemplate(value: unknown): SafetyResponseLocaleTemplate {
  const data = record(value, ['L1', 'L2', 'resourceCard']), l1 = record(data.L1, ['text']), l2 = record(data.L2, ['text', 'safetyQuestion']);
  const card = record(data.resourceCard, ['title', 'footer', 'schoolUnknown', 'outsideUsLabel']);
  return { L1: { text: text(l1.text, 4000, true, true) },
    L2: { text: text(l2.text, 4000, true, true), safetyQuestion: text(l2.safetyQuestion, 500, true) },
    resourceCard: { title: text(card.title, 160), footer: text(card.footer, 500), schoolUnknown: text(card.schoolUnknown, 1000),
      outsideUsLabel: text(card.outsideUsLabel, 160) } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function renderedAction(value: unknown): SafetyResponseRenderedAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  const kind = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (kind === 'call') {
    const data = record(value, ['kind', 'number', 'label']); return { kind, number: phone(data.number), label: text(data.label, 160) };
  }
  if (kind === 'sms') {
    const data = record(value, ['kind', 'number', 'body', 'label']);
    return { kind, number: phone(data.number), body: data.body === null ? null : text(data.body, 160), label: text(data.label, 160) };
  }
  if (kind === 'web') {
    const data = record(value, ['kind', 'url', 'label']); return { kind, url: web(data.url), label: text(data.label, 160) };
  }
  return invalid();
}
/** Decode an existing plain response, without rendering, activation, delivery evidence, or safety-state changes. */
export function parseSafetyResponseRenderResult(value: unknown): SafetyResponseRenderResult {
  try {
    const data = record(value, ['text', 'resourceCard'], ['question']);
    const card = record(data.resourceCard, ['title', 'contacts', 'schoolUnknown', 'footer', 'outsideUs']);
    const outside = record(card.outsideUs, ['label', 'text']), outsideText = text(outside.text, 1000);
    if (/\p{N}|(?:https?:\/\/|tel:|sms:|www\.|@)/iu.test(outsideText)) invalid();
    const entries = array(card.contacts, 1, 3);
    if (![1, 3].includes(entries.length) || Object.hasOwn(data, 'question') && entries.length !== 3) invalid();
    const contacts = entries.map((value, index): SafetyResponseRenderedContact => {
      const entry = record(value, ['id', 'verifiedAt', 'reviewRef', 'name', 'description', 'actions']);
      if (entry.id !== CONTACT_IDS[index]) invalid();
      const actions = array(entry.actions, 1, 3).map(renderedAction);
      if (new Set(actions.map(action => action.kind)).size !== actions.length) invalid();
      return { id: entry.id as SafetyResponseContactDefinition['id'], verifiedAt: timestamp(entry.verifiedAt), reviewRef: text(entry.reviewRef, 400),
        name: text(entry.name, 160), description: text(entry.description, 1000), actions };
    });
    const result: SafetyResponseRenderResult = { text: text(data.text, 20000, false, true),
      ...(Object.hasOwn(data, 'question') ? { question: text(data.question, 5000) } : {}),
      resourceCard: { title: text(card.title, 160), contacts, schoolUnknown: text(card.schoolUnknown, 1000), footer: text(card.footer, 500),
        outsideUs: { label: text(outside.label, 160), text: outsideText } } };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024) invalid();
    return freeze(result);
  } catch { return invalid(); }
}
/**
 * Render an already checked server bundle. Syntax validation cannot establish clinical approval,
 * policy activation, visibility, consent, safety clearance, or contact delivery. No execution port is accepted.
 */
export function renderSafetyResponse(input: SafetyResponseRenderInput): SafetyResponseRenderResult {
  try {
    const data = record(input, ['level', 'locale', 'templateFromBundle', 'contactsFromBundle', 'outsideUsTranslation', 'companionName', 'userName', 'askSafetyQuestion']);
    if (!['L1', 'L2'].includes(data.level as string) || !['zh', 'en'].includes(data.locale as string)
      || typeof data.askSafetyQuestion !== 'boolean' || data.level === 'L1' && data.askSafetyQuestion) invalid();
    const locale = data.locale as 'zh' | 'en', template = localeTemplate(data.templateFromBundle), definitions = contacts(data.contactsFromBundle);
    const companionName = text(data.companionName, 100), userName = text(data.userName, 100, false, false, true);
    const outsideUsText = text(data.outsideUsTranslation, 1000);
    if (/\p{N}|(?:https?:\/\/|tel:|sms:|www\.|@)/iu.test(outsideUsText)) invalid();
    // A callback keeps '$&', '$`', and '$\'' in names literal. There is only one substitution pass.
    const interpolate = (value: string, maximum: number, multiline = false) => text(value.replace(/\{\{(companionName|userName)\}\}/g,
      (_match, key: string) => key === 'companionName' ? companionName : userName), maximum, false, multiline);
    const selected = CONTACT_IDS.filter(id => data.level === 'L2' || id === 'lifeline_988').map(id => {
      const definition = definitions.find(contact => contact.id === id)!;
      const actions: SafetyResponseRenderedAction[] = definition.actions.map(action => ({ ...action, label: action.label[locale] }));
      return { id, verifiedAt: definition.verifiedAt, reviewRef: definition.reviewRef, name: definition.name[locale],
        description: definition.description[locale], actions };
    });
    return parseSafetyResponseRenderResult({ text: interpolate(data.level === 'L1' ? template.L1.text : template.L2.text, 20000, true),
      ...(data.level === 'L2' && data.askSafetyQuestion ? { question: interpolate(template.L2.safetyQuestion, 5000) } : {}),
      resourceCard: { title: template.resourceCard.title, contacts: selected, schoolUnknown: template.resourceCard.schoolUnknown,
        footer: template.resourceCard.footer, outsideUs: { label: template.resourceCard.outsideUsLabel, text: outsideUsText } } });
  } catch { return invalid(); }
}
