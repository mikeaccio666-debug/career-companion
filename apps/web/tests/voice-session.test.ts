import assert from 'node:assert/strict';
import test from 'node:test';
import { disposeVoiceSession, microphoneErrorText } from '../src/voice-session.ts';
import { VoiceDraftStore, voiceDepartureNotice } from '../src/voice-draft.ts';

test('leaving detaches recording callbacks, aborts requests, closes RTC and stops every microphone track', () => {
  const events: string[] = [], controllers = [new AbortController(), new AbortController()];
  controllers.forEach((controller, index) => controller.signal.addEventListener('abort', () => events.push(`abort-${index}`)));
  const recorder = { state: 'recording', onstop: (() => events.push('must-not-upload')) as unknown, ondataavailable: (() => events.push('must-not-retain-blob')) as unknown, stop() { events.push('recorder'); if (typeof this.onstop === 'function') this.onstop(); } };
  const recognition = { onresult: (() => {}) as unknown, onerror: (() => {}) as unknown, onend: (() => {}) as unknown, stop() { events.push('recognition'); } };
  const audio = { srcObject: {} as unknown, pause() { events.push('audio'); } };
  disposeVoiceSession({ controllers, recorder, recognition, audio, peer: { close() { events.push('RTC'); } }, microphone: { getTracks() { return [0, 1].map((index) => ({ stop() { events.push(`track-${index}`); } })); } } });
  assert.deepEqual(events, ['abort-0', 'abort-1', 'recognition', 'RTC', 'recorder', 'track-0', 'track-1', 'audio']);
  assert.equal(recorder.onstop, null); assert.equal(recorder.ondataavailable, null); assert.equal(recognition.onresult, null); assert.equal(audio.srcObject, null);
});

test('a throwing resource does not prevent the other tracks, audio and requests being released', () => {
  const events: string[] = [], controller = new AbortController(), audio = { srcObject: {} as unknown, pause() { throw new Error('Fictional private browser detail.'); } };
  disposeVoiceSession({ controllers: [controller], recognition: { onresult: () => {}, onerror: () => {}, onend: () => {}, stop() { throw new Error('Fictional stopped recognizer.'); } }, peer: { close() { throw new Error('Fictional closed peer.'); } }, microphone: { getTracks() { return [{ stop() { throw new Error('Fictional failed first track.'); } }, { stop() { events.push('second-track'); } }]; } }, audio });
  assert.equal(controller.signal.aborted, true); assert.deepEqual(events, ['second-track']); assert.equal(audio.srcObject, null);
});

test('queued final recognition callback after cleanup cannot replace the restored draft', () => {
  const store = new VoiceDraftStore(); store.changeSession({ accountId: 'fictional-a', generation: 1 });
  const draft = store.open('conversation-a'), old = draft.edit(); old.update((value) => ({ ...value, text: 'Fictional complete text.' }));
  const callback = () => old.update((value) => ({ ...value, text: 'Fictional late final callback.' }));
  const recognition = { onresult: callback as unknown, onerror: null, onend: null, stop() { callback(); } };
  old.close(); disposeVoiceSession({ controllers: [], recognition });
  const restored = store.open('conversation-a'); assert.equal(restored.getSnapshot().text, 'Fictional complete text.'); assert.equal(callback(), false);
});

test('leaving during recording preserves complete text but does not trigger upload or claim untranscribed audio was retained', () => {
  const store = new VoiceDraftStore(); store.changeSession({ accountId: 'fictional-a', generation: 1 });
  const draft = store.open(null); draft.edit().update((value) => ({ ...value, text: 'Fictional earlier complete text.' }));
  const notice = voiceDepartureNotice({ recording: true, transcribing: false, speaking: false, recognizing: false, realtime: false });
  draft.update((value) => ({ ...value, notice })); let uploads = 0;
  const recorder = { state: 'recording', ondataavailable: () => {}, onstop: (() => { ++uploads; }) as unknown, stop() { if (typeof this.onstop === 'function') this.onstop(); } };
  disposeVoiceSession({ controllers: [], recorder });
  assert.equal(uploads, 0); assert.equal(store.open(null).getSnapshot().text, 'Fictional earlier complete text.');
  assert.match(store.open(null).getSnapshot().notice, /尚未转写的音频没有保留/);
});

test('recording controller cancellation is included in departure cleanup even when another resource throws', () => {
  let cancelled = 0, trackStopped = 0;
  disposeVoiceSession({ controllers: [], peer: { close() { throw new Error('Fictional RTC failure'); } }, recording: { cancel() { cancelled++; } }, microphone: { getTracks() { return [{ stop() { trackStopped++; } }]; } } });
  assert.equal(cancelled, 1); assert.equal(trackStopped, 1);
});

test('microphone failures offer device or permission recovery without exposing browser details', () => {
  const cases = [['NotAllowedError', /网站设置/], ['PermissionDeniedError', /网站设置/], ['NotFoundError', /没有找到/], ['DevicesNotFoundError', /没有找到/], ['NotReadableError', /其他正在使用/], ['TrackStartError', /其他正在使用/], ['SecurityError', /HTTPS/], ['AbortError', /重试/], ['UnknownBrowserName', /重试/]] as const;
  for (const [name, pattern] of cases) {
    const message = microphoneErrorText({ name, message: 'Fictional private device label' });
    assert.match(message, pattern); assert.doesNotMatch(message, /Fictional private device label/);
  }
  assert.match(microphoneErrorText(null), /原有文字仍在/);
});
