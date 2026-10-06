import { afterEach, describe, expect, it } from 'vitest';
import leverRules from '@edaix/apply-rules/lever.json';
import { buildApplyPlan } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import type { ApplyFormDescriptor, VendorAdapter } from '../src/contracts';

/**
 * Rule-declared plain-text typeahead (`typeaheadComboboxes`), modelled on Lever's
 * "Current location" as measured on 2026-09-15 (jobs.lever.co/palantir/ac978161-…/apply
 * plus the widget script jobs.lever.co/js/retrieveLocations.js): a bare text input, a
 * sibling hidden `selectedLocation`, suggestions appended as `.dropdown-results >
 * div.dropdown-location#location-<i>`, a pick on `mousedown` that copies the suggestion
 * text into the input and a JSON payload into the hidden field, and a blur that wipes
 * both when nothing was picked.
 *
 * The stand-in is **keyboard-driven exactly like the live widget**: `input` only reveals
 * the dropdown container, and the search itself runs from the `keydown` handler. Measured
 * the same day against the live posting: a native setter plus an `input` event produced
 * zero suggestions and zero `/searchLocations` in 3.5s, and one synthetic `keydown` pair
 * produced five in 0.8s. So every case below also proves the minimal keyboard envelope
 * (`write/allowlist.ts` → `dispatchTypeaheadSearchKey`) reaches the host; without it this
 * file goes red at the first suggestion assertion.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

const TYPEAHEAD_RULE = {
  triggerSelector: 'input.location-input',
  containerSelector: 'li.application-question',
  suggestionSelector: '.dropdown-results > .dropdown-location',
  selectedValueSelector: 'input.location-input',
  minTypedChars: 2,
  selectionWitnessSelector: 'input[name="selectedLocation"]',
};

function typeaheadAdapter(overrides: Partial<typeof TYPEAHEAD_RULE> = {}): VendorAdapter {
  const rules = structuredClone(leverRules) as Record<string, unknown>;
  rules['widgetNames'] = [];
  rules['typeaheadComboboxes'] = [{ ...TYPEAHEAD_RULE, ...overrides }];
  const steps = rules['keySteps'] as Array<Record<string, unknown>>;
  (steps[0]!['map'] as Record<string, string>)['location'] = 'location';
  return compileBundledAdapter(rules);
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

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
}

interface LeverWidget {
  readonly trigger: HTMLInputElement;
  readonly hidden: HTMLInputElement;
  readonly queries: string[];
  /** Every `key` the widget's own keydown handler saw, in order. */
  readonly keys: string[];
}

/** Lever's structured location question; `search` plays the geocoder behind /searchLocations. */
function mountLever(
  search: (query: string) => readonly string[],
  { registerPick = true, delayMs = 20 }: { registerPick?: boolean; delayMs?: number } = {},
): LeverWidget {
  document.body.innerHTML = `
    <form id="application-form" method="POST">
      <ul>
        <li class="application-question">
          <label><div class="application-label">Full name<span class="required">✱</span></div>
            <div class="application-field"><input type="text" data-qa="name-input" name="name" required=""></div></label>
        </li>
        <li class="application-question" data-qa="structured-contact-location-question">
          <label>
            <div class="application-label">Current location <span class="required" data-qa="SCL-question-required-asterisk">✱</span></div>
            <div class="application-field">
              <input class="location-input" data-qa="location-input" id="location-input" type="text" maxlength="100" name="location" required="">
              <input id="selected-location" type="hidden" name="selectedLocation">
              <div class="momentum-body dropdown-container" style="display: none">
                <div class="dropdown-results width-full cursor-pointer"></div>
                <div class="dropdown-no-results" style="display: none">No location found. Try entering a different location</div>
                <div class="dropdown-loading-results" style="display: none">Loading</div>
              </div>
            </div>
          </label>
        </li>
      </ul>
    </form>`;
  const trigger = document.getElementById('location-input') as HTMLInputElement;
  const hidden = document.getElementById('selected-location') as HTMLInputElement;
  const container = document.querySelector('.dropdown-container') as HTMLElement;
  const results = document.querySelector('.dropdown-results') as HTMLElement;
  const queries: string[] = [];
  const keys: string[] = [];
  let searched: readonly string[] = [];
  const empty = () => { results.replaceChildren(); searched = []; };
  // Live Lever, 2026-09-15: `input` only flips the container from display:none to
  // flex. Nothing is ever searched from it — the geocoder call lives in the
  // (debounced) `keydown` handler, so a value written without a keystroke sits in
  // a visible, permanently empty dropdown.
  trigger.addEventListener('input', () => {
    container.style.display = 'flex';
    empty();
  });
  trigger.addEventListener('keydown', (event) => {
    keys.push((event as KeyboardEvent).key);
    const query = trigger.value;
    empty();
    if (query === '') return;
    queries.push(query);
    setTimeout(() => {
      searched = search(query);
      searched.forEach((name, index) => {
        const item = document.createElement('div');
        item.className = 'break-word dropdown-location width-full py1 px2';
        item.id = `location-${index}`;
        item.textContent = name;
        results.append(item);
      });
    }, delayMs);
  });
  document.addEventListener('mousedown', (event) => {
    const target = event.target as Element;
    if (!target.classList.contains('dropdown-location') || !registerPick) return;
    container.style.display = 'none';
    setInputValue(trigger, target.textContent ?? '');
    hidden.value = JSON.stringify({ name: target.textContent, index: Number(target.id.split('-')[1]) });
    empty();
  });
  return { trigger, hidden, queries, keys };
}

