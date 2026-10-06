import {
  canonicalizePilotUa1ActionUrl,
  createPilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRuntimeResponse,
  pilotUa1DiscoveryFailure,
  type PilotUa1DiscoveryFailure,
  type PilotUa1DiscoveryRequest,
  type PilotUa1DiscoveryRuntimeResponse,
} from './pilotUa1DiscoveryProtocol';
import {
  PILOT_UA1_CONTROL_ROLES,
  PILOT_UA1_INPUT_TYPES,
  PILOT_UA1_MAX_CONTROLS,
  PILOT_UA1_MAX_OPTIONS_PER_CONTROL,
  PILOT_UA1_MAX_OPAQUE_BOUNDARIES,
  PILOT_UA1_MAX_OPTION_TEXT_LENGTH,
  PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
  PILOT_UA1_MAX_SUPPRESSED_CONTROLS,
  PILOT_UA1_SCHEMA_VERSION,
  parsePilotUa1DiscoveryPacket,
  parsePilotUa1DiscoveryResult,
  type PilotUa1ControlRole,
  type PilotUa1DiscoveryPacket,
  type PilotUa1FileAcceptShape,
  type PilotUa1InputType,
  type PilotUa1VisibleControl,
} from '@edaix/contracts/draft';
import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import {
  readDeclaredWizardStep,
  sameDeclaredWizardStep,
  type DeclaredWizardStep,
  type WizardReadOnlyDeclaration,
} from '@edaix/apply-kernel/wizardIdentity';
import { readPilotWizardRuntimeStep, type PilotWizardRuntime } from './pilotWizardRuntime';
import {
  FORM_ROLES,
  formalKindOfShape,
  isHoneypot,
  isPureActivatorShape,
  isSiteDeclaredNonInput,
  type ControlShape,
} from '@edaix/apply-kernel/guards';
import {
  buildPilotUa1StructureSidecar,
  type PilotUa1PlaceholderShape,
  type PilotUa1RawRow,
  type PilotUa1RawStructureEntry,
  type PilotUa1StructureSidecar,
} from './pilotUa1StructureSidecar';

/**
 * One completed exact-page observation, handed to the in-process consumer that
 * builds a semantic epoch. It never crosses the extension message boundary:
 * the runtime response stays the bounded value-free terminal it has always been.
 */
export interface PilotUa1Observation {
  readonly packet: PilotUa1DiscoveryPacket;
  /** Null whenever the scan cannot prove the sidecar describes the whole packet. */
  readonly structure: PilotUa1StructureSidecar | null;
}

/**
 * Exact, content-realm-only lookup for one completed UA-1 generation.
 *
 * `identityDigest` is an address and can be inherited by a replacement node.
 * A writer must therefore present the sidecar's first-sight `elementToken` too,
 * and this registry returns only the exact Element reference observed twice by
 * the producer. No selector, Element or raw value enters the runtime response.
 */
export interface PilotUa1ExactElementRegistry {
  readonly resolve: (identity: Readonly<{
    identityDigest: string;
    elementToken: string;
  }>) => Element | null;
  /**
   * Re-runs the same bounded, value-free UA-1 scan before a write decision.
   * Unlike `resolve`, this catches CSSOM and geometry drift that DOM mutation
   * observers cannot see, and returns only the originally observed Element.
   */
  readonly resolveForWrite: (identity: Readonly<{
    identityDigest: string;
    elementToken: string;
  }>) => Element | null;
  /**
   * Returns the exact option membership observed in one stable DOM window.
   * This is content-local only: callers receive neither selectors nor a way to
   * resolve an arbitrary digest. A hidden DOM member makes the set incomplete;
   * detectable partial virtualization is rejected by the semantic consumer.
   */
  readonly resolveOptionsForWrite: (identity: Readonly<{
    identityDigest: string;
    elementToken: string;
  }>) => Readonly<{
    container: Element;
    options: readonly Readonly<{
      identityDigest: string;
      element: Element;
    }>[];
  }> | null;
  readonly isCurrent: () => boolean;
  readonly dispose: () => void;
}

/** In-process ownership only. Never send or persist this object. */
export interface PilotUa1LiveObservation {
  readonly observation: PilotUa1Observation;
  readonly registry: PilotUa1ExactElementRegistry;
  /**
   * Optional content-local structural evidence only, never a rules-source or
   * execution grant. Null means the supplied declaration could not be proved.
   * A producer must separately validate the runtime-bundle rule provenance.
   */
  readonly declaredWizard?: Readonly<{
    step: DeclaredWizardStep;
    isCurrent: () => boolean;
  }> | null;
}

const issuedWizardObservations = new WeakSet<object>();
const issuedWizardRuntimes = new WeakMap<object, PilotWizardRuntime>();

/** Formal consumers require the exact verified source used by this UA-1 capture. */
export function readPilotUa1WizardRuntime(live: PilotUa1LiveObservation): PilotWizardRuntime | null {
  return readPilotUa1DeclaredWizard(live) === null ? null : issuedWizardRuntimes.get(live) ?? null;
}

/** A copied callback/step record is not an observation issued by UA-1. */
export function readPilotUa1DeclaredWizard(live: PilotUa1LiveObservation): DeclaredWizardStep | null {
  try {
    if (!issuedWizardObservations.has(live) || live.declaredWizard?.isCurrent() !== true) return null;
    return live.declaredWizard.step;
  } catch { return null; }
}

export interface PilotUa1ActionTab {
  readonly id?: number;
  readonly url?: string;
  readonly status?: string;
}

export interface PilotUa1ActionApi {
  readonly onClicked: {
    readonly addListener: (listener: (tab: PilotUa1ActionTab) => void) => void;
  };
  readonly setBadgeText: (
    details: Readonly<{ tabId: number; text: string }>,
  ) => Promise<void> | void;
  readonly setTitle: (
    details: Readonly<{ tabId: number; title: string }>,
  ) => Promise<void> | void;
}

export interface PilotUa1TabUpdate {
  readonly status?: string;
  /** The background strips the raw URL and exposes only this value-free signal. */
  readonly urlChanged?: boolean;
}

export interface PilotUa1TabsApi {
  readonly onUpdated: {
    readonly addListener: (
      listener: (tabId: number, change: PilotUa1TabUpdate) => void,
    ) => void;
  };
  readonly onRemoved: {
    readonly addListener: (listener: (tabId: number) => void) => void;
  };
  readonly get: (tabId: number) => Promise<PilotUa1ActionTab>;
  readonly sendMessage: (
    tabId: number,
    message: PilotUa1DiscoveryRequest,
    options: Readonly<{ frameId: 0 }>,
  ) => Promise<unknown>;
}

