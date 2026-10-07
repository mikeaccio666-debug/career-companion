import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserVoiceRecording, RECORDING_MIME_TYPES, supportedRecordingMimeType, type RecordingRecorder, type VoiceRecordingCallbacks } from '../src/voice-recording.ts';
import { MAX_TRANSCRIPTION_AUDIO_BYTES, transcriptionForm } from '../src/voice-transcription.ts';

class FictionalTrack {
  readyState = 'live';
  stops = 0;
  throwOnStop = false;
  listeners = new Set<EventListener>();
  addEventListener(type: string, listener: EventListener) { if (type === 'ended') this.listeners.add(listener); }
  removeEventListener(type: string, listener: EventListener) { if (type === 'ended') this.listeners.delete(listener); }
  stop() { this.stops++; this.readyState = 'ended'; if (this.throwOnStop) throw new Error('Fictional private track failure.'); }
  end() { this.readyState = 'ended'; for (const listener of [...this.listeners]) listener(new Event('ended')); }
}
class FictionalRecorder implements RecordingRecorder {
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: MediaRecorder['ondataavailable'] = null;
  onstop: MediaRecorder['onstop'] = null;
  onerror: MediaRecorder['onerror'] = null;
  starts: number[] = [];
  stops = 0;
  throwOnStart = false;
  throwOnStop = false;
  delayStop = false;
  finalChunk: Blob | null = null;
  duringStart: (() => void) | null = null;
  start(timeslice?: number) {
    this.starts.push(timeslice!); this.state = 'recording';
    if (this.throwOnStart) throw new Error('Fictional private browser startup failure.');
    this.duringStart?.();
  }
  stop() {
    this.stops++;
    if (this.throwOnStop) throw new Error('Fictional private browser stop failure.');
    if (this.finalChunk) this.data(this.finalChunk);
    this.state = 'inactive';
    if (!this.delayStop) this.stopped();
  }
  data(data: Blob) { this.ondataavailable?.call(this as unknown as MediaRecorder, { data } as BlobEvent); }
  stopped() { this.onstop?.call(this as unknown as MediaRecorder, new Event('stop')); }
  errored() { this.onerror?.call(this as unknown as MediaRecorder, new Event('error')); }
}
function setup(options: { mime?: string; supported?: (mime: string) => boolean; maximum?: number; tracks?: FictionalTrack[]; construct?: () => FictionalRecorder } = {}) {
  const tracks = options.tracks ?? [new FictionalTrack(), new FictionalTrack()];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const recorder = new FictionalRecorder(); if (options.mime !== undefined) recorder.mimeType = options.mime;
  let current = true;
  const events: string[] = [], audio: Blob[] = [], errors: string[] = [], requested: string[] = [];
  const callbacks: VoiceRecordingCallbacks = {
    isCurrent: () => current,
    onStopped: () => { events.push('stopped'); },
    onComplete: (value) => { events.push('complete'); audio.push(value); },
    onError: (message) => { events.push('error'); errors.push(message); },
  };
  const recording = new BrowserVoiceRecording(stream, callbacks, {
    isTypeSupported: options.supported ?? ((mime) => mime === RECORDING_MIME_TYPES[0]),
    createRecorder: (_, configuration) => { requested.push(configuration.mimeType!); return options.construct ? options.construct() : recorder; },
    maxBytes: options.maximum,
  });
  return { recording, recorder, tracks, events, audio, errors, requested, callbacks, stale: () => { current = false; } };
}
function released(value: ReturnType<typeof setup>) {
  assert.equal(value.recorder.ondataavailable, null);
  assert.equal(value.recorder.onstop, null);
  assert.equal(value.recorder.onerror, null);
  for (const track of value.tracks) { assert.equal(track.stops, 1); assert.equal(track.listeners.size, 0); }
}

