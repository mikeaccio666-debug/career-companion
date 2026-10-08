import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { ApiError } from '../src/errors.ts';
import { readDataCrypto, type DataCrypto } from '../src/data-crypto.ts';
import { COMPANION_SEAL_PNG_MAX_BYTES, COMPANION_SEAL_SVG_MAX_BYTES, createCompanionSealRenderer,
  type CompanionSealRendered } from '../src/companion-seal-rendering.ts';
import { openCompanionBirthAssets, parseCompanionBirthAssetSnapshot, sealCompanionBirthAssets,
  type CompanionBirthAssetCoordinates, type CompanionBirthAssetRow, type CompanionBirthAssetSnapshot,
} from '../src/companion-birth-assets.ts';

// Actual native renders of fictional shapes, not font/review/admission evidence.
const FICTIONAL_PATH = 'M10 10H90V90H10Z';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: '46'.repeat(32) })!;
const glyphSource = sha('fictional-birth-asset-pack');
const at: CompanionBirthAssetCoordinates = Object.freeze({
  id: '5d7db69c-b29c-4b7d-8f1d-87a64fd79b18', ownerId: 'eb0bcb8a-f337-42bd-a42d-9c18c3140808',
  companionId: '18f94a3e-b146-49be-a69a-2807d9e2d0ad', birthReceiptId: 'eead56cd-ae0a-4806-90a2-ccf3a982408f',
  bornAt: '2026-10-08T07:00:00.123Z', sealChar: '墨', inkToken: 'dai',
});
const renderer = createCompanionSealRenderer({ lookup: char => char === '墨' ? { path: FICTIONAL_PATH, assetDigest: glyphSource } : null });
let native: Promise<Readonly<CompanionSealRendered>> | undefined;
const render = () => native ??= renderer.render({ sealChar: at.sealChar, inkToken: at.inkToken });
const code = (error: unknown) => error instanceof ApiError && error.status === 503
  && error.code === 'COMPANION_BIRTH_ASSETS_UNAVAILABLE'
  && error.message === 'The protected companion seal could not be confirmed.' && !Object.hasOwn(error, 'cause');
const pngBinding = { table: 'platform_companion_birth_assets', column: 'png_base64_ciphertext',
  rowId: at.id, ownerId: at.ownerId, revision: 1 };
const svgBinding = { ...pngBinding, column: 'svg_ciphertext' };
function replacePngText(row: CompanionBirthAssetRow, snapshot: CompanionBirthAssetSnapshot, text: string) {
  const bytes = crypto.sealUtf8(text, pngBinding);
  return { row: { ...row, png_base64_ciphertext: bytes }, snapshot: { ...snapshot, pngCipherDigest: sha(bytes) } };
}
function replaceSvgText(row: CompanionBirthAssetRow, snapshot: CompanionBirthAssetSnapshot, text: string) {
  const bytes = crypto.sealUtf8(text, svgBinding);
  return { row: { ...row, svg_ciphertext: bytes }, snapshot: { ...snapshot, svgCipherDigest: sha(bytes) } };
}
function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'latin1');
  data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function imageData(png: Buffer) {
  const parts: Buffer[] = [];
  for (let pos = 8; pos < png.length;) {
    const length = png.readUInt32BE(pos);
    if (png.toString('latin1', pos + 4, pos + 8) === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + length));
    pos += 12 + length;
  }
  const compressed = Buffer.concat(parts);
  return { compressed, raw: inflateSync(compressed), repack: (bytes: Buffer) => Buffer.concat([
    png.subarray(0, 33), chunk('IDAT', bytes), chunk('IEND', Buffer.alloc(0)),
  ]) };
}