function randomRequestId(
  getRandomValues: (values: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
): string | null {
  try {
    const bytes = getRandomValues(new Uint8Array(16));
    if (bytes.length !== 16) return null;
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function sha256Hex(
  value: string,
  subtle: Pick<SubtleCrypto, 'digest'> = crypto.subtle,
): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(value);
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((part) => part.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

function pilotUa1ActionTerminalTitle(response: PilotUa1DiscoveryRuntimeResponse): string {
  return response.ok
    ? `UA-1 discovery: OK (${response.detectedControlCount})`
    : `UA-1 discovery: ${response.code}`;
}

const PILOT_UA1_ACTION_IDLE_TITLE = 'Discover controls on this page';

function invokePilotUa1ActionUpdate(update: () => Promise<void> | void): Promise<void> {
  try {
    return Promise.resolve(update()).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Retains the bounded, value-free terminal on the Extension-owned action UI.
 * Host DOM, storage, logs and telemetry are intentionally outside this sink.
 */
async function surfacePilotUa1ActionTerminal(
  action: PilotUa1ActionApi,
  tabId: number,
  response: PilotUa1DiscoveryRuntimeResponse,
  isCurrentPageAttempt: () => boolean,
): Promise<void> {
  const badgeText = response.ok ? 'OK' : '!';
  const title = pilotUa1ActionTerminalTitle(response);
  const updates: Promise<void>[] = [];
  if (isCurrentPageAttempt()) {
    updates.push(invokePilotUa1ActionUpdate(() => action.setBadgeText({ tabId, text: badgeText })));
  }
  if (isCurrentPageAttempt()) {
    updates.push(invokePilotUa1ActionUpdate(() => action.setTitle({ tabId, title })));
  }
  await Promise.all(updates);
}

async function clearPilotUa1ActionTerminal(
  action: PilotUa1ActionApi,
  tabId: number,
): Promise<void> {
  await Promise.all([
    invokePilotUa1ActionUpdate(() => action.setBadgeText({ tabId, text: '' })),
    invokePilotUa1ActionUpdate(() => action.setTitle({
      tabId,
      title: PILOT_UA1_ACTION_IDLE_TITLE,
    })),
  ]);
}

/**
 * Installs the sole UA-1 trigger producer. There is intentionally no runtime
 * message endpoint that can manufacture a click: only `action.onClicked`
 * creates a fresh request, and delivery is pinned to frame 0 of that tab.
 */
export function installPilotUa1ActionTrigger(input: Readonly<{
  enabled: boolean;
  action: PilotUa1ActionApi;
  tabs: PilotUa1TabsApi;
  now?: () => number;
  getRandomValues?: (values: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  digestExactUrl?: (canonicalHref: string) => Promise<string | null>;
}>): boolean {
  if (!input.enabled) return false;
  const now = input.now ?? Date.now;
  const getRandomValues = input.getRandomValues ?? crypto.getRandomValues.bind(crypto);
  const digestExactUrl = input.digestExactUrl ?? ((href) => sha256Hex(href));

  interface PageAttempt {
    readonly epoch: object;
  }
  const pageEpochByTab = new Map<number, object>();
  const activeAttemptByTab = new Map<number, PageAttempt>();
  const currentEpoch = (tabId: number): object => {
    const existing = pageEpochByTab.get(tabId);
    if (existing) return existing;
    const created = Object.freeze({});
    pageEpochByTab.set(tabId, created);
    return created;
  };

  input.tabs.onUpdated.addListener((tabId, change) => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return;
    if (change.status !== 'loading' && change.urlChanged !== true) return;
    pageEpochByTab.delete(tabId);
    activeAttemptByTab.delete(tabId);
    void clearPilotUa1ActionTerminal(input.action, tabId);
  });
  input.tabs.onRemoved.addListener((tabId) => {
    pageEpochByTab.delete(tabId);
    activeAttemptByTab.delete(tabId);
  });

  input.action.onClicked.addListener((tab) => {
    if (!Number.isSafeInteger(tab.id) || (tab.id ?? -1) < 0 || typeof tab.url !== 'string') return;
    const tabId = tab.id!;
    const canonicalHref = canonicalizePilotUa1ActionUrl(tab.url);
    const target = canonicalHref === null ? null : new URL(canonicalHref);
    const attempt: PageAttempt = Object.freeze({
      epoch: currentEpoch(tabId),
    });
    activeAttemptByTab.set(tabId, attempt);
    void clearPilotUa1ActionTerminal(input.action, tabId);
    const isCurrentPageAttempt = () =>
      pageEpochByTab.get(tabId) === attempt.epoch &&
      activeAttemptByTab.get(tabId) === attempt;
    void (async () => {
      let terminal: PilotUa1DiscoveryRuntimeResponse = pilotUa1DiscoveryFailure(
        'PILOT_DISCOVERY_UNAVAILABLE',
      );
      try {
        if (canonicalHref !== null) {
          const issuedAtMs = now();
          const requestId = randomRequestId(getRandomValues);
          const targetUrlDigest = await digestExactUrl(canonicalHref);
          if (
            Number.isSafeInteger(issuedAtMs) &&
            issuedAtMs >= 0 &&
            requestId !== null &&
            targetUrlDigest !== null
          ) {
            const request = createPilotUa1DiscoveryRequest({
              pageUrl: canonicalHref,
              requestId,
              issuedAtMs,
              targetUrlDigest,
            });
            if (
              request !== null &&
              request.targetOrigin === (target?.origin ?? null) &&
              request.targetPathname === (target?.pathname ?? null) &&
              isCurrentPageAttempt()
            ) {
              const response = await input.tabs.sendMessage(tabId, request, { frameId: 0 });
              terminal = parsePilotUa1DiscoveryRuntimeResponse(response) ?? terminal;
            }
          }
        }
      } catch {
        // Fail closed to the same stable value-free terminal used for malformed
        // content responses. No exception text crosses into the result surface.
      }
      let currentTab: PilotUa1ActionTab | null = null;
      if (canonicalHref !== null && isCurrentPageAttempt()) {
        try {
          currentTab = await input.tabs.get(tabId);
        } catch {
          // Exact-page readback is mandatory. Missing URL/readback is zero UI.
        }
      }
      const exactPageReadback =
        currentTab?.id === tabId &&
        currentTab.status === 'complete' &&
        canonicalizePilotUa1ActionUrl(currentTab.url) === canonicalHref &&
        isCurrentPageAttempt();
      if (exactPageReadback) {
        await surfacePilotUa1ActionTerminal(
          input.action,
          tabId,
          terminal,
          isCurrentPageAttempt,
        );
      } else if (isCurrentPageAttempt()) {
        await clearPilotUa1ActionTerminal(input.action, tabId);
      }
      if (activeAttemptByTab.get(tabId) === attempt) {
        activeAttemptByTab.delete(tabId);
      }
    })();
  });
  return true;
}

export const PILOT_UA1_DISCOVERY_DISABLED_RESPONSE = pilotUa1DiscoveryFailure(
  'PILOT_CAPABILITY_DISABLED',
);

export type { PilotUa1DiscoveryRuntimeResponse };

const PILOT_CONTROL_ROLES = new Set<string>(PILOT_UA1_CONTROL_ROLES);
const PILOT_INPUT_TYPES = new Set<string>(PILOT_UA1_INPUT_TYPES);
const MAX_CONSUMED_REQUESTS = 128;
const ZERO_DIGEST = '0'.repeat(64);

interface PilotUa1MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
}

export interface PilotUa1RuntimeMessageApi {
  readonly id: string;
  readonly getURL: (path: string) => string;
  readonly onMessage: {
    readonly addListener: (
      listener: (
        message: unknown,
        sender: PilotUa1MessageSender,
        sendResponse: (response: PilotUa1DiscoveryRuntimeResponse) => void,
      ) => boolean | void,
    ) => void;
  };
}

interface PilotUa1MutationObserverLike {
  readonly observe: (target: Node, options: MutationObserverInit) => void;
  readonly takeRecords: () => MutationRecord[];
  readonly disconnect: () => void;
}

type PilotUa1MutationObserverFactory = (
  callback: (records: readonly MutationRecord[]) => void,
) => PilotUa1MutationObserverLike;

/**
 * Per-lifecycle element identity. UA-1's identityDigest is an ADDRESS: it is
 * derived from child ordinals, so removing a sibling shifts it and a different
 * control injected at the same address inherits it. A first-sight counter kept
 * in a WeakMap is the only value-free evidence that distinguishes "the same
 * Element again" from "a new Element at the same place", and it exists only
 * here, at the scan site.
 */
export interface PilotUa1ElementIdentities {
  readonly seq: (element: Element) => number;
  /**
   * A repeating group stays a repeating group after the host deletes rows from
   * it. Without this memory a group that shrinks to a single row would stop
   * looking repetitive, its last row would lose its incarnation, and the
   * compiler would see one logical control claiming two different nodes across
   * epochs — exactly the identity confusion this sidecar exists to end.
   */
  readonly rememberRowGroup: (parent: Element, shape: string) => void;
  readonly isKnownRowGroup: (parent: Element, shape: string) => boolean;
}

export function createPilotUa1ElementIdentities(): PilotUa1ElementIdentities {
  const seen = new WeakMap<Element, number>();
  const rowGroups = new WeakMap<Element, Set<string>>();
  let next = 0;
  return {
    seq: (element) => {
      const existing = seen.get(element);
      if (existing !== undefined) return existing;
      next += 1;
      seen.set(element, next);
      return next;
    },
    rememberRowGroup: (parent, shape) => {
      const shapes = rowGroups.get(parent) ?? new Set<string>();
      shapes.add(shape);
      rowGroups.set(parent, shapes);
    },
    isKnownRowGroup: (parent, shape) => rowGroups.get(parent)?.has(shape) === true,
  };
}

/**
 * Closed date-mask shapes. Structure only: matched against the mask itself, so
 * the placeholder text never leaves the page, and no vendor or library name
 * participates.
 */
const MONTH_YEAR_MASK = /^(?:mm|month)\s*[/\-. ]\s*(?:yy|yyyy|year)$/iu;
const DATE_MASK =
  /^(?:(?:mm|dd|month|day)\s*[/\-. ]\s*(?:mm|dd|month|day)\s*[/\-. ]\s*(?:yy|yyyy|year)|(?:yyyy|year)\s*[/\-. ]\s*(?:mm|month)\s*[/\-. ]\s*(?:dd|day))$/iu;

/**
 * Closed accept tokens. Structure only: MIME types and extensions the host
 * declared, matched against fixed sets. No vendor, library or ATS name
 * participates, and the raw list never leaves the page.
 */
const DOCUMENT_ACCEPT_TOKENS = new Set([
  '.pdf', '.doc', '.docx', '.rtf', '.txt', '.odt', '.pages',
  'application/pdf', 'application/msword', 'application/rtf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
]);
const IMAGE_ACCEPT_TOKENS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.svg',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
  'image/bmp', 'image/svg+xml', 'image/*',
]);
/** Long enough for a real accept list, short enough to stay bounded. */
const MAX_ACCEPT_LENGTH = 512;
const MAX_ACCEPT_TOKENS = 32;

function fileAcceptShapeOf(
  element: Element,
  inputType: PilotUa1InputType | null,
): PilotUa1FileAcceptShape | null {
  if (inputType !== 'file') return null;
  const raw = element.getAttribute('accept');
  // Unreadably long or over-long lists are not classified rather than guessed,
  // and never abort a scan that would otherwise have succeeded.
  // Only an absent or whitespace-empty declaration is "no restriction". A
  // declaration that is present but malformed -- a stray comma, a trailing
  // comma, an empty segment -- states an intent this wire cannot read, and
  // reading it as unrestricted would widen a file slot the author narrowed.
  if (raw === null || raw.trim().length === 0) return 'ANY';
  if (raw.length > MAX_ACCEPT_LENGTH) return 'OTHER';
  const tokens = raw.toLowerCase().split(',').map((token) => token.trim());
  if (tokens.length > MAX_ACCEPT_TOKENS) return 'OTHER';
  if (tokens.some((token) => token.length === 0)) return 'OTHER';
  if (tokens.every((token) => DOCUMENT_ACCEPT_TOKENS.has(token))) return 'DOCUMENT';
  if (tokens.every((token) => IMAGE_ACCEPT_TOKENS.has(token))) return 'IMAGE';
  return 'OTHER';
}

/** Longest string that can still be one of the closed masks below. */
const MAX_MASK_LENGTH = 32;

function placeholderShapeOf(element: Element): PilotUa1PlaceholderShape | null {
  const raw = element.getAttribute('placeholder');
  // Read without a throwing bound: anything longer than a mask simply is not
  // one, and a long placeholder must not abort a scan that used to succeed.
  if (raw === null || raw.length > MAX_MASK_LENGTH) return null;
  const mask = raw.trim();
  if (MONTH_YEAR_MASK.test(mask)) return 'MONTH_YEAR_MASK';
  if (DATE_MASK.test(mask)) return 'DATE_MASK';
  return null;
}

/** A control's own declaration, without inheritance. */
function hasOwnDisabled(element: Element): boolean {
  return element.hasAttribute('disabled') ||
    normalizedAttribute(element, 'aria-disabled', 16) === 'true';
}

/**
 * HTML effective disabled state -- the single predicate for both proxy
 * admission and sidecar evidence, so the two can never disagree about whether
 * a control is answerable.
 *
 * A control is disabled by its own attribute, or by inheritance from an
 * ancestor `<fieldset disabled>` IN ITS OWN TREE. The one exception is that
 * fieldset's FIRST `<legend>`: HTML exempts its contents precisely so a section
 * can carry the control that re-enables it, and a scan that missed that would
 * refuse the one control the user must be able to answer.
 *
 * The walk uses tree-scoped `parentElement` and deliberately does not cross a
 * shadow boundary. A light-DOM fieldset does not disable controls inside the
 * shadow root of a descendant host -- that is a separate tree -- and treating
 * it as if it did would mark a live field disabled, refuse it as a proxy
 * target, and drop an answerable question with nothing to show for it.
 */
function isDisabled(element: Element, budget: DiscoveryBudget): boolean {
  if (hasOwnDisabled(element)) return true;
  let child: Element = element;
  let cursor = element.parentElement;
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (cursor.tagName.toLowerCase() === 'fieldset' && cursor.hasAttribute('disabled')) {
      let firstLegend: Element | null = null;
      for (const candidate of cursor.children) {
        spend(budget, 'relationSteps');
        if (candidate.tagName.toLowerCase() === 'legend') {
          firstLegend = candidate;
          break;
        }
      }
      // Exempt only when this chain passes through that first legend; an outer
      // disabled fieldset still applies, so the walk continues either way.
      if (firstLegend === null || firstLegend !== child) return true;
    }
    child = cursor;
    cursor = cursor.parentElement;
  }
  return false;
}

function isReadOnly(element: Element): boolean {
  return element.hasAttribute('readonly') ||
    normalizedAttribute(element, 'aria-readonly', 16) === 'true';
}

function isMultiple(element: Element): boolean {
  return element.hasAttribute('multiple') ||
    normalizedAttribute(element, 'aria-multiselectable', 16) === 'true';
}

/**
 * A placeholder option is declared by the host, never guessed from its text:
 * an explicitly disabled option, or an explicitly empty value. A placeholder
 * never participates in matching or writing, so over-claiming one would hide a
 * real choice — hence the narrow, attribute-only test.
 */
function isPlaceholderOption(option: Element): boolean {
  // An option's own disabled attribute is the HTML placeholder signal; fieldset
  // inheritance says nothing about whether an option is a placeholder.
  if (hasOwnDisabled(option)) return true;
  const value = option.getAttribute('value');
  // Same reason as the mask read: a long value is certainly not the empty
  // placeholder value, so it needs no bound and must never fail the scan.
  return value !== null && value.length <= MAX_MASK_LENGTH && value.trim().length === 0;
}

interface RawOption {
  readonly path: string;
  readonly accessibleName: string;
  readonly placeholder: boolean;
}

interface RawOptionSet {
  readonly options: readonly RawOption[];
  /** Exact references aligned one-for-one with `options`; content-local only. */
  readonly elements: readonly Element[];
  /** Exact select/group/listbox traversed to produce this membership. */
  readonly container: Element | null;
  /** False when an observed role=option candidate was hidden and not emitted. */
  readonly membershipComplete: boolean;
}

interface RawControl {
  readonly path: string;
  readonly role: PilotUa1ControlRole | null;
  readonly inputType: PilotUa1InputType | null;
  readonly autocomplete: readonly string[];
  readonly required: boolean;
  readonly accessibleName: string | null;
  readonly label: string | null;
  readonly legend: string | null;
  readonly options: readonly RawOption[];
  readonly fileAccept: PilotUa1FileAcceptShape | null;
  /** Structural evidence for the sidecar; never part of the UA-1 wire. */
  readonly structure: PilotUa1RawStructureEntry;
}

interface RawScan {
  readonly controls: readonly RawControl[];
  /** Exact references aligned one-for-one with `controls`; content-local only. */
  readonly elements: readonly Element[];
  /** Exact option references aligned first by control and then by packet option. */
  readonly optionElements: readonly (readonly Element[])[];
  /** Exact option-set containers aligned one-for-one with `controls`. */
  readonly optionContainers: readonly (Element | null)[];
  /** Whether every option-like candidate for each control was emitted. */
  readonly optionMembershipComplete: readonly boolean[];
  /** Paths of controls observed and suppressed; digested with the same salt. */
  readonly suppressedPaths: readonly string[];
  /**
   * Hidden natives that could still be questions, observed without ever being
   * given an identity. Two hidden shapes are NOT in this number because they
   * are not questions in any generation: a pure activator by the compiler's
   * own role/type priority (BUTTON, never a form role on a button, never a
   * FILE), and a native the author declared not-for-humans whose ownership by
   * one emitted question is shown -- it sits inside that question's visible
   * ARIA widget, or beside exactly one compatible emitted control in its own
   * label or parent with no independent label between them. Both are recorded
   * by identity in `suppressedPaths`; a declaration whose ownership cannot be
   * shown stays counted here, because the declaration alone proves nothing
   * about what it belongs to.
   */
  readonly hiddenNotObservedCount: number;
  /** False when a pruned subtree could not be proven counted; withholds the sidecar. */
  readonly conserved: boolean;
  /**
   * Paths of frame/iframe elements the semantic walk reached unhidden. A frame
   * is an opaque boundary of the observed surface: its contents are not this
   * document and the scan cannot vouch for them, so it is neither a control nor
   * a silent drop. Digested with its own salt; the consumer owes each one a
   * DISCOVERY_INCOMPLETE row.
   */
  readonly opaqueBoundaryPaths: readonly string[];
}

function boundedAttribute(element: Element, name: string, maxLength = 256): string | null {
  const raw = element.getAttribute(name);
  if (raw !== null && raw.length > maxLength) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  return raw;
}

function normalizedAttribute(element: Element, name: string, maxLength = 64): string {
  return (boundedAttribute(element, name, maxLength) ?? '').trim().toLowerCase();
}

const NON_PILOT_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'caption', 'cell', 'code', 'columnheader', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis',
  'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading',
  'img', 'insertion', 'link', 'log', 'main', 'marquee', 'math', 'menu',
  'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
  'navigation', 'none', 'note', 'paragraph', 'presentation', 'progressbar',
  'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'separator',
  'status', 'strong', 'subscript', 'superscript', 'tab', 'table', 'tablist',
  'tabpanel', 'term', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
  'treeitem',
]);
const NON_PILOT_ROLE = Symbol('NON_PILOT_ROLE');

function firstPilotRole(
  element: Element,
): PilotUa1ControlRole | null | typeof NON_PILOT_ROLE {
  const raw = normalizedAttribute(element, 'role', 128);
  if (raw.length === 0) return null;
  for (const token of raw.split(/\s+/u)) {
    if (PILOT_CONTROL_ROLES.has(token)) return token as PilotUa1ControlRole;
    if (NON_PILOT_ARIA_ROLES.has(token)) return NON_PILOT_ROLE;
  }
  return null;
}

function boundedStyle(value: string): string {
  if (value.length > 256) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  return value;
}

/**
 * HTML editable state of one element. `contenteditable` with no value is the
 * true state, and only an explicit `false` ends an editable flow.
 */
function editableState(element: Element): 'HOST' | 'FALSE' | 'NONE' {
  const raw = element.getAttribute('contenteditable');
  // An enumerated attribute matches its keywords ASCII case-insensitively and
  // does NOT tolerate surrounding whitespace. Trimming here would honour
  // `contenteditable=" false "` as a real barrier, when HTML makes an invalid
  // value inherit instead -- and a fake barrier mints a second question for a
  // node that is still part of the surrounding answer surface.
  if (raw === null || raw.length > MAX_EDITABLE_KEYWORD_LENGTH) return 'NONE';
  const keyword = raw.toLowerCase();
  if (keyword === '' || keyword === 'true' || keyword === 'plaintext-only') return 'HOST';
  // Only an exact, legal `false` ends an editable flow. Anything else inherits,
  // so it is neither a host of its own nor a barrier.
  return keyword === 'false' ? 'FALSE' : 'NONE';
}

/** Longest string that can still be one of the three legal keywords. */
const MAX_EDITABLE_KEYWORD_LENGTH = 16;

/** Native form elements own their control identity; contenteditable is inert on them. */
const NATIVE_CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'button']);

/**
 * True when this editing host lies inside another one with no
 * `contenteditable="false"` region between them.
 *
 * That is the whole distinction, and it is HTML's rather than a heuristic: a
 * nested editable node is part of the surrounding answer surface, so it is not
 * a second question and has no answer of its own. A false region ends the
 * editable flow, so a host re-formed inside one is genuinely independent and
 * must keep its question.
 *
 * Both bounds matter and both are load-bearing: the walk stays inside one tree,
 * and only an exactly-spelled `false` counts as a barrier.
 */
function containedByEditingHost(element: Element, budget: DiscoveryBudget): boolean {
  if (NATIVE_CONTROL_TAGS.has(element.tagName.toLowerCase())) return false;
  if (editableState(element) !== 'HOST') return false;
  // Tree-scoped: an editing host cannot reach into the shadow root of a
  // descendant, which is a separate tree with its own editable flow. Crossing
  // the boundary would suppress a real editor and quietly lower the denominator
  // -- the same silent-drop failure this slice exists to close.
  const parent = element.parentElement;
  return parent !== null && withinEditingFlow(parent, budget);
}

/** Focusable by the author's own declaration -- role-agnostic, value-free. */
function isFocusableByTabIndex(element: Element): boolean {
  const raw = boundedAttribute(element, 'tabindex', 32);
  if (raw === null) return false;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0;
}

/**
 * An activator carries no answer. This is the same test the answerable-control
 * set already applies, named once so both callers share it instead of drifting.
 */
