/**
 * ATS lab content script (VIBE_DIST=ats-lab only).
 *
 * Drives the apply-kernel directly on the current page with mock data:
 *   scan   → gate + adapter + sealed descriptor (same kernel calls as production)
 *   fill   → buildApplyPlan → mintIntentAuthority (local lease) → runApplyPlan
 *   next   → lab-only wizard step advance (never a submit control)
 *   prestep→ lab-only in-page "Apply for this job" expander
 *
 * There is no backend, no intent, no receipt. The production gates that bind a
 * fill to a signed intent are simply not on this path; the kernel's own gates
 * (host/page veto, honeypots, manual-only classes, readback, host validation,
 * late recheck) all still run. The user's Submit stays the user's.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { AUTOFILL_EXCLUDE_MATCHES, AUTOFILL_WIDE_MATCHES } from '@edaix/apply-kernel/vendors';
import { evaluatePageVeto, resolveApplyGate, resolveAuthorizedApplyGate } from '@edaix/apply-kernel/gate';
import {
  createScanRoot,
  resolveScanRootMutationPolicy,
  sealScanRootMutationPolicy,
  type ScanRootMutationPolicy,
} from '@edaix/apply-kernel/scanRoot';
import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import { readRuntimeApplyFormResult, type ResolvedRuntimeApplyAdapter } from '@edaix/apply-kernel/runtimeRegistry';
import { buildApplyPlan, buildFillPlan, capabilitiesForPlan } from '@edaix/apply-kernel/engine';
import { mintIntentAuthority } from '@edaix/apply-kernel/grant';
import { runApplyPlan } from '@edaix/apply-kernel/runner';
import { createUndoJournal } from '@edaix/apply-kernel/undo';
import { buildAuditView, type AuditView } from '@edaix/apply-kernel/audit';
import type {
  ApplyFieldDescriptor,
  ApplyFormDescriptor,
  ApplyVendor,
  HostVisibilityStyle,
  ListboxComboboxBinding,
  ScanRootOptions,
} from '@edaix/apply-kernel/contracts';
import type { HoneypotGeometry } from '@edaix/apply-kernel/guards';
import type { HostValidationSignals } from '@edaix/apply-kernel/verify';
import { LAB_COLLECTIONS, LAB_COVER_LETTER, LAB_PROFILE, LAB_WORK_AUTHORIZATIONS } from '../lab/labProfile';
import { LAB_RESUME_FILE_NAME, labResumeFile } from '../lab/labResume';
import { labApplyPolicy } from '../lab/labPolicy';
import { labMockAnswers } from '../lab/labAnswers';
import { labAdapterFor, labGenericExcludeWithin, labGenericMapping, labVendorForHost } from '../lab/labVendors';
import { genericApplyFormEvidence } from '../lib/kernelScanner';
import { jobLikeUrl } from '../lib/autofillDockDecision';
import { hasJobPosting } from '../lib/jobCardFromPage';
import { controlText, findNextStepControl, findPreStepControl, isVisibleControl } from '../lab/labNavigator';
import { comboboxAnswered } from '../lab/labCombobox';
import { labScanIsActionable } from '../lab/labScanGate';
import {
  LAB_COMMAND_EVENT,
  LAB_READY_ATTRIBUTE,
  LAB_RESULT_ATTRIBUTE_PREFIX,
  parseLabCommand,
  type LabCommand,
  type LabCommandOptions,
} from '../lab/labProtocol';

const LAB_SCHEMA_VERSION = 1;
const LAB_LEASE_TTL_MS = 10 * 60 * 1000;
const LAB_LATE_RECHECK_MS = 250;
const LAB_NAVIGATION_SETTLE_MS = 1_500;

interface LabScanState {
  readonly vendor: ApplyVendor;
  readonly descriptor: ApplyFormDescriptor;
  readonly mutationPolicy: ScanRootMutationPolicy | null;
  readonly at: number;
}

let lastScan: LabScanState | null = null;
let lastFill: Record<string, unknown> | null = null;
let running = false;

/** Lenient shadow opener: closed roots through the content-script API, open roots otherwise. */
function openHostShadowRoot(element: Element): ShadowRoot | null {
  const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } })
    .chrome?.dom?.openOrClosedShadowRoot;
  if (typeof dom === 'function') {
    try {
      return dom(element);
    } catch {
      return element.shadowRoot;
    }
  }
  return element.shadowRoot;
}

function readHostGeometry(element: Element): HoneypotGeometry {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const fontSize = Number.parseFloat(style?.fontSize ?? '');
  return {
    width: rect.width,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    ...(style?.clip ? { clip: style.clip } : {}),
    ...(style?.clipPath ? { clipPath: style.clipPath } : {}),
    ...(Number.isFinite(fontSize) ? { fontSize } : {}),
  };
}