test('real native dual bytes survive actual AES-GCM storage with exact immutable metadata and column AAD', async () => {
  const rendered = await render(), { row, snapshot } = sealCompanionBirthAssets(crypto, at, rendered);
  const reopened = openCompanionBirthAssets(crypto, row, snapshot);
  assert(reopened.svg.equals(rendered.svg), 'the original native SVG must roundtrip');
  assert(reopened.png.equals(rendered.png), 'the original native PNG must roundtrip');
  assert.equal(reopened.pathSha256, sha(FICTIONAL_PATH)); assert.equal(reopened.glyphAssetDigest, glyphSource);
  assert.equal(row.svg_ciphertext.length, rendered.svg.length + 29);
  assert.equal(row.png_base64_ciphertext.length, rendered.png.toString('base64').length + 29);
  assert.equal(snapshot.svgCipherDigest, sha(row.svg_ciphertext)); assert.equal(snapshot.pngCipherDigest, sha(row.png_base64_ciphertext));
  assert(crypto.openUtf8(row.svg_ciphertext, svgBinding) === rendered.svg.toString('utf8'), 'SVG plaintext must be exact');
  assert(crypto.openUtf8(row.png_base64_ciphertext, pngBinding) === rendered.png.toString('base64'), 'PNG encoding must be exact');
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(row)); assert(Object.isFrozen(reopened));
  assert.equal(row.created_at.toISOString(), at.bornAt);
});

test('write and read copy native buffers; a crypto callback cannot change the second plaintext after capture', async () => {
  const original = await render(), svg = Buffer.from(original.svg), png = Buffer.from(original.png);
  let calls = 0;
  const intervening: DataCrypto = { ...crypto, sealUtf8(text, binding) {
    calls++; svg.fill(0); png.fill(0); return crypto.sealUtf8(text, binding);
  } };
  const { row, snapshot } = sealCompanionBirthAssets(intervening, at, { ...original, svg, png });
  assert.equal(calls, 2);
  const read = openCompanionBirthAssets(crypto, row, snapshot);
  assert(read.svg.equals(original.svg), 'captured SVG must not share a caller buffer');
  assert(read.png.equals(original.png), 'captured PNG must not share a caller buffer');
  read.svg.fill(0); read.png.fill(0);
  const again = openCompanionBirthAssets(crypto, row, snapshot);
  assert.equal(again.svgSha256, sha(again.svg)); assert.equal(again.pngSha256, sha(again.png));
});

test('missing key/row and corrupted bytes have the same bounded unavailable result with no partial read', async () => {
  const rendered = await render(), { row, snapshot } = sealCompanionBirthAssets(crypto, at, rendered);
  assert.throws(() => sealCompanionBirthAssets(undefined, at, rendered), code);
  for (const missing of [null, undefined, {}, { ...row, svg_ciphertext: null }, { ...row, png_base64_ciphertext: null }]) {
    assert.throws(() => openCompanionBirthAssets(crypto, missing, snapshot), code);
  }
  assert.throws(() => openCompanionBirthAssets(undefined, row, snapshot), code);
  for (const column of ['svg_ciphertext', 'png_base64_ciphertext'] as const) {
    const bytes = Buffer.from(row[column]); bytes[bytes.length - 1] ^= 1;
    const forgedSnapshot = { ...snapshot, [column === 'svg_ciphertext' ? 'svgCipherDigest' : 'pngCipherDigest']: sha(bytes) };
    assert.throws(() => openCompanionBirthAssets(crypto, { ...row, [column]: bytes }, forgedSnapshot), code);
  }
});

test('actual AEAD rejects owner/asset moves and wrong table, column or schema even with new envelope digests', async () => {
  const rendered = await render(), { row, snapshot } = sealCompanionBirthAssets(crypto, at, rendered);
  const other = '07cf3ad5-4867-44c0-b1ae-3156657b4cfb';
  assert.throws(() => openCompanionBirthAssets(crypto, { ...row, user_id: other }, { ...snapshot, ownerId: other }), code);
  assert.throws(() => openCompanionBirthAssets(crypto, { ...row, id: other }, { ...snapshot, id: other }), code);
  for (const changed of [{ table: 'platform_companion_birth_receipts' }, { column: 'png_base64_ciphertext' }, { revision: 2 }]) {
    const bytes = crypto.sealUtf8(rendered.svg.toString('utf8'), { ...svgBinding, ...changed });
    assert.throws(() => openCompanionBirthAssets(crypto, { ...row, svg_ciphertext: bytes }, { ...snapshot, svgCipherDigest: sha(bytes) }), code);
  }
});

