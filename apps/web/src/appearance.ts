export type AppearancePreference = 'system' | 'light' | 'dark';
export type AppearanceSnapshot = Readonly<{preference: AppearancePreference; persistence: 'saved' | 'session'}>;
export interface AppearancePort {
  read(): string | null;
  write(value: AppearancePreference): void;
  apply(value: AppearancePreference): void;
  listen(change: () => void): () => void;
}
const preference = (value: unknown): AppearancePreference => value === 'light' || value === 'dark' ? value : 'system';
export const DEFAULT_APPEARANCE: AppearanceSnapshot = Object.freeze({preference: 'system', persistence: 'saved'});
/** One cosmetic preference per browser. No account IDs, content, or network. */
export class AppearanceStore {
  private state: AppearanceSnapshot = DEFAULT_APPEARANCE;
  private listeners = new Set<() => void>();
  private unlisten?: () => void;
  private readonly port: AppearancePort;
  constructor(port: AppearancePort) { this.port = port; this.refresh(); }
  getSnapshot = (): AppearanceSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start() {
    if (!this.unlisten) { this.unlisten = this.port.listen(() => this.refresh()); this.refresh(); }
  }
  stop() { this.unlisten?.(); this.unlisten = undefined; }
  choose(value: AppearancePreference) {
    if (!['system', 'light', 'dark'].includes(value)) throw new Error('Invalid appearance preference.');
    let persistence: AppearanceSnapshot['persistence'] = 'saved';
    try { this.port.write(value); } catch { persistence = 'session'; }
    this.publish(value, persistence);
  }
  private refresh() {
    try { this.publish(preference(this.port.read()), 'saved'); }
    catch { this.publish(this.state.preference, 'session'); }
  }
  private publish(value: AppearancePreference, persistence: AppearanceSnapshot['persistence']) {
    this.port.apply(value);
    if (this.state.preference === value && this.state.persistence === persistence) return;
    this.state = Object.freeze({preference: value, persistence});
    for (const listener of this.listeners) listener();
  }
}
