/**
 * apply-rules 的解释器：把一份校验过的 `VendorRuleset`（纯 JSON 数据）
 * 编译成 `VendorAdapter`。
 *
 * 这是 JSON 化改造（docs/40-工程计划 P1）的另一半：四家适配器里原本
 * 手写的扫描循环在这里只存在一份，厂商差异全部退化为数据。改版当天
 * 后端改 JSON 下发，扩展不动、不过商店（审核最坏 28 天）。
 *
 * 行为对齐说明：本文件的扫描语义逐字对齐搬入时的四份 sites/<vendor>/applyForm.ts
 * （vibeid-ext-autofill@3580e71），由原有四套适配器测试整套锁定。此处不发明
 * 任何新行为；要改填法，先改测试再改数据/解释器。
 */

import { installFileContextMaxDepth } from '../write/fileContextDepth.ts';
import { isCollectionFieldRole } from '../collectionProjection.ts';
import {
  classifyControl,
  isContentEditable,
  isSiteDeclaredNonInput,
} from '../dict/controls.ts';
import {
  createScanRoot,
  withScanPass,
  CONTROL_SELECTOR,
  isScannableControl,
  labelTextOf,
  labelTextsOf,
  rawVisibleTextOf,
  resolveAriaReference,
  ROW_SCOPE_PREFIX,
} from '../scanRoot.ts';
import { fieldSignature } from '../fieldIdentity.ts';
import type { ChoiceGroupShape, ProxyChoiceGroupShape, ProxyChoiceOption } from '../contracts.ts';
import {
  ARIA_CHOICE_GROUP_SELECTOR,
  ARIA_PROXY_OPTION_SELECTOR,
  ariaProxyCarrier,
  ariaProxyKind,
  ariaProxyPressed,
  canSubmitOrResetAForm,
  isSingleChoiceProxy,
  nearestAriaProxyOption,
  type AriaProxyKind,
} from '../dict/ariaChoice.ts';
import {
  generatedContentIsRequiredMarker,
  hasRequiredMarkerAtEdge,
  isRequiredMarkerText,
} from '../dict/requiredMarker.ts';
import { isNonResumeFileField, isResumeFileField } from '../dict/guards.ts';
import { describesPickFromSuggestions } from '../dict/fieldContext.ts';
import { createPlainTextContenteditableAttestation } from './plainTextContenteditable.ts';
import {
  canClickHostRestorationTarget,
  clickHostRestorationTarget,
} from '../click/primitives.ts';
import {
  assertNever,
  type ApplyFieldDescriptor,
  type ApplyFieldKey,
  type DerivedAnswerKey,
  type ComboboxSemanticAuthority,
  type ComboboxSemanticTransaction,
  type ComboboxSemanticUndoTransaction,
  type CollectionFieldRole,
  type ConsentGateReading,
  type FileUploadBinding,
  type FinalSubmitControlDescriptor,
  type ListboxComboboxBinding,
  type RowScopeRule,
  type ScanRoot,
  type SearchPromptShape,
  type ApplyPathOptions,
  type ScanRootOptions,
  type VendorAdapter,
} from '../contracts.ts';
import {
  parseVendorRuleset,
  RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET,
  type RuleAttrMapKey,
  type ComboboxSemanticControlRule,
  type ListboxComboboxRule,
  type QuestionScopeRule,
  type RuleKeyStep,
  type RuleMapAttr,
  type RuleRegex,
  type PortaledPromptRule,
  type PromptComboboxRule,
  type SearchPromptComboboxRule,
  type FileUploadRule,
  type TypeaheadComboboxRule,
  type VendorRuleset,
} from './schema.ts';
import { sealRuleOwnedComboboxSemanticAuthority } from './comboboxSemanticAuthority.ts';
import { compileAccountWall } from './accountWall.ts';

type RuleFieldKey = ApplyFieldKey | CollectionFieldRole | DerivedAnswerKey;

/**
 * 扫描面：原生控件（`scanRoot`）与 ARIA 代理选项（`dict/ariaChoice`），一次文档序遍历。
 * 在调用时拼、不在模块求值时拼：本模块在装载期不读 `scanRoot` 的任何导出（有的测试把它整个桩掉）。
 */
function scanSelector(): string {
  return `${CONTROL_SELECTOR}, ${ARIA_PROXY_OPTION_SELECTOR}`;
}

interface PlainTextContenteditableRuleMatch {
  readonly attr: RuleMapAttr;
  readonly expectedValue: string;
}

interface ResolvedRuleKey {
  readonly key: RuleFieldKey | null;
  readonly confidence: number;
  readonly plainTextContenteditable: PlainTextContenteditableRuleMatch | null;
}

function isInput(element: Element): element is HTMLInputElement {
  return element.localName === 'input';
}

function isTextarea(element: Element): element is HTMLTextAreaElement {
  return element.localName === 'textarea';
}

function isSelect(element: Element): element is HTMLSelectElement {
  return element.localName === 'select';
}

function nativeSubmitControl(
  element: Element,
): HTMLButtonElement | HTMLInputElement | null {
  if (element.localName === 'button') {
    const button = element as HTMLButtonElement;
    return button.type === 'submit' ? button : null;
  }
  if (element.localName === 'input') {
    const input = element as HTMLInputElement;
    return input.type === 'submit' || input.type === 'image' ? input : null;
  }
  return null;
}

function exactFieldsForm(
  fields: readonly ApplyFieldDescriptor[],
): HTMLFormElement | null {
  if (fields.length === 0) return null;
  let exact: HTMLFormElement | null = null;
  for (const field of fields) {
    if (!field.element.isConnected) return null;
    const candidate = field.element.closest('form');
    if (!candidate || candidate.localName !== 'form' || !candidate.isConnected) return null;
    const form = candidate as HTMLFormElement;
    if (
      ['input', 'select', 'textarea', 'button'].includes(field.element.localName)
    ) {
      const formAttribute = field.element.getAttribute('form');
      if (
        (formAttribute !== null && (form.id === '' || formAttribute !== form.id)) ||
        (field.element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement)
          .form !== form
      ) return null;
    }
    if (exact !== null && exact !== form) return null;
    exact = form;
  }
  return exact;
}

const FINAL_CONTROL_ATTRIBUTES = [
  'type',
  'disabled',
  'form',
  'formaction',
  'formenctype',
  'formmethod',
  'formnovalidate',
  'formtarget',
  'name',
  'value',
  'aria-disabled',
] as const;

const FINAL_FORM_ATTRIBUTES = [
  'accept-charset',
  'action',
  'enctype',
  'method',
  'novalidate',
  'rel',
  'target',
] as const;

function finalSubmissionSemanticsSeal(
  element: HTMLButtonElement | HTMLInputElement,
  form: HTMLFormElement,
): readonly unknown[] {
  return [
    element.ownerDocument,
    form.ownerDocument,
    ...FINAL_CONTROL_ATTRIBUTES.map((name) => element.getAttribute(name)),
    ...FINAL_FORM_ATTRIBUTES.map((name) => form.getAttribute(name)),
    // Seal both raw attributes and the browser-resolved effective tuple. The
    // latter catches base-URL drift and fallback from submitter overrides to
    // form defaults even when the raw submitter itself is unchanged.
    element.formAction,
    element.formEnctype,
    element.formMethod,
    element.formNoValidate,
    element.formTarget,
    form.acceptCharset,
    form.action,
    form.enctype,
    form.method,
    form.noValidate,
    form.rel,
    form.target,
  ];
}

