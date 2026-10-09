import { parseCompanionDailySettingsCommand, type CompanionDailySettings, type CompanionDailySettingsCommand, type DailyPreferences } from '@companion/platform-contracts';
import { readDailySettings, changeDailySettings, type DailySettingsClient } from './companion-daily-settings-api.ts';
import { ApiError } from './api-error.ts';
export interface DailySettingsSnapshot {
    readonly loaded: boolean;
    readonly busy: boolean;
    readonly suspended: boolean;
    readonly settings: Readonly<CompanionDailySettings> | null;
    readonly pending: Readonly<CompanionDailySettingsCommand> | null;
    readonly uncertain: boolean;
    readonly error: string;
    readonly notice: string;
}
export const emptyDailySettings = (): DailySettingsSnapshot => Object.freeze({ loaded: false, busy: false, suspended: false, settings: null, pending: null, uncertain: false, error: '', notice: '' });
export class DailySettingsController {
    private state = emptyDailySettings();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: DailySettingsClient;
    private readonly changed: (s: DailySettingsSnapshot) => void;
    private readonly timeoutMs: number;
    constructor(client: DailySettingsClient, changed: (s: DailySettingsSnapshot) => void, timeoutMs = 8000) { this.client = client; this.changed = changed; this.timeoutMs = timeoutMs; }
    snapshot() { return this.state; }
    private current(g = this.generation) { return this.live && this.client.isCurrent() && g === this.generation; }
    private publish(patch: Partial<DailySettingsSnapshot>) { if (this.current()) {
        this.state = Object.freeze({ ...this.state, ...patch });
        this.changed(this.state);
    } }
    start(suspended = false) { if (this.live)
        return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent())
        this.stop(); }); if (suspended)
        this.publish({ suspended: true });
    else
        void this.refresh(); }
    stop() { this.generation++; this.live = false; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = emptyDailySettings(); this.changed(this.state); }
    suspend() { if (!this.current())
        return; this.generation++; this.request?.abort(); this.request = null; this.publish({ loaded: false, busy: false, suspended: true, settings: null, uncertain: !!this.state.pending, error: '', notice: '' }); }
    resume() { if (!this.current())
        return; this.publish({ suspended: false }); void this.refresh(); }
    private async timed<T>(run: (signal: AbortSignal) => Promise<T>) {
        const abort = new AbortController();
        this.request = abort;
        let cancel: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(new DOMException('Interrupted', 'AbortError')); abort.signal.addEventListener('abort', cancel, { once: true }); });
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);
        try {
            return await Promise.race([run(abort.signal), interrupted]);
        }
        finally {
            clearTimeout(timer);
            if (cancel)
                abort.signal.removeEventListener('abort', cancel);
            if (this.request === abort)
                this.request = null;
        }
    }
    async refresh() {
        if (!this.current() || this.request || this.state.suspended)
            return;
        const g = this.generation;
        this.publish({ busy: true, loaded: false, settings: null, error: '', notice: '' });
        try {
            const settings = await this.timed(s => readDailySettings(this.client, s));
            if (this.current(g))
                this.publish({ busy: false, loaded: true, settings });
        }
        catch (e) {
            if (this.current(g))
                this.publish({ busy: false, error: e instanceof ApiError && e.code === 'COMPANION_NOT_BORN' ? '主理人诞生后，就可以在这里设置。' : '设置暂时没有读到，可以重新读取。' });
        }
    }
    begin(mode: DailyPreferences) { if (!this.current() || this.request || this.state.pending || !this.state.loaded || !this.state.settings || this.state.suspended)
        return; let pending: Readonly<CompanionDailySettingsCommand>; try { pending = parseCompanionDailySettingsCommand({ companionId: this.state.settings.companionId, operationId: crypto.randomUUID(), expectedRevision: this.state.settings.revision, preferences: mode }); } catch { this.publish({ error: '请核对时区、时间和每日分钟数。' }); return; } this.publish({ pending, uncertain: false, error: '', notice: '' }); void this.execute(false); }
    retry() { return this.execute(false); }
    observe() { return this.execute(true); }
    private async execute(observe: boolean) {
        const pending = this.state.pending;
        if (!this.current() || this.request || !pending || this.state.suspended)
            return;
        const g = this.generation;
        this.publish({ busy: true, error: '', notice: '' });
        try {
            const result = await this.timed(s => changeDailySettings(this.client, pending, observe, s));
            if (this.current(g))
                this.publish({ busy: false, loaded: true, settings: result.settings, pending: null, uncertain: false, notice: result.settings.revision > result.operation.appliedRevision ? '已核对原操作；当前显示的是之后保存的新选择。' : '选择已保存。' });
        }
        catch (e) {
            if (!this.current(g))
                return;
            const definitive = !observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string';
            if (definitive)
                this.publish({ busy: false, loaded: false, settings: null, pending: null, uncertain: false, error: '这次保存未确认，请重新读取设置后再选择。' });
            else
                this.publish({ busy: false, uncertain: true, error: '还不能确认这次保存是否完成。请核对原操作，或用原操作重试。' });
        }
    }
}
