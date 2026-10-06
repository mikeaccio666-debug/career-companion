import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';

/**
 * 真实 Greenhouse job-boards 实测（2026-09-10）：下拉全是 react-select，
 * 菜单在 mousedown 打开、由 aria-controls 指向，选项 [role=option] 没有
 * aria-selected；选中后菜单关闭，文字显示在 .select__value-container 里的
 * .select__single-value；location 是异步 typeahead。这里用最小的仿制件
 * 复现这四个行为，走真实 scan → plan → runner 路径。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * Minimal react-select stand-in with the behaviours the writer relies on. `batches` scripts
 * how the menu fills in: each batch replaces the visible list `batchDelayMs` after the previous
 * one, the way a geocoder or a remote search streams results in.
 */
function mountReactSelect(
  options: readonly string[],
  { typeahead = false, batches, batchDelayMs = 40 }: { typeahead?: boolean; batches?: readonly (readonly string[])[]; batchDelayMs?: number } = {},
): HTMLInputElement {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="candidate-location">Location</label>
      <div class="select__container">
        <div class="select__control">
          <div class="select__value-container">
            <input id="candidate-location" type="text" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="react-select-location-listbox" />
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('candidate-location') as HTMLInputElement;
  const container = trigger.closest('.select__container')!;
  const valueContainer = trigger.closest('.select__value-container')!;
  const render = (visible: readonly string[]) => {
    document.getElementById('react-select-location-listbox')?.remove();
    const listbox = document.createElement('div');
    listbox.id = 'react-select-location-listbox';
    listbox.setAttribute('role', 'listbox');
    for (const text of visible) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        valueContainer.querySelector('.select__single-value')?.remove();
        const chosen = document.createElement('div');
        chosen.className = 'select__single-value';
        chosen.textContent = text;
        valueContainer.prepend(chosen);
        listbox.remove();
        trigger.value = '';
        trigger.setAttribute('aria-expanded', 'false');
      });
      listbox.append(option);
    }
    container.append(listbox);
  };
  const stream = (filter: (text: string) => boolean) => {
    if (!batches) { render(options.filter(filter)); return; }
    batches.forEach((batch, index) => setTimeout(() => render(batch.filter(filter)), index * batchDelayMs));
  };
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    if (typeahead) render([]); else stream(() => true);
  });
  if (typeahead) {
    trigger.addEventListener('input', () => {
      const typed = trigger.value.toLowerCase();
      setTimeout(() => stream((text) => text.toLowerCase().includes(typed)), 20);
    });
  }
  return trigger;
}

/**
 * react-select `isMulti` stand-in (Vercel / Gusto job boards, 2026-09-10): the value container
 * carries `--is-multi`, every pick appends a `.select__multi-value` chip whose
 * `.select__multi-value__label` shows the option text, and the menu closes after each pick.
 */
function mountMultiReactSelect(
  options: readonly string[],
  label = 'Which languages do you use? (select all that apply)',
): HTMLInputElement {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="4001">${label}</label>
      <div class="select__container">
        <div class="select__control">
          <div class="select__value-container select__value-container--is-multi">
            <input id="4001" type="text" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="react-select-4001-listbox" />
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('4001') as HTMLInputElement;
  const container = trigger.closest('.select__container')!;
  const valueContainer = trigger.closest('.select__value-container')!;
  const chosen = new Set<string>();
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    document.getElementById('react-select-4001-listbox')?.remove();
    const listbox = document.createElement('div');
    listbox.id = 'react-select-4001-listbox';
    listbox.setAttribute('role', 'listbox');
    for (const text of options.filter((option) => !chosen.has(option))) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        chosen.add(text);
        const chip = document.createElement('div');
        chip.className = 'select__multi-value';
        const label = document.createElement('div');
        label.className = 'select__multi-value__label';
        label.textContent = text;
        chip.append(label);
        valueContainer.insertBefore(chip, trigger);
        listbox.remove();
        trigger.value = '';
        trigger.setAttribute('aria-expanded', 'false');
      });
      listbox.append(option);
    }
    container.append(listbox);
  });
  return trigger;
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

async function fillLocation(location: string) {
  const root = greenhouseAdapter.resolveRoot(document)!;
  const fields = [...greenhouseAdapter.scan(root)];
  const plan = buildApplyPlan({ vendor: 'greenhouse', root, fields }, { location }, { fillEmptyOnly: true });
  const summary = await runApplyPlan({
    plan,
    auth: fillAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: createBundledApplyPolicy(Date.now()),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 10,
  });
  return summary.results.find((result) => result.key === 'location');
}