/**
 * 标签归一化要的计算可见性。与 readHostGeometry 同姿势：读 DOM 在这里，
 * 判据在 kernel 里（RULE-KERNEL-DETERMINISTIC-BOUNDARY）。
 *
 * 只取 display / visibility 两条——宿主**明说不渲染**的那两条。读不到 view
 * （detached document）就交回空对象，kernel 退回属性层判据。
 */
function readHostVisibility(element: Element): HostVisibilityStyle {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return {};
  return { display: style.display, visibility: style.visibility };
}

/** 题干上画出来的必填星号（`::before` / `::after` 的 content），与生产扫描器同一个读法（lib/kernelScanner.ts）。 */
function readHostGeneratedContent(element: Element, pseudo: '::before' | '::after'): string | null {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element, pseudo);
  return style ? style.content : null;
}

function readHostValidationSignals(element: Element): HostValidationSignals {
  const control = element as Partial<HTMLInputElement>;
  const describedBy = [element.getAttribute('aria-errormessage'), element.getAttribute('aria-describedby')]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/\s+/u))
    .filter(Boolean);
  const errorText = describedBy
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
  return {
    ariaInvalid: element.getAttribute('aria-invalid'),
    ...(typeof control.willValidate === 'boolean' ? { willValidate: control.willValidate } : {}),
    ...(typeof control.validity?.valid === 'boolean' ? { valid: control.validity.valid } : {}),
    ...(errorText ? { errorText } : {}),
  };
}

function collectRoots(root: ParentNode, out: ParentNode[], depth = 0): void {
  if (depth > 12) return;
  for (const element of root.querySelectorAll('*')) {
    const shadow = openHostShadowRoot(element);
    if (shadow) {
      out.push(shadow);
      collectRoots(shadow, out, depth + 1);
    }
  }
}

/** Lab-only page inventory to explain a refused or empty scan. */
function inventory(doc: Document): Record<string, unknown> {
  const roots: ParentNode[] = [doc];
  collectRoots(doc, roots);
  const count = (selector: string) => roots.reduce((sum, root) => sum + root.querySelectorAll(selector).length, 0);
  return {
    forms: Array.from(doc.forms).map((form) => form.id || form.getAttribute('name') || form.getAttribute('data-ui') || '(anonymous)').slice(0, 12),
    shadowRoots: roots.length - 1,
    inputs: count('input:not([type="hidden"])'),
    textareas: count('textarea'),
    selects: count('select'),
    files: count('input[type="file"]'),
    comboboxes: count('[role="combobox"]'),
    radios: count('input[type="radio"]'),
    checkboxes: count('input[type="checkbox"]'),
    buttons: count('button'),
    iframes: doc.querySelectorAll('iframe').length,
    title: doc.title.slice(0, 80),
  };
}

