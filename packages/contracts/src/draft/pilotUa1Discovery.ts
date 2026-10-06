/**
 * UA-1 universal-discovery draft wire.
 *
 * This surface is deliberately value-free and read-only. Inclusion in a packet
 * means that the Extension observed a visible form control on the exact page
 * binding; there is no second `visible` assertion for a caller to forge. The
 * shape contains no current value, selector, executable text, write authority,
 * submit action, screenshot, HTML, credential, or durable-storage field.
 */

/**
 * Wire version 2 (BREAKING-L2-T, delivered ATOMIC): `observation.opaqueBoundaries`
 * is required, so a producer that predates it cannot be read as having observed
 * everything. Version 1 packets are rejected. Every producer and consumer of this
 * packet lives in this repository and moved in the same change; there is no
 * released v1 producer. Rollback is the reverting commit, which restores v1 on
 * both sides at once.
 */
export const PILOT_UA1_SCHEMA_VERSION = 2 as const;
export const PILOT_UA1_DISCOVERY_ERROR_CODE =
  'PILOT_DISCOVERY_UNAVAILABLE' as const;

export const PILOT_UA1_MAX_CONTROLS = 64 as const;
export const PILOT_UA1_MAX_OPTIONS_PER_CONTROL = 32 as const;
export const PILOT_UA1_MAX_TOTAL_OPTIONS = 256 as const;
export const PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH = 256 as const;
export const PILOT_UA1_MAX_OPTION_TEXT_LENGTH = 128 as const;
export const PILOT_UA1_MAX_TOTAL_SEMANTIC_TEXT_LENGTH = 16_384 as const;
export const PILOT_UA1_MAX_PATHNAME_LENGTH = 2_048 as const;
export const PILOT_UA1_MAX_AUTOCOMPLETE_TOKENS = 4 as const;
export const PILOT_UA1_DIGEST_HEX_LENGTH = 64 as const;

/** Closed ARIA roles relevant to visible form controls. */
export const PILOT_UA1_CONTROL_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'listbox',
  'option',
  'radio',
  'radiogroup',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
] as const;
export type PilotUa1ControlRole = (typeof PILOT_UA1_CONTROL_ROLES)[number];

/**
 * Closed native control kinds. `hidden` is intentionally absent: UA-1 packets
 * represent visible controls only. `file` identifies a file picker but never
 * carries its FileList, filename, or current state.
 */
export const PILOT_UA1_INPUT_TYPES = [
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'search',
  'select-multiple',
  'select-one',
  'submit',
  'tel',
  'text',
  'textarea',
  'time',
  'url',
  'week',
] as const;
export type PilotUa1InputType = (typeof PILOT_UA1_INPUT_TYPES)[number];

/**
 * Author-declared file acceptance, as a closed shape. The raw `accept` list is
 * page text and never crosses this wire; only its classification does, and an
 * unrecognized or mixed list is reported as OTHER rather than guessed.
 */
export const PILOT_UA1_FILE_ACCEPT_SHAPES = [
  /** Every declared token is a document type. */
  'DOCUMENT',
  /** Every declared token is an image type. */
  'IMAGE',
  /** No restriction declared. */
  'ANY',
  /** Declared, but mixed or not a shape this wire recognizes. */
  'OTHER',
] as const;
export type PilotUa1FileAcceptShape = (typeof PILOT_UA1_FILE_ACCEPT_SHAPES)[number];

/** Bounds for the value-free drop accounting. */
export const PILOT_UA1_MAX_SUPPRESSED_CONTROLS = 64 as const;
export const PILOT_UA1_MAX_HIDDEN_NOT_OBSERVED = 4_096 as const;
export const PILOT_UA1_MAX_OPAQUE_BOUNDARIES = 64 as const;

/** UA-1 detects controls; semantic/canonical classification belongs to UA-2. */
export const PILOT_UA1_DETECTION_OUTCOMES = [
  'VISIBLE_CONTROL_DETECTED',
] as const;
export type PilotUa1DetectionState =
  (typeof PILOT_UA1_DETECTION_OUTCOMES)[number];

export type PilotUa1PageBinding = {
  readonly origin: string;
  readonly pathname: string;
  /**
   * SHA-256 of a per-content-lifecycle nonce plus its mutation generation.
   * Unlike a bare counter, it cannot silently collide after an exact-tab reload.
   */
  readonly domGeneration: string;
};

