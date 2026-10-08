import { parseCareerIdentityCommand, type CareerIdentityEntry, type CareerIdentityRecord } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
import { ApiError } from './api.ts';
import { readIdentityEntry, readIdentityRecords, changeIdentityRecord, observeIdentityRecord, type IdentityIntent, type IdentityResult } from './career-identity-api.ts';
export interface IdentitySnapshot {
    entry: CareerIdentityEntry | null;
    records: readonly Readonly<CareerIdentityRecord>[];
    busy: boolean;
    uncertain: boolean;
    pending: IdentityIntent | null;
    error: string;
    lastResult: IdentityResult | null;
}
const empty = (): IdentitySnapshot => ({ entry: null, records: [], busy: false, uncertain: false, pending: null, error: '', lastResult: null });
/** Memory-only UI state. Original nonce is retained until actual reconciliation.
 * Account invalidation aborts requests and discards values/drafts/intent together. */
export class CareerIdentityController {
    private state: IdentitySnapshot = empty();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: BoundPlatformClient;
    private readonly changed: (s: IdentitySnapshot) => void;
    private readonly timeouts: {
        read: number;
        write: number;
    };
    constructor(client: BoundPlatformClient, changed: (s: IdentitySnapshot) => void, timeouts = { read: 12000, write: 8000 }) { this.client = client; this.changed = changed; this.timeouts = timeouts; }
    snapshot() { return this.state; }
    private current(generation = this.generation) { return generation === this.generation && this.live && this.client.isCurrent(); }
    private publish(patch: Partial<IdentitySnapshot>) { if (!this.current())
        return; this.state = Object.freeze({ ...this.state, ...patch }); this.changed(this.state); }
    start() { if (this.live)
        return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent())
        this.stop(); }); void this.refresh(); }
    stop() { this.generation++; this.live = false; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = empty(); this.changed(this.state); }
    private async timed<T>(run: (signal: AbortSignal) => Promise<T>, ms: number) {
        const abort = new AbortController();
        this.request = abort;
        let rejectAbort: (() => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new DOMException('Request interrupted', 'AbortError')); abort.signal.addEventListener('abort', rejectAbort, { once: true }); });
        const timer = setTimeout(() => abort.abort(), ms);
        try {
            return await Promise.race([run(abort.signal), cancelled]);
        }
        finally {
            clearTimeout(timer);
            if (rejectAbort)
                abort.signal.removeEventListener('abort', rejectAbort);
            if (this.request === abort)
                this.request = null;
        }
    }
    async refresh() {
        if (!this.current() || this.request)
            return;
        const generation = this.generation;
        this.publish({ busy: true, error: this.state.pending ? this.state.error : '' });
        try {
            const result = await this.timed(async (signal) => { const entry = await readIdentityEntry(this.client, signal); const records = entry.kind === 'available' ? await readIdentityRecords(this.client, signal) : []; return { entry, records }; }, this.timeouts.read);
            if (this.current(generation))
                this.publish({ ...result, busy: false });
        }
        catch {
            if (this.current(generation))
                this.publish({ busy: false, error: '个人资料暂时没有读到，可以重新读取。' });
        }
    }
    begin(value: IdentityIntent) {
        if (!this.current() || this.state.busy || this.state.pending || this.state.entry?.kind !== 'available')
            return;
        const command = parseCareerIdentityCommand(value.action, value.body);
        if (value.action !== 'create') {
            const row = this.state.records.find(r => r.id === value.id);
            if (!row || row.revision !== command.expectedRevision) {
                this.publish({ error: '记录已有变化，先重新读取并核对。' });
                return;
            }
        }
        const pending = Object.freeze({ action: value.action, id: value.id, body: command });
        this.publish({ pending, uncertain: false, error: '' });
        void this.execute(false);
    }
    async retry() { await this.execute(false); }
    async observe() { await this.execute(true); }
    private async execute(observe: boolean) {
        const pending = this.state.pending;
        if (!this.current() || !pending || this.request || this.state.busy)
            return;
        const generation = this.generation;
        this.publish({ busy: true, error: '' });
        try {
            const result = await this.timed(signal => observe ? observeIdentityRecord(this.client, pending, signal) : changeIdentityRecord(this.client, pending, signal), observe ? this.timeouts.read : this.timeouts.write);
            if (!this.current(generation))
                return;
            const records = Object.freeze([...this.state.records.filter(r => r.id !== result.operation.recordId), ...(result.record ? [result.record] : [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
            this.publish({ records, busy: false, uncertain: false, pending: null, error: '', lastResult: result });
        }
        catch (e) {
            if (!this.current(generation))
                return;
            // Missing observer result can race an in-flight original commit. Never clear
            // an ambiguous intent on a read-only observation failure.
            if (!observe && e instanceof ApiError && e.status >= 400 && e.status < 500)
                this.publish({ busy: false, pending: null, uncertain: false, error: e.status === 409 ? '记录已有变化，先重新读取并核对。' : '这次没有保存，请核对资料或登录状态。' });
            else
                this.publish({ busy: false, uncertain: true, error: '还在确认，先别关页面。可以核对这次操作，或用原操作重试。' });
        }
    }
}
