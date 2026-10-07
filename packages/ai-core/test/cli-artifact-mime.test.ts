import test from 'node:test';
import assert from 'node:assert/strict';
import { cliMediaMime } from '../src/cli-artifact-mime.ts';

test('CLI MP4/M4A recognition requires a bounded complete ftyp box and recognized brand', () => {
  const bytes = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');
  assert.equal(cliMediaMime('.mp4', bytes), 'video/mp4'); assert.equal(cliMediaMime('.m4a', bytes), 'audio/mp4');
  assert.equal(cliMediaMime('.mp4', bytes.subarray(0, 18)), undefined);
  const invalid = Buffer.from(bytes); invalid.writeUInt32BE(8192, 0); assert.equal(cliMediaMime('.mp4', invalid), undefined);
  assert.equal(cliMediaMime('.mp4', Buffer.from('<html>fictional</html>')), undefined);
  assert.equal(cliMediaMime('.html', bytes), undefined);
});
test('WebM recognition checks EBML header DocType and rejects malformed or different container headers', () => {
  const bytes = Buffer.from('1a45dfa3874282847765626d', 'hex');
  assert.equal(cliMediaMime('.webm', bytes), 'video/webm'); assert.equal(cliMediaMime('.weba', bytes), 'audio/webm');
  for (const value of ['1a45dfa3874282846e6f7065', '1a45dfa3884282847765626d', '1a45dfa3874282857765626d', '1a45dfa3004282847765626d'])
    assert.equal(cliMediaMime('.webm', Buffer.from(value, 'hex')), undefined);
});
test('WAV recognition verifies RIFF size and complete nonempty format/data chunks', () => {
  const bytes = Buffer.alloc(46); bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
  assert.equal(cliMediaMime('.wav', bytes), 'audio/wav');
  const empty = Buffer.from(bytes); empty.writeUInt32LE(0, 40); assert.equal(cliMediaMime('.wav', empty), undefined);
  assert.equal(cliMediaMime('.wav', bytes.subarray(0, 44)), undefined);
});
