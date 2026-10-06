import {
  PRODUCT_PANEL_VIEW_MODEL_INVALID,
  summarizeProductPanel,
  validateProductPanelViewModel,
  type ProductPanelEntryState,
  type ProductPanelQuestion,
  type ProductPanelQuestionStatus,
  type ProductPanelSummary,
  type ProductPanelViewModel,
} from './model';
import {
  createContinueIntentGate,
  normalizeProductPanelIntentResult,
  reduceProductPanelState,
  type ProductPanelContinueIntent,
  type ProductPanelIntentResult as ProductPanelIntentResultFromState,
  type ProductPanelState,
} from './state';
import type { PilotUa5ReadinessStatus } from '../lib/pilotUa5ConnectedProtocol';

export type ProductPanelIntentResult = ProductPanelIntentResultFromState;

export const PRODUCT_PANEL_PROTOTYPE_MARKER = 'product-panel/interaction-prototype' as const;

export type ProductPanelStartIntent = Readonly<{ kind: 'START_AUTOFILL' }>;
export type ProductPanelUndoIntent = Readonly<{
  kind: 'UNDO_FIELD';
  runId: string;
  questionId: string;
}>;
export type ProductPanelEntryTarget =
  | 'CURRENT_JOB'
  | 'AUTOFILL_INFORMATION'
  | 'RESUME'
  | 'COVER_LETTER';
export type ProductPanelEntryIntent = Readonly<{
  kind: 'OPEN_ENTRY';
  target: ProductPanelEntryTarget;
}>;