/** Nearby prose a human would read as this control's question; lab diagnostics only. */
function contextText(element: Element): string {
  const container = element.closest('li, fieldset, section, [class*="field"], [class*="question"], [class*="form-group"], div');
  const text = (container?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  return text.slice(0, 160);
}

function currentValue(element: Element): string | boolean | null {
  const control = element as HTMLInputElement;
  if (control.type === 'checkbox' || control.type === 'radio') return control.checked;
  if (control.type === 'file') return control.files && control.files.length > 0 ? control.files[0]!.name : '';
  if (typeof control.value === 'string') return control.value.slice(0, 80);
  if (element.getAttribute('contenteditable')) return (element.textContent ?? '').slice(0, 80);
  return null;
}

function describeField(field: ApplyFieldDescriptor, order: number): Record<string, unknown> {
  const element = field.element as Element;
  const choice = field.kind === 'choice' ? field.choice : null;
  return {
    order,
    kind: field.kind,
    key: field.key,
    label: field.label.slice(0, 120),
    required: field.required,
    confidence: field.confidence,
    unsupportedReason: field.kind === 'unsupported' ? field.unsupportedReason : null,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute('type'),
    id: element.id || null,
    name: element.getAttribute('name'),
    autocomplete: element.getAttribute('autocomplete'),
    role: element.getAttribute('role'),
    ariaHasPopup: element.getAttribute('aria-haspopup'),
    ariaAutocomplete: element.getAttribute('aria-autocomplete'),
    ariaControls: element.getAttribute('aria-controls'),
    placeholder: element.getAttribute('placeholder'),
    className: (element.getAttribute('class') ?? '').slice(0, 80),
    accept: element.getAttribute('accept'),
    choiceControl: choice?.control ?? null,
    choiceOptions: choice ? choice.options.map((option) => option.label.slice(0, 40)).slice(0, 12) : null,
    context: contextText(element),
    value: currentValue(element),
  };
}

function serializeAudit(view: AuditView): Record<string, unknown> {
  return {
    filled: view.filled,
    requiredTotal: view.requiredTotal,
    requiredHandled: view.requiredHandled,
    needsAttention: view.needsAttention,
    blockedByUs: view.blockedByUs,
    rows: view.rows.map((row) => ({
      key: row.key,
      label: row.label.slice(0, 120),
      required: row.required,
      status: row.status,
      reason: row.reason,
      attemptedValue: row.attemptedValue,
      resolvedOptionText: row.resolvedOptionText,
      confidence: row.confidence,
    })),
  };
}

const LAB_DOM_DUMP_MAX_CHARS = 600_000;

/** Lowest common ancestor of every scanned control, serialized for offline rule work (lab only). */
function formHtml(descriptor: ApplyFormDescriptor): string {
  const elements = descriptor.fields.map((field) => field.element as Element).filter((element) => element.isConnected);
  if (elements.length === 0) return '';
  let ancestor: Element | null = elements[0]!;
  for (const element of elements.slice(1)) {
    while (ancestor !== null && !ancestor.contains(element)) ancestor = ancestor.parentElement;
    if (ancestor === null) break;
  }
  const container = ancestor ?? document.body;
  // Include the parent so shared question wrappers and legends around the LCA are visible.
  const target = container.parentElement ?? container;
  const html = target.outerHTML;
  return html.length > LAB_DOM_DUMP_MAX_CHARS ? `${html.slice(0, LAB_DOM_DUMP_MAX_CHARS)}\n<!-- truncated -->` : html;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Generic-lane page evidence, read with production's own readers (`lib/pageEvidence.ts` feeds
 * the same three into `dockFaceForPage`): one generic form (and whether it carries a job-only
 * field), a declared JobPosting, a job-like URL. `probeMs` is timed like the tracker times it
 * — over `SLOW_PROBE_MS` production stops probing that path. Booleans and counts only.
 */
function labGenericEvidence(): Record<string, unknown> {
  const started = performance.now();
  let genericForm: string;
  try {
    genericForm = genericApplyFormEvidence(document);
  } catch (error) {
    genericForm = `THREW:${error instanceof Error ? error.message : 'unknown'}`;
  }
  const probeMs = Math.round((performance.now() - started) * 10) / 10;
  let jobPosting = false;
  try {
    jobPosting = hasJobPosting(document);
  } catch {
    jobPosting = false;
  }
  const veto = evaluatePageVeto(document, { readVisibility: readHostVisibility });
  return {
    genericForm,
    probeMs,
    jobPosting,
    jobUrl: jobLikeUrl(location.hostname, location.pathname),
    pageVeto: veto.vetoed ? veto.reason : null,
  };
}

/**
 * Why the generic root did not resolve, in counts: how many `<form>` containers the page has,
 * how many keyed fields the generic rules find in each, and in the whole body (inside or outside
 * a form). A form the rules would read but that is not a `<form>` shows up as body-keyed ≥ 4
 * with no qualifying form. Lab diagnostics only; nothing here is sealed or written.
 */
function labGenericDiagnostics(mapping: ResolvedRuntimeApplyAdapter, options: ScanRootOptions): Record<string, unknown> {
  const excludeWithin = labGenericExcludeWithin(mapping);
  const count = (container: Element) => {
    const root = createScanRoot(container, excludeWithin, [], options, null);
    const fields = [...mapping.adapter.scan(root, options)];
    const keys = new Set(fields.flatMap((field) => (field.key === null ? [] : [field.key])));
    return {
      fields: fields.length,
      keyed: fields.filter((field) => field.key !== null).length,
      distinctKeys: keys.size,
      insideForm: fields.filter((field) => (field.element as Element).closest('form') !== null).length,
    };
  };
  const forms = [...document.querySelectorAll('form')];
  // What the generic rules make of every control in the body, so a miss can be read
  // field by field (lab output stays in the git-ignored run directory).
  const bodyFields = document.body
    ? [...mapping.adapter.scan(createScanRoot(document.body, excludeWithin, [], options, null), options)]
        .slice(0, 80)
        .map((field, order) => describeField(field, order))
    : [];
  return {
    forms: forms.length,
    perForm: forms.slice(0, 12).map(count),
    body: document.body ? count(document.body) : null,
    bodyFields,
  };
}

async function labGenericScan(policy: ReturnType<typeof labApplyPolicy>, isTopFrame: boolean): Promise<Record<string, unknown>> {
  const doc = document;
  const loc = location;
  const mapping = await labGenericMapping();
  if (mapping !== null) installApplyAdapters({ generic: mapping.adapter });
  const verdict = resolveAuthorizedApplyGate({ doc, hostname: loc.hostname, pathname: loc.pathname, policy, vendor: 'generic', isTopFrame, readVisibility: readHostVisibility });
  const base: Record<string, unknown> = {
    schemaVersion: LAB_SCHEMA_VERSION,
    url: loc.href,
    frame: isTopFrame ? 'top' : 'child',
    hostVendor: null,
    lane: 'generic',
    gate: verdict.attach
      ? { attach: true, vendor: verdict.vendor, source: verdict.source }
      : { attach: false, reason: verdict.reason, vendor: verdict.vendor },
    inventory: inventory(doc),
    evidence: mapping === null ? null : labGenericEvidence(),
  };
  const locale = doc.documentElement?.lang?.trim() || undefined;
  const options: ScanRootOptions = {
    openShadowRoot: openHostShadowRoot,
    readVisibility: readHostVisibility,
    readGeneratedContent: readHostGeneratedContent,
    ...(locale ? { locale } : {}),
    // The same flag production's scanner passes on this lane (kernelScanner.ts).
    generic: true,
  };
  if (!verdict.attach) {
    lastScan = null;
    // Read-only counts even when the gate refused, so a veto can be told apart from "no form".
    return { ...base, ok: false, stage: 'GATE', diagnostics: mapping === null ? null : labGenericDiagnostics(mapping, options) };
  }
  if (mapping === null) {
    lastScan = null;
    return { ...base, ok: false, stage: 'NO_ADAPTER', vendor: 'generic' };
  }
  const read = readRuntimeApplyFormResult(mapping, loc.pathname, doc, options, { generic: true });
  if (!read.ok) {
    lastScan = null;
    // Stage names the harness already acts on: NO_ROOT / NO_CANONICAL_FIELD / SEAL_FAILED.
    const stage = read.stop === 'ROOT_NOT_FOUND'
      ? 'NO_ROOT'
      : read.stop === 'NO_KEYED_FIELD'
        ? 'NO_CANONICAL_FIELD'
        : read.stop.startsWith('NOT_SEALABLE') ? 'SEAL_FAILED' : read.stop;
    return { ...base, ok: false, stage, stop: read.stop, vendor: 'generic', diagnostics: labGenericDiagnostics(mapping, options) };
  }
  const descriptor = read.descriptor;
  const fields = descriptor.fields;
  lastScan = { vendor: 'generic', descriptor, mutationPolicy: resolveScanRootMutationPolicy(descriptor.root), at: Date.now() };
  return {
    ...base,
    ok: true,
    stage: 'SCANNED',
    vendor: 'generic',
    applyPath: true,
    fieldCount: fields.length,
    canonicalCount: fields.filter((field) => field.key !== null).length,
    finalSubmitControl: descriptor.finalSubmitControl ? 'declared' : null,
    fields: fields.map(describeField),
    diagnostics: labGenericDiagnostics(mapping, options),
  };
}

async function labScan(): Promise<Record<string, unknown>> {
  const doc = document;
  const loc = location;
  const isTopFrame = window.top === window.self;
  const policy = labApplyPolicy();
  const hostVendor = labVendorForHost(loc.hostname);
  const verdict = hostVendor === null
    ? resolveApplyGate({ doc, hostname: loc.hostname, pathname: loc.pathname, search: loc.search, policy, isTopFrame, readVisibility: readHostVisibility })
    : resolveAuthorizedApplyGate({ doc, hostname: loc.hostname, pathname: loc.pathname, policy, vendor: hostVendor, isTopFrame, readVisibility: readHostVisibility });
  // Production's third layer (`pageVendor`): neither the host table nor a vendor fingerprint
  // answered, so the page is the generic lane's to read — never before those two.
  if (hostVendor === null && !verdict.attach && verdict.reason === 'NO_VENDOR') {
    return labGenericScan(policy, isTopFrame);
  }
  const base: Record<string, unknown> = {
    schemaVersion: LAB_SCHEMA_VERSION,
    url: loc.href,
    frame: isTopFrame ? 'top' : 'child',
    hostVendor,
    gate: verdict.attach
      ? { attach: true, vendor: verdict.vendor, source: verdict.source }
      : { attach: false, reason: verdict.reason, vendor: verdict.vendor },
    inventory: inventory(doc),
  };
  if (!verdict.attach) {
    lastScan = null;
    return { ...base, ok: false, stage: 'GATE' };
  }
  const vendor = verdict.vendor;
  const adapter = labAdapterFor(vendor);
  if (adapter === null) {
    lastScan = null;
    return { ...base, ok: false, stage: 'NO_ADAPTER', vendor };
  }
  const applyPath = adapter.isApplyPath(loc.pathname);
  const locale = doc.documentElement?.lang?.trim() || undefined;
  const options: ScanRootOptions = {
    openShadowRoot: openHostShadowRoot,
    readVisibility: readHostVisibility,
    readGeneratedContent: readHostGeneratedContent,
    ...(locale ? { locale } : {}),
  };
  const root = adapter.resolveRoot(doc, options);
  if (!root) {
    lastScan = null;
    return { ...base, ok: false, stage: 'NO_ROOT', vendor, applyPath };
  }
  const fields = [...adapter.scan(root, options)];
  const canonicalCount = fields.filter((field) => field.key !== null).length;
  const described = fields.map(describeField);
  if (!labScanIsActionable(fields.length)) {
    lastScan = null;
    return { ...base, ok: false, stage: 'NO_CANONICAL_FIELD', vendor, applyPath, fieldCount: fields.length, fields: described };
  }
  if (sealScanRootMutationPolicy(root, { fields, rescan: () => adapter.scan(root, options) }) === null) {
    lastScan = null;
    return { ...base, ok: false, stage: 'SEAL_FAILED', vendor, applyPath, fieldCount: fields.length, fields: described };
  }
  const descriptor: ApplyFormDescriptor = {
    vendor,
    root,
    fields,
    finalSubmitControl: adapter.resolveFinalSubmitControl(root, fields),
  };
  lastScan = { vendor, descriptor, mutationPolicy: resolveScanRootMutationPolicy(root), at: Date.now() };
  return {
    ...base,
    ok: true,
    stage: 'SCANNED',
    vendor,
    applyPath,
    fieldCount: fields.length,
    canonicalCount,
    finalSubmitControl: descriptor.finalSubmitControl ? 'declared' : null,
    fields: described,
  };
}

/** Lab-only: the three-event pointer sequence a widget listens for. */
function labPoke(target: Element): void {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
}

/**
 * Lab-only: read the **leaf** wording of a rule-declared tiered prompt.
 *
 * The first menu of such a widget holds categories, not answers (Workday:
 * Associations / Event-Conference / Job Board / …), so harvesting it verbatim
 * would hand the mock answer layer "Job Board" where the option it wants is
 * "Linkedin Jobs". Walk one level: into each category, collect its rows, then
 * click the trigger again — which returns the open menu to the top level.
 *
 * Every selector comes from the binding the vendor rule produced; this function
 * knows no vendor of its own.
 */
async function harvestPromptLeaves(
  trigger: HTMLInputElement,
  shape: NonNullable<ListboxComboboxBinding['hierarchicalPrompt']>,
): Promise<string[]> {
  const popup = (): Element | null => {
    const matches = document.querySelectorAll(shape.popupRootSelector);
    return matches.length === 1 ? matches[0]! : null;
  };
  const rows = (): Element[] => [...(popup()?.querySelectorAll(shape.optionSelector) ?? [])];
  const texts = (): string[] => rows().map((row) => (row.textContent ?? '').replace(/\s+/gu, ' ').trim());
  const signature = (list: readonly string[]): string => JSON.stringify(list);
  /** Poll until the menu shows something other than `was`, or the budget runs out. */
  const changedFrom = async (was: string): Promise<string[]> => {
    for (let waited = 0; waited < 3_000; waited += 200) {
      const now = texts();
      if (now.length > 0 && signature(now) !== was) return now;
      await delay(200);
    }
    return texts();
  };
  const categories = texts();
  const top = signature(categories);
  const leaves: string[] = [];
  for (const category of categories.slice(0, shape.maxCategories)) {
    if (category === '') continue;
    const row = rows().find((candidate) => (candidate.textContent ?? '').replace(/\s+/gu, ' ').trim() === category);
    if (row === undefined) continue;
    labPoke(row);
    // A category whose list never changes is a leaf itself (a flat prompt).
    const inside = await changedFrom(top);
    if (signature(inside) !== top) leaves.push(...inside);
    // Back to the top level, and **wait for it**: a fixed delay here harvested
    // only the first category (2026-09-15) and the mock answer layer then
    // answered "How did you hear about us" with an association's name.
    labPoke(trigger);
    if (signature(await changedFrom(signature(inside))) !== top) {
      labPoke(trigger);
      if (signature(await changedFrom(signature(texts()))) !== top) break;
    }
  }
  return leaves.length > 0 ? leaves : categories;
}

/**
 * Lab-only: open each unanswered combobox once to read its option texts, then
 * close it. The kernel asks comboboxes as free text, so mock answers need the
 * widget's exact wording ("Decline To Self Identify" vs "Decline to
 * self-identify"). Runs before the sealed scan that the fill uses.
 */
async function harvestComboboxOptions(descriptor: ApplyFormDescriptor): Promise<Map<Element, string[]>> {
  const harvest = new Map<Element, string[]>();
  for (const field of descriptor.fields) {
    if (field.kind !== 'combobox') continue;
    const trigger = field.element as HTMLInputElement;
    if (!trigger.isConnected || comboboxAnswered(trigger, field.listbox)) continue;
    // A widget whose rule declares a visible activation control is opened through
    // that control, not through the scanned input — Workday's value mirror is 0×0
    // and clicking it opens nothing (2026-09-15 live). Same element as the writer
    // uses, resolved the same way.
    const binding = field.listbox;
    const activation = binding?.activationSelector
      ? trigger.closest(binding.valueContainerSelector)?.querySelector(binding.activationSelector) ?? null
      : trigger;
    if (activation === null) continue;
    try {
      (activation as HTMLElement).focus?.();
      for (const type of ['mousedown', 'mouseup', 'click']) {
        activation.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
      await delay(400);
      // A rule-declared tiered prompt hides its answers one level below the
      // menu it just opened; harvesting the categories would give the mock
      // answer layer the wrong wording entirely.
      if (binding?.hierarchicalPrompt !== undefined) {
        const leaves = [...new Set((await harvestPromptLeaves(trigger, binding.hierarchicalPrompt)).filter(Boolean))];
        if (leaves.length > 0 && leaves.length <= 400) harvest.set(trigger, leaves);
        continue;
      }
      const id = activation.getAttribute('aria-controls') ?? activation.getAttribute('aria-owns');
      let options = id ? [...(document.getElementById(id)?.querySelectorAll('[role="option"]') ?? [])] : [];
      if (options.length === 0) options = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
      const texts = [...new Set(options
        .filter((option) => option.getAttribute('aria-disabled') !== 'true')
        .map((option) => (option.textContent ?? '').replace(/\s+/gu, ' ').trim())
        .filter(Boolean))];
      if (texts.length > 0 && texts.length <= 400) harvest.set(trigger, texts);
    } catch {
      // A widget that throws on synthetic pointer events simply stays unharvested.
    } finally {
      activation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      (activation as HTMLElement).blur?.();
      await delay(150);
    }
  }
  return harvest;
}

async function labFill(options: LabCommandOptions | undefined): Promise<Record<string, unknown>> {
  let scan = await labScan();
  if (scan.ok !== true || lastScan === null) return { ...scan, fill: null };
  const harvestedOptions = options?.mockAnswers === false
    ? new Map<Element, string[]>()
    : await harvestComboboxOptions(lastScan.descriptor);
  if (harvestedOptions.size > 0) {
    // Opening menus mutates the page; take the sealed scan the fill will use afterwards.
    scan = await labScan();
    if (scan.ok !== true || lastScan === null) return { ...scan, fill: null, harvested: harvestedOptions.size };
  }
  const { descriptor, mutationPolicy } = lastScan;
  const policy = labApplyPolicy();
  const planOptions = {
    fillEmptyOnly: options?.overwrite !== true,
    readGeometry: readHostGeometry,
    resumeFileName: LAB_RESUME_FILE_NAME,
    resumeHostConfirmed: true,
    coverLetterText: LAB_COVER_LETTER,
    coverLetterTargetVerified: true,
    collections: LAB_COLLECTIONS,
    workAuthorizations: LAB_WORK_AUTHORIZATIONS,
    // 计划期的类别闸（他人信息等）读的是同一份 lab policy，不是另一套开关。
    capabilities: policy.capabilities,
  };
  const profilePlan = buildApplyPlan(descriptor, LAB_PROFILE, planOptions);
  const mock = options?.mockAnswers === false
    ? { answers: [], report: [] }
    : labMockAnswers(descriptor, profilePlan, { selfIdentification: options?.selfIdentification !== false, harvestedOptions });
  const plan = mock.answers.length > 0
    ? buildFillPlan(descriptor, LAB_PROFILE, mock.answers, planOptions)
    : profilePlan;
  const now = Date.now();
  const minted = mintIntentAuthority({
    lease: { executionLease: `ats-lab-${now.toString(36)}`, expiresAtMs: now + LAB_LEASE_TTL_MS },
    purpose: 'fill',
    fingerprint: plan.fingerprint,
    capabilities: new Set(
      [...capabilitiesForPlan(plan)].filter((capability) => policy.capabilities[capability]),
    ),
    now,
  });
  const skipped = plan.skipped.map((skip) => ({
    key: skip.key,
    reason: skip.reason,
    order: skip.order,
    label: (skip as { label?: string }).label?.slice(0, 120) ?? null,
  }));
  if (!minted.ok) {
    return { ...scan, fill: { ok: false, stage: 'MINT', reason: minted.code, planned: plan.entries.length, skipped } };
  }
  const journal = createUndoJournal();
  const startedAt = Date.now();
  const summary = await runApplyPlan({
    plan,
    auth: minted.value,
    journal,
    root: descriptor.root,
    policy,
    readHostValidation: readHostValidationSignals,
    lateRecheckMs: LAB_LATE_RECHECK_MS,
    resolveResumeFile: async () => labResumeFile(),
    scanStillCurrent: () => mutationPolicy?.isExecutionCurrent() ?? true,
    now: Date.now,
  });
  const view = buildAuditView(plan, summary.results);
  const fill: Record<string, unknown> = {
    ok: true,
    stage: 'RAN',
    durationMs: Date.now() - startedAt,
    planned: plan.entries.length,
    harvestedComboboxes: [...harvestedOptions.entries()].map(([element, texts]) => ({
      id: (element as Element).id || null,
      name: element.getAttribute('name'),
      optionCount: texts.length,
      sample: texts.slice(0, 6),
    })),
    mockAnswers: mock.report,
    plannedEntries: plan.entries.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      label: entry.label.slice(0, 120),
      required: entry.required,
      confidence: entry.confidence,
      writeMode: entry.writeMode ?? 'setValue',
      resolvedOptionText: entry.resolvedOptionText ?? null,
    })),
    skipped,
    filled: summary.filled,
    failed: summary.failed,
    abortedBy: summary.abortedBy,
    identityDrift: summary.identityDrift,
    labelHintDrifted: summary.labelHintDrifted,
    results: summary.results.map((result) => ({
      key: result.key,
      label: result.label.slice(0, 120),
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      unverified: result.ok && result.unverified === true,
    })),
    audit: serializeAudit(view),
  };
  lastFill = fill;
  return { ...scan, fill };
}

