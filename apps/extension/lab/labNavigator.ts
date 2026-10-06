/**
 * ATS lab wizard navigator (VIBE_DIST=ats-lab only).
 *
 * The production engine never advances a wizard step. The lab needs to, so it
 * can measure every page of a multi-step application, but it keeps the one
 * rule that matters: it never activates anything that could submit.
 *
 *  - Only `type="button"` buttons, `role="button"` elements and vendor-declared
 *    next controls qualify. Native submit buttons and links are refused.
 *  - The visible text must read as "next / continue" and must not read as
 *    "submit / apply / finish".
 *  - The control must be visible and enabled.
 *
 * Pre-steps are the other lab-only affordance: some vendors hide the form
 * behind an in-page "Apply for this job" expander (BambooHR) or a "Start
 * application" button. Those are also plain buttons, never consent grants.
 */

const NEXT_TEXT = /^(?:next|continue|save (?:and|&) continue|save (?:and|&) next|next step|next page|continue application|continue to (?:the )?next(?: step| page)?|proceed)\b/iu;
const SUBMIT_TEXT = /submit|apply now|send (?:my |the )?application|finish|complete (?:my |the )?application|review (?:and|&) submit|confirm (?:and|&) submit|place (?:my )?application|i accept|agree/iu;
const PRESTEP_TEXT = /^(?:apply for this job|apply for this position|apply now|apply|start application|start your application|begin application|i'm interested|i am interested)\b/iu;

const VENDOR_NEXT_SELECTORS: readonly string[] = [
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id="pageFooterNextButton"]',
];

export interface NavigatorHit {
  readonly control: HTMLElement;
  readonly text: string;
  readonly how: 'vendor-selector' | 'text';
}

export interface NavigatorRefusal {
  readonly refusal: 'NO_CANDIDATE' | 'ONLY_SUBMIT_TYPE' | 'ONLY_LINKS';
  readonly candidates: readonly string[];
}

export function controlText(element: Element): string {
  const aria = element.getAttribute('aria-label')?.trim();
  const own = (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
  const value = (element as HTMLInputElement).value;
  return (aria || own || (typeof value === 'string' ? value : '') || '').slice(0, 80);
}

export function isVisibleControl(element: Element): boolean {
  if (element.getClientRects().length === 0) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  if (style.visibility === 'hidden' || style.display === 'none' || Number.parseFloat(style.opacity || '1') === 0) return false;
  return true;
}

function isEnabledControl(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  return true;
}

export function isSubmitLike(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'button' && (type === 'submit' || type === '')) return true;
  if (tag === 'input' && (type === 'submit' || type === 'image')) return true;
  return SUBMIT_TEXT.test(controlText(element));
}

function collectShadowRoots(root: ParentNode, out: ParentNode[], depth = 0): void {
  if (depth > 12) return;
  const all = root.querySelectorAll('*');
  for (const element of all) {
    const shadow = (element as Element).shadowRoot;
    if (shadow) {
      out.push(shadow);
      collectShadowRoots(shadow, out, depth + 1);
    }
  }
}

/** The lab's own floating panel must never be a navigation candidate. */
export const LAB_PANEL_HOST_ID = 'edaix-ats-lab';

function isLabOwned(root: ParentNode): boolean {
  const host = (root as ShadowRoot).host;
  return host instanceof Element && (host.id === LAB_PANEL_HOST_ID || host.closest(`#${LAB_PANEL_HOST_ID}`) !== null);
}

/** All button-like controls in the document, piercing open shadow roots. */
export function buttonLikeControls(doc: Document): HTMLElement[] {
  const roots: ParentNode[] = [doc];
  collectShadowRoots(doc, roots);
  const found: HTMLElement[] = [];
  for (const root of roots) {
    if (isLabOwned(root)) continue;
    for (const element of root.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"], [role="button"], a[href]')) {
      if (element instanceof HTMLElement && element.closest(`#${LAB_PANEL_HOST_ID}`) === null) found.push(element);
    }
  }
  return found;
}

export function findNextStepControl(doc: Document): NavigatorHit | NavigatorRefusal {
  // Vendor-declared step controls (Workday's footer button) keep one identity
  // across the wizard and only change their wording on the final step, so the
  // text is the deciding fact here, not the button type.
  for (const selector of VENDOR_NEXT_SELECTORS) {
    const control = doc.querySelector(selector);
    if (control instanceof HTMLElement && isVisibleControl(control) && isEnabledControl(control) && !SUBMIT_TEXT.test(controlText(control))) {
      return { control, text: controlText(control), how: 'vendor-selector' };
    }
  }
  const candidates = buttonLikeControls(doc).filter((element) => isVisibleControl(element) && isEnabledControl(element));
  const nextLike = candidates.filter((element) => NEXT_TEXT.test(controlText(element)) && !SUBMIT_TEXT.test(controlText(element)));
  const safe = nextLike.filter((element) => !isSubmitLike(element) && element.tagName.toLowerCase() !== 'a');
  if (safe.length > 0) return { control: safe[0]!, text: controlText(safe[0]!), how: 'text' };
  const labels = nextLike.map((element) => `${element.tagName.toLowerCase()}[type=${element.getAttribute('type') ?? ''}] "${controlText(element)}"`);
  if (nextLike.some((element) => element.tagName.toLowerCase() === 'a')) return { refusal: 'ONLY_LINKS', candidates: labels };
  if (nextLike.length > 0) return { refusal: 'ONLY_SUBMIT_TYPE', candidates: labels };
  return { refusal: 'NO_CANDIDATE', candidates: candidates.slice(0, 20).map(controlText) };
}

/**
 * Would activating this control submit a form? A `<button>` with no `type` is a submit button,
 * so the attribute alone is not the answer — the element's own `type` and `form` are.
 */
function submitsAForm(element: Element): boolean {
  if (element instanceof HTMLButtonElement) return element.type === 'submit' && element.form !== null;
  if (element instanceof HTMLInputElement) return (element.type === 'submit' || element.type === 'image') && element.form !== null;
  return false;
}

/**
 * In-page "Apply for this job" expanders. Links that navigate are allowed here: the target is still a job page.
 *
 * 2026-09-28: a control that would submit a form is never a pre-step. On a company-built form
 * (the generic lane) the form's own button often reads "Apply" and carries no `type` — the old
 * check only refused an explicit `type="submit"`, so it would have pressed that button.
 */
export function findPreStepControl(doc: Document): NavigatorHit | NavigatorRefusal {
  const candidates = buttonLikeControls(doc).filter((element) => isVisibleControl(element) && isEnabledControl(element));
  const applyLike = candidates.filter((element) => PRESTEP_TEXT.test(controlText(element)) && !/submit/iu.test(controlText(element)));
  const safe = applyLike.filter((element) => !submitsAForm(element));
  if (safe.length > 0) return { control: safe[0]!, text: controlText(safe[0]!), how: 'text' };
  return { refusal: 'NO_CANDIDATE', candidates: candidates.slice(0, 20).map(controlText) };
}
