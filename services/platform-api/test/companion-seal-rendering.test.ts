import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { COMPANION_SEAL_PNG_MAX_BYTES, COMPANION_SEAL_SVG_MAX_BYTES, CompanionSealRenderingError,
  createCompanionSealRenderer, inspectCompanionSealPNG, readCompanionSealWorkerSVG,
  validateCompanionSealGlyphPath, type CompanionSealRenderInput } from '../src/companion-seal-rendering.ts';

// A fictional rectangle, never represented as Noto, a licensed production pack,
// an accepted tier-one list or an approved name/clinical review. No screenshots,
// private glyph downloads, names or runtime outputs are written into source.
const FICTIONAL_PATH = 'M10 10H90V90H10Z';
const FICTIONAL_ASSET_DIGEST = createHash('sha256').update('fictional-test-outline-pack-v1').digest('hex');
const input = Object.freeze({ sealChar: '墨', inkToken: 'dai' } as const);
function lookup(path = FICTIONAL_PATH) {
  return { lookup: (char: string) => char === '墨' ? { path, assetDigest: FICTIONAL_ASSET_DIGEST } : null };
}
function code(expected: string) {
  return (error: unknown) => error instanceof CompanionSealRenderingError && error.code === expected
    && error.message === 'The companion seal could not be rendered.' && !Object.hasOwn(error, 'cause');
}
function assertClosed(children: readonly ChildProcess[]) {
  for (const child of children) {
    assert(child.exitCode !== null || child.signalCode !== null, 'renderer must confirm real child termination');
    assert.equal(child.stdin?.destroyed, true);
    assert.equal(child.stdout?.destroyed, true);
    assert.equal(child.stderr?.destroyed, true);
  }
}
/** Rebuild real native image data with correct chunk CRCs. These counterexamples
 * exercise compressed-stream completeness, not a corrupt outer PNG header. */
function nativeImageData(png: Buffer) {
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const chunk = (type: string, bytes: Buffer) => {
    const output = Buffer.alloc(bytes.length + 12); output.writeUInt32BE(bytes.length);
    output.write(type, 4, 4, 'latin1'); bytes.copy(output, 8);
    output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4); return output;
  };
  return { compressed: Buffer.concat(data), withData: (...parts: Buffer[]) => Buffer.concat([
    png.subarray(0, 33), ...parts.map(bytes => chunk('IDAT', bytes)), chunk('IEND', Buffer.alloc(0)),
  ]) };
}
/** Intercepts the private spawn port, not the renderer input. The replacement is
 * a fictional actual process used to exercise the parent's native-worker
 * lifetime boundary. Production command/argv/env are inspected before replacing.
 */