function isActivatorKind(kind: Readonly<{
  role: PilotUa1ControlRole | null;
  inputType: PilotUa1InputType | null;
}>): boolean {
  return kind.role === 'button' ||
    kind.inputType === 'button' || kind.inputType === 'submit' ||
    kind.inputType === 'reset' || kind.inputType === 'image';
}

function questionRoleInertInEditingFlow(
  element: Element,
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
  idTargets: WeakMap<Document | ShadowRoot, Map<string, Element | null>>,
): boolean {
  const kind = nativeControlKind(element);
  // Native identity and intrinsic editability are decided elsewhere; neither is
  // an ARIA-only claim, so neither is ever inert here.
  if (kind === null) return false;
  if (NATIVE_CONTROL_TAGS.has(element.tagName.toLowerCase())) return false;
  if (editableState(element) === 'HOST') return false;
  // An activator compiles to an ACTION and cannot inflate the question
  // denominator, so it is never elided.
  if (isActivatorKind(kind)) return false;
  // Evidence comes from the formal pipeline, not from a second role taxonomy:
  // the author declaring the element focusable, or the ordinary option
  // collection -- which already owns which roles carry options -- finding any.
  // A role with either is a real widget and is kept, whatever the role is.
  if (isFocusableByTabIndex(element)) return false;
  if (controlOptions(element, '', view, budget, visibilityCache, idTargets).options.length > 0) {
    return false;
  }
  const parent = element.parentElement;
  return parent !== null && withinEditingFlow(parent, budget);
}

function nativeControlKind(element: Element): Readonly<{
  role: PilotUa1ControlRole | null;
  inputType: PilotUa1InputType | null;
}> | null {
  const tag = element.tagName.toLowerCase();
  const declared = firstPilotRole(element);
  // Two things give an element control identity of its own: a native form tag,
  // and intrinsic editability. Either survives a non-form ARIA role, because
  // ARIA supplements what a control means and does not delete an element the
  // user can still focus and answer -- ARIA itself says a presentational role
  // is ignored on a focusable element rather than applied to it. A field erased
  // this way leaves no trace: the question is gone and the accounting, which
  // only ever sees controls, has nothing to report.
  //
  // Where neither holds, a role is the only reason the element would be a
  // control at all, so a non-form role still vetoes it.
  const intrinsicIdentity =
    NATIVE_CONTROL_TAGS.has(tag) || editableState(element) === 'HOST';
  if (declared === NON_PILOT_ROLE && !intrinsicIdentity) return null;
  const role = declared === NON_PILOT_ROLE ? null : declared;

  if (tag === 'input') {
    const rawType = normalizedAttribute(element, 'type') || 'text';
    if (rawType === 'hidden') return null;
    const inputType = PILOT_INPUT_TYPES.has(rawType)
      ? rawType as PilotUa1InputType
      : 'text';
    const nativeRole: PilotUa1ControlRole =
      inputType === 'checkbox' ? 'checkbox' :
        inputType === 'radio' ? 'radio' :
          inputType === 'range' ? 'slider' :
            inputType === 'number' ? 'spinbutton' :
              inputType === 'search' ? 'searchbox' :
                inputType === 'button' || inputType === 'submit' || inputType === 'reset' || inputType === 'image'
                  ? 'button'
                  : 'textbox';
    return { role: role ?? nativeRole, inputType };
  }
  if (tag === 'textarea') return { role: role ?? 'textbox', inputType: 'textarea' };
  if (tag === 'select') {
    const inputType = element.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
    return { role: role ?? (inputType === 'select-multiple' ? 'listbox' : 'combobox'), inputType };
  }
  if (tag === 'button') {
    const rawType = normalizedAttribute(element, 'type') || 'submit';
    const inputType: PilotUa1InputType =
      rawType === 'button' || rawType === 'reset' || rawType === 'submit' ? rawType : 'submit';
    return { role: role ?? 'button', inputType };
  }
  const contentEditable = normalizedAttribute(element, 'contenteditable');
  if (
    contentEditable === 'plaintext-only' ||
    contentEditable === 'true' ||
    contentEditable === '' && element.hasAttribute('contenteditable')
  ) {
    return { role: role ?? 'textbox', inputType: null };
  }
  return role === null ? null : { role, inputType: null };
}

/**
 * Two bounded passes, two ceilings.
 *
 * The structural pass is cheap -- tag, role and editability only, no computed
 * style -- and visits every element of the document and its open shadow roots
 * to find the answer surface: every control candidate, every <label>, every
 * frame, and their ancestor chains. It has the larger ceiling.
 *
 * The semantic walk does the expensive work (computed style, visibility, proxy
 * pairing, honeypot geometry, names) and visits only that surface, so a long
 * job description, a footer or any other prose spends none of its budget. Its
 * ceiling is unchanged. Exhausting either ceiling still fails the whole scan
 * closed: neither is a soft limit, and a page that cannot be bounded is not a
 * page that can be filled. Measured 2026-09-04 on public candidate pages: one
 * long posting walked 3719 of 4096 nodes under the single-pass rule, with
 * fewer than a hundred of them on the answer surface.
 */
const MAX_DISCOVERY_STRUCTURAL_NODES = 32_768;
const MAX_DISCOVERY_DOM_NODES = 4_096;
const MAX_DISCOVERY_SEMANTIC_NODES = 16_384;
const MAX_DISCOVERY_RELATION_STEPS = 65_536;
const MAX_ARIA_LABELLEDBY_TOKENS = 16;
const MAX_ARIA_POPUP_REFERENCES = 16;
/**
 * Bounded probe for controls inside a subtree the scan is about to prune.
 *
 * Hidden subtrees are never walked, so without this a control inside one is not
 * merely unemitted -- it is unobserved, and the producer would have no reason to
 * doubt its own completeness. The probe turns that silence into a recorded fact,
 * and it fails closed: exhausting it means the subtree could not be proven
 * control-free.
 */
const MAX_HIDDEN_PROBE_NODES = 256;
const MAX_RAW_SEMANTIC_FACTOR = 4;
/** Containers that hold everything and therefore prove nothing about ownership. */
const STRUCTURAL_CONTAINER_TAGS = new Set(['form', 'body', 'html']);
/**
 * Compiler kinds a visible leaf widget is known to proxy with a hidden,
 * author-declared native, in two explicit families. Membership is positive on
 * both sides: a declared native must be in one family to be a shim candidate,
 * and an anchor must be in the SAME family to own it. FILE, PASSWORD, BUTTON
 * and UNKNOWN are in neither: a declared file input or password is still a
 * question (or a refusal) of its own, and an emitted file input or password
 * never proves that a hidden text input beside it is its shim.
 */
const CHOICE_LEAF_KINDS = new Set(['RADIO_GROUP', 'CHECKBOX_SINGLE', 'SWITCH']);
const VALUE_LEAF_KINDS = new Set([
  'TEXT_SINGLE', 'TEXT_MULTILINE', 'COMBOBOX', 'SELECT_ONE', 'SELECT_MANY', 'NUMBER', 'DATE', 'RANGE',
]);
const SHIM_CANDIDATE_KINDS = new Set([...CHOICE_LEAF_KINDS, ...VALUE_LEAF_KINDS]);
type ShimFamily = 'CHOICE' | 'VALUE';
function shimFamilyOf(shape: ControlShape): ShimFamily | null {
  const kind = formalKindOfShape(shape);
  if (CHOICE_LEAF_KINDS.has(kind)) return 'CHOICE';
  if (VALUE_LEAF_KINDS.has(kind)) return 'VALUE';
  return null;
}
/** A field group is shallow; a deeper walk would start reading the whole form. */
const MAX_FIELD_GROUP_DEPTH = 4;

interface DiscoveryBudget {
  domNodes: number;
  semanticNodes: number;
  relationSteps: number;
}

function spend(budget: DiscoveryBudget, key: keyof DiscoveryBudget, amount = 1): void {
  budget[key] -= amount;
  if (budget[key] < 0) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
}

function normalizeSemantic(raw: string, maxLength: number): string | null {
  if (raw.length > maxLength * MAX_RAW_SEMANTIC_FACTOR) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length > maxLength) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  return normalized.length > 0 ? normalized : null;
}

function semanticText(
  node: Node | null,
  maxLength: number,
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): string | null {
  if (node === null) return null;
  const pieces: string[] = [];
  let rawLength = 0;
  const pending: Node[] = [node];
  spend(budget, 'semanticNodes');
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.nodeType === 1 &&
      isElementHidden(current as Element, view, budget, visibilityCache)
    ) continue;
    if (current.nodeType === 3) {
      const value = (current as Text).data;
      rawLength += value.length;
      if (rawLength > maxLength * MAX_RAW_SEMANTIC_FACTOR) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      pieces.push(value);
      continue;
    }
    const children = current.childNodes;
    spend(budget, 'semanticNodes', children.length);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
  return normalizeSemantic(pieces.join(' '), maxLength);
}

function semanticAttribute(element: Element, name: string, maxLength: number): string | null {
  const raw = element.getAttribute(name);
  return raw === null ? null : normalizeSemantic(raw, maxLength);
}

function parentElementAcrossShadow(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isElementHidden(
  element: Element,
  view: Window,
  budget: DiscoveryBudget,
  cache: WeakMap<Element, boolean>,
): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let cursor: Element | null = element;
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (
      cursor.hasAttribute('hidden') ||
      cursor.hasAttribute('inert') ||
      normalizedAttribute(cursor, 'aria-hidden', 16) === 'true'
    ) {
      cache.set(element, true);
      return true;
    }
    const style = view.getComputedStyle(cursor);
    const display = boundedStyle(style.display);
    const visibility = boundedStyle(style.visibility);
    const opacity = boundedStyle(style.opacity);
    const contentVisibility = boundedStyle(style.contentVisibility);
    const clipPath = boundedStyle(style.clipPath);
    const clip = boundedStyle(style.clip);
    const position = boundedStyle(style.position);
    const leftStyle = boundedStyle(style.left);
    const topStyle = boundedStyle(style.top);
    if (
      display === 'none' ||
      visibility === 'hidden' ||
      visibility === 'collapse' ||
      opacity === '0' ||
      contentVisibility === 'hidden' ||
      clipPath === 'inset(50%)' ||
      /^rect\(0(?:px)?,\s*0(?:px)?,\s*0(?:px)?,\s*0(?:px)?\)$/u.test(clip)
    ) {
      cache.set(element, true);
      return true;
    }
    if (position === 'absolute' || position === 'fixed') {
      const left = Number.parseFloat(leftStyle);
      const top = Number.parseFloat(topStyle);
      if ((Number.isFinite(left) && left < -1_000) || (Number.isFinite(top) && top < -1_000)) {
        cache.set(element, true);
        return true;
      }
    }
    cursor = parentElementAcrossShadow(cursor);
  }
  cache.set(element, false);
  return false;
}

/**
 * Proxy pairing is structural, never inferred from opacity, dimensions or a
 * library-specific class. The native form control must remain focusable in the
 * DOM; a separately verified visible surface supplies semantics only.
 */
function isProxyPairTarget(
  element: Element,
  kind: Readonly<{ inputType: PilotUa1InputType | null }>,
  view: Window,
  budget: DiscoveryBudget,
): boolean {
  const tag = element.tagName.toLowerCase();
  if (
    kind.inputType === null ||
    tag !== 'input' && tag !== 'textarea' && tag !== 'select' && tag !== 'button' ||
    isDisabled(element, budget)
  ) return false;
  const rawTabIndex = boundedAttribute(element, 'tabindex', 32);
  if (rawTabIndex !== null) {
    const tabIndex = Number(rawTabIndex.trim());
    if (!Number.isInteger(tabIndex) || tabIndex < 0) return false;
  }
  let cursor: Element | null = element;
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (
      cursor.hasAttribute('hidden') ||
      cursor.hasAttribute('inert') ||
      normalizedAttribute(cursor, 'aria-hidden', 16) === 'true'
    ) return false;
    const style = view.getComputedStyle(cursor);
    const display = boundedStyle(style.display);
    const visibility = boundedStyle(style.visibility);
    const contentVisibility = boundedStyle(style.contentVisibility);
    if (
      display === 'none' ||
      visibility === 'hidden' ||
      visibility === 'collapse' ||
      contentVisibility === 'hidden'
    ) return false;
    cursor = parentElementAcrossShadow(cursor);
  }
  return true;
}

/**
 * True when this element sits inside an active editing flow in its own tree.
 *
 * The walk is tree-scoped and stops at an exact `contenteditable="false"`: a
 * shadow root is a separate tree with its own flow, and a false region ends the
 * one it appears in. Starting at the element itself means a host counts as
 * being in its own flow, which is what both callers want.
 */
function withinEditingFlow(element: Element, budget: DiscoveryBudget): boolean {
  let cursor: Element | null = element;
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    const state = editableState(cursor);
    if (state === 'FALSE') return false;
    if (state === 'HOST') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

/**
 * An editing host is a question with an answer of its own, so nothing inside its
 * flow can stand in as some other control's surface.
 *
 * Consuming one does not rename that control: it deletes the editor's question,
 * and it leaves the editor's rendered text -- not the native -- as the thing any
 * later readback could see. Eligibility follows the flow rather than the
 * candidate's own attribute, because a plain wrapper that merely inherits
 * editability is still part of the editor; judging it by its own attribute lets
 * every surface source reach straight past it and delete the editor anyway.
 */
function canServeAsSurface(element: Element, budget: DiscoveryBudget): boolean {
  return !withinEditingFlow(element, budget);
}

function coveringInteractionSurface(
  element: Element,
  view: Window,
  budget: DiscoveryBudget,
  visibilityCache: WeakMap<Element, boolean>,
): Element | null {
  let cursor = parentElementAcrossShadow(element);
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (cursor.tagName.toLowerCase() === 'label') return null;
    // Bounds the search rather than supplying a surface.
    if (!canServeAsSurface(cursor, budget)) return null;
    const role = firstPilotRole(cursor);
    if (
      role !== null &&
      role !== NON_PILOT_ROLE &&
      !isElementHidden(cursor, view, budget, visibilityCache)
    ) return cursor;
    cursor = parentElementAcrossShadow(cursor);
  }
  return null;
}

function semanticRoot(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) return root;
  return element.ownerDocument;
}

