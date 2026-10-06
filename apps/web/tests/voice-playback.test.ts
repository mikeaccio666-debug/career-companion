import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRequestContext } from '../src/account-context.ts';
import { holdPrivateResource } from '../src/private-media.ts';
import { VoicePlaybackController } from '../src/voice-playback.ts';

class Player extends EventTarget {
  paused = true;
  ended = false;
  pauses = 0;
  failPause = false;
  currentTime = 2;
  callbacks = new Map<string, EventListener[]>();
  override addEventListener(type: string, callback: EventListener) {
    const all = this.callbacks.get(type) || []; all.push(callback); this.callbacks.set(type, all);
    super.addEventListener(type, callback);
  }
  play() { this.paused = false; this.ended = false; this.dispatchEvent(new Event('play')); }
  pause() {
    this.pauses++;
    if (this.failPause) throw new Error('Fictional private device detail.');
    if (this.paused) return;
    this.paused = true; this.dispatchEvent(new Event('pause'));
  }
}

test('stop pauses every registered voice player and preserves native resume, seek position and another scope', () => {
  const voice = new VoicePlaybackController(() => true), other = new VoicePlaybackController(() => true);
  const first = new Player(), second = new Player(), elsewhere = new Player();
  voice.register(first); voice.register(second); other.register(elsewhere);
  first.play(); second.play(); elsewhere.play();
  assert.equal(voice.getSnapshot(), 2); assert.equal(other.getSnapshot(), 1);
  voice.pauseAll();
  assert.equal(first.paused, true); assert.equal(second.paused, true); assert.equal(elsewhere.paused, false);
  assert.equal(voice.getSnapshot(), 0); assert.equal(first.currentTime, 2);
  first.play(); assert.equal(first.paused, false); assert.equal(voice.getSnapshot(), 1);
  first.pause(); assert.equal(voice.getSnapshot(), 0);
});

test('native state wins over queued play, pause and ended events from earlier operations', () => {
  const voice = new VoicePlaybackController(() => true), first = new Player(), second = new Player();
  voice.register(first); voice.register(second); first.play(); second.play();
  voice.pauseAll(); first.dispatchEvent(new Event('play')); second.dispatchEvent(new Event('playing'));
  assert.equal(voice.getSnapshot(), 0);
  first.play(); second.play(); first.ended = true; first.dispatchEvent(new Event('ended'));
  assert.equal(voice.getSnapshot(), 1);
  first.play(); first.dispatchEvent(new Event('ended')); first.dispatchEvent(new Event('pause'));
  assert.equal(voice.getSnapshot(), 2, 'a stale event cannot declare currently playing media stopped');
  second.pause(); assert.equal(voice.getSnapshot(), 1);
});

test('one failing pause cannot prevent stopping other players or falsely report that every player stopped', () => {
  const voice = new VoicePlaybackController(() => true), first = new Player(), second = new Player();
  voice.register(first); voice.register(second); first.play(); second.play(); first.failPause = true;
  voice.pauseAll();
  assert.equal(first.paused, false); assert.equal(second.paused, true); assert.equal(voice.getSnapshot(), 1);
  first.failPause = false; voice.pauseAll(); assert.equal(voice.getSnapshot(), 0);
});

test('source replacement and StrictMode setup-cleanup-setup reject old events and cleanup without closing the scope', () => {
  const voice = new VoicePlaybackController(() => true), player = new Player();
  const stopOld = voice.register(player), oldPlay = player.callbacks.get('play')![0];
  player.play(); stopOld(); assert.equal(player.paused, true); assert.equal(voice.getSnapshot(), 0);
  const stopNew = voice.register(player); player.play();
  oldPlay(new Event('play')); stopOld();
  assert.equal(player.paused, false); assert.equal(voice.getSnapshot(), 1);
  stopNew(); assert.equal(player.paused, true); assert.equal(voice.getSnapshot(), 0);
  player.play(); assert.equal(voice.getSnapshot(), 0, 'unregistered media cannot update the old page');
});

test('the same account in a new authentication generation cannot revive old players or affect the new scope', () => {
  const context = new AccountRequestContext(); context.changeSession('799c7d39-2d4d-4c43-8004-71872d3a021a');
  const capture = context.capture()!, account = { isCurrent: () => context.isCurrent(capture), subscribe: context.subscribe };
  const oldScope = new VoicePlaybackController(account.isCurrent), oldPlayer = new Player();
  const release = oldScope.register(oldPlayer), late = oldPlayer.callbacks.get('play')![0];
  const cleanup = holdPrivateResource(account, release); oldPlayer.play();
  context.changeSession(capture.accountId); assert.equal(oldPlayer.paused, true); assert.equal(oldScope.getSnapshot(), 0);
  const next = context.capture()!, nextScope = new VoicePlaybackController(() => context.isCurrent(next)), nextPlayer = new Player();
  nextScope.register(nextPlayer); nextPlayer.play(); late(new Event('play')); cleanup(); oldScope.pauseAll();
  assert.equal(nextPlayer.paused, false); assert.equal(nextScope.getSnapshot(), 1);
  oldPlayer.play(); oldScope.register(oldPlayer);
  assert.equal(oldPlayer.paused, true); assert.equal(oldScope.getSnapshot(), 0);
});

test('draft invalidation silences a late native play while an unrelated draft keeps playing', () => {
  let current = true;
  const old = new VoicePlaybackController(() => current), next = new VoicePlaybackController(() => true);
  const first = new Player(), second = new Player(); old.register(first); next.register(second);
  first.play(); second.play(); current = false; first.play();
  assert.equal(first.paused, true); assert.equal(old.getSnapshot(), 0);
  assert.equal(second.paused, false); assert.equal(next.getSnapshot(), 1);
});

test('paused audio stays stopped during a pending permission request and after its rejection; explicit native play stays available', async () => {
  const voice = new VoicePlaybackController(() => true), player = new Player(); voice.register(player); player.play();
  let reject!: (error: Error) => void, requested = false;
  const permission = new Promise<void>((_, fail) => { reject = fail; });
  voice.pauseAll();
  const pending = (() => { requested = true; assert.equal(player.paused, true); return permission; })();
  assert.equal(requested, true); assert.equal(voice.getSnapshot(), 0);
  reject(new Error('Fictional denied microphone permission.')); await assert.rejects(pending, /denied/);
  assert.equal(player.paused, true); assert.equal(voice.getSnapshot(), 0);
  player.play(); assert.equal(voice.getSnapshot(), 1);
});