export type PilotUa1OptionSemantics = {
  readonly identityDigest: string;
  readonly accessibleName: string;
};

/**
 * What the scan observed but deliberately did not emit.
 *
 * Without this, a suppressed honeypot or a hidden native is an invisible drop:
 * the packet looks complete, downstream coverage reads as complete, and a
 * required question can disappear with nothing able to say so. These are
 * bounded counts and digests only — never a selector, name, text or value — and
 * they are kept out of `controls` precisely so nothing here can be mistaken for
 * an answerable question.
 */
export type PilotUa1ObservationAccounting = {
  /**
   * Identity digests of controls that were observed and deliberately not
   * emitted: honeypots, editable descendants of an editing host, hidden pure
   * activators (the compiler's own BUTTON kind -- never a form role on a
   * button, never a file input), and author-declared non-inputs
   * (`aria-hidden="true"` with `tabindex="-1"`, carrying no name of their own)
   * that one emitted, visible, same-family leaf question demonstrably owns:
   * inside that widget with no other question emitted inside it, or alone
   * beside it in the declared native's own label or parent -- validation shims
   * and native carriers. None of them is a question; every one is on the wire.
   */
  readonly suppressedControls: readonly string[];
  /**
   * Hidden natives that could still be questions and were never given an
   * identity: conditional sections, half-declared natives, unlabelled hidden
   * inputs, hidden file inputs and form-role buttons. Pure activators and
   * owned author-declared non-inputs are not in this number (they are
   * suppressed by identity above); a declaration whose owner cannot be shown
   * stays here, exactly counted.
   */
  readonly hiddenNotObservedCount: number;
  /**
   * Identity digests of frame/iframe elements the scan reached unhidden but
   * could not observe into. A frame is a boundary of the observed surface: its
   * contents are not this document, so the scan can neither count them nor
   * vouch for them. Each boundary is therefore neither a control nor a silent
   * drop -- the consumer owes it a DISCOVERY_INCOMPLETE row, and a packet that
   * lists one may never be read as a complete denominator. Digests only: no
   * src, host, title, size or selector crosses this wire.
   */
  readonly opaqueBoundaries: readonly string[];
};

export type PilotUa1VisibleControl = {
  readonly identityDigest: string;
  readonly role: PilotUa1ControlRole | null;
  readonly inputType: PilotUa1InputType | null;
  readonly autocomplete: readonly string[];
  readonly required: boolean;
  readonly accessibleName: string | null;
  readonly label: string | null;
  readonly legend: string | null;
  readonly options: readonly PilotUa1OptionSemantics[];
  /** Closed accept shape for a file picker; null for every other control. */
  readonly fileAccept: PilotUa1FileAcceptShape | null;
};

export type PilotUa1DiscoveryPacket = {
  readonly schemaVersion: typeof PILOT_UA1_SCHEMA_VERSION;
  readonly binding: PilotUa1PageBinding;
  readonly controls: readonly PilotUa1VisibleControl[];
  readonly observation: PilotUa1ObservationAccounting;
};

export type PilotUa1DetectionOutcome = {
  readonly identityDigest: string;
  readonly outcome: PilotUa1DetectionState;
};

export type PilotUa1DiscoveryResult = {
  readonly schemaVersion: typeof PILOT_UA1_SCHEMA_VERSION;
  readonly binding: PilotUa1PageBinding;
  readonly outcomes: readonly PilotUa1DetectionOutcome[];
};

export type PilotUa1DiscoveryParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: typeof PILOT_UA1_DISCOVERY_ERROR_CODE };

type DataValues = Readonly<Record<string, unknown>>;