test('all owner/origin/character/color/time and declared content metadata are matched against the authenticated expected snapshot', async () => {
  const { row, snapshot } = sealCompanionBirthAssets(crypto, at, await render());
  const other = '07cf3ad5-4867-44c0-b1ae-3156657b4cfb';
  const changes = { id: other, user_id: other, companion_id: other, birth_receipt_id: other, seal_char: '舟', ink_token: 'hehui',
    renderer_version: 'resvg-js-0', glyph_source_digest: sha('fictional-other-pack'), svg_digest: sha('fictional-other-svg'),
    png_digest: sha('fictional-other-png'), assets_schema_version: 2, svg_size_bytes: row.svg_size_bytes + 1,
    png_size_bytes: row.png_size_bytes + 1, created_at: new Date('2026-10-08T07:00:00.124Z') };
  for (const [key, value] of Object.entries(changes)) assert.throws(() => openCompanionBirthAssets(crypto, { ...row, [key]: value }, snapshot), code);
  for (const [key, value] of Object.entries({ pathDigest: sha('fictional-other-path'), svgDigest: sha('fictional-other-svg'),
    pngDigest: sha('fictional-other-png'), svgCipherDigest: sha('fictional-new-envelope'), pngCipherDigest: sha('fictional-new-envelope') })) {
    assert.throws(() => openCompanionBirthAssets(crypto, row, { ...snapshot, [key]: value }), code);
  }
  // Even an AEAD-valid replacement of the same bytes has a distinct immutable
  // envelope. It is not silently repaired or adopted as the original asset.
  const bytes = crypto.sealUtf8((await render()).svg.toString('utf8'), svgBinding);
  assert.throws(() => openCompanionBirthAssets(crypto, { ...row, svg_ciphertext: bytes }, snapshot), code);
});

test('canonical PNG base64 rejects whitespace, URL alphabet and nonzero pad bits after real authenticated decryption', async () => {
  let rendered = await render();
  // Recompress the actual native scanlines when necessary to exercise padding.
  if (rendered.png.length % 3 === 0) {
    const data = imageData(rendered.png);
    for (let level = 0; level <= 9; level++) {
      const png = data.repack(deflateSync(data.raw, { level }));
      if (png.length <= COMPANION_SEAL_PNG_MAX_BYTES && png.length % 3) {
        rendered = { ...rendered, png, pngSha256: sha(png), pngByteLength: png.length }; break;
      }
    }
  }
  const { row, snapshot } = sealCompanionBirthAssets(crypto, at, rendered), base64 = rendered.png.toString('base64');
  assert(base64.endsWith('='), 'a real PNG with padding must exercise the pad-bit counterexample');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', index = base64.search(/=+$/) - 1;
  const padBits = base64.slice(0, index) + alphabet[alphabet.indexOf(base64[index]) ^ 1] + base64.slice(index + 1);
  assert(Buffer.from(padBits, 'base64').equals(rendered.png), 'the counterexample must decode to the same native image');
  for (const encoded of [' ' + base64.slice(1), '-' + base64.slice(1), padBits]) {
    const changed = replacePngText(row, snapshot, encoded);
    assert.throws(() => openCompanionBirthAssets(crypto, changed.row, changed.snapshot), code);
  }
});

test('fixed SVG ink/path and UTF-8 template are validated on write and authenticated read, without XML sanitizing', async () => {
  const rendered = await render(), text = rendered.svg.toString('utf8');
  for (const svg of [Buffer.from(text.replace('#4D635B', '#695B53')), Buffer.from(text.replace(' d="', ' onclick="x" d="')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rendered.svg]), Buffer.from('<svg>fictional</svg>'), Buffer.from([0xc3, 0x28])]) {
    const forged = { ...rendered, svg, svgSha256: sha(svg), svgByteLength: svg.length };
    assert.throws(() => sealCompanionBirthAssets(crypto, at, forged), code);
    const stored = sealCompanionBirthAssets(crypto, at, rendered), changed = replaceSvgText(stored.row, stored.snapshot, svg.toString('utf8'));
    const expected = { ...changed.snapshot, svgDigest: sha(svg), svgSizeBytes: svg.length };
    assert.throws(() => openCompanionBirthAssets(crypto, { ...changed.row, svg_digest: expected.svgDigest, svg_size_bytes: svg.length }, expected), code);
  }
  assert.throws(() => sealCompanionBirthAssets(crypto, at, { ...rendered, pathSha256: sha('fictional-wrong-path') }), code);
});