async function labNext(): Promise<Record<string, unknown>> {
  const hit = findNextStepControl(document);
  if ('refusal' in hit) return { ok: false, stage: 'NEXT_REFUSED', ...hit };
  const urlBefore = location.href;
  hit.control.scrollIntoView({ block: 'center' });
  hit.control.click();
  await delay(LAB_NAVIGATION_SETTLE_MS);
  return { ok: true, stage: 'NEXT_CLICKED', clicked: hit.text, how: hit.how, urlBefore, urlAfter: location.href };
}

/**
 * Lab-only pass through a "select your location of residence" data-consent
 * gate (Jobvite). Picks the United States option and then advances only
 * through a next-like control; a control that reads as agree/accept is left
 * to a human, so the report says so instead of clicking it.
 */
const CONSENT_ACCEPT_TEXT = /^(?:i )?(?:accept|agree|acknowledge|continue|proceed|next|submit)\b/iu;

async function labConsentGate(options: LabCommandOptions | undefined): Promise<Record<string, unknown> | null> {
  const form = document.querySelector('form[name="consentForm"], form[id*="consent" i], form[class*="consent" i]');
  const select = document.querySelector('form[name="consentForm"] select, select[name*="consent" i], select[id*="consent" i], form[id*="consent" i] select');
  if (!(select instanceof HTMLSelectElement)) return null;
  const choices = [...select.options].filter((candidate) => candidate.value !== '' && !candidate.disabled);
  const option = choices.find((candidate) => /united states/iu.test(candidate.text)) ?? choices[0] ?? null;
  if (option === null) return { ok: false, stage: 'CONSENT_GATE_NO_OPTION', options: [...select.options].map((candidate) => candidate.text).slice(0, 20) };
  select.focus();
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await delay(1_500);
  const urlBefore = location.href;
  const next = findNextStepControl(document);
  if (!('refusal' in next)) {
    next.control.click();
    await delay(LAB_NAVIGATION_SETTLE_MS);
    return { ok: true, stage: 'CONSENT_GATE_PASSED', selected: option.text, clicked: next.text, how: next.how, urlBefore, urlAfter: location.href };
  }
  if (options?.consentGates !== true) return { ok: false, stage: 'CONSENT_GATE_HUMAN', selected: option.text, ...next };
  // Lab-only: the mock applicant accepts the vendor's data-consent prompt. The
  // control must sit inside the consent form and read as accept/continue.
  const scope: ParentNode = form instanceof HTMLFormElement ? form : document;
  const accept = [...scope.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]')]
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .find((element) => isVisibleControl(element) && CONSENT_ACCEPT_TEXT.test(controlText(element)) && !/back|cancel|decline|reject/iu.test(controlText(element)));
  if (!accept) return { ok: false, stage: 'CONSENT_GATE_HUMAN', selected: option.text, ...next };
  accept.click();
  await delay(LAB_NAVIGATION_SETTLE_MS);
  return { ok: true, stage: 'CONSENT_GATE_ACCEPTED_BY_LAB', selected: option.text, clicked: controlText(accept), urlBefore, urlAfter: location.href };
}

