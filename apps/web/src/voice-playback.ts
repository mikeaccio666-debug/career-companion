export interface VoicePlaybackMedia {
  readonly paused: boolean;
  readonly ended: boolean;
  pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
interface Player { release(): void; }
const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'error'] as const;
const safely = (work: () => void) => { try { work(); } catch { /* One player must not prevent the others from stopping. */ } };

/** One mounted voice draft owns these players; no document search or global audio state. */
export class VoicePlaybackController {
  private players = new Map<VoicePlaybackMedia, Player>();
  private listeners = new Set<() => void>();
  private playing = 0;
  private readonly isCurrent: () => boolean;
  constructor(isCurrent: () => boolean) { this.isCurrent = isCurrent; }
  getSnapshot = () => this.playing;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private current() { try { return this.isCurrent(); } catch { return false; } }
  private audible(media: VoicePlaybackMedia) { try { return !media.paused && !media.ended; } catch { return false; } }
  private publish() {
    const count = this.current() ? [...this.players.keys()].filter((media) => this.audible(media)).length : 0;
    if (count === this.playing) return;
    this.playing = count;
    for (const listener of this.listeners) listener();
  }
  register(media: VoicePlaybackMedia): () => void {
    if (!this.current()) { safely(() => media.pause()); this.publish(); return () => {}; }
    this.players.get(media)?.release();
    let active = true;
    const player: Player = { release: () => {
      if (!active) return;
      active = false;
      for (const type of events) safely(() => media.removeEventListener(type, changed));
      // A delayed old-source cleanup cannot pause a replacement registration.
      if (this.players.get(media) === player) { this.players.delete(media); safely(() => media.pause()); this.publish(); }
    } };
    const changed: EventListener = () => {
      if (!active || this.players.get(media) !== player) return;
      if (!this.current() && this.audible(media)) safely(() => media.pause());
      // Read native state: queued play/pause/ended events may describe an earlier action.
      this.publish();
    };
    this.players.set(media, player);
    for (const type of events) media.addEventListener(type, changed);
    this.publish();
    return player.release;
  }
  /** Pause every registered player, including a pending native play(), without changing its source. */
  pauseAll(): void {
    for (const media of [...this.players.keys()]) safely(() => media.pause());
    this.publish();
  }
}