function findLabelElements(
  element: Element,
  budget: DiscoveryBudget,
  labelsByRoot: WeakMap<Document | ShadowRoot, ReadonlyMap<string, readonly Element[]>>,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): readonly Element[] {
  const root = semanticRoot(element);
  const id = element.getAttribute('id');
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const append = (candidate: Element): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (isElementHidden(candidate, view, budget, visibilityCache)) return;
    candidates.push(candidate);
  };
  if (id !== null && id.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  if (id !== null && id.length > 0) {
    for (const candidate of labelsByRoot.get(root)?.get(id) ?? []) {
      spend(budget, 'relationSteps');
      append(candidate);
    }
  }
  let cursor = parentElementAcrossShadow(element);
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (cursor.tagName.toLowerCase() === 'label') {
      append(cursor);
      break;
    }
    cursor = parentElementAcrossShadow(cursor);
  }
  return candidates;
}

function labelText(
  candidates: readonly Element[],
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): string | null {
  const texts: string[] = [];
  for (const candidate of candidates) {
    const text = semanticText(
      candidate,
      PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
      budget,
      view,
      visibilityCache,
    );
    if (text !== null) texts.push(text);
    if (texts.join(' ').length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
  }
  const combined = texts.join(' ');
  return combined.length > 0 ? combined : null;
}

function findLabel(
  element: Element,
  budget: DiscoveryBudget,
  labelsByRoot: WeakMap<Document | ShadowRoot, ReadonlyMap<string, readonly Element[]>>,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): string | null {
  return labelText(
    findLabelElements(element, budget, labelsByRoot, view, visibilityCache),
    budget,
    view,
    visibilityCache,
  );
}

function findLegend(
  element: Element,
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): string | null {
  let cursor = parentElementAcrossShadow(element);
  while (cursor !== null) {
    spend(budget, 'relationSteps');
    if (cursor.tagName.toLowerCase() === 'fieldset') {
      for (const child of cursor.children) {
        spend(budget, 'relationSteps');
        if (child.tagName.toLowerCase() === 'legend') {
          if (isElementHidden(child, view, budget, visibilityCache)) return null;
          return semanticText(
            child,
            PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
            budget,
            view,
            visibilityCache,
          );
        }
      }
      return null;
    }
    cursor = parentElementAcrossShadow(cursor);
  }
  return null;
}

function labelledByText(
  element: Element,
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): string | null {
  const raw = element.getAttribute('aria-labelledby');
  if (raw === null) return null;
  if (raw.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH * 2) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  const root = semanticRoot(element);
  const getById = root instanceof Document
    ? root.getElementById.bind(root)
    : root.getElementById.bind(root);
  const parts: string[] = [];
  const tokens = raw.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length > MAX_ARIA_LABELLEDBY_TOKENS) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (token.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    spend(budget, 'relationSteps');
    const referenced = getById(token);
    if (referenced !== null && isElementHidden(referenced, view, budget, visibilityCache)) continue;
    const text = semanticText(
      referenced,
      PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
      budget,
      view,
      visibilityCache,
    );
    if (text !== null) {
      parts.push(text);
      if (parts.join(' ').length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
    }
  }
  const combined = parts.join(' ').trim();
  if (combined.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  return combined.length > 0 ? combined : null;
}

interface ControlSemanticSignals {
  readonly labelledBy: string | null;
  readonly ariaLabel: string | null;
  readonly label: string | null;
  readonly legend: string | null;
  readonly placeholder: string | null;
  readonly title: string | null;
  readonly nameFromContent: string | null;
}

function collectControlSemanticSignals(
  element: Element,
  role: PilotUa1ControlRole | null,
  label: string | null,
  legend: string | null,
  budget: DiscoveryBudget,
  view: Window,
  visibilityCache: WeakMap<Element, boolean>,
): ControlSemanticSignals {
  const permitsNameFromContent =
    role === 'button' || role === 'checkbox' || role === 'radio' ||
    role === 'switch' || role === 'option';
  return {
    labelledBy: labelledByText(element, budget, view, visibilityCache),
    ariaLabel: semanticAttribute(element, 'aria-label', PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH),
    label,
    legend,
    placeholder: semanticAttribute(
      element,
      'placeholder',
      PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
    ),
    title: semanticAttribute(element, 'title', PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH),
    nameFromContent: permitsNameFromContent
      ? semanticText(
        element,
        PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
        budget,
        view,
        visibilityCache,
      )
      : null,
  };
}

function resolveAccessibleName(signals: ControlSemanticSignals): string | null {
  return signals.labelledBy ??
    signals.ariaLabel ??
    signals.label ??
    signals.nameFromContent ??
    signals.placeholder ??
    signals.title;
}

function boundedSemanticSignalUnion(signals: ControlSemanticSignals): string {
  const combined = [...new Set([
    signals.labelledBy,
    signals.ariaLabel,
    signals.label,
    signals.legend,
    signals.placeholder,
    signals.title,
    signals.nameFromContent,
  ].filter((value): value is string => value !== null))].join(' ');
  if (combined.length > 2_048) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  return combined;
}

function autocompleteTokenAccepted(token: string): boolean {
  return parsePilotUa1DiscoveryPacket({
    schemaVersion: PILOT_UA1_SCHEMA_VERSION,
    binding: { origin: 'https://pilot.invalid', pathname: '/', domGeneration: ZERO_DIGEST },
    controls: [{
      identityDigest: ZERO_DIGEST,
      role: 'textbox',
      inputType: 'text',
      autocomplete: [token],
      required: false,
      accessibleName: null,
      label: null,
      legend: null,
      options: [],
      fileAccept: null,
    }],
    observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
  }).ok;
}

function autocompleteTokens(element: Element): readonly string[] {
  const raw = element.getAttribute('autocomplete');
  if (raw === null) return [];
  if (raw.length > 512) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  const tokens = raw.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length > 4) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  const accepted: string[] = [];
  for (const token of tokens) {
    if (accepted.includes(token) || !autocompleteTokenAccepted(token)) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    accepted.push(token);
  }
  return accepted;
}

function controlOptions(
  element: Element,
  path: string,
  view: Window,
  budget: DiscoveryBudget,
  visibilityCache: WeakMap<Element, boolean>,
  idTargets: WeakMap<Document | ShadowRoot, Map<string, Element | null>>,
): RawOptionSet {
  const kind = nativeControlKind(element);
  if (
    kind === null ||
    kind.role !== 'combobox' && kind.role !== 'listbox' && kind.role !== 'radiogroup' &&
      kind.inputType !== 'select-one' && kind.inputType !== 'select-multiple'
  ) return { options: [], elements: [], container: null, membershipComplete: true };
  const candidates: Element[] = [];
  const pending: Element[] = [];
  let associatedPopup: Element | null = null;
  let visited = 0;
  // A combobox popup may be a sibling or portal. Only the host's explicit,
  // tree-scoped ARIA relation can supply it; proximity and matching labels
  // are not ownership evidence. Missing/hidden popups remain unobserved.
  if (kind.role === 'combobox' && element.tagName.toLowerCase() !== 'select') {
    if (normalizedAttribute(element, 'aria-expanded', 16) === 'false') {
      return { options: [], elements: [], container: null, membershipComplete: true };
    }
    const relation = element.getAttribute('aria-controls') ?? element.getAttribute('aria-owns');
    if (relation !== null) {
      if (relation.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH * 2) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      const ids = relation.trim().split(/\s+/u).filter(Boolean);
      if (ids.length > MAX_ARIA_POPUP_REFERENCES) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      const root = semanticRoot(element);
      let popup: Element | null = null;
      for (const id of ids) {
        spend(budget, 'relationSteps');
        // A duplicate ID is an ambiguous relation even if one copy is hidden
        // or has a different role. The bounded structural pass indexes every
        // element in its own tree, so DOM ordering cannot select a winner.
        const target = idTargets.get(root)?.get(id);
        if (target === null) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
        if (
          target === undefined || target === element || firstPilotRole(target) !== 'listbox' ||
          isElementHidden(target, view, budget, visibilityCache)
        ) continue;
        // Several distinct lists are not one option set. Do not combine them
        // into an apparently complete choice list for an authorized answer.
        if (popup !== null && popup !== target) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
        popup = target;
      }
      if (popup === null) {
        return { options: [], elements: [], container: null, membershipComplete: true };
      }
      associatedPopup = popup;
    }
  }
  const optionRoot = associatedPopup ?? element;
  if (optionRoot.children.length > MAX_DISCOVERY_DOM_NODES) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  for (let index = optionRoot.children.length - 1; index >= 0; index -= 1) {
    pending.push(optionRoot.children[index]!);
  }
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    visited += 1;
    if (visited > MAX_DISCOVERY_DOM_NODES) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    spend(budget, 'relationSteps');
    const role = firstPilotRole(candidate);
    // A nested widget is not part of the explicitly associated popup's set.
    if (associatedPopup !== null && (role === 'listbox' || role === 'combobox')) continue;
    if (
      element.tagName.toLowerCase() === 'select'
        ? candidate.tagName.toLowerCase() === 'option'
        : role === 'option' || kind.role === 'radiogroup' && role === 'radio'
    ) candidates.push(candidate);
    if (visited + pending.length + candidate.children.length > MAX_DISCOVERY_DOM_NODES) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      pending.push(candidate.children[index]!);
    }
  }
  const options: RawOption[] = [];
  const optionElements: Element[] = [];
  let membershipComplete = true;
  candidates.forEach((option, index) => {
    if (isElementHidden(option, view, budget, visibilityCache)) {
      membershipComplete = false;
      return;
    }
    if (options.length >= PILOT_UA1_MAX_OPTIONS_PER_CONTROL) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    const name = semanticAttribute(option, 'aria-label', PILOT_UA1_MAX_OPTION_TEXT_LENGTH) ??
      semanticText(option, PILOT_UA1_MAX_OPTION_TEXT_LENGTH, budget, view, visibilityCache);
    if (name === null) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    if (isHoneypot({
      text: name,
      identities: [
        boundedAttribute(option, 'id'),
        boundedAttribute(option, 'class'),
        boundedAttribute(option, 'data-automation-id'),
        boundedAttribute(option, 'data-ui'),
        boundedAttribute(option, 'data-qa'),
      ],
    })) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    options.push({
      path: `${path}/option:${index}`,
      accessibleName: name,
      placeholder: isPlaceholderOption(option),
    });
    optionElements.push(option);
  });
  return { options, elements: optionElements, container: optionRoot, membershipComplete };
}

function defaultOpenShadowRoot(element: Element): ShadowRoot | null {
  const opener = (globalThis as {
    chrome?: { dom?: { openOrClosedShadowRoot?: (target: Element) => ShadowRoot | null } };
  }).chrome?.dom?.openOrClosedShadowRoot;
  if (typeof opener !== 'function') throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  return opener(element);
}

function boundedIdentity(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null && value.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) {
    throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  return value;
}

function isControlHoneypot(
  element: Element,
  text: string,
  view: Window,
  visibleLabelProxy: boolean,
): boolean {
  let geometry;
  if (!visibleLabelProxy) {
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    if (style.clip.length > 256 || style.clipPath.length > 256) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    geometry = {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      clip: style.clip,
      clipPath: style.clipPath,
      fontSize: Number.parseFloat(style.fontSize),
    };
    if (
      !Number.isFinite(geometry.width) ||
      !Number.isFinite(geometry.height) ||
      !Number.isFinite(geometry.left) ||
      !Number.isFinite(geometry.right) ||
      !Number.isFinite(geometry.fontSize)
    ) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  }
  return isHoneypot({
    text,
    identities: [
      boundedIdentity(element, 'name'),
      boundedIdentity(element, 'id'),
      boundedIdentity(element, 'class'),
      boundedIdentity(element, 'data-automation-id'),
      boundedIdentity(element, 'data-ui'),
      boundedIdentity(element, 'data-qa'),
    ],
    ...(geometry ? { geometry } : {}),
  });
}

/**
 * Structural row detection.
 *
 * A repeating group is a container whose element children hold at least one
 * observed control each and share the same member shape; those children are its
 * rows. Shape is DOM structure plus ARIA/accessible naming only — no vendor,
 * library, class name or CSS constant participates, and every raw string here
 * is a digest input that is salted and hashed before it leaves the page.
 *
 * This produces EVIDENCE, not a decision: what a row means for grouping, undo
 * or coverage stays with the semantic compiler, which is the single authority.
 * A container with no repeating cohort simply yields no row evidence.
 */
/**
 * Controls inside a subtree the scan is about to prune, and whether that number
 * is provably the whole of it.
 *
 * `proven: false` is not a smaller count. It means the probe stopped before it
 * could see everything, so the number is a floor, not a total -- and a floor
 * reported as a conservation count would read as exact. Callers must withhold
 * the sidecar instead of adding it.
 *
 * Only natives that could be questions are counted: a pure activator by the
 * compiler's own priority (`isPureActivatorShape`) is never one, whatever
 * hides it; a type=file or a form role on a button still is. A native the
 * author declared not-for-humans IS counted here, because inside a pruned
 * subtree nothing can show which emitted question it belongs to -- that
 * evidence exists only on the walked surface.
 */
interface PrunedSubtreeProbe {
  readonly controls: number;
  readonly proven: boolean;
}

function probePrunedSubtree(
  root: Element,
  skipRoot: boolean,
  openShadowRoot: (element: Element) => ShadowRoot | null,
): PrunedSubtreeProbe {
  const pending: Element[] = [root];
  let visited = 0;
  let controls = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > MAX_HIDDEN_PROBE_NODES) return { controls, proven: false };
    try {
      // The root of a proxy-pair candidate may still be emitted below; counting
      // it here as well would double count the same observation.
      if (!(skipRoot && current === root)) {
        const kind = nativeControlKind(current);
        if (kind !== null && !isPureActivatorShape(kind)) controls += 1;
      }
    } catch {
      return { controls, proven: false };
    }
    const children = current.children;
    // A host can be empty in light DOM and hold the whole form in its shadow
    // root. Both draw on one budget, and a boundary that cannot be opened is
    // unknown rather than empty.
    let shadow: ShadowRoot | null;
    try {
      shadow = openShadowRoot(current);
    } catch {
      return { controls, proven: false };
    }
    const shadowChildren = shadow === null ? 0 : shadow.children.length;
    if (visited + pending.length + children.length + shadowChildren > MAX_HIDDEN_PROBE_NODES) {
      return { controls, proven: false };
    }
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
    if (shadow !== null) {
      for (let index = shadow.children.length - 1; index >= 0; index -= 1) {
        pending.push(shadow.children[index]!);
      }
    }
  }
  return { controls, proven: true };
}

