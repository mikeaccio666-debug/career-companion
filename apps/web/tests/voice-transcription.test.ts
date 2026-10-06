import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { appendTranscriptionText, MAX_TRANSCRIPTION_AUDIO_BYTES, transcribeAudio, transcriptionForm } from '../src/voice-transcription.ts';

test('actual multipart HTTP sends selected provider and audio without exposing the original filename', async () => {
  let multipart = '', contentType = '';
  const server = createServer(async (request, response) => {
    contentType = request.headers['content-type'] || '';
    for await (const chunk of request) multipart += chunk.toString();
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ text: 'Fictional course project.' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const file = new File(['fictional encoded audio fixture'], 'fictional-personal-filename.wav', { type: 'audio/wav' });
    const controller = new AbortController();
    const result = await transcribeAudio(file, 'local-fixture', controller.signal, async (path, init) => {
      assert.equal(path, '/voice/transcribe'); assert.equal(init.signal, controller.signal);
      return (await fetch(`http://127.0.0.1:${address.port}`, init)).json();
    });
    assert.equal(result, 'Fictional course project.');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(multipart, /name="file"; filename="recording.wav"/);
    assert.match(multipart, /name="provider"\r\n\r\nlocal-fixture/);
    assert.doesNotMatch(multipart, /fictional-personal-filename/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('invalid audio is rejected before upload and empty browser MIME is inferred only for known audio extensions', async () => {
  let calls = 0;
  const send = async () => { calls++; return { text: '' }; };
  for (const audio of [new Blob([], { type: 'audio/wav' }), new Blob(['fictional'], { type: 'text/plain' }), new Blob(['fictional'], { type: 'constructor' }), new Blob([new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)], { type: 'audio/wav' })]) {
    await assert.rejects(transcribeAudio(audio, 'fixture', new AbortController().signal, send));
  }
  assert.equal(calls, 0);
  const form = transcriptionForm(new File(['fictional'], 'fictional.WAV'), 'fixture');
  assert.equal((form.get('file') as File).type, 'audio/wav'); assert.equal((form.get('file') as File).name, 'recording.wav');
  assert.throws(() => transcriptionForm(new File(['fictional'], 'fictional.txt'), 'fixture'));
  assert.equal((transcriptionForm(new Blob(['fixture'], { type: 'audio/webm;codecs=opus' }), 'fixture').get('file') as File).type, 'audio/webm');
  for (const [original, canonical] of [['video/webm', 'audio/webm'], ['audio/x-m4a', 'audio/mp4'], ['audio/mp3', 'audio/mpeg'], ['audio/vnd.wave', 'audio/wav']]) assert.equal((transcriptionForm(new Blob(['fixture'], { type: original }), 'fixture').get('file') as File).type, canonical);
});

test('silence returns no added text while malformed and excessive responses leave the editor unchanged', async () => {
  const audio = new Blob(['fixture'], { type: 'audio/wav' }), signal = new AbortController().signal;
  assert.equal(await transcribeAudio(audio, 'fixture', signal, async () => ({ text: '' })), '');
  assert.equal(appendTranscriptionText('Original fictional draft.', ''), 'Original fictional draft.');
  for (const response of [null, [], { text: 1 }, { text: '\u0000' }, { text: '中'.repeat(22000) }]) await assert.rejects(transcribeAudio(audio, 'fixture', signal, async () => response));
  assert.equal(appendTranscriptionText('Original fictional draft.', 'Recognized phrase.'), 'Original fictional draft.\nRecognized phrase.');
  assert.throws(() => appendTranscriptionText('x'.repeat(7990), 'A longer recognized phrase.'), /8,000/);
});

test('an aborted request cannot publish a late transport result and pre-aborted input is never sent', async () => {
  const audio = new Blob(['fixture'], { type: 'audio/wav' }), early = new AbortController(); early.abort();
  let calls = 0;
  await assert.rejects(transcribeAudio(audio, 'fixture', early.signal, async () => { calls++; return { text: 'Late text.' }; }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController(); let finish!: (value: unknown) => void;
  const pending = transcribeAudio(audio, 'fixture', controller.signal, async () => new Promise(resolve => { finish = resolve; }));
  controller.abort(); finish({ text: 'Late fictional text.' });
  await assert.rejects(pending, { name: 'AbortError' });
});
