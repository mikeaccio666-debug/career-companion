// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { APPLY_ERROR_CODES } from '@edaix/apply-kernel/contracts';
import type { AuditView } from '@edaix/apply-kernel/audit';

import { mountAutofillDock } from '../lib/autofillDock';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';
import { COPY } from '../lib/dock/copy';

/**
 * 2026-09-23 在真实 Chrome 的后台标签页里看到的一幕：我们自己写成的五栏回读超时（VERIFY_TIMEOUT），
 * 浮层先把它们列成没填上、原因那一行是空的（码表里没有这个码），然后因为栏里有值，把它们算成
 * 「你补上了 5 项」。两件事都不对：
 *
 *  · 能走到浮层一行上的原因码，每一个都要有一句话——空着的原因行等于什么都没说；
 *  · 一栏是我们这一轮要写的，它在收尾那一刻的值是我们写的（或宿主据此改成的样子），不是用户补的。
 *    只有用户之后在网站上把它改了，才算他补上的。
 *
 * 全部是合成的页面与值，不带任何真实资料。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * 审计视图不会摆到浮层上的码：蜜罐与用户主动关掉的一类（audit.ts HIDDEN_REASONS，「不得出现」），
 * 以及档案草稿存储自己的两个码（不是任何一栏的结局）。其余每一个都可能是某一行的原因。
 */
const NEVER_A_ROW_REASON: ReadonlySet<string> = new Set([
  'HONEYPOT',
  'SENSITIVE_OPT_OUT',
  'STORAGE_UNAVAILABLE',
  'SCHEMA_TOO_NEW',
]);

describe('浮层每一行的原因', () => {
  it('能走到一行上的内核原因码，每一个都有一句话', () => {
    const missing = APPLY_ERROR_CODES.filter((code) => !NEVER_A_ROW_REASON.has(code) && !(COPY.reasons[code]?.trim()));
    expect(missing).toEqual([]);
  });

  it('回读超时这一行说的是网站没来得及确认', () => {
    expect(COPY.reasons.VERIFY_TIMEOUT).toBe('填了，网站没来得及确认，看一眼对不对');
  });
});

function auditRow(
  element: Element,
  fields: Partial<AuditView['rows'][number]> & Pick<AuditView['rows'][number], 'label' | 'status' | 'reason'>,
  order: number,
): AuditView['rows'][number] {
  return {
    key: null,
    required: true,
    attemptedValue: null,
    resolvedOptionText: null,
    element,
    confidence: null,
    order,
    ...fields,
  };
}

function view(rows: AuditView['rows']): AuditView {
  return { rows, filled: 0, requiredTotal: rows.length, requiredHandled: 0, needsAttention: rows.length, blockedByUs: 1, awaitingUser: rows.length - 1 };
}

function mount() {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
  handle.openPanel();
  const root = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, root };
}

/** 浏览器认定的真事件（happy-dom 里派发的事件 isTrusted 恒为 false）。 */
class TrustedPointer extends MouseEvent { get isTrusted() { return true; } }
/** 用户在网站上改一栏：先真的点进去，再输入。 */
const edit = (input: HTMLInputElement, value: string) => {
  input.dispatchEvent(new TrustedPointer('pointerdown', { bubbles: true, composed: true }));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('「你补上了」只算用户自己动过的那几栏', () => {
  it('我们写了、没能确认的一栏：网页上仍是我们写的值，不算用户补的；用户改了它，才算', () => {
    const email = document.createElement('input');
    const why = document.createElement('input');
    document.body.append(email, why);
    // 我们写进去的值（回读超时，没能确认）。
    email.value = 'candidate@example.test';
    const { handle, root } = mount();
    handle.beginRun(dockProgressFromAudit('fill-hidden', view([
      auditRow(email, { key: 'email', label: 'Email', status: 'FAILED', reason: 'VERIFY_TIMEOUT', attemptedValue: 'candidate@example.test' }, 0),
      auditRow(why, { label: 'Why do you want to work here?', status: 'NEEDS_MANUAL', reason: 'USER_ONLY' }, 1),
    ])));

    // 页面上任何一次输入都会让浮层重看一遍。
    why.dispatchEvent(new Event('input', { bubbles: true }));
    // 2026-09-28：按要做的事分组（写一段在前、去网页上看一眼在后）；他办好了的那一行离开「需要你」，记在「其余已填好」里。
    const reasons = () => [...root.querySelectorAll('[data-need-row] .need-why')].map((node) => node.textContent);
    const byYou = () => [...root.querySelectorAll('.rrow')].filter((node) => node.querySelector('.rv')?.textContent === '你已填好')
      .map((node) => node.querySelector('.rq')?.textContent);
    expect(reasons()).toEqual(['开放题，用你自己的话写几句', '填了，网站没来得及确认，看一眼对不对']);
    expect(root.querySelector('.sum-title')?.textContent).toBe('还有 2 项需要你');
    expect(byYou()).toEqual([]);

    // 用户自己答了开放题：那一栏算他的——没写过的行照旧只看有没有值。
    edit(why, 'Because of the mission');
    expect(reasons()).toEqual(['填了，网站没来得及确认，看一眼对不对']);
    expect(byYou()).toEqual(['Why do you want to work here?']);

    // 用户在网站上把我们写的那一栏改掉了：这才算他补上的。
    edit(email, 'someone@example.test');
    expect(reasons()).toEqual([]);
    expect(byYou()).toEqual(['Email', 'Why do you want to work here?']);
    expect(root.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
  });

  it('这一轮开始以后用户没在网站上动过手：一格里新冒出来的值是网站填的，不算「你补上了」', () => {
    // 2026-09-24：Lever 附上简历十几秒后才把解析结果写回表单；那时我们早已收尾，从前算成了用户补的。
    const company = document.createElement('input');
    document.body.append(company);
    const { handle, root } = mount();
    handle.beginRun(dockProgressFromAudit('fill-late-parse', view([
      auditRow(company, { key: 'currentCompany', label: 'Current company', status: 'MISSING_PROFILE', reason: 'NO_VALUE' }, 0),
    ])));
    company.value = 'Example Corp';
    company.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-need-row] .need-why')?.textContent).toBe('你的资料里还没有这一项');

    // 用户真的在网站上动了手之后，照旧按那一栏有没有值算他的：离开「需要你」，记成「你已填好」。
    edit(company, 'Example Corp');
    expect(root.querySelector('[data-need-row]')).toBeNull();
    expect(root.querySelector('.rrow .rv')?.textContent).toBe('你已填好');
  });

  it('宿主改过格式的也一样：收尾那一刻的样子不算用户的', () => {
    const phone = document.createElement('input');
    document.body.append(phone);
    phone.value = '(415) 555-0142';
    const { handle, root } = mount();
    handle.beginRun(dockProgressFromAudit('fill-coerced', view([
      auditRow(phone, { key: 'phone', label: 'Phone', status: 'FAILED', reason: 'VALUE_COERCED', attemptedValue: '+1 415 555 0142' }, 0),
    ])));
    phone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('[data-need-row] .need-why')?.textContent).toBe('网站改了格式，看一眼对不对');
    expect(root.querySelector('.sum-title')?.textContent).toBe('还有 1 项需要你');
  });
});