const GEOCODER = (query: string): readonly string[] => {
  const city = query.split(',')[0]!.trim().toLowerCase();
  if (city === 'san francisco') {
    return ['San Francisco, California, United States', 'San Francisco, Córdoba, Argentina', 'São Francisco, Minas Gerais, BRA'];
  }
  if (city === 'springfield') return ['Springfield, Illinois, United States', 'Springfield, Massachusetts, United States'];
  return ['Atlanta, Georgia, United States'];
};

async function fill(adapter: VendorAdapter, profile: { location: string; fullName?: string }, fillEmptyOnly = true) {
  const root = adapter.resolveRoot(document)!;
  const fields = [...adapter.scan(root)];
  const descriptor: ApplyFormDescriptor = { vendor: 'lever', root, fields };
  const plan = buildApplyPlan(descriptor, profile, { fillEmptyOnly });
  const summary = await runApplyPlan({
    plan,
    auth: fillAuthority(plan.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: createBundledApplyPolicy(Date.now()),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 10,
  });
  return { fields, plan, summary, result: summary.results.find((result) => result.key === 'location') };
}

describe('typeahead combobox binding (Lever-shaped plain-text typeahead)', () => {
  it('scans the bare text input as a combobox carrying the typeahead binding', () => {
    const { trigger } = mountLever(GEOCODER);
    const adapter = typeaheadAdapter();
    const root = adapter.resolveRoot(document)!;
    expect(adapter.scan(root).find((field) => field.element === trigger)).toMatchObject({
      kind: 'combobox',
      key: 'location',
      listbox: {
        valueContainerSelector: 'li.application-question',
        selectedValueSelector: 'input.location-input',
        typeahead: { suggestionSelector: '.dropdown-results > .dropdown-location', minTypedChars: 2, selectionWitnessSelector: 'input[name="selectedLocation"]' },
      },
    });
  });

  it('without the binding the same input stays the honest WIDGET manual item', () => {
    const { trigger } = mountLever(GEOCODER);
    // lever.json ships the binding now, so the "no binding" shape has to be
    // built: the guard being locked is that a rule which only *names* the
    // widget still refuses to write it as an ordinary text field.
    const unbound = structuredClone(leverRules) as Record<string, unknown>;
    delete unbound['typeaheadComboboxes'];
    unbound['widgetNames'] = ['location'];
    const adapter = compileBundledAdapter(unbound);
    const root = adapter.resolveRoot(document)!;
    expect(adapter.scan(root).find((field) => field.element === trigger)).toMatchObject({ kind: 'unsupported', unsupportedReason: 'WIDGET' });
  });

  /**
   * 红证：把键盘信封拿掉，同一次填充必然填不进去。
   *
   * 这是 `HOST_EVENTS` 增加 keydown/keyup 的全部理由，所以它要有一条只证明
   * 这一件事的测试——`stopImmediatePropagation` 掉触发器上的 keydown，等价于
   * 「我们没发这一下」，其余一切不变。
   *
   * 落的码是 `CHOICE_NO_DATA` 而不是 `WIDGET_TIMEOUT`：建议列表一条都没出现过，
   * 对 typeahead 来说「空」是稳定终态（`emptyIsFinal: false` 的预算走完即判空），
   * 不是「没稳定下来」。这一点纠正了 lever.json 旧注释里的那句预判。
   */
  it('without the keyboard envelope reaching the widget, the same fill writes nothing', async () => {
    const { trigger, hidden } = mountLever(GEOCODER);
    trigger.addEventListener('keydown', (event) => event.stopImmediatePropagation(), true);
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
    expect(hidden.value).toBe('');
  }, 20_000);

  it('sends exactly one keydown per query, carrying that query\'s last character', async () => {
    const { keys, queries } = mountLever((query) => (query === 'San Francisco' ? GEOCODER(query) : []));
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: true });
    // 两次查询（完整候选 → 首段），各一下按键；`key` 是那串查询的末字符。
    expect(queries).toEqual(['San Francisco, CA, United States', 'San Francisco']);
    expect(keys).toEqual(['s', 'o']);
  }, 20_000);

  it('never sends a keystroke to a plain text field on the same page', async () => {
    mountLever(GEOCODER);
    const name = document.querySelector<HTMLInputElement>('input[name="name"]')!;
    const seen: string[] = [];
    for (const type of ['keydown', 'keyup', 'keypress']) {
      name.addEventListener(type, (event) => seen.push(event.type), true);
    }
    // 同一次运行里那个普通文本框确实被写了（否则这条断言是空转）。
    await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States', fullName: 'Taylor Example' });
    expect(name.value).toBe('Taylor Example');
    expect(seen).toEqual([]);
  }, 20_000);

  it('types the candidate, picks the agreeing suggestion, and confirms display plus witness', async () => {
    const { trigger, hidden, queries } = mountLever(GEOCODER);
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ key: 'location', ok: true });
    expect(trigger.value).toBe('San Francisco, California, United States');
    expect(JSON.parse(hidden.value)).toMatchObject({ name: 'San Francisco, California, United States', index: 0 });
    expect(queries).toEqual(['San Francisco, CA, United States']);
    expect(document.querySelectorAll('.dropdown-location')).toHaveLength(0);
  });

  it('falls back to the leading segment when the full candidate yields nothing usable', async () => {
    const { trigger, queries } = mountLever((query) => (query === 'San Francisco' ? GEOCODER(query) : []));
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: true });
    expect(trigger.value).toBe('San Francisco, California, United States');
    expect(queries).toEqual(['San Francisco, CA, United States', 'San Francisco']);
  }, 20_000);

  it('never writes and restores the empty box when no suggestion matches', async () => {
    const { trigger, hidden } = mountLever(GEOCODER);
    const { result } = await fill(typeaheadAdapter(), { location: 'Atlantis, ZZ, Nowhere' });
    expect(result).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
    expect(hidden.value).toBe('');
  });

  it('refuses several agreeing suggestions and restores the box', async () => {
    const { trigger } = mountLever(GEOCODER);
    const { result } = await fill(typeaheadAdapter(), { location: 'Springfield' });
    expect(result).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION' });
    expect(trigger.value).toBe('');
  });

  it('reports WRITE_REVERTED and restores the box when the widget ignores the pick (typed text is not a selection)', async () => {
    const { trigger, hidden } = mountLever(GEOCODER, { registerPick: false });
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: false, reason: 'WRITE_REVERTED' });
    expect(trigger.value).toBe('');
    expect(hidden.value).toBe('');
  });

  it('requires the witness when the rule declares one: a pick that only sets the text is a revert', async () => {
    const { trigger, hidden } = mountLever(GEOCODER);
    document.addEventListener('mousedown', (event) => {
      const target = event.target as Element;
      if (target.classList.contains('dropdown-location')) hidden.value = '';
    });
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: false, reason: 'WRITE_REVERTED' });
    expect(trigger.value).toBe('');
  });

  it('skips queries shorter than minTypedChars', async () => {
    const { queries } = mountLever(GEOCODER);
    const { result } = await fill(typeaheadAdapter({ minTypedChars: 16 }), { location: 'Atlantis, ZZ, Nowhere' });
    expect(result).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(queries).toEqual(['Atlantis, ZZ, Nowhere']);
  });

  it('keeps a different existing selection when filling empty fields only', async () => {
    const { trigger, hidden, queries } = mountLever(GEOCODER);
    setInputValue(trigger, 'Oakland, California, United States');
    hidden.value = JSON.stringify({ name: 'Oakland, California, United States' });
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(trigger.value).toBe('Oakland, California, United States');
    expect(queries).toEqual([]);
  });

  it('accepts an existing selection equal to the candidate only when the witness confirms it', async () => {
    const { trigger, hidden, queries } = mountLever(GEOCODER);
    setInputValue(trigger, 'San Francisco, California, United States');
    hidden.value = JSON.stringify({ name: 'San Francisco, California, United States' });
    expect((await fill(typeaheadAdapter(), { location: 'San Francisco, California, United States' })).result).toMatchObject({ ok: true });
    expect(queries).toEqual([]);

    hidden.value = '';
    const { result } = await fill(typeaheadAdapter(), { location: 'San Francisco, California, United States' });
    expect(result).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(trigger.value).toBe('San Francisco, California, United States');
  });

  it('fails closed when the declared witness or container is missing from the page', async () => {
    mountLever(GEOCODER);
    document.getElementById('selected-location')!.remove();
    expect((await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' })).result).toMatchObject({ ok: false, reason: 'CAPABILITY_DISABLED' });
    const { trigger } = mountLever(GEOCODER);
    expect((await fill(typeaheadAdapter({ containerSelector: 'section.never' }), { location: 'San Francisco, CA, United States' })).result).toMatchObject({ ok: false, reason: 'CAPABILITY_DISABLED' });
    expect(trigger.value).toBe('');
  });

  it('never leaves the trigger with search text when stopped by the execution fence mid-way', async () => {
    const { trigger } = mountLever(GEOCODER, { delayMs: 300 });
    const adapter = typeaheadAdapter();
    const root = adapter.resolveRoot(document)!;
    const fields = [...adapter.scan(root)];
    const plan = buildApplyPlan({ vendor: 'lever', root, fields }, { location: 'San Francisco, CA, United States' }, { fillEmptyOnly: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const summary = await runApplyPlan({
      plan,
      auth: fillAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 10,
      signal: controller.signal,
    });
    expect(summary.results.find((result) => result.key === 'location')?.ok).toBe(false);
    expect(trigger.value).toBe('');
  });
});

/**
 * 整轮结束之后的复核也问下拉部件（2026-09-24）。
 *
 * 部件自己的那一句「页面上是不是还是我们选的那一项」从前只在收尾那一次延时复检里问（250 毫秒）。
 * 简历解析是一次服务端往返：测试台 2026-09-24 在 Lever（jobs.lever.co/palantir/ac978161-…/apply）上
 * 量到，附上简历之后宿主把我们填好的「Current location」清空，而审计面板与浮层一直说「已填」——
 * 那是在说谎。复核（`ApplyRunSummary.recheck`）现在也问部件这一句。
 */
describe('整轮之后的复核也问下拉部件', () => {
  it('收尾之后宿主清空了地点：复核判 LATE_REVERTED，摘要本身不被改写', async () => {
    const { trigger, hidden } = mountLever(GEOCODER);
    const { result, summary } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    expect(result).toMatchObject({ key: 'location', ok: true });
    const rechecked = () => summary.recheck().find((entry) => entry.key === 'location');
    // 没人动过：复核照旧是成功。
    expect(rechecked()).toMatchObject({ ok: true });

    // 简历解析回来，把地点连同见证字段一起清空。
    setInputValue(trigger, '');
    hidden.value = '';
    expect(rechecked()).toMatchObject({ ok: false, reason: 'LATE_REVERTED' });
    expect(summary.results.find((entry) => entry.key === 'location')).toMatchObject({ ok: true });
  });

  it('部件整个被卸掉：读不到不等于没了，复核不改判', async () => {
    const { trigger } = mountLever(GEOCODER);
    const { summary } = await fill(typeaheadAdapter(), { location: 'San Francisco, CA, United States' });
    trigger.closest('li')!.remove();
    expect(summary.recheck().find((entry) => entry.key === 'location')).toMatchObject({ ok: true });
  });
});