test('MIME negotiation selects only accepted containers and one throwing probe does not hide Safari-style MP4 support', () => {
  const checked: string[] = [];
  assert.equal(supportedRecordingMimeType((mime) => { checked.push(mime); if (mime.startsWith('audio/webm')) throw new Error('Fictional broken probe.'); return mime === 'audio/mp4'; }), 'audio/mp4');
  assert.deepEqual(checked, RECORDING_MIME_TYPES.slice(0, 3));
  assert.equal(supportedRecordingMimeType(() => false), '');
  assert.equal(supportedRecordingMimeType(() => { throw new Error('Fictional probe failure.'); }), '');
  assert.equal(supportedRecordingMimeType((mime) => mime === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus');
});

test('explicit stop completes one bounded multipart-compatible recording, including the final chunk, after releasing the microphone', async () => {
  const value = setup(); value.recording.start();
  assert.deepEqual(value.requested, ['audio/webm;codecs=opus']); assert.deepEqual(value.recorder.starts, [1000]);
  value.recorder.data(new Blob(['Fictional first chunk.'], { type: 'audio/webm;codecs=opus' }));
  value.recorder.finalChunk = new Blob([' Final fixture chunk.'], { type: 'audio/webm' });
  value.recording.stop(); value.recording.stop(); value.recording.start();
  assert.deepEqual(value.events, ['stopped', 'complete']); assert.equal(value.errors.length, 0); assert.equal(value.audio.length, 1);
  assert.equal(value.audio[0].type, 'audio/webm'); assert.equal(await value.audio[0].text(), 'Fictional first chunk. Final fixture chunk.');
  const uploaded = transcriptionForm(value.audio[0]).get('file') as File;
  assert.equal(uploaded.name, 'recording.webm'); assert.equal(uploaded.type, 'audio/webm');
  assert.equal(value.recorder.stops, 1); released(value);
});

test('MP4 and Ogg recordings retain their actual container and multipart extension', () => {
  for (const [mime, extension] of [['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg']]) {
    const value = setup({ mime, supported: (candidate) => candidate === mime }); value.recording.start();
    value.recorder.data(new Blob(['Fictional encoded bytes.'], { type: mime })); value.recording.stop();
    assert.equal(value.audio[0].type, mime.split(';')[0]);
    assert.equal((transcriptionForm(value.audio[0]).get('file') as File).name, `recording.${extension}`);
    released(value);
  }
});

test('unknown/empty MIME is never relabeled WebM; chunk MIME may establish an explicitly recorded supported container', () => {
  for (const mode of ['unknown-recorder', 'unknown-chunk', 'all-empty', 'conflicting-containers']) {
    const value = setup({ mime: mode === 'unknown-recorder' ? 'audio/unknown' : mode === 'all-empty' ? '' : 'audio/webm' });
    value.recording.start();
    value.recorder.data(new Blob(['Fictional bytes.'], { type: mode === 'unknown-chunk' ? 'text/plain' : mode === 'conflicting-containers' ? 'audio/mp4' : '' }));
    value.recording.stop(); assert.equal(value.audio.length, 0, mode); assert.equal(value.errors.length, 1, mode); assert.match(value.errors[0], /录音格式/); released(value);
  }
  const value = setup({ mime: '' }); value.recording.start();
  value.recorder.data(new Blob(['Fictional identified container.'], { type: 'audio/mp4' })); value.recording.stop();
  assert.equal(value.audio[0].type, 'audio/mp4'); released(value);
});

test('an error followed by captured data/stop callbacks discards partial audio and emits one generic terminal result', () => {
  const value = setup(); value.recording.start();
  value.recorder.data(new Blob(['Fictional earlier partial chunk.'], { type: 'audio/webm' }));
  const data = value.recorder.ondataavailable!, stopped = value.recorder.onstop!, error = value.recorder.onerror!;
  value.recorder.errored();
  data.call(value.recorder as unknown as MediaRecorder, { data: new Blob(['Fictional late fragment.'], { type: 'audio/webm' }) } as BlobEvent);
  stopped.call(value.recorder as unknown as MediaRecorder, new Event('stop'));
  error.call(value.recorder as unknown as MediaRecorder, new Event('error'));
  value.recording.stop(); value.recording.cancel();
  assert.deepEqual(value.events, ['stopped', 'error']); assert.equal(value.audio.length, 0); assert.match(value.errors[0], /中断.*未上传/); released(value);
});

test('an ended track or an unrequested native stop discards the recording even when other tracks remain live', () => {
  for (const mode of ['track', 'native-stop', 'already-ended']) {
    const value = setup(); if (mode === 'already-ended') value.tracks[0].readyState = 'ended';
    value.recording.start(); value.recorder.data(new Blob(['Fictional partial audio.'], { type: 'audio/webm' }));
    if (mode === 'track') value.tracks[0].end();
    if (mode === 'native-stop') { value.recorder.state = 'inactive'; value.recorder.stopped(); }
    value.recording.stop(); assert.equal(value.audio.length, 0, mode); assert.equal(value.errors.length, 1, mode); released(value);
  }
});

test('cancel and stale editor events release recording resources silently; late events cannot upload', () => {
  for (const mode of ['cancel', 'stale-data', 'stale-stop', 'stale-error', 'stale-start', 'cancel-before-start']) {
    const value = setup();
    if (mode === 'stale-start') value.stale();
    if (mode === 'cancel-before-start') value.recording.cancel();
    value.recording.start(); const data = value.recorder.ondataavailable, stop = value.recorder.onstop;
    if (mode === 'cancel') value.recording.cancel();
    if (mode.startsWith('stale-')) value.stale();
    if (mode === 'stale-data') value.recorder.data(new Blob(['Fictional stale chunk.'], { type: 'audio/webm' }));
    if (mode === 'stale-stop') value.recording.stop();
    if (mode === 'stale-error') value.recorder.errored();
    data?.call(value.recorder as unknown as MediaRecorder, { data: new Blob(['Fictional late chunk.'], { type: 'audio/webm' }) } as BlobEvent);
    stop?.call(value.recorder as unknown as MediaRecorder, new Event('stop'));
    value.recording.cancel(); assert.deepEqual(value.events, [], mode); assert.equal(value.audio.length, 0, mode); released(value);
  }
});

test('byte overflow, including a final stop chunk, discards everything while an exact limit can complete', () => {
  for (const final of [false, true]) {
    const value = setup({ maximum: 3 }); value.recording.start(); value.recorder.data(new Blob(['abc'], { type: 'audio/webm' }));
    if (final) { value.recorder.finalChunk = new Blob(['d'], { type: 'audio/webm' }); value.recording.stop(); }
    else value.recorder.data(new Blob(['d'], { type: 'audio/webm' }));
    assert.equal(value.audio.length, 0); assert.deepEqual(value.events, ['stopped', 'error']); assert.match(value.errors[0], /20 MiB.*未上传/); released(value);
  }
  const value = setup({ maximum: 3 }); value.recording.start(); value.recorder.data(new Blob(['abc'], { type: 'audio/webm' })); value.recording.stop();
  assert.equal(value.audio[0].size, 3); released(value);
});

test('injected limits cannot enlarge the actual 20 MiB upload boundary', () => {
  const value = setup({ maximum: MAX_TRANSCRIPTION_AUDIO_BYTES + 1 }); value.recording.start();
  value.recorder.data(new Blob([new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)], { type: 'audio/webm' }));
  assert.equal(value.audio.length, 0); assert.equal(value.errors.length, 1); released(value);
});

test('constructor, start and stop failures release every track, never expose private browser details and never complete', () => {
  for (const mode of ['constructor', 'start', 'stop']) {
    const tracks = [new FictionalTrack(), new FictionalTrack()]; tracks[0].throwOnStop = true;
    const value = setup({ tracks, ...(mode === 'constructor' ? { construct: () => { throw new Error('Fictional private constructor detail.'); } } : {}) });
    value.recorder.throwOnStart = mode === 'start'; value.recorder.throwOnStop = mode === 'stop';
    value.recording.start(); value.recording.stop(); value.recording.cancel();
    assert.deepEqual(value.events, ['stopped', 'error'], mode); assert.equal(value.audio.length, 0, mode);
    assert.doesNotMatch(value.errors[0], /Fictional|private|constructor|browser/, mode); released(value);
  }
});

test('unsupported capture, empty audio and invalid limit cannot dispatch a successful completion', () => {
  for (const mode of ['unsupported', 'empty', 'limit']) {
    const value = setup({ ...(mode === 'unsupported' ? { supported: () => false } : {}), ...(mode === 'limit' ? { maximum: 0 } : {}) });
    value.recording.start(); value.recording.stop();
    assert.equal(value.audio.length, 0, mode); assert.equal(value.errors.length, 1, mode); released(value);
    if (mode !== 'empty') assert.equal(value.requested.length, 0, mode);
  }
});

test('a delayed native stop only completes once and stale completion stays silent', () => {
  for (const stale of [false, true]) {
    const value = setup(); value.recorder.delayStop = true; value.recording.start(); value.recorder.data(new Blob(['Fictional bytes.'], { type: 'audio/webm' }));
    const stopped = value.recorder.onstop!; value.recording.stop(); value.recording.stop();
    assert.equal(value.recorder.stops, 1); assert.deepEqual(value.events, []);
    if (stale) value.stale();
    stopped.call(value.recorder as unknown as MediaRecorder, new Event('stop')); stopped.call(value.recorder as unknown as MediaRecorder, new Event('stop'));
    assert.deepEqual(value.events, stale ? [] : ['stopped', 'complete']); assert.equal(value.audio.length, stale ? 0 : 1); released(value);
  }
});

test('callback failures cannot prevent cleanup or create an unhandled rejection', async () => {
  const value = setup();
  value.callbacks.onStopped = () => { throw new Error('Fictional callback failure.'); };
  value.callbacks.onComplete = async () => { throw new Error('Fictional asynchronous callback failure.'); };
  value.recording.start(); value.recorder.data(new Blob(['Fictional bytes.'], { type: 'audio/webm' }));
  assert.doesNotThrow(() => value.recording.stop()); released(value);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('a stopped callback which switches account prevents completion from publishing into the next editor', () => {
  const value = setup(); value.callbacks.onStopped = () => { value.events.push('stopped'); value.stale(); };
  value.recording.start(); value.recorder.data(new Blob(['Fictional bytes.'], { type: 'audio/webm' })); value.recording.stop();
  assert.deepEqual(value.events, ['stopped']); assert.equal(value.audio.length, 0); released(value);
});

test('synchronous cancellation or track failure during construction/start cannot leave an orphan recorder', () => {
  for (const mode of ['construct-end', 'start-end', 'start-cancel']) {
    const orphan = new FictionalRecorder(); orphan.state = 'recording';
    const value = setup({ ...(mode === 'construct-end' ? { construct: () => { value.tracks[0].end(); return orphan; } } : {}) });
    if (mode === 'start-end') value.recorder.duringStart = () => value.tracks[0].end();
    if (mode === 'start-cancel') value.recorder.duringStart = () => value.recording.cancel();
    value.recording.start();
    assert.equal(value.audio.length, 0, mode); assert.deepEqual(value.events, mode === 'start-cancel' ? [] : ['stopped', 'error'], mode);
    released(value); if (mode === 'construct-end') { assert.equal(orphan.stops, 1); assert.equal(orphan.ondataavailable, null); }
  }
});