const CONTROL_ROLES = new Set<string>(PILOT_UA1_CONTROL_ROLES);
const INPUT_TYPES = new Set<string>(PILOT_UA1_INPUT_TYPES);
const DETECTION_OUTCOMES = new Set<string>(PILOT_UA1_DETECTION_OUTCOMES);
const FILE_ACCEPT_SHAPES = new Set<string>(PILOT_UA1_FILE_ACCEPT_SHAPES);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_AUTOCOMPLETE_TOKEN = /^(?:section-[a-z0-9_-]{1,48}|shipping|billing|home|work|mobile|fax|pager|webauthn|on|off|name|honorific-prefix|given-name|additional-name|family-name|honorific-suffix|nickname|username|new-password|current-password|one-time-code|organization-title|organization|street-address|address-line1|address-line2|address-line3|address-level4|address-level3|address-level2|address-level1|country|country-name|postal-code|cc-name|cc-given-name|cc-additional-name|cc-family-name|cc-number|cc-exp|cc-exp-month|cc-exp-year|cc-csc|cc-type|transaction-currency|transaction-amount|language|bday|bday-day|bday-month|bday-year|sex|url|photo|tel|tel-country-code|tel-national|tel-area-code|tel-local|tel-local-prefix|tel-local-suffix|tel-extension|email|impp)$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function failure<T>(): PilotUa1DiscoveryParseResult<T> {
  return { ok: false, code: PILOT_UA1_DISCOVERY_ERROR_CODE };
}

/** Read exact own data properties without invoking caller-provided accessors. */
function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return null;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Dense JSON-like arrays only: holes, accessors, symbols, and extra keys fail. */
function denseDataArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
    return null;
  }

  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy.push(descriptor.value);
  }
  return copy;
}

function parseDigest(value: unknown): string | null {
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
}

function parseSemanticText(value: unknown, maxLength: number): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  return value;
}

function parseNullableSemanticText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return parseSemanticText(value, PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) ?? undefined;
}

function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    return null;
  }
  return value;
}

function parsePathname(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PILOT_UA1_MAX_PATHNAME_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('?') ||
    value.includes('#') ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  const parsed = new URL(value, 'https://pilot.invalid');
  return parsed.pathname === value ? value : null;
}

function parseBinding(value: unknown): PilotUa1PageBinding | null {
  const fields = exactDataValues(value, ['origin', 'pathname', 'domGeneration']);
  if (!fields) return null;
  const origin = parseOrigin(fields.origin);
  const pathname = parsePathname(fields.pathname);
  const domGeneration = parseDigest(fields.domGeneration);
  if (origin === null || pathname === null || domGeneration === null) {
    return null;
  }
  return Object.freeze({ origin, pathname, domGeneration });
}

function parseAutocomplete(value: unknown): readonly string[] | null {
  const tokens = denseDataArray(value);
  if (!tokens || tokens.length > PILOT_UA1_MAX_AUTOCOMPLETE_TOKENS) return null;
  const parsed: string[] = [];
  for (const token of tokens) {
    if (typeof token !== 'string' || !SAFE_AUTOCOMPLETE_TOKEN.test(token)) return null;
    if (parsed.includes(token)) return null;
    parsed.push(token);
  }
  return Object.freeze(parsed);
}

function parseOption(value: unknown): PilotUa1OptionSemantics | null {
  const fields = exactDataValues(value, ['identityDigest', 'accessibleName']);
  if (!fields) return null;
  const identityDigest = parseDigest(fields.identityDigest);
  const accessibleName = parseSemanticText(
    fields.accessibleName,
    PILOT_UA1_MAX_OPTION_TEXT_LENGTH,
  );
  if (identityDigest === null || accessibleName === null) return null;
  return Object.freeze({ identityDigest, accessibleName });
}

function permitsOptions(
  role: PilotUa1ControlRole | null,
  inputType: PilotUa1InputType | null,
): boolean {
  return (
    role === 'combobox' ||
    role === 'listbox' ||
    role === 'radiogroup' ||
    inputType === 'select-one' ||
    inputType === 'select-multiple'
  );
}

type ParsedControl = {
  readonly control: PilotUa1VisibleControl;
  readonly semanticLength: number;
  readonly optionCount: number;
};

