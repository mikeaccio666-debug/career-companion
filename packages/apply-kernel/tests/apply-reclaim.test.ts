import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { readApplyForm } from '../src/registry';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { createScanRoot } from '../src/scanRoot';
import { fieldSignature } from '../src/fieldIdentity';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

installBundledApplyAdapters();

/**
 * 收回我们写过、随后被宿主改掉的那一栏（`RunApplyPlanInput.reclaim`，2026-09-24）。
 *
 * 有的宿主在收到简历之后自己解析、隔一两秒把别的栏改写掉（测试台 2026-09-24：Rippling 把我们填好的
 * 姓名、邮箱、电话、LinkedIn 改成它从简历里读的）。插件在同一次点击里重写一次——资料里的值为准。
 * 那是一次覆盖，所以 runner 那道「非空不写」只对调用方点名的栏放宽，而且只在写前最后那一刻的值
 * **逐字**仍是调用方记下的那个宿主值时放宽：变了（多半是用户在改）就照旧 NOT_EMPTY、一个字都不动。
 *
 * 夹具全部是合成文字。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name</label>
      <input id="first_name" name="job_application[first_name]" />
      <label for="email">Email</label>
      <input id="email" name="job_application[email]" />
    </form>`;
  const form = readApplyForm('greenhouse');
  if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');
  const firstName = document.querySelector<HTMLInputElement>('#first_name')!;
  const email = document.querySelector<HTMLInputElement>('#email')!;
  // 计划在两栏都空的时候定下（与插件那一侧一样：先有计划，宿主后改）。
  const plan = buildApplyPlan(form, { firstName: 'Sample', email: 'sample.person@example.test' });
  return { form, plan, firstName, email };
}

function events(element: HTMLElement): string[] {
  const seen: string[] = [];
  for (const type of ['input', 'change']) element.addEventListener(type, () => seen.push(type));
  return seen;
}

describe('reclaim：只收回调用方点名、且此刻仍是那个宿主值的栏', () => {
  it('此刻的值逐字仍是记下的宿主值：非空也再写一次，资料里的值为准', async () => {
    const { form, plan, firstName, email } = mount();
    // 宿主的简历解析改写了两栏。
    firstName.value = 'SAMPLE PARSED';
    email.value = 'parsed@example.test';

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
      reclaim: new Map([[firstName, 'SAMPLE PARSED']]),
    });

    expect(run.results).toEqual([
      expect.objectContaining({ key: 'firstName', ok: true }),
      // 没点名的那一栏照旧不覆盖。
      expect.objectContaining({ key: 'email', ok: false, reason: 'NOT_EMPTY' }),
    ]);
    expect(firstName.value).toBe('Sample');
    expect(email.value).toBe('parsed@example.test');
  });

  it('写前那一刻的值已经不是记下的宿主值（用户在改）：照旧 NOT_EMPTY，零写入、零事件', async () => {
    const { form, plan, firstName } = mount();
    firstName.value = 'Sample Edited By Person';
    const seen = events(firstName);

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
      reclaim: new Map([[firstName, 'SAMPLE PARSED']]),
    });

    expect(run.results.find((result) => result.key === 'firstName')).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(firstName.value).toBe('Sample Edited By Person');
    expect(seen).toEqual([]);
  });

  it('不给 reclaim：与从前逐字相同，非空一律不写', async () => {
    const { form, plan, firstName } = mount();
    firstName.value = 'SAMPLE PARSED';

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root: form.root,
      policy: testApplyPolicy(),
    });

    expect(run.results.find((result) => result.key === 'firstName')).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(firstName.value).toBe('SAMPLE PARSED');
  });
});

/**
 * 组合框也要收得回（2026-10-04 测试台，Rippling 的 Location）：我们点中「Irvine, CA, USA」，1.8 秒后网站的简历解析把它改成
 * 简历上的「Champaign, IL」。第二遍点名收回这一栏，可下拉的写入器拿的是整份计划的「非空不写」，看到框里有字就答
 * NOT_EMPTY——收回从没发生，浮层 8/8 页留着「网站后来改掉了，再看一眼」。点名收回、此刻仍是记下的宿主值时，下拉也按
 * 资料里的值重选一次；用户在改（值变了）照旧不动。
 */
function mountListbox(current: string) {
  document.body.innerHTML = `
    <form id="application-form">
      <div class="field">
        <label for="pronouns">Pronouns</label>
        <div class="vc"><input id="pronouns" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"></div>
      </div>
    </form>`;
  const trigger = document.querySelector<HTMLInputElement>('#pronouns')!;
  trigger.value = current;
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-controls'); };
  trigger.addEventListener('mousedown', () => {
    if (menu !== null) return;
    menu = document.createElement('ul');
    menu.id = 'pronouns-list';
    menu.setAttribute('role', 'listbox');
    for (const text of ['She/her/hers', 'He/him/his', 'They/them/theirs']) {
      const option = document.createElement('li');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => { trigger.value = text; close(); });
      menu.append(option);
    }
    trigger.closest('.field')!.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'pronouns-list');
  });
  const root = createScanRoot(document.querySelector('form')!, []);
  const form = {
    vendor: 'rippling',
    root,
    fields: [{
      kind: 'combobox', element: trigger, key: 'preferredPronouns', label: 'Pronouns', required: false, confidence: 1,
      signature: fieldSignature(trigger, root),
      listbox: { triggerSelector: '#pronouns', valueContainerSelector: '.vc', selectedValueSelector: 'input' },
      semanticAuthority: undefined,
    }],
  } as never;
  // 计划在框还空着的时候定下（与插件那一侧一样：先有计划，宿主后改）。
  const saved = trigger.value;
  trigger.value = '';
  const plan = buildApplyPlan(form, { preferredPronouns: 'She/her/hers' } as never);
  trigger.value = saved;
  return { form, plan, trigger, root };
}

describe('reclaim：组合框也收得回', () => {
  it('网站改写过的下拉、此刻仍是记下的宿主值：按资料里的值重选一次', async () => {
    const { plan, trigger, root } = mountListbox('He/him/his');
    expect(plan.entries.map((entry) => entry.key)).toEqual(['preferredPronouns']);
    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', ['set-combobox']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      lateRecheckMs: 5,
      reclaim: new Map([[trigger, 'He/him/his']]),
    });
    expect(run.results).toEqual([expect.objectContaining({ key: 'preferredPronouns', ok: true })]);
    expect(trigger.value).toBe('She/her/hers');
  });

  it('不给 reclaim，或此刻的值已经变了：照旧不动', async () => {
    const first = mountListbox('He/him/his');
    const untouched = await runApplyPlan({
      plan: first.plan,
      auth: testAuthority(first.plan.fingerprint, 'fill', ['set-combobox']),
      journal: createUndoJournal(),
      root: first.root,
      policy: testApplyPolicy(),
      lateRecheckMs: 5,
    });
    expect(untouched.results[0]).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(first.trigger.value).toBe('He/him/his');

    const second = mountListbox('They/them/theirs');
    const changed = await runApplyPlan({
      plan: second.plan,
      auth: testAuthority(second.plan.fingerprint, 'fill', ['set-combobox']),
      journal: createUndoJournal(),
      root: second.root,
      policy: testApplyPolicy(),
      lateRecheckMs: 5,
      reclaim: new Map([[second.trigger, 'He/him/his']]),
    });
    expect(changed.results[0]).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(second.trigger.value).toBe('They/them/theirs');
  });
});