test('CRC-valid IDAT tails, second streams and header-shaped nonimages cannot be encrypted as native assets or read back', async () => {
  const rendered = await render(), data = imageData(rendered.png);
  const corrupt = Buffer.from(rendered.png); corrupt[corrupt.length - 5] ^= 1;
  for (const png of [data.repack(Buffer.concat([data.compressed, Buffer.from('fictional-hidden-IDAT-tail')])),
    data.repack(Buffer.concat([data.compressed, deflateSync(Buffer.from('fictional-second-stream'))])), corrupt, rendered.png.subarray(0, 33)]) {
    assert.throws(() => sealCompanionBirthAssets(crypto, at, { ...rendered, png, pngSha256: sha(png), pngByteLength: png.length }), code);
    const stored = sealCompanionBirthAssets(crypto, at, rendered), ciphertext = crypto.sealUtf8(png.toString('base64'), pngBinding);
    const snapshot = { ...stored.snapshot, pngDigest: sha(png), pngSizeBytes: png.length, pngCipherDigest: sha(ciphertext) };
    const row = { ...stored.row, png_digest: snapshot.pngDigest, png_size_bytes: png.length, png_base64_ciphertext: ciphertext };
    assert.throws(() => openCompanionBirthAssets(crypto, row, snapshot), code);
  }
});

test('closed snapshot/row/render inputs reject hidden fields, accessors and noncanonical coordinates without invoking getters', async () => {
  const rendered = await render(), { row, snapshot } = sealCompanionBirthAssets(crypto, at, rendered); let reads = 0;
  const accessor = { ...snapshot }; Object.defineProperty(accessor, 'pathDigest', { enumerable: true, get() { reads++; return snapshot.pathDigest; } });
  const hidden = { ...snapshot }; Object.defineProperty(hidden, 'authority', { value: true });
  for (const value of [accessor, hidden, { ...snapshot, [Symbol('fictional')]: true }, { ...snapshot, ownerId: at.ownerId.toUpperCase() },
    { ...snapshot, bornAt: '2026-02-30T07:00:00.123Z' }, { ...snapshot, bornAt: at.bornAt.replace('Z', '+00:00') },
    { ...snapshot, glyphSourceDigest: glyphSource + '\n' }, { ...snapshot, svgSizeBytes: -0 }, { ...snapshot, svgSizeBytes: COMPANION_SEAL_SVG_MAX_BYTES + 1 },
    { ...snapshot, pngSizeBytes: COMPANION_SEAL_PNG_MAX_BYTES + 1 }, { ...snapshot, templateVersion: 'fictional-v2' }]) {
    assert.throws(() => parseCompanionBirthAssetSnapshot(value), code);
  }
  const invalidRow = { ...row }; Object.defineProperty(invalidRow, 'svg_ciphertext', { enumerable: true, get() { reads++; return row.svg_ciphertext; } });
  assert.throws(() => openCompanionBirthAssets(crypto, invalidRow, snapshot), code);
  const invalidRender = { ...rendered }; Object.defineProperty(invalidRender, 'png', { enumerable: true, get() { reads++; return rendered.png; } });
  assert.throws(() => sealCompanionBirthAssets(crypto, at, invalidRender), code); assert.equal(reads, 0);
  assert.throws(() => sealCompanionBirthAssets(crypto, { ...at, inkToken: '#4D635B' } as never, rendered), code);
});

test('every fixed light ink is compared to its actual native bytes, and oversized or misdeclared render results fail', async () => {
  for (const inkToken of ['yanzhi', 'zheshi', 'ganlan', 'jiangzi', 'dai', 'yanzi', 'hehui'] as const) {
    const rendered = await renderer.render({ sealChar: at.sealChar, inkToken }), coords = { ...at, inkToken };
    const saved = sealCompanionBirthAssets(crypto, coords, rendered);
    assert.equal(openCompanionBirthAssets(crypto, saved.row, saved.snapshot).pngSha256, rendered.pngSha256);
  }
  const rendered = await render();
  for (const change of [{ width: 256 }, { rendererVersion: 'resvg-js-2.0.0' }, { glyphAssetDigest: 'approved' },
    { svgByteLength: rendered.svg.length + 1 }, { pngByteLength: rendered.png.length + 1 },
    { svg: Buffer.alloc(COMPANION_SEAL_SVG_MAX_BYTES + 1) }, { png: Buffer.alloc(COMPANION_SEAL_PNG_MAX_BYTES + 1) }]) {
    assert.throws(() => sealCompanionBirthAssets(crypto, at, { ...rendered, ...change } as never), code);
  }
});