function sameUnknownList(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

/**
 * 规则声明的最终提交在哪儿：先只在扫描根里找（Greenhouse、Workable 一直如此）——恰好一颗才算，多了就不猜。
 *
 * 根里一颗都没有时，只认一种表外的样子（2026-10-04，BambooHR 实测）：提交钮住在表下方的固定操作栏里，用 HTML 的
 * `form` 属性认领这张表（`<button type="submit" form="job-application-form">`）。它要同时满足——
 *  · 选择器在这张表所在的整棵树里（文档或影子根）恰好命中一颗；
 *  · 那一颗的 `form` 属性正好写着这张表的 id（表没有 id 就不认）；
 *  · 这张表名下的原生提交（`form.elements` 里 type=submit/image 的）只有它这一颗。
 * 表外没写 `form` 属性的按钮属于别的东西，一律不认；身份、可用、同一张表这几道闸由调用方照旧再核。
 */
function locateFinalControl(
  root: ScanRoot,
  form: HTMLFormElement,
  selector: string,
): Readonly<{ element: Element; outside: boolean }> | null {
  let inside: readonly Element[];
  try {
    inside = root.querySelectorAll(selector);
  } catch {
    return null;
  }
  if (inside.length === 1) return { element: inside[0]!, outside: false };
  if (inside.length > 1 || form.id === '') return null;
  const tree = form.getRootNode();
  if (typeof (tree as ParentNode).querySelectorAll !== 'function') return null;
  let page: Element[];
  try {
    page = Array.from((tree as ParentNode).querySelectorAll(selector));
  } catch {
    return null;
  }
  if (page.length !== 1) return null;
  const only = page[0]!;
  if (only.getAttribute('form') !== form.id) return null;
  const owned = Array.from(form.elements).filter((control) => nativeSubmitControl(control) !== null);
  if (owned.length !== 1 || owned[0] !== only) return null;
  return { element: only, outside: true };
}

/** 小写化的 `name`；`urls[...]` 命名空间按不区分大小写比较。 */
function nameOf(element: Element): string {
  return (element.getAttribute('name') || '').toLowerCase();
}

function isRequired(element: Element): boolean {
  const nativeRequired =
    (isInput(element) || isTextarea(element) || isSelect(element)) && element.required;
  // Workable 会显式写 aria-required="false"，所以只有字面 "true" 算数。
  return nativeRequired || element.getAttribute('aria-required') === 'true';
}

function compileRegex(spec: RuleRegex): RegExp {
  return new RegExp(spec.source, spec.flags ?? '');
}

/** 预编译一步：正则编译成 RegExp，查表换成 Map（去掉原型链上的假命中面）。 */
type CompiledKeyStep =
  | {
      readonly type: 'attrMap';
      readonly attr: RuleMapAttr;
      readonly confidence: number;
      readonly map: ReadonlyMap<string, RuleAttrMapKey>;
    }
  | {
      readonly type: 'ancestorAttrMap';
      readonly attr: RuleMapAttr;
      readonly confidence: number;
      readonly map: ReadonlyMap<string, RuleFieldKey>;
    }
  | { readonly type: 'stopNamePrefix'; readonly prefixes: readonly string[] }
  | { readonly type: 'labelFallbackGate'; readonly nameRegex: RegExp; readonly allowEmptyName: boolean }
  | {
      readonly type: 'labelPatterns';
      readonly confidence: number;
      readonly patterns: ReadonlyArray<{
        readonly regex: RegExp;
        readonly key: RuleFieldKey;
        /** BCP-47 主子标签白名单；缺省 = 通用。见 schema 的 RuleLabelPattern。 */
        readonly locales?: readonly string[];
      }>;
    };

function compileKeyStep(step: RuleKeyStep): CompiledKeyStep {
  switch (step.type) {
    case 'attrMap':
      return { ...step, map: new Map(Object.entries(step.map)) };
    case 'ancestorAttrMap':
      return { ...step, map: new Map(Object.entries(step.map)) };
    case 'stopNamePrefix':
      return step;
    case 'labelFallbackGate':
      return { ...step, nameRegex: compileRegex(step.nameRegex) };
    case 'labelPatterns':
      return {
        ...step,
        patterns: step.patterns.map((entry) =>
          entry.locales === undefined
            ? { regex: compileRegex(entry.regex), key: entry.key }
            : { regex: compileRegex(entry.regex), key: entry.key, locales: entry.locales },
        ),
      };
    default:
      return assertNever(step, 'compileKeyStep rule step type');
  }
}

const NO_KEY = { key: null, confidence: 0, plainTextContenteditable: null } as const;

const COMBOBOX_RULE_UNAVAILABLE = new Error('CAPABILITY_DISABLED');

interface SemanticOptionState {
  readonly element: Element;
  readonly identity: string;
  readonly text: string;
  readonly selected: boolean;
}

interface SemanticControlState {
  readonly trigger: HTMLInputElement;
  readonly optionRoot: Element;
  readonly options: readonly SemanticOptionState[];
}

function normalizeComboboxOptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unavailableComboboxRule(): never {
  throw COMBOBOX_RULE_UNAVAILABLE;
}

function queryRuleElements(
  root: ScanRoot,
  selector: string,
): readonly Element[] | null {
  try {
    return root.querySelectorAll(selector);
  } catch {
    return null;
  }
}

function resolveSemanticTrigger(
  rule: ComboboxSemanticControlRule,
  root: ScanRoot,
): HTMLInputElement | null {
  const matches = queryRuleElements(root, rule.triggerSelector);
  if (
    matches === null ||
    matches.length !== 1 ||
    !isInput(matches[0]!) ||
    !matches[0]!.isConnected ||
    root.isExcluded(matches[0]!)
  ) return null;
  return matches[0]!;
}

function readSemanticControlState(
  rule: ComboboxSemanticControlRule,
  root: ScanRoot,
  expectedRoot?: Element,
): SemanticControlState | null {
  const trigger = resolveSemanticTrigger(rule, root);
  const roots = queryRuleElements(root, rule.optionRootSelector);
  if (
    trigger === null ||
    roots === null ||
    roots.length !== 1 ||
    !roots[0]!.isConnected ||
    root.isExcluded(roots[0]!) ||
    (expectedRoot !== undefined && roots[0] !== expectedRoot)
  ) return null;

  const optionRoot = roots[0]!;
  let members: readonly Element[];
  try {
    members = [...optionRoot.querySelectorAll(rule.optionMemberSelector)];
  } catch {
    return null;
  }
  if (members.length === 0) return null;

  const seenIdentities = new Set<string>();
  const options: SemanticOptionState[] = [];
  for (const element of members) {
    if (
      !element.isConnected ||
      element.getRootNode() !== optionRoot.getRootNode() ||
      root.isExcluded(element)
    ) return null;
    const identity = element.getAttribute(rule.optionIdentityAttribute);
    const text = normalizeComboboxOptionText(element.textContent ?? '');
    if (
      identity === null ||
      identity === '' ||
      text === '' ||
      seenIdentities.has(identity)
    ) return null;
    const selectedValue = element.getAttribute(rule.selectedState.attribute);
    if (
      selectedValue !== rule.selectedState.selectedValue &&
      selectedValue !== rule.selectedState.unselectedValue
    ) return null;
    seenIdentities.add(identity);
    options.push(Object.freeze({
      element,
      identity,
      text,
      selected: selectedValue === rule.selectedState.selectedValue,
    }));
  }
  return {
    trigger,
    optionRoot,
    options: Object.freeze(options),
  };
}

function membershipSeal(options: readonly SemanticOptionState[]): string {
  return JSON.stringify(options.map(({ identity, text }) => [identity, text]));
}

function semanticStateSeal(options: readonly SemanticOptionState[]): string {
  return JSON.stringify(
    options.map(({ identity, text, selected }) => [identity, text, selected]),
  );
}

function selectedOption(
  state: SemanticControlState,
): SemanticOptionState | null {
  const selected = state.options.filter((option) => option.selected);
  return selected.length === 1 ? selected[0]! : null;
}

/** Auxiliary visible-state restoration; semantic option state remains the authority. */
function restoreComboboxRawValue(
  trigger: HTMLInputElement,
  expected: string,
): boolean {
  try {
    const Input = trigger.ownerDocument.defaultView?.HTMLInputElement;
    const setter = Input
      ? Object.getOwnPropertyDescriptor(Input.prototype, 'value')?.set
      : undefined;
    if (typeof setter !== 'function') return false;
    setter.call(trigger, expected);
    return trigger.value === expected;
  } catch {
    return false;
  }
}

function createComboboxSemanticAuthority(
  rule: ComboboxSemanticControlRule,
  trigger: HTMLInputElement,
  root: ScanRoot,
): ComboboxSemanticAuthority {
  const exactTrigger = (): HTMLInputElement | null => resolveSemanticTrigger(rule, root);
  const state = (expectedRoot?: Element): SemanticControlState | null =>
    readSemanticControlState(rule, root, expectedRoot);

  const ownsTarget = (
    originalTrigger: HTMLInputElement,
    optionRoot: Element,
    target: EventTarget | null,
  ): boolean => {
    if (target === originalTrigger || target === optionRoot) return true;
    const live = state(optionRoot);
    if (live === null) return false;
    if (target === live.trigger) return true;
    if (!(target instanceof Node)) return false;
    return live.options.some(
      (option) => option.element === target || option.element.contains(target),
    );
  };

  const optionSource = Object.freeze({
    read: (liveTrigger: HTMLInputElement): readonly { readonly element: Element; readonly text: string }[] => {
      if (exactTrigger() !== liveTrigger) unavailableComboboxRule();
      const live = state();
      if (live === null || live.trigger !== liveTrigger) unavailableComboboxRule();
      return Object.freeze(live.options.map(({ element, text }) => Object.freeze({ element, text })));
    },
    isOpen: (liveTrigger: HTMLInputElement): boolean => {
      if (exactTrigger() !== liveTrigger) unavailableComboboxRule();
      const value = liveTrigger.getAttribute(rule.openState.attribute);
      if (value === rule.openState.openValue) return true;
      if (value === rule.openState.closedValue) return false;
      return unavailableComboboxRule();
    },
  });

  const readSelection: ComboboxSemanticAuthority['readSelection'] = (
    liveTrigger,
    expectedOptionText,
  ) => {
    if (exactTrigger() !== liveTrigger) return 'UNVERIFIABLE';
    const live = state();
    if (live === null || live.trigger !== liveTrigger) return 'UNVERIFIABLE';
    const selected = live.options.filter((option) => option.selected);
    if (selected.length === 0) return 'EMPTY';
    if (selected.length !== 1) return 'UNVERIFIABLE';
    const expected = normalizeComboboxOptionText(expectedOptionText);
    if (expected === '') return 'UNVERIFIABLE';
    return selected[0]!.text === expected ? 'MATCH' : 'MISMATCH';
  };

  const semanticTransactionSource = Object.freeze({
    snapshot: (liveTrigger: HTMLInputElement): ComboboxSemanticTransaction | null => {
      if (exactTrigger() !== liveTrigger || liveTrigger !== trigger) return null;
      const before = state();
      if (before === null || before.trigger !== liveTrigger) return null;
      const prior = selectedOption(before);
      if (prior === null) return null;

      const optionRoot = before.optionRoot;
      const optionRootNode = optionRoot.getRootNode();
      const beforeMembership = membershipSeal(before.options);
      const beforeState = semanticStateSeal(before.options);
      const beforeRawValue = liveTrigger.value;
      const priorIdentity = prior.identity;
      const priorText = prior.text;

      interface ExactSemanticStateSeal {
        readonly state: string;
        readonly rawValue: string;
        readonly selectedIdentity: string;
        readonly selectedText: string;
      }

      const preWriteSeal: ExactSemanticStateSeal = Object.freeze({
        state: beforeState,
        rawValue: beforeRawValue,
        selectedIdentity: priorIdentity,
        selectedText: priorText,
      });

      const current = (): SemanticControlState | null => {
        const live = state(optionRoot);
        if (
          live === null ||
          live.trigger !== liveTrigger ||
          optionRoot.getRootNode() !== optionRootNode ||
          membershipSeal(live.options) !== beforeMembership
        ) return null;
        return live;
      };

      const matchesExactSemanticSeal = (
        live: SemanticControlState,
        seal: ExactSemanticStateSeal,
      ): boolean => {
        if (semanticStateSeal(live.options) !== seal.state) return false;
        const selected = selectedOption(live);
        return selected?.identity === seal.selectedIdentity &&
          selected.text === seal.selectedText;
      };

      /**
       * Raw value is a host-controlled getter. Read semantic state on both
       * sides of it so a getter cannot return the sealed raw value while
       * changing the backing selection to an unrelated third state.
       */
      const proveExactSemanticSeal = (
        seal: ExactSemanticStateSeal,
      ): SemanticControlState | null => {
        const beforeRaw = current();
        if (beforeRaw === null || !matchesExactSemanticSeal(beforeRaw, seal)) return null;
        if (beforeRaw.trigger.value !== seal.rawValue) return null;
        const afterRaw = current();
        return afterRaw !== null && matchesExactSemanticSeal(afterRaw, seal)
          ? afterRaw
          : null;
      };

      const isAtPreWriteState = (): boolean => {
        const live = current();
        return live !== null &&
          semanticStateSeal(live.options) === beforeState &&
          live.trigger.value === beforeRawValue;
      };

      const restoreTargetIsSafe = (): boolean => {
        const live = current();
        if (live === null) return false;
        const priorCandidates = live.options.filter(
          (option) => option.identity === priorIdentity && option.text === priorText,
        );
        if (priorCandidates.length !== 1) return false;
        const beforeProofState = semanticStateSeal(live.options);
        const beforeProofRaw = live.trigger.value;
        if (!canClickHostRestorationTarget({
          element: priorCandidates[0]!.element,
          root,
        })) return false;
        const afterProof = current();
        if (
          afterProof === null ||
          semanticStateSeal(afterProof.options) !== beforeProofState ||
          afterProof.trigger.value !== beforeProofRaw
        ) return false;
        const afterPrior = afterProof.options.filter(
          (option) => option.identity === priorIdentity && option.text === priorText,
        );
        return afterPrior.length === 1;
      };

      const canRestorePreWrite = (): boolean =>
        isAtPreWriteState() &&
        restoreTargetIsSafe() &&
        isAtPreWriteState();

      const restorePreWrite = (writtenSeal?: ExactSemanticStateSeal): boolean => {
        const live = writtenSeal === undefined
          ? current()
          : proveExactSemanticSeal(writtenSeal);
        if (live === null) {
          return writtenSeal !== undefined && proveExactSemanticSeal(preWriteSeal) !== null;
        }
        if (semanticStateSeal(live.options) !== beforeState) {
          if (!restoreTargetIsSafe()) return false;
          const restoreState = writtenSeal === undefined
            ? current()
            : proveExactSemanticSeal(writtenSeal);
          if (restoreState === null) {
            return writtenSeal !== undefined && proveExactSemanticSeal(preWriteSeal) !== null;
          }
          const candidates = restoreState.options.filter(
            (option) => option.identity === priorIdentity && option.text === priorText,
          );
          if (candidates.length !== 1) return false;
          const option = candidates[0]!;
          const restoreStartState = writtenSeal?.state ?? semanticStateSeal(restoreState.options);
          const restoreStartRawValue = writtenSeal?.rawValue ?? restoreState.trigger.value;
          const restoreElement = option.element;
          const restoreElementRoot = restoreElement.getRootNode();
          const pointerSequenceFence = (
            pointerPhase: 'before-mousedown' | 'after-mousedown' | 'after-mouseup',
          ) => {
            let phase: SemanticControlState | null;
            if (writtenSeal !== undefined) {
              phase = proveExactSemanticSeal(writtenSeal);
              // Before the first restoration pointer, only the transaction's
              // capture-time written seal grants authority. Exact pre-state is
              // accepted only after our pointer sequence has begun, when the
              // host may already have completed restoration on mousedown.
              if (phase === null && pointerPhase !== 'before-mousedown') {
                phase = proveExactSemanticSeal(preWriteSeal);
              }
            } else {
              phase = current();
            }
            if (phase === null) return 'IDENTITY_CHANGED' as const;
            const phaseCandidates = phase.options.filter(
              (candidate) =>
                candidate.identity === priorIdentity && candidate.text === priorText,
            );
            if (
              phaseCandidates.length !== 1 ||
              phaseCandidates[0]!.element !== restoreElement ||
              !restoreElement.isConnected ||
              restoreElement.getRootNode() !== restoreElementRoot
            ) return 'IDENTITY_CHANGED' as const;
            // The capture-bound proof already read raw value and then re-read
            // semantic state. Do not invoke the hostile getter once more after
            // that final semantic proof and before the next pointer event.
            if (writtenSeal !== undefined) return null;
            const phaseState = semanticStateSeal(phase.options);
            const phaseRawValue = phase.trigger.value;
            const stillExactWritten =
              phaseState === restoreStartState && phaseRawValue === restoreStartRawValue;
            const reachedExactPreWrite =
              phaseState === beforeState && phaseRawValue === beforeRawValue;
            if (!stillExactWritten && !reachedExactPreWrite) {
              return 'IDENTITY_CHANGED' as const;
            }
            return null;
          };
          if (!clickHostRestorationTarget({
            element: restoreElement,
            root,
            pointerSequenceFence,
          })) return false;
        }
        const restored = current();
        if (restored === null || semanticStateSeal(restored.options) !== beforeState) return false;
        if (
          restored.trigger.value !== beforeRawValue &&
          !restoreComboboxRawValue(restored.trigger, beforeRawValue)
        ) return false;
        return writtenSeal === undefined
          ? isAtPreWriteState()
          : proveExactSemanticSeal(preWriteSeal) !== null;
      };

      const captureWrittenState = (
        expectedOptionText: string,
      ): ComboboxSemanticUndoTransaction | null => {
        const written = current();
        const expected = normalizeComboboxOptionText(expectedOptionText);
        if (written === null || expected === '') return null;
        const selected = selectedOption(written);
        if (selected === null || selected.text !== expected) return null;
        if (!restoreTargetIsSafe()) return null;
        const provenWritten = current();
        if (provenWritten === null) return null;
        const provenSelected = selectedOption(provenWritten);
        if (provenSelected === null || provenSelected.text !== expected) return null;
        const writtenState = semanticStateSeal(provenWritten.options);
        const writtenRawValue = provenWritten.trigger.value;
        const writtenIdentity = provenSelected.identity;
        const writtenText = provenSelected.text;
        const writtenSeal: ExactSemanticStateSeal = Object.freeze({
          state: writtenState,
          rawValue: writtenRawValue,
          selectedIdentity: writtenIdentity,
          selectedText: writtenText,
        });
        let undoDisposed = false;

        const isAtWrittenState = (): boolean => {
          if (undoDisposed) return false;
          const live = current();
          if (
            live === null ||
            semanticStateSeal(live.options) !== writtenState ||
            live.trigger.value !== writtenRawValue
          ) return false;
          const liveSelected = selectedOption(live);
          return liveSelected?.identity === writtenIdentity && liveSelected.text === writtenText;
        };

        return Object.freeze({
          wasUserEdited: () => false,
          isAtWrittenState,
          restorePreWrite: () => !undoDisposed && restorePreWrite(writtenSeal),
          isAtPreWriteState: () => !undoDisposed && isAtPreWriteState(),
          ownsEventTarget: (target: EventTarget | null) =>
            !undoDisposed && ownsTarget(liveTrigger, optionRoot, target),
          dispose: () => {
            undoDisposed = true;
          },
        });
      };

      return Object.freeze({
        canRestorePreWrite,
        restorePreWrite: () => restorePreWrite(),
        isAtPreWriteState,
        ownsEventTarget: (target: EventTarget | null) =>
          ownsTarget(liveTrigger, optionRoot, target),
        captureWrittenState,
      });
    },
  });

  return sealRuleOwnedComboboxSemanticAuthority({
    optionSource,
    semanticTransactionSource,
    readSelection,
  });
}

/**
 * The one rule whose trigger selector matches this element. None, or several (the rules disagree
 * about what this control is), is no binding; a selector the engine cannot parse matches nothing.
 */
function soleRuleFor<R extends { readonly triggerSelector: string }>(rules: readonly R[], element: Element): R | undefined {
  const matching = rules.filter((rule) => {
    try {
      return element.matches(rule.triggerSelector);
    } catch {
      return false;
    }
  });
  return matching.length === 1 ? matching[0] : undefined;
}

/** Where a rule-declared widget keeps its chosen value(s): its root, and the display under it. */
const valueSlotOf = (rule: { readonly containerSelector: string; readonly selectedValueSelector: string }) => ({
  valueContainerSelector: rule.containerSelector,
  selectedValueSelector: rule.selectedValueSelector,
});

/** The portaled popup a prompt rule declares, and the row in it that answers a pointer. */
const popupOf = (rule: PortaledPromptRule) => ({ popupRootSelector: rule.popupRootSelector, optionSelector: rule.optionSelector });

function listboxBindingFor(
  rules: readonly ListboxComboboxRule[],
  element: HTMLInputElement,
): ListboxComboboxBinding | undefined {
  const rule = soleRuleFor(rules, element);
  if (rule === undefined) return undefined;
  const { valueContainerSelector, selectedValueSelector, multiValueContainerSelector, multiValueLabelSelector, activationSelector, optionSelector } = rule;
  return {
    valueContainerSelector,
    selectedValueSelector,
    ...(multiValueContainerSelector && multiValueLabelSelector ? { multiValueContainerSelector, multiValueLabelSelector } : {}),
    ...(activationSelector === undefined ? {} : { activationSelector }),
    ...(optionSelector === undefined ? {} : { optionSelector }),
  };
}

/**
 * A rule-declared plain-text typeahead (no ARIA listbox) whose trigger selector
 * matches exactly this element. It rides in the same `listbox` binding slot with
 * `typeahead` set, so the plan carries one combobox binding shape and the runner
 * picks the typeahead writer. Exactly one matching rule, as for listboxes.
 */
function typeaheadBindingFor(
  rules: readonly TypeaheadComboboxRule[],
  element: HTMLInputElement,
): ListboxComboboxBinding | undefined {
  const rule = soleRuleFor(rules, element);
  if (rule === undefined) return undefined;
  return {
    ...valueSlotOf(rule),
    typeahead: {
      suggestionSelector: rule.suggestionSelector,
      minTypedChars: rule.minTypedChars,
      ...(rule.selectionWitnessSelector === undefined ? {} : { selectionWitnessSelector: rule.selectionWitnessSelector }),
    },
  };
}

/**
 * A rule-declared portaled prompt (no ARIA listbox, values one level down)
 * whose trigger selector matches exactly this element. Like the typeahead, it
 * rides in the same `listbox` binding slot with `hierarchicalPrompt` set, so
 * the plan carries one combobox binding shape and the runner picks the prompt
 * writer. Exactly one matching rule, as for listboxes.
 */
function promptBindingFor(
  rules: readonly PromptComboboxRule[],
  element: HTMLInputElement,
): ListboxComboboxBinding | undefined {
  const rule = soleRuleFor(rules, element);
  if (rule === undefined) return undefined;
  return {
    ...valueSlotOf(rule),
    hierarchicalPrompt: { ...popupOf(rule), maxCategories: rule.maxCategories },
  };
}

/**
 * A rule-declared search prompt (typing is only a query, Enter searches, rows are portaled) whose
 * trigger selector matches exactly this element. Same binding slot, with `searchPrompt` set.
 */
function searchPromptBindingFor(
  rules: readonly SearchPromptComboboxRule[],
  element: HTMLInputElement,
): (ListboxComboboxBinding & { readonly searchPrompt: SearchPromptShape }) | undefined {
  const rule = soleRuleFor(rules, element);
  if (rule === undefined) return undefined;
  return {
    ...valueSlotOf(rule),
    searchPrompt: { ...popupOf(rule), maxValues: rule.maxValues },
  };
}

/**
 * The one rule-declared upload widget whose file input is exactly this element (2026-09-28, Workday's resume field).
 * The rule itself is the binding: its trigger selector rides along unused (the writer only reads the other four).
 */
function fileUploadBindingFor(rules: readonly FileUploadRule[], element: HTMLInputElement): FileUploadBinding | undefined {
  return soleRuleFor(rules, element);
}

const collapse = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** A rule-declared question scope that resolved for one control: its wrapper and the wording found inside. */
interface ResolvedQuestionScope {
  readonly container: Element;
  readonly text: string;
  /** The same wording before display normalization: required markers (`*`, `(required)`) kept. */
  readonly raw: string;
  /** The rule-declared wording element itself (the question title the user reads). */
  readonly label: Element;
}

/**
 * The first declared question scope (declaration order) whose wrapper holds this control.
 *
 * Fail-closed by construction: the wrapper must be the control's nearest `closest()` match and
 * lie inside the verified scan root; it must hold **exactly one** wording element, and that
 * element must not wrap a control (a whole question row is not its own title — its text would
 * carry option labels along with the question). An invalid selector counts as no match. Two
 * wording elements in one wrapper mean the wrapper is broader than a question; that scope is
 * skipped rather than guessed at. `null` = the interpreter behaves exactly as before.
 */
/**
 * 按下去会不会提交一张表：`input[type=submit|image]`，或属于某张表的 `<button>`（没写 type 的 button 默认就是提交）。
 * 「打开申请表」那一颗只在不是这样时才交出去。
 */
function submitsAForm(control: Element): boolean {
  if (control.localName === 'input') {
    const type = (control.getAttribute('type') ?? '').trim().toLowerCase();
    return type === 'submit' || type === 'image';
  }
  if (control.localName !== 'button') return false;
  const type = (control.getAttribute('type') ?? 'submit').trim().toLowerCase();
  return type !== 'button' && type !== 'reset' && (control as HTMLButtonElement).form !== null;
}

function resolveQuestionScope(
  scopes: readonly QuestionScopeRule[],
  element: Element,
  root: ScanRoot,
  readVisibility?: ScanRootOptions['readVisibility'],
): ResolvedQuestionScope | null {
  for (const scope of scopes) {
    let container: Element | null;
    try {
      container = element.closest(scope.container);
    } catch {
      continue;
    }
    if (container === null || root.isExcluded(container)) continue;
    let labels: readonly Element[];
    try {
      labels = [...container.querySelectorAll(scope.label)];
    } catch {
      continue;
    }
    if (labels.length !== 1) continue;
    const label = labels[0]!;
    if (label.querySelector(CONTROL_SELECTOR) !== null) continue;
    const { text, raw } = labelTextsOf(label, readVisibility);
    if (text === '') continue;
    return { container, text, raw, label };
  }
  return null;
}

/**
 * Every scannable member of a native choice group, in DOM order, with the label the user sees.
 *
 * Inside a resolved question scope the wrapper defines the group: every same-type member it
 * holds is one question even when their `name` attributes differ (2026-09-15 Ashby: each
 * checkbox of "How did you hear about this opportunity? (select all that apply)" is named after
 * its own option text). Without a scope, same-name members are the group, as always.
 */
function choiceGroupOf(
  element: HTMLInputElement,
  root: ScanRoot,
  questionContainer: Element | null,
): ChoiceGroupShape {
  const control = element.type === 'radio' ? 'radio' : 'checkbox';
  const name = nameOf(element);
  const scannable = (member: Element): member is HTMLInputElement =>
    isInput(member) && isScannableControl(member) && !root.isExcluded(member);
  let members: HTMLInputElement[];
  if (questionContainer !== null) {
    members = [...questionContainer.querySelectorAll(`input[type="${control}"]`)].filter(scannable);
  } else if (name === '') {
    members = [element];
  } else {
    members = root
      .querySelectorAll(`input[type="${control}"]`)
      .filter((member): member is HTMLInputElement => scannable(member) && nameOf(member) === name);
  }
  // 成员表必须含控件本身；查不到（例如 type 大小写异常）就退回单成员，不发明成员。
  if (!members.includes(element)) members = [element];
  return { control, options: members.map((member) => ({ element: member, label: root.labelTextFor(member) })) };
}

/** The wording of a choice question: its fieldset legend, else the accessible name of its group role. */
function choiceGroupLabel(element: HTMLInputElement): string {
  const legend = element.closest('fieldset')?.querySelector(':scope > legend');
  if (legend) return collapse(legend.textContent);
  return collapse(element.closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-label'));
}

/**
 * 一道 ARIA 代理题（2026-09-23，见 `dict/ariaChoice.ts` 头注）。
 *
 * `natives` 是这道题名下的全部原生控件——代理里的承载（Workable 的隐藏 radio）与选项旁的镜像
 * （Ashby 那个只镜像 Yes 的 checkbox）。它们**不是**第二个字段：用户操作的是代理，真相在代理的
 * ARIA 状态上；它们仍留在身份计数里（一直都在），所以别的字段的序号一个都不挪。
 */
interface ProxyGroup {
  readonly kind: AriaProxyKind;
  readonly container: Element | null;
  readonly options: readonly ProxyChoiceOption[];
  readonly natives: ReadonlySet<Element>;
  readonly nameSource: HTMLInputElement | null;
  readonly wording: string;
  /** 题干读自的那个元素；来自属性（aria-label）时是 null。 */
  readonly wordingElement: Element | null;
  readonly required: boolean;
  /** 某个选项是有表单归属、点了会提交或重置的按钮：照样列出来，但绝不写。 */
  readonly submitCapable: boolean;
}

interface ProxyGroupResolverInput {
  readonly root: ScanRoot;
  readonly questionScopes: readonly QuestionScopeRule[];
  readonly denyLabels: readonly RegExp[];
  readonly readVisibility?: ScanRootOptions['readVisibility'];
  readonly readGeneratedContent?: ScanRootOptions['readGeneratedContent'];
}

/** 题干与选项文字的等价口径（NFKC、折叠空白、不分大小写），与 `write/choiceGroup.ts` 的 `sameText` 同尺。 */
function comparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isHiddenByAttribute(element: Element): boolean {
  return element.hasAttribute('hidden') || element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
}

/**
 * 把扫描面上的 ARIA 代理选项归成题。每次扫描一个解析器（结果按容器缓存，一次扫描里不重复算）。
 *
 * **归组**：选项的题容器取两者中离它最近的那个——ARIA / HTML 的分组容器
 * （`role=radiogroup|group`、`fieldset`，Workable）与规则声明的 question scope 容器（Ashby）。
 * 容器里的全部代理选项就是这道题的全部选项，必须同一种、而且各自最近的题容器都是它（不认嵌套题）。
 * 没有任何题容器时，只有单个 `role=checkbox` 自成一题（「我同意…」那一类）；落单的切换按钮与
 * radio 说不清是哪道题，不认。
 *
 * **失败关闭**（任何一条不成立，这组代理整个不认，与接这条能力之前逐字相同）：
 *  · 选项数：切换按钮与 radio 至少两个，checkbox 至少一个；
 *  · 代理自己用属性明说藏起来（`hidden` / `aria-hidden="true"`）的不认——看不见的不是题；
 *  · 容器里除了承载、镜像（不在任何选项里、`tabindex=-1` 的原生 radio/checkbox）与 hidden input 之外
 *    还有别的真控件：这组代理不是这道题的作答部件（富文本编辑器的加粗/斜体工具条就是这个形状）；
 *  · 选项文字为空或两两撞车、单选题公布了不止一个选中项、题干读不出来。
 */
function createProxyGroupResolver(input: ProxyGroupResolverInput) {
  const { root, questionScopes, readVisibility, readGeneratedContent } = input;
  const byContainer = new Map<Element, ProxyGroup | null>();
  const byLoneOption = new Map<Element, ProxyGroup | null>();

  const withinRoot = (element: Element | null): element is Element =>
    element !== null && !root.isExcluded(element);

  /** 离这个元素最近的题容器与它的 question scope（若有）。 */
  const questionContainerOf = (element: Element): {
    readonly container: Element | null;
    readonly scope: ResolvedQuestionScope | null;
  } => {
    const candidate = element.parentElement?.closest(ARIA_CHOICE_GROUP_SELECTOR) ?? null;
    const ariaGroup = withinRoot(candidate) ? candidate : null;
    const scope = questionScopes.length === 0
      ? null
      : resolveQuestionScope(questionScopes, element, root, readVisibility);
    const scoped = scope?.container ?? null;
    if (ariaGroup === null) return { container: scoped, scope };
    if (scoped === null) return { container: ariaGroup, scope };
    // 两者都是它的祖先，必有一个包含另一个；取更深（离选项更近）的那个。
    return { container: scoped.contains(ariaGroup) ? ariaGroup : scoped, scope };
  };

  const referencedText = (owner: Element, attribute: string): { text: string; element: Element | null } => {
    const ids = owner.getAttribute(attribute)?.trim().split(/\s+/).filter(Boolean) ?? [];
    const parts: string[] = [];
    let first: Element | null = null;
    for (const id of ids) {
      const referenced = resolveAriaReference(owner, id);
      if (!withinRoot(referenced)) continue;
      const text = labelTextOf(referenced, readVisibility);
      if (text === '') continue;
      parts.push(text);
      first ??= referenced;
    }
    return { text: parts.join(' '), element: first };
  };

  /** 题干：宿主声明的组名（aria-labelledby → aria-label → legend）优先，其次规则声明的 question scope。 */
  const groupWording = (
    container: Element,
    scope: ResolvedQuestionScope | null,
  ): { text: string; element: Element | null } => {
    const labelled = referencedText(container, 'aria-labelledby');
    if (labelled.text !== '') return labelled;
    const aria = collapse(container.getAttribute('aria-label'));
    if (aria !== '') return { text: aria, element: null };
    if (container.localName === 'fieldset') {
      const legend = container.querySelector(':scope > legend');
      const text = legend === null ? '' : labelTextOf(legend, readVisibility);
      if (text !== '') return { text, element: legend };
    }
    if (scope !== null && (scope.container === container || scope.container.contains(container))) {
      return { text: scope.text, element: scope.label };
    }
    return { text: '', element: null };
  };

  /** 单个 checkbox 代理自成一题：题干就是它自己的名字。 */
  const loneWording = (option: Element): { text: string; element: Element | null } => {
    const labelled = referencedText(option, 'aria-labelledby');
    if (labelled.text !== '') return labelled;
    const aria = collapse(option.getAttribute('aria-label'));
    if (aria !== '') return { text: aria, element: null };
    const wrapping = option.parentElement?.closest('label') ?? null;
    if (withinRoot(wrapping)) {
      const text = labelTextOf(wrapping, readVisibility);
      if (text !== '') return { text, element: wrapping };
    }
    const own = labelTextOf(option, readVisibility);
    return { text: own, element: own === '' ? null : option };
  };

  /**
   * 题干这一行上挂没挂必填记号。三种画法都是用户眼睛读到的那个星号：
   *  · 写在题干文字的头尾（「Question *」）；
   *  · 画在题干元素的 `::before` / `::after` 上（Ashby，经注入的读法）；
   *  · 与题干并排、同一行上单独一个元素（Workable：`<span><strong>*</strong></span>` 紧挨着题干那个
   *    span）——从题干往上最多走三层，只要那一层里还没有任何控件或代理，它的文字减去题干若恰好是
   *    一个必填记号，就是这一题的；那一层多出别的文字就停（那已经不是「这一行」了）。
   */
  const wordingShowsRequiredMarker = (wordingElement: Element | null): boolean => {
    if (wordingElement === null) return false;
    const own = rawVisibleTextOf(wordingElement, readVisibility);
    if (hasRequiredMarkerAtEdge(own)) return true;
    if (readGeneratedContent !== undefined) {
      for (const pseudo of ['::before', '::after'] as const) {
        let content: string | null = null;
        try {
          content = readGeneratedContent(wordingElement, pseudo);
        } catch {
          content = null;
        }
        if (generatedContentIsRequiredMarker(content)) return true;
      }
    }
    let line: Element | null = wordingElement.parentElement;
    for (let depth = 0; line !== null && depth < 3; depth += 1, line = line.parentElement) {
      if (!withinRoot(line)) return false;
      if (line.querySelector(`${CONTROL_SELECTOR}, ${ARIA_PROXY_OPTION_SELECTOR}`) !== null) return false;
      const text = rawVisibleTextOf(line, readVisibility);
      const at = own === '' ? -1 : text.indexOf(own);
      if (at < 0) return false;
      const rest = `${text.slice(0, at)} ${text.slice(at + own.length)}`.trim();
      if (rest === '') continue;
      return isRequiredMarkerText(rest);
    }
    return false;
  };

  const build = (
    kind: AriaProxyKind,
    container: Element | null,
    members: readonly Element[],
    wording: { text: string; element: Element | null },
  ): ProxyGroup | null => {
    if (wording.text === '') return null;
    if (members.length < (kind === 'checkbox' ? 1 : 2)) return null;
    if (members.some((member) => !withinRoot(member) || isHiddenByAttribute(member))) return null;

    const options: ProxyChoiceOption[] = [];
    const natives = new Set<Element>();
    for (const member of members) {
      const carrier = ariaProxyCarrier(member, kind);
      if (carrier === 'AMBIGUOUS') return null;
      if (carrier !== null) natives.add(carrier);
      const label = container === null
        ? wording.text
        : labelTextOf(member, readVisibility) || collapse(member.getAttribute('aria-label'));
      if (label === '') return null;
      options.push(Object.freeze({ element: member as HTMLElement, label, carrier }));
    }
    const labels = options.map((option) => comparableText(option.label));
    if (new Set(labels).size !== labels.length) return null;
    if (isSingleChoiceProxy(kind) && members.filter((member) => ariaProxyPressed(member, kind) === true).length > 1) {
      return null;
    }
    if (input.denyLabels.some((pattern) => pattern.test(wording.text) || options.some((option) => pattern.test(option.label)))) {
      return null;
    }

    // 容器里的每一个真控件都得是这道题名下的：承载、镜像或 hidden input。多出任何一个就不是这道题的部件。
    const scope = container ?? members[0]!;
    const mirrors: HTMLInputElement[] = [];
    for (const control of scope.querySelectorAll(CONTROL_SELECTOR)) {
      if (!isScannableControl(control) || natives.has(control)) continue;
      if (isInput(control) && control.type === 'hidden') continue;
      const mirror = isInput(control) &&
        (control.type === 'radio' || control.type === 'checkbox') &&
        control.getAttribute('tabindex') === '-1' &&
        nearestAriaProxyOption(control) === null;
      if (!mirror) return null;
      mirrors.push(control);
      natives.add(control);
    }

    const nativeInputs = [...options.flatMap((option) => (option.carrier === null ? [] : [option.carrier])), ...mirrors];
    const required =
      container?.getAttribute('aria-required') === 'true' ||
      members.some((member) => member.getAttribute('aria-required') === 'true') ||
      nativeInputs.some((native) => isRequired(native)) ||
      wordingShowsRequiredMarker(wording.element);
    return Object.freeze({
      kind,
      container,
      options: Object.freeze(options),
      natives,
      nameSource: nativeInputs.find((native) => nameOf(native) !== '') ?? null,
      wording: wording.text,
      wordingElement: wording.element,
      required,
      submitCapable: members.some(canSubmitOrResetAForm),
    });
  };

  const groupOf = (option: Element): ProxyGroup | null => {
    const kind = ariaProxyKind(option);
    if (kind === null) return null;
    const { container, scope } = questionContainerOf(option);
    if (container === null) {
      if (kind !== 'checkbox') return null;
      if (!byLoneOption.has(option)) {
        byLoneOption.set(option, build(kind, null, [option], loneWording(option)));
      }
      return byLoneOption.get(option) ?? null;
    }
    if (!byContainer.has(container)) {
      const members = [...container.querySelectorAll(ARIA_PROXY_OPTION_SELECTOR)]
        .filter((member) => !['input', 'select', 'textarea'].includes(member.localName));
      const coherent = members.every((member) =>
        ariaProxyKind(member) === kind && questionContainerOf(member).container === container);
      byContainer.set(container, coherent ? build(kind, container, members, groupWording(container, scope)) : null);
    }
    const group = byContainer.get(container) ?? null;
    return group !== null && group.options.some((candidate) => candidate.element === option) ? group : null;
  };

  /** 这个原生控件是不是某道代理题名下的承载或镜像（那样它就不是第二个字段）。 */
  const ownsNative = (control: HTMLInputElement): boolean => {
    if (control.type !== 'radio' && control.type !== 'checkbox') return false;
    const carrierOf = nearestAriaProxyOption(control);
    if (carrierOf !== null) return groupOf(carrierOf)?.natives.has(control) === true;
    const { container } = questionContainerOf(control);
    if (container === null) return false;
    const first = container.querySelector(ARIA_PROXY_OPTION_SELECTOR);
    if (first === null) return false;
    const group = groupOf(first);
    return group !== null && group.container === container && group.natives.has(control);
  };

  return { groupOf, ownsNative };
}

function proxyChoiceShape(group: ProxyGroup): ProxyChoiceGroupShape {
  return Object.freeze({
    control: 'proxy',
    proxy: group.kind,
    multiple: !isSingleChoiceProxy(group.kind),
    options: group.options,
    container: group.container,
    nameSource: group.nameSource,
    question: group.wordingElement,
  });
}

function semanticAuthorityFor(
  rules: readonly ComboboxSemanticControlRule[],
  element: HTMLInputElement,
  root: ScanRoot,
): ComboboxSemanticAuthority | undefined {
  const matching = rules.filter((rule) => resolveSemanticTrigger(rule, root) === element);
  return matching.length === 1
    ? createComboboxSemanticAuthority(matching[0]!, element, root)
    : undefined;
}

/**
 * 通用路（2026-09-28）：一个简历上传栏也算一个「认得的字段」。
 *
 * 规则的键只指档案字段，简历不是档案键，所以从前一张「Name / Email / Resume / LinkedIn」的表（Shopify、
 * Valve 的形状）数出来只有两三个，差一个门槛。判据与计划期同一套词表（`dict/guards.ts` 的
 * `isResumeFileField`：标签与稳定钩子正向认出简历、又没说到求职信成绩单一类），只看标签与属性、不读邻近上下文——
 * 这里是认表的门槛，不是写入的批准；写不写仍由 engine 与 setFile 按各自的身份判据再判。
 */
function countsAsResumeUpload(field: ApplyFieldDescriptor): boolean {
  if (field.kind !== 'file') return false;
  const element = field.element;
  const identities = [
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('data-automation-id'),
    element.getAttribute('data-ui'),
    element.getAttribute('data-qa'),
    element.getAttribute('data-testid'),
  ];
  return isResumeFileField(field.label, identities) && !isNonResumeFileField(field.label, identities);
}

/** 组标题：控件所在 fieldset 的 legend，或 `role=group` 的可读名。读不到就是空串。 */
function groupCaptionOf(
  element: Element,
  root: ScanRoot,
  readVisibility?: ScanRootOptions['readVisibility'],
): string {
  const fieldset = element.closest('fieldset');
  if (fieldset !== null && !root.isExcluded(fieldset)) {
    const legend = [...fieldset.children].find((child) => child.localName === 'legend') ?? null;
    const text = legend === null ? '' : labelTextOf(legend, readVisibility);
    if (text !== '') return text;
  }
  const group = element.closest('[role="group"]');
  if (group === null || root.isExcluded(group)) return '';
  const labelledBy = group.getAttribute('aria-labelledby')?.trim().split(/\s+/).filter(Boolean) ?? [];
  const referenced = labelledBy
    .map((id) => resolveAriaReference(group, id))
    .filter((node): node is Element => node !== null && !root.isExcluded(node))
    .map((node) => labelTextOf(node, readVisibility))
    .filter((text) => text !== '')
    .join(' ');
  return referenced !== '' ? referenced : collapse(group.getAttribute('aria-label'));
}

/** 小标签：一两个词（「First」「Last」「Given」），不是一句题面。 */
const SUB_LABEL_MAX_WORDS = 3;
const SUB_LABEL_MAX_LENGTH = 24;
const GROUP_CAPTION_MAX_LENGTH = 80;

function isSubLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed !== '' && trimmed.length <= SUB_LABEL_MAX_LENGTH && trimmed.split(/\s+/).length <= SUB_LABEL_MAX_WORDS;
}

/**
 * 只有占位项的原生下拉（2026-09-28 通用路）：没有 `<label>`、没有 aria，唯一说明这是什么的就是第一项
 * （`<option value="">Select Position</option>`、`-- Country --`）。推断级联会把整张选项表拼成标签——一长串
 * 国名，或者超长被丢掉——于是这一栏什么都认不出。第一项的值为空（或是禁用的提示项）才算占位项；
 * 去掉两头的破折号与省略号。认键时再去掉「Select／Choose／Please select」这类动词（`placeholderSubject`）。
 */
function selectPlaceholderLabel(element: HTMLSelectElement): string {
  const first = element.options[0];
  if (first === undefined) return '';
  const placeholder = first.value.trim() === '' || first.disabled;
  if (!placeholder) return '';
  return collapse(first.textContent).replace(/^[-–—_.:\s]+|[-–—_.:…\s]+$/gu, '').trim();
}

/** 占位项去掉「选一个」那半句，剩下的才是这一栏问的东西（「Select a Country」→「Country」）。 */
function placeholderSubject(placeholder: string): string {
  const subject = placeholder
    .replace(/^(?:please\s+)?(?:select|choose|pick|enter)(?:\s+(?:a|an|the|your|one|an?\s+option|option))*\b\s*/iu, '')
    .replace(/^(?:bitte\s+)?(?:w[äa]hlen|ausw[äa]hlen)\b\s*/iu, '')
    .trim();
  // 只剩「one」「an option」「…」这种的，说不出问的是什么。
  return /^(?:one|an?\s+option|option|\W*)$/iu.test(subject) ? '' : subject;
}

/**
 * 把 `ScanRootOptions.locale` 归一成 BCP-47 **主子标签**（小写）。
 * 空串、纯空白、非法值一律当作"未知"——未知时所有 pattern 都参与，
 * 保持接 locale 分层之前的行为，不因为读不到 lang 就悄悄少认字段。
 */
function primaryLanguage(locale: string | undefined): string | null {
  const tag = locale?.trim().toLowerCase().split('-')[0] ?? '';
  return /^[a-z]{2,3}$/.test(tag) ? tag : null;
}

/**
 * 这个控件所在的行作用域规则；不在任何行里就是 `undefined`。
 *
 * ⚠️ 它**收算好的 `scopeKey`，自己不查**。`identityScope` 是每字段一次全树查询
 * （`scanRoot.ts` 头注记着实测「400 字段 38ms、200 字段 10ms」的二次方形态），
 * 所以扫描循环里只查一次、结果传给下游——一度 `rowRuleFor` 与 `rowScopedKey`
 * 各查一次，800 字段的注入预算当场从 <400ms 涨到 438ms，被 CAP-AF-065 的门禁抓住。
 *
 * 2026-08-23 又踩了一次同一个坑，这次是**跨模块**：本函数查一次、`fieldSignature`
 * 再查一次，那条注释管不到另一个文件。所以现在把 scope 提到调用处算，
 * 两边共用同一份。
 */
function rowRuleFor(
  scopeKey: string,
  rowScopes: readonly RowScopeRule[],
): RowScopeRule | undefined {
  if (rowScopes.length === 0) return undefined;
  if (!scopeKey.startsWith(ROW_SCOPE_PREFIX)) return undefined;
  return rowScopes[Number(scopeKey.slice(ROW_SCOPE_PREFIX.length).split(':')[0])];
}

/** 行内单元名：有 `cellIdPattern` 就从 id 剥行号，否则按 name。 */
function cellNameOf(element: Element, rule: RowScopeRule | undefined): string | null {
  if (rule === undefined) return null;
  const raw =
    rule.cellIdPattern === undefined
      ? element.getAttribute('name')
      : rule.cellIdPattern.exec(element.getAttribute('id') ?? '')?.[1];
  return raw === null || raw === undefined ? null : raw.toLowerCase();
}

/**
 * 行内映射声明的角色。**已解析好的** rule 与 cellName 传进来，本函数不碰 DOM。
 *
 * 行内映射优先于全局 `keySteps`：它是最具体的厂商知识，而且全局表表达不了
 * 「这个 `start_date` 是经历段的还是教育段的」（两段共用同一批 name）。
 * 置信度不参与——厂商按 name 逐一声明，命中即确定（与 attrMap 同档）。
 */
function rowScopedKey(
  rule: RowScopeRule | undefined,
  cellName: string | null,
): CollectionFieldRole | null {
  if (rule?.fieldMap === undefined || rule.collection === undefined || cellName === null) {
    return null;
  }
  const suffix = rule.fieldMap[cellName];
  if (suffix === undefined) return null;
  const role = `${rule.collection}.${suffix}`;
  return isCollectionFieldRole(role) ? role : null;
}

/**
 * 把标签尾部的必填／选填标记剥掉，再交给标签规则匹配。
 *
 * 296 条标签规则里绝大多数以 `$` 收尾（`^country$`、`…attend?$`、`^summary$`）。宿主
 * 把标记渲染进可访问名时——`Country *`、`…attend? ✱`、`Email (required)`——这些规则
 * **一条都不中**。2026-09-22 量过：语料里能被认出的 62 个 (厂商, 标签) 组合，末尾加
 * 一个标记，46 个（74%）当场认不出。
 *
 * 剥在这里而不是逐条给正则加尾巴：296 处每一处都可能把别的写法改坏，而且下一条新
 * 规则又会忘记加。这里是一处的事，对已有与未来的规则同时生效。已经自带 `\s*\*?$`
 * 那种尾巴的规则不受影响——标记被剥掉之后，那段可选尾巴匹配空串。
 *
 * **只剥尾部**，且只剥这两类：
 *  · 星号类符号（`*` `✱` `✳` `＊` `★` `•`）；
 *  · 括号里的 required / optional / if applicable，含中文全角括号与「必填」「选填」。
 *
 * 光秃秃的 `required` 一词**不剥**：「Salary required」是一条真标签，剥成「Salary」
 * 就是另一个意思。标记出现在句中也不剥——那是句子的一部分，不是渲染出来的标记。
 */
const REQUIRED_MARKER_TAIL =
  /(?:\s*(?:[*\u2731\u2733\uFF0A\u2605\u2022]+|[(（]\s*(?:required|optional|if\s+applicable|必填|选填|選填)\s*[)）]))+\s*$/u;

function stripRequiredMarker(label: string): string {
  return label.replace(REQUIRED_MARKER_TAIL, '').trim();
}

function resolveKey(
  steps: readonly CompiledKeyStep[],
  element: Element,
  label: string,
  pageLanguage: string | null,
): ResolvedRuleKey {
  for (const step of steps) {
    switch (step.type) {
      case 'attrMap': {
        const value = (element.getAttribute(step.attr) || '').toLowerCase();
        const key = step.map.get(value);
        if (key === RULE_PLAIN_TEXT_CONTENTEDITABLE_TARGET) {
          return {
            key: null,
            confidence: step.confidence,
            plainTextContenteditable: { attr: step.attr, expectedValue: value },
          };
        }
        if (key) return { key, confidence: step.confidence, plainTextContenteditable: null };
        break;
      }
      case 'ancestorAttrMap': {
        // Site knowledge remains in JSON: the interpreter only walks ancestors and
        // reads the rule-declared, closed-set attribute. Exact map values prevent a
        // nearby unrelated wrapper from becoming a fuzzy fallback.
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const rawValue = ancestor.getAttribute(step.attr);
          if (rawValue === null) continue;
          const value = rawValue.toLowerCase();
          const key = step.map.get(value);
          if (key) return { key, confidence: step.confidence, plainTextContenteditable: null };
          // The nearest wrapper declaring this attribute owns the field. An
          // unknown value is a closed-set denial, never permission to inherit a
          // broader outer wrapper (for example extension nested under phone).
          return NO_KEY;
        }
        break;
      }
      case 'stopNamePrefix': {
        const name = nameOf(element);
        if (step.prefixes.some((prefix) => name.startsWith(prefix))) return NO_KEY;
        break;
      }
      case 'labelFallbackGate': {
        const name = nameOf(element);
        const allowed = name === '' ? step.allowEmptyName : step.nameRegex.test(name);
        if (!allowed) return NO_KEY;
        break;
      }
      case 'labelPatterns': {
        const haystack = stripRequiredMarker(label.toLowerCase());
        if (!haystack) break;
        // 未声明 locales = 通用；声明了就只在匹配的页面语言下参与。
        // 页面语言未知（调用方没注入）时**全部参与**——保持接分层之前的行为，
        // 不因为读不到 lang 就悄悄少认字段。
        const hit = step.patterns.find(
          (entry) =>
            (entry.locales === undefined || pageLanguage === null || entry.locales.includes(pageLanguage)) &&
            entry.regex.test(haystack),
        );
        if (hit) {
          return { key: hit.key, confidence: step.confidence, plainTextContenteditable: null };
        }
        break;
      }
      default:
        return assertNever(step, 'resolveKey rule step type');
    }
  }
  return NO_KEY;
}

