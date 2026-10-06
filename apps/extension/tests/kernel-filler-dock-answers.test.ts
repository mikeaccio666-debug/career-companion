// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fillFromGesture } from '../lib/gestureFill';
import type { KernelFillAudit } from '../lib/kernelFiller';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { readApplyForm } from '@edaix/apply-kernel/registry';

installBundledApplyAdapters();

/**
 * 「需要你」在浮层里当场答（2026-09-28 负责人：用户要做的越少越好）。
 *
 * 浮层按元素问内容脚本「这一栏能不能当场答、有哪些选项」（`questionAt`），他点一个选项、或填一句按「填入」，那一下点击
 * 走的是与补答同一条授权路（`answer`：点击当下铸票、这一轮的信封、同一本撤销日志）。这里钉住四件事：
 *  · 写入期没对上选项的选择题（NO_OPTION_MATCH / AMBIGUOUS_OPTION）也能这样答——从前只有计划期跳过的题可以；
 *  · 按规定留给本人的（MANUAL_ONLY：同意、自我认同……）不给当场答，只能去那一栏；
 *  · 答上的那一格在复核视图里是「填好了」，并标上 `userAnswered`（浮层写明是他答的）；
 *  · 不是真点击就一个字不写。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const CITY = `
  <label for="city_sel">City</label>
  <select id="city_sel"><option value="">Select…</option><option value="pdx">Portland</option><option value="aus">Austin</option></select>`;
const WHEN = '<label for="start">When can you start?</label><input id="start" type="text" />';
const CONSENT = '<label for="marketing"><input id="marketing" type="checkbox" /> I agree to receive marketing emails</label>';

function page(extra: string) {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    <label for="email">Email</label><input id="email" type="email" />
    ${extra}
  </form>`;
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  return { shadowRoot, button, descriptor: descriptor! };
}

const livePolicy = (over: Partial<ApplyPolicy> = {}): ApplyPolicy => ({ ...createBundledApplyPolicy(), notAfter: Date.now() + 60_000, ...over });

async function filled(extra: string, profile: Record<string, string>) {
  const { shadowRoot, button, descriptor } = page(extra);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  const onClick = (event: Event) => { proof = captureTrustedShadowGesture(event, shadowRoot); };
  button.addEventListener('click', onClick);
  button.dispatchEvent(new TrustedClick('click'));
  button.removeEventListener('click', onClick);
  const audits: KernelFillAudit[] = [];
  await fillFromGesture({
    proof: proof as never,
    scan: { descriptor } as never,
    profile: profile as never,
    policy: livePolicy(),
    progress: { onOutcome: vi.fn(), shouldStop: () => false } as never,
    onAudit: (audit: KernelFillAudit) => audits.push(audit),
  } as never);
  const audit = audits[0]!;
  /** 用户在浮层里的一下真点击：凭证在派发当中取（`answer` 同步铸票）。 */
  const clickAnswer = (element: Element, value: string, trusted = true) => {
    let pending: ReturnType<KernelFillAudit['answer']> | null = null;
    const questionId = audit.questionAt?.(element)?.questionId ?? '';
    const answer = (event: Event) => { pending = audit.answer(event, shadowRoot, [{ questionId, value }]); };
    button.addEventListener('click', answer);
    button.dispatchEvent(trusted ? new TrustedClick('click') : new MouseEvent('click'));
    button.removeEventListener('click', answer);
    return pending!;
  };
  return { audit, clickAnswer };
}

describe('浮层里当场答（2026-09-28）', () => {
  it('写入期没对上选项的选择题：浮层拿得到页面上的真实选项，点一个就经内核写进去，复核视图标成他答的', async () => {
    const { audit, clickAnswer } = await filled(CITY, { firstName: 'Taylor', email: 'taylor@example.test', city: 'Seattle' });
    const select = document.getElementById('city_sel') as HTMLSelectElement;
    const before = audit.view.rows.find((row) => row.element === select);
    expect(['NO_OPTION_MATCH', 'AMBIGUOUS_OPTION']).toContain(before?.reason);
    const question = audit.questionAt?.(select);
    expect(question).toMatchObject({ controlType: 'SINGLE_CHOICE' });
    expect(question?.options.map((option) => option.text)).toEqual(['Portland', 'Austin']);

    const results = await clickAnswer(select, 'Portland');
    expect(results.map((result) => result.ok)).toEqual([true]);
    expect(select.value).toBe('pdx');
    const after = audit.recheck().rows.find((row) => row.element === select);
    expect(after).toMatchObject({ status: 'FILLED', userAnswered: true });
  });

  it('资料里没有的文本题同样当场答；不是真点击就一个字不写', async () => {
    const { audit, clickAnswer } = await filled(WHEN, { firstName: 'Taylor', email: 'taylor@example.test' });
    const start = document.getElementById('start') as HTMLInputElement;
    expect(audit.questionAt?.(start)).toMatchObject({ controlType: 'TEXT' });
    expect((await clickAnswer(start, 'In two weeks', false)).every((result) => !result.ok)).toBe(true);
    expect(start.value).toBe('');
    expect((await clickAnswer(start, 'In two weeks')).map((result) => result.ok)).toEqual([true]);
    expect(start.value).toBe('In two weeks');
  });

  it('按规定留给本人的（营销同意没开代填）不给当场答', async () => {
    const { audit } = await filled(CONSENT, { firstName: 'Taylor', email: 'taylor@example.test' });
    const consent = document.getElementById('marketing')!;
    expect(audit.view.rows.find((row) => row.element === consent)?.reason).toBe('MANUAL_ONLY');
    expect(audit.questionAt?.(consent)).toBeNull();
    // 已经填好的一栏也不是「当场答」的题。
    expect(audit.questionAt?.(document.getElementById('first_name')!)).toBeNull();
  });
});
