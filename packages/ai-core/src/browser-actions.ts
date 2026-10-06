import type { BrowserAction, BrowserTarget, BrowserTaskOptions, BrowserObservation, JobExecutionResult, CreateJobInput } from '@companion/platform-contracts';
import type { ElementHandle, Page } from 'playwright';
import { ProviderError } from './errors.ts';
import { workflowHash } from './workflow.ts';

const sensitive = /(?:\b(?:pass(?:word|code)?|user[- ]?name|e[- ]?mail|phone|mobile|tel(?:ephone)?|log[- ]?in|sign[- ]?(?:in|up)|auth(?:entication)?|account|captcha|recaptcha|verification|verify|otp|one[- ]?time|two[- ]?factor|2fa|mfa|ssn|social[- ]?security|passport|identity|credit|debit|card|cc|cvv|cvc|birth|payment|billing|bank|routing|iban|tax|tos|terms|consent|agreement|accept|agree|submit|apply|send|confirm|purchase|checkout|pay|order|finish|final(?:ize)?|upload)\b|密码|口令|邮箱|邮件|手机|电话|登录|登入|注册|验证|验证码|身份|护照|社保|支付|付款|银行卡|信用卡|税号|条款|同意|隐私|提交|投递|申请|确认|购买|结算|完成|上传)/i;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function invalid(message = 'Browser options require a URL and at most twelve explicit reviewed actions.'): never { throw new ProviderError('INVALID_PROVIDER_INPUT', message, 400); }
function exact(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Browser scripts, selectors, coordinates and unknown fields are not supported.'); }
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid('Browser targets require a bounded visible role or label name.');
  return value;
}
function target(value: unknown, action: string): BrowserTarget {
  if (!plain(value)) invalid('Select a target by its role or label.');
  if (value.by === 'label') { exact(value, ['by','name']); return { by: 'label', name: name(value.name) }; }
  if (value.by !== 'role') invalid('Only role and label targets are supported.');
  exact(value, ['by','role','name']);
  const roles = action === 'click' ? ['link','button'] : action === 'fill' ? ['textbox'] : ['combobox'];
  if (typeof value.role !== 'string' || !roles.includes(value.role)) invalid('The target role does not match the reviewed action.');
  return { by: 'role', role: value.role as 'link' | 'button' | 'textbox' | 'combobox', name: name(value.name) };
}

/** Pure strict parsing; the executor separately resolves and pins public network addresses. */
export function parseBrowserTaskOptions(value: unknown): BrowserTaskOptions {
  if (!plain(value)) invalid(); exact(value, ['url','actions']);
  if (typeof value.url !== 'string' || !value.url.length || value.url.length > 4096) invalid('A browser task requires an absolute options.url.');
  let url: URL; try { url = new URL(value.url); } catch { return invalid('A browser task requires an absolute options.url.'); }
  if (url.href.length > 4096) invalid('The normalized browser URL exceeds its size limit.');
  if (url.username || url.password) throw new ProviderError('BROWSER_ADDRESS_BLOCKED', 'URLs containing credentials are not allowed.', 400);
  if (!['http:','https:'].includes(url.protocol)) throw new ProviderError('BROWSER_ADDRESS_BLOCKED', 'This URL scheme is not allowed.', 400);
  for (const key of url.searchParams.keys()) if (/^(?:password|passwd|pwd|secret|api[-_]?key|token|(?:access|refresh|id)[-_]?token|authorization|auth|session(?:id)?)$/i.test(key))
    throw new ProviderError('BROWSER_ADDRESS_BLOCKED', 'URLs containing authentication parameters are not allowed.', 400);
  if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.length > 12)) invalid();
  const actions: BrowserAction[] = (value.actions ?? []).map((entry: unknown) => {
    if (!plain(entry)) invalid();
    if (entry.type === 'scroll') {
      exact(entry, ['type','direction','pixels']);
      if (typeof entry.direction !== 'string' || !['up','down'].includes(entry.direction) || !Number.isInteger(entry.pixels) || Number(entry.pixels) < 1 || Number(entry.pixels) > 1200) invalid('Scroll by between 1 and 1200 pixels in a reviewed direction.');
      return { type: 'scroll', direction: entry.direction as 'up' | 'down', pixels: Number(entry.pixels) };
    }
    if (typeof entry.type !== 'string' || !['click','fill','select'].includes(entry.type)) invalid('Only click, fill, select and scroll actions are supported.');
    exact(entry, entry.type === 'click' ? ['type','target'] : entry.type === 'fill' ? ['type','target','value'] : ['type','target','optionLabel']);
    const selected = target(entry.target, String(entry.type));
    if (entry.type === 'fill') {
      if (typeof entry.value !== 'string' || entry.value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.value)) invalid('Fill values must be bounded text without control characters.');
      return { type: 'fill', target: selected, value: entry.value };
    }
    if (entry.type === 'select') return { type: 'select', target: selected, optionLabel: name(entry.optionLabel) };
    return { type: 'click', target: selected };
  });
  return { url: url.href, ...(actions.length ? { actions } : {}) };
}