async function labPrestep(options: LabCommandOptions | undefined): Promise<Record<string, unknown>> {
  const consent = await labConsentGate(options);
  if (consent !== null) return consent;
  const hit = findPreStepControl(document);
  if ('refusal' in hit) return { ok: false, stage: 'PRESTEP_REFUSED', ...hit };
  const urlBefore = location.href;
  hit.control.scrollIntoView({ block: 'center' });
  hit.control.click();
  await delay(LAB_NAVIGATION_SETTLE_MS);
  return { ok: true, stage: 'PRESTEP_CLICKED', clicked: hit.text, how: hit.how, urlBefore, urlAfter: location.href };
}

async function handle(command: LabCommand): Promise<Record<string, unknown>> {
  if (running) return { ok: false, stage: 'BUSY' };
  running = true;
  try {
    switch (command.kind) {
      case 'probe':
      case 'scan':
        return await labScan();
      case 'fill':
        return await labFill(command.options);
      case 'next':
        return await labNext();
      case 'prestep':
        return await labPrestep(command.options);
      case 'dom':
        return lastScan === null
          ? { ok: false, stage: 'NO_SCAN' }
          : { ok: true, stage: 'DOM', url: location.href, vendor: lastScan.vendor, html: formHtml(lastScan.descriptor) };
      case 'snapshot':
        return lastScan === null
          ? { ok: false, stage: 'NO_SCAN' }
          : {
              ok: true,
              stage: 'SNAPSHOT',
              url: location.href,
              vendor: lastScan.vendor,
              fields: lastScan.descriptor.fields.map((field, order) => ({
                order,
                key: field.key,
                kind: field.kind,
                label: field.label.slice(0, 80),
                value: currentValue(field.element as Element),
                connected: (field.element as Element).isConnected,
              })),
            };
      case 'status':
        return {
          ok: true,
          stage: 'STATUS',
          url: location.href,
          lastScanAt: lastScan?.at ?? null,
          lastScanVendor: lastScan?.vendor ?? null,
          lastFill,
        };
      default:
        return { ok: false, stage: 'UNKNOWN_COMMAND' };
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'THREW',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 6).join('\n') : null,
    };
  } finally {
    running = false;
  }
}

