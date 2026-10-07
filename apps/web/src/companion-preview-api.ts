import { COMPANION_INK_TOKENS, type CompanionDraftAccepted, type CompanionDraftEntryState,
  type CompanionDraftRequest, type PublicCompanionPreview } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';

function invalid(): never { throw new Error('主理人的生成进度暂时无法确认，请重新读取。'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(value)?.[0] !== value) invalid(); return value;
}
function integer(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(); return value as number; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function member<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) invalid(); return value as T; }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16 * 1024
    || /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) invalid(); return value;
}
function preview(value: unknown): PublicCompanionPreview {
  const data = record(value, ['taskId', 'companionId', 'revision', 'generatedBy', 'summary', 'samples', 'inkToken']);
  if (data.revision !== 1 || !Array.isArray(data.samples) || Object.getPrototypeOf(data.samples) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(data.samples);
  if (descriptors.length?.value !== 3 || Reflect.ownKeys(data.samples).some(key => !['0', '1', '2', 'length'].includes(key as string))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor)) || ['0', '1', '2'].some(key => !descriptors[key]?.enumerable)) invalid();
  const summary = text(data.summary), samples = Object.freeze(['0', '1', '2'].map(key => text(descriptors[key].value)) as [string, string, string]);
  if (new TextEncoder().encode(JSON.stringify({ summary, samples })).byteLength > 16 * 1024) invalid();
  return Object.freeze({ taskId: uuid(data.taskId), companionId: uuid(data.companionId), revision: 1,
    generatedBy: member(data.generatedBy, ['model', 'fallback']), summary, samples, inkToken: member(data.inkToken, COMPANION_INK_TOKENS) });
}
/** Shape validation only. Authorization and model/cost receipts remain server responsibilities. */
export function parseCompanionDraftEntry(value: unknown): CompanionDraftEntryState {
  // Read descriptors before the discriminant so untrusted accessors cannot run.
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const discriminator = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!discriminator || !('value' in discriminator)) invalid();
  if (discriminator.value === 'intake_required') { record(value, ['kind']); return Object.freeze({ kind: 'intake_required' }); }
  if (discriminator.value === 'not_prepared') {
    const data = record(value, ['kind', 'intakeRevision', 'generationAvailable']);
    return Object.freeze({ kind: 'not_prepared', intakeRevision: integer(data.intakeRevision, 1), generationAvailable: boolean(data.generationAvailable) });
  }
  if (discriminator.value === 'generation') {
    const data = record(value, ['kind', 'taskId', 'companionId', 'generation', 'status', 'hold']);
    const generation = integer(data.generation), status = member(data.status, ['pending', 'running', 'failed', 'interrupted', 'uncertain']);
    if (status === 'running' && generation === 0) invalid();
    const hold = data.hold === null ? null : member(data.hold, ['authorization_required', 'configuration_unavailable', 'requires_review']);
    return Object.freeze({ kind: 'generation', taskId: uuid(data.taskId), companionId: uuid(data.companionId), generation, status, hold });
  }
  if (discriminator.value === 'preview') { const data = record(value, ['kind', 'preview']); return Object.freeze({ kind: 'preview', preview: preview(data.preview) }); }
  return invalid();
}
export async function readCompanionDraftEntry(client: BoundPlatformClient, signal?: AbortSignal): Promise<CompanionDraftEntryState> {
  const data = record(await client.request('/companion/drafts/current', { signal }), ['entry']); return parseCompanionDraftEntry(data.entry);
}
export async function acceptCompanionDraft(client: BoundPlatformClient, input: CompanionDraftRequest, signal?: AbortSignal): Promise<CompanionDraftAccepted> {
  const command = record(input, ['operationId', 'expectedRevision']), operationId = uuid(command.operationId), expectedRevision = integer(command.expectedRevision, 1);
  const data = record(await client.request('/companion/drafts', { method: 'POST', body: JSON.stringify({ operationId, expectedRevision }), signal }), ['entry', 'operation']);
  const entry = parseCompanionDraftEntry(data.entry), operation = record(data.operation, ['id', 'replayed']);
  if (uuid(operation.id) !== operationId || !['generation', 'preview'].includes(entry.kind)) invalid();
  return Object.freeze({ entry, operation: Object.freeze({ id: operationId, replayed: boolean(operation.replayed) }) });
}