export type ProductPanelViewAdapter = Readonly<{
  getSnapshot(): ProductPanelViewModel;
  getReadiness?(): PilotUa5ReadinessStatus;
  subscribe(listener: (model: ProductPanelViewModel) => void): () => void;
  requestStartAutofill(
    intent: ProductPanelStartIntent,
  ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
  requestContinue(
    intent: ProductPanelContinueIntent,
  ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
  requestOpenEntry(
    intent: ProductPanelEntryIntent,
  ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
  requestUndoField?(
    intent: ProductPanelUndoIntent,
  ): ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
}>;

export type ProductPanelMountOptions = Readonly<{
  reducedMotion?: boolean;
  presentation?: 'PROTOTYPE' | 'CONNECTED';
  /** Explicit unit-test seam. Production must omit this predicate. */
  testOnlyIsTrustedUserAction?: (event: MouseEvent) => boolean;
}>;

export type ProductPanelDestroyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: 'PRODUCT_PANEL_UNSUBSCRIBE_FAILED' }>;

export type ProductPanelMount = Readonly<{
  /** Start the run the panel's own button starts, for a gesture made on the
   *  in-page panel and already checked where it happened. */
  startFromPageGesture(): void;
  destroy(): ProductPanelDestroyResult;
}>;

const STATUS_LABELS: Readonly<Record<ProductPanelQuestionStatus, string>> = Object.freeze({
  PREFILLED: 'Already complete',
  FILLED: 'Filled and verified',
  AI_SUGGESTED: 'Suggestion ready for review',
  USER_CONFIRMATION_REQUIRED: 'Your confirmation needed',
  MANUAL_REQUIRED: 'Complete manually',
  POLICY_BLOCKED: 'Held by a safety check',
  DISCOVERY_INCOMPLETE: 'Not reached on this page',
});

const STATUS_GLYPHS: Readonly<Record<ProductPanelQuestionStatus, string>> = Object.freeze({
  PREFILLED: '✓',
  FILLED: '✓',
  AI_SUGGESTED: '✦',
  USER_CONFIRMATION_REQUIRED: '!',
  MANUAL_REQUIRED: '↗',
  POLICY_BLOCKED: '×',
  DISCOVERY_INCOMPLETE: '…',
});

const ENTRY_CONFIG = Object.freeze([
  ['autofillInformation', 'Saved applicant data', 'AUTOFILL_INFORMATION', 'open-autofill-information'],
  ['resume', 'Résumé source', 'RESUME', 'open-resume'],
  ['coverLetter', 'Letter source', 'COVER_LETTER', 'open-cover-letter'],
] as const);

const ENTRY_PREVIEW_COPY: Readonly<Record<
  ProductPanelEntryTarget,
  Readonly<{ title: string; copy: string }>
>> = Object.freeze({
  CURRENT_JOB: Object.freeze({
    title: 'Application overview destination',
    copy: 'This interaction seam is ready for a connected job-details view. Page text is intentionally excluded from this prototype.',
  }),
  AUTOFILL_INFORMATION: Object.freeze({
    title: 'Applicant data destination',
    copy: 'This interaction seam is ready for a connected applicant-data view. Personal values are intentionally excluded from this prototype.',
  }),
  RESUME: Object.freeze({
    title: 'Résumé destination preview',
    copy: 'This interaction seam is ready for a connected résumé workflow. Document content is intentionally excluded from this prototype.',
  }),
  COVER_LETTER: Object.freeze({
    title: 'Letter destination preview',
    copy: 'This interaction seam is ready for a connected letter workflow. Document content is intentionally excluded from this prototype.',
  }),
});

const ENTRY_STATE_LABELS: Readonly<Record<ProductPanelEntryState, string>> = Object.freeze({
  READY: 'Ready',
  NEEDS_ATTENTION: 'Needs attention',
  UNAVAILABLE: 'Not added',
});

function node<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function summarySentence(summary: ProductPanelSummary): string {
  if (summary.continuation?.status === 'SCANNING') return 'Scanning the current page…';
  if (summary.continuation?.status === 'UNAVAILABLE') return 'Current page observation unavailable';
  if (summary.continuation?.status === 'SCANNED') return `${summary.wizard?.currentStep ? `Scanned step ${summary.wizard.currentStep.stepIndex + 1} · ` : ''}${summary.continuation.scan.observedControls} controls observed · read-only`;
  if (summary.wizard) return `${summary.wizard.checkpoints.length} steps recorded locally`;
  if (summary.phase === 'OBSERVED') {
    return `${summary.observedControls ?? 0} controls observed`;
  }
  if (summary.phase === 'COMPOSED') {
    return `${summary.detected} questions recognized`;
  }
  return summary.discoveryComplete === false
    ? `Required completion: ${summary.requiredFilled}/${summary.requiredTotal} observed verified`
    : `Required completion: ${summary.requiredFilled}/${summary.requiredTotal} verified`;
}

function progressDetail(summary: ProductPanelSummary): string {
  if (summary.wizard) return summary.wizard.currentStep
    ? `Scanned step ${summary.wizard.currentStep.stepIndex + 1} · current-step completion unknown`
    : 'Local step history · current-step identity and completion unknown';
  if (summary.continuation !== undefined) return 'Page identity unverified · current-page completion unknown';
  if (summary.phase === 'OBSERVED') return `${summary.observedControls ?? 0} controls observed`;
  if (summary.phase === 'COMPOSED') {
    return `${summary.detected} questions recognized · ${summary.authorizedQuestions ?? 0} authorized`;
  }
  return summary.discoveryComplete === false
    ? `${summary.detected} observed questions settled · page not fully observed`
    : `${summary.detected} questions settled`;
}

/**
 * The percentage is over the OBSERVED required questions. When the page was not
 * fully observed it must say so in the same breath, or "100%" reads as the
 * whole page.
 */
function percentageCopy(summary: ProductPanelSummary): string {
  return summary.discoveryComplete === false
    ? `${summary.requiredPercentage}% of observed`
    : `${summary.requiredPercentage}%`;
}

function incompleteCopy(summary: ProductPanelSummary): string {
  const regions = summary.unobservedRegions;
  return regions > 0
    ? `Page not fully observed: ${regions} ${regions === 1 ? 'region' : 'regions'} could not be scanned`
    : 'Page not fully observed: some questions were not reached';
}

function isCompletedStatus(status: ProductPanelQuestionStatus): boolean {
  return status === 'FILLED' || status === 'PREFILLED';
}

function renderPrototypeNotice(document: Document): HTMLElement {
  const notice = node(document, 'div', 'pp-prototype-notice');
  notice.append(
    node(document, 'strong', 'pp-prototype-notice__title', 'Interaction prototype'),
    node(
      document,
      'span',
      'pp-prototype-notice__copy',
      'Visual design pending · Connected destinations are placeholders',
    ),
  );
  return notice;
}

const READINESS_COPY: Readonly<Record<PilotUa5ReadinessStatus, string>> = Object.freeze({
  USER_ACTION_REQUIRED: 'Click the EdAIX extension icon on this page, then click Begin assisted fill.',
  SITE_ACCESS_REQUIRED: 'Allow EdAIX access to this site in Chrome, then try again.',
  CHECKING: 'Checking the local API, EdAIX sign-in, current page, and test authorization…',
  API_UNREACHABLE: 'The local EdAIX API is not reachable on localhost:3000.',
  AUTH_REQUIRED: 'Sign in and connect this extension to EdAIX before continuing.',
  PAGE_NOT_REGISTERED: 'Open or refresh a supported Greenhouse application page, then try again.',
  LIVE_WRITE_NOT_AUTHORIZED: 'This is not an authorized EdAIX test page. No fields will be changed.',
  PROFILE_UNAVAILABLE: 'Your saved applicant profile is unavailable for this test.',
  RECOVERY_REQUIRED: 'The run was interrupted after writing. Check the application page and edit any affected fields there.',
  READY: 'This authorized test page is ready for assisted fill.',
});

function renderConnectedNotice(
  document: Document,
  readiness: PilotUa5ReadinessStatus,
): HTMLElement {
  const notice = node(document, 'div', 'pp-prototype-notice');
  notice.append(
    node(document, 'strong', 'pp-prototype-notice__title', 'Connected test readiness'),
    node(document, 'span', 'pp-prototype-notice__copy', READINESS_COPY[readiness]),
  );
  return notice;
}

function intentFailureCopy(code: string): string {
  if (code in READINESS_COPY) {
    return READINESS_COPY[code as PilotUa5ReadinessStatus];
  }
  return 'This action is not available in the current connected test build.';
}

function renderHeader(document: Document): HTMLElement {
  const header = node(document, 'header', 'pp-header');
  const titleGroup = node(document, 'div', 'pp-header__titles');
  titleGroup.append(
    node(document, 'p', 'pp-eyebrow', 'EdAIX application helper'),
    node(document, 'h1', 'pp-title', 'Current application'),
  );
  header.append(titleGroup);
  return header;
}

type EntryRequest = (
  button: HTMLButtonElement,
  status: HTMLElement,
  preview: HTMLElement,
  intent: ProductPanelEntryIntent,
  label: string,
) => void;

function renderEntries(
  document: Document,
  model: ProductPanelViewModel,
  openEntry: EntryRequest,
  preview: HTMLElement,
  readiness: PilotUa5ReadinessStatus | null,
): HTMLElement {
  const section = node(document, 'section', 'pp-section pp-materials');
  const title = node(document, 'h2', 'pp-section__title', 'Application resources');
  title.id = 'product-panel-materials-title';
  section.setAttribute('aria-labelledby', title.id);
  const list = node(document, 'ul', 'pp-entry-list');
  const status = node(document, 'p', 'pp-action-status');
  status.dataset.productPanelEntryStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  for (const [key, label, target, actionName] of ENTRY_CONFIG) {
    const item = node(document, 'li', 'pp-entry-item');
    const button = node(document, 'button', 'pp-entry');
    button.type = 'button';
    button.dataset.action = actionName;
    if (readiness !== null && readiness !== 'READY') button.disabled = true;
    const copy = node(document, 'div', 'pp-entry__copy');
    copy.append(
      node(document, 'span', 'pp-entry__label', label),
      node(document, 'span', 'pp-entry__state', ENTRY_STATE_LABELS[model.entries[key]]),
    );
    button.append(copy, node(document, 'span', 'pp-entry__action', 'Open'));
    button.addEventListener('click', () => openEntry(
      button,
      status,
      preview,
      { kind: 'OPEN_ENTRY', target },
      label,
    ));
    item.append(button);
    list.append(item);
  }
  section.append(title, list, status);
  return section;
}

function renderHome(
  document: Document,
  model: ProductPanelViewModel,
  state: ProductPanelState,
  start: (button: HTMLButtonElement, status: HTMLElement, event: MouseEvent) => void,
  openEntry: EntryRequest,
  expand: () => void,
  readiness: PilotUa5ReadinessStatus | null,
): HTMLElement {
  const content = node(document, 'div', 'pp-content');
  content.setAttribute('aria-labelledby', 'product-panel-job-title');
  const entryPreview = node(document, 'section', 'pp-card pp-entry-preview');
  entryPreview.hidden = true;
  entryPreview.setAttribute('role', 'region');
  entryPreview.setAttribute('aria-labelledby', 'product-panel-entry-preview-title');
  const job = node(document, 'section', 'pp-card pp-job');
  const jobHeading = node(document, 'div', 'pp-job__heading');
  const title = node(document, 'h2', 'pp-section__title', 'Application overview');
  title.id = 'product-panel-job-title';
  const currentJobAction = node(document, 'button', 'pp-icon-button', 'Open details');
  currentJobAction.type = 'button';
  currentJobAction.dataset.action = 'open-current-job';
  if (readiness !== null && readiness !== 'READY') currentJobAction.disabled = true;
  const currentJobStatus = node(document, 'p', 'pp-action-status');
  currentJobStatus.dataset.productPanelEntryStatus = '';
  currentJobStatus.setAttribute('role', 'status');
  currentJobStatus.setAttribute('aria-live', 'polite');
  currentJobStatus.setAttribute('aria-atomic', 'true');
  jobHeading.append(title, node(
    document,
    'span',
    'pp-entry__state',
    ENTRY_STATE_LABELS[model.entries.currentJob],
  ));
  job.append(
    jobHeading,
    node(document, 'p', 'pp-copy', 'Review what the assistant can handle safely for this application.'),
    currentJobAction,
    currentJobStatus,
  );
  currentJobAction.addEventListener('click', () => openEntry(
    currentJobAction,
    currentJobStatus,
    entryPreview,
    { kind: 'OPEN_ENTRY', target: 'CURRENT_JOB' },
    'Application overview',
  ));
  const action = node(
    document,
    'button',
    'pp-button pp-button--primary',
    model.run === null ? 'Begin assisted fill' : 'Review assisted-fill activity',
  );
  action.type = 'button';
  action.dataset.action = model.run === null ? 'start-autofill' : 'expand-autofill-home';
  if (
    model.run === null &&
    readiness === 'CHECKING'
  ) action.disabled = true;
  if (model.run !== null) {
    action.setAttribute('aria-expanded', 'false');
    action.setAttribute('aria-controls', 'product-panel-autofill-details');
  }
  action.addEventListener('click', (event) => {
    if (model.run === null) start(action, status, event);
    else expand();
  });
  const status = node(document, 'p', 'pp-action-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  job.append(action, status);
  content.append(job, renderEntries(document, model, openEntry, entryPreview, readiness), entryPreview);
  const safety = node(
    document,
    'p',
    'pp-safety-note',
    'Review every answer on the application page. Submission always stays with you.',
  );
  content.append(safety);
  if (state.kind === 'AUTOFILL_STICKY_COLLAPSED') {
    const controlled = node(document, 'section', 'pp-visually-hidden');
    controlled.id = 'product-panel-autofill-details';
    controlled.hidden = true;
    content.append(controlled);
  }
  return content;
}

function animateVerifiedCheck(icon: HTMLElement, reducedMotion: boolean): void {
  if (reducedMotion || typeof icon.animate !== 'function') return;
  try {
    icon.animate(
      [
        { opacity: 0.35, transform: 'scale(0.72)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  } catch {
    icon.dataset.motionState = 'ANIMATION_UNAVAILABLE';
  }
}

function renderQuestionGroup(
  document: Document,
  titleText: string,
  questions: readonly ProductPanelQuestion[],
  animatedQuestionIds: ReadonlySet<string>,
  reducedMotion: boolean,
  connected: boolean,
): HTMLElement {
  const section = node(document, 'section', 'pp-question-group');
  const title = node(document, 'h3', 'pp-question-group__title', titleText);
  section.setAttribute('aria-labelledby', `${titleText.toLowerCase()}-questions-title`);
  title.id = `${titleText.toLowerCase()}-questions-title`;
  const list = node(document, 'ul', 'pp-question-list');
  for (const [index, question] of questions.entries()) {
    const item = node(document, 'li', 'pp-question');
    if (connected) {
      item.dataset.status = isCompletedStatus(question.status) ? 'SUCCESS' : 'MANUAL_REVIEW';
    } else {
      item.dataset.questionId = question.id;
      item.dataset.status = question.status;
    }
    const icon = node(
      document,
      'span',
      'pp-question__icon',
      connected
        ? isCompletedStatus(question.status) ? '✓' : '–'
        : STATUS_GLYPHS[question.status],
    );
    icon.setAttribute('aria-hidden', 'true');
    const copy = node(document, 'div', 'pp-question__copy');
    if (connected) {
      copy.append(node(document, 'span', 'pp-question__label', 'Recognized'));
    } else {
      copy.append(
        node(document, 'span', 'pp-question__label', `${titleText} question ${index + 1}`),
        node(document, 'span', 'pp-question__requirement', titleText),
      );
    }
    const status = node(
      document,
      'span',
      'pp-question__status',
      connected
        ? question.writeEffect === 'MAY_HAVE_CHANGED' ? 'Failed — check page'
          : isCompletedStatus(question.status) ? 'Success' : 'Manual review'
        : STATUS_LABELS[question.status],
    );
    item.append(icon, copy, status);
    list.append(item);
    if (
      isCompletedStatus(question.status) &&
      animatedQuestionIds.has(question.id)
    ) animateVerifiedCheck(icon, reducedMotion);
  }
  section.append(title, list);
  return section;
}

function renderProgress(
  document: Document,
  model: ProductPanelViewModel,
  summary: ProductPanelSummary,
  animatedQuestionIds: ReadonlySet<string>,
  reducedMotion: boolean,
  presentation: 'PROTOTYPE' | 'CONNECTED',
  collapse: () => void,
  continueIntent: (
    button: HTMLButtonElement,
    status: HTMLElement,
    intent: ProductPanelContinueIntent,
    event: MouseEvent,
  ) => void,
): HTMLElement {
  const content = node(document, 'div', 'pp-content pp-content--progress');
  const panel = node(document, 'section', 'pp-card pp-progress');
  panel.id = 'product-panel-autofill-details';
  panel.dataset.panel = 'autofill-details';
  panel.setAttribute('aria-labelledby', 'product-panel-progress-title');
  const heading = node(document, 'div', 'pp-progress__heading');
  const titles = node(document, 'div', 'pp-progress__titles');
  const title = node(document, 'h2', 'pp-section__title', 'Assisted-fill activity');
  title.id = 'product-panel-progress-title';
  title.tabIndex = -1;
  titles.append(
    title,
    node(document, 'p', 'pp-copy', progressDetail(summary)),
  );
  const collapseButton = node(document, 'button', 'pp-icon-button', 'Collapse');
  collapseButton.type = 'button';
  collapseButton.dataset.action = 'collapse-autofill';
  collapseButton.setAttribute('aria-expanded', 'true');
  collapseButton.setAttribute('aria-controls', panel.id);
  collapseButton.addEventListener('click', collapse);
  heading.append(titles, collapseButton);

  const metrics = node(document, 'div', 'pp-metrics');
  const sentence = node(document, 'strong', 'pp-metrics__sentence', summarySentence(summary));
  const progress = node(document, 'progress', 'pp-progress-bar');
  progress.max = summary.requiredTotal;
  progress.setAttribute('value', String(summary.requiredFilled));
  progress.setAttribute(
    'aria-label',
    summary.discoveryComplete === false
      ? `Required completion: ${summary.requiredFilled}/${summary.requiredTotal} observed verified; page not fully observed`
      : `Required completion: ${summary.requiredFilled}/${summary.requiredTotal} verified`,
  );
  metrics.append(sentence);
  if (summary.continuation !== undefined) {
    if (summary.continuation.status === 'SCANNED') {
      const scan = summary.continuation.scan;
      metrics.append(node(document, 'p', 'pp-copy',
        `${scan.hiddenNotObservedCount} hidden controls not observed · ${scan.unobservedRegions} regions not observed`));
      if (!scan.structureAvailable) metrics.append(node(document, 'p', 'pp-copy', 'Page structure unavailable'));
    }
    metrics.append(node(document, 'p', 'pp-copy', 'No filling occurred during this scan.'));
  } else if (summary.wizard) {
    metrics.append(node(document, 'p', 'pp-copy', 'Recorded steps do not establish the whole application’s completion.'));
  } else if (summary.phase !== 'SETTLED') {
    metrics.append(node(
      document,
      'span',
      'pp-copy',
      'Required completion will appear after the run settles',
    ));
  } else if (summary.requiredTotal > 0) {
    metrics.append(
      node(document, 'span', 'pp-metrics__percentage', percentageCopy(summary)),
      progress,
    );
  } else {
    metrics.append(node(document, 'span', 'pp-copy', 'No required questions detected'));
  }
  if (summary.continuation === undefined && summary.phase === 'SETTLED' && summary.discoveryComplete === false) {
    const incomplete = node(document, 'p', 'pp-copy pp-metrics__incomplete', incompleteCopy(summary));
    incomplete.dataset.completeness = 'INCOMPLETE';
    metrics.append(incomplete);
  }

  const groups = node(document, 'div', 'pp-question-groups');
  if (summary.wizard && summary.wizard.checkpoints.length > 0) {
    const history = node(document, 'section', 'pp-question-groups');
    history.dataset.resultScope = 'LOCAL_STEP_HISTORY';
    history.append(node(document, 'h3', 'pp-section__title', 'Local step history'));
    for (const checkpoint of summary.wizard.checkpoints) {
      const step = node(document, 'section', 'pp-question-groups');
      step.append(node(document, 'h4', 'pp-section__title', `Step ${checkpoint.stepIndex + 1}`));
      step.append(node(document, 'p', 'pp-copy', checkpoint.discoveryComplete
        ? 'Observed at the time of this run'
        : `Not fully observed · ${checkpoint.unobservedRegions.length} regions not observed`));
      step.append(renderQuestionGroup(document, 'Required', checkpoint.requiredDispositions.map((row, order) => ({
        id: row.questionId, order, requirement: 'REQUIRED' as const, status: row.disposition.state,
        ...('writeEffect' in row.disposition ? { writeEffect: row.disposition.writeEffect } : {}),
      })), new Set<string>(), true, presentation === 'CONNECTED'));
      history.append(step);
    }
    groups.append(history);
  }
  if (summary.continuation !== undefined) {
    groups.dataset.resultScope = 'HISTORY';
    groups.append(node(document, 'h3', 'pp-section__title', 'Previous run'),
      node(document, 'p', 'pp-copy', 'These results describe the earlier run and do not establish the current page’s completion.'));
  }
  if (summary.phase === 'SETTLED') {
    groups.append(
      ...(summary.wizard?.checkpoints.length ? [] : [renderQuestionGroup(
        document,
        'Required',
        summary.required,
        animatedQuestionIds,
        reducedMotion,
        presentation === 'CONNECTED',
      )]),
      renderQuestionGroup(
        document,
        'Optional',
        summary.optional,
        animatedQuestionIds,
        reducedMotion,
        presentation === 'CONNECTED',
      ),
    );
  } else {
    groups.append(node(document, 'p', 'pp-copy', 'Question results will appear after the run settles.'));
  }
  panel.append(heading, metrics, groups);
  if (presentation === 'CONNECTED' && summary.phase === 'SETTLED') {
    panel.append(node(document, 'p', 'pp-copy',
      'Review the application page before submitting. Edit fields there; to replace an uploaded résumé, use the page’s file control if available.'));
  }

  const actionStatus = node(document, 'p', 'pp-action-status');
  actionStatus.setAttribute('role', 'status');
  actionStatus.setAttribute('aria-live', 'polite');
  actionStatus.setAttribute('aria-atomic', 'true');
  if (
    model.run?.continueIntent !== null &&
    model.run !== null
  ) {
    const button = node(document, 'button', 'pp-button pp-button--secondary', presentation === 'CONNECTED' ? 'Continue: scan current page' : 'Continue to next page');
    button.type = 'button';
    button.dataset.action = 'continue-next-page';
    const intent: ProductPanelContinueIntent = {
      kind: 'CONTINUE_TO_NEXT_PAGE',
      runId: model.run.id,
      intentId: model.run.continueIntent.intentId,
    };
    button.addEventListener('click', (event) => continueIntent(button, actionStatus, intent, event));
    if (presentation === 'CONNECTED') panel.append(node(document, 'p', 'pp-copy',
      'If the application has another step, open it on the application page, then continue here to observe it.'));
    panel.append(button, actionStatus);
  } else {
    actionStatus.textContent = 'No next-page action is available.';
    panel.append(actionStatus);
  }
  content.append(
    panel,
    node(
      document,
      'p',
      'pp-safety-note',
      'Passwords, verification, consent, human checks, and final submission stay on the application page.',
    ),
  );
  return content;
}

function renderStickySummary(
  document: Document,
  summary: ProductPanelSummary,
  expand: () => void,
): HTMLElement {
  const footer = node(document, 'footer', 'pp-sticky-summary');
  const button = node(document, 'button', 'pp-sticky-summary__button');
  button.type = 'button';
  button.dataset.action = 'expand-autofill';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'product-panel-autofill-details');
  const copy = node(document, 'span', 'pp-sticky-summary__copy');
  copy.append(
    node(document, 'strong', 'pp-sticky-summary__title', summarySentence(summary)),
    node(
      document,
      'span',
      'pp-sticky-summary__meta',
      summary.wizard !== undefined
        ? progressDetail(summary)
        : summary.continuation !== undefined
        ? 'Page identity unverified · completion unknown'
        : summary.phase !== 'SETTLED'
        ? 'Run in progress'
        : summary.requiredTotal > 0
        ? summary.discoveryComplete === false
          ? `${summary.requiredPercentage}% of observed · page not fully observed`
          : `${summary.requiredPercentage}% complete`
        : summary.discoveryComplete === false
          ? 'No required questions observed · page not fully observed'
          : 'No required questions',
    ),
  );
  const chevron = node(document, 'span', 'pp-sticky-summary__chevron', '⌃');
  chevron.setAttribute('aria-hidden', 'true');
  button.append(copy, chevron);
  button.addEventListener('click', expand);
  footer.append(button);
  return footer;
}

export function mountProductPanel(
  root: HTMLElement,
  adapter: ProductPanelViewAdapter,
  options: ProductPanelMountOptions = {},
): ProductPanelMount {
  const document = root.ownerDocument;
  const reducedMotion = options.reducedMotion === true;
  const presentation = options.presentation ?? 'PROTOTYPE';
  const permitsUserAction = options.testOnlyIsTrustedUserAction ?? ((event: MouseEvent) =>
    event.isTrusted === true && document.defaultView?.navigator.userActivation?.isActive === true);
  const hasTrustedUserAction = (event: MouseEvent): boolean => {
    try {
      return permitsUserAction(event) === true;
    } catch {
      return false;
    }
  };
  const surface = node(document, 'div', 'pp-surface');
  const announcer = node(document, 'div', 'pp-visually-hidden');
  announcer.dataset.productPanelAnnouncer = '';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  root.replaceChildren(surface, announcer);
  let destroyed = false;
  let unsubscribed = false;
  let startPending = false;
  let currentModel: ProductPanelViewModel | null = null;
  let lastAcceptedRevision = -1;
  let latestEntryRequest = 0;
  let state: ProductPanelState = { kind: 'HOME' };
  let pendingFocus: 'PROGRESS_TITLE' | null = null;

  const continueGate = createContinueIntentGate(async (intent) =>
        normalizeProductPanelIntentResult(await adapter.requestContinue(intent)));

  function renderFailure(): void {
    const shell = node(document, 'div', 'pp-shell pp-shell--failed');
    if (presentation === 'PROTOTYPE') {
      shell.dataset.prototypeMarker = PRODUCT_PANEL_PROTOTYPE_MARKER;
    }
    shell.dataset.safetyContract = 'ZERO_SUBMIT';
    const error = node(document, 'p', 'pp-error', PRODUCT_PANEL_VIEW_MODEL_INVALID);
    error.setAttribute('role', 'alert');
    shell.append(
      presentation === 'CONNECTED'
        ? renderConnectedNotice(document, adapter.getReadiness?.() ?? 'API_UNREACHABLE')
        : renderPrototypeNotice(document),
      renderHeader(document),
      error,
    );
    surface.replaceChildren(shell);
    announcer.textContent = PRODUCT_PANEL_VIEW_MODEL_INVALID;
  }

  function expand(): void {
    if (currentModel?.run === null || currentModel === null) return;
    const result = reduceProductPanelState(state, {
      type: 'EXPAND_AUTOFILL',
      runId: currentModel.run.id,
    });
    if (!result.ok) return;
    state = result.state;
    render(undefined, 'PROGRESS_TITLE');
  }

  function collapse(): void {
    if (currentModel?.run === null || currentModel === null) return;
    const result = reduceProductPanelState(state, {
      type: 'COLLAPSE_AUTOFILL',
      runId: currentModel.run.id,
    });
    if (!result.ok) return;
    state = result.state;
    render(undefined, 'STICKY_SUMMARY');
  }

  function requestEntry(
    button: HTMLButtonElement,
    status: HTMLElement,
    preview: HTMLElement,
    intent: ProductPanelEntryIntent,
    label: string,
  ): void {
    const target = intent.target;
    const dispatchedIntent = Object.freeze({ kind: 'OPEN_ENTRY' as const, target });
    const requestGeneration = ++latestEntryRequest;
    for (const entryStatus of surface.querySelectorAll<HTMLElement>(
      '[data-product-panel-entry-status]',
    )) {
      entryStatus.textContent = '';
    }
    preview.hidden = true;
    preview.removeAttribute('data-entry-preview-target');
    preview.replaceChildren();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = `Preparing ${label}…`;
    let request: ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
    try {
      request = adapter.requestOpenEntry(dispatchedIntent);
    } catch {
      request = { ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' };
    }
    void Promise.resolve(request)
      .then(normalizeProductPanelIntentResult)
      .catch((): ProductPanelIntentResult => ({
        ok: false,
        code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
      }))
      .then((result) => {
        if (destroyed) return;
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
        if (requestGeneration !== latestEntryRequest || !root.contains(preview)) {
          if (status.textContent === `Preparing ${label}…`) status.textContent = '';
          return;
        }
        if (result.ok) {
          const previewCopy = ENTRY_PREVIEW_COPY[target];
          const title = node(document, 'h2', 'pp-section__title', previewCopy.title);
          title.id = 'product-panel-entry-preview-title';
          title.tabIndex = -1;
          const close = node(document, 'button', 'pp-icon-button', 'Close preview');
          close.type = 'button';
          close.dataset.action = 'close-entry-preview';
          close.addEventListener('click', () => {
            preview.hidden = true;
            preview.removeAttribute('data-entry-preview-target');
            preview.replaceChildren();
            status.textContent = `${label} preview closed.`;
            if (root.contains(button)) button.focus();
          });
          preview.dataset.entryPreviewTarget = target;
          preview.replaceChildren(
            title,
            node(document, 'p', 'pp-copy', previewCopy.copy),
            close,
          );
          preview.hidden = false;
          title.focus();
          status.textContent = `${label} preview opened.`;
        } else {
          status.textContent = presentation === 'CONNECTED'
            ? intentFailureCopy(result.code)
            : `Entry action unavailable. ${result.code}`;
        }
      });
  }

  function requestStart(
    button: HTMLButtonElement,
    status: HTMLElement,
    // 'PAGE_GESTURE' means the user pressed Autofill on the in-page panel. The
    // trusted-event check below guards this document's own button; that gesture
    // was checked where it happened, and the worker armed its one-shot lease
    // from it — which is the authority the run is admitted against either way.
    event: MouseEvent | 'PAGE_GESTURE',
  ): void {
    if (startPending || currentModel?.run !== null) return;
    if (presentation === 'CONNECTED' && event !== 'PAGE_GESTURE' && !hasTrustedUserAction(event)) {
      status.textContent = READINESS_COPY.USER_ACTION_REQUIRED;
      return;
    }
    startPending = true;
    pendingFocus = 'PROGRESS_TITLE';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = presentation === 'CONNECTED'
      ? 'Checking readiness…'
      : 'Preparing the functional preview…';
    let request: ProductPanelIntentResult | Promise<ProductPanelIntentResult>;
    try {
      request = adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    } catch {
      request = { ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' };
    }
    void Promise.resolve(request)
      .then(normalizeProductPanelIntentResult)
      .catch((): ProductPanelIntentResult => ({
        ok: false,
        code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
      }))
      .then((result) => {
        if (!result.ok && !destroyed) {
          pendingFocus = null;
          status.textContent = presentation === 'CONNECTED'
            ? intentFailureCopy(result.code)
            : 'The preview is unavailable. PRODUCT_PANEL_INTENT_UNAVAILABLE';
        }
      })
      .then(() => {
        startPending = false;
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
      });
  }

  function requestContinue(
    button: HTMLButtonElement,
    status: HTMLElement,
    intent: ProductPanelContinueIntent,
    event: MouseEvent,
  ): void {
    if (presentation === 'CONNECTED' && !hasTrustedUserAction(event)) {
      status.textContent = 'Click Continue to scan the current page. USER_ACTION_REQUIRED';
      return;
    }
    button.disabled = true;
    pendingFocus = 'PROGRESS_TITLE';
    button.setAttribute('aria-busy', 'true');
    status.textContent = presentation === 'CONNECTED' ? 'Scanning the current page…' : 'Sending one next-page intent…';
    void continueGate.dispatch(intent).then((result) => {
      if (!result.ok && result.code !== 'CONTINUE_INTENT_ALREADY_CONSUMED' && !destroyed) {
        pendingFocus = null;
        status.textContent = 'Next-page intent unavailable. CONTINUE_INTENT_UNAVAILABLE';
      }
      button.setAttribute('aria-busy', 'false');
    });
  }

  function render(
    animatedQuestionIds: ReadonlySet<string> = new Set<string>(),
    explicitFocus?: 'PROGRESS_TITLE' | 'STICKY_SUMMARY',
  ): void {
    if (destroyed || currentModel === null) return;
    const activeElement = root.contains(document.activeElement)
      ? document.activeElement as HTMLElement
      : null;
    const previousAction = activeElement?.dataset.action ?? null;
    const progressTitleHadFocus = activeElement?.id === 'product-panel-progress-title';
    const shell = node(document, 'div', 'pp-shell');
    if (presentation === 'PROTOTYPE') {
      shell.dataset.prototypeMarker = PRODUCT_PANEL_PROTOTYPE_MARKER;
    }
    shell.dataset.safetyContract = 'ZERO_SUBMIT';
    shell.append(
      presentation === 'CONNECTED'
        ? renderConnectedNotice(document, adapter.getReadiness?.() ?? 'API_UNREACHABLE')
        : renderPrototypeNotice(document),
      renderHeader(document),
    );
    if (state.kind === 'AUTOFILL_EXPANDED' && currentModel.run !== null) {
      shell.append(renderProgress(
        document,
        currentModel,
        summarizeProductPanel(currentModel),
        animatedQuestionIds,
        reducedMotion,
        presentation,
        collapse,
        requestContinue,
      ));
    } else {
      shell.append(renderHome(
        document,
        currentModel,
        state,
        requestStart,
        requestEntry,
        expand,
        presentation === 'CONNECTED'
          ? adapter.getReadiness?.() ?? 'API_UNREACHABLE'
          : null,
      ));
      if (state.kind === 'AUTOFILL_STICKY_COLLAPSED' && currentModel.run !== null) {
        shell.append(renderStickySummary(document, summarizeProductPanel(currentModel), expand));
      }
    }
    surface.replaceChildren(shell);
    const focusTarget = explicitFocus ?? pendingFocus;
    pendingFocus = null;
    if (focusTarget === 'PROGRESS_TITLE') {
      root.querySelector<HTMLElement>('#product-panel-progress-title')?.focus();
    } else if (focusTarget === 'STICKY_SUMMARY') {
      root.querySelector<HTMLElement>('[data-action="expand-autofill"]')
        ?.focus();
    } else if (previousAction !== null) {
      for (const candidate of root.querySelectorAll<HTMLElement>('[data-action]')) {
        if (candidate.dataset.action === previousAction) {
          candidate.focus();
          break;
        }
      }
    } else if (progressTitleHadFocus) {
      root.querySelector<HTMLElement>('#product-panel-progress-title')?.focus();
    }
  }

  function accept(candidate: unknown, initial: boolean): void {
    if (destroyed) return;
    const validation = validateProductPanelViewModel(candidate);
    if (!validation.ok) {
      pendingFocus = null;
      renderFailure();
      return;
    }
    if (validation.model.revision <= lastAcceptedRevision) return;
    lastAcceptedRevision = validation.model.revision;
    const previousModel = currentModel;
    const previousRunId = previousModel?.run?.id ?? null;
    const previousQuestions = new Map(
      (previousModel?.run?.id === previousRunId ? previousModel.run.questions : [])
        .map((question) => [question.id, question.status] as const),
    );
    currentModel = validation.model;
    if (currentModel.run === null) {
      state = { kind: 'HOME' };
      render();
      if (!initial) {
        announcer.textContent = `Activity update ${currentModel.revision}. No active assisted-fill run.`;
      }
      return;
    }
    if (initial || previousRunId !== currentModel.run.id) {
      state = { kind: 'AUTOFILL_EXPANDED', runId: currentModel.run.id };
      const animate = initial
        ? new Set<string>()
        : new Set(currentModel.run.questions
            .filter((question) => isCompletedStatus(question.status))
            .map((question) => question.id));
      render(animate);
      if (!initial) {
        announcer.textContent = `Activity update ${currentModel.revision}. ${summarySentence(
          summarizeProductPanel(currentModel),
        )}.`;
      }
      return;
    }
    const presented = reduceProductPanelState(state, {
      type: 'PRESENT_RUN',
      runId: currentModel.run.id,
    });
    if (presented.ok) state = presented.state;
    const animate = new Set(currentModel.run.questions
      .filter((question) =>
        isCompletedStatus(question.status) &&
        !isCompletedStatus(previousQuestions.get(question.id) ?? 'DISCOVERY_INCOMPLETE'))
      .map((question) => question.id));
    render(animate);
    if (!initial) {
      announcer.textContent = `Activity update ${currentModel.revision}. ${summarySentence(
        summarizeProductPanel(currentModel),
      )}.`;
    }
  }

  try {
    accept(adapter.getSnapshot(), true);
  } catch {
    renderFailure();
  }
  let unsubscribe = (): void => undefined;
  try {
    const subscribed = adapter.subscribe((model) => accept(model, false));
    if (typeof subscribed !== 'function') {
      renderFailure();
    } else {
      unsubscribe = subscribed;
    }
  } catch {
    renderFailure();
  }

  return Object.freeze({
    /** Start the same run the panel's own button starts, for a gesture made on
     *  the in-page panel. No-op when a run is already under way. */
    startFromPageGesture(): void {
      const button = root.querySelector('[data-action="start-autofill"]');
      const status = root.querySelector('.pp-action-status');
      if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;
      requestStart(button, status, 'PAGE_GESTURE');
    },
    destroy(): ProductPanelDestroyResult {
      destroyed = true;
      try {
        if (!unsubscribed) unsubscribe();
        unsubscribed = true;
        return { ok: true };
      } catch {
        return { ok: false, code: 'PRODUCT_PANEL_UNSUBSCRIBE_FAILED' };
      } finally {
        root.replaceChildren();
      }
    },
  });
}