function detectRows(
  emitted: readonly Readonly<{ element: Element; base: Omit<RawControl, 'structure'> }>[],
  pathByElement: WeakMap<Element, string>,
  identities: PilotUa1ElementIdentities,
  budget: DiscoveryBudget,
): Map<number, PilotUa1RawRow> {
  const under = new Map<Element, number[]>();
  const parentOf = new Map<Element, Element | null>();
  const chains: Element[][] = [];
  emitted.forEach((entry, index) => {
    const chain: Element[] = [];
    let cursor = parentElementAcrossShadow(entry.element);
    while (cursor !== null) {
      spend(budget, 'relationSteps');
      chain.push(cursor);
      const beneath = under.get(cursor) ?? [];
      beneath.push(index);
      under.set(cursor, beneath);
      const parent = parentElementAcrossShadow(cursor);
      parentOf.set(cursor, parent);
      cursor = parent;
    }
    chains.push(chain);
  });

  const shapeOf = (candidate: Element): string =>
    `${candidate.tagName.toLowerCase()}|${(under.get(candidate) ?? []).map((index) => {
      const control = emitted[index]!.base;
      return `${control.role ?? ''}:${control.inputType ?? ''}:${control.accessibleName ?? ''}`;
    }).join(',')}`;

  const firstControlIndex = (candidate: Element): number => {
    const beneath = under.get(candidate);
    return beneath === undefined || beneath.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...beneath);
  };

  const childrenByParent = new Map<Element, Element[]>();
  for (const [candidate, parent] of parentOf) {
    if (parent === null) continue;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(candidate);
    childrenByParent.set(parent, siblings);
  }

  const rows = new Map<Element, PilotUa1RawRow>();
  for (const [parent, children] of childrenByParent) {
    const byShape = new Map<string, Element[]>();
    for (const child of children) {
      spend(budget, 'relationSteps');
      const shape = shapeOf(child);
      const cohort = byShape.get(shape) ?? [];
      cohort.push(child);
      byShape.set(shape, cohort);
    }
    for (const [shape, cohort] of byShape) {
      if (cohort.length < 2 && !identities.isKnownRowGroup(parent, shape)) continue;
      identities.rememberRowGroup(parent, shape);
      const groupPath = `${pathByElement.get(parent) ?? ''} ${shape}`;
      [...cohort]
        .sort((a, b) => firstControlIndex(a) - firstControlIndex(b))
        .forEach((rowElement, ordinal) => {
          rows.set(rowElement, Object.freeze({
            groupPath,
            ordinal,
            shapeKey: shape,
            rowElementSeq: identities.seq(rowElement),
          }));
        });
    }
  }

  const rowByControl = new Map<number, PilotUa1RawRow>();
  emitted.forEach((_entry, index) => {
    for (const ancestor of chains[index]!) {
      const row = rows.get(ancestor);
      if (row !== undefined) {
        rowByControl.set(index, row);
        return;
      }
    }
  });
  return rowByControl;
}