function parseControl(value: unknown): ParsedControl | null {
  const fields = exactDataValues(value, [
    'identityDigest',
    'role',
    'inputType',
    'autocomplete',
    'required',
    'accessibleName',
    'label',
    'legend',
    'options',
    'fileAccept',
  ]);
  if (!fields) return null;

  const identityDigest = parseDigest(fields.identityDigest);
  const role = fields.role === null
    ? null
    : typeof fields.role === 'string' && CONTROL_ROLES.has(fields.role)
      ? fields.role as PilotUa1ControlRole
      : undefined;
  const inputType = fields.inputType === null
    ? null
    : typeof fields.inputType === 'string' && INPUT_TYPES.has(fields.inputType)
      ? fields.inputType as PilotUa1InputType
      : undefined;
  const autocomplete = parseAutocomplete(fields.autocomplete);
  const accessibleName = parseNullableSemanticText(fields.accessibleName);
  const label = parseNullableSemanticText(fields.label);
  const legend = parseNullableSemanticText(fields.legend);
  const rawOptions = denseDataArray(fields.options);
  const fileAccept = fields.fileAccept === null
    ? null
    : typeof fields.fileAccept === 'string' && FILE_ACCEPT_SHAPES.has(fields.fileAccept)
      ? fields.fileAccept as PilotUa1FileAcceptShape
      : undefined;

  if (
    fileAccept === undefined ||
    // An accept shape asserts something only a file picker can have.
    (fileAccept !== null && inputType !== 'file') ||
    identityDigest === null ||
    role === undefined ||
    inputType === undefined ||
    (role === null && inputType === null) ||
    autocomplete === null ||
    typeof fields.required !== 'boolean' ||
    accessibleName === undefined ||
    label === undefined ||
    legend === undefined ||
    !rawOptions ||
    rawOptions.length > PILOT_UA1_MAX_OPTIONS_PER_CONTROL ||
    (rawOptions.length > 0 && !permitsOptions(role, inputType))
  ) {
    return null;
  }

  const options: PilotUa1OptionSemantics[] = [];
  const optionDigests = new Set<string>();
  let optionSemanticLength = 0;
  for (const rawOption of rawOptions) {
    const option = parseOption(rawOption);
    if (!option || optionDigests.has(option.identityDigest)) return null;
    optionDigests.add(option.identityDigest);
    optionSemanticLength += option.accessibleName.length;
    options.push(option);
  }

  const semanticLength =
    (accessibleName?.length ?? 0) +
    (label?.length ?? 0) +
    (legend?.length ?? 0) +
    optionSemanticLength;
  return {
    control: Object.freeze({
      identityDigest,
      role,
      inputType,
      autocomplete,
      required: fields.required,
      accessibleName,
      label,
      legend,
      options: Object.freeze(options),
      fileAccept,
    }),
    semanticLength,
    optionCount: options.length,
  };
}

function parseObservationAccounting(value: unknown): PilotUa1ObservationAccounting | null {
  const fields = exactDataValues(value, [
    'suppressedControls',
    'hiddenNotObservedCount',
    'opaqueBoundaries',
  ]);
  if (!fields) return null;
  const raw = denseDataArray(fields.suppressedControls);
  const rawBoundaries = denseDataArray(fields.opaqueBoundaries);
  const count = fields.hiddenNotObservedCount;
  if (
    !raw ||
    raw.length > PILOT_UA1_MAX_SUPPRESSED_CONTROLS ||
    !rawBoundaries ||
    rawBoundaries.length > PILOT_UA1_MAX_OPAQUE_BOUNDARIES ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > PILOT_UA1_MAX_HIDDEN_NOT_OBSERVED
  ) return null;
  // One identity lives in exactly one accounting bucket: a digest that is both
  // a suppressed decoy and an opaque boundary would be counted twice.
  const seen = new Set<string>();
  const suppressed: string[] = [];
  for (const entry of raw) {
    const digest = parseDigest(entry);
    if (digest === null || seen.has(digest)) return null;
    seen.add(digest);
    suppressed.push(digest);
  }
  const boundaries: string[] = [];
  for (const entry of rawBoundaries) {
    const digest = parseDigest(entry);
    if (digest === null || seen.has(digest)) return null;
    seen.add(digest);
    boundaries.push(digest);
  }
  return Object.freeze({
    suppressedControls: Object.freeze(suppressed),
    hiddenNotObservedCount: count,
    opaqueBoundaries: Object.freeze(boundaries),
  });
}

