import { afterEach, describe, expect, it } from 'vitest';
import { buildApplyPlan } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';

/**
 * 代填的下拉——Greenhouse react-select，真实扫描 → 计划 → runner（第二刀，2026-09-23）。
 *
 * 2026-09-23 从本机 ats-lab 批量结果与公开职位接口核对：Greenhouse 上的隐私同意与属实声明几乎都是
 * 必填的单选下拉，选项是 Consent／I agree／Acknowledge/Confirm／Yes-No。从前触发器的题面带 consent，
 * 点击策略按「同意」拒，这一栏永远停在那里。现在能力位开着、用户同意过，就打开菜单、选那一项肯定
 * 回答；点下去那一刻题面与选项各认一遍，认不回来就拒。
 */
const PRIVACY =
  "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy for this position in accordance with Acme's Applicant Privacy Policy?";

afterEach(() => {
  document.body.innerHTML = '';
});

function mountQuestion(question: string, options: readonly string[]): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="question_1">${question}*</label>
      <div class="select__container">
        <div class="select__control">
          <div class="select__value-container">
            <input id="question_1" type="text" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="react-select-question_1-listbox" />
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('question_1') as HTMLInputElement;
  const container = trigger.closest('.select__container')!;
  const valueContainer = trigger.closest('.select__value-container')!;
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    const listbox = document.createElement('div');
    listbox.id = 'react-select-question_1-listbox';
    listbox.setAttribute('role', 'listbox');
    for (const text of options) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        const chosen = document.createElement('div');
        chosen.className = 'select__single-value';
        chosen.textContent = text;
        valueContainer.prepend(chosen);
        listbox.remove();
        trigger.setAttribute('aria-expanded', 'false');
      });
      listbox.append(option);
    }
    container.append(listbox);
  });
}

function fillAuthority(fingerprint: string): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  const minted = mintAuthority({ event, shadowRoot, purpose: 'fill', fingerprint, capabilities: new Set(['set-text', 'set-combobox']) });
  if (!minted.ok) throw new Error(minted.code);
  return minted.value;
}

async function fill(on: boolean) {
  const root = greenhouseAdapter.resolveRoot(document)!;
  const fields = [...greenhouseAdapter.scan(root)];
  const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, {}, { fillEmptyOnly: true, capabilities: { 'sign-on-behalf': on } } as never);
  const bundled = createBundledApplyPolicy(Date.now());
  const summary = await runApplyPlan({
    plan,
    auth: fillAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: { ...bundled, capabilities: { ...bundled.capabilities, 'sign-on-behalf': on } },
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 10,
    signOnBehalfCurrent: () => on,
  });
  return { plan, summary };
}

const chosen = () => document.querySelector('.select__single-value')?.textContent ?? null;

describe('代填的 Greenhouse 下拉', () => {
  it.each([[['Consent']], [['Yes', 'No']], [['Acknowledge/Confirm']]])('隐私同意 %j → 选那一项肯定回答', async (options) => {
    mountQuestion(PRIVACY, options);
    const { summary } = await fill(true);
    expect(summary.results).toEqual([expect.objectContaining({ key: 'termsConsent', ok: true })]);
    expect(chosen()).toBe(options[0]);
  });

  it('能力位关着 → 不排进计划（MANUAL_ONLY），菜单都不打开', async () => {
    mountQuestion(PRIVACY, ['Consent']);
    const { plan, summary } = await fill(false);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
    expect(summary.results).toEqual([]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('菜单里只有「Yes, and add me to your talent community」：前缀撞中，点击策略认不回来 → 拒，不选', async () => {
    mountQuestion(PRIVACY, ['Yes, and add me to your talent community', 'No']);
    const { summary } = await fill(true);
    expect(summary.results).toEqual([expect.objectContaining({ key: 'termsConsent', ok: false, reason: 'CLICK_DENIED' })]);
    expect(chosen()).toBeNull();
  });
});
