import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerPlan, buildApplyPlan } from '../src/engine';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { ripplingAdapter } from '../src/sites/rippling/applyForm';
import { createUndoJournal } from '../src/undo';
import type { ApplyFormDescriptor, VendorAdapter } from '../src/contracts';

/**
 * Two live widget shapes measured on 2026-09-15 that the react-select model did not
 * cover, replayed against the real vendor rules (rippling.json / ashby.json):
 *
 *  · Rippling (ats.rippling.com/peach-finance/jobs/b507c21b-…/apply): the search input
 *    is the display — after a pick its own `value` is the option text. Pronouns is a
 *    complete ARIA combobox (`aria-expanded`, `aria-controls` → `ul[role=listbox]` rendered
 *    inside the field wrapper); Location has only `aria-autocomplete` + `aria-haspopup`,
 *    never `role`/`aria-expanded`, and names its list with `aria-controls` only once a
 *    query produced results.
 *  · Ashby (jobs.ashbyhq.com/notion/7793e862-…/application): an ARIA combobox that opens
 *    only after typing, whose `[role=listbox]` is portaled to `<body>` outside the scan
 *    root, and whose selection is again the input's own value.
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
  return minted.value;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
}

async function run(adapter: VendorAdapter, vendor: 'rippling' | 'ashby', plan: (descriptor: ApplyFormDescriptor) => ReturnType<typeof buildApplyPlan>) {
  const root = adapter.resolveRoot(document)!;
  const fields = [...adapter.scan(root)];
  const descriptor: ApplyFormDescriptor = { vendor, root, fields };
  const built = plan(descriptor);
  const summary = await runApplyPlan({
    plan: built,
    auth: fillAuthority(built.fingerprint),
    journal: createUndoJournal(),
    root,
    policy: createBundledApplyPolicy(Date.now()),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 10,
  });
  return { fields, summary };
}

/** Rippling's select: the popper with `ul[role=listbox]` renders inside the field wrapper; a pick lands in the input's value. */
function mountRipplingPronouns(options: readonly string[]): HTMLInputElement {
  document.body.innerHTML = `
    <form>
      <div data-testid="field">
        <div><span id="field-8-label">First name</span></div>
        <div><div data-testid="first_name"><input data-testid="input-first_name" id="field-8" aria-labelledby="field-8-label" name="z7FRYsYUls" value=""></div></div>
      </div>
      <div data-testid="field" class="css-fuqajr eun831x1">
        <div class="css-1w8xq0 eun831x4"><span id="field-20-label" class="css-1xdhyk6">Pronouns</span></div>
        <div class="css-1fttcpj eun831x6">
          <div data-testid="pronouns_strategy" data-disabled="false" class="css-1y9duzt">
            <div><div data-testid="select-controller" class="css-jvil1b"><div class="css-18c1nrl"><div class="css-15epsmk">
              <div data-testid="select-search-input" class="css-1sjw7wz">
                <input data-input="select-search-input" data-testid="input-select-search-input" id="field-20" aria-required="false"
                  autocomplete="auto-complete-off" placeholder="Search" aria-label="Search" aria-labelledby="field-20-label" role="combobox"
                  aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" class="css-d76fs efnm4lm5" value="" name="F0_30gAsGBR">
              </div>
            </div></div></div></div>
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('field-20') as HTMLInputElement;
  const strategy = trigger.closest('[data-testid="pronouns_strategy"]')!;
  const close = () => {
    strategy.querySelector('[data-testid="popper"]')?.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
  };
  trigger.addEventListener('mousedown', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') { close(); return; }
    const popper = document.createElement('div');
    popper.setAttribute('data-testid', 'popper');
    popper.setAttribute('role', 'dialog');
    const list = document.createElement('ul');
    list.id = 'field-20-list';
    list.setAttribute('data-testid', 'menuList');
    list.setAttribute('role', 'listbox');
    const filter = trigger.value.trim().toLowerCase();
    options.filter((text) => text.toLowerCase().includes(filter)).forEach((text, index) => {
      const option = document.createElement('li');
      option.id = `field-20-list-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(trigger.value === text));
      option.textContent = text;
      option.addEventListener('click', () => {
        setInputValue(trigger, text);
        close();
      });
      list.append(option);
    });
    popper.append(list);
    strategy.append(popper);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'field-20-list');
  });
  return trigger;
}