function collectRawControls(input: Readonly<{
  document: Document;
  view: Window;
  identities: PilotUa1ElementIdentities;
  observeAdditionalRoot: (root: ShadowRoot) => void;
  openShadowRoot: (element: Element) => ShadowRoot | null;
}>): RawScan {
  const documentRoot = input.document.documentElement;
  if (documentRoot === null) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
  const controls: RawControl[] = [];
  const budget: DiscoveryBudget = {
    domNodes: MAX_DISCOVERY_DOM_NODES,
    semanticNodes: MAX_DISCOVERY_SEMANTIC_NODES,
    relationSteps: MAX_DISCOVERY_RELATION_STEPS,
  };
  const visibilityCache = new WeakMap<Element, boolean>();
  /** Hidden natives the scan observed and counted exactly. */
  let hiddenNotObserved = 0;
  /**
   * False once the scan prunes a subtree it cannot prove it counted. A count is
   * evidence only when it is exact; "I ran out of probe" is not a smaller
   * number, it is an unknown one, so it withholds the sidecar instead of
   * inflating a total that would then look precise.
   */
  let conserved = true;
  const mutableLabels = new WeakMap<Document | ShadowRoot, Map<string, Element[]>>();
  const idTargets = new WeakMap<Document | ShadowRoot, Map<string, Element | null>>();
  const entries: Array<Readonly<{
    element: Element;
    path: string;
    hidden: boolean;
    proxyPairTarget: boolean;
    /**
     * Hidden, not a proxy candidate, and by its own HTML/ARIA facts either
     * never a question (a pure activator by the compiler's priority) or a
     * shim candidate (an author-declared non-input of a kind a visible widget
     * proxies). It keeps its path so the emission loop can account for it by
     * identity -- or, when ownership cannot be shown, by honest count.
     */
    hiddenNonQuestion: boolean;
  }>> = [];
  /**
   * Structural pass: which elements can matter to the answer surface. An
   * element is a candidate when it has control identity of its own
   * (`nativeControlKind`), is a <label> (it may name a control elsewhere), or
   * is a frame (an opaque boundary that must be accounted). The surface is the
   * candidates plus their ancestor chains, across open shadow roots. Nothing
   * outside it can hold a control, so pruning it loses no observation -- and
   * every shadow root is still handed to the mutation observer, as before.
   * Cheap by construction: no computed style, no geometry, no text.
   */
  const surface = new Set<Element>();
  const opaqueBoundaryPaths: string[] = [];
  {
    const joinSurface = (element: Element): void => {
      let cursor: Element | null = element;
      while (cursor !== null && !surface.has(cursor)) {
        spend(budget, 'relationSteps');
        surface.add(cursor);
        cursor = parentElementAcrossShadow(cursor);
      }
    };
    let structuralVisited = 0;
    const structuralPending: Element[] = [documentRoot];
    while (structuralPending.length > 0) {
      const element = structuralPending.pop()!;
      structuralVisited += 1;
      if (structuralVisited > MAX_DISCOVERY_STRUCTURAL_NODES) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      const id = element.getAttribute('id');
      if (id !== null && id.length <= PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH * 2) {
        const root = semanticRoot(element);
        let targets = idTargets.get(root);
        if (targets === undefined) {
          targets = new Map();
          idTargets.set(root, targets);
        }
        targets.set(id, targets.has(id) ? null : element);
      }
      const tag = element.tagName.toLowerCase();
      if (
        tag === 'label' || tag === 'iframe' || tag === 'frame' ||
        nativeControlKind(element) !== null
      ) joinSurface(element);
      const children = element.children;
      // An unopenable shadow root is unknown, never empty. Its host joins the
      // surface so the semantic walk reaches it and applies the rule it always
      // had: a hidden host withholds the sidecar through the prune probe, and a
      // visible one fails the scan closed.
      let shadow: ShadowRoot | null;
      try {
        shadow = input.openShadowRoot(element);
      } catch {
        shadow = null;
        joinSurface(element);
      }
      const shadowChildren = shadow === null ? 0 : shadow.children.length;
      if (
        structuralVisited + structuralPending.length + children.length + shadowChildren >
          MAX_DISCOVERY_STRUCTURAL_NODES
      ) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      for (let index = children.length - 1; index >= 0; index -= 1) {
        structuralPending.push(children[index]!);
      }
      if (shadow !== null) {
        input.observeAdditionalRoot(shadow);
        for (let index = shadow.children.length - 1; index >= 0; index -= 1) {
          structuralPending.push(shadow.children[index]!);
        }
      }
    }
  }

  // The root is on the surface exactly when the document holds any candidate;
  // a page with none has nothing to walk and nothing to account.
  const pending: Array<Readonly<{ element: Element; path: string }>> = surface.has(documentRoot)
    ? [{ element: documentRoot, path: '0' }]
    : [];

  const pushChildren = (parent: Element | ShadowRoot, prefix: string): void => {
    const children = parent.children;
    const visited = MAX_DISCOVERY_DOM_NODES - budget.domNodes;
    // Paths stay ordinal over ALL children, so an identity digest does not move
    // when prose siblings are pruned from the walk.
    const onSurface: Array<Readonly<{ element: Element; path: string }>> = [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (surface.has(child)) onSurface.push({ element: child, path: `${prefix}${index}` });
    }
    if (visited + pending.length + onSurface.length > MAX_DISCOVERY_DOM_NODES) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    for (let index = onSurface.length - 1; index >= 0; index -= 1) {
      pending.push(onSurface[index]!);
    }
  };

  // Semantic walk over the answer surface only. It is explicitly budgeted
  // before any label/control lookup, so a huge tail cannot hide behind
  // querySelectorAll, and prose that can hold no control never reaches it.
  while (pending.length > 0) {
    const { element, path } = pending.pop()!;
    spend(budget, 'domNodes');
    const kind = nativeControlKind(element);
    const proxyPairTarget = kind !== null && isProxyPairTarget(
      element,
      kind,
      input.view,
      budget,
    );
    const hidden = isElementHidden(element, input.view, budget, visibilityCache);
    // A hidden native that is not a proxy candidate and, by its own facts, is
    // either a pure activator (the compiler's own BUTTON kind -- a form role on
    // a button or a type=file is NOT one) or an author-declared non-input
    // (`aria-hidden="true"` and `tabindex="-1"`, the kernel interpreter's own
    // predicate) of a kind that visible widgets proxy. It is kept as an entry
    // so the emission loop can decide, with the final emitted questions known,
    // whether one of them owns it or it stays an honest hidden count.
    const hiddenNonQuestion = hidden && !proxyPairTarget && kind !== null && (
      isPureActivatorShape(kind) ||
      (isSiteDeclaredNonInput(element) && SHIM_CANDIDATE_KINDS.has(formalKindOfShape(kind)))
    );
    if (hidden) {
      // A pruned subtree is still an observation. Probe it before the prune so
      // the drop is recorded rather than silently lost. A focusable proxy
      // target may still be emitted below, so only its subtree is pruned; an
      // unfocusable one is pruned whole, itself included -- unless the emission
      // loop accounts for the root itself, in which case counting it here too
      // would double count.
      const probe = probePrunedSubtree(
        element,
        proxyPairTarget || hiddenNonQuestion,
        input.openShadowRoot,
      );
      if (probe.proven) hiddenNotObserved += probe.controls;
      else conserved = false;
    }
    if (hidden && !proxyPairTarget && !hiddenNonQuestion) continue;
    entries.push({ element, path, hidden, proxyPairTarget, hiddenNonQuestion });
    if (hidden) continue;

    const tag = element.tagName.toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      // An unhidden frame is an opaque boundary: not this document, not a
      // control, and not something the scan may silently step over. It gets an
      // identity so the consumer can owe it a DISCOVERY_INCOMPLETE row. Bounded
      // like every other accounting list, and never descended into. A hidden
      // frame never reaches here: it is pruned with its subtree above.
      if (opaqueBoundaryPaths.length >= PILOT_UA1_MAX_OPAQUE_BOUNDARIES) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      opaqueBoundaryPaths.push(path);
      continue;
    }
    if (tag === 'label') {
      const targetId = element.getAttribute('for');
      if (targetId !== null) {
        if (
          targetId.length > PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH ||
          /[\u0000-\u001f\u007f]/u.test(targetId)
        ) throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
        if (targetId.length > 0) {
          const root = semanticRoot(element);
          let rootLabels = mutableLabels.get(root);
          if (rootLabels === undefined) {
            rootLabels = new Map();
            mutableLabels.set(root, rootLabels);
          }
          const candidates = rootLabels.get(targetId) ?? [];
          candidates.push(element);
          rootLabels.set(targetId, candidates);
        }
      }
    }

    // Push light children first so the LIFO walk visits a shadow tree first,
    // preserving deterministic path ordering without bulk unbounded spreads.
    pushChildren(element, `${path}/`);
    const shadow = input.openShadowRoot(element);
    if (shadow !== null) {
      input.observeAdditionalRoot(shadow);
      pushChildren(shadow, `${path}/shadow:`);
    }
  }

  const proxyEvidenceByNative = new WeakMap<Element, Readonly<{
    label: string;
  }>>();
  const semanticProxyElements = new Set<Element>();
  const surfacesByNative = new WeakMap<Element, readonly Element[]>();
  const nativesBySurface = new Map<Element, Set<Element>>();
  for (const { element, proxyPairTarget } of entries) {
    if (!proxyPairTarget) continue;
    const surfaces = [...findLabelElements(
      element,
      budget,
      mutableLabels,
      input.view,
      visibilityCache,
    )];
    const coveringSurface = coveringInteractionSurface(
      element,
      input.view,
      budget,
      visibilityCache,
    );
    if (coveringSurface !== null && !surfaces.includes(coveringSurface)) {
      surfaces.push(coveringSurface);
    }
    surfacesByNative.set(element, surfaces);
    for (const surface of surfaces) {
      const natives = nativesBySurface.get(surface) ?? new Set<Element>();
      natives.add(element);
      nativesBySurface.set(surface, natives);
    }
  }
  const pathByElement = new WeakMap<Element, string>();
  for (const { element, path } of entries) pathByElement.set(element, path);

  /**
   * Non-button controls the scan observed, by path. A button is an activator,
   * not a question, so a field group that holds one control plus its button is
   * still a single-question group.
   */
  const answerableControlPaths = new Set<string>();
  for (const { element, path } of entries) {
    const kind = nativeControlKind(element);
    if (kind === null) continue;
    const activator = isActivatorKind(kind);
    // Answerable means a human could give it a value: not an activator, and
    // not effectively disabled. Both exclusions matter for the count below.
    if (
      !activator &&
      !isDisabled(element, budget) &&
      !questionRoleInertInEditingFlow(element, budget, input.view, visibilityCache, idTargets)
    ) answerableControlPaths.add(path);
  }

  /**
   * The surface a human actually sees for a visually hidden native that carries
   * no label and sits under no ARIA-roled ancestor — the styled-control and
   * drop-zone shapes. Evidence is structural containment plus visible text:
   * the nearest visible ancestor whose only non-button control is this one.
   *
   * That is deliberately narrow. The moment a second answerable control shares
   * the ancestor, the walk stops with no surface, because nothing value-free
   * could say which question the text belongs to. No vendor, library, class
   * name or pixel constant participates, and a control that is not focusable
   * never reaches this point.
   */
  const fieldGroupSurface = (element: Element): Element | null => {
    const ownPath = pathByElement.get(element);
    // The fallback exists to name one answerable question. An activator, or a
    // control nobody can answer, has no question for the surrounding text to
    // belong to -- so it never earns a surface of its own.
    if (ownPath === undefined || !answerableControlPaths.has(ownPath)) return null;
    let cursor = parentElementAcrossShadow(element);
    for (let depth = 0; cursor !== null && depth < MAX_FIELD_GROUP_DEPTH; depth += 1) {
      spend(budget, 'relationSteps');
      if (isElementHidden(cursor, input.view, budget, visibilityCache)) return null;
      // Same rule as the ancestor-role walk: an editing host bounds the search.
      if (!canServeAsSurface(cursor, budget)) return null;
      const cursorPath = pathByElement.get(cursor);
      if (cursorPath === undefined) return null;
      const prefix = `${cursorPath}/`;
      let answerable = 0;
      for (const candidate of answerableControlPaths) {
        if (candidate === ownPath || candidate.startsWith(prefix)) answerable += 1;
      }
      // Exactly one, and it must be this control: more is ambiguous, and fewer
      // means the text belongs to no question at all.
      if (answerable !== 1) return null;
      if (semanticText(
        cursor,
        PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH,
        budget,
        input.view,
        visibilityCache,
      ) !== null) return cursor;
      cursor = parentElementAcrossShadow(cursor);
    }
    return null;
  };

  for (const { element, hidden, proxyPairTarget } of entries) {
    if (!proxyPairTarget) continue;
    const uniqueSurfaces = (surfacesByNative.get(element) ?? []).filter(
      (surface) => {
        // Covers label-derived surfaces, which reach this filter from a source
        // neither walk above can bound.
        if (!canServeAsSurface(surface, budget)) return false;
        if (nativesBySurface.get(surface)?.size !== 1) return false;
        if (hidden) return true;
        const role = firstPilotRole(surface);
        return role !== null && role !== NON_PILOT_ROLE;
      },
    );
    let surfaces = uniqueSurfaces;
    let label = labelText(surfaces, budget, input.view, visibilityCache);
    if (label === null && hidden) {
      // No label and no roled ancestor: fall back to the field-group surface so
      // a question a human can plainly see stops disappearing from the packet.
      const group = fieldGroupSurface(element);
      if (group !== null) {
        surfaces = [group];
        label = labelText(surfaces, budget, input.view, visibilityCache);
      }
    }
    if (label === null) continue;
    proxyEvidenceByNative.set(element, { label });
    for (const proxyElement of surfaces) semanticProxyElements.add(proxyElement);
  }
  const emittedRoleByPath = new Map<string, PilotUa1ControlRole | null>();
  const suppressedPaths: string[] = [];
  const suppress = (path: string): void => {
    if (suppressedPaths.length >= PILOT_UA1_MAX_SUPPRESSED_CONTROLS) {
      throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
    }
    suppressedPaths.push(path);
  };

  /**
   * Hidden non-question candidates are decided AFTER the emission loop, against
   * the questions that were actually emitted -- never against a candidate set
   * that a later honeypot or editing-host rule may still remove.
   */
  const deferredHiddenNonQuestions: Array<Readonly<{ element: Element; path: string; kind: ControlShape }>> = [];
  /** Whether each emitted control was itself hidden (a proxy-paired native): such a control is a question, but not a visible anchor. */
  const emittedHidden = new WeakMap<Element, boolean>();
  const emitted: Array<Readonly<{ element: Element; base: Omit<RawControl, 'structure'>;
    optionElements: readonly Element[];
    optionContainer: Element | null;
    optionMembershipComplete: boolean;
    partial: Omit<PilotUa1RawStructureEntry, 'row'>; }>> = [];

  /** First emitted ancestor control carrying role=radiogroup, if any. */
  const enclosingGroupControlPath = (element: Element): string | null => {
    let cursor = parentElementAcrossShadow(element);
    while (cursor !== null) {
      spend(budget, 'relationSteps');
      const cursorPath = pathByElement.get(cursor);
      if (cursorPath !== undefined && emittedRoleByPath.get(cursorPath) === 'radiogroup') {
        return cursorPath;
      }
      cursor = parentElementAcrossShadow(cursor);
    }
    return null;
  };

  /**
   * Exact native grouping evidence: the control's real form owner, the root it
   * lives in, and its name. All three are needed and none is a stand-in.
   *
   * The owner is `HTMLInputElement.form`, not the nearest ancestor `<form>`: a
   * radio can be associated to a form it does not sit inside via `form=`, and
   * two radios sharing a name under different owners are two questions, not
   * one. The root separates same-name radios in different shadow trees, which
   * are likewise independent. Identities enter only as per-lifecycle opaque
   * tokens, and the raw name is a salted digest input that never leaves.
   */
  const groupKeyRawOf = (element: Element, kind: ReturnType<typeof nativeControlKind>): string | null => {
    if (kind === null || kind.inputType !== 'checkbox' && kind.inputType !== 'radio') return null;
    const name = boundedAttribute(element, 'name', PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH);
    if (name === null || name.length === 0) return null;
    let ownerToken = 'noform';
    const owner = (element as Partial<HTMLInputElement>).form;
    if (owner !== null && owner !== undefined) {
      ownerToken = `f${input.identities.seq(owner)}`;
    }
    const root = element.getRootNode();
    const rootToken = root instanceof ShadowRoot
      ? `s${input.identities.seq(root.host)}`
      : 'doc';
    return `${ownerToken} ${rootToken} ${name}`;
  };

  for (const { element, path, hidden, hiddenNonQuestion } of entries) {
    if (semanticProxyElements.has(element) && !proxyEvidenceByNative.has(element)) continue;
    const kind = nativeControlKind(element);
    if (kind !== null) {
      if (hiddenNonQuestion) {
        // Accounted exactly once, below, once the emitted questions are final
        // (the subtree probe skipped this element itself).
        deferredHiddenNonQuestions.push({ element, path, kind });
        continue;
      }
      if (emitted.length >= PILOT_UA1_MAX_CONTROLS) {
        throw new Error('PILOT_DISCOVERY_UNAVAILABLE');
      }
      // Not a control at all here, so it is neither emitted nor accounted.
      if (questionRoleInertInEditingFlow(element, budget, input.view, visibilityCache, idTargets)) continue;
      const proxyEvidence = proxyEvidenceByNative.get(element);
      if (hidden && proxyEvidence === undefined) {
        // Focusable, but with no surface a human could have read. The subtree
        // probe above deliberately skipped this element itself, so this is the
        // first and only time it is accounted: by identity if the compiler's
        // own priority says it is a pure action, by count otherwise.
        if (isPureActivatorShape(kind)) suppress(path);
        else hiddenNotObserved += 1;
        continue;
      }
      const label = proxyEvidence?.label ?? findLabel(
        element,
        budget,
        mutableLabels,
        input.view,
        visibilityCache,
      );
      const visibleLabelProxy = proxyEvidence !== undefined;
      const legend = visibleLabelProxy
        ? null
        : findLegend(element, budget, input.view, visibilityCache);
      const semanticSignals = visibleLabelProxy
        ? null
        : collectControlSemanticSignals(
          element,
          kind.role,
          label,
          legend,
          budget,
          input.view,
          visibilityCache,
        );
      const name = visibleLabelProxy ? label : resolveAccessibleName(semanticSignals!);
      const honeypotText = visibleLabelProxy
        ? label ?? ''
        : boundedSemanticSignalUnion(semanticSignals!);
      // Observed, deliberately not emitted, and recorded: a nested editable
      // descendant is part of its host's answer surface, so it reaches the
      // compiler as a decoy instead of a question nobody could ever answer.
      if (isControlHoneypot(
        element,
        honeypotText,
        input.view,
        visibleLabelProxy,
      ) || containedByEditingHost(element, budget)) {
        suppress(path);
        continue;
      }
      const optionSet = controlOptions(
        element,
        path,
        input.view,
        budget,
        visibilityCache,
        idTargets,
      );
      const options = optionSet.options;
      emittedRoleByPath.set(path, kind.role);
      emittedHidden.set(element, hidden);
      emitted.push(Object.freeze({
        element,
        optionElements: optionSet.elements,
        optionContainer: optionSet.container,
        optionMembershipComplete: optionSet.membershipComplete,
        base: {
          path,
          role: kind.role,
          inputType: kind.inputType,
          autocomplete: autocompleteTokens(element),
          required: element.hasAttribute('required') ||
            normalizedAttribute(element, 'aria-required', 16) === 'true',
          accessibleName: name,
          label,
          legend,
          options,
          fileAccept: fileAcceptShapeOf(element, kind.inputType),
        },
        partial: {
          path,
          elementSeq: input.identities.seq(element),
          groupKeyRaw: groupKeyRawOf(element, kind),
          memberOfGroupControlPath: enclosingGroupControlPath(element),
          placeholderShape: placeholderShapeOf(element),
          placeholderOptionIndexes: options.flatMap(
            (option, index) => (option.placeholder ? [index] : []),
          ),
          disabled: isDisabled(element, budget),
          readOnly: isReadOnly(element),
          multiple: isMultiple(element),
        },
      }));
    }
  }

  // A uniquely associated popup and its ARIA-only options are parts of the
  // emitted combobox, not additional questions. Keep each observed identity in
  // suppression accounting while leaving the combobox's exact option registry
  // intact. Ownership comes from the same complete membership used above;
  // standalone, shared, independently named or partially observed popups stay
  // separate. Native controls and editing hosts always retain their identity.
  type EmittedControl = (typeof emitted)[number];
  const emittedByElement = new Map(emitted.map((entry) => [entry.element, entry]));
  const popupOwners = new Map<Element, EmittedControl | null>();
  for (const entry of emitted) {
    const popup = entry.optionContainer;
    if (
      entry.base.role !== 'combobox' || popup === null || popup === entry.element ||
      emittedHidden.get(entry.element) === true || !entry.optionMembershipComplete ||
      entry.optionElements.length === 0
    ) continue;
    popupOwners.set(popup, popupOwners.has(popup) ? null : entry);
  }
  const popupParts = new Set<Element>();
  const ariaOnlyPart = (element: Element): boolean =>
    !NATIVE_CONTROL_TAGS.has(element.tagName.toLowerCase()) && editableState(element) !== 'HOST';
  for (const [popup, owner] of popupOwners) {
    if (owner === null) continue;
    const popupEntry = emittedByElement.get(popup);
    const ownerCaptions = new Set([owner.base.accessibleName, owner.base.label, owner.base.legend]);
    if (
      popupEntry === undefined || popupEntry.base.role !== 'listbox' || !ariaOnlyPart(popup) ||
      emittedHidden.get(popup) === true || !popupEntry.optionMembershipComplete ||
      popupEntry.optionContainer !== popup ||
      popupEntry.partial.multiple !== owner.partial.multiple ||
      popupEntry.optionElements.length !== owner.optionElements.length ||
      !popupEntry.optionElements.every((option, index) => option === owner.optionElements[index]) ||
      [popupEntry.base.accessibleName, popupEntry.base.label, popupEntry.base.legend]
        .some((caption) => caption !== null && !ownerCaptions.has(caption))
    ) continue;
    popupParts.add(popup);
    for (const option of owner.optionElements) {
      spend(budget, 'relationSteps');
      const optionEntry = emittedByElement.get(option);
      if (optionEntry?.base.role === 'option' && ariaOnlyPart(option)) popupParts.add(option);
    }
  }
  if (popupParts.size > 0) {
    const questions = emitted.filter((entry) => {
      if (!popupParts.has(entry.element)) return true;
      suppress(entry.base.path);
      return false;
    });
    emitted.splice(0, emitted.length, ...questions);
  }

  /**
   * Every question that was actually emitted, keyed by path and by element,
   * with what it would take to be an ANCHOR: the one question that may own a
   * hidden, author-declared non-input. Eligibility is positive and explicit:
   * the control itself is visible (a proxy-paired hidden native is a question,
   * not a visible anchor), enabled, carries a form-control leaf role (never a
   * group such as radiogroup, never an activator), and its compiler kind is in
   * one of the two shim families. FILE, PASSWORD and UNKNOWN are in neither, so
   * they can be the single question beside a declared native and still never
   * own it. A control the honeypot or editing-host rules removed is not here.
   */
  type AnchorCandidate = Readonly<{
    element: Element;
    path: string;
    /** Carries a form-control leaf role; a group such as radiogroup does not. */
    leaf: boolean;
    /** Non-null only for an eligible anchor: visible, enabled, leaf, in a shim family. */
    family: ShimFamily | null;
  }>;
  const emittedQuestionByPath = new Map<string, AnchorCandidate>();
  const emittedQuestionByElement = new Map<Element, AnchorCandidate>();
  for (const entry of emitted) {
    const shape: ControlShape = { role: entry.base.role, inputType: entry.base.inputType };
    if (isPureActivatorShape(shape)) continue;
    const leaf = shape.role !== null && FORM_ROLES.has(shape.role);
    const eligible = leaf && emittedHidden.get(entry.element) !== true && !entry.partial.disabled;
    const candidate: AnchorCandidate = Object.freeze({
      element: entry.element,
      path: entry.base.path,
      leaf,
      family: eligible ? shimFamilyOf(shape) : null,
    });
    emittedQuestionByPath.set(entry.base.path, candidate);
    emittedQuestionByElement.set(entry.element, candidate);
  }
  /**
   * Whether one emitted question demonstrably owns a hidden, author-declared
   * non-input, so that the declared native is that question's carrier or
   * validation shim rather than a question of its own. Both accepted shapes are
   * structural, value-free, and share one anchor eligibility (above) and one
   * independence check:
   *
   *   0. a declared native that carries its own naming -- a <label for> of its
   *      own, aria-labelledby or aria-label -- is an independent field, whatever
   *      sits beside it, and is never owned;
   *   1. the declared native lies inside an emitted leaf control: that control
   *      is the scope, and owns it only if it is the SOLE emitted question in
   *      that scope (itself, with no independent question emitted beneath it)
   *      and an eligible anchor of the same family -- the native carrier behind
   *      a role=radio/checkbox/combobox surface. A leaf that holds further
   *      emitted questions, or is ineligible or of the other family, settles the
   *      question as not owned. An enclosing GROUP (radiogroup) is a legitimate
   *      container of every option and is never an anchor itself; the walk
   *      continues to the field container below;
   *   2. otherwise the declared native's own field container -- its nearest
   *      wrapping <label> if it has one, else its parent element; never form,
   *      body or the document element -- is the scope: it must hold exactly one
   *      emitted question of any kind, and that one must be an eligible anchor
   *      of the same family.
   *
   * Both paths run the SAME sole-question check over the same bounded emitted
   * set, so neither can be weaker than the other. A shared layout wrapper
   * further up is not evidence, a role name is not proof that a widget has no
   * independent questions inside, and neither is "the only thing nearby": two
   * independently labelled fields under one parent stay two fields. Anything
   * not shown here stays an honest hidden count.
   */
  /**
   * The one emitted question within `scope` (the scope itself if emitted, plus
   * everything emitted beneath it), or null when there are none or several.
   */
  const soleEmittedQuestionWithin = (scope: Element): AnchorCandidate | null => {
    const scopePath = pathByElement.get(scope);
    if (scopePath === undefined) return null;
    const prefix = `${scopePath}/`;
    let sole: AnchorCandidate | null = null;
    for (const candidate of emittedQuestionByPath.values()) {
      if (candidate.path !== scopePath && !candidate.path.startsWith(prefix)) continue;
      if (sole !== null) return null;
      sole = candidate;
    }
    return sole;
  };
  const ownedWithin = (scope: Element, declaredFamily: ShimFamily): boolean => {
    const sole = soleEmittedQuestionWithin(scope);
    return sole !== null && sole.family === declaredFamily;
  };
  const ownedByOneEmittedQuestion = (element: Element, kind: ControlShape): boolean => {
    const declaredFamily = shimFamilyOf(kind);
    if (declaredFamily === null) return false;
    // 0 · own naming = independent field.
    if (
      normalizeSemantic(element.getAttribute('aria-label') ?? '', PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) !== null ||
      normalizeSemantic(element.getAttribute('aria-labelledby') ?? '', PILOT_UA1_MAX_SEMANTIC_TEXT_LENGTH) !== null
    ) return false;
    const ownId = element.getAttribute('id');
    if (ownId !== null && ownId.length > 0) {
      for (const _label of mutableLabels.get(semanticRoot(element))?.get(ownId) ?? []) return false;
    }
    // 1 · enclosing emitted control = the widget.
    let wrappingLabel: Element | null = null;
    let cursor = parentElementAcrossShadow(element);
    for (let depth = 0; cursor !== null && depth < MAX_FIELD_GROUP_DEPTH; depth += 1) {
      spend(budget, 'relationSteps');
      const widget = emittedQuestionByElement.get(cursor);
      // An enclosing leaf settles ownership either way, through the same
      // sole-question check the fallback uses; an enclosing group is passed.
      if (widget !== undefined && widget.leaf) return ownedWithin(cursor, declaredFamily);
      if (wrappingLabel === null && cursor.tagName.toLowerCase() === 'label') wrappingLabel = cursor;
      cursor = parentElementAcrossShadow(cursor);
    }
    // 2 · own field container: exactly one emitted question, an eligible anchor of the same family.
    const container = wrappingLabel ?? parentElementAcrossShadow(element);
    if (container === null || STRUCTURAL_CONTAINER_TAGS.has(container.tagName.toLowerCase())) return false;
    return ownedWithin(container, declaredFamily);
  };
  for (const { element, path, kind } of deferredHiddenNonQuestions) {
    // A pure activator is suppressed by identity outright. An author-declared
    // non-input is suppressed only when one emitted question demonstrably owns
    // it; otherwise it stays an honest hidden count.
    if (isPureActivatorShape(kind) || ownedByOneEmittedQuestion(element, kind)) suppress(path);
    else hiddenNotObserved += 1;
  }

  const rowByControl = detectRows(emitted, pathByElement, input.identities, budget);
  for (const [index, entry] of emitted.entries()) {
    controls.push({
      ...entry.base,
      structure: Object.freeze({ ...entry.partial, row: rowByControl.get(index) ?? null }),
    });
  }
  return {
    controls,
    elements: emitted.map((entry) => entry.element),
    optionElements: emitted.map((entry) => entry.optionElements),
    optionContainers: emitted.map((entry) => entry.optionContainer),
    optionMembershipComplete: emitted.map((entry) => entry.optionMembershipComplete),
    suppressedPaths,
    hiddenNotObservedCount: hiddenNotObserved,
    conserved,
    opaqueBoundaryPaths,
  };
}