function capture(t: TestContext, fictionalProgram?: string) {
  const original = childProcess.spawn.bind(childProcess), children: ChildProcess[] = [];
  t.mock.method(childProcess, 'spawn', ((command: string, args: readonly string[], options: SpawnOptions) => {
    assert.equal(command, process.execPath);
    assert.equal(args.length, 3);
    assert.deepEqual(args.slice(0, 2), ['--max-old-space-size=32', '--disable-warning=ExperimentalWarning']);
    assert.equal(args[2], fileURLToPath(new URL('../src/companion-seal-render-worker.ts', import.meta.url)));
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(options.env, { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
    const child = original(command, fictionalProgram === undefined ? args
      : ['--max-old-space-size=32', '--eval', fictionalProgram], options);
    children.push(child); return child;
  }) as typeof childProcess.spawn);
  return children;
}

test('outline grammar rejects markup, references, unsupported commands, broken contours and complexity before spawning', async t => {
  const children = capture(t);
  for (const path of [
    '', '<script>alert(1)</script>', 'M10 10L90 90Z"/><image href="https://invalid.test/fictional"/>',
    'url(file:///fictional-font.ttf)', 'm10 10l90 90z', 'M0 0A10 10 0 0 0 90 90Z',
    'M0 0LNaN 1Z', 'M0 0LInfinity 1Z', 'M0 0L1e99 1Z', 'M-1 1L90 90Z',
    'M0 0H101V90Z', 'M10 10L90Z', 'M10 10L90 90', 'M10 10Z', 'M10 10L90 90Z', 'M10 10L90 90ZZ',
    'M10 10L100.0000001 90Z',
    'M10 10,,L90 90Z', 'M,10 10L90 90Z', 'M10 10L90 90,Z',
    'M1 1V2' + 'H1'.repeat(2050) + 'Z', 'M0 0L1 1Z' + ' '.repeat(COMPANION_SEAL_SVG_MAX_BYTES),
  ]) await assert.rejects(createCompanionSealRenderer(lookup(path)).render(input), code('COMPANION_SEAL_GLYPH_INVALID'));
  assert.equal(children.length, 0);
  assert.equal(validateCompanionSealGlyphPath('M10 10 90 10 90 90 10 90Z'), 'M10 10 90 10 90 90 10 90Z');
  assert.equal(validateCompanionSealGlyphPath('M10 10Q90 10 90 90L10 90Z'), 'M10 10Q90 10 90 90L10 90Z');
  assert.equal(validateCompanionSealGlyphPath('M10 10C40 10 90 40 90 90L10 90Z'), 'M10 10C40 10 90 40 90 90L10 90Z');
});

test('character/CSS/raw SVG input cannot expand lookup or fixed token protocol; no fallback for missing glyph', async t => {
  const children = capture(t); let lookups = 0;
  const renderer = createCompanionSealRenderer({ lookup: char => { lookups++; return lookup().lookup(char); } });
  for (const invalid of [
    { ...input, sealChar: '墨\n' }, { ...input, sealChar: '墨墨' }, { ...input, sealChar: '<' },
    { ...input, inkToken: '#4D635B' }, { ...input, inkToken: 'var(--ink)' },
    { ...input, inkToken: '__proto__' }, { ...input, inkToken: 'dai;url(https://invalid.test)' },
    { ...input, svg: '<svg/>' }, { ...input, name: 'Fictional' }, { ...input, size: 4096 },
  ]) await assert.rejects(renderer.render(invalid as CompanionSealRenderInput), code('COMPANION_SEAL_RENDER_INVALID_INPUT'));
  assert.equal(lookups, 0);
  await assert.rejects(renderer.render({ ...input, sealChar: '舟' }), code('COMPANION_SEAL_GLYPH_UNAVAILABLE'));
  assert.equal(lookups, 1); assert.equal(children.length, 0);
});

test('malformed/accessor glyphs and asset digests never become renderer authority', async t => {
  const children = capture(t); let reads = 0;
  const accessor = { get path() { reads++; return FICTIONAL_PATH; }, assetDigest: FICTIONAL_ASSET_DIGEST };
  for (const glyph of [accessor, { path: FICTIONAL_PATH, assetDigest: FICTIONAL_ASSET_DIGEST + '\n' },
    { path: FICTIONAL_PATH, assetDigest: 'approved' }, { path: FICTIONAL_PATH, assetDigest: FICTIONAL_ASSET_DIGEST, approved: true }]) {
    const renderer = createCompanionSealRenderer({ lookup: () => glyph });
    await assert.rejects(renderer.render(input), code('COMPANION_SEAL_GLYPH_INVALID'));
  }
  assert.equal(reads, 0); assert.equal(children.length, 0);
  assert.throws(() => createCompanionSealRenderer(lookup(), { wallTimeoutMs: 5001 }), code('COMPANION_SEAL_RENDER_INVALID_INPUT'));
  assert.throws(() => createCompanionSealRenderer(lookup(), null as never), code('COMPANION_SEAL_RENDER_INVALID_INPUT'));
});

test('actual child emits real bounded 128px PNG with exact byte hashes and fixed color/template only', async t => {
  const children = capture(t);
  const result = await createCompanionSealRenderer(lookup()).render(input);
  assert.equal(children.length, 1); assertClosed(children);
  assert.equal(result.svgByteLength, result.svg.length); assert.equal(result.pngByteLength, result.png.length);
  assert(result.svg.length <= COMPANION_SEAL_SVG_MAX_BYTES); assert(result.png.length <= COMPANION_SEAL_PNG_MAX_BYTES);
  assert.equal(result.svgSha256, createHash('sha256').update(result.svg).digest('hex'));
  assert.equal(result.pngSha256, createHash('sha256').update(result.png).digest('hex'));
  assert.equal(result.pathSha256, createHash('sha256').update(FICTIONAL_PATH).digest('hex'));
  assert.equal(result.glyphAssetDigest, FICTIONAL_ASSET_DIGEST);
  assert.deepEqual(inspectCompanionSealPNG(result.png), { width: 128, height: 128, byteLength: result.png.length, sha256: result.pngSha256 });
  const svg = readCompanionSealWorkerSVG(result.svg);
  assert(svg.includes('fill="#4D635B"')); assert(svg.includes('stroke="#FCFDFE"'));
  assert(svg.includes('r="43.125"')); assert(svg.includes('stroke-width="3.75"'));
  assert(svg.includes('translate(26 28) scale(0.48) rotate(-3 50 50)'));
  assert(!svg.includes('墨')); assert(!svg.includes('<text')); assert(!svg.includes('font')); assert(!svg.includes('href'));
  // A valid header does not excuse corrupted image payload/CRC or extra metadata.
  const corrupted = Buffer.from(result.png); corrupted[corrupted.length - 5] ^= 1;
  for (const bytes of [corrupted, result.png.subarray(0, 33), Buffer.concat([result.png, Buffer.from('fictional-private-metadata')])]) {
    assert.throws(() => inspectCompanionSealPNG(bytes), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
  }
  for (const altered of [svg.replace('#4D635B', 'url(https://invalid.test/fictional)'),
    svg.replace('<path ', '<path onclick="fictional()" '), '<!DOCTYPE svg>' + svg,
    svg.replace('"/></svg>', '"/><text>fictional</text></svg>'), svg.replace('128" height="128', '4096" height="4096')]) {
    assert.throws(() => readCompanionSealWorkerSVG(Buffer.from(altered)), code('COMPANION_SEAL_GLYPH_INVALID'));
  }
});

test('seven actual ink tokens use fixed light palette in independent native PNG renders', async () => {
  const inks = { yanzhi: '#95425F', zheshi: '#86503A', ganlan: '#53650F', jiangzi: '#8D4572',
    dai: '#4D635B', yanzi: '#70566E', hehui: '#695B53' } as const;
  const renderer = createCompanionSealRenderer(lookup());
  const digests = new Set<string>();
  for (const [inkToken, color] of Object.entries(inks)) {
    const result = await renderer.render({ sealChar: '墨', inkToken: inkToken as typeof input.inkToken });
    assert(result.svg.toString('utf8').includes(`fill="${color}"`)); digests.add(result.pngSha256);
  }
  assert.equal(digests.size, 7);
});

test('CRC-valid IDAT tails and concatenated zlib streams cannot hide extra data; valid split IDAT remains an image', async () => {
  const result = await createCompanionSealRenderer(lookup()).render(input);
  const data = nativeImageData(result.png);
  assert.equal(inspectCompanionSealPNG(data.withData(data.compressed)).width, 128);
  assert.equal(inspectCompanionSealPNG(data.withData(data.compressed.subarray(0, 1), data.compressed.subarray(1, 3), data.compressed.subarray(3))).height, 128);
  for (const tail of [Buffer.from('fictional-private-IDAT-tail'), deflateSync(Buffer.from('fictional-second-zlib-stream'))]) {
    assert.throws(() => inspectCompanionSealPNG(data.withData(Buffer.concat([data.compressed, tail]))), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
    assert.throws(() => inspectCompanionSealPNG(data.withData(data.compressed, tail)), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
  }
});

test('an actual successful child cannot return a CRC-valid PNG with unconsumed compressed tail data', async t => {
  const original = await createCompanionSealRenderer(lookup()).render(input);
  const data = nativeImageData(original.png);
  const invalid = data.withData(Buffer.concat([data.compressed, Buffer.from('fictional-private-worker-tail')]));
  const children = capture(t, `process.stdin.resume(); process.stdout.write(Buffer.from('${invalid.toString('base64')}', 'base64'), () => process.exit(0));`);
  await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
  assert.equal(children.length, 1); assertClosed(children);
});

test('already cancelled work never spawns, and cancellation waits for real native child termination', async t => {
  const children = capture(t); const first = new AbortController(); first.abort(new Error('fictional private reason'));
  const renderer = createCompanionSealRenderer(lookup());
  await assert.rejects(renderer.render(input, first.signal), code('COMPANION_SEAL_RENDER_CANCELLED'));
  assert.equal(children.length, 0);
  const second = new AbortController(), pending = renderer.render(input, second.signal);
  assert.equal(children.length, 1); second.abort(new Error('fictional private reason'));
  await assert.rejects(pending, code('COMPANION_SEAL_RENDER_CANCELLED')); assertClosed(children);
});

test('hard startup deadline kills actual worker before rejection and releases its slot only after close', async t => {
  const children = capture(t);
  await assert.rejects(createCompanionSealRenderer(lookup(), { wallTimeoutMs: 1 }).render(input), code('COMPANION_SEAL_RENDER_TIMEOUT'));
  assert.equal(children.length, 1); assertClosed(children);
  const result = await createCompanionSealRenderer(lookup()).render(input);
  assert.equal(result.width, 128); assertClosed(children);
});

test('small concurrency limit is shared across renderer instances; cancelled busy workers cannot leak slots', async t => {
  const children = capture(t, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const a = new AbortController(), b = new AbortController();
  const first = createCompanionSealRenderer(lookup()).render(input, a.signal);
  const second = createCompanionSealRenderer(lookup()).render(input, b.signal);
  const settled = Promise.allSettled([first, second]);
  assert.equal(children.length, 2);
  try {
    await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_BUSY'));
    assert.equal(children.length, 2);
  } finally { a.abort(); b.abort(); await settled; }
  assertClosed(children);
  const c = new AbortController(), next = createCompanionSealRenderer(lookup()).render(input, c.signal);
  assert.equal(children.length, 3); c.abort(); await assert.rejects(next, code('COMPANION_SEAL_RENDER_CANCELLED'));
  assertClosed(children);
});

test('overflow/crash/native stderr is bounded, suppressed and killed before returning failure', async t => {
  const children = capture(t, 'process.stdin.resume(); process.stdout.write(Buffer.alloc(32769)); setInterval(() => {}, 1000);');
  await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
  assertClosed(children);
});

test('worker diagnostics never enter the bounded application error', async t => {
  const children = capture(t, 'process.stdin.resume(); process.stderr.write("fictional-private-native-diagnostic"); setInterval(() => {}, 1000);');
  await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_WORKER_FAILED'));
  assertClosed(children);
});

test('nonzero worker exit confirms termination and cannot produce an asset or retain a slot', async t => {
  const children = capture(t, 'process.stdin.resume(); process.exit(17);');
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_WORKER_FAILED'));
    assertClosed(children);
  }
  assert.equal(children.length, 3);
});

test('a successful child exit with header-shaped non-image bytes cannot become a PNG', async t => {
  const children = capture(t, 'process.stdin.resume(); process.stdout.write(Buffer.alloc(100), () => process.exit(0));');
  await assert.rejects(createCompanionSealRenderer(lookup()).render(input), code('COMPANION_SEAL_RENDER_INVALID_PNG'));
  assertClosed(children);
});

test('native worker itself rejects extra argv and oversized/non-template stdin without leaking source', async () => {
  const worker = fileURLToPath(new URL('../src/companion-seal-render-worker.ts', import.meta.url));
  for (const [payload, extra] of [
    [Buffer.from('<svg><script>fictional-private-source</script></svg>'), []],
    [Buffer.alloc(COMPANION_SEAL_SVG_MAX_BYTES + 1, 65), []], [Buffer.from('<svg/>'), ['fictional-extra-arg']],
  ] as const) {
    const child = childProcess.spawn(process.execPath, ['--max-old-space-size=32', '--disable-warning=ExperimentalWarning', worker, ...extra],
      { env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (bytes: Buffer) => out.push(bytes)); child.stderr.on('data', (bytes: Buffer) => err.push(bytes));
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    child.stdin.end(payload);
    const status = await closed; clearTimeout(timer);
    assert.notEqual(status, 0); assert.equal(Buffer.concat(out).length, 0);
    assert.equal(Buffer.concat(err).toString('utf8'), 'COMPANION_SEAL_RENDER_WORKER_FAILED\n');
    assertClosed([child]);
  }
});
