import test from 'node:test';
import assert from 'node:assert/strict';
import { validatedComfyOutput } from '../src/comfyui-output.ts';
import { box, ebml, mp4, png, webm } from './fixtures/comfy-media.ts';

test('Comfy image output uses the actual header and matching declared MIME, never a filename', () => {
  assert.deepEqual(validatedComfyOutput('image', png, 'IMAGE/PNG; charset=binary', 0), { name: 'image-1.png', mime: 'image/png', bytes: png });
  for (const [bytes, mime] of [[Buffer.from([255,216,255,0]), 'image/jpeg'], [Buffer.from('RIFF0000WEBP'), 'image/webp']] as const) {
    assert.equal(validatedComfyOutput('image', bytes, mime, 1).mime, mime);
  }
  for (const [bytes, mime] of [[png, 'video/mp4'], [png, 'image/jpeg'], [png, null], [Buffer.from('<html>not an image</html>'), 'image/png'], [mp4(), 'image/png']] as const)
    assert.throws(() => validatedComfyOutput('image', bytes, mime, 0), { code: 'COMFYUI_OUTPUT_INVALID' });
});

test('WebP magic compares exact bytes instead of ASCII that masks high bits', () => {
  for(const offset of [0,1,2,3,8,9,10,11]){
    const forged=Buffer.from('RIFF0000WEBP');forged[offset]!|=128;
    assert.throws(()=>validatedComfyOutput('image',forged,'image/webp',0),{code:'COMFYUI_OUTPUT_INVALID'});
  }
});

test('MP4 output needs an MP4 container, a video handler/sample description, positive video samples and media data', () => {
  const bytes = mp4(); assert.equal(validatedComfyOutput('video', bytes, 'video/mp4', 0).name, 'video-1.mp4');
  for (const candidate of [mp4({handler:'soun'}), mp4({media:false}), mp4({dimensions:false}), mp4({sampleCount:0}), box('ftyp', Buffer.from('avif'), Buffer.alloc(4)),
    bytes.subarray(0, bytes.length - 1), Buffer.from('GIF89a'), png, Buffer.from('<video>fake</video>')])
    assert.throws(() => validatedComfyOutput('video', candidate, 'video/mp4', 0), { code: 'COMFYUI_OUTPUT_INVALID' });
  const invalidSize = Buffer.from(bytes); invalidSize.writeUInt32BE(0xfffffff0, 0);
  const invalidCount = Buffer.from(bytes); invalidCount.writeUInt32BE(2, invalidCount.indexOf('stsd') + 8);
  for (const value of [invalidSize, invalidCount]) assert.throws(() => validatedComfyOutput('video', value, 'video/mp4', 0), {code:'COMFYUI_OUTPUT_INVALID'});
  assert.throws(() => validatedComfyOutput('video', bytes, 'video/webm', 0), {code:'COMFYUI_OUTPUT_INVALID'});
});

test('MP4 rejects empty video tracks with audio data and accepts compact/fragmented positive video samples', () => {
  const emptyVideo = mp4({sampleCount:0}), audio = mp4({handler:'soun',trackId:2}), audioMovie = audio.indexOf('moov') - 4;
  assert.throws(() => validatedComfyOutput('video', Buffer.concat([emptyVideo, audio.subarray(audioMovie)]), 'video/mp4', 0), {code:'COMFYUI_OUTPUT_INVALID'});
  assert.equal(validatedComfyOutput('video', mp4({compactSamples:true}), 'video/mp4', 0).mime, 'video/mp4');
  assert.equal(validatedComfyOutput('video', mp4({fragmentTrack:1}), 'video/mp4', 0).mime, 'video/mp4');
  for (const value of [mp4({fragmentTrack:2}),mp4({fragmentTrack:1,fragmentCount:0}),mp4({handler:'soun',fragmentTrack:1}),mp4({sampleSize:0}),mp4({compactSamples:true,sampleSize:0})])
    assert.throws(() => validatedComfyOutput('video', value, 'video/mp4', 0), {code:'COMFYUI_OUTPUT_INVALID'});
});

test('MP4 supports bounded extended-size and final-to-EOF media boxes', () => {
  const bytes = mp4(), mdat = bytes.indexOf('mdat') - 4, prefix = bytes.subarray(0, mdat), payload = bytes.subarray(mdat + 8);
  const extended = Buffer.alloc(16); extended.writeUInt32BE(1); extended.write('mdat', 4); extended.writeBigUInt64BE(BigInt(payload.length + 16), 8);
  assert.equal(validatedComfyOutput('video', Buffer.concat([prefix, extended, payload]), 'video/mp4', 0).mime, 'video/mp4');
  const tail = Buffer.alloc(8); tail.write('mdat', 4);
  assert.equal(validatedComfyOutput('video', Buffer.concat([prefix, tail, payload]), 'video/mp4', 0).mime, 'video/mp4');
  extended.writeBigUInt64BE(2n ** 63n, 8);
  assert.throws(() => validatedComfyOutput('video', Buffer.concat([prefix, extended, payload]), 'video/mp4', 0), {code:'COMFYUI_OUTPUT_INVALID'});
});

test('WebM identifies a declared video track and a media block belonging to that track', () => {
  for (const options of [{}, {unknownSegment:true}, {unknownSegment:true,unknownCluster:true,twoClusters:true}, {group:true}])
    assert.equal(validatedComfyOutput('video', webm(options), 'video/webm; codecs="vp9"', 0).name, 'video-1.webm');
  for (const bytes of [webm({audio:true}), webm({docType:'matroska'}), webm({blockTrack:2}), webm({noFrame:true}), webm().subarray(0, webm().length - 1),
    Buffer.from([0x1a,0x45,0xdf,0xa3]), mp4(), png, ebml(0x1a45dfa3, ebml(0x4282, Buffer.from('webm')), true)])
    assert.throws(() => validatedComfyOutput('video', bytes, 'video/webm', 0), {code:'COMFYUI_OUTPUT_INVALID'});
  assert.throws(() => validatedComfyOutput('video', webm(), 'audio/webm', 0), {code:'COMFYUI_OUTPUT_INVALID'});
});

test('bounded container parsing rejects excessive element counts without external tools', () => {
  const bytes = Buffer.concat([mp4(), ...Array.from({length:65_536}, () => box('free'))]);
  assert.throws(() => validatedComfyOutput('video', bytes, 'video/mp4', 0), {code:'COMFYUI_OUTPUT_INVALID'});
});
