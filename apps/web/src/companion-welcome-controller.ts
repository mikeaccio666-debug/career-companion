import { parseCompanionWelcomeObservation, parseCompanionWelcomeChoice, parseCompanionWelcomeChoiceResult, type CompanionWelcome, type CompanionWelcomeChoice } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';
import type { CompanionNamingEnvironment } from './companion-naming-controller.ts';
export interface WelcomeViewState {
    readonly welcome: CompanionWelcome | null;
    readonly loading: boolean;
    readonly writing: boolean;
    readonly uncertain: boolean;
    readonly error: string;
}
export const emptyWelcome = (): WelcomeViewState => ({ welcome: null, loading: false, writing: false, uncertain: false, error: '' });
export interface WelcomeIntentStore {
    read(key: string): string | null;
    write(key: string, value: string): void;
    remove(key: string): void;
}
const store: WelcomeIntentStore = { read: key => sessionStorage.getItem(key), write: (key, value) => sessionStorage.setItem(key, value), remove: key => sessionStorage.removeItem(key) };
const environment: CompanionNamingEnvironment = { now: () => Date.now(), isVisible: () => document.visibilityState !== 'hidden', isOnline: () => navigator.onLine !== false,
    operationId: () => crypto.randomUUID(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>) };
/** Opening publishes the documented C1 once; read-only recovery never repeats
 * that POST. The student's C1 choice is always explicit, source-bound and uses
 * its original operation ID after an ambiguous response. */