export function browserDefinitionHash(input: CreateJobInput): string {
  if (input.kind !== 'browser' || input.provider !== 'browser' || typeof input.prompt !== 'string' || !input.prompt.length || input.prompt.length > 20_000 || input.attachmentIds?.length)
    invalid('Browser execution requires a reviewed browser task without attachments.');
  const options = parseBrowserTaskOptions({ url: input.options?.url, actions: input.options?.actions });
  return workflowHash({ version: 1, prompt: input.prompt, url: options.url, actions: options.actions ?? [] });
}

interface ElementMetadata { tag: string; type: string; role: string; disabled: boolean; readonly: boolean; contentEditable: boolean; text: string; href: string; sensitive: boolean; }
async function metadata(element: ElementHandle): Promise<ElementMetadata> {
  return element.evaluate((node: Element) => {
    const control = node as HTMLInputElement;
    const labels = 'labels' in control ? Array.from(control.labels ?? []).map(label => { const copy = label.cloneNode(true) as Element; copy.querySelectorAll('input,textarea,select,button,[contenteditable]').forEach(node => node.remove()); return copy.textContent ?? ''; }).join(' ') : '';
    const labelled = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    const form = 'form' in control ? (control.form as HTMLFormElement | null) : node.closest('form');
    const attrs = ['id','name','type','autocomplete','placeholder','aria-label','title'].map(key => node.getAttribute(key) ?? '').join(' ');
    const context = [labels,labelled,attrs,node.tagName === 'A' || node.tagName === 'BUTTON' ? node.textContent ?? '' : '',
      form ? [form.getAttribute('id'),form.getAttribute('name'),form.getAttribute('action'),form.getAttribute('aria-label')].join(' ') : ''].join(' ').slice(0, 6000);
    return { tag: node.tagName.toLowerCase(), type: node.getAttribute('type')?.toLowerCase() ?? '', role: node.getAttribute('role')?.toLowerCase() ?? '',
      disabled: !!control.disabled || node.getAttribute('aria-disabled') === 'true', readonly: !!control.readOnly, contentEditable: (node as HTMLElement).isContentEditable,
      text: context, href: node.getAttribute('href') ?? '', sensitive: node.closest('[data-sensitive], [autocomplete="current-password"], [autocomplete="new-password"]') !== null };
  });
}
function permitted(meta: ElementMetadata, action: 'click' | 'fill' | 'select', targetName: string): boolean {
  const description = (targetName + ' ' + meta.text + ' ' + meta.href).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
  if (meta.disabled || meta.sensitive || sensitive.test(description)) return false;
  if (action === 'click') {
    let link = false;
    try { link = !!meta.href && ['http:','https:'].includes(new URL(meta.href,'https://fixture.invalid/').protocol); } catch { /* Malformed link targets are blocked. */ }
    return meta.tag === 'a' && link || (meta.tag === 'button' || meta.tag === 'input') && meta.type === 'button';
  }
  if (meta.readonly || meta.contentEditable) return false;
  if (action === 'fill') return meta.tag === 'textarea' || meta.tag === 'input' && ['', 'text','search'].includes(meta.type);
  return meta.tag === 'select';
}

