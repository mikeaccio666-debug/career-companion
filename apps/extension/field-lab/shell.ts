export const FIELD_LAB_ADAPTER_UNAVAILABLE = 'FIELD_LAB_ADAPTER_UNAVAILABLE' as const;

export type FieldLabStageId =
  | 'discovery'
  | 'compiler'
  | 'classification'
  | 'writer'
  | 'terminal';

export type FieldLabStageSnapshot = Readonly<{
  id: FieldLabStageId;
  state: string;
  detail: string;
}>;

type RunFieldLabProbes = () => Promise<readonly FieldLabStageSnapshot[]>;

const STAGES: readonly Readonly<{
  id: FieldLabStageId;
  eyebrow: string;
  title: string;
  initialState: string;
  description: string;
}>[] = Object.freeze([
  Object.freeze({
    id: 'discovery',
    eyebrow: 'UA-4 input',
    title: 'Certified discovery input',
    initialState: 'READY_TO_PROBE',
    description: 'The production path accepts certified UA-1 semantic epochs; this panel ships no page fixture.',
  }),
  Object.freeze({
    id: 'compiler',
    eyebrow: '#164',
    title: 'Unique semantic compiler',
    initialState: 'READY_TO_PROBE',
    description: 'Compiler ownership stays inside the production UA-4 composition runtime.',
  }),
  Object.freeze({
    id: 'classification',
    eyebrow: 'UA-4 classify',
    title: 'Question classification',
    initialState: 'READY_TO_PROBE',
    description: 'Classification stays inside the same compiler-owned production path.',
  }),
  Object.freeze({
    id: 'writer',
    eyebrow: 'UA-4 writer',
    title: 'Production writer boundary',
    initialState: 'READY_TO_PROBE',
    description: 'An explicit click calls the real runtime under its hard-disabled policy.',
  }),
  Object.freeze({
    id: 'terminal',
    eyebrow: 'UA-4 terminal',
    title: 'Terminal disposition ledger',
    initialState: 'READY_TO_PROBE',
    description: 'The disabled probe must stop before creating any disposition or ledger.',
  }),
]);

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

function badge(document: Document, text: string): HTMLElement {
  return node(document, 'span', 'fl-badge', text);
}

export function mountFieldLabShell(root: HTMLElement, runProbes: RunFieldLabProbes): void {
  const document = root.ownerDocument;
  const shell = node(document, 'div', 'fl-shell');

  const banner = node(document, 'div', 'fl-banner');
  banner.append(
    node(document, 'strong', 'fl-banner__label', 'DEV FIELD LAB'),
    node(document, 'span', 'fl-banner__copy', 'Unpacked development only'),
  );

  const header = node(document, 'header', 'fl-header');
  header.append(
    node(document, 'p', 'fl-eyebrow', 'Production-port composition preview'),
    node(document, 'h1', 'fl-title', 'EdAIX Field Lab'),
    node(
      document,
      'p',
      'fl-subtitle',
      'A value-free shell bound to the production UA-4 composition port. It is not an autofill engine.',
    ),
  );
  const badges = node(document, 'div', 'fl-badges');
  badges.append(
    badge(document, 'DEFAULT_OFF'),
    badge(document, 'NOT_RELEASED'),
    badge(document, 'NOT_E2E'),
    badge(document, 'ZERO_SUBMIT'),
  );
  header.append(badges);

  const content = node(document, 'div', 'fl-content');
  const inputCard = node(document, 'section', 'fl-card fl-input-card');
  inputCard.append(
    node(document, 'p', 'fl-eyebrow', 'Runtime authority boundary'),
    node(document, 'h2', 'fl-section-title', 'No product fixture is shipped'),
    node(
      document,
      'p',
      'fl-copy',
      'No page, profile, answer, candidate rule, authority, write plan, disposition or ledger is fabricated here.',
    ),
  );

  const stageSection = node(document, 'section', 'fl-stage-section');
  stageSection.append(
    node(document, 'h2', 'fl-section-title', 'One production UA-4 path, held at its default-off gate'),
  );
  const stageGrid = node(document, 'div', 'fl-stage-grid');
  const stateById = new Map<FieldLabStageId, HTMLElement>();
  const detailById = new Map<FieldLabStageId, HTMLElement>();
  for (const stage of STAGES) {
    const card = node(document, 'article', 'fl-card fl-stage-card');
    card.dataset.stageId = stage.id;
    const heading = node(document, 'div', 'fl-stage-heading');
    heading.append(
      node(document, 'span', 'fl-eyebrow', stage.eyebrow),
      node(document, 'h3', 'fl-stage-title', stage.title),
    );
    const state = node(document, 'p', 'fl-stage-state', stage.initialState);
    const detail = node(document, 'p', 'fl-copy', stage.description);
    stateById.set(stage.id, state);
    detailById.set(stage.id, detail);
    card.append(heading, state, detail);
    stageGrid.append(card);
  }
  stageSection.append(stageGrid);

  const actions = node(document, 'section', 'fl-actions');
  const button = node(document, 'button', 'fl-button', 'Probe production UA-4 boundary');
  button.type = 'button';
  const status = node(document, 'p', 'fl-status', 'No probe has run.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(button, status);

  const artifacts = node(document, 'section', 'fl-card');
  artifacts.append(
    node(document, 'p', 'fl-eyebrow', 'Artifact availability'),
    node(document, 'h2', 'fl-section-title', 'Field Lab is physically isolated'),
  );
  const artifactList = node(document, 'ul', 'fl-artifact-list');
  for (const item of [
    'Field Lab unpacked build — INCLUDED',
    'Default Extension build — EXCLUDED',
    'Store Extension build — EXCLUDED',
  ]) artifactList.append(node(document, 'li', 'fl-artifact-item', item));
  artifacts.append(artifactList);

  content.append(inputCard, stageSection, actions, artifacts);
  const footer = node(
    document,
    'footer',
    'fl-footer',
    'No host writes · No production activation · Submit remains human-only',
  );
  shell.append(banner, header, content, footer);
  root.replaceChildren(shell);

  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = 'Checking the production default-off boundary…';
    void runProbes().then((snapshots) => {
      const expected = new Set(STAGES.map((stage) => stage.id));
      if (
        snapshots.length !== expected.size ||
        snapshots.some((snapshot) => !expected.delete(snapshot.id)) ||
        expected.size !== 0
      ) throw new Error('FIELD_LAB_ADAPTER_SET_INVALID');
      for (const snapshot of snapshots) {
        stateById.get(snapshot.id)!.textContent = snapshot.state;
        detailById.get(snapshot.id)!.textContent = snapshot.detail;
      }
      status.textContent = 'Production UA-4 boundary held DEFAULT_OFF with zero host calls.';
    }).catch(() => {
      status.textContent = FIELD_LAB_ADAPTER_UNAVAILABLE;
    }).finally(() => {
      button.disabled = false;
    });
  });
}
