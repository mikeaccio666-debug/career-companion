/**
 * 账号墙的解释（2026-09-28，负责人：像 Jobright 那样替用户在 Workday／iCIMS 上注册、登录）。
 *
 * 规则（`accountSteps`，见 schema.ts 的 `AccountStepsRule`）只说「这一步长什么样」：容器、每一步的标志、那几格与那几颗、
 * 网站在哪儿说话、说的是哪一种结局。这里把它解释成 selector-free 的活元素与一次同步复核，交给扩展——扩展从不接触
 * 选择器（RULE-GLOBAL-DOM-RULE-BOUNDARY）。
 *
 * 全部 fail closed：容器不是恰好一个、这一步的标志不是恰好一个、必填的那一格或那一颗不是恰好一个、某一格的类型不对
 * （密码栏不是 `type=password`、条款不是勾选框），都答「没有账号墙」。答「没有」的后果是扩展照旧说「先在网站上登录」，
 * 而认错一格的后果是把密码写进别的栏——两者不对称，所以宁可认不出。
 *
 * 这里只读 DOM、不写、不点、不碰布局（RULE-KERNEL-DETERMINISTIC-BOUNDARY）：横幅看不看得见由调用方量好交进来。
 * 规则里没有授权：能不能替用户注册、登录，由运行时包的 `account-access` 位与用户同意过的那一版文案说了算。
 */

import type {
  AccountControlRole,
  AccountFieldRole,
  AccountOutcomeReading,
  AccountStepKind,
  AccountWallStep,
  ScanRootOptions,
} from '../contracts.ts';
import { createScanRoot } from '../scanRoot.ts';
import type { AccountStepRule, AccountStepsRule } from './schema.ts';

const FIELD_ROLES: readonly AccountFieldRole[] = ['email', 'password', 'verifyPassword'];
const CONTROL_ROLES: readonly AccountControlRole[] = ['submit', 'useEmail', 'toSignIn', 'toCreateAccount', 'terms'];
/** 每一种步骤里哪几项必须在（与 schema 的 `ACCOUNT_STEP_KEYS` 同一张表的「必填」那一半）。 */
const REQUIRED: Readonly<Record<AccountStepKind, readonly (AccountFieldRole | AccountControlRole)[]>> = {
  choice: ['useEmail'],
  identify: ['email', 'submit'],
  signIn: ['email', 'password', 'submit'],
  createAccount: ['email', 'password', 'submit'],
};

/** 整页或容器里按选择器找：0 个、1 个、说不清（不止一个，或选择器本身坏了——坏规则不是「可以猜一下」）。 */
function findUnique(scope: ParentNode, selector: string): Element | null | 'AMBIGUOUS' {
  let found: ArrayLike<Element>;
  try {
    found = scope.querySelectorAll(selector);
  } catch {
    return 'AMBIGUOUS';
  }
  if (found.length === 0) return null;
  return found.length === 1 ? found[0]! : 'AMBIGUOUS';
}

function inputType(element: Element): string {
  return (element.getAttribute('type') ?? '').trim().toLowerCase();
}

/** 这一格能不能当这个角色：邮箱是可见的文本框（不是密码框、不是隐藏框），两个密码栏必须是 `type=password`。 */
function fieldFits(role: AccountFieldRole, element: Element): element is HTMLInputElement {
  if (element.localName !== 'input') return false;
  const type = inputType(element);
  return role === 'email'
    ? type === '' || type === 'text' || type === 'email'
    : type === 'password';
}

/**
 * 这一颗能不能当这个角色：条款必须是勾选框；别的必须是按钮的样子——`<button>`、`type=submit|button` 的
 * `<input>`、或声明了 `role=button` 的元素（Workday 的提交按钮外面罩着一层 `role=button` 的 click_filter）。
 * 链接、文本框、下拉一律不是。点不点得了，点击策略在按下去之前还会逐项再判。
 */
function controlFits(role: AccountControlRole, element: Element): boolean {
  if (role === 'terms') return element.localName === 'input' && inputType(element) === 'checkbox';
  if (element.localName === 'button') return true;
  if (element.localName === 'input') return inputType(element) === 'submit' || inputType(element) === 'button';
  if (element.localName === 'a' || element.localName === 'select' || element.localName === 'textarea') return false;
  return (element.getAttribute('role') ?? '').trim().toLowerCase() === 'button';
}

function selectorFor(step: AccountStepRule, role: AccountFieldRole | AccountControlRole): string | undefined {
  return (step as unknown as Readonly<Record<string, string | undefined>>)[role];
}