/** Pin the inspected element handle so a later locator re-resolution cannot select another DOM node. */
export async function safeBrowserTarget(page: Page, action: Exclude<BrowserAction, { type: 'scroll' }>): Promise<ElementHandle> {
  const selected = action.target.by === 'role' ? page.getByRole(action.target.role, { name: action.target.name, exact: true }) : page.getByLabel(action.target.name, { exact: true });
  if (await selected.count() > 100) throw new ProviderError('BROWSER_TARGET_BLOCKED', 'The reviewed browser target is ambiguous.', 409);
  const handles = await selected.elementHandles();
  if (!handles.length && action.target.by === 'label') {
    // A wrapping label's DOM text can include select options. Match only its descriptive text.
    const labels = page.locator('label');
    for (let index = 0, count = Math.min(await labels.count(),100); index < count; index++) {
      const label = await labels.nth(index).elementHandle(); if (!label) continue;
      try {
        const text = await label.evaluate(node => { const copy = node.cloneNode(true) as Element; copy.querySelectorAll('input,textarea,select,button,[contenteditable]').forEach(child => child.remove()); return (copy.textContent ?? '').replace(/\s+/g,' ').trim(); });
        if (text !== action.target.name) continue;
        const property = await label.getProperty('control'), control = property.asElement();
        if (!control) { await property.dispose(); continue; }
        let duplicate = false;
        for (const existing of handles) if (await control.evaluate((node,other) => node === other,existing)) { duplicate = true; break; }
        if (duplicate) await control.dispose(); else handles.push(control);
      } finally { await label.dispose(); }
    }
  }
  if (handles.length > 100) { await Promise.all(handles.map(handle => handle.dispose())); throw new ProviderError('BROWSER_TARGET_BLOCKED', 'The reviewed browser target is ambiguous.', 409); }
  const visible: ElementHandle[] = [];
  for (const handle of handles) { if (await handle.isVisible()) visible.push(handle); else await handle.dispose(); }
  if (visible.length !== 1) { await Promise.all(visible.map(handle => handle.dispose())); throw new ProviderError('BROWSER_TARGET_BLOCKED', 'The reviewed browser target must be uniquely visible.', 409); }
  const element = visible[0];
  const meta = await metadata(element);
  if (!permitted(meta, action.type, action.target.name)) { await element.dispose(); throw new ProviderError('BROWSER_TARGET_BLOCKED', 'Sensitive fields, authentication, agreements and submission controls require user participation.', 409); }
  return element;
}

export async function performBrowserAction(page: Page, action: BrowserAction): Promise<void> {
  if (action.type === 'scroll') {
    await page.mouse.wheel(0, action.direction === 'down' ? action.pixels : -action.pixels);
    // Wheel is a request; give the page bounded paint time without dispatching it again.
    await page.evaluate(`new Promise(resolve => {
      let frames = 0; const timer = setTimeout(resolve,250);
      const painted = () => { if (++frames >= 2) { clearTimeout(timer); resolve(); } else requestAnimationFrame(painted); };
      requestAnimationFrame(painted);
    })`);
    return;
  }
  const element = await safeBrowserTarget(page, action);
  try {
    // Reinspect the pinned node immediately before dispatch; page code remains untrusted.
    if (!permitted(await metadata(element), action.type, action.target.name)) throw new ProviderError('BROWSER_TARGET_BLOCKED', 'The reviewed target changed before execution.', 409);
    if (action.type === 'click') await element.click({ timeout: 5000 });
    else if (action.type === 'fill') await element.fill(action.value, { timeout: 5000 });
    else {
      const choices = await element.evaluate((node, label) => Array.from((node as HTMLSelectElement).options).filter(option => option.label === label && !option.disabled && !option.hidden && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)).length, action.optionLabel);
      if (choices !== 1 || sensitive.test(action.optionLabel)) throw new ProviderError('BROWSER_TARGET_BLOCKED', 'Choose one available non-sensitive option by its reviewed label.', 409);
      await element.selectOption({ label: action.optionLabel }, { timeout: 5000 });
    }
  } finally { await element.dispose(); }
}