function rawScansMatch(left: RawScan, right: RawScan): boolean {
  if (
    left.elements.length !== left.controls.length ||
    right.elements.length !== right.controls.length ||
    left.elements.length !== right.elements.length ||
    left.optionElements.length !== left.controls.length ||
    right.optionElements.length !== right.controls.length ||
    left.optionContainers.length !== left.controls.length ||
    right.optionContainers.length !== right.controls.length ||
    left.optionMembershipComplete.length !== left.controls.length ||
    right.optionMembershipComplete.length !== right.controls.length ||
    !left.elements.every((element, index) => right.elements[index] === element) ||
    !left.optionElements.every((elements, controlIndex) => {
      const current = right.optionElements[controlIndex];
      return current !== undefined && elements.length === current.length &&
        elements.every((element, optionIndex) => current[optionIndex] === element);
    }) ||
    !left.optionMembershipComplete.every(
      (complete, index) => right.optionMembershipComplete[index] === complete,
    ) ||
    !left.optionContainers.every(
      (container, index) => right.optionContainers[index] === container,
    )
  ) return false;
  return JSON.stringify({
    controls: left.controls,
    suppressedPaths: left.suppressedPaths,
    hiddenNotObservedCount: left.hiddenNotObservedCount,
    conserved: left.conserved,
    opaqueBoundaryPaths: left.opaqueBoundaryPaths,
  }) === JSON.stringify({
    controls: right.controls,
    suppressedPaths: right.suppressedPaths,
    hiddenNotObservedCount: right.hiddenNotObservedCount,
    conserved: right.conserved,
    opaqueBoundaryPaths: right.opaqueBoundaryPaths,
  });
}

async function materializePacket(input: Readonly<{
  controls: readonly RawControl[];
  suppressedPaths: readonly string[];
  hiddenNotObservedCount: number;
  opaqueBoundaryPaths: readonly string[];
  lifecycleNonce: string;
  mutationGeneration: number;
  origin: string;
  pathname: string;
  digest: (value: string) => Promise<string | null>;
}>): Promise<PilotUa1DiscoveryPacket | null> {
  const controls: PilotUa1VisibleControl[] = [];
  for (const raw of input.controls) {
    const identityDigest = await input.digest(
      `${input.lifecycleNonce}:control:${raw.path}`,
    );
    if (identityDigest === null) return null;
    const options = [];
    for (const rawOption of raw.options) {
      const optionDigest = await input.digest(
        `${input.lifecycleNonce}:option:${rawOption.path}`,
      );
      if (optionDigest === null) return null;
      options.push({
        identityDigest: optionDigest,
        accessibleName: rawOption.accessibleName,
      });
    }
    controls.push({
      identityDigest,
      role: raw.role,
      inputType: raw.inputType,
      autocomplete: [...raw.autocomplete],
      required: raw.required,
      accessibleName: raw.accessibleName,
      label: raw.label,
      legend: raw.legend,
      options,
      fileAccept: raw.fileAccept,
    });
  }
  const suppressedControls: string[] = [];
  for (const path of input.suppressedPaths) {
    const digest = await input.digest(`${input.lifecycleNonce}:control:${path}`);
    if (digest === null) return null;
    suppressedControls.push(digest);
  }
  // Its own salt namespace: a boundary can never collide with a control or a
  // decoy digested at the same address, and the parser refuses any overlap.
  const opaqueBoundaries: string[] = [];
  for (const path of input.opaqueBoundaryPaths) {
    const digest = await input.digest(`${input.lifecycleNonce}:boundary:${path}`);
    if (digest === null) return null;
    opaqueBoundaries.push(digest);
  }
  const observation = {
    suppressedControls,
    hiddenNotObservedCount: input.hiddenNotObservedCount,
    opaqueBoundaries,
  };
  const structureSeal = await input.digest(JSON.stringify(controls));
  if (structureSeal === null) return null;
  const domGeneration = await input.digest(
    `${input.lifecycleNonce}:generation:${input.mutationGeneration}:${structureSeal}`,
  );
  if (domGeneration === null) return null;
  const parsed = parsePilotUa1DiscoveryPacket({
    schemaVersion: PILOT_UA1_SCHEMA_VERSION,
    binding: {
      origin: input.origin,
      pathname: input.pathname,
      domGeneration,
    },
    controls,
    observation,
  });
  return parsed.ok ? parsed.value : null;
}

function isPotentialPilotUa1Message(value: unknown): boolean {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    return descriptor !== undefined && 'value' in descriptor &&
      descriptor.value === 'pilot-ua1/discover-exact-page';
  } catch {
    return false;
  }
}

function senderIsActionBackground(
  sender: PilotUa1MessageSender,
  extensionId: string,
  expectedBackgroundUrl: string,
): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(sender);
    const id = descriptors.id;
    const url = descriptors.url;
    const tab = descriptors.tab;
    return id !== undefined && 'value' in id && id.value === extensionId &&
      url !== undefined && 'value' in url && url.value === expectedBackgroundUrl &&
      tab === undefined;
  } catch {
    return false;
  }
}

