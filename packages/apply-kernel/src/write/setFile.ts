import { dispatchHostEvent, EVENT_PROFILES } from './allowlist';
import { checkActiveCapability, type HostWriteAuthority, type WriteCapability } from '../grant';
import type { ApplyPolicy } from '../policy';
import type { FileUploadBinding, Result, ScanRoot } from '../contracts';
import type { WriteTicket } from '../undo';
import { isCoverLetterFileField, isHoneypot, isNonResumeFileField, isResumeFileField, namesNonCoverLetterUpload } from '../dict/guards';
import { fileContextMaxDepth } from './fileContextDepth.ts';

/**
 * 把简历文件挂到宿主的 `<input type="file">` 上。
 *
 * 铁律 3 的 autofill 例外明确允许写 `files`（与 `value` / `selectedIndex` / `checked`
 * 并列）。实测（2026-08-01，jobs.lever.co 与 job-boards.greenhouse.io）：标准的
 * `DataTransfer` 写入 + `change` 两家都接受，宿主自己的 UI 会渲染出文件名并开始它
 * 自己的解析流程。**不需要 `chrome.debugger`** —— Simplify 为此申请了那个权限
 * （CDP 的 `DOM.setFileInputFiles`），至少在这两家上是多余的，我们不申请。
 *
 * 为什么这是"控件扩围"里唯一值得做的一个：同日在两张真实表上数过，Greenhouse
 * 零单选/零复选/零日期；Lever 的 11 个复选框全是代词、3 个单选是 EEO 人口统计——
 * 两类都在硬禁令里，而且我们的 11 键档案里没有对应数据。而简历文件在几乎每张表上
 * 都是必填或准必填。
 */

const FILE_CAPABILITY: WriteCapability = 'set-file';

export interface AttachHostFileInput {
  readonly element: HTMLInputElement;
  readonly file: File;
  readonly root: ScanRoot;
  readonly authority: HostWriteAuthority;
  /** 原值已记录的证明。拿不到就一个字节都不写。 */
  readonly ticket: Result<WriteTicket, 'JOURNAL_UNAVAILABLE'>;
  readonly policy: ApplyPolicy;
  /**
   * 挂的是哪一件（2026-09-27）：简历（缺省）还是求职信。两者各走各的身份判据，
   * 求职信栏永远收不到简历，简历栏永远收不到求职信。
   */
  readonly purpose?: FileTargetPurpose;
}

export type FileTargetPurpose = 'resume' | 'cover-letter';

/**
 * 这一次写入结束时，我们能不能自己读回确认。
 *
 * 文件控件的回读不是字符串比对，是 `input.files` 里那个 File **对象同一性**
 * （`hasExactFile`）。读得到就该如实说读得到——2026-09-17 那轮 Ashby 上 89 条
 * 必填简历栏被报成「读不回」，正是因为这个判决以前没有地方可以带出去。
 *
 * · `readback`——控件还在、身份没漂、`files` 里就是我们挂的那个 File。
 * · `host-adopted`——宿主在 change 处理器里把 input 卸了或换了，只在字段上留下
 *   文件名。文件确实交出去了（所以不是失败），但**没有可读的控件**，因此不能
 *   声称已验证。
 */
export type AttachedFileConfirmation = 'readback' | 'host-adopted';

export type AttachHostFileError =
  | 'CAPABILITY_DISABLED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'JOURNAL_UNAVAILABLE'
  | 'POLICY_DISABLED'
  | 'DETACHED'
  | 'IDENTITY_CHANGED'
  | 'NOT_EMPTY'
  | 'VALUE_COERCED';

export interface ClearHostFileInput {
  readonly element: HTMLInputElement;
  readonly expectedFile: File;
  readonly authority: HostWriteAuthority;
  readonly ticket: WriteTicket;
}

export type ClearHostFileError =
  | 'CAPABILITY_DISABLED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'DETACHED'
  | 'IDENTITY_CHANGED'
  | 'VALUE_COERCED';

/**
 * `accept` 匹配。宿主会当场拒绝不合规的文件，而我们的面板会显示"已填"——
 * 制造一个假的成功比不填更糟。
 *
 * 支持三种写法（HTML 规范允许混用）：扩展名 `.pdf`、精确 MIME `application/pdf`、
 * 通配 MIME `application/＊`。空 `accept` 表示不限制。
 */
export function matchesFileAccept(accept: string, file: File): boolean {
  const rules = accept
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter((rule) => rule !== '');
  if (rules.length === 0) return true;

  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return mime.startsWith(`${rule.slice(0, -1)}`);
    return mime === rule;
  });
}

function isFullInsetClipPath(value: string | undefined): boolean {
  if (!value) return false;
  return /^inset\(\s*(?:0(?:\.0+)?(?:px|%|em|rem)?\s*){1,4}(?:round\s+[^)]+)?\)$/i.test(value);
}

const MIN_VISIBLE_OPACITY = 0.05;

function filterOpacityFactor(value: string | undefined): number {
  if (!value || !/opacity\(/i.test(value)) return 1;
  const matches = [
    ...value.matchAll(/opacity\(\s*(\d*\.?\d+)\s*(%)?\s*\)/gi),
  ];
  if (matches.length === 0) return 0;
  return matches.reduce((factor, match) => {
    const numeric = Number.parseFloat(match[1] ?? '');
    if (!Number.isFinite(numeric)) return 0;
    const opacity = match[2] ? numeric / 100 : numeric;
    return factor * Math.min(1, Math.max(0, opacity));
  }, 1);
}

/**
 * 遮罩把内容藏起来了吗（计算值，已小写）。
 *
 * 2026-09-28 PostHog：整页包在一个滚动区里，滚动区用 `mask-image: linear-gradient(rgba(0,0,0,0) 0px, rgb(0,0,0)
 * 32px, rgb(0,0,0) calc(100% - 32px), rgba(0,0,0,0))` 把上下两头各淡出 32px。从前任何遮罩都算「藏起来」，于是页面
 * 上每一个上传触发器都看不见、必填的简历写不进去。只有渐变读得懂：里面有一个不透明的色标（`rgb(…)`、alpha ≥ 0.95
 * 的 `rgba(…)`），它就只是淡出边缘。图片遮罩（`url(…)`）读不出透不透明、只有透明色标的渐变，仍算藏起来。
 */
function masksContentAway(mask: string): boolean {
  if (mask === '' || mask === 'none') return false;
  if (mask.includes('url(') || !/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/u.test(mask)) return true;
  for (const [color] of mask.matchAll(/rgba?\([^)]*\)/gu)) {
    const parts = color.slice(color.indexOf('(') + 1, -1).split(/[\s,/]+/u).filter(Boolean);
    if (parts.length === 3) return false;
    const alpha = parts.length === 4 ? Number.parseFloat(parts[3]!) * (parts[3]!.endsWith('%') ? 0.01 : 1) : Number.NaN;
    if (Number.isFinite(alpha) && alpha >= 0.95) return false;
  }
  return true;
}

