import { afterEach, describe, expect, it } from 'vitest';
import { createScanRoot } from '../src/scanRoot';
import { fillListboxCombobox } from '../src/write/listboxCombobox';
import { consumeAuthority, mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { createUndoJournal } from '../src/undo';

/**
 * Greenhouse 的异步搜索下拉（react-select，2026-09-23 在 discord/jobs/8571766002 的
 * Discipline 框上实测）：打字后列表里先是「Loading...」，约半秒后换成「No options」——
 * 两者都只是 `role=listbox` 里的一段文字，没有选项、没有 aria-busy。合成的 Escape
 * 关不上菜单，失焦才关。
 *
 * 从前：搜不到的那一句要等满 3 秒才认，收尾再等 1.5 秒关菜单——一页三段教育白等十几秒。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

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
  const active = consumeAuthority(minted.value);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

/** 打字后「Loading...」，`answerAfterMs` 之后按查询给选项或「No options」。Escape 不理，失焦收菜单。 */
function mountAsyncSelect(
  options: readonly string[],
  answerAfterMs: number | ((query: string) => number),
  { opensOnClick = true, staleForMs = 0 }: { opensOnClick?: boolean; staleForMs?: number } = {},
): { trigger: HTMLInputElement; form: HTMLElement } {
  document.body.innerHTML = `
    <form id="f">
      <div class="field">
        <label for="discipline">Discipline</label>
        <div class="select__value-container"><div class="select__single-value"></div>
          <input id="discipline" role="combobox" aria-autocomplete="list" aria-expanded="false">
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('discipline') as HTMLInputElement;
  const single = document.querySelector('.select__single-value') as HTMLElement;
  let menu: HTMLElement | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let loading: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (pending !== null) clearTimeout(pending);
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
  };
  const open = () => {
    if (menu === null) {
      menu = document.createElement('div');
      menu.id = 'discipline-listbox';
      menu.setAttribute('role', 'listbox');
      trigger.closest('.field')!.append(menu);
    }
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'discipline-listbox');
  };
  if (opensOnClick) trigger.addEventListener('mousedown', open);
  trigger.addEventListener('input', () => {
    open();
    const query = trigger.value.trim().toLowerCase();
    if (pending !== null) clearTimeout(pending);
    if (loading !== null) clearTimeout(loading);
    if (query === '') { menu!.textContent = ''; return; }
    // staleForMs > 0：新一句打进去的头几十毫秒，弹层还挂着上一句的答复，之后才换成 Loading...
    if (staleForMs > 0) loading = setTimeout(() => { if (menu !== null) menu.textContent = 'Loading...'; }, staleForMs);
    else menu!.textContent = 'Loading...';
    pending = setTimeout(() => {
      if (menu === null) return;
      const found = options.filter((option) => option.toLowerCase().includes(query));
      if (found.length === 0) { menu.textContent = 'No options'; return; }
      menu.textContent = '';
      for (const text of found) {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = text;
        option.addEventListener('click', () => { single.textContent = text; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(trigger, ''); close(); });
        menu.append(option);
      }
    }, staleForMs + (typeof answerAfterMs === 'number' ? answerAfterMs : answerAfterMs(query)));
  });
  // react-select 在 Greenhouse 上不认合成的 Escape；失焦才收。
  trigger.addEventListener('focusout', close);
  return { trigger, form: document.getElementById('f')! };
}

const fill = (trigger: HTMLInputElement, form: HTMLElement, candidates: readonly string[]) => {
  const journal = createUndoJournal();
  return fillListboxCombobox({
    trigger,
    binding: { valueContainerSelector: '.select__value-container', selectedValueSelector: '.select__single-value' },
    candidates,
    root: createScanRoot(form, []),
    authority: fillAuthority('fp-async'),
    ticket: journal.record(trigger),
    policy: createBundledApplyPolicy(Date.now()),
    fillEmptyOnly: true,
    fence: () => null,
    lateRecheckMs: 10,
  });
};

describe('异步搜索下拉：搜索已经答了「没有结果」', () => {
  it('Loading... 换成 No options 之后不再等满预算；Escape 关不上就失焦去关，框里不留搜索词', async () => {
    const { trigger, form } = mountAsyncSelect(['Accounting', 'Anthropology'], 60);
    const started = Date.now();
    const outcome = await fill(trigger, form, ['Underwater Basket Weaving']);
    const elapsed = Date.now() - started;
    expect(outcome).toMatchObject({ ok: false, code: 'CHOICE_NO_DATA' });
    // 从前：3 秒预算 + 1.5 秒等菜单关 ≈ 4.5 秒。
    expect(elapsed).toBeLessThan(1_800);
    expect(trigger.value).toBe('');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('点开不出菜单、要打字才出的搜索框（Ashby／Rippling 的地点框）：不再干等 1.5 秒才去打字', async () => {
    const { trigger, form } = mountAsyncSelect(['San Francisco, California, United States'], 50, { opensOnClick: false });
    const started = Date.now();
    const outcome = await fill(trigger, form, ['San Francisco, California, United States']);
    expect(outcome).toEqual({ ok: true, value: 'San Francisco, California, United States' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('上一句刚答完「No options」、这一句头一眼还是它：换成 Loading... 不算答了，慢一点的结果照样等到', async () => {
    // 2026-09-23 第一版判据栽在这里：School 第二句、Degree 第一句都被错判成没结果，少填了一项。
    // 第一句很快答了「No options」；第二句头一眼还挂着它，随后 Loading... 900ms 才出结果。
    const { trigger, form } = mountAsyncSelect(['San Francisco'], (query) => (query === 'san francisco' ? 900 : 60), { staleForMs: 40 });
    const outcome = await fill(trigger, form, ['Nonexistent Place', 'San Francisco']);
    expect(outcome).toEqual({ ok: true, value: 'San Francisco' });
  });

  it('连着两句都搜不到：第二句静下来的「No options」与打字前相同，但正是这个框刚答过的没结果，照样不等满', async () => {
    const { trigger, form } = mountAsyncSelect(['Accounting'], 60, { staleForMs: 40 });
    const started = Date.now();
    const outcome = await fill(trigger, form, ['Nonexistent Place', 'Imaginary Town']);
    expect(outcome).toMatchObject({ ok: false, code: 'CHOICE_NO_DATA' });
    // 从前：两句各等满 3 秒 + 1.5 秒关菜单。
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('一直停在 Loading... 的慢搜索不会被提前判成没有结果：文字没变过就接着等', async () => {
    const { trigger, form } = mountAsyncSelect(['Computer Science', 'Computer Engineering'], 900);
    const outcome = await fill(trigger, form, ['Computer Science']);
    expect(outcome).toEqual({ ok: true, value: 'Computer Science' });
    expect(document.querySelector('.select__single-value')?.textContent).toBe('Computer Science');
  });
});

/**
 * 选项在页面里、打字只在本地筛（2026-10-04 测试台，Greenhouse Point72 的「What is your preferred work location?」：18 个城市，
 * 打字的那一下就变成「No options」，之后再也不变）。从前「答了没有结果」要先看到一段不同的文字（多半是 Loading...）再变一次，
 * 这种框从来不变第二次，每一句都等满 3 秒——三句一共 9 秒，整页 32 秒里最大的一块。
 * 文字变成一段与打字前不同、不像「还在找」的话，并且静了一秒，就算答了。
 */
function mountStaticSelect(options: readonly string[]): { trigger: HTMLInputElement; form: HTMLElement } {
  document.body.innerHTML = `
    <form id="f">
      <div class="field">
        <label for="where">What is your preferred work location?</label>
        <div class="select__value-container"><div class="select__single-value"></div>
          <input id="where" role="combobox" aria-autocomplete="list" aria-expanded="false">
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('where') as HTMLInputElement;
  const single = document.querySelector('.select__single-value') as HTMLElement;
  let menu: HTMLElement | null = null;
  const render = () => {
    if (menu === null) return;
    const query = trigger.value.trim().toLowerCase();
    const found = options.filter((option) => option.toLowerCase().includes(query));
    menu.textContent = '';
    if (found.length === 0) { menu.textContent = 'No options'; return; }
    for (const text of found) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => { single.textContent = text; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(trigger, ''); close(); });
      menu.append(option);
    }
  };
  const close = () => { menu?.remove(); menu = null; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-controls'); };
  const open = () => {
    if (menu === null) {
      menu = document.createElement('div');
      menu.id = 'where-listbox';
      menu.setAttribute('role', 'listbox');
      trigger.closest('.field')!.append(menu);
    }
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'where-listbox');
    render();
  };
  trigger.addEventListener('mousedown', open);
  trigger.addEventListener('input', () => { open(); render(); });
  trigger.addEventListener('focusout', close);
  return { trigger, form: document.getElementById('f')! };
}

describe('选项在页面里、打字只在本地筛的下拉', () => {
  it('搜不到：「No options」一出来就不再变——静一秒就算答了，不再每一句等满 3 秒', async () => {
    const { trigger, form } = mountStaticSelect(['Stamford, CT', 'New York, NY', 'London, UK']);
    const started = Date.now();
    const outcome = await fill(trigger, form, ['Irvine, California']);
    expect(outcome).toMatchObject({ ok: false, code: 'CHOICE_NO_DATA' });
    // 两句（「Irvine, California」「Irvine」）：从前各等满 3 秒。
    expect(Date.now() - started).toBeLessThan(3_500);
  });

  it('搜得到的照样选上', async () => {
    const { trigger, form } = mountStaticSelect(['Stamford, CT', 'New York, NY', 'London, UK']);
    const outcome = await fill(trigger, form, ['New York, NY']);
    expect(outcome).toEqual({ ok: true, value: 'New York, NY' });
  });
});