export class CompanionWelcomeController {
    private live = false;
    private epoch = 0;
    private request: AbortController | null = null;
    private timer: unknown = null;
    private unsubscribe: (() => void) | null = null;
    private attemptedOpen = false;
    private nextAt = 0;
    private pending: Readonly<CompanionWelcomeChoice> | null = null;
    private view = emptyWelcome();
    private readonly key: string;
    private openingError = '';
    private readonly client: BoundPlatformClient;
    private readonly companionId: string;
    private readonly changed: (v: WelcomeViewState) => void;
    private readonly paused: () => boolean;
    private readonly timing: CompanionNamingEnvironment;
    private readonly intents: WelcomeIntentStore;
    constructor(client: BoundPlatformClient, companionId: string, changed: (v: WelcomeViewState) => void, paused: () => boolean = () => false, timing: CompanionNamingEnvironment = environment, intents: WelcomeIntentStore = store) {
        this.client = client;
        this.companionId = companionId;
        this.changed = changed;
        this.paused = paused;
        this.timing = timing;
        this.intents = intents;
        this.key = 'companion.welcome.choice.v1:' + client.account.accountId + ':' + companionId;
    }
    private publish(patch: Partial<WelcomeViewState>) { this.view = Object.freeze({ ...this.view, ...patch }); this.changed(this.view); }
    private current(epoch: number, request: AbortController) { return this.live && epoch === this.epoch && this.client.isCurrent() && !request.signal.aborted; }
    private cancelTimer() { if (this.timer !== null)
        this.timing.clearTimer(this.timer); this.timer = null; }
    private later() {
        this.cancelTimer();
        if (!this.live || !this.client.isCurrent() || !this.timing.isOnline() || !this.timing.isVisible())
            return;
        this.timer = this.timing.setTimer(() => { this.timer = null; this.refresh(); }, Math.max(3000, this.nextAt - this.timing.now()));
    }
    private quota(error: unknown) { if (error instanceof ApiError && error.status === 429) {
        this.nextAt = this.timing.now() + Math.max(60000, Math.min(86400000, error.retryAfterMs ?? 0));
        return true;
    } return false; }
    private accept(value: unknown) { const v = parseCompanionWelcomeObservation(value); if (v.kind === 'welcome' && v.companionId !== this.companionId)
        throw Error('Changed companion'); return v; }
    private clearPending() { this.pending = null; try {
        this.intents.remove(this.key);
    }
    catch { /* The server state remains authoritative. */ } }
    start() {
        if (this.live || !this.client.isCurrent())
            return;
        this.live = true;
        this.epoch++;
        try {
            const saved = this.intents.read(this.key);
            if (saved)
                this.pending = parseCompanionWelcomeChoice(JSON.parse(saved));
        }
        catch { /* No arbitrary stored body is sent. */ }
        this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent())
            this.stop(); });
        this.refresh();
    }
    stop() {
        this.live = false;
        this.epoch++;
        this.request?.abort();
        this.request = null;
        this.cancelTimer();
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (!this.client.isCurrent())
            this.pending = null;
        this.view = Object.freeze(emptyWelcome());
        this.changed(this.view);
    }
    refresh() {
        if (!this.live || this.request || !this.client.isCurrent() || !this.timing.isOnline() || !this.timing.isVisible())
            return;
        if (this.nextAt > this.timing.now()) {
            this.later();
            return;
        }
        this.cancelTimer();
        const epoch = this.epoch, request = new AbortController();
        this.request = request;
        this.publish({ loading: true, error: this.openingError });
        void (async () => {
            let retry = false;
            try {
                let state = this.accept(await this.client.request('/companion/welcome', { signal: request.signal }));
                if (!this.current(epoch, request))
                    return;
                if (state.kind === 'not_opened' && !this.paused() && !this.attemptedOpen) {
                    this.attemptedOpen = true;
                    state = this.accept(await this.client.request('/companion/welcome/open', { method: 'POST', body: JSON.stringify({ expectedCompanionId: this.companionId }), signal: request.signal }));
                    if (!this.current(epoch, request))
                        return;
                    if (state.kind !== 'welcome')
                        throw Error('No saved introduction');
                }
                if (state.kind === 'welcome') {
                    this.openingError = '';
                    if (state.revision === 2 || this.pending && this.pending.welcomeId !== state.id)
                        this.clearPending();
                }
                else if (this.attemptedOpen && !this.paused())
                    this.openingError ||= '初见还没有确认保存，请先重新读取进度，或继续初见。';
                this.publish({ welcome: state.kind === 'welcome' ? state : null, error: this.openingError, uncertain: !!this.pending && state.kind === 'welcome' && state.step === 'C1' });
                retry = !!this.pending;
            }
            catch (error) {
                if (!this.current(epoch, request))
                    return;
                retry = this.quota(error) || this.attemptedOpen;
                if (this.attemptedOpen && !this.view.welcome)
                    this.openingError = '初见还没有确认保存，请先重新读取进度，或继续初见。';
                this.publish({ error: this.openingError || '初见进度暂时无法确认，可以重新读取后继续。', uncertain: !!this.pending });
            }
            finally {
                if (this.current(epoch, request) && this.request === request) {
                    this.request = null;
                    this.publish({ loading: false });
                    if (retry)
                        this.later();
                }
            }
        })();
    }
    retryOpen() { if (this.view.welcome || this.paused() || this.request || this.nextAt > this.timing.now())
        return; this.attemptedOpen = false; this.openingError = ''; this.refresh(); }
    choose(choice: CompanionWelcomeChoice['choice']) { return this.write(choice, false); }
    retryChoice() { return this.pending ? this.write(this.pending.choice, true) : false; }
    private write(choice: CompanionWelcomeChoice['choice'], retry: boolean) {
        const state = this.view.welcome;
        if (!this.live || !this.client.isCurrent() || this.paused() || this.view.writing || state?.step !== 'C1'
            || this.nextAt > this.timing.now() || !this.timing.isOnline() || !this.timing.isVisible() || (!retry && this.pending))
            return false;
        const command = retry ? this.pending : parseCompanionWelcomeChoice({ operationId: this.timing.operationId(), welcomeId: state.id, expectedRevision: 1, choice });
        if (!command || command.welcomeId !== state.id)
            return false;
        try {
            this.intents.write(this.key, JSON.stringify(command));
        }
        catch {
            this.publish({ error: '暂时无法准备这次确认，请稍后再试。' });
            return false;
        }
        this.pending = command;
        this.cancelTimer();
        this.request?.abort();
        const request = new AbortController(), epoch = ++this.epoch;
        this.request = request;
        this.publish({ writing: true, loading: false, uncertain: false, error: '' });
        void (async () => {
            try {
                const result = parseCompanionWelcomeChoiceResult(await this.client.request('/companion/welcome/choice', { method: 'POST', body: JSON.stringify(command), signal: request.signal }));
                if (!this.current(epoch, request))
                    return;
                if (result.operation.id !== command.operationId || result.state.id !== command.welcomeId
                    || result.state.companionId !== this.companionId || result.state.choice !== command.choice)
                    throw Error('Unconfirmed choice');
                this.clearPending();
                this.publish({ welcome: result.state, uncertain: false });
            }
            catch (error) {
                if (!this.current(epoch, request))
                    return;
                this.quota(error);
                this.publish({ uncertain: true, error: '这次选择还没有确认，请先读取已保存的进度。' });
            }
            finally {
                if (this.current(epoch, request) && this.request === request) {
                    this.request = null;
                    this.publish({ writing: false });
                    this.refresh();
                }
            }
        })();
        return true;
    }
}