function hasHiddenPresentation(element: Element): boolean {
  let effectiveOpacity = 1;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden')?.toLowerCase() === 'true'
    ) {
      return true;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    const opacityText = style?.opacity?.trim() ?? '';
    const opacity = opacityText === '' ? 1 : Number.parseFloat(opacityText);
    effectiveOpacity *=
      (Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0) *
      filterOpacityFactor(style?.filter);
    const clip = style?.clip?.trim().toLowerCase();
    const clipPath = style?.clipPath?.trim().toLowerCase();
    const maskImage = (
      style?.maskImage || style?.getPropertyValue?.('-webkit-mask-image') || ''
    ).trim().toLowerCase();
    const masked = masksContentAway(maskImage);
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.contentVisibility === 'hidden' ||
      effectiveOpacity < MIN_VISIBLE_OPACITY ||
      style?.pointerEvents === 'none' ||
      masked ||
      (clip !== undefined && clip !== '' && clip !== 'auto' && clip !== 'none') ||
      (clipPath !== undefined &&
        clipPath !== '' &&
        clipPath !== 'none' &&
        !isFullInsetClipPath(clipPath))
    ) {
      return true;
    }
  }
  return false;
}

function hasRenderedTriggerBox(element: Element): boolean {
  if (hasHiddenPresentation(element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  // Do not use vertical viewport position: a legitimate upload below the fold
  // must not flip from denied to approved merely because the user scrolled.
  // A box placed wholly beyond the horizontal canvas is deliberate hiding,
  // not ordinary document flow.
  const view = element.ownerDocument.defaultView;
  if (rect.right <= 0 || (view && rect.left >= view.innerWidth)) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const transform = style?.transform?.trim().toLowerCase();
  const translate = style?.translate?.trim().toLowerCase();
  const isTransformed =
    (transform !== undefined && transform !== '' && transform !== 'none') ||
    (translate !== undefined && translate !== '' && translate !== 'none');
  const verticallyOutside = rect.bottom <= 0 || Boolean(view && rect.top >= view.innerHeight);
  if (isTransformed && verticallyOutside) return false;
  if (style?.position === 'fixed' && verticallyOutside) return false;
  if (style?.position === 'absolute' && rect.bottom + (view?.scrollY ?? 0) <= 0) return false;

  const fontSize = Number.parseFloat(style?.fontSize ?? '');
  return !isHoneypot({
    geometry: {
      width: rect.width,
      height: rect.height,
      ...(style?.clip ? { clip: style.clip } : {}),
      ...(style?.clipPath ? { clipPath: style.clipPath } : {}),
      ...(Number.isFinite(fontSize) ? { fontSize } : {}),
    },
  });
}

function renderedTextContent(element: Element): string {
  const pieces: string[] = [];

  function visit(node: Node): void {
    if (node.nodeType === 3) {
      if (node.textContent) pieces.push(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (['script', 'style', 'template', 'noscript'].includes(child.localName)) return;
    if (hasHiddenPresentation(child)) return;
    for (const descendant of child.childNodes) visit(descendant);
  }

  for (const child of element.childNodes) visit(child);
  return pieces.join(' ');
}

function ariaLabelledByText(
  element: Element,
  allowReference: (reference: Element) => boolean = () => true,
): string {
  const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/).filter(Boolean) ?? [];
  return ids
    .map((id) => element.ownerDocument.getElementById(id))
    .filter((reference): reference is HTMLElement => reference !== null && allowReference(reference))
    .map((reference) => reference.textContent ?? '')
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value !== '')
    .join(' ');
}

/** Accessible descriptions may only veto a target; they never prove intent. */
function ariaDescriptionText(element: Element): string {
  const ids = element.getAttribute('aria-describedby')?.trim().split(/\s+/).filter(Boolean) ?? [];
  return [
    element.getAttribute('aria-description'),
    ...ids.map((id) => element.ownerDocument.getElementById(id)?.textContent),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value !== '')
    .join(' ');
}

function semanticTriggerName(element: Element): string {
  return [
    element.textContent,
    ariaLabelledByText(element),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    ariaDescriptionText(element),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value !== '')
    .join(' ');
}

/**
 * "Is a proper descendant of the verified container and not under an
 * excluded ancestor" — the same set `root.querySelectorAll('*')` returns,
 * decided in O(depth) through `root.isExcluded` instead of a shadow-piercing
 * walk that calls the host's shadow opener once per element. On Lever's
 * live page (2026-09-15) the file entry's ~6 such walks cost ~0.7 s of
 * synchronous work right while text entries' C6 frames were pending — the
 * way a sporadic VERIFY_TIMEOUT arises. Every element judged here came out
 * of the deep scan already, so membership needs no second traversal. The
 * parent (or shadow host) must be inside too: the root node itself is not a
 * member, exactly as `querySelectorAll` never returns its scope node.
 */
function isRootDescendant(node: Element, root: ScanRoot): boolean {
  if (root.isExcluded(node)) return false;
  const parent = node.parentElement ?? (node.parentNode as Partial<ShadowRoot> | null)?.host ?? null;
  return parent !== null && !root.isExcluded(parent);
}

function readableTriggerName(element: Element, root: ScanRoot): string {
  return [
    renderedTextContent(element),
    ariaLabelledByText(element, (reference) => isRootDescendant(reference, root)),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value !== '')
    .join(' ');
}

function associatedFileLabels(
  element: HTMLInputElement,
): ReadonlyArray<HTMLLabelElement> {
  // `input.labels` is the browser's canonical answer for *this* control. It
  // preserves duplicate-id safety (only the first matching input owns a
  // `for=id` label) and correctly handles wrapping labels. On live Lever and
  // Workable pages Chrome returns those labels here while `label.control` is
  // null, so rebuilding the relation from the label side rejects real uploads.
  return [...(element.labels ?? [])].filter((label) => {
    if (label.control === element) return true;

    const explicitId = label.htmlFor.trim();
    if (explicitId !== '') {
      const duplicates = [...element.ownerDocument.querySelectorAll('[id]')].filter(
        (candidate) => candidate.id === explicitId,
      );
      return (
        element.id === explicitId &&
        duplicates.length === 1 &&
        element.ownerDocument.getElementById(explicitId) === element
      );
    }

    if (!label.contains(element)) return false;
    const labelable = [
      ...label.querySelectorAll('button,input,meter,output,progress,select,textarea'),
    ].filter(
      (candidate) =>
        !(candidate instanceof HTMLInputElement && candidate.type.toLowerCase() === 'hidden'),
    );
    return labelable.length === 1 && labelable[0] === element;
  });
}

/**
 * 浏览器给 `<input type=file>` 自己渲染的空状态提示。
 *
 * 这不是页面写的字，是 Chrome/Firefox/Safari 在按钮旁边画的一句「还没选文件」。
 * 它跟在触发器名字后面，于是采到的上下文变成 `Choose File*No file selected`，
 * 把 `hasFileTriggerName` 里那条 `…(files?|résumé|cv)\s*$` 的结尾锚点顶掉。
 *
 * 2026-09-17 实测：BambooHR 八个页面的简历框全部因此认不出来——每页填了 139
 * 个字段，唯一必填的那个简历框一个没填，等于整份申请交不出去。那个 input 上
 * 没有 name、没有 id、附近也没有「Resume」字样，浏览器这句提示是采到的全部文字。
 */
const NATIVE_FILE_EMPTY_STATE =
  /\bno files? (?:chosen|selected)\b|keine datei(?:en)? ausgew[äa]hlt|aucun fichier (?:choisi|s[ée]lectionn[ée])|ning[úu]n archivo seleccionado|no se (?:ha seleccionado|eligi[óo]) ning[úu]n archivo|未[选選]择(?:任何)?文件|ファイルが選択されていません|선택된 파일 없음/giu;

/**
 * Required markers are presentation, not part of the trigger's name: BambooHR
 * (2026-09-15 live) renders its only human-facing trigger as `Choose File*`.
 * 浏览器的空状态提示同理——见上。
 */
function normalizeTriggerName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(NATIVE_FILE_EMPTY_STATE, ' ')
    .replace(/[*✱✦※•·❋✳︎✴︎✷✸]+/gu, ' ')
    .replace(/\s+/g, ' ')
    // 句末的标点不是名字的一部分（2026-09-28 Valve：「Choose files. No files chosen.」剥掉空状态后剩「Choose files. .」）。
    .replace(/[\s.:。…]+$/u, '')
    .trim();
}

/** 求职信上传栏自己的按钮名（2026-09-27）：「Cover Letter」「Attach cover letter」「Upload your cover letter」。 */
const COVER_LETTER_TRIGGER_NAME =
  /^(?:(?:attach|upload|choose|browse|select|add)\s+(?:a\s+|your\s+)?)?(?:cover[-_\s]*letter|motivation(?:al)?[-_\s]*letter)$/iu;

function hasFileTriggerName(value: string): boolean {
  const name = normalizeTriggerName(value);
  // 2026-09-28 通用路：德文、法文、西文的上传按钮名（Hochladen、Parcourir、Adjuntar……）。
  if (/^(?:attach|upload|hochladen|durchsuchen|anh[äa]ngen|parcourir|joindre|t[ée]l[ée]charger|adjuntar|subir|examinar|cargar|上传|添付)$/iu.test(name)) return true;
  // 重音在第一个 e 上（Rippling 的 `Résumé`，见 dict/guards.ts `RESUME_FILE` 头注）。
  if (/\br[ée]sum[eé](?!\p{L})|\bcv\b|curriculum ?vitae|\bcurr[íi]cul(?:um|o)(?!\p{L})|lebenslauf|hoja de vida|简历|履歴書|이력서/iu.test(name)) return true;
  if (
    /^(?:datei(?:en)?|lebenslauf)\s+(?:ausw[äa]hlen|hochladen|anh[äa]ngen|w[äa]hlen)$|^(?:choisir|s[ée]lectionner|joindre|t[ée]l[ée]charger)\s+(?:un\s+|le\s+|votre\s+)?(?:fichier|cv)$|^(?:seleccionar|elegir|adjuntar|subir|cargar)\s+(?:un\s+|el\s+|tu\s+|su\s+)?(?:archivo|cv|curr[íi]culum)$/iu.test(name)
  ) {
    return true;
  }
  if (
    /(?:^|\s)(?:attach|upload|choose|browse|select)\s+(?:a\s+)?(?:files?|r[ée]sum[eé]|cv)\s*$/iu.test(
      name,
    )
  ) {
    return true;
  }
  // Dropzone prompts are the human-facing surface of a hidden native file
  // control: "Drop or select (.doc / .docx / .pdf)" (Rippling), "Drag and drop
  // file or browse computer" (Dover), "Choose file or drag and drop here"
  // (Workable) — all 2026-09-15 live.
  if (
    /\bdrag\b.{0,12}\bdrop\b|\bdrop\b.{0,24}\b(?:select|browse|choose|upload|files?)\b|\bbrowse\b.{0,12}\b(?:computer|files?|device)\b/iu.test(
      name,
    )
  ) {
    return true;
  }
  return /(?:上传|选择|浏览)(?:文件|简历|履歴書|이력서)$|履歴書.*添付$/i.test(name);
}

function deniesFileTriggerName(value: string): boolean {
  return /\b(?:do not|don't|never)\s+(?:attach|upload|choose|browse|select)\b|(?:请勿|不要|禁止).{0,8}(?:上传|选择|浏览|添付)/i.test(
    value.normalize('NFKC').replace(/\s+/g, ' ').trim(),
  );
}

/**
 * Stable vendor hooks allowed to provide positive resume identity.
 *
 * Must stay a superset of what `engine.ts` plans with: the planner approved
 * Rippling's input through `data-testid="input-resume"` (its `name` is empty
 * and its id positional), and until 2026-09-15 this list lacked that hook, so
 * the runner refused the very target the preview showed and aborted the whole
 * run with IDENTITY_CHANGED before writing a byte.
 */
function filePositiveIdentities(element: Element): ReadonlyArray<string | null | undefined> {
  return [
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('data-automation-id'),
    element.getAttribute('data-ui'),
    element.getAttribute('data-qa'),
    element.getAttribute('data-testid'),
  ];
}

/** Classes and every data hook are useful vetoes, but never positive proof. */
function fileNegativeIdentities(element: Element): ReadonlyArray<string | null | undefined> {
  return [
    ...filePositiveIdentities(element),
    element.getAttribute('class'),
    ...[...element.attributes]
      .filter((attribute) => attribute.name.toLowerCase().startsWith('data-'))
      .map((attribute) => attribute.value),
  ];
}

function canUseNativeFileAsOwnTrigger(element: HTMLInputElement): boolean {
  if (!hasRenderedTriggerBox(element)) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const transform = style?.transform?.trim().toLowerCase();
  const translate = style?.translate?.trim().toLowerCase();
  const scale = style?.scale?.trim().toLowerCase();
  if (
    (transform && transform !== 'none') ||
    (translate && translate !== 'none') ||
    (scale && scale !== 'none')
  ) {
    return false;
  }
  if (style?.position === 'fixed') {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    if (rect.bottom <= 0 || (view && rect.top >= view.innerHeight)) return false;
  }
  return true;
}

/**
 * Native file controls are commonly hidden behind a styled label or button.
 * For this control type, the human-facing trigger is the visibility proof;
 * the input's own geometry and viewport position are not safety signals.
 *
 * A file honeypot would first have to positively identify itself as a resume
 * upload to reach this path. Text controls keep their stricter geometry guard
 * unchanged because bots can and do get trapped by writing profile text there.
 */
function hasVisibleFileTrigger(element: HTMLInputElement, root: ScanRoot, purpose: FileTargetPurpose = 'resume'): boolean {
  // 否决词按用途（2026-09-27）：简历栏旁说到求职信、成绩单……不算；求职信栏旁说到简历或别的附件不算。
  const vetoes = (name: string, identities: ReadonlyArray<string | null | undefined> = []): boolean =>
    purpose === 'cover-letter'
      ? namesNonCoverLetterUpload(name) || identities.some((identity) => (identity ? namesNonCoverLetterUpload(identity) : false))
      : isNonResumeFileField(name, identities);
  const triggerNamed = (name: string): boolean =>
    hasFileTriggerName(name) || (purpose === 'cover-letter' && COVER_LETTER_TRIGGER_NAME.test(normalizeTriggerName(name)));
  const associated = associatedFileLabels(element);
  const candidates = new Set<Element>();
  for (const label of associated) {
    if (isRootDescendant(label, root)) candidates.add(label);
  }

  // Do not search a whole form: an unrelated Submit button must never make a
  // hidden upload look human-operable. Only the input's own field container
  // may contribute a non-submitting button, and only when that container has
  // no second file control the generic button could belong to.
  //
  // 2026-09-15 live shapes this must reach: BambooHR nests its "Choose File"
  // button two levels below the input's container; Dover's trigger is the
  // react-dropzone root itself (`div[role=button]` wrapping the hidden input),
  // with no `<button>` anywhere.
  let container: Element | null = element.parentElement;
  for (let depth = 0; container && depth < FILE_TRIGGER_CONTAINER_MAX_DEPTH; depth += 1) {
    if (!isRootDescendant(container, root)) break;
    if (fileInputsWithin(container).some((candidate) => candidate !== element)) break;
    if (isDropzoneSurface(container)) candidates.add(container);
    if (depth === 0) {
      for (const button of container.querySelectorAll('button, [role="button"]')) {
        if (button.localName === 'button' && (button as HTMLButtonElement).type !== 'button') continue;
        candidates.add(button);
      }
    }
    container = container.parentElement;
  }

  // A negative signal on any associated candidate wins over every positive
  // candidate. Otherwise a visible "Attach resume" button could launder an
  // equally explicit "For robots only" label on the same control.
  if (
    [...associated, ...candidates].some((candidate) => {
      const name = semanticTriggerName(candidate);
      const identities = fileNegativeIdentities(candidate);
      return (
        deniesFileTriggerName(name) ||
        vetoes(name, identities) ||
        isHoneypot({ text: name, identities })
      );
    })
  ) {
    return false;
  }

  // A normally rendered native file picker includes its own browser-provided
  // button and is therefore a trigger. Zero geometry fails closed: this path
  // runs after layout, and treating 0×0 as "test environment unknown" would
  // turn a production-hidden field into an approved target. Transformed or
  // permanently off-screen fixed controls need separate human-facing proof.
  if (canUseNativeFileAsOwnTrigger(element)) return true;

  return [...candidates].some((candidate) => {
    const name = readableTriggerName(candidate, root);
    return (
      !root.isExcluded(candidate) &&
      candidate.getAttribute('aria-disabled')?.toLowerCase() !== 'true' &&
      !candidate.matches(':disabled') &&
      name !== '' &&
      triggerNamed(name) &&
      !vetoes(name) &&
      !isHoneypot({ text: name }) &&
      hasRenderedTriggerBox(candidate)
    );
  });
}

function fileTargetText(element: HTMLInputElement, label: string): string {
  return [
    label,
    ariaLabelledByText(element),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    ariaDescriptionText(element),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function fileTargetLabelText(
  element: HTMLInputElement,
  root: ScanRoot,
  includeExcluded: boolean,
): string {
  return associatedFileLabels(element)
    .filter((label) => includeExcluded || isRootDescendant(label, root))
    .map((label) => label.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter((label) => label !== '')
    .join(' ');
}

function hasExactFile(element: HTMLInputElement, file: File): boolean {
  return element.files?.length === 1 && element.files[0] === file;
}

/** `type="File"` (Rippling, 2026-09-15 live) is still a file control; compare the reflected property. */
function fileInputsWithin(scope: Element): HTMLInputElement[] {
  return [...scope.querySelectorAll('input')].filter(
    (candidate): candidate is HTMLInputElement =>
      candidate instanceof HTMLInputElement && candidate.type === 'file',
  );
}

/**
 * The react-dropzone root shape: a wrapper the human clicks or drops on.
 *
 * A button-role wrapper, or (2026-09-28, PostHog's required resume) react-dropzone's default root: a
 * keyboard-focusable `div[role=presentation][tabindex=0]` around the hidden input. A focusable wrapper
 * with no role, or `role=presentation|none`, is the widget a person operates; any other role is some other
 * widget. It is only ever a *candidate*: it still has to render, carry an upload prompt of its own
 * (`hasFileTriggerName`), hold no second file control and pass every veto.
 */
function isDropzoneSurface(element: Element): boolean {
  if (element.localName === 'button') return (element as HTMLButtonElement).type === 'button';
  const role = element.getAttribute('role')?.trim().toLowerCase() ?? '';
  if (role === 'button') return true;
  if (role !== '' && role !== 'presentation' && role !== 'none') return false;
  const tabindex = Number.parseInt(element.getAttribute('tabindex') ?? '', 10);
  return Number.isInteger(tabindex) && tabindex >= 0;
}

/** How far above the input a dropzone surface or a preceding heading may sit. */
const FILE_TRIGGER_CONTAINER_MAX_DEPTH = 2;

/** Longer text is a paragraph or a whole section, not this field's label. */
const FILE_CONTEXT_MAX_PIECE_LENGTH = 120;

/** How many siblings in one direction still count as "adjacent". */
const FILE_CONTEXT_MAX_SIBLINGS = 3;

function normalizeContextText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** A button-like element's name proves a human can operate it, never what the field is. */
function isTriggerLike(element: Element): boolean {
  return (
    element.localName === 'button' ||
    element.localName === 'a' ||
    element.getAttribute('role')?.trim().toLowerCase() === 'button'
  );
}

/**
 * Readable text of a sibling: text nodes plus the prompt a prompt-bearing
 * control shows in place of text (Jobvite's paste textarea). With
 * `excludeTriggers`, button-like descendants contribute nothing, so their
 * names can veto a target but never vouch for it (the S0 "generic upload
 * beside an Attach resume button" contract).
 */
function contextTextOf(node: Node, excludeTriggers: boolean): string {
  const pieces: string[] = [];
  const visit = (current: Node): void => {
    if (current.nodeType === 3) {
      pieces.push(current.textContent ?? '');
      return;
    }
    if (current.nodeType !== 1) return;
    const element = current as Element;
    if (['script', 'style', 'template', 'noscript'].includes(element.localName)) return;
    if (excludeTriggers && isTriggerLike(element)) return;
    if (element.localName === 'textarea' || element.localName === 'input') {
      pieces.push(element.getAttribute('placeholder') ?? '', element.getAttribute('aria-label') ?? '');
      return;
    }
    for (const child of element.childNodes) visit(child);
  };
  visit(node);
  return normalizeContextText(pieces.join(' '));
}

export interface FileFieldContext {
  /** Text allowed to establish a resume identity. */
  readonly positive: string;
  /** Everything read while collecting `positive`; may only veto. */
  readonly veto: string;
}

/**
 * The nearest adjacent prose in one direction: skips trigger-only siblings on
 * the way to a heading or label, but keeps everything it skipped as veto text.
 */
function nearestSiblingContext(node: Node, direction: 'previous' | 'next'): FileFieldContext {
  const veto: string[] = [];
  let sibling = direction === 'previous' ? node.previousSibling : node.nextSibling;
  for (let seen = 0; sibling && seen < FILE_CONTEXT_MAX_SIBLINGS; sibling = direction === 'previous' ? sibling.previousSibling : sibling.nextSibling) {
    if (sibling.nodeType === 1 && fileInputsWithin(sibling as Element).length > 0) break;
    const all = contextTextOf(sibling, false);
    if (all === '') continue;
    seen += 1;
    veto.push(all);
    const positive = contextTextOf(sibling, true);
    if (positive !== '') return { positive, veto: veto.join(' ') };
  }
  return { positive: '', veto: veto.join(' ') };
}

/**
 * Bounded nearby context of a file control: its accessible names, the nearest
 * preceding heading / label / section text at each of a few ancestor levels,
 * and the adjacent prose inside its own container.
 *
 * Why (2026-09-15 live): the human-facing name of a resume dropzone is
 * regularly not in any `<label>` for the input. Dover writes `Resume *` as a
 * sibling two levels up and labels the dropzone "Drag and drop file or browse
 * computer"; BambooHR labels both uploads `file-input` and says `Resume*` in
 * the section above; Jobvite labels both `File` and only the paste textarea
 * beside each one says "…your Resume here" / "…your Cover Letter here";
 * Rippling names the field `Résumé` through the wrapping label's
 * `aria-labelledby`.
 *
 * Bounds keep this a field's context rather than a page's: at most four
 * ancestor levels, never past an ancestor that holds a second file control,
 * only the nearest prose-bearing preceding sibling per level, following
 * siblings only inside the input's own container, and no piece longer than a
 * label. Headings follow their fields nowhere, so a following sibling further
 * up would name the *next* field.
 */
/**
 * 往上一层，必要时跨过 shadow 边界。
 *
 * `parentElement` 到了 shadow root 就是 null，祖先链当场断掉，外面那些说明
 * 「这是简历栏」的文字一个也读不到。
 *
 * 2026-09-17 实测 BambooHR 八个页面：inventory 报 `shadowRoots: 1`，那个 file
 * input 没有 name、没有 id，aria-label 是通用的 `file-input`，能证明它是简历栏的
 * `Resume*` 在 shadow 之外。于是每页填了 139 个字段，而唯一的必填项——简历——
 * 一个都没填（必填 0/10），整份申请交不出去。
 *
 * 跨法与本文件 `isRootDescendant` 一致：先 parentElement，没有就取 shadow host。
 */
function climbPastShadow(node: Element): Element | null {
  return node.parentElement ?? ((node.parentNode as Partial<ShadowRoot> | null)?.host ?? null);
}

export function nearbyFileContext(element: HTMLInputElement, root: ScanRoot): FileFieldContext {
  const positive: string[] = [];
  const veto: string[] = [];
  const push = (context: FileFieldContext): void => {
    if (context.positive !== '' && context.positive.length <= FILE_CONTEXT_MAX_PIECE_LENGTH) {
      positive.push(context.positive);
    }
    if (context.veto !== '') veto.push(context.veto);
  };
  const own = (value: string | null): void => {
    const text = normalizeContextText(value);
    push({ positive: text, veto: text });
  };
  own(ariaLabelledByText(element));
  own(element.getAttribute('aria-label'));
  own(element.getAttribute('title'));
  own(element.getAttribute('placeholder'));
  for (const label of associatedFileLabels(element)) {
    own(label.textContent);
    own(ariaLabelledByText(label));
  }

  let node: Element = element;
  for (let depth = 0; depth < fileContextMaxDepth(); depth += 1) {
    const scope = climbPastShadow(node);
    if (!scope || root.isExcluded(scope)) break;
    if (fileInputsWithin(scope).some((candidate) => candidate !== element)) break;
    push(nearestSiblingContext(node, 'previous'));
    if (depth === 0) push(nearestSiblingContext(node, 'next'));
    node = scope;
  }
  return { positive: positive.join(' '), veto: veto.join(' ') };
}

/**
 * Nearby context may only *add* a resume identity, and only when nothing read
 * along the way names another upload (cover letter, transcript, the vendor's
 * own "autofill from resume" parser…). It never overrides the control's own
 * label or hooks in either direction.
 */
export function hasResumeFileContext(element: HTMLInputElement, root: ScanRoot): boolean {
  const context = nearbyFileContext(element, root);
  return isResumeFileField(context.positive) && !isNonResumeFileField(context.veto);
}

/**
 * The host took the file: after our change event it renders the attached
 * file's name inside the field's own container (Rippling and Dover replace
 * the dropzone with a filename chip within a task, BambooHR and Greenhouse
 * do so synchronously). Checked only inside the bounded container, never on
 * the page, so an unrelated mention of the filename cannot vouch for a write.
 */
function hostShowsAttachedFileName(container: Element | null, file: File): boolean {
  if (!container || !container.isConnected) return false;
  const name = normalizeContextText(file.name);
  if (name === '') return false;
  return normalizeContextText(container.textContent).includes(name);
}

/** The input's own field container: the nearest bounded ancestor holding no second file control. */
function fileFieldContainer(element: HTMLInputElement, root: ScanRoot): Element | null {
  let container: Element | null = null;
  let node: Element = element;
  for (let depth = 0; depth < fileContextMaxDepth(); depth += 1) {
    const scope = node.parentElement;
    if (!scope || root.isExcluded(scope)) break;
    if (fileInputsWithin(scope).some((candidate) => candidate !== element)) break;
    container = scope;
    node = scope;
  }
  return container;
}

/**
 * 宿主**稍后**才显示它收下的那个文件（2026-09-28 通用路：Hetzner 的 Flow.js 在 change 里收下文件、清空 input，
 * 传完才把文件名写进这一栏；Shopify 那张 Ashby 的表也是清空再异步显示）。写之前调用：先记下这一栏自己的容器
 * （写完之后 input 可能已被宿主换掉），返回的函数只回答一件事——那个容器里此刻有没有这个文件名。与同一拍里
 * `hostShowsAttachedFileName` 同一个判据，只在这一栏自己的有界容器里找，页面别处提到这个文件名不算。
 */
export function watchHostFileAdoption(element: HTMLInputElement, root: ScanRoot, file: File): () => boolean {
  const container = fileFieldContainer(element, root);
  return () => hostShowsAttachedFileName(container, file);
}

/** 规则声明的上传部件根：从文件框往上最近的那一个，在扫描根里，里面只有这一个文件框。认不出就是 null。 */
function declaredUploadContainer(element: HTMLInputElement, root: ScanRoot, binding: FileUploadBinding): Element | null {
  let container: Element | null;
  try {
    container = element.closest(binding.containerSelector);
  } catch {
    return null;
  }
  if (container === null || !isRootDescendant(container, root)) return null;
  return fileInputsWithin(container).every((candidate) => candidate === element) ? container : null;
}

/**
 * 规则声明的上传部件说「收下了这一份」（2026-09-28 Workday 的简历栏，adobe.wd5 实测）：宿主在 change 里拿走文件、清空
 * 文件框，随即在部件里列出这一份（`itemSelector`，名字在 `itemNameSelector`），传完再给它挂上自己的「传好了」标记
 * （`successSelector`）；测试台上从 change 到标记出现约 0.6 秒。
 *
 * 写之前调用：定下部件根，记下此刻「名字就是这一份、带着标记」的有几项。返回的函数只回答一件事：这样的项是不是比写之前
 * 多了——也就是这一次挂上的这一份，宿主列出来了、而且说传好了。名字要逐字相同（折叠空白之后），只在这个部件里面找；
 * 部件根认不出、选择器坏了、一项里的名字元素不止一个，一律答「没有」（照旧记「网站没确认」）。
 */
export function watchDeclaredUpload(element: HTMLInputElement, root: ScanRoot, binding: FileUploadBinding, file: File): () => boolean {
  // 与同一拍里看文件名（`hostShowsAttachedFileName`）同一个口径：折叠空白，大小写照原样。
  const name = normalizeContextText(file.name);
  const captured = declaredUploadContainer(element, root, binding);
  if (captured === null || name === '') return () => false;
  const confirmedItems = (container: Element): number | null => {
    try {
      let count = 0;
      for (const item of container.querySelectorAll(binding.itemSelector)) {
        const names = item.querySelectorAll(binding.itemNameSelector);
        if (names.length !== 1 || normalizeContextText(names[0]!.textContent) !== name) continue;
        if (item.querySelector(binding.successSelector) !== null) count += 1;
      }
      return count;
    } catch {
      return null;
    }
  };
  const before = confirmedItems(captured);
  if (before === null) return () => false;
  return () => {
    // 宿主整个重画了部件：文件框还在就按同一条规则再认一次它的部件根。
    const container = captured.isConnected ? captured : element.isConnected ? declaredUploadContainer(element, root, binding) : null;
    if (container === null) return false;
    const now = confirmedItems(container);
    return now !== null && now > before;
  };
}

/** 恰好一个文件，名字、大小、类型与我们写进去的那一份逐项相同，而且仍合 accept。 */
function holdsEquivalentFile(element: HTMLInputElement, file: File): boolean {
  const held = element.files?.length === 1 ? element.files[0] : undefined;
  return held !== undefined &&
    held.name === file.name &&
    held.size === file.size &&
    held.type === file.type &&
    matchesFileAccept(element.getAttribute('accept') ?? '', held);
}

/** The pre-write state is known to be empty, so a synchronous host reaction is safe to unwind. */
function tryRestoreEmptyFileList(element: HTMLInputElement): void {
  try {
    element.files = new DataTransfer().files;
  } catch {
    // The runner keeps an Undo ticket if our exact File remains reachable.
  }
}

export function hasSafeResumeFileIdentity(element: HTMLInputElement, root: ScanRoot): boolean {
  // The reflected `type`, not an attribute selector: Rippling (2026-09-15
  // live) spells it `type="File"`. Membership is `isExcluded` (see
  // readableTriggerName): the deep scan already found this element once.
  if (element.type !== 'file' || !element.isConnected || root.isExcluded(element)) {
    return false;
  }
  const label = fileTargetLabelText(element, root, true);
  const text = fileTargetText(element, label);
  const identities = fileNegativeIdentities(element);
  if (isNonResumeFileField(text, identities)) return false;
  if (
    isHoneypot({
      text,
      identities,
    })
  ) {
    return false;
  }
  return true;
}

/**
 * 只判**身份**：这个控件还是不是我们批准过的那个简历上传目标。
 *
 * 单独导出是因为 `isApprovedResumeFileTarget` 把三件事塌成一个布尔——身份、
 * disabled、可见触发器。runner 需要区分：身份漂了是**页面级**信号（页面可能
 * 重渲染，整轮保守停手）；后两个只说明"这一栏现在用不了"，与其他字段无关。
 * 混在一起会让一个藏起来的上传控件把整页字段废成 ABORTED（2026-08-21 实测：
 * Lever 形状损失 7 项，Greenhouse 形状只损失 1 项，仅因 DOM 顺序不同）。
 */
export function hasApprovedResumeFileIdentity(element: HTMLInputElement, root: ScanRoot): boolean {
  if (!hasSafeResumeFileIdentity(element, root)) return false;
  const label = fileTargetLabelText(element, root, false);
  if (isResumeFileField(label, filePositiveIdentities(element))) return true;
  return hasResumeFileContext(element, root);
}

/** Final live-target proof, repeated after every asynchronous file read. */
export function isApprovedResumeFileTarget(element: HTMLInputElement, root: ScanRoot): boolean {
  return (
    hasApprovedResumeFileIdentity(element, root) &&
    !element.disabled &&
    !element.matches(':disabled') &&
    hasVisibleFileTrigger(element, root)
  );
}

/**
 * 求职信上传栏的身份（2026-09-27）：与简历那一套同一个形状——安全（是 file、在根里、不是蜜罐、没说到简历或别的附件）
 * ∧ 标签或稳定钩子正向认出求职信，或者有界的邻近上下文认出、且一路读到的文字没有说到简历或别的附件。
 */
export function hasSafeCoverLetterFileIdentity(element: HTMLInputElement, root: ScanRoot): boolean {
  if (element.type !== 'file' || !element.isConnected || root.isExcluded(element)) return false;
  const label = fileTargetLabelText(element, root, true);
  const text = fileTargetText(element, label);
  const identities = fileNegativeIdentities(element);
  if (namesNonCoverLetterUpload(text) || identities.some((identity) => identity ? namesNonCoverLetterUpload(identity) : false)) {
    return false;
  }
  return !isHoneypot({ text, identities });
}

export function hasCoverLetterFileContext(element: HTMLInputElement, root: ScanRoot): boolean {
  const context = nearbyFileContext(element, root);
  return isCoverLetterFileField(context.positive) && !namesNonCoverLetterUpload(context.veto);
}

export function hasApprovedCoverLetterFileIdentity(element: HTMLInputElement, root: ScanRoot): boolean {
  if (!hasSafeCoverLetterFileIdentity(element, root)) return false;
  const label = fileTargetLabelText(element, root, false);
  if (isCoverLetterFileField(label, filePositiveIdentities(element))) return true;
  return hasCoverLetterFileContext(element, root);
}

/** Final live-target proof for a cover letter upload, repeated after every asynchronous read. */
export function isApprovedCoverLetterFileTarget(element: HTMLInputElement, root: ScanRoot): boolean {
  return (
    hasApprovedCoverLetterFileIdentity(element, root) &&
    !element.disabled &&
    !element.matches(':disabled') &&
    hasVisibleFileTrigger(element, root, 'cover-letter')
  );
}

/** 按用途取那三道判据：身份、可写目标、写后仍安全。 */
export function fileTargetChecks(purpose: FileTargetPurpose = 'resume'): Readonly<{
  approvedIdentity: (element: HTMLInputElement, root: ScanRoot) => boolean;
  approvedTarget: (element: HTMLInputElement, root: ScanRoot) => boolean;
  safeIdentity: (element: HTMLInputElement, root: ScanRoot) => boolean;
}> {
  return purpose === 'cover-letter'
    ? { approvedIdentity: hasApprovedCoverLetterFileIdentity, approvedTarget: isApprovedCoverLetterFileTarget, safeIdentity: hasSafeCoverLetterFileIdentity }
    : { approvedIdentity: hasApprovedResumeFileIdentity, approvedTarget: isApprovedResumeFileTarget, safeIdentity: hasSafeResumeFileIdentity };
}

export function attachHostFile(
  input: AttachHostFileInput,
): Result<AttachedFileConfirmation, AttachHostFileError> {
  const { element, file, root, authority, ticket, policy } = input;
  const checks = fileTargetChecks(input.purpose);

  // 顺序与 clickHostTarget 一致：便宜且不消耗授权的检查排在前面。
  if (!ticket.ok) return { ok: false, code: 'JOURNAL_UNAVAILABLE' };
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  if (!policy.capabilities[FILE_CAPABILITY]) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const access = checkActiveCapability(authority, FILE_CAPABILITY);
  if (!access.ok) return access;
  if (!element.isConnected) return { ok: false, code: 'DETACHED' };
  if (!checks.approvedTarget(element, root)) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }

  /**
   * **绝不覆盖用户已经挂上的文件。**
   *
   * 这是本模块最重要的一条，也是它与文本写入最大的不同：文本被覆盖了还能靠撤销
   * 日志还原，**文件覆盖没有撤销可言**——原来那个 File 对象在页面里已经没有引用，
   * 我们复原不出来。而用户很可能刚传了一份专门为这个岗位改过的简历。
   *
   * 所以这一条不看 `fillEmptyOnly` 开关，它是无条件的。
   */
  if ((element.files?.length ?? 0) > 0) return { ok: false, code: 'NOT_EMPTY' };

  const accept = element.getAttribute('accept') ?? '';
  if (!matchesFileAccept(accept, file)) return { ok: false, code: 'VALUE_COERCED' };
  // Captured before the write: a host may replace the input itself.
  const container = fileFieldContainer(element, root);

  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.files = transfer.files;
    if (!hasExactFile(element, file)) {
      tryRestoreEmptyFileList(element);
      return { ok: false, code: 'VALUE_COERCED' };
    }
  } catch {
    tryRestoreEmptyFileList(element);
    return { ok: false, code: 'VALUE_COERCED' };
  }

  try {
    for (const type of EVENT_PROFILES.file) dispatchHostEvent(element, type);
  } catch {
    tryRestoreEmptyFileList(element);
    return { ok: false, code: 'VALUE_COERCED' };
  }

  // The host received the File with the change event. Greenhouse (2026-09-10,
  // live) unmounts the input inside that same synchronous handler and renders a
  // filename/remove chip in its place: a detached input here is the host taking
  // the file, not losing it, and clearing a detached node's list takes nothing
  // back. A host that keeps the input may still have swapped its visible Attach
  // trigger; the trigger is write-time evidence that a human can operate this
  // field, not a post-write identity invariant.
  if (!element.isConnected) return { ok: true, value: 'host-adopted' };
  let postWriteFailure: AttachHostFileError | null = null;
  if (!checks.safeIdentity(element, root)) postWriteFailure = 'IDENTITY_CHANGED';
  else if (
    !matchesFileAccept(element.getAttribute('accept') ?? '', file) ||
    !hasExactFile(element, file)
  ) {
    postWriteFailure = 'VALUE_COERCED';
  }
  if (postWriteFailure) {
    // A host that re-renders or clears the input while already showing the
    // attached file's name in this field has taken the file; that is the
    // detached-input case above with the node left in place, not a lost or
    // coerced write. There is no readable control left, so it stays unverified.
    if (hostShowsAttachedFileName(container, file)) return { ok: true, value: 'host-adopted' };
    // 宿主把我们的文件换成它自己新建的 File 对象（2026-09-28 Shopify 那张 Ashby 的表：同名、同大小、同类型，
    // 只是对象不同）：这一栏里仍是这一份文件，只是我们不再拥有那个对象——收下了，不可读回、不可撤销（unverified）。
    if (postWriteFailure === 'VALUE_COERCED' && holdsEquivalentFile(element, file)) return { ok: true, value: 'host-adopted' };
    tryRestoreEmptyFileList(element);
    return { ok: false, code: postWriteFailure };
  }
  // The input is still here, its identity has not drifted, and `hasExactFile`
  // just proved our exact File object is the one in `files`. That IS the
  // readback for a file control; report it rather than discarding it.
  return { ok: true, value: 'readback' };
}

/** Restore only the exact in-memory File this session attached. */
export function clearHostFile(input: ClearHostFileInput): Result<void, ClearHostFileError> {
  const { element, expectedFile, authority } = input;
  const access = checkActiveCapability(authority, FILE_CAPABILITY);
  if (!access.ok) return access;
  if (!element.isConnected) return { ok: false, code: 'DETACHED' };
  if (element.type !== 'file') return { ok: false, code: 'IDENTITY_CHANGED' };
  if (element.files?.length !== 1 || element.files[0] !== expectedFile) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }

  try {
    element.files = new DataTransfer().files;
  } catch {
    return { ok: false, code: 'VALUE_COERCED' };
  }
  if ((element.files?.length ?? 0) !== 0) return { ok: false, code: 'VALUE_COERCED' };
  for (const type of EVENT_PROFILES.file) dispatchHostEvent(element, type);
  if ((element.files?.length ?? 0) !== 0) return { ok: false, code: 'VALUE_COERCED' };
  return { ok: true, value: undefined };
}