/** 把一份校验过的规则编译成 VendorAdapter。正则只在这里编译一次。 */
export function compileRuleAdapter(ruleset: VendorRuleset): VendorAdapter {
  const applyPath = compileRegex(ruleset.applyPath);
  const embeddedApplyPath =
    ruleset.embeddedApplyPath === null ? null : compileRegex(ruleset.embeddedApplyPath);
  // 白标 B 的钩子：本家 attrMap(id) 的每一个 id。属性选择器不用转义，id 里有什么都安全。
  const whitelabelRoot = ruleset.whitelabelRoot;
  const genericRoot = ruleset.genericRoot;
  const whitelabelHooks: readonly string[] = whitelabelRoot === null
    ? []
    : ruleset.keySteps.flatMap((step) =>
        step.type === 'attrMap' && step.attr === 'id'
          ? Object.keys(step.map).map((id) => `[id="${id.replace(/["\\]/g, '')}"]`)
          : []);
  const denyLabels = ruleset.denyLabels.map(compileRegex);
  const widgetNames = new Set(ruleset.widgetNames);
  const steps = ruleset.keySteps.map(compileKeyStep);
  const questionScopes = ruleset.questionScopes;
  // 账号墙（2026-09-28）：规则声明了才编译；没声明的厂商下面四项一律答「没有」。
  const account = ruleset.accountSteps === null ? null : compileAccountWall(ruleset.accountSteps, ruleset.excludeWithin);
  /**
   * 扫描时不看的地方：规则的 excludeWithin，加上这一家声明的验证码提示的容器（2026-10-04）。验证码格从来不是填写计划的
   * 一部分——不排进计划、不送给 AI 代答、不进「需要你」；它们只经 `write/emailCode.ts` 写他本人在浮层里输的那一串。
   */
  const scanExclusions: readonly string[] = Object.freeze([
    ...ruleset.excludeWithin,
    ...(ruleset.emailVerification?.codePrompts.map((prompt) => prompt.container) ?? []),
  ]);

  /**
   * 一次扫描是一个同步拍子：这一拍里的穿透查询共用一份影子根索引（scanRoot.ts 的 `withScanPass`，2026-09-28
   * 通用路探测耗时）。写入期的身份复核不在拍子里，照旧活查。
   */
  function scan(root: ScanRoot, options?: ScanRootOptions): readonly ApplyFieldDescriptor[] {
    return withScanPass(root, () => scanInPass(root, options));
  }

  function scanInPass(root: ScanRoot, options?: ScanRootOptions): readonly ApplyFieldDescriptor[] {
    // 每次扫描重装一次厂商声明的上下文深度：换厂商就换设定，不累积，也不会让
    // 上一家的设定泄漏到这一家的页面上。缺省 null = 内核默认的 4 层。
    installFileContextMaxDepth(ruleset.fileContextMaxDepth);
    const pageLanguage = primaryLanguage(options?.locale);
    const fields: ApplyFieldDescriptor[] = [];

    // ARIA 代理题（2026-09-23）按题归组，一次扫描一个解析器、按容器缓存。
    const proxies = createProxyGroupResolver({
      root,
      questionScopes,
      denyLabels,
      ...(options?.readVisibility === undefined ? {} : { readVisibility: options.readVisibility }),
      ...(options?.readGeneratedContent === undefined ? {} : { readGeneratedContent: options.readGeneratedContent }),
    });

    // 扫描面来自 `scanRoot`，不在这里重写一遍。2026-08-21 实测：这两处各写了一份
    // `'input, select, textarea'`，于是把 contenteditable 加进扫描面之后，
    // scanRoot 收得到、解释器照样丢——同一个常量抄两份，漏改一处就等于没改。
    // ARIA 代理选项（`dict/ariaChoice.ts`）与原生控件在同一次文档序遍历里，题才排在它在表上的位置。
    for (const element of root.querySelectorAll(scanSelector())) {
      // 用户操作的是代理、原生控件藏着或只是镜像的选择题：一组一道题，只由 DOM 顺序的第一个选项报告。
      if (ariaProxyKind(element) !== null) {
        if (root.isExcluded(element)) continue;
        const group = proxies.groupOf(element);
        if (group === null || group.options[0]!.element !== element) continue;
        // 规则里读属性的那几步（attrMap / name 闸 / 祖先表）读带着这道题表单名的原生控件，
        // 与原生题读第一个成员同一个姿势；没有就读代理本身。
        const keyElement = group.nameSource ?? element;
        if (ruleset.denyNameSubstrings.some((fragment) => nameOf(keyElement).includes(fragment))) continue;
        const signature = fieldSignature(element, root, root.identityScope(element));
        const proxyKey = resolveKey(steps, keyElement, group.wording, pageLanguage);
        if (group.submitCapable) {
          // 点了会提交或重置一张表单的按钮：这道题照样列出来（带着认出的键），交还用户，绝不点。
          fields.push({
            kind: 'unsupported',
            element,
            key: proxyKey.key,
            label: group.wording,
            signature,
            required: group.required,
            confidence: 0,
            unsupportedReason: 'WIDGET',
          });
          continue;
        }
        fields.push({
          kind: 'choice',
          element: element as HTMLElement,
          key: proxyKey.key,
          label: group.wording,
          signature,
          required: group.required,
          confidence: proxyKey.key === null ? 0 : proxyKey.confidence,
          choice: proxyChoiceShape(group),
        });
        continue;
      }
      if (!isScannableControl(element)) continue;
      if (root.isExcluded(element)) continue;

      // 反滥用管道永不进扫描结果，连"手动项"都不算。Ashby 把 g-recaptcha-response
      // 放在与真实问题同一个容器里，这条过滤在那家是承重墙。
      const name = nameOf(element);
      if (ruleset.denyNameSubstrings.some((fragment) => name.includes(fragment))) continue;
      if (isInput(element) && element.type === 'hidden') continue;
      // 一道 ARIA 代理题名下的承载或镜像不是第二个字段（见 `ProxyGroup.natives`）。排在占位框判据
      // 之前只是为了把原因说对：Workable 的承载恰好也长着占位框的样子，Ashby 的镜像则不是。
      if (isInput(element) && proxies.ownsNative(element)) continue;
      // 站点自己声明不是给人填的（react-select 的校验垫片等）。见 dict/controls.ts。
      if (isSiteDeclaredNonInput(element)) continue;

      // 标签的三级来源，前者永远压过后者：
      //  1. 宿主**声明**给控件的名字（显式/包裹 label、aria-*）；
      //  2. 规则声明的 question scope 里的题干（容器唯一命中才算，见 resolveQuestionScope）；
      //  3. 推断级联（占位符、title、附近文字）——没有规则或规则没命中时与从前逐字相同。
      // 2026-09-15 实测：Lever 自定义题只有 placeholder「Type your response」、Rippling 的
      // 长题干超出附近文字的长度上限、Dover 的题干是 styled div——三家都落在第 2 级。
      // 同一条级联顺手交出**同一来源**保留必填记号的原文（显示用的 label 把 `*` 剥掉了），
      // 不多一次 DOM 查询。占位符与 title 不交：框里的提示不是标签。
      let rawLabel = '';
      const captureRawLabel = (raw: string): void => { rawLabel = raw; };
      const declaredLabel = root.labelTextFor(element, { declaredOnly: true, onRawText: captureRawLabel });
      const questionScope = questionScopes.length === 0
        ? null
        : resolveQuestionScope(questionScopes, element, root, options?.readVisibility);
      let label: string;
      if (declaredLabel !== '') label = declaredLabel;
      else if (questionScope !== null) {
        label = questionScope.text;
        rawLabel = questionScope.raw;
      } else label = root.labelTextFor(element, { onRawText: captureRawLabel });
      // 通用路（2026-09-28）：推断级联什么都读不出的原生下拉，用占位项当标签（见 selectPlaceholderLabel）；
      // 占位项只是一句「Please select one」、说不出问的是什么的，不算。
      const placeholder = genericRoot !== null && label === '' && isSelect(element) ? selectPlaceholderLabel(element) : '';
      if (placeholder !== '' && placeholderSubject(placeholder) !== '') {
        label = placeholder;
        rawLabel = placeholder;
      }
      if (denyLabels.some((pattern) => pattern.test(label))) continue;

      // 每字段**只查一次** identityScope，结果同时喂给签名与行规则。
      // 分开查的代价实测是整条扫描路径的查询次数翻倍（见 rowRuleFor 头注）。
      const scope = root.identityScope(element);
      const signature = fieldSignature(element, root, scope);
      // 必填：宿主声明的（required / aria-required="true"），或者宿主**写在标签上**给用户看的记号
      // （2026-09-23）。很多宿主只在标签文字里标必填：BambooHR 渲染「Are you at least 18 years of
      // age? *」、Workable 把红色的 `*` 放在题干**前面**，控件上一个 required 都没有——于是它们
      // 都是 required=false，浮层的「需要你」只列必填，youngliving.bamboohr.com 上说「还有 1 项」
      // 而 7 道必填没答。判据（头或尾的星号类记号、结尾的「(required)」「(必填)」；带「(optional)」
      // 的不算；句中光秃秃的 required 不算）在 dict/requiredMarker.ts，与代理题同一把尺。
      const required = isRequired(element) || hasRequiredMarkerAtEdge(rawLabel);

      // 声明了 `writeMode: 'typed'` 的行：只接受逐字符增量输入，整串写入会被
      // 宿主的表单状态拒收而 `element.value` 留着——回读判决会把这次报成成功
      // （2026-08-23 Workable 实测，50-证据库 §F.6-s）。在逐字符写入通路落地
      // 之前一律如实报 WIDGET：那正是「值被厂商部件托管」这个原因码的含义。
      //
      // 挂在行作用域而不是全局 `widgetNames`：后者按 name 匹配，而 Workable 的
      // `summary` 在同一张表单里出现两次（另一个是求职信），全局标记会误伤。
      // 值被厂商部件托管的文本框：往里写字回读会把没成功报成成功（Lever location）。
      // 每字段只查一次行作用域（见 rowRuleFor 头注的性能说明）。
      const rowRule = rowRuleFor(scope.scopeKey, ruleset.rowScopes);
      const cellName = cellNameOf(element, rowRule);
      const typedRow = rowRule?.writeMode === 'typed';
      // 掩码格**不放行**：投影层给日期的首选是 `2021-06`，敲进 `MM/YYYY` 掩码
      // 会得到一个错误的日期，而回读判决恰好会把它判成成功
      // （50-证据库 §F.6-w 第二条）。在「预测形态 + 严格相等」落地之前，
      // 它们照旧如实报填不了；同一行的普通文本格照常走逐字符通路。
      const maskedCell =
        typedRow && cellName !== null && (rowRule?.maskedCells ?? []).includes(cellName);
      if (widgetNames.has(name) || maskedCell) {
        fields.push({
          kind: 'unsupported',
          element,
          // typed 行**保留已解析出的键**：这一栏我们其实认出来了，只是写不进去。
          // 审计面板据此能说「这是你的职位，但这一栏得你自己填」，而不是
          // 含糊的「有个控件我们处理不了」。widgetNames 那一路维持原样
          // （它是按 name 的全局表，没有行上下文）。
          key: maskedCell ? rowScopedKey(rowRule, cellName) : null,
          label,
          signature,
          required,
          confidence: 0,
          unsupportedReason: 'WIDGET',
        });
        continue;
      }

      const kind = classifyControl(element);
      if (kind === 'unsupported') {
        fields.push({
          kind: 'unsupported',
          element,
          key: null,
          label,
          signature,
          required,
          confidence: 0,
          unsupportedReason: 'CONTROL_TYPE',
        });
        continue;
      }
      // 单选/复选：一组成员是**一道题**，只由 DOM 顺序的第一个成员报告一次，带上整组成员
      // 与用户看到的选项文字。成员按 question scope 的容器归组（命中时），否则按同名归组。
      // 题干：宿主声明的组名（fieldset>legend / 组 aria-label）优先；多成员组取 scope 里的题干；
      // 单成员组的题干就是它自己的标签（已按声明→scope→推断算好——「I confirm…」这种自带
      // 包裹 label 的单个 checkbox 永远保留自己的文字，题干容器只在它没有声明标签时接手）。
      if (kind === 'choice') {
        if (!isInput(element)) continue;
        const choice = choiceGroupOf(element, root, questionScope?.container ?? null);
        if (choice.options[0]?.element !== element) continue;
        const groupLabel = choiceGroupLabel(element);
        const wording =
          groupLabel ||
          (choice.options.length === 1 ? label : questionScope?.text ?? '');
        // 题干的原文（保留必填记号）跟着题干的来源走：组名本来就是原文（legend 的 textContent /
        // 组的 aria-label），单成员组是它自己标签的原文，多成员组是 question scope 题干的原文。
        const wordingRaw =
          groupLabel ||
          (choice.options.length === 1 ? rawLabel : questionScope?.raw ?? '');
        // 题干与成员标签是两段文字，反滥用文案要对题干也查一次。
        if (wording !== label && denyLabels.some((pattern) => pattern.test(wording))) continue;
        // 用**题干**解键，不是成员标签：一组单选的成员标签是「Yes」「No」，
        // 规则认的是「Are you at least 18 years of age?」。`wording` 已经按
        // 「宿主声明的组名 → question scope → 单成员自己的标签」算好。
        //
        // 2026-09-22 之前这里写死 `key: null`，于是 engine 里
        // `field.key !== null` 那道前置条件永远不成立，每一个 radio/checkbox 组
        // 都落 CHOICE_NO_DATA——P1-5 接的「有档案值的选择题按档案写」**在真实页面上
        // 从来没有生效过一次**。它的测试一直是绿的，因为那些用例手工构造描述符、
        // 直接给了 key，从不经过扫描器。本仓同一形状的第六次。
        //
        // 接上键不会绕过防线：engine 的三道守卫（蜜罐 / 推荐人 / 岗位相关）排在
        // choice 分支之前，那是 2026-08-15 就修好的顺序属性。
        const choiceKey = resolveKey(steps, element, wording, pageLanguage);
        fields.push({
          kind: 'choice',
          element,
          key: choiceKey.key,
          label: wording,
          signature,
          required: choice.options.some((option) => isRequired(option.element)) || hasRequiredMarkerAtEdge(wordingRaw),
          confidence: choiceKey.key === null ? 0 : choiceKey.confidence,
          choice,
        });
        continue;
      }

      // 行内映射先于全局 keySteps：它是**最具体的**厂商知识，而且全局表
      // 表达不了「这个 start_date 是经历段的还是教育段的」（两段共用同一批
      // name，见 contracts.ts 的 RowScopeRule.fieldMap）。
      const rowKey = rowScopedKey(rowRule, cellName);
      let resolved: ResolvedRuleKey = rowKey
        ? { key: rowKey, confidence: 1, plainTextContenteditable: null }
        : resolveKey(steps, element, placeholder !== '' && label === placeholder ? placeholderSubject(label) : label, pageLanguage);
      // 通用路（2026-09-28，Gravity Forms）：「Name」标题下的「First」「Last」两个小标签。小标签自己认不出、
      // 又落在一个有标题的组（fieldset 的 legend、role=group 的可读名）里，就把小标签接上标题再认一次
      // （「First」+「Name」→「First Name」）；认出来了，标签也换成接上的那一句，面板与守卫读到的是完整的题。
      // 只给通用路：厂商路上有锚点与自己的钩子，那边的认法不动。只加键、从不改掉已经认出的键。
      if (resolved.key === null && rowKey === null && genericRoot !== null && kind !== 'file' && isSubLabel(label)) {
        const caption = groupCaptionOf(element, root, options?.readVisibility);
        if (caption !== '' && caption.length <= GROUP_CAPTION_MAX_LENGTH && collapse(caption) !== collapse(label)) {
          const composed = `${label} ${caption}`;
          const retry = resolveKey(steps, element, composed, pageLanguage);
          if (retry.key !== null && !denyLabels.some((pattern) => pattern.test(composed))) {
            resolved = retry;
            label = composed;
          }
        }
      }
      const { key, confidence } = resolved;
      const common = {
        key,
        label,
        signature,
        required,
        confidence,
        ...(typedRow ? { writeMode: 'typed' as const } : {}),
      };
      switch (kind) {
        // 三种 kind 的元素类型都是 HTMLInputElement，但**必须分开写**：合并成
        // 一个 case 之后 `kind` 是联合类型，TS 映射不回判别联合，只能靠 cast 蒙混——
        // 而 cast 正是这套全量记录设计要消灭的东西。
        case 'text':
          if (isInput(element)) {
            // 规则量过的纯文本 typeahead（Lever location）：DOM 上是普通文本框，值却由
            // 建议列表托管——整串写入会留下一个看着填了、表单里没有的框（旧 widgetNames
            // 的由来）。有 measured binding 时按 combobox 走建议匹配 + 点选 + 回读；
            // 没有就仍是普通文本框。
            const typeahead = typeaheadBindingFor(ruleset.typeaheadComboboxes, element);
            // A plain text input the rule identifies as the **value mirror** of a
            // hosted picker: the widget a human operates is the declared visible
            // activation control, and nothing can be typed here (Workday's
            // `button[aria-haspopup="listbox"]` + 0×0 sibling input, 2026-09-15).
            // Only a rule that names that control turns the mirror into a
            // combobox; without `activationSelector` a text input stays text.
            const mirrored = listboxBindingFor(ruleset.listboxComboboxes, element);
            const hosted = mirrored?.activationSelector === undefined ? undefined : mirrored;
            // A plain text input whose value only arrives by walking a portaled,
            // tiered menu (Workday's "How Did You Hear About Us?", 2026-09-15).
            // Typing into it is discarded, so without a measured binding it must
            // stay an ordinary text field rather than be written and reverted.
            const prompt = promptBindingFor(ruleset.promptComboboxes, element);
            // A search prompt (Workday's Field of Study / Skills, 2026-09-24): text typed into it is
            // only a query, so without a measured binding it stays an ordinary text field.
            const search = searchPromptBindingFor(ruleset.searchPromptComboboxes, element);
            // 通用路（2026-09-28）：页面自己说这一栏要从建议里选（Shopify 的 Location），又没有任何绑定——整串写进去
            // 宿主不收，交还本人；认出的键留着，面板说得清「这是你的所在地，但这一栏得你自己选」。
            const pickOnly = genericRoot !== null && typeahead === undefined && hosted === undefined && prompt === undefined &&
              search === undefined && describesPickFromSuggestions(label);
            if (pickOnly) fields.push({ ...common, kind: 'unsupported', element, confidence: 0, unsupportedReason: 'WIDGET' });
            else if (typeahead !== undefined) fields.push({ ...common, kind: 'combobox', element, listbox: typeahead });
            else if (hosted !== undefined) fields.push({ ...common, kind: 'combobox', element, listbox: hosted });
            else if (prompt !== undefined) fields.push({ ...common, kind: 'combobox', element, listbox: prompt });
            // More than one value (Skills) makes it a multi-value widget; one (Field of Study) is one answer.
            else if (search !== undefined) {
              fields.push({ ...common, kind: 'combobox', element, listbox: search, ...(search.searchPrompt.maxValues > 1 ? { multiple: true } : {}) });
            } else fields.push({ ...common, kind, element });
          }
          break;
        // 部件托管的下拉：同样是 <input>，但值只能靠开→点选进去，不能 setValue。
        case 'combobox':
          if (isInput(element)) {
            const semanticAuthority = semanticAuthorityFor(
              ruleset.comboboxSemanticControls,
              element,
              root,
            );
            const listbox = listboxBindingFor(ruleset.listboxComboboxes, element)
              ?? typeaheadBindingFor(ruleset.typeaheadComboboxes, element)
              ?? promptBindingFor(ruleset.promptComboboxes, element);
            fields.push({
              ...common,
              kind,
              element,
              ...(semanticAuthority === undefined ? {} : { semanticAuthority }),
              ...(listbox === undefined ? {} : { listbox }),
              ...(listbox?.multiValueContainerSelector && element.closest(listbox.multiValueContainerSelector) ? { multiple: true } : {}),
            });
          }
          break;
        // 文件控件：值的载体是 files 不是 value，由 write/setFile.ts 写。
        // 规则声明了这种上传部件怎么说「收下了」（2026-09-28 Workday 的简历栏）：带上绑定，写完之后按它确认。
        case 'file':
          if (isInput(element)) {
            const upload = fileUploadBindingFor(ruleset.fileUploads, element);
            fields.push({ ...common, kind, element, ...(upload === undefined ? {} : { upload }) });
          }
          break;
        case 'textarea':
          if (isTextarea(element)) fields.push({ ...common, kind, element });
          break;
        case 'select':
          if (isSelect(element)) fields.push({ ...common, kind, element });
          break;
        case 'richtext':
          if (isContentEditable(element)) {
            const match = resolved.plainTextContenteditable;
            fields.push({
              ...common,
              kind,
              element,
              plainTextContenteditableAttestation: match
                ? createPlainTextContenteditableAttestation({
                    root,
                    element,
                    attr: match.attr,
                    expectedValue: match.expectedValue,
                  })
                : null,
            });
          }
          break;
        default:
          assertNever(kind, 'rule interpreter control kind');
      }
    }

    return fields;
  }

  return {
    isApplyPath(pathname: string, options?: ApplyPathOptions): boolean {
      // 白标 B：别人的域名上本家的路径知识不适用；有退路声明就放行，闸在 resolveRoot。
      if (options?.whitelabel === true) return whitelabelRoot !== null;
      // 通用路：一个厂商都认不出时，本家的路径知识更加不适用。同样只放行「有没有
      // 声明退路」，真正的闸在 resolveRoot 里数字段（见 genericRoot）。
      if (options?.generic === true) return genericRoot !== null;
      const lower = pathname.toLowerCase();
      if (applyPath.test(lower)) return true;
      // 嵌入路径只对自称在子帧里的调用方开：顶层帧上它照旧不是申请页。
      return options?.embedded === true && embeddedApplyPath !== null && embeddedApplyPath.test(lower);
    },
    resolveRoot(page: ParentNode, options?: ScanRootOptions): ScanRoot | null {
      for (const selector of ruleset.anchors) {
        // happy-dom 对 detached DocumentFragment 的 querySelectorAll 比
        // querySelector 实现得更忠实；用集合形式让适配器隔离测试与内嵌页
        // 走同一条容器逻辑。
        const container = page.querySelectorAll(selector)[0];
        if (container) {
          return createScanRoot(
            container,
            scanExclusions,
            ruleset.rowScopes,
            options,
            { page, anchors: ruleset.anchors },
          );
        }
      }
      // 白标 B（P2-11）：本家锚点都没有、调用方又声明了白标（指纹判定为该家 + 主机不在厂商表里）
      // 时，找「包含 ≥ minHooks 个本家 id 钩子的容器」。恰好一个才算——两个都像就不猜。
      // 钩子 < minHooks 照旧 NO_ROOT：那是「看起来像申请表」，不是本家的数据契约。
      // 通用路（2026-09-22）：一个厂商都认不出时，本家的锚点与 id 钩子都不存在，
      // 唯一立得住的判据是「这一张表里有足够多我们认得的字段」。恰好一个容器达标
      // 才算——两张表都像申请表就不猜，与白标那条纪律一字不差。
      if (options?.generic === true) {
        if (genericRoot === null) return null;
        let forms: Element[];
        try {
          forms = Array.from(page.querySelectorAll(genericRoot.container));
        } catch {
          // 坏选择器是坏规则，不是「可以猜一下」。
          return null;
        }
        const qualifying = forms.filter((candidate) => {
          const probe = createScanRoot(candidate, scanExclusions, ruleset.rowScopes, options, null);
          let keyed = 0;
          for (const field of scan(probe, options)) {
            // 简历上传栏也算一栏（2026-09-28，见 countsAsResumeUpload）。
            if ((field.key !== null || countsAsResumeUpload(field)) && ++keyed >= genericRoot.minKeyedFields) return true;
          }
          return false;
        });
        if (qualifying.length !== 1) return null;
        return createScanRoot(qualifying[0]!, scanExclusions, ruleset.rowScopes, options, null);
      }
      if (options?.whitelabel !== true || whitelabelRoot === null || whitelabelHooks.length < whitelabelRoot.minHooks) {
        return null;
      }
      let containers: Element[];
      try {
        containers = Array.from(page.querySelectorAll(whitelabelRoot.container));
      } catch {
        return null;
      }
      const candidates = containers.filter((candidate) => {
        let hooks = 0;
        for (const hook of whitelabelHooks) {
          try {
            if (candidate.querySelector(hook) !== null) hooks += 1;
          } catch {
            // 坏选择器不算命中，也不让整页哑掉。
          }
        }
        return hooks >= whitelabelRoot.minHooks;
      });
      if (candidates.length !== 1) return null;
      // 不绑定规则锚点：容器选择器（如 `form`）在页面上可能命中多个，`firstBoundContainer` 会指到
      // 第一个而不是这一个；身份复核仍由 scanRoot 对这个元素本身的检查覆盖。
      return createScanRoot(candidates[0]!, scanExclusions, ruleset.rowScopes, options, null);
    },
    questionTextFor(root: ScanRoot, element: Element): string {
      // 规则声明的题干（question scope）：扫描给控件读题目用的同一份数据，这里给「页面上还空着的必填」读那些扫描不认
      // 的控件（Rippling 自定义题的 `div[role=combobox]`）。没声明、找不到都是空串。
      if (ruleset.questionScopes.length === 0) return '';
      try {
        return resolveQuestionScope(ruleset.questionScopes, element, root)?.text ?? '';
      } catch {
        return '';
      }
    },
    readConsentGate(page: ParentNode): ConsentGateReading | null {
      // D7（2026-10-04 负责人）：交出数据同意页上规则声明的表与居住地下拉；只在锚点没命中、那张表此刻在页面上时。不动手。
      const gate = ruleset.consentGate;
      if (gate === null) return null;
      const single = (selector: string): Element | null => {
        try {
          const all = page.querySelectorAll(selector);
          return all.length === 1 ? all[0]! : null;
        } catch {
          return null;
        }
      };
      try {
        if (ruleset.anchors.some((anchor) => page.querySelectorAll(anchor).length > 0)) return null;
      } catch {
        return null;
      }
      const form = single(gate.form);
      if (form === null) return null;
      const select = (): HTMLSelectElement | null => {
        if (gate.residence === null) return null;
        const found = single(gate.residence);
        return found !== null && found.localName === 'select' && form.contains(found) ? found as HTMLSelectElement : null;
      };
      const residence = select();
      return Object.freeze({
        form,
        residence,
        isCurrent: () => form.isConnected && single(gate.form) === form && select() === residence,
        submitControls: () => {
          try {
            return Array.from(form.querySelectorAll('button, input[type="submit"], input[type="image"]')).filter(submitsAForm);
          } catch {
            return [];
          }
        },
      });
    },
    hasConsentGate(page: ParentNode): boolean {
      const gate = ruleset.consentGate;
      if (gate === null) return false;
      // 选择器来自规则，写坏了就是规则坏了：查不动一律答否（与 hasUnopenedApplyForm 同一个口径）。
      const present = (selector: string): boolean => {
        try {
          return page.querySelectorAll(selector).length > 0;
        } catch {
          return false;
        }
      };
      // 锚点已经在这一页上 = 申请表出来了，这一条不成立。
      if (ruleset.anchors.some(present)) return false;
      return present(gate.form);
    },
    applyGateControl(page: ParentNode): HTMLElement | null {
      // D8（2026-10-04 负责人）：「自动填写」可以先替他点开申请表——那一下只把表单展开，不提交任何东西。只交出规则
      // 声明的那一颗、且申请表此刻确实还没打开；是任何一张表的提交控件、停用、不止一颗，一律不交。按不按由扩展按翻页
      // 那一位（远程可关）决定，这里不动手。
      const gate = ruleset.applyGate;
      if (gate === null) return null;
      let matches: Element[];
      try {
        if (ruleset.anchors.some((anchor) => page.querySelectorAll(anchor).length > 0)) return null;
        matches = Array.from(page.querySelectorAll(gate.selector));
      } catch {
        return null;
      }
      if (matches.length !== 1) return null;
      const control = matches[0]!;
      const view = control.ownerDocument?.defaultView;
      if (view === null || view === undefined || !(control instanceof view.HTMLElement)) return null;
      if (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true') return null;
      if (submitsAForm(control)) return null;
      return control;
    },
    hasUnopenedApplyForm(page: ParentNode): boolean {
      const gate = ruleset.applyGate;
      if (gate === null) return false;
      // 选择器来自规则，写坏了就是规则坏了，不是「可以猜一下」：查不动一律答否。
      const present = (selector: string): boolean => {
        try {
          return page.querySelectorAll(selector).length > 0;
        } catch {
          return false;
        }
      };
      // 锚点已经在这一页上 = 表单开着，这条不成立（BambooHR 点开之后那个按钮
      // 仍留在页面上，所以必须先排除锚点，不能只看按钮在不在）。
      if (ruleset.anchors.some(present)) return false;
      return present(gate.selector);
    },
    resolveFinalSubmitControl(
      root: ScanRoot,
      fields: readonly ApplyFieldDescriptor[],
    ): FinalSubmitControlDescriptor | null {
      const rule = ruleset.finalSubmitControl;
      if (rule === null || rule.activation !== 'native-submit') return null;
      const form = exactFieldsForm(fields);
      if (form === null) return null;
      const located = locateFinalControl(root, form, rule.selector);
      if (located === null) return null;
      const element = nativeSubmitControl(located.element);
      if (
        element === null ||
        !element.isConnected ||
        !form.isConnected ||
        element.disabled ||
        element.form !== form ||
        element.getAttribute('aria-disabled') === 'true'
      ) return null;
      let submissionSemantics: readonly unknown[];
      try {
        submissionSemantics = finalSubmissionSemanticsSeal(element, form);
      } catch {
        return null;
      }
      return Object.freeze({
        activation: 'native-submit' as const,
        element,
        form,
        isCurrent: () => {
          // 与认出它时同一条路再找一次：还是这一颗、还在原来那一边（表里，或表外用 form 属性认领）。
          const again = locateFinalControl(root, form, rule.selector);
          if (again === null || again.element !== element || again.outside !== located.outside) return false;
          const live = nativeSubmitControl(element);
          try {
            return live === element &&
              element.isConnected &&
              form.isConnected &&
              !element.disabled &&
              element.form === form &&
              element.getAttribute('aria-disabled') !== 'true' &&
              exactFieldsForm(fields) === form &&
              sameUnknownList(
                finalSubmissionSemanticsSeal(element, form),
                submissionSemantics,
              );
          } catch {
            return false;
          }
        },
      });
    },
    scan,
    rowScopes: ruleset.rowScopes,
    declaresAccountSteps: account !== null,
    isAccountPath: (pathname: string) => account?.isAccountPath(pathname) ?? false,
    resolveAccountWall: (page: ParentNode, options?: ScanRootOptions) => account?.resolveAccountWall(page, options) ?? null,
    readAccountOutcome: (page: ParentNode, isVisible: (element: Element) => boolean) =>
      account?.readAccountOutcome(page, isVisible) ?? null,
    declaresEmailCodePrompts: (ruleset.emailVerification?.codePrompts.length ?? 0) > 0,
    emailVerificationMail: ruleset.emailVerification?.mail ?? null,
    emailVerification: ruleset.emailVerification,
  };
}

/**
 * 随包内置规则的装载入口：校验 + 编译，校验不过直接抛。
 *
 * 内置数据坏了是构建期的程序员错误，四套适配器测试会在第一次 import 时爆炸——
 * 这正是想要的。后端下发的规则**不许**走这个入口；完整 release 必须经
 * `runtimeRegistry.ts` 验证 mapping 与两层 JCS/SHA-256 后动态编译。远程 release
 * 不可用时关闭执行，不能降级回这里恢复授权。
 *
 * 随包数据是本仓自己写的，按发布侧口径解析：陌生顶层键拒收，不走运行时的「不解释」。
 */
export function compileBundledAdapter(input: unknown): VendorAdapter {
  const parsed = parseVendorRuleset(input, { unknownTopLevelKeys: 'reject' });
  if (!parsed.ok) throw new Error(`apply-rules: bundled ruleset rejected: ${parsed.code}`);
  return compileRuleAdapter(parsed.value);
}
