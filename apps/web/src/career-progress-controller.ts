import type { CareerProgressSnapshot } from '@companion/platform-contracts';
import { readCareerProgress, type CareerProgressClient } from './career-progress-api.ts';
export interface CareerProgressState { readonly value: Readonly<CareerProgressSnapshot> | null; readonly busy: boolean; readonly error: string; }
const empty = (): CareerProgressState => Object.freeze({ value: null, busy: false, error: '' });
/** Read-only owner view. Clears before every refresh, including failure; there
 * is no optimistic increment or persistent browser storage. */
export class CareerProgressController {
    private state = empty();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: CareerProgressClient;
    private readonly changed: (state: CareerProgressState) => void;
    private readonly timeoutMs: number;
    constructor(client: CareerProgressClient, changed: (state: CareerProgressState) => void, timeoutMs = 8000) { this.client = client; this.changed = changed; this.timeoutMs = timeoutMs; }
    snapshot() { return this.state; }
    private current(g = this.generation) { return this.live && this.client.isCurrent() && g === this.generation; }
    private publish(state: CareerProgressState) { if (this.current()) { this.state = Object.freeze(state); this.changed(this.state); } }
    start() { if (this.live) return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); }); void this.refresh(); }
    stop() { this.live = false; this.generation++; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = empty(); this.changed(this.state); }
    async refresh() {
        if (!this.current() || this.request) return;
        const g = this.generation, c = new AbortController(); this.request = c;
        this.publish({ value: null, busy: true, error: '' });
        let abort: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new DOMException('Interrupted', 'AbortError')); c.signal.addEventListener('abort', abort, { once: true }); });
        const timer = setTimeout(() => c.abort(), this.timeoutMs);
        try {
            const value = await Promise.race([readCareerProgress(this.client, c.signal), interrupted]);
            if (this.current(g)) this.publish({ value, busy: false, error: '' });
        } catch { if (this.current(g)) this.publish({ value: null, busy: false, error: '成长记录暂时没读到，请重新读取。' }); }
        finally { clearTimeout(timer); if (abort) c.signal.removeEventListener('abort', abort); if (this.request === c) this.request = null; }
    }
}
