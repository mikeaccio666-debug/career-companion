import type { ApplyFieldDescriptor } from './contracts';

/** 控件的本地补充题面；只读 placeholder／aria-describedby，不读取或传递填写值。 */
export function questionContextOf(element: Element): string {
  return [element.getAttribute('placeholder') ?? '',
    ...(element.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? ''),
  ].map((part) => part.replace(/\s+/gu, ' ').trim()).filter(Boolean).join(' · ');
}

export type QuestionControlType = 'TEXT' | 'TEXTAREA' | 'SINGLE_CHOICE' | 'MULTI_CHOICE';

/** Value-free description of a host question, shaped like the backend's question packet item. */
export interface QuestionDescription {
  readonly questionId: string;
  readonly text: string;
  readonly controlType: QuestionControlType;
  readonly required: boolean;
  readonly options: readonly { readonly optionId: string; readonly text: string }[];
  /**
   * The control's own form name (`name`, else `id`), read generically off the scanned element —
   * a choice group reports the one name its members share. Empty when the control has neither.
   * It lets a caller that already holds the form's field list join the two; it is not site
   * knowledge and no writer ever selects by it.
   */
  readonly fieldName: string;
}

/**
 * Describe a scanned field as a question the backend can answer and the user can review.
 * Comboboxes are asked as free text: the answer is later matched against the widget's own
 * options by the combobox writer, so their option list need not be harvested up front.
 * Returns null for controls that cannot take a reviewed answer (radio/checkbox groups,
 * files, rich text) or that carry no question text.
 */
export function describeQuestion(field: ApplyFieldDescriptor, questionId: string): QuestionDescription | null {
  const text = field.label.trim();
  if (!text) return null;
  const base = { questionId, text, required: field.required, options: [] as const, fieldName: fieldNameOf(field) };
  switch (field.kind) {
    case 'text':
    case 'combobox':
      return { ...base, controlType: 'TEXT' };
    case 'textarea':
      return { ...base, controlType: 'TEXTAREA' };
    case 'select': {
      const options = [...field.element.options]
        .filter((option) => !option.disabled && option.value !== '' && option.text.trim() !== '')
        .map((option, index) => ({ optionId: `o${index}`, text: option.text.trim() }));
      return options.length > 0 ? { ...base, controlType: 'SINGLE_CHOICE', options } : null;
    }
    case 'choice': {
      const options = field.choice.options.flatMap((option, index) => (option.label.trim() ? [{ optionId: `o${index}`, text: option.label.trim() }] : []));
      // 单选组与 ARIA 代理的切换按钮 / role=radio 只能选一项；复选组与 role=checkbox 各自独立。
      const single = field.choice.control === 'radio' || (field.choice.control === 'proxy' && !field.choice.multiple);
      return options.length > 0 ? { ...base, controlType: single ? 'SINGLE_CHOICE' : 'MULTI_CHOICE', options } : null;
    }
    default:
      return null;
  }
}

/** The cross-page identity of a described question: what question memory hashes. */
export interface QuestionIdentity {
  readonly text: string;
  readonly controlType: QuestionControlType;
  readonly optionTexts: readonly string[];
}

/**
 * The identity of a described question, with its per-scan ids dropped.
 *
 * `questionId` is an order label (`q3`) and option ids are positional, so neither may
 * reach the identity: a question that moves up the page is still the same question.
 */
export function questionIdentity(question: QuestionDescription): QuestionIdentity {
  return {
    text: question.text,
    controlType: question.controlType,
    optionTexts: question.options.map((option) => option.text),
  };
}

/**
 * The scanned control's own `name`, else its `id`. A choice group's element is its first member,
 * which carries the name every member of the group shares.
 *
 * An ARIA-proxied question reads the native control that carries its form name (a hidden carrier
 * or a sibling mirror), never the proxy: Workable regenerates every proxy `id` on each render,
 * and Ashby's option buttons carry neither a name nor an id.
 */
function fieldNameOf(field: ApplyFieldDescriptor): string {
  if (field.kind === 'choice' && field.choice.control === 'proxy') {
    return field.choice.nameSource?.getAttribute('name')?.trim() ?? '';
  }
  const element = field.element as Element | undefined;
  const name = element?.getAttribute('name')?.trim();
  return name || element?.getAttribute('id')?.trim() || '';
}