describe('listbox combobox fill (react-select shape)', () => {
  it('scans the trigger with the rule-declared readback binding', () => {
    mountReactSelect(['Seattle, WA', 'Portland, OR']);
    const root = greenhouseAdapter.resolveRoot(document)!;
    const field = greenhouseAdapter.scan(root).find((candidate) => candidate.key === 'location');
    expect(field).toMatchObject({
      kind: 'combobox',
      listbox: { valueContainerSelector: '.select__value-container', selectedValueSelector: '.select__single-value' },
    });
  });

  it('opens the menu, clicks the matching option and reads the chosen text back', async () => {
    mountReactSelect(['Seattle, WA', 'Portland, OR']);
    expect(await fillLocation('Seattle, WA')).toMatchObject({ key: 'location', ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Seattle, WA');
  });

  it('types the candidate into a typeahead before choosing', async () => {
    mountReactSelect(['Seattle, WA', 'Portland, OR'], { typeahead: true });
    expect(await fillLocation('Seattle, WA')).toMatchObject({ key: 'location', ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Seattle, WA');
  });

  it('resolves a place-style candidate against geocoder-shaped typeahead options', async () => {
    mountReactSelect(
      ['Seattle Hill-Silver Firs, Washington, United States', 'Seattle, Washington, United States', 'SeaTac, Washington, United States'],
      { typeahead: true },
    );
    expect(await fillLocation('Seattle, WA')).toMatchObject({ key: 'location', ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Seattle, Washington, United States');
  });

  it('reports CHOICE_NO_DATA when no option matches and leaves the widget untouched', async () => {
    mountReactSelect(['Portland, OR']);
    expect(await fillLocation('Seattle, WA')).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(document.querySelector('.select__single-value')).toBeNull();
  });

  it('keeps an existing different selection when filling empty fields only', async () => {
    const trigger = mountReactSelect(['Seattle, WA', 'Portland, OR']);
    const chosen = document.createElement('div');
    chosen.className = 'select__single-value';
    chosen.textContent = 'Portland, OR';
    trigger.closest('.select__value-container')!.prepend(chosen);
    expect(await fillLocation('Seattle, WA')).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Portland, OR');
  });
});

/**
 * Independent review of #303 (2026-09-10): the writer picked the first of several agreeing
 * places, let a 1–3 character token prefix-match any segment, and clicked before the option
 * list had settled. Each case below reproduces one of those and pins the safe outcome.
 */
describe('listbox combobox fill: guesses are refused and the list must settle', () => {
  it('refuses to pick a state for an ambiguous place instead of taking the first ranked option', async () => {
    mountReactSelect(['Springfield, Illinois, United States', 'Springfield, Massachusetts, United States']);
    expect(await fillLocation('Springfield')).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION' });
    expect(document.querySelector('.select__single-value')).toBeNull();
  });

  it('never treats a short token as a prefix of an unrelated place', async () => {
    mountReactSelect(['Austell, Georgia, United States']);
    expect(await fillLocation('AU')).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(document.querySelector('.select__single-value')).toBeNull();
  });

  it('still expands a region code only in the region position and only to its full name', async () => {
    mountReactSelect(['Portland, Maine, United States', 'Portland, Oregon, United States'], { typeahead: true });
    expect(await fillLocation('Portland, OR')).toMatchObject({ ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Portland, Oregon, United States');
  });

  it('does not click an option the menu showed immediately until the list has been quiet', async () => {
    const trigger = mountReactSelect(['Seattle, WA']);
    let clickedBeforeSettled = false;
    let settled = false;
    trigger.addEventListener('mousedown', () => {
      document.querySelector('[role="option"]')!.addEventListener('click', () => { clickedBeforeSettled = !settled; });
      setTimeout(() => { settled = true; }, 30);
    });
    expect(await fillLocation('Seattle, WA')).toMatchObject({ ok: true });
    expect(clickedBeforeSettled).toBe(false);
  });

  it('waits for a list that fills in batches, so a late second match makes the choice ambiguous', async () => {
    mountReactSelect([], { batches: [['Springfield, Illinois, United States'], ['Springfield, Illinois, United States', 'Springfield, Massachusetts, United States']] });
    expect(await fillLocation('Springfield')).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION' });
    expect(document.querySelector('.select__single-value')).toBeNull();
  });

  it('treats an equal-length replacement of the list as still loading and matches the final set', async () => {
    mountReactSelect([], { batches: [['Seattle Hill-Silver Firs, Washington, United States'], ['Seattle, Washington, United States']] });
    expect(await fillLocation('Seattle, WA')).toMatchObject({ ok: true });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Seattle, Washington, United States');
  });

  it('fails with WIDGET_TIMEOUT instead of choosing when the list never settles', async () => {
    const churn = Array.from({ length: 60 }, (_, index) => [`Seattle, WA`, `Seattle, WA (${index})`]);
    mountReactSelect([], { batches: churn, batchDelayMs: 30 });
    expect(await fillLocation('Seattle, WA')).toMatchObject({ ok: false, reason: 'WIDGET_TIMEOUT' });
    expect(document.querySelector('.select__single-value')).toBeNull();
  });
});

describe('multi-select listbox combobox (react-select isMulti shape)', () => {
  it('scans the multi-value trigger as such and selects every confirmed value, reading the chips back', async () => {
    const trigger = mountMultiReactSelect(['TypeScript', 'Python', 'Rust']);
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    expect(fields.find((field) => field.element === trigger)).toMatchObject({ kind: 'combobox', multiple: true });
    const plan = buildAnswerPlan({ vendor: 'greenhouse', root, fields }, [{ questionId: 'langs', element: trigger, value: 'TypeScript\nRust' }]);
    expect(plan.entries[0]).toMatchObject({ key: 'question:langs', kind: 'combobox', multiple: true, comboboxCandidates: ['TypeScript', 'Rust'] });
    const summary = await runApplyPlan({
      plan,
      auth: fillAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 10,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['question:langs', true]]);
    expect([...document.querySelectorAll('.select__multi-value__label')].map((chip) => chip.textContent)).toEqual(['TypeScript', 'Rust']);
  });

  /**
   * 2026-09-24 测试台（Twilio 8185918）：Greenhouse 的人口统计题是多选 react-select（value container 带
   * `--is-multi`），「Voluntary Self-Identification of Gender」的菜单是 Male / Female / Transgender /
   * Gender Nonconforming / I don't wish to answer。档案里的一个性别码给的是**同一个答案的几种写法**
   * （Female、Woman），多选那一路却把每个候选都当成要选的值：先选上 Female，再去找 Woman——找不到，
   * 整栏报 CHOICE_NO_DATA，浮层说「你的资料里没有这一题的答案」，而页面上明明已经选好了 Female。
   */
  it('answers a single-valued EEO question on a multi-select once, from the candidate ladder', async () => {
    const trigger = mountMultiReactSelect(
      ['Male', 'Female', 'Transgender', 'Gender Nonconforming', "I don't wish to answer"],
      'Voluntary Self-Identification of Gender*',
    );
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    expect(fields.find((field) => field.element === trigger)).toMatchObject({ kind: 'combobox', multiple: true });
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields },
      { eeoGender: 'FEMALE' },
      { fillEmptyOnly: true, capabilities: { 'set-self-identification': true } },
    );
    expect(plan.entries[0]).toMatchObject({ key: 'eeoGender', kind: 'combobox', multiple: true, comboboxCandidates: ['Female', 'Woman'] });
    const summary = await runApplyPlan({
      plan,
      auth: fillAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 10,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['eeoGender', true]]);
    expect([...document.querySelectorAll('.select__multi-value__label')].map((chip) => chip.textContent)).toEqual(['Female']);
  });

  it('keeps a multi-select that already shows one of the answer spellings and leaves a different answer alone', async () => {
    const run = async () => {
      const root = greenhouseAdapter.resolveRoot(document)!;
      const fields = [...greenhouseAdapter.scan(root)];
      const plan = buildApplyPlan(
        { vendor: 'greenhouse', root, fields },
        { eeoGender: 'FEMALE' },
        { fillEmptyOnly: true, capabilities: { 'set-self-identification': true } },
      );
      return runApplyPlan({
        plan,
        auth: fillAuthority(plan.fingerprint),
        journal: createUndoJournal(),
        root,
        policy: createBundledApplyPolicy(Date.now()),
        readHostValidation: () => ({ ariaInvalid: 'false' }),
        lateRecheckMs: 10,
      });
    };
    const chip = (text: string) => {
      const node = document.createElement('div');
      node.className = 'select__multi-value';
      const label = document.createElement('div');
      label.className = 'select__multi-value__label';
      label.textContent = text;
      node.append(label);
      document.querySelector('.select__value-container')!.prepend(node);
    };
    mountMultiReactSelect(['Male', 'Female', "I don't wish to answer"], 'Gender');
    chip('Female');
    expect((await run()).results.map((result) => [result.key, result.ok])).toEqual([['eeoGender', true]]);
    expect([...document.querySelectorAll('.select__multi-value__label')].map((node) => node.textContent)).toEqual(['Female']);

    mountMultiReactSelect(['Male', 'Female', "I don't wish to answer"], 'Gender');
    chip('Male');
    expect((await run()).results).toMatchObject([{ key: 'eeoGender', ok: false, reason: 'NOT_EMPTY' }]);
    expect([...document.querySelectorAll('.select__multi-value__label')].map((node) => node.textContent)).toEqual(['Male']);
  });
});