export interface CompanionPreviewObservation {
  readonly entry: CompanionDraftEntryState | null;
  readonly checking: boolean;
  readonly error: string;
}
export interface CompanionPreviewObserverEnvironment {
  now(): number;
  isVisible(): boolean;
  isOnline(): boolean;
  operationId(): string;
  setTimer(run: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}
const defaultEnvironment: CompanionPreviewObserverEnvironment = {
  now: () => Date.now(), isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false, operationId: () => crypto.randomUUID(),
  setTimer: (run, delay) => setTimeout(run, delay), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
/** Account-bound transport observation. A browser abort never claims to cancel the accepted server task. */
export class CompanionPreviewObserver {
  private client: BoundPlatformClient;
  private intakeRevision: number;
  private changed: (state: CompanionPreviewObservation) => void;
  private environment: CompanionPreviewObserverEnvironment;
  private live = false;
  private epoch = 0;
  private request: AbortController | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private command: CompanionDraftRequest | null = null;
  private nextAllowedAt = 0;
  private snapshot: CompanionPreviewObservation = { entry: null, checking: false, error: '' };
  constructor(client: BoundPlatformClient, intakeRevision: number,
    changed: (state: CompanionPreviewObservation) => void, environment = defaultEnvironment) {
    this.client = client; this.intakeRevision = intakeRevision; this.changed = changed; this.environment = environment;
  }
  private current(epoch: number) { return this.live && this.epoch === epoch && this.client.isCurrent(); }
  private publish(patch: Partial<CompanionPreviewObservation>) { this.snapshot = { ...this.snapshot, ...patch }; this.changed(this.snapshot); }
  private clearTimer() { if (this.timer !== null) this.environment.clearTimer(this.timer); this.timer = null; }
  private schedule(delay: number) {
    this.clearTimer();
    if (!this.live || !this.client.isCurrent() || !this.environment.isVisible() || !this.environment.isOnline()) return;
    const epoch = this.epoch;
    this.timer = this.environment.setTimer(() => { this.timer = null; if (this.current(epoch)) this.refresh(); }, Math.min(24 * 60 * 60_000, Math.max(0, delay)));
  }
  start() {
    if (this.live) return;
    this.live = true; this.epoch++;
    this.unsubscribe = this.client.subscribe(() => {
      if (!this.client.isCurrent()) { this.stop(); this.publish({ entry: null, checking: false, error: '' }); }
    });
    this.refresh();
  }
  stop() {
    this.live = false; this.epoch++; this.request?.abort(); this.request = null;
    this.clearTimer(); this.unsubscribe?.(); this.unsubscribe = null;
  }
  /** Visible/online transitions only resume observation; they cannot retry a failed model execution. */
  resume() {
    this.clearTimer();
    this.refresh();
  }
  refresh() {
    if (!this.live || this.request || !this.client.isCurrent() || !this.environment.isOnline() || !this.environment.isVisible()) return;
    const delay = this.nextAllowedAt - this.environment.now();
    if (delay > 0) { this.schedule(delay); return; }
    this.clearTimer(); const epoch = this.epoch, request = new AbortController(); this.request = request;
    this.publish({ checking: true, error: '' });
    void this.observe(epoch, request);
  }
  private async observe(epoch: number, request: AbortController) {
    let retryRead = false;
    const valid = () => this.current(epoch) && !request.signal.aborted;
    try {
      let entry = await readCompanionDraftEntry(this.client, request.signal); if (!valid()) return;
      this.publish({ entry });
      if (entry.kind === 'not_prepared' && entry.generationAvailable && this.command === null) {
        if (entry.intakeRevision !== this.intakeRevision) { this.publish({ error: '回答的进度已更新，请重新读取初见进度。' }); return; }
        // Capture once before dispatch; StrictMode restart and lost confirmations must not create another intent.
        this.command = Object.freeze({ operationId: this.environment.operationId(), expectedRevision: entry.intakeRevision });
        try {
          const result = await acceptCompanionDraft(this.client, this.command, request.signal); if (!valid()) return;
          entry = result.entry; this.publish({ entry });
        } catch (error) {
          if (!valid()) return;
          if (error instanceof ApiError && error.status === 429) throw error;
          // A POST failure says nothing about acceptance. Read the durable state before presenting failure.
          entry = await readCompanionDraftEntry(this.client, request.signal); if (!valid()) return;
          this.publish({ entry, error: entry.kind === 'not_prepared' ? '这一步暂时没有确认完成。你的回答已经保存，可以重新读取进度。' : '' });
        }
      } else if (entry.kind === 'not_prepared' && this.command !== null) {
        this.publish({ error: '这一步暂时没有确认完成。你的回答已经保存，可以重新读取进度。' });
      }
      this.nextAllowedAt = 0;
    } catch (error) {
      if (!valid()) return;
      if (error instanceof ApiError && error.status === 429) {
        const reported = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs! >= 0 ? error.retryAfterMs! : 0;
        this.nextAllowedAt = this.environment.now() + Math.max(60_000, Math.min(Number.MAX_SAFE_INTEGER - this.environment.now(), reported));
        retryRead = true;
        this.publish({ error: this.snapshot.entry?.kind === 'generation' && this.snapshot.entry.hold !== null
          ? '暂时读取得太频繁了。稍后可以重新读取进度。' : '暂时读取得太频繁了。稍后会重新确认进度。' });
      } else this.publish({ error: '生成进度暂时无法读取。你的回答已经保存，请稍后重新读取。' });
    } finally {
      if (valid() && this.request === request) {
        this.request = null; this.publish({ checking: false });
        const entry = this.snapshot.entry;
        if (!(entry?.kind === 'generation' && entry.hold !== null)
          && (retryRead || entry?.kind === 'generation' && ['pending', 'running'].includes(entry.status))) this.schedule(Math.max(3_000, this.nextAllowedAt - this.environment.now()));
      }
    }
  }
}