/** Rippling's location: no role, never `aria-expanded`; a query produces `aria-controls` → `ul[role=listbox]` inside the field. */
function mountRipplingLocation(geocoder: (query: string) => readonly string[]): HTMLInputElement {
  document.body.innerHTML = `
    <form>
      <div data-testid="field">
        <div><span id="field-8-label">First name</span></div>
        <div><div data-testid="first_name"><input data-testid="input-first_name" id="field-8" aria-labelledby="field-8-label" name="z7FRYsYUls" value=""></div></div>
      </div>
      <div data-testid="field" class="css-fuqajr eun831x1">
        <div class="css-1w8xq0 eun831x4"><span id="field-42-label" class="css-191zjzq">Location</span><span class="css-1av554z">*</span></div>
        <div class="css-1fttcpj eun831x6">
          <div data-testid="location"><div><div class="css-1mlcsw efnm4lm1">
            <span class="css-kuu68s"><span data-icon="SEARCH_OUTLINE" aria-hidden="true"></span></span>
            <input data-testid="input-undefined" id="field-42" aria-required="true" autocomplete="off" aria-label="textbox"
              aria-labelledby="field-42-label" aria-autocomplete="list" aria-haspopup="listbox" class="css-d76fs efnm4lm5" value="" name="rhEOWUPSjwq">
          </div></div></div>
        </div>
      </div>
      <div data-testid="field"><div><div data-testid="externalPlaceId"><input data-testid="input-externalPlaceId" id="field-47" type="hidden" value="" name="i0Ju91_zsP5"></div></div></div>
    </form>`;
  const trigger = document.getElementById('field-42') as HTMLInputElement;
  const wrapper = trigger.closest('[data-testid="location"]')!;
  const close = () => {
    wrapper.querySelector('[data-testid="popper"]')?.remove();
    trigger.removeAttribute('aria-controls');
  };
  trigger.addEventListener('input', () => {
    const query = trigger.value.trim();
    setTimeout(() => {
      close();
      if (query === '') return;
      const popper = document.createElement('div');
      popper.setAttribute('data-testid', 'popper');
      popper.setAttribute('role', 'dialog');
      const list = document.createElement('ul');
      list.id = 'field-42-list';
      list.setAttribute('role', 'listbox');
      const results = geocoder(query);
      if (results.length === 0) {
        const status = document.createElement('div');
        status.setAttribute('role', 'status');
        status.textContent = `No results found for "${query}"`;
        list.append(status);
      }
      results.forEach((text, index) => {
        const option = document.createElement('li');
        option.id = `field-42-list-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.textContent = text;
        option.addEventListener('click', () => {
          setInputValue(trigger, text);
          close();
        });
        list.append(option);
      });
      popper.append(list);
      wrapper.append(popper);
      trigger.setAttribute('aria-controls', 'field-42-list');
    }, 20);
  });
  return trigger;
}

/** A geocoder answers fuzzily: an unknown place still yields nearby-sounding results. */
const RIPPLING_GEOCODER = (query: string): readonly string[] => {
  const city = query.split(',')[0]!.trim().toLowerCase();
  return city === 'san francisco'
    ? [
        'San Francisco, CA, USA',
        'San Francisco del Rincón, Guanajuato, Mexico',
        'San Francisco de Macorís, Dominican Republic',
        'San Francisco, Córdoba Province, Argentina',
        'San Francisco Solano, Buenos Aires Province, Argentina',
      ]
    : ['Atlanta, GA, USA', 'Atlantic City, NJ, USA'];
};

describe('Rippling select (value shown in the trigger, popper inside the field)', () => {
  const PRONOUNS = ['She/her/hers', 'He/him/his', 'They/them/theirs', 'Xe/xem/xyrs', 'Choose not to disclose'];

  it('scans Pronouns as a combobox bound to the trigger-as-display readback', () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    const root = ripplingAdapter.resolveRoot(document)!;
    const field = ripplingAdapter.scan(root).find((candidate) => candidate.element === trigger);
    expect(field).toMatchObject({
      kind: 'combobox',
      label: 'Pronouns',
      listbox: { valueContainerSelector: '[data-testid="pronouns_strategy"]', selectedValueSelector: 'input[data-testid="input-select-search-input"]' },
    });
  });

  it('opens the list, clicks the answered option and reads the trigger value back', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'They/them/theirs' }]));
    expect(summary.results).toEqual([{ key: 'question:pronouns', label: 'Pronouns', ok: true }]);
    expect(trigger.value).toBe('They/them/theirs');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="popper"]')).toBeNull();
  });

  it('refuses an answer the list does not carry and leaves the box empty', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'Decline to self-identify' }]));
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
  });

  it('treats text already in the trigger as the current selection, not as mid-interaction', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    setInputValue(trigger, 'He/him/his');
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'They/them/theirs' }]));
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'NOT_EMPTY' });
    expect(trigger.value).toBe('He/him/his');
  });

  it('accepts a selection that already equals the answer without opening the list', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    setInputValue(trigger, 'They/them/theirs');
    let opened = 0;
    trigger.addEventListener('mousedown', () => { opened += 1; });
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'They/them/theirs' }]));
    expect(summary.results[0]).toMatchObject({ ok: true });
    expect(opened).toBe(0);
  });

  // 2026-09-23 实测：每个下拉恒定 ~560ms，其中 250ms 是它自己的延时复查——一页十几个就是三四秒。
  // 复查改由 runner 在整轮收尾那一次统一做：写入器选完、看到值就返回，不再各自等。
  it('does not sleep out its own late recheck under the runner: the one end-of-run delay covers it', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    const root = ripplingAdapter.resolveRoot(document)!;
    const descriptor: ApplyFormDescriptor = { vendor: 'rippling', root, fields: [...ripplingAdapter.scan(root)] };
    const built = buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'They/them/theirs' }]);
    let delays = 0;
    const started = Date.now();
    const summary = await runApplyPlan({
      plan: built,
      auth: fillAuthority(built.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      // 窗口开得很大：写入器要是还自己等，这一条就要跑五秒以上。
      lateRecheckMs: 5_000,
      lateRecheckDelay: async () => { delays += 1; },
    });
    expect(summary.results[0]).toMatchObject({ ok: true });
    expect(trigger.value).toBe('They/them/theirs');
    expect(delays, 'runner waits once for the whole run').toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still catches a pick the host takes back after the widget returned (LATE_REVERTED at the end-of-run recheck)', async () => {
    const trigger = mountRipplingPronouns(PRONOUNS);
    trigger.addEventListener('mousedown', () => {
      // 宿主在我们看到值之后才把它撤掉——延时复查要抓的正是这一种。
      for (const option of document.querySelectorAll('[role="option"]')) {
        option.addEventListener('click', () => { setTimeout(() => setInputValue(trigger, ''), 1); });
      }
    });
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildAnswerPlan(descriptor, [{ questionId: 'pronouns', element: trigger, value: 'They/them/theirs' }]));
    expect(summary.results[0]).toMatchObject({ ok: false, reason: 'LATE_REVERTED' });
  });

  /**
   * 2026-09-15 那一版刻意不绑自我认同题（当时它们一律交还用户）。2026-09-21 起 EEO 按用户在门户里存的答案
   * 直接写，而 2026-09-24 测试台 ats.rippling.com/moov/…/apply 上「Please identify your race」仍落
   * CAPABILITY_DISABLED——没有 binding。现在 eeoc.* 里的搜索输入都绑上；电话区号照旧不绑。
   */
  it('binds the searchable EEO selects (eeoc.*) but never the phone country code', () => {
    mountRipplingPronouns(PRONOUNS);
    const field = document.querySelector('[data-testid="pronouns_strategy"]')!.closest('[data-testid="field"]')!;
    const clone = (testid: string, id: string, label: string): HTMLInputElement => {
      const copy = field.cloneNode(true) as HTMLElement;
      copy.querySelector('[data-testid="pronouns_strategy"]')!.setAttribute('data-testid', testid);
      const labelNode = copy.querySelector('#field-20-label')!;
      labelNode.id = `${id}-label`;
      labelNode.textContent = label;
      const input = copy.querySelector('input')!;
      input.id = id;
      input.setAttribute('aria-labelledby', `${id}-label`);
      field.after(copy);
      return input;
    };
    const race = clone('eeoc.race', 'field-73', 'Please identify your race');
    const phoneCode = clone('phone_number-code', 'field-34', 'Country code');
    const root = ripplingAdapter.resolveRoot(document)!;
    const fields = ripplingAdapter.scan(root);
    expect(fields.find((candidate) => candidate.element === race)).toMatchObject({
      kind: 'combobox',
      label: 'Please identify your race',
      listbox: { valueContainerSelector: '[data-testid^="eeoc."]', selectedValueSelector: 'input[data-testid="input-select-search-input"]' },
    });
    expect((fields.find((candidate) => candidate.element === phoneCode) as { listbox?: unknown } | undefined)?.listbox).toBeUndefined();
  });

  it('answers the EEO race and veteran selects from the profile codes (Moov options, 2026-09-24)', async () => {
    const RACES = ['American Indian or Alaskan Native', 'Asian', 'Black or African American', 'Middle Eastern or North African', 'White', 'Native Hawaiian or other Pacific Islander', 'Two or more races', 'Choose not to disclose'];
    const trigger = mountRipplingPronouns(RACES);
    const strategy = trigger.closest('[data-testid="pronouns_strategy"]')!;
    strategy.setAttribute('data-testid', 'eeoc.race');
    document.getElementById('field-20-label')!.textContent = 'Please identify your race';
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { eeoRace: 'ASIAN' }, { fillEmptyOnly: true, capabilities: { 'set-self-identification': true } }));
    expect(summary.results.find((result) => result.key === 'eeoRace')).toMatchObject({ ok: true });
    expect(trigger.value).toBe('Asian');

    const VETERAN = ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', 'Choose not to disclose'];
    const veteran = mountRipplingPronouns(VETERAN);
    veteran.closest('[data-testid="pronouns_strategy"]')!.setAttribute('data-testid', 'eeoc.veteranStatus');
    document.getElementById('field-20-label')!.textContent = 'Veteran Status';
    const second = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { eeoVeteran: 'DECLINE' }, { fillEmptyOnly: true, capabilities: { 'set-self-identification': true } }));
    expect(second.summary.results.find((result) => result.key === 'eeoVeteran')).toMatchObject({ ok: true });
    expect(veteran.value).toBe('Choose not to disclose');
  });
});

describe('Rippling location (no role, no aria-expanded, list named only once results exist)', () => {
  it('scans Location as a combobox keyed by its label with the location binding', () => {
    const trigger = mountRipplingLocation(RIPPLING_GEOCODER);
    const root = ripplingAdapter.resolveRoot(document)!;
    const field = ripplingAdapter.scan(root).find((candidate) => candidate.element === trigger);
    expect(field).toMatchObject({
      kind: 'combobox',
      key: 'location',
      listbox: { valueContainerSelector: '[data-testid="location"]', selectedValueSelector: 'input[aria-haspopup="listbox"]' },
    });
  });

  it('types the profile location, matches the geocoder result across the USA alias and reads the value back', async () => {
    const trigger = mountRipplingLocation(RIPPLING_GEOCODER);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'San Francisco, CA, United States' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: true });
    expect(trigger.value).toBe('San Francisco, CA, USA');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('restores the empty box when the geocoder knows nothing matching', async () => {
    const trigger = mountRipplingLocation(RIPPLING_GEOCODER);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'Atlantis, ZZ, Nowhere' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
    // The widget drops its list on its own once the restored empty value reaches it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('waits out a "No results found" list (zero options, only a status row) for every query, then restores the box', async () => {
    const trigger = mountRipplingLocation(() => []);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'Atlantis, ZZ, Nowhere' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
  }, 20_000);

  it('refuses when several results agree with the candidate instead of taking the first', async () => {
    const trigger = mountRipplingLocation(() => ['Springfield, IL, USA', 'Springfield, MA, USA']);
    const { summary } = await run(ripplingAdapter, 'rippling', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'Springfield' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'AMBIGUOUS_OPTION' });
    expect(trigger.value).toBe('');
  });
});

/**
 * Ashby: no `<form>`, the anchor is `.ashby-application-form-container`; the autocomplete
 * input has neither id nor name (its label cannot associate, so the placeholder is the
 * label), the field wrapper carries `data-field-path="_systemfield_location"`, and the
 * `[role=listbox]` is appended to `<body>` while open.
 */
function mountAshbyLocation(
  geocoder: (query: string) => readonly string[],
  { registerPick = true, popupRole = 'listbox' as string | null } = {},
): HTMLInputElement {
  document.body.innerHTML = `
    <div class="ashby-application-form-container">
      <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="_systemfield_name">
        <label class="ashby-application-form-question-title" for="_systemfield_name">Full Name</label>
        <input placeholder="Jane Doe..." name="_systemfield_name" required="" id="_systemfield_name" type="text" class="ashby-application-form-input-text" value="">
      </div>
      <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="_systemfield_location" data-field-entry-id="4f6f9897__systemfield_location">
        <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="_systemfield_location">Location</label>
        <div class="_inputContainer_d7ago_28">
          <input class="_input_d7ago_28 ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list"
            aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
          <button class="_container_pjyt6_1 _toggleButton_d7ago_32" type="button"></button>
        </div>
      </div>
    </div>`;
  const trigger = document.querySelector('.ashby-application-form-input-autocomplete') as HTMLInputElement;
  const close = () => {
    document.getElementById(':r2:')?.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
  };
  trigger.addEventListener('input', () => {
    const query = trigger.value.trim();
    setTimeout(() => {
      close();
      if (query === '') return;
      const portal = document.createElement('div');
      portal.id = ':r2:';
      const listbox = document.createElement('div');
      listbox.id = ':r0:';
      if (popupRole !== null) listbox.setAttribute('role', popupRole);
      listbox.className = '_floatingContainer_d7ago_103';
      const results = document.createElement('div');
      results.className = '_resultContainer_d7ago_116 ashby-application-form-input-autocomplete-popup';
      const hits = geocoder(query);
      if (hits.length === 0) results.setAttribute('data-empty', '');
      hits.forEach((text, index) => {
        const option = document.createElement('div');
        option.id = `:r${index + 3}:`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === 0));
        option.className = `_result_d7ago_107 ashby-application-form-input-autocomplete-popup-result`;
        option.textContent = text;
        option.addEventListener('click', () => {
          if (!registerPick) return;
          setInputValue(trigger, text);
          close();
        });
        results.append(option);
      });
      listbox.append(results);
      portal.append(listbox);
      document.body.append(portal);
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', ':r0:');
    }, 20);
  });
  return trigger;
}

const ASHBY_GEOCODER = (query: string): readonly string[] => {
  const city = query.split(',')[0]!.trim().toLowerCase();
  return city === 'san francisco'
    ? [
        'San Francisco, California, United States',
        'San Francisco Bay Area, California, United States',
        'San Francisco de Macorís, Duarte, Dominican Republic',
        'San Francisco, Córdoba, Argentina',
      ]
    : ['Coacalco, Mexico, Mexico'];
};

describe('Ashby location autocomplete (opens on typing, listbox portaled outside the scan root)', () => {
  it('keys the field through the wrapper data-field-path and binds the trigger-as-display readback', () => {
    const trigger = mountAshbyLocation(ASHBY_GEOCODER);
    const root = ashbyAdapter.resolveRoot(document)!;
    const fields = ashbyAdapter.scan(root);
    expect(fields.find((candidate) => candidate.element === trigger)).toMatchObject({
      kind: 'combobox',
      key: 'location',
      confidence: 1,
      listbox: { valueContainerSelector: '.ashby-application-form-field-entry', selectedValueSelector: 'input.ashby-application-form-input-autocomplete' },
    });
    // The last-placed wrapper step never shadows the earlier name table.
    expect(fields.find((candidate) => candidate.element.id === '_systemfield_name')).toMatchObject({ key: 'fullName' });
  });

  it('types, clicks the option inside the portaled list the trigger controls, and reads the value back', async () => {
    const trigger = mountAshbyLocation(ASHBY_GEOCODER);
    const { summary } = await run(ashbyAdapter, 'ashby', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'San Francisco, CA, United States' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: true });
    expect(trigger.value).toBe('San Francisco, California, United States');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(':r2:')).toBeNull();
  });

  it('still denies a portaled option whose container is not a listbox (the OUTSIDE_FORM lift needs the ARIA popup)', async () => {
    const trigger = mountAshbyLocation(ASHBY_GEOCODER, { popupRole: null });
    let clicked = false;
    document.body.addEventListener('click', (event) => {
      if ((event.target as Element).getAttribute('role') === 'option') clicked = true;
    });
    const { summary } = await run(ashbyAdapter, 'ashby', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'San Francisco, CA, United States' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'CLICK_DENIED' });
    expect(clicked).toBe(false);
    expect(trigger.value).toBe('');
  });

  it('reports WRITE_REVERTED and clears the typed query when the widget ignores the pick', async () => {
    const trigger = mountAshbyLocation(ASHBY_GEOCODER, { registerPick: false });
    const { summary } = await run(ashbyAdapter, 'ashby', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'San Francisco, CA, United States' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'WRITE_REVERTED' });
    expect(trigger.value).toBe('');
  });

  it('leaves the box empty when no result matches', async () => {
    const trigger = mountAshbyLocation(ASHBY_GEOCODER);
    const { summary } = await run(ashbyAdapter, 'ashby', (descriptor) =>
      buildApplyPlan(descriptor, { location: 'Atlantis, ZZ, Nowhere' }, { fillEmptyOnly: true }));
    expect(summary.results.find((result) => result.key === 'location')).toMatchObject({ ok: false, reason: 'CHOICE_NO_DATA' });
    expect(trigger.value).toBe('');
    // The widget closes its list on its own once the restored empty value reaches it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(':r2:')).toBeNull();
  });
});
