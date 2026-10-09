import {dailyEditMatches,type DailyEditBasis} from './daily-plan-editor.ts';
import { parseDailyPlanCommand, type DailyPlanView, type DailyPlanCommand } from '@companion/platform-contracts';
export type DailyPlanIntent={action:'add';title:string;minutes:number}|{action:'edit';itemId:string;title:string;minutes:number;basis:DailyEditBasis}|{action:'accept'}|{action:'done'|'move'|'drop';itemId:string};
import { readDailyPlanView, changeDailyPlan, type DailyPlanClient } from './daily-plans-api.ts';
import { ApiError } from './api-error.ts';
export interface DailyPlanSnapshot {
    readonly loaded: boolean;
    readonly busy: boolean;
    readonly suspended: boolean;
    readonly view: Readonly<DailyPlanView> | null;
    readonly pending: Readonly<DailyPlanCommand> | null;
    readonly uncertain: boolean;
    readonly error: string;
    readonly notice: string;
}
export const emptyDailyPlan = (): DailyPlanSnapshot => Object.freeze({ loaded: false, busy: false, suspended: false, view: null, pending: null, uncertain: false, error: '', notice: '' });
export class DailyPlanController {
    private state = emptyDailyPlan();
    private live = false;
    private generation = 0;
    private request: AbortController | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly client: DailyPlanClient;
    private readonly changed: (s: DailyPlanSnapshot) => void;
    private readonly timeoutMs: number;
    constructor(client: DailyPlanClient, changed: (s: DailyPlanSnapshot) => void, timeoutMs = 8000) { this.client = client; this.changed = changed; this.timeoutMs = timeoutMs; }
    snapshot() { return this.state; }
    private current(g = this.generation) { return this.live && this.client.isCurrent() && g === this.generation; }
    private publish(patch: Partial<DailyPlanSnapshot>) { if (this.current()) {
        this.state = Object.freeze({ ...this.state, ...patch });
        this.changed(this.state);
    } }
    start(suspended = false) { if (this.live)
        return; this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent())
        this.stop(); }); if (suspended)
        this.publish({ suspended: true });
    else
        void this.refresh(); }
    stop() { this.generation++; this.live = false; this.request?.abort(); this.request = null; this.unsubscribe?.(); this.unsubscribe = null; this.state = emptyDailyPlan(); this.changed(this.state); }
    suspend() { if (!this.current())
        return; this.generation++; this.request?.abort(); this.request = null; this.publish({ loaded: false, busy: false, suspended: true, view: null, uncertain: !!this.state.pending, error: '', notice: '' }); }
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
        this.publish({ busy: true, loaded: false, view: null, error: '', notice: '' });
        try {
            const view = await this.timed(s => readDailyPlanView(this.client, s));
            if (this.current(g))
                this.publish({ busy: false, loaded: true, view });
        }
        catch (e) {
            if (this.current(g))
                this.publish({ busy: false, error: e instanceof ApiError && e.code === 'COMPANION_NOT_BORN' ? '主理人诞生后，就可以在这里设置。' : e instanceof ApiError && e.code === 'DAILY_SETTINGS_REQUIRED' ? '先在主理人设置中保存时区，就可以安排今天。' : '今天的安排暂时没有读到，可以重新读取。' });
        }
    }
    begin(intent:DailyPlanIntent) { if (!this.current() || this.request || this.state.pending || !this.state.loaded || !this.state.view || this.state.suspended || this.state.view.paused) return;
      if(intent.action==='edit'&&!dailyEditMatches(this.state.view,intent.itemId,intent.basis)){this.publish({error:'安排已有变化，请核对当前内容后再保存修改。'});return;}
      const fields=intent.action==='edit'?{action:intent.action,itemId:intent.itemId,title:intent.title,minutes:intent.minutes}:intent;
      let pending:Readonly<DailyPlanCommand>;try{const v=this.state.view;pending=parseDailyPlanCommand({...fields,companionId:v.companionId,operationId:crypto.randomUUID(),localDate:v.localDate,planId:v.plan?.id??null,expectedRevision:v.plan?.revision??0});}catch{this.publish({error:'请填写事项和预计分钟数。'});return;}
      this.publish({pending,uncertain:false,error:'',notice:''});void this.execute(false);
    }
    retry() { return this.execute(false); }
    observe() { return this.execute(true); }
    private async execute(observe: boolean) {
        const pending = this.state.pending;
        if (!this.current() || this.request || !pending || this.state.suspended)
            return;
        const g = this.generation;
        this.publish({ busy: true, error: '', notice: '' });
        try {
            const result = await this.timed(s => changeDailyPlan(this.client, pending, observe, s));
            if (this.current(g))
                this.publish({ busy: false, loaded: true, view: result.view, pending: null, uncertain: false, notice: result.view.localDate !== pending.localDate ? '原操作已保存；现在显示新一天的安排。' : result.operation.replayed ? '已核对原操作，显示当前安排。' : '安排已保存。' });
        }
        catch (e) {
            if (!this.current(g))
                return;
            const definitive = !observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string';
            if (definitive)
                this.publish({ busy: false, loaded: false, view: null, pending: null, uncertain: false, error: e instanceof ApiError && e.code === 'DAILY_PLAN_BUDGET' ? '预计时间超过每日预算。请调整事项或在设置中修改预算。' : e instanceof ApiError && e.code === 'DAILY_PLAN_PAUSED' ? '现在是你选择的休息时间。重新读取后会收起任务。' : '这次保存未确认，请重新读取今天的安排后再选择。' });
            else
                this.publish({ busy: false, uncertain: true, error: '还不能确认这次保存是否完成。请核对原操作，或用原操作重试。' });
        }
    }
}