function parsePacket(value: unknown): PilotUa1DiscoveryPacket | null {
  const fields = exactDataValues(value, [
    'schemaVersion',
    'binding',
    'controls',
    'observation',
  ]);
  if (!fields || fields.schemaVersion !== PILOT_UA1_SCHEMA_VERSION) return null;
  const observation = parseObservationAccounting(fields.observation);
  if (!observation) return null;
  const binding = parseBinding(fields.binding);
  const rawControls = denseDataArray(fields.controls);
  if (!binding || !rawControls || rawControls.length > PILOT_UA1_MAX_CONTROLS) return null;

  const controls: PilotUa1VisibleControl[] = [];
  const identityDigests = new Set<string>();
  let totalOptions = 0;
  let totalSemanticLength = 0;
  for (const rawControl of rawControls) {
    const parsed = parseControl(rawControl);
    if (!parsed || identityDigests.has(parsed.control.identityDigest)) return null;
    identityDigests.add(parsed.control.identityDigest);
    for (const option of parsed.control.options) {
      if (identityDigests.has(option.identityDigest)) return null;
      identityDigests.add(option.identityDigest);
    }
    totalOptions += parsed.optionCount;
    totalSemanticLength += parsed.semanticLength;
    if (
      totalOptions > PILOT_UA1_MAX_TOTAL_OPTIONS ||
      totalSemanticLength > PILOT_UA1_MAX_TOTAL_SEMANTIC_TEXT_LENGTH
    ) {
      return null;
    }
    controls.push(parsed.control);
  }

  // A suppressed control is not an emitted one. Overlap would let a decoy pose
  // as an answerable question, so it fails closed here rather than downstream.
  for (const digest of observation.suppressedControls) {
    if (identityDigests.has(digest)) return null;
  }
  // A boundary is not a question either. It may never share an identity with
  // an emitted control or option, or a consumer could write "into" a frame.
  for (const digest of observation.opaqueBoundaries) {
    if (identityDigests.has(digest)) return null;
  }

  return Object.freeze({
    schemaVersion: PILOT_UA1_SCHEMA_VERSION,
    binding,
    controls: Object.freeze(controls),
    observation,
  });
}

function parseOutcome(value: unknown): PilotUa1DetectionOutcome | null {
  const fields = exactDataValues(value, ['identityDigest', 'outcome']);
  if (!fields) return null;
  const identityDigest = parseDigest(fields.identityDigest);
  if (
    identityDigest === null ||
    typeof fields.outcome !== 'string' ||
    !DETECTION_OUTCOMES.has(fields.outcome)
  ) {
    return null;
  }
  return Object.freeze({
    identityDigest,
    outcome: fields.outcome as PilotUa1DetectionState,
  });
}

function parseResult(value: unknown): PilotUa1DiscoveryResult | null {
  const fields = exactDataValues(value, ['schemaVersion', 'binding', 'outcomes']);
  if (!fields || fields.schemaVersion !== PILOT_UA1_SCHEMA_VERSION) return null;
  const binding = parseBinding(fields.binding);
  const rawOutcomes = denseDataArray(fields.outcomes);
  if (!binding || !rawOutcomes || rawOutcomes.length > PILOT_UA1_MAX_CONTROLS) return null;

  const outcomes: PilotUa1DetectionOutcome[] = [];
  const digests = new Set<string>();
  for (const rawOutcome of rawOutcomes) {
    const outcome = parseOutcome(rawOutcome);
    if (!outcome || digests.has(outcome.identityDigest)) return null;
    digests.add(outcome.identityDigest);
    outcomes.push(outcome);
  }
  return Object.freeze({
    schemaVersion: PILOT_UA1_SCHEMA_VERSION,
    binding,
    outcomes: Object.freeze(outcomes),
  });
}

export function parsePilotUa1DiscoveryPacket(
  value: unknown,
): PilotUa1DiscoveryParseResult<PilotUa1DiscoveryPacket> {
  try {
    const parsed = parsePacket(value);
    return parsed ? { ok: true, value: parsed } : failure();
  } catch {
    // Proxies and hostile platform objects may throw from reflection/URL parsing.
    return failure();
  }
}

export function parsePilotUa1DiscoveryResult(
  value: unknown,
): PilotUa1DiscoveryParseResult<PilotUa1DiscoveryResult> {
  try {
    const parsed = parseResult(value);
    return parsed ? { ok: true, value: parsed } : failure();
  } catch {
    return failure();
  }
}