export interface CompiledAccountWall {
  readonly isAccountPath: (pathname: string) => boolean;
  readonly resolveAccountWall: (page: ParentNode, options?: ScanRootOptions) => AccountWallStep | null;
  readonly readAccountOutcome: (page: ParentNode, isVisible: (element: Element) => boolean) => AccountOutcomeReading;
}

/** 横幅里的字：折叠空白。只拿来比对规则里的那几句话，不出这一层（Data-L1 不进任何回报）。 */
function bannerText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

export function compileAccountWall(rule: AccountStepsRule, excludeWithin: readonly string[]): CompiledAccountWall {
  const path = rule.path === null ? null : new RegExp(rule.path.source, rule.path.flags ?? '');
  const outcomes = rule.outcomes.map((outcome) => ({
    kind: outcome.kind,
    text: new RegExp(outcome.text.source, outcome.text.flags ?? ''),
  }));

  /** 这一步规则声明的每一项，在容器里解析成节点。必填的缺一样、任何一项说不清、类型不对、两项指到同一个节点：null。 */
  const bind = (
    container: Element,
    step: AccountStepRule,
  ): Readonly<{ fields: Partial<Record<AccountFieldRole, HTMLInputElement>>; controls: Partial<Record<AccountControlRole, Element>> }> | null => {
    const fields: Partial<Record<AccountFieldRole, HTMLInputElement>> = {};
    const controls: Partial<Record<AccountControlRole, Element>> = {};
    const seen = new Set<Element>();
    for (const role of [...FIELD_ROLES, ...CONTROL_ROLES]) {
      const selector = selectorFor(step, role);
      if (selector === undefined) continue;
      const found = findUnique(container, selector);
      if (found === 'AMBIGUOUS') return null;
      if (found === null) {
        if (REQUIRED[step.kind].includes(role)) return null;
        continue;
      }
      if (seen.has(found)) return null;
      seen.add(found);
      if ((FIELD_ROLES as readonly string[]).includes(role)) {
        if (!fieldFits(role as AccountFieldRole, found)) return null;
        fields[role as AccountFieldRole] = found;
      } else {
        if (!controlFits(role as AccountControlRole, found)) return null;
        controls[role as AccountControlRole] = found;
      }
    }
    return { fields, controls };
  };

  const resolveAccountWall = (page: ParentNode, options?: ScanRootOptions): AccountWallStep | null => {
    const container = findUnique(page, rule.container);
    if (container === null || container === 'AMBIGUOUS') return null;
    for (const step of rule.steps) {
      const marker = findUnique(container, step.marker);
      if (marker === null) continue;
      // 两个标志：这一步说不清是哪一个，不往后猜别的步骤。
      if (marker === 'AMBIGUOUS') return null;
      const bound = bind(container, step);
      if (bound === null) return null;
      const fields = Object.freeze({ ...bound.fields });
      const controls = Object.freeze({ ...bound.controls });
      const root = createScanRoot(container, excludeWithin, [], options ?? {}, null);
      const isCurrent = (): boolean => {
        try {
          if (findUnique(page, rule.container) !== container || findUnique(container, step.marker) !== marker) return false;
          const again = bind(container, step);
          if (again === null) return false;
          const same = <K extends string>(left: Partial<Record<K, Element>>, right: Partial<Record<K, Element>>): boolean => {
            const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<K>;
            return [...keys].every((key) => left[key] === right[key] && (left[key]?.isConnected ?? true));
          };
          return container.isConnected && same(fields, again.fields) && same(controls, again.controls);
        } catch {
          return false;
        }
      };
      return Object.freeze({ kind: step.kind, root, fields, controls, isCurrent });
    }
    return null;
  };

  const readAccountOutcome = (page: ParentNode, isVisible: (element: Element) => boolean): AccountOutcomeReading => {
    if (rule.banners === null) return null;
    let nodes: ArrayLike<Element>;
    try {
      nodes = page.querySelectorAll(rule.banners);
    } catch {
      return null;
    }
    const texts: string[] = [];
    for (const node of Array.from(nodes)) {
      let shown = false;
      try {
        shown = isVisible(node) === true;
      } catch {
        shown = false;
      }
      const text = shown ? bannerText(node) : '';
      if (text !== '') texts.push(text);
    }
    if (texts.length === 0) return null;
    for (const outcome of outcomes) {
      if (texts.some((text) => outcome.text.test(text))) return outcome.kind;
    }
    return 'unrecognized';
  };

  return Object.freeze({
    isAccountPath: (pathname: string) => path !== null && path.test(pathname.toLowerCase()),
    resolveAccountWall,
    readAccountOutcome,
  });
}
