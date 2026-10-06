/** Wizard data carried only by a v3 vendor ruleset in the verified runtime bundle. */

export interface ExecutionRuntimeWizardDeclarationV1 {
  readonly schemaVersion: 1;
  readonly wizardKey: string;
  readonly applicationRootSelector: string;
  readonly indicatorContainerSelector: string;
  readonly steps: readonly Readonly<{ stepKey: string; indicatorSelector: string }>[];
}

export type ExecutionRuntimeWizardDeclarationResult =
  | Readonly<{ ok: true; value: ExecutionRuntimeWizardDeclarationV1 }>
  | Readonly<{ ok: false; code: 'RULES_MALFORMED' }>;

const KEY = /^[a-z][a-z0-9._-]{0,63}$/u;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const properties = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const property = properties[key];
    if (!property || !('value' in property) || property.enumerable !== true) return null;
    copy[key] = property.value;
  }
  return copy;
}

function selector(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    // 控制字符正是这一条要拒的东西——选择器里出现它们只可能是注入或者
    // 传输损坏。eslint 默认不许在正则里写控制字符，这里是那条规则的例外本身。
    // eslint-disable-next-line no-control-regex
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Strict data-only wire parser. Syntax validity grants no execution authority. */
export function parseExecutionRuntimeWizardDeclarationV1(input: unknown): ExecutionRuntimeWizardDeclarationResult {
  try {
    const data = record(input, ['schemaVersion', 'wizardKey', 'applicationRootSelector', 'indicatorContainerSelector', 'steps']);
    if (data === null || data.schemaVersion !== 1 || typeof data.wizardKey !== 'string' || !KEY.test(data.wizardKey) ||
        !selector(data.applicationRootSelector) || !selector(data.indicatorContainerSelector) ||
        !Array.isArray(data.steps) || Object.getPrototypeOf(data.steps) !== Array.prototype) {
      return { ok: false, code: 'RULES_MALFORMED' };
    }
    const properties = Object.getOwnPropertyDescriptors(data.steps) as Record<string, PropertyDescriptor>;
    const length = properties.length?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 64 ||
        Reflect.ownKeys(properties).length !== length + 1) return { ok: false, code: 'RULES_MALFORMED' };
    const steps: Array<Readonly<{ stepKey: string; indicatorSelector: string }>> = [];
    const keys = new Set<string>(), selectors = new Set<string>();
    for (let index = 0; index < length; index++) {
      const property = properties[String(index)];
      if (!property || !('value' in property) || property.enumerable !== true) return { ok: false, code: 'RULES_MALFORMED' };
      const step = record(property.value, ['stepKey', 'indicatorSelector']);
      if (step === null || typeof step.stepKey !== 'string' || !KEY.test(step.stepKey) ||
          !selector(step.indicatorSelector) || keys.has(step.stepKey) || selectors.has(step.indicatorSelector)) {
        return { ok: false, code: 'RULES_MALFORMED' };
      }
      keys.add(step.stepKey); selectors.add(step.indicatorSelector);
      steps.push(Object.freeze({ stepKey: step.stepKey, indicatorSelector: step.indicatorSelector }));
    }
    const value: ExecutionRuntimeWizardDeclarationV1 = Object.freeze({
      schemaVersion: 1, wizardKey: data.wizardKey,
      applicationRootSelector: data.applicationRootSelector,
      indicatorContainerSelector: data.indicatorContainerSelector,
      steps: Object.freeze(steps),
    });
    return Object.freeze({ ok: true, value });
  } catch { return { ok: false, code: 'RULES_MALFORMED' }; }
}