/** Only semantic descriptors are exposed; values, hrefs, selectors and raw HTML stay out of target records. */
export async function browserTargets(page: Page): Promise<{ target: BrowserTarget; action: 'click' | 'fill' | 'select' }[]> {
  const all = page.locator('a[href],button,input[type="button"],input:not([type]),input[type="text"],input[type="search"],textarea,select');
  const candidates: ElementHandle[] = [];
  for (let index = 0, count = Math.min(await all.count(), 100); index < count; index++) {
    const element = await all.nth(index).elementHandle(); if (element) candidates.push(element);
  }
  const targets: { target: BrowserTarget; action: 'click' | 'fill' | 'select' }[] = [];
  try {
    for (const element of candidates.slice(0, 100)) {
      if (targets.length >= 40) break;
      if (!await element.isVisible()) continue;
      const info = await element.evaluate((node: Element) => {
        const control = node as HTMLInputElement;
        const labels = 'labels' in control ? Array.from(control.labels ?? []).map(label => { const copy = label.cloneNode(true) as Element; copy.querySelectorAll('input,textarea,select,button,[contenteditable]').forEach(node => node.remove()); return copy.textContent ?? ''; }).join(' ') : '';
        const labelled = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
        return { tag: node.tagName.toLowerCase(), name: (node.getAttribute('aria-label') || labelled || labels || (['A','BUTTON'].includes(node.tagName) ? node.textContent : '') || '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,200), role: node.getAttribute('role') ?? '' };
      });
      if (!info.name || sensitive.test(info.name)) continue;
      const action = info.tag === 'a' || info.tag === 'button' || info.tag === 'input' && await element.getAttribute('type') === 'button' ? 'click' : info.tag === 'select' ? 'select' : 'fill';
      const role = action === 'click' ? info.tag === 'a' ? 'link' : 'button' : action === 'select' ? 'combobox' : 'textbox';
      let target: BrowserTarget = { by: 'role', role, name: info.name };
      if (info.role && info.role !== role || !permitted(await metadata(element), action, info.name)) continue;
      const matching = page.getByRole(role, { name: info.name, exact: true });
      if (await matching.count() !== 1) {
        if (action === 'click') continue;
        target = { by: 'label', name: info.name };
        const handle = await safeBrowserTarget(page, { type: action, target, ...(action === 'fill' ? { value: '' } : { optionLabel: '' }) } as Exclude<BrowserAction,{ type:'scroll' }>).catch(() => undefined);
        if (!handle) continue; await handle.dispose();
      }
      targets.push({ target, action });
    }
  } finally { await Promise.all(candidates.map(element => element.dispose())); }
  return targets;
}

export async function captureBrowserResult(page: Page, requestedUrl: string, url: string, completedActions: number): Promise<JobExecutionResult> {
  const title = (await page.title()).slice(0,500);
  const visibleText = await page.locator('body').evaluate((body: HTMLElement) => {
    // Form values are not observation text; no raw markup leaves the renderer.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = '', visited = 0;
    while (walker.nextNode() && text.length < 65_536 && ++visited < 20_000) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script,style,template,noscript,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none' || !parent.getClientRects().length) continue;
      text += (walker.currentNode.textContent ?? '').slice(0,65_536 - text.length) + '\n';
    }
    return text;
  });
  const bytes = Buffer.from(visibleText); let end = Math.min(bytes.length,64 * 1024);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const text = bytes.subarray(0,end).toString('utf8');
  const observation: BrowserObservation = { version: 1, provenance: 'untrusted_page', requestedUrl, url, title, text, completedActions, targets: await browserTargets(page) };
  const snapshot = `Title: ${title}\nRequested URL: ${requestedUrl}\nResponse URL: ${url}\nProvenance: untrusted_page\n\n${text}`;
  const screenshot = await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000, mask: [page.locator('input,textarea,select,[contenteditable]')] });
  if (screenshot.length > 4 * 1024 * 1024) throw new ProviderError('BROWSER_LIMIT_EXCEEDED', 'The page screenshot is too large.', 413);
  const json = Buffer.from(JSON.stringify(observation));
  if (json.length > 512 * 1024) throw new ProviderError('BROWSER_LIMIT_EXCEEDED', 'The page observation exceeds its size limit.', 413);
  return { text: snapshot, artifacts: [
    { name: 'browser-snapshot.txt', mime: 'text/plain', bytes: Buffer.from(snapshot) },
    { name: 'browser-screenshot.png', mime: 'image/png', bytes: screenshot },
    { name: 'browser-observation.json', mime: 'application/json', bytes: json },
  ] };
}
