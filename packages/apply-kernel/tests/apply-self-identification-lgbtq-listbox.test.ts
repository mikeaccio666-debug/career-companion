import { afterEach, describe, expect, it } from 'vitest';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';

/**
 * 跨性别、性取向、「是否 LGBTQ+」在 Greenhouse react-select 上：真实扫描 → 计划 → runner（2026-09-23）。
 *
 * 线上实例是 Greenhouse Discord 的「I consider myself a member of the LGBTQ+ community. (optional)」，
 * 从前一直落「只能由你本人填写」。题面与选项都是合成文字。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function mountQuestion(question: string, options: readonly string[]): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="question_1">${question}</label>
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

async function fill(answers: Pick<BuildPlanOptions, 'transgenderStatus' | 'sexualOrientation'>, on = true) {
  const root = greenhouseAdapter.resolveRoot(document)!;
  const fields = [...greenhouseAdapter.scan(root)];
  const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, {}, {
    fillEmptyOnly: true,
    capabilities: { 'set-self-identification': on },
    ...answers,
  });
  const bundled = createBundledApplyPolicy(Date.now());
  const summary = await runApplyPlan({
    plan,
    auth: fillAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: { ...bundled, capabilities: { ...bundled.capabilities, 'set-self-identification': on } },
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 10,
  });
  return { plan, summary };
}

const chosen = () => document.querySelector('.select__single-value')?.textContent ?? null;
const LGBTQ = 'I consider myself a member of the LGBTQ+ community. (optional)';
const ORIENTATION_MENU = [
  'Asexual', 'Bisexual and/or pansexual', 'Gay', 'Heterosexual', 'Lesbian', 'Queer', "I don't wish to answer",
];

describe('Greenhouse 下拉上的三道题', () => {
  it('「是否 LGBTQ+」：性取向是 Gay → 打开菜单选 Yes', async () => {
    mountQuestion(LGBTQ, ['Yes', 'No', "I don't wish to answer"]);
    const { summary } = await fill({ sexualOrientation: 'GAY' });
    expect(summary.results).toEqual([expect.objectContaining({ key: 'eeoLgbtqCommunity', ok: true })]);
    expect(chosen()).toBe('Yes');
  });

  it('跨性别：答过「否」→ 选 No', async () => {
    mountQuestion('Do you identify as transgender?', ['Yes', 'No', 'I prefer not to answer']);
    const { summary } = await fill({ transgenderStatus: 'NO' });
    expect(summary.results).toEqual([expect.objectContaining({ key: 'eeoTransgender', ok: true })]);
    expect(chosen()).toBe('No');
  });

  it('性取向：Gay → 选 Gay', async () => {
    mountQuestion('What is your sexual orientation?', ORIENTATION_MENU);
    const { summary } = await fill({ sexualOrientation: 'GAY' });
    expect(summary.results).toEqual([expect.objectContaining({ key: 'eeoSexualOrientation', ok: true })]);
    expect(chosen()).toBe('Gay');
  });

  it.each([
    [ORIENTATION_MENU],
    [['Asexual', 'Bisexual', 'Pansexual', 'Gay', 'Heterosexual']],
  ])('性取向：Bisexual / Pansexual 在下拉上交还用户，菜单都不打开（%j）', async (menu) => {
    mountQuestion('What is your sexual orientation?', menu);
    const { plan, summary } = await fill({ sexualOrientation: 'BISEXUAL_PANSEXUAL' });
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
    expect(summary.results).toEqual([]);
    expect(chosen()).toBeNull();
  });

  it('性取向：Lesbian 在只有「Gay or lesbian」的菜单上不选，更不退到单列的「Gay」', async () => {
    mountQuestion('What is your sexual orientation?', ['Straight', 'Gay', 'Gay or lesbian', 'Bisexual']);
    const { summary } = await fill({ sexualOrientation: 'LESBIAN' });
    expect(summary.results).toEqual([expect.objectContaining({ key: 'eeoSexualOrientation', ok: false })]);
    expect(chosen()).toBeNull();
  });

  it('能力位关着 → 不排进计划（MANUAL_ONLY），菜单都不打开', async () => {
    mountQuestion(LGBTQ, ['Yes', 'No']);
    const { plan, summary } = await fill({ sexualOrientation: 'GAY' }, false);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
    expect(summary.results).toEqual([]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