function publish(id: string, result: Record<string, unknown>): void {
  try {
    document.documentElement.setAttribute(`${LAB_RESULT_ATTRIBUTE_PREFIX}${id}`, JSON.stringify(result));
  } catch {
    document.documentElement.setAttribute(`${LAB_RESULT_ATTRIBUTE_PREFIX}${id}`, JSON.stringify({ ok: false, stage: 'PUBLISH_FAILED' }));
  }
}

function mountPanel(): void {
  if (document.getElementById('edaix-ats-lab')) return;
  const host = document.createElement('div');
  host.id = 'edaix-ats-lab';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .box{font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0A1128;color:#E8EDF5;border-radius:10px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.35);min-width:220px;max-width:360px}
      .row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
      .t{font-weight:600;letter-spacing:.02em}
      button{font:inherit;border:0;border-radius:6px;padding:4px 8px;background:#FF9D4D;color:#0A1128;cursor:pointer}
      button.q{background:#26304F;color:#E8EDF5}
      .s{white-space:pre-wrap;max-height:160px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#C3CBDD}
    </style>
    <div class="box">
      <div class="row"><span class="t">EdAIX ATS Lab</span><span id="v"></span></div>
      <div class="row"><button id="scan" class="q">Scan</button><button id="fill">Fill</button><button id="next" class="q">Next</button><button id="pre" class="q">Apply▸</button></div>
      <div class="s" id="status">ready</div>
    </div>`;
  const status = shadow.getElementById('status') as HTMLElement;
  const version = shadow.getElementById('v') as HTMLElement;
  const run = (kind: LabCommand['kind']) => {
    status.textContent = `${kind}…`;
    void handle({ id: `panel-${Date.now().toString(36)}`, kind }).then((result) => {
      const fill = result.fill as Record<string, unknown> | null | undefined;
      const summary = fill && typeof fill === 'object'
        ? `filled ${String(fill.filled)} / planned ${String(fill.planned)}, failed ${String(fill.failed)}, skipped ${String((fill.skipped as unknown[]).length)}`
        : `${String(result.stage)}${result.vendor ? ` ${String(result.vendor)}` : ''}${typeof result.fieldCount === 'number' ? ` fields=${String(result.fieldCount)}` : ''}${result.clicked ? ` clicked "${String(result.clicked)}"` : ''}${result.reason ? ` ${String(result.reason)}` : ''}`;
      status.textContent = summary;
      version.textContent = result.vendor ? String(result.vendor) : '';
    });
  };
  (shadow.getElementById('scan') as HTMLButtonElement).addEventListener('click', () => run('scan'));
  (shadow.getElementById('fill') as HTMLButtonElement).addEventListener('click', () => run('fill'));
  (shadow.getElementById('next') as HTMLButtonElement).addEventListener('click', () => run('next'));
  (shadow.getElementById('pre') as HTMLButtonElement).addEventListener('click', () => run('prestep'));
  (document.body ?? document.documentElement).appendChild(host);
}

export default defineContentScript({
  matches: [...AUTOFILL_WIDE_MATCHES],
  excludeMatches: [...AUTOFILL_EXCLUDE_MATCHES],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    if (!__VIBE_ATS_LAB__) return;

    document.addEventListener(LAB_COMMAND_EVENT, (event) => {
      const command = parseLabCommand((event as CustomEvent<unknown>).detail);
      if (command === null) return;
      void handle(command).then((result) => publish(command.id, result));
    });

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (typeof message !== 'object' || message === null) return false;
      const { kind, id, options } = message as { kind?: unknown; id?: unknown; options?: unknown };
      if (typeof kind !== 'string' || !kind.startsWith('lab/')) return false;
      const command = parseLabCommand({ id: typeof id === 'string' ? id : `msg-${Date.now().toString(36)}`, kind: kind.slice(4), options });
      if (command === null) return false;
      void handle(command).then((result) => {
        publish(command.id, result);
        sendResponse(result);
      });
      return true;
    });

    document.documentElement.setAttribute(LAB_READY_ATTRIBUTE, window.top === window.self ? 'ready' : 'ready-frame');
    if (window.top === window.self) {
      if (document.body) mountPanel();
      else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    }
  },
});
