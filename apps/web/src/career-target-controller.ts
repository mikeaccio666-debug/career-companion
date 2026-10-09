import { parseCareerTargetCommand, type CareerTarget, type CareerTargetAction } from '@companion/platform-contracts';
import { readCareerTargets, changeCareerTarget, type CareerTargetClient } from './career-target-api.ts';
import { ApiError } from './api-error.ts';
export interface PendingTargetOperation {
    readonly action: CareerTargetAction;
    readonly id: string | null;
    readonly body: ReturnType<typeof parseCareerTargetCommand>;
}
export interface CareerTargetSnapshot {
    readonly targets: readonly Readonly<CareerTarget>[];
    readonly loaded: boolean;
    readonly busy: boolean;
    readonly suspended: boolean;
    readonly pending: Readonly<PendingTargetOperation> | null;
    readonly uncertain: boolean;
    readonly error: string;
    readonly notice: string;
    readonly settledOperationId: string | null;
}
export const emptyCareerTargets = (): CareerTargetSnapshot => Object.freeze({ targets: Object.freeze([]), loaded: false, busy: false, suspended: false, pending: null, uncertain: false, error: '', notice: '', settledOperationId: null });
export class CareerTargetController {
    private state = emptyCareerTargets();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: CareerTargetClient;
    private readonly changed: (s: CareerTargetSnapshot) => void;
    private readonly timeoutMs: number;
    constructor(client: CareerTargetClient, changed: (s: CareerTargetSnapshot) => void, timeoutMs = 8000) { this.client = client; this.changed = changed; this.timeoutMs = timeoutMs; }
    snapshot() { return this.state; }
    private current(g = this.generation) { return this.live && this.client.isCurrent() && g === this.generation; }
    private publish(patch: Partial<CareerTargetSnapshot>) { if (this.current()) { this.state = Object.freeze({ ...this.state, ...patch }); this.changed(this.state); } }
    start(suspended = false) { if (this.live) return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); }); if (suspended) this.publish({ suspended: true }); else void this.refresh(); }
    stop() { this.generation++; this.live = false; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = emptyCareerTargets(); this.changed(this.state); }
    suspend() { if (!this.current()) return; this.generation++; this.request?.abort(); this.request = null; this.publish({ targets: Object.freeze([]), loaded: false, busy: false, suspended: true, uncertain: !!this.state.pending, error: '', notice: '' }); }
    resume() { if (!this.current()) return; this.publish({ suspended: false }); void this.refresh(); }
    private async timed<T>(run: (signal: AbortSignal) => Promise<T>) {
        const abort = new AbortController(); this.request = abort;
        let cancel: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(new DOMException('Interrupted', 'AbortError')); abort.signal.addEventListener('abort', cancel, { once: true }); });
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);
        try { return await Promise.race([run(abort.signal), interrupted]); }
        finally { clearTimeout(timer); if (cancel) abort.signal.removeEventListener('abort', cancel); if (this.request === abort) this.request = null; }
    }
    async refresh() {
        if (!this.current() || this.request || this.state.suspended) return;
        const g = this.generation; this.publish({ busy: true, loaded: false, targets: Object.freeze([]), error: '' });
        try { const targets = await this.timed(s => readCareerTargets(this.client, s)); if (this.current(g)) this.publish({ busy: false, loaded: true, targets }); }
        catch { if (this.current(g)) this.publish({ busy: false, error: '方向暂时没读到，请重新读取。未确认的保存仍可核对或重试。' }); }
    }
    begin(action: CareerTargetAction, id: string | null, input: unknown) {
        if (!this.current() || this.request || this.state.pending || !this.state.loaded || this.state.suspended) return;
        const body = parseCareerTargetCommand(action, input);
        const target = this.state.targets.find(t => t.id === id);
        if (action !== 'create' && (!target || target.revision !== body.expectedRevision)) { this.publish({ error: '你正在编辑旧版，请重新读取，再核对修改。' }); return; }
        this.publish({ pending: Object.freeze({ action, id, body }), uncertain: false, error: '', notice: '' });
        void this.execute(false);
    }
    retry() { return this.execute(false); }
    observe() { return this.execute(true); }
    private async execute(observe: boolean) {
        const pending = this.state.pending;
        if (!this.current() || this.request || !pending || this.state.suspended) return;
        const g = this.generation; this.publish({ busy: true, error: '', notice: '' });
        try {
            const result = await this.timed(s => changeCareerTarget(this.client, pending.action, pending.id, pending.body, s, observe));
            if (!this.current(g)) return;
            const loaded = this.state.loaded;
            const targets = loaded ? Object.freeze([...this.state.targets.filter(t => t.id !== result.operation.targetId), ...(result.target ? [result.target] : [])].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) : Object.freeze([]);
            this.publish({ busy: false, targets, pending: null, uncertain: false, settledOperationId: pending.body.operationId, notice: result.target === null ? '已核对，这个方向已经移除。' : result.target.revision > result.operation.appliedRevision ? '已核对原操作；当前显示之后保存的新版本。' : '方向已保存。' });
            // A recovered single record is not a complete list after a failed read.
            if (!loaded) await this.refresh();
        } catch (e) {
            if (!this.current(g)) return;
            const definitive = !observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string';
            if (definitive) this.publish({ busy: false, loaded: false, targets: Object.freeze([]), pending: null, uncertain: false, error: '这次保存未确认，请重新读取方向，再核对你的修改。' });
            else this.publish({ busy: false, uncertain: true, error: '还不能确认这次保存是否完成。请核对这次保存，或用原操作重试。' });
        }
    }
}
