import type { AssistantPorts } from '../ports/assistant-ports';
import type { createAssistantStore, RequestScope } from '../state/store';
import type { AssistantData, AssistantState, CandidateField, Scene } from '../state/types';

export interface AssistantMotion {
  navigate(scene: Scene, commit: () => void, morph?: boolean): Promise<void>;
  visibility(open: boolean, commit: () => void): Promise<void>;
  chooseCard(accept: boolean): Promise<void>;
  enterCard(undoFrom?: boolean): void;
  extract(messageId: string): Promise<void>;
  candidate(cardId: string, messageId: string | null, fields: CandidateField[]): Promise<void>;
  saved(cardId: string): void;
  targetChanged(): void;
  scrollChat(): void;
}
export interface ControllerContext {
  readonly t: import('../i18n').Translator;
  readonly data: AssistantData;
  readonly ports: AssistantPorts;
  readonly store: ReturnType<typeof createAssistantStore<AssistantState>>;
  readonly state: AssistantState;
  motion: AssistantMotion | null;
  patch(patch: Partial<AssistantState> | ((state: AssistantState) => AssistantState), scope?: RequestScope): boolean;
  go(scene: Scene, morph?: boolean): Promise<void>;
  close(): Promise<void>;
  open(): Promise<void>;
  toast(message: string): void;
  nextId(prefix: string): string;
  afterRender(): Promise<void>;
}

export const isCurrent = (ctx: ControllerContext, scope: RequestScope) => !scope.signal.aborted && ctx.store.scope().epoch === scope.epoch;

/** Convert an unexpected adapter failure to a stable local result at the boundary. */
export async function portResult<T>(operation: () => Promise<import('../ports/assistant-ports').UiResult<T>>) {
  try { return await operation(); }
  catch { return { ok: false as const, code: 'UNAVAILABLE' as const }; }
}
