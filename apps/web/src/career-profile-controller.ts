import { parseCareerProfileCommand, type CareerProfileSnapshot, type CareerProfileAction } from '@companion/platform-contracts';
import { readCareerProfile, changeCareerProfile, type CareerProfileClient } from './career-profile-api.ts';
import { ApiError } from './api-error.ts';
export interface ProfileState {
    data: Readonly<CareerProfileSnapshot> | null;
    busy: boolean;
    suspended: boolean;
    pending: Readonly<{
        action: CareerProfileAction;
        body: ReturnType<typeof parseCareerProfileCommand>;
    }> | null;
    error: string;
    notice: string;
    settled: string | null;
}
const empty = (): ProfileState => ({ data: null, busy: false, suspended: false, pending: null, error: '', notice: '', settled: null });
export class CareerProfileController {
    private state = empty();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: CareerProfileClient;
    private readonly changed: (s: ProfileState) => void;
    private readonly timeout: number;
    constructor(client: CareerProfileClient, changed: (s: ProfileState) => void, timeout = 10000) { this.client = client; this.changed = changed; this.timeout = timeout; }
    snapshot() { return this.state; }
    private current(g = this.generation) { return this.live && this.client.isCurrent() && g === this.generation; }
    private publish(p: Partial<ProfileState>) { if (this.current()) {
        this.state = Object.freeze({ ...this.state, ...p });
        this.changed(this.state);
    } }
    start(suspended = false) { if (this.live)
        return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent())
        this.stop(); }); if (suspended)
        this.publish({ suspended: true });
    else
        void this.refresh(); }
    stop() { this.generation++; this.live = false; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = empty(); this.changed(this.state); }
    suspend() { if (!this.current())
        return; this.generation++; this.request?.abort(); this.request = null; this.publish({ data: null, busy: false, suspended: true, error: '', notice: '' }); }
    resume() { if (!this.current())
        return; this.publish({ suspended: false }); if (this.state.pending)
        void this.observe();
    else
        void this.refresh(); }
    private async timed<T>(run: (s: AbortSignal) => Promise<T>) {
        const a = new AbortController();
        this.request = a;
        let cancel: () => void = () => { };
        const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(new DOMException('Interrupted', 'AbortError')); a.signal.addEventListener('abort', cancel, { once: true }); });
        const timer = setTimeout(() => a.abort(), this.timeout);
        try {
            return await Promise.race([run(a.signal), interrupted]);
        }
        finally {
            clearTimeout(timer);
            a.signal.removeEventListener('abort', cancel);
            if (this.request === a)
                this.request = null;
        }
    }
    async refresh() {
        if (!this.current() || this.request || this.state.suspended)
            return;
        if (this.state.pending) {
            await this.observe();
            return;
        }
        const g = this.generation;
        this.publish({ busy: true, data: null, error: '' });
        try {
            const data = await this.timed(s => readCareerProfile(this.client, s));
            if (this.current(g))
                this.publish({ data, busy: false });
        }
        catch {
            if (this.current(g))
                this.publish({ busy: false, error: '职业档案暂时没有读到，可以重新读取。' });
        }
    }
    begin(action: CareerProfileAction, input: unknown) {
        if (!this.current() || this.request || this.state.suspended || this.state.pending || !this.state.data)
            return;
        const body = parseCareerProfileCommand(action, input);
        if (body.expectedRevision !== this.state.data.revision) {
            this.publish({ error: '档案已有变化，请重新读取并核对。' });
            return;
        }
        this.publish({ pending: Object.freeze({ action, body }), error: '', notice: '' });
        void this.execute(false);
    }
    retry() { return this.execute(false); }
    observe() { return this.execute(true); }
    private async execute(observe: boolean) {
        const pending = this.state.pending;
        if (!this.current() || this.request || this.state.suspended || !pending)
            return;
        const g = this.generation;
        this.publish({ busy: true, error: '' });
        try {
            const r = await this.timed(s => changeCareerProfile(this.client, pending.action, pending.body, s, observe));
            if (!this.current(g))
                return;
            this.publish({ data: r, busy: false, pending: null, settled: pending.body.operationId, notice: r.revision > r.operation.appliedRevision ? '已核对原操作，显示之后保存的最新档案。' : r.profile ? '职业档案已保存。' : '职业档案已删除。' });
        }
        catch (e) {
            if (!this.current(g))
                return;
            if (!observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string')
                this.publish({ data: null, busy: false, pending: null, error: '这次保存未确认，请重新读取，再核对修改。' });
            else
                this.publish({ busy: false, error: '还不能确认是否已保存。可以核对这次操作，或用原操作重试。' });
        }
    }
}