function createExactElementRegistry(input: Readonly<{
  observation: PilotUa1Observation;
  scan: RawScan;
  observers: readonly PilotUa1MutationObserverLike[];
  generation: () => number;
  expectedGeneration: number;
  document: Document;
  documentRoot: Element;
  view: Window;
  location: Location;
  exactHref: string;
  revalidateScan: () => RawScan;
}>): PilotUa1ExactElementRegistry | null {
  const byDigest = new Map<string, Readonly<{ element: Element; elementToken: string }>>();
  const optionsByDigest = new Map<string, Readonly<{
    elementToken: string;
    container: Element | null;
    membershipComplete: boolean;
    options: readonly Readonly<{ identityDigest: string; element: Element }>[];
  }>>();
  if (
    input.scan.elements.length !== input.observation.packet.controls.length ||
    input.scan.optionElements.length !== input.scan.elements.length ||
    input.scan.optionContainers.length !== input.scan.elements.length ||
    input.scan.optionMembershipComplete.length !== input.scan.elements.length
  ) return null;
  const sidecar = input.observation.structure;
  if (sidecar !== null) {
    if (sidecar.entries.length !== input.scan.elements.length) return null;
    for (let index = 0; index < input.scan.elements.length; index += 1) {
      const control = input.observation.packet.controls[index];
      const entry = sidecar.entries[index];
      const element = input.scan.elements[index];
      const optionElements = input.scan.optionElements[index];
      const optionContainer = input.scan.optionContainers[index];
      if (
        control === undefined || entry === undefined || element === undefined ||
        optionElements === undefined || optionElements.length !== control.options.length ||
        entry.identityDigest !== control.identityDigest ||
        byDigest.has(control.identityDigest)
      ) return null;
      byDigest.set(control.identityDigest, Object.freeze({
        element,
        elementToken: entry.elementToken,
      }));
      const seenOptionDigests = new Set<string>();
      const options: Array<Readonly<{ identityDigest: string; element: Element }>> = [];
      for (let optionIndex = 0; optionIndex < control.options.length; optionIndex += 1) {
        const option = control.options[optionIndex];
        const optionElement = optionElements[optionIndex];
        if (
          option === undefined || optionElement === undefined ||
          seenOptionDigests.has(option.identityDigest)
        ) return null;
        seenOptionDigests.add(option.identityDigest);
        options.push(Object.freeze({
          identityDigest: option.identityDigest,
          element: optionElement,
        }));
      }
      optionsByDigest.set(control.identityDigest, Object.freeze({
        elementToken: entry.elementToken,
        container: optionContainer ?? null,
        membershipComplete: input.scan.optionMembershipComplete[index] === true,
        options: Object.freeze(options),
      }));
    }
  }

  let disposed = false;
  let dirty = false;
  const markDirty = () => { dirty = true; };
  const navigationEvents = ['pagehide', 'beforeunload', 'popstate', 'hashchange'] as const;
  for (const type of navigationEvents) input.view.addEventListener(type, markDirty, true);

  const nodeIsConnected = (node: Node): boolean => {
    try {
      const getter = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')?.get;
      return getter !== undefined && getter.call(node) === true;
    } catch {
      return false;
    }
  };
  const current = (): boolean => {
    if (disposed || dirty) return false;
    try {
      for (const observer of input.observers) {
        if (observer.takeRecords().length > 0) dirty = true;
      }
      if (
        dirty ||
        input.generation() !== input.expectedGeneration ||
        input.document.documentElement !== input.documentRoot ||
        input.view.top !== input.view.self ||
        canonicalizePilotUa1ActionUrl(input.location.href) !== input.exactHref
      ) {
        dirty = true;
        return false;
      }
      for (const record of byDigest.values()) {
        if (!nodeIsConnected(record.element) || record.element.ownerDocument !== input.document) {
          dirty = true;
          return false;
        }
      }
      for (const optionSet of optionsByDigest.values()) {
        if (
          optionSet.container !== null &&
          (!nodeIsConnected(optionSet.container) || optionSet.container.ownerDocument !== input.document)
        ) {
          dirty = true;
          return false;
        }
        for (const option of optionSet.options) {
          if (!nodeIsConnected(option.element) || option.element.ownerDocument !== input.document) {
            dirty = true;
            return false;
          }
        }
      }
      return true;
    } catch {
      dirty = true;
      return false;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    dirty = true;
    byDigest.clear();
    optionsByDigest.clear();
    for (const type of navigationEvents) input.view.removeEventListener(type, markDirty, true);
    for (const observer of input.observers) {
      try {
        observer.disconnect();
      } catch {
        // A failed observer cleanup cannot make a retired generation current.
      }
    }
  };
  const resolveExact = (
    identity: Readonly<{ identityDigest: string; elementToken: string }>,
  ): Element | null => {
    if (!current()) return null;
    try {
      const record = byDigest.get(identity.identityDigest);
      if (record === undefined || record.elementToken !== identity.elementToken) return null;
      return current() ? record.element : null;
    } catch {
      dirty = true;
      return null;
    }
  };
  const revalidate = (): boolean => {
    if (!current()) return false;
    try {
      // This is intentionally a full bounded parity read, not a selector
      // lookup. UA-1 applies the same DOM/relation budgets and honeypot,
      // visibility, geometry and semantic classification as first sight.
      // `rawScansMatch` additionally requires every exact Element in order.
      if (!rawScansMatch(input.revalidateScan(), input.scan)) dirty = true;
      return !dirty && current();
    } catch {
      dirty = true;
      return false;
    }
  };
  return Object.freeze({
    resolve(identity: Readonly<{ identityDigest: string; elementToken: string }>): Element | null {
      return resolveExact(identity);
    },
    resolveForWrite(
      identity: Readonly<{ identityDigest: string; elementToken: string }>,
    ): Element | null {
      return revalidate() ? resolveExact(identity) : null;
    },
    resolveOptionsForWrite(
      identity: Readonly<{ identityDigest: string; elementToken: string }>,
    ): Readonly<{
      container: Element;
      options: readonly Readonly<{ identityDigest: string; element: Element }>[],
    }> | null {
      if (!revalidate()) return null;
      try {
        const control = byDigest.get(identity.identityDigest);
        const optionSet = optionsByDigest.get(identity.identityDigest);
        if (
          control === undefined || control.elementToken !== identity.elementToken ||
          optionSet === undefined || optionSet.elementToken !== identity.elementToken ||
          optionSet.container === null || !optionSet.membershipComplete
        ) return null;
        return current()
          ? Object.freeze({ container: optionSet.container, options: optionSet.options })
          : null;
      } catch {
        dirty = true;
        return null;
      }
    },
    isCurrent: current,
    dispose,
  });
}

export function createPilotUa1ContentRuntime(input: Readonly<{
  enabled: boolean;
  extensionId: string;
  expectedBackgroundUrl: string;
  document?: Document;
  view?: Window;
  location?: Location;
  now?: () => number;
  lifecycleNonce?: string;
  digest?: (value: string) => Promise<string | null>;
  scanPacket?: typeof scanPilotUa1Discovery;
  /** In-process sink for the completed observation; absent means nothing consumes it. */
  observe?: (observation: PilotUa1Observation) => void;
  /**
   * Content-local ownership sink for an exact live Element generation. This
   * object must never cross `runtime.sendMessage`, storage, logs or telemetry.
   */
  observeLive?: (observation: PilotUa1LiveObservation) => void;
  /** Dormant until a verified rule producer supplies it; no published wire change. */
  /** Syntax-only fixture seam. Formal consumers use the verified runtime handle. */
  wizardDeclaration?: WizardReadOnlyDeclaration;
  wizardRuntime?: PilotWizardRuntime;
  observerFactory?: PilotUa1MutationObserverFactory;
  openShadowRoot?: (element: Element) => ShadowRoot | null;
}>): (message: unknown, sender: PilotUa1MessageSender) => Promise<PilotUa1DiscoveryRuntimeResponse> {
  const doc = input.document ?? document;
  const view = input.view ?? window;
  const loc = input.location ?? location;
  const now = input.now ?? Date.now;
  const digest = input.digest ?? ((value) => sha256Hex(value));
  const scanPacket = input.scanPacket ?? scanPilotUa1Discovery;
  const lifecycleNonce = !input.enabled
    ? null
    : input.lifecycleNonce ?? randomRequestId(crypto.getRandomValues.bind(crypto));
  const observerFactory = input.observerFactory ?? ((callback) =>
    new MutationObserver((records) => callback(records)));
  const openShadowRoot = input.openShadowRoot ?? defaultOpenShadowRoot;
  const consumedRequests = new Map<string, number>();
  const identities = createPilotUa1ElementIdentities();
  let requestGeneration = 0;
  let scanInFlight = false;
  /**
   * Epoch index of the NEXT observation. A StructureSidecarV1 binds to it, and
   * `compileGraph` fails closed when it does not match the epoch's position in
   * the chain — so a consumer that drops an observation degrades to today's
   * behaviour instead of re-grouping against a stale sidecar.
   */
  let nextEpochIndex = 0;
  let activeLiveRegistry: PilotUa1ExactElementRegistry | null = null;

  return async (message, sender) => {
    if (!input.enabled) return PILOT_UA1_DISCOVERY_DISABLED_RESPONSE;
    const request = parsePilotUa1DiscoveryRequest(message);
    if (
      request === null ||
      !senderIsActionBackground(sender, input.extensionId, input.expectedBackgroundUrl)
    ) {
      return pilotUa1DiscoveryFailure('PILOT_NOT_USER_TRIGGERED');
    }

    let currentTime: number;
    try {
      currentTime = now();
    } catch {
      return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
    }
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
      return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
    }
    for (const [requestId, tombstoneUntil] of consumedRequests) {
      if (tombstoneUntil < currentTime) consumedRequests.delete(requestId);
    }
    if (consumedRequests.has(request.requestId)) {
      return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
    }
    if (consumedRequests.size >= MAX_CONSUMED_REQUESTS) {
      return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
    }
    // Tombstone before freshness/target checks. A well-formed request gets one
    // attempt even if it was stale or delivered to the wrong page.
    consumedRequests.set(
      request.requestId,
      Math.min(request.expiresAtMs, currentTime + 5_000),
    );

    if (
      request.issuedAtMs > currentTime ||
      request.expiresAtMs < currentTime ||
      lifecycleNonce === null
    ) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
    if (scanInFlight) return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');

    // A new authenticated attempt supersedes every prior live generation,
    // including when the new attempt later fails closed.
    activeLiveRegistry?.dispose();
    activeLiveRegistry = null;

    const scanObservers: PilotUa1MutationObserverLike[] = [];
    const captureWizard = (input.wizardRuntime !== undefined || input.wizardDeclaration !== undefined) && input.observeLive !== undefined;
    let wizardHistoryDrift = false;
    const markWizardHistoryDrift = (): void => { wizardHistoryDrift = true; };
    const wizardNavigationEvents = ['pagehide', 'pageshow', 'beforeunload', 'popstate', 'hashchange'] as const;
    const wizardListeners: Array<(typeof wizardNavigationEvents)[number]> = [];
    const readWizard = (): DeclaredWizardStep | null => {
      if (!captureWizard) return null;
      const budget: DiscoveryBudget = {
        domNodes: MAX_DISCOVERY_DOM_NODES,
        semanticNodes: MAX_DISCOVERY_SEMANTIC_NODES,
        relationSteps: MAX_DISCOVERY_RELATION_STEPS,
      };
      const cache = new WeakMap<Element, boolean>();
      const isVisible = (element: Element): boolean => {
          if (isElementHidden(element, view, budget, cache)) return false;
          const rect = element.getBoundingClientRect();
          return Number.isFinite(rect.width) && rect.width > 0 && Number.isFinite(rect.height) && rect.height > 0;
      };
      const result = input.wizardRuntime !== undefined
        ? readPilotWizardRuntimeStep(input.wizardRuntime, isVisible)
        : readDeclaredWizardStep({ declaration: input.wizardDeclaration!, document: doc, isVisible });
      return result.ok ? result.value : null;
    };
    let observersTransferred = false;
    scanInFlight = true;
    let mutationGeneration = requestGeneration += 1;
    const advanceGeneration = (records: readonly MutationRecord[]): void => {
      if (records.length === 0) return;
      mutationGeneration = Math.min(Number.MAX_SAFE_INTEGER, mutationGeneration + records.length);
    };
    try {
      if (view.top !== view.self) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      const beforeHref = canonicalizePilotUa1ActionUrl(loc.href);
      if (beforeHref === null) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      const beforeUrl = new URL(beforeHref);
      if (
        beforeUrl.origin !== request.targetOrigin ||
        beforeUrl.pathname !== request.targetPathname ||
        await digest(beforeUrl.href) !== request.targetUrlDigest
      ) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');

      const documentRoot = doc.documentElement;
      if (documentRoot === null) return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
      const rootObserver = observerFactory(advanceGeneration);
      rootObserver.observe(documentRoot, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      scanObservers.push(rootObserver);
      advanceGeneration(rootObserver.takeRecords());
      const generationBefore = mutationGeneration;

      if (captureWizard) {
        for (const type of wizardNavigationEvents) {
          view.addEventListener(type, markWizardHistoryDrift, true);
          wizardListeners.push(type);
        }
      }
      const wizardBefore = readWizard();
      // Request generations intentionally differ between scans. Stability is
      // proven inside this one observer lifetime, never by equating two runs.
      if (wizardBefore !== null) await new Promise<void>((resolve) => view.setTimeout(resolve, 450));
      const wizardAfter = readWizard();
      if (wizardBefore !== null && (wizardAfter === null || !sameDeclaredWizardStep(wizardBefore, wizardAfter))) {
        return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      }

      const observedShadowRoots = new Set<ShadowRoot>();
      const observeShadowRoot = (root: ShadowRoot): void => {
        if (observedShadowRoots.has(root)) return;
        observedShadowRoots.add(root);
        const observer = observerFactory(advanceGeneration);
        observer.observe(root, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        scanObservers.push(observer);
      };
      const scan = collectRawControls({
        document: doc,
        view,
        identities,
        openShadowRoot,
        observeAdditionalRoot: observeShadowRoot,
      });
      const packet = await materializePacket({
        controls: scan.controls,
        suppressedPaths: scan.suppressedPaths,
        hiddenNotObservedCount: scan.hiddenNotObservedCount,
        opaqueBoundaryPaths: scan.opaqueBoundaryPaths,
        lifecycleNonce,
        mutationGeneration: generationBefore,
        origin: request.targetOrigin,
        pathname: request.targetPathname,
        digest,
      });
      if (packet === null) return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
      // Pure over already-collected evidence: no DOM read, so the drift checks
      // below still cover everything this observation asserts.
      const structure = await buildPilotUa1StructureSidecar({
        controls: packet.controls,
        raw: scan.controls.map((control) => control.structure),
        lifecycleNonce,
        epochIndex: nextEpochIndex,
        suppressedCount: packet.observation.suppressedControls.length,
        hiddenNotObservedCount: packet.observation.hiddenNotObservedCount,
        conserved: scan.conserved,
        digest,
      });

      advanceGeneration(rootObserver.takeRecords());
      for (const observer of scanObservers) advanceGeneration(observer.takeRecords());
      const afterHref = canonicalizePilotUa1ActionUrl(loc.href);
      if (afterHref === null) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      const afterUrl = new URL(afterHref);
      const afterUrlDigest = await digest(afterUrl.href);
      // MutationObserver cannot see attachShadow/CSSOM/geometry drift. This
      // last bounded parity read is deliberately after the final await.
      const scanAfterHash = collectRawControls({
        document: doc,
        view,
        identities,
        openShadowRoot,
        observeAdditionalRoot: observeShadowRoot,
      });
      if (!rawScansMatch(scanAfterHash, scan)) {
        return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      }
      advanceGeneration(rootObserver.takeRecords());
      for (const observer of scanObservers) advanceGeneration(observer.takeRecords());
      const finalHref = canonicalizePilotUa1ActionUrl(loc.href);
      if (finalHref === null) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      const finalUrl = new URL(finalHref);
      const wizardFinal = readWizard();
      if (wizardBefore !== null && (wizardFinal === null || !sameDeclaredWizardStep(wizardBefore, wizardFinal))) {
        return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      }
      for (const observer of scanObservers) advanceGeneration(observer.takeRecords());
      if (
        wizardHistoryDrift ||
        mutationGeneration !== generationBefore ||
        doc.documentElement !== documentRoot ||
        view.top !== view.self ||
        afterUrl.origin !== request.targetOrigin ||
        afterUrl.pathname !== request.targetPathname ||
        afterUrlDigest !== request.targetUrlDigest ||
        finalUrl.href !== afterUrl.href ||
        now() > request.expiresAtMs
      ) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');

      const outcome = scanPacket(packet);
      if (!outcome.ok) return pilotUa1DiscoveryFailure(outcome.code);
      const reparsed = parsePilotUa1DiscoveryResult(outcome.value);
      if (!reparsed.ok || reparsed.value.outcomes.length !== packet.controls.length) {
        return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
      }
      advanceGeneration(rootObserver.takeRecords());
      for (const observer of scanObservers) advanceGeneration(observer.takeRecords());
      if (
        mutationGeneration !== generationBefore ||
        doc.documentElement !== documentRoot ||
        loc.href !== finalUrl.href ||
        now() > request.expiresAtMs
      ) return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
      const observation = Object.freeze({ packet, structure });
      let liveRegistry: PilotUa1ExactElementRegistry | null = null;
      if (input.observeLive !== undefined) {
        liveRegistry = createExactElementRegistry({
          observation,
          scan,
          observers: scanObservers,
          generation: () => mutationGeneration,
          expectedGeneration: generationBefore,
          document: doc,
          documentRoot,
          view,
          location: loc,
          exactHref: finalUrl.href,
          revalidateScan: () => {
            let introducedShadowRoot = false;
            const fresh = collectRawControls({
              document: doc,
              view,
              identities,
              openShadowRoot,
              observeAdditionalRoot: (root) => {
                if (!observedShadowRoots.has(root)) introducedShadowRoot = true;
              },
            });
            if (introducedShadowRoot) throw new Error('PILOT_TARGET_DRIFT');
            return fresh;
          },
        });
        if (liveRegistry === null || !liveRegistry.isCurrent()) {
          liveRegistry?.dispose();
          return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
        }
      }
      try {
        input.observe?.(observation);
        if (liveRegistry !== null && input.observeLive !== undefined) {
          const registry = liveRegistry;
          let wizardRetired = false;
          let wizardLastTime = currentTime;
          const declaredWizard = wizardBefore === null ? null : Object.freeze({
            step: wizardBefore,
            isCurrent: (): boolean => {
              if (wizardRetired || wizardHistoryDrift || !registry.isCurrent()) return false;
              try {
                const time = now();
                if (!Number.isSafeInteger(time) || time < wizardLastTime || time > request.expiresAtMs) {
                  wizardRetired = true;
                  return false;
                }
                wizardLastTime = time;
              } catch { wizardRetired = true; return false; }
              const fresh = readWizard();
              if (fresh === null || !sameDeclaredWizardStep(wizardBefore, fresh) || !registry.isCurrent()) {
                wizardRetired = true;
                return false;
              }
              return true;
            },
          });
          if (declaredWizard !== null && !declaredWizard.isCurrent()) {
            registry.dispose();
            return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
          }
          const live = Object.freeze({
            observation, registry,
            ...(captureWizard ? { declaredWizard } : {}),
          });
          if (declaredWizard !== null) {
            issuedWizardObservations.add(live);
            if (input.wizardRuntime !== undefined) issuedWizardRuntimes.set(live, input.wizardRuntime);
          }
          input.observeLive(live);
          if (declaredWizard !== null && !declaredWizard.isCurrent()) {
            registry.dispose();
            return pilotUa1DiscoveryFailure('PILOT_TARGET_DRIFT');
          }
          observersTransferred = true;
          activeLiveRegistry = liveRegistry;
        }
      } catch {
        liveRegistry?.dispose();
        return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
      }
      nextEpochIndex += 1;
      return Object.freeze({
        ok: true,
        detectedControlCount: reparsed.value.outcomes.length,
      });
    } catch {
      return pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE');
    } finally {
      for (const type of wizardListeners) view.removeEventListener(type, markWizardHistoryDrift, true);
      if (!observersTransferred) {
        for (const observer of scanObservers) observer.disconnect();
      }
      scanInFlight = false;
    }
  };
}

/** Install only when the build-time gate is true; no gate means no listener. */
export function installPilotUa1ContentTrigger(input: Readonly<{
  enabled: boolean;
  runtime: PilotUa1RuntimeMessageApi;
  document?: Document;
  view?: Window;
  location?: Location;
}>): boolean {
  if (!input.enabled) return false;
  const handle = createPilotUa1ContentRuntime({
    enabled: true,
    extensionId: input.runtime.id,
    expectedBackgroundUrl: input.runtime.getURL('/background.js'),
    ...(input.document ? { document: input.document } : {}),
    ...(input.view ? { view: input.view } : {}),
    ...(input.location ? { location: input.location } : {}),
  });
  input.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPotentialPilotUa1Message(message)) return;
    void handle(message, sender).then(sendResponse).catch(() => {
      sendResponse(pilotUa1DiscoveryFailure('PILOT_DISCOVERY_UNAVAILABLE'));
    });
    return true;
  });
  return true;
}
