import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateSync, type Inflate } from 'node:zlib';
import type { CompanionPublicInkToken } from '@companion/platform-contracts';

export const COMPANION_SEAL_SVG_MAX_BYTES = 16 * 1024;
export const COMPANION_SEAL_PNG_MAX_BYTES = 32 * 1024;
export const COMPANION_SEAL_PNG_SIZE = 128;
export const COMPANION_SEAL_RENDER_CONCURRENCY = 2;
const PATH_MAX_BYTES = 12 * 1024, PATH_MAX_SEGMENTS = 2048, PATH_MAX_TOKENS = 8192;
const DEFAULT_WALL_MS = 3000, MAX_WALL_MS = 5000;
const SHEET = '#FCFDFE';
const INKS = Object.freeze({ yanzhi: '#95425F', zheshi: '#86503A', ganlan: '#53650F',
  jiangzi: '#8D4572', dai: '#4D635B', yanzi: '#70566E', hehui: '#695B53' });
export const COMPANION_SEAL_TEMPLATE_VERSION = 'companion-round-light-v1';
export const COMPANION_SEAL_PALETTE_VERSION = 'companion-light-v1';
export const COMPANION_SEAL_RENDERER_VERSION = 'resvg-js-2.6.2';

/** A server-owned offline asset port. Paths are aspect-preserving glyphs already
 * centered in 100x100 coordinates. Presence/digest do not prove Noto origin,
 * complete tier-one coverage, font license, name/clinical review or activation.
 */
export interface CompanionSealGlyph { readonly path: string; readonly assetDigest: string; }
export interface CompanionSealGlyphLookup { lookup(sealChar: string): Readonly<CompanionSealGlyph> | null; }
export interface CompanionSealRenderInput { readonly sealChar: string; readonly inkToken: CompanionPublicInkToken; }
export interface CompanionSealRendered {
  readonly svg: Buffer; readonly png: Buffer;
  readonly svgSha256: string; readonly pngSha256: string;
  readonly svgByteLength: number; readonly pngByteLength: number;
  readonly width: 128; readonly height: 128;
  readonly glyphAssetDigest: string; readonly pathSha256: string;
  readonly templateVersion: typeof COMPANION_SEAL_TEMPLATE_VERSION;
  readonly paletteVersion: typeof COMPANION_SEAL_PALETTE_VERSION;
  readonly rendererVersion: typeof COMPANION_SEAL_RENDERER_VERSION;
}
type RenderErrorCode = 'COMPANION_SEAL_RENDER_INVALID_INPUT' | 'COMPANION_SEAL_GLYPH_UNAVAILABLE'
  | 'COMPANION_SEAL_GLYPH_INVALID' | 'COMPANION_SEAL_RENDER_BUSY' | 'COMPANION_SEAL_RENDER_CANCELLED'
  | 'COMPANION_SEAL_RENDER_TIMEOUT' | 'COMPANION_SEAL_RENDER_WORKER_FAILED' | 'COMPANION_SEAL_RENDER_INVALID_PNG';
export class CompanionSealRenderingError extends Error {
  readonly code: RenderErrorCode;
  constructor(code: RenderErrorCode) {
    super('The companion seal could not be rendered.');
    this.name = 'CompanionSealRenderingError'; this.code = code;
  }
}
function fail(code: RenderErrorCode): never { throw new CompanionSealRenderingError(code); }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function closed(value: unknown, keys: readonly string[], code: RenderErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(entry => !('value' in entry) || !entry.enumerable)) fail(code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail('COMPANION_SEAL_RENDER_CANCELLED'); }

function curveArea(points: readonly (readonly [number, number])[]): number {
  const coefficients = (axis: 0 | 1) => {
    const a = points[0][axis], b = points[1][axis], c = points[2][axis];
    if (points.length === 3) return [a, 2 * (b - a), a - 2 * b + c];
    const d = points[3][axis];
    return [a, 3 * (b - a), 3 * (a - 2 * b + c), -a + 3 * b - 3 * c + d];
  };
  const x = coefficients(0), y = coefficients(1); let area = 0;
  // Integral x dy - y dx in polynomial form, for quadratic/cubic curves.
  for (let i = 0; i < x.length; i++) for (let j = 1; j < x.length; j++) {
    area += (x[i] * j * y[j] - y[i] * j * x[j]) / (i + j);
  }
  return area;
}

/** A restricted absolute outline grammar, not an SVG sanitizer. Only the
 * commands emitted by the offline outline generator are supported. Every
 * contour must close; curves/control points stay inside the normalized square.
 */
export function validateCompanionSealGlyphPath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > PATH_MAX_BYTES
    || !/^[MLHVCQZ0-9.,+\- \t\r\n]+$/.test(value)) fail('COMPANION_SEAL_GLYPH_INVALID');
  const tokens: (string | number)[] = [];
  const number = /[+-]?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})/y;
  let at = 0, previousWasCommand = true;
  while (at < value.length) {
    const start = at;
    while (at < value.length && /[ ,\t\r\n]/.test(value[at])) at++;
    const separators = value.slice(start, at), commas = separators.split(',').length - 1;
    if (commas > 1 || commas && (previousWasCommand || at === value.length || /[MLHVCQZ]/.test(value[at]))) fail('COMPANION_SEAL_GLYPH_INVALID');
    if (at === value.length) break;
    const char = value[at];
    if (/[MLHVCQZ]/.test(char)) { tokens.push(char); at++; previousWasCommand = true; }
    else {
      number.lastIndex = at; const found = number.exec(value);
      if (!found || found[0].length > 12 || /[0-9]/.test(value[number.lastIndex] ?? '')) fail('COMPANION_SEAL_GLYPH_INVALID');
      const coordinate = Number(found[0]);
      if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 100 || Object.is(coordinate, -0)) fail('COMPANION_SEAL_GLYPH_INVALID');
      tokens.push(coordinate); at = number.lastIndex; previousWasCommand = false;
    }
    if (tokens.length > PATH_MAX_TOKENS) fail('COMPANION_SEAL_GLYPH_INVALID');
  }
  if (tokens[0] !== 'M') fail('COMPANION_SEAL_GLYPH_INVALID');
  const counts: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4 };
  let position = 0, open = false, visibleContour = false, segments = 0;
  let x = 0, y = 0, startX = 0, startY = 0, area = 0;
  const line = (nextX: number, nextY: number) => { area += x * nextY - nextX * y; x = nextX; y = nextY; };
  while (position < tokens.length) {
    const command = tokens[position++];
    if (typeof command !== 'string') fail('COMPANION_SEAL_GLYPH_INVALID');
    if (command === 'Z') {
      if (!open) fail('COMPANION_SEAL_GLYPH_INVALID');
      line(startX, startY); if (Math.abs(area) > 1e-9) visibleContour = true;
      open = false; segments++;
    } else {
      if (command === 'M' ? open : !open) fail('COMPANION_SEAL_GLYPH_INVALID');
      const first = position;
      while (position < tokens.length && typeof tokens[position] === 'number') {
        position++;
      }
      const length = position - first;
      if (!length || length % counts[command] !== 0) fail('COMPANION_SEAL_GLYPH_INVALID');
      const groups = length / counts[command]; segments += groups;
      for (let group = 0; group < groups; group++) {
        const offset = first + group * counts[command];
        const n = (index: number) => tokens[offset + index] as number;
        if (command === 'M' && group === 0) { x = startX = n(0); y = startY = n(1); area = 0; open = true; }
        else if (command === 'M' || command === 'L') line(n(0), n(1));
        else if (command === 'H') line(n(0), y);
        else if (command === 'V') line(x, n(0));
        else if (command === 'Q') { area += curveArea([[x, y], [n(0), n(1)], [n(2), n(3)]]); x = n(2); y = n(3); }
        else if (command === 'C') { area += curveArea([[x, y], [n(0), n(1)], [n(2), n(3)], [n(4), n(5)]]); x = n(4); y = n(5); }
      }
    }
    if (segments > PATH_MAX_SEGMENTS) fail('COMPANION_SEAL_GLYPH_INVALID');
  }
  if (open || !visibleContour) fail('COMPANION_SEAL_GLYPH_INVALID');
  return value;
}

const SVG_START = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100">';
const SVG_RING = `<circle cx="50" cy="50" r="43.125" fill="none" stroke="${SHEET}" stroke-width="3.75"/>`;
const SVG_PATH_START = `<path fill="${SHEET}" transform="translate(26 28) scale(0.48) rotate(-3 50 50)" d="`;
const SVG_END = '"/></svg>';
function svgPrefix(ink: string) { return `${SVG_START}<circle cx="50" cy="50" r="50" fill="${ink}"/>${SVG_RING}${SVG_PATH_START}`; }
function svgBytes(path: string, ink: string): Buffer {
  const bytes = Buffer.from(svgPrefix(ink) + path + SVG_END, 'utf8');
  if (bytes.length > COMPANION_SEAL_SVG_MAX_BYTES) fail('COMPANION_SEAL_GLYPH_INVALID');
  return bytes;
}
/** Internal worker protocol only: accepts the exact fixed template, not general
 * XML. Reconstructing it plus the closed path grammar rejects all extra markup,
 * CSS, text, external references, entities and unknown colors/attributes.
 */
export function readCompanionSealWorkerSVG(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > COMPANION_SEAL_SVG_MAX_BYTES) fail('COMPANION_SEAL_GLYPH_INVALID');
  let svg: string;
  try { svg = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('COMPANION_SEAL_GLYPH_INVALID'); }
  for (const ink of Object.values(INKS)) {
    const prefix = svgPrefix(ink);
    if (svg.startsWith(prefix) && svg.endsWith(SVG_END)) {
      const path = validateCompanionSealGlyphPath(svg.slice(prefix.length, -SVG_END.length));
      if (!Buffer.from(bytes).equals(svgBytes(path, ink))) fail('COMPANION_SEAL_GLYPH_INVALID');
      return svg;
    }
  }
  fail('COMPANION_SEAL_GLYPH_INVALID');
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  CRC_TABLE[i] = crc >>> 0;
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
/** Validates actual bounded PNG bytes, all chunk CRCs and the complete 128x128
 * RGBA scanlines. Header-shaped or truncated bytes are not an image. Unknown
 * ancillary chunks are rejected, preventing arbitrary private metadata.
 */
export function inspectCompanionSealPNG(value: Uint8Array): Readonly<{ width: 128; height: 128; byteLength: number; sha256: string }> {
  if (!(value instanceof Uint8Array) || value.length > COMPANION_SEAL_PNG_MAX_BYTES || value.length < 57) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
  let at = 8, header = false, ended = false, dataBytes = 0;
  const imageData: Buffer[] = [];
  while (at < bytes.length) {
    if (at + 12 > bytes.length) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
    const length = bytes.readUInt32BE(at), end = at + 12 + length;
    if (end > bytes.length || length > COMPANION_SEAL_PNG_MAX_BYTES) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
    const type = bytes.toString('latin1', at + 4, at + 8), data = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
    if (type === 'IHDR') {
      if (header || at !== 8 || length !== 13 || data.readUInt32BE(0) !== 128 || data.readUInt32BE(4) !== 128
        || data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
      header = true;
    } else if (type === 'IDAT') {
      if (!header || ended || !length) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
      imageData.push(data); dataBytes += length;
    } else if (type === 'IEND') {
      if (!header || !dataBytes || length || end !== bytes.length) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
      ended = true;
    } else fail('COMPANION_SEAL_RENDER_INVALID_PNG');
    at = end;
  }
  if (!ended) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
  const rowBytes = 128 * 4 + 1, rawBytes = 128 * rowBytes;
  let raw: Buffer;
  try {
    const compressed = Buffer.concat(imageData, dataBytes);
    // Node's documented info result is not modeled by the Buffer-only types.
    // A valid first zlib stream must not conceal a tail or a second stream in
    // CRC-valid IDAT chunks. Valid chunk splits still consume the entire input.
    const decoded = inflateSync(compressed, { maxOutputLength: rawBytes, info: true }) as unknown as { buffer: Buffer; engine: Inflate };
    if (!Buffer.isBuffer(decoded.buffer) || decoded.engine.bytesWritten !== compressed.length) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
    raw = decoded.buffer;
  }
  catch { fail('COMPANION_SEAL_RENDER_INVALID_PNG'); }
  if (raw.length !== rawBytes) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
  for (let row = 0; row < 128; row++) if (raw[row * rowBytes] > 4) fail('COMPANION_SEAL_RENDER_INVALID_PNG');
  return Object.freeze({ width: 128 as const, height: 128 as const, byteLength: bytes.length, sha256: sha256(bytes) });
}

let activeWorkers = 0;
const WORKER_FILE = fileURLToPath(new URL('./companion-seal-render-worker.ts', import.meta.url));
async function renderPNG(svg: Buffer, wallMs: number, signal?: AbortSignal): Promise<Buffer> {
  cancelled(signal);
  if (activeWorkers >= COMPANION_SEAL_RENDER_CONCURRENCY) fail('COMPANION_SEAL_RENDER_BUSY');
  activeWorkers++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let child: ReturnType<typeof childProcess.spawn>;
      try {
        // Fixed argv/native Node 24 type stripping; never inherit loaders,
        // NODE_OPTIONS, credentials, home/font directories, PATH or proxy env.
        child = childProcess.spawn(process.execPath, ['--max-old-space-size=32', '--disable-warning=ExperimentalWarning', WORKER_FILE],
          { shell: false, windowsHide: true, env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { reject(new CompanionSealRenderingError('COMPANION_SEAL_RENDER_WORKER_FAILED')); return; }
      let failure: RenderErrorCode | undefined, total = 0, stderrBytes = 0, closed = false;
      const output: Buffer[] = [];
      let killRetry: ReturnType<typeof setInterval> | undefined;
      const kill = () => {
        if (!closed && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* Never expose OS/native diagnostics. Still wait for close. */ }
        }
      };
      const stop = (code: RenderErrorCode) => {
        if (!failure) failure = code;
        kill();
        // A slot/promise stays retained until close confirms real termination,
        // even if a first signal failed or a stream error arrived before spawn.
        killRetry ??= setInterval(kill, 50);
      };
      const abort = () => stop('COMPANION_SEAL_RENDER_CANCELLED');
      const timer = setTimeout(() => stop('COMPANION_SEAL_RENDER_TIMEOUT'), wallMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('spawn', () => { if (failure) kill(); });
      child.once('error', () => stop('COMPANION_SEAL_RENDER_WORKER_FAILED'));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (failure) return;
        total += chunk.length;
        if (total > COMPANION_SEAL_PNG_MAX_BYTES) stop('COMPANION_SEAL_RENDER_INVALID_PNG');
        else output.push(Buffer.from(chunk));
      });
      // Drain and discard diagnostics; not even a native crash reaches logs.
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes) stop('COMPANION_SEAL_RENDER_WORKER_FAILED');
      });
      child.stdin?.on('error', () => stop('COMPANION_SEAL_RENDER_WORKER_FAILED'));
      child.stdout?.on('error', () => stop('COMPANION_SEAL_RENDER_WORKER_FAILED'));
      child.stderr?.on('error', () => stop('COMPANION_SEAL_RENDER_WORKER_FAILED'));
      child.once('close', (code, exitSignal) => {
        closed = true; clearTimeout(timer); if (killRetry) clearInterval(killRetry);
        signal?.removeEventListener('abort', abort);
        if (!failure && signal?.aborted) failure = 'COMPANION_SEAL_RENDER_CANCELLED';
        if (!failure && (code !== 0 || exitSignal !== null)) failure = 'COMPANION_SEAL_RENDER_WORKER_FAILED';
        if (failure) { reject(new CompanionSealRenderingError(failure)); return; }
        resolve(Buffer.concat(output, total));
      });
      if (!child.stdin || !child.stdout || !child.stderr) stop('COMPANION_SEAL_RENDER_WORKER_FAILED');
      else if (signal?.aborted) abort();
      else { try { child.stdin.end(svg); } catch { stop('COMPANION_SEAL_RENDER_WORKER_FAILED'); } }
    });
  } finally { activeWorkers--; }
}

/** Rendering is preparation only. It cannot activate an identity, select a
 * candidate or commit a birth; the caller must independently recheck authority
 * and persist these immutable byte/hash bindings in its real transaction.
 */
export function createCompanionSealRenderer(glyphs: CompanionSealGlyphLookup, options: { readonly wallTimeoutMs?: number } = {}) {
  const fixedOptions = closed(options, options && typeof options === 'object' && Object.hasOwn(options, 'wallTimeoutMs') ? ['wallTimeoutMs'] : [], 'COMPANION_SEAL_RENDER_INVALID_INPUT');
  const wallMs = fixedOptions.wallTimeoutMs ?? DEFAULT_WALL_MS;
  if (typeof wallMs !== 'number' || !Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > MAX_WALL_MS
    || !glyphs || typeof glyphs.lookup !== 'function') fail('COMPANION_SEAL_RENDER_INVALID_INPUT');
  const lookup = glyphs.lookup.bind(glyphs);
  return Object.freeze({
    async render(input: CompanionSealRenderInput, signal?: AbortSignal): Promise<Readonly<CompanionSealRendered>> {
      cancelled(signal);
      const fixed = closed(input, ['sealChar', 'inkToken'], 'COMPANION_SEAL_RENDER_INVALID_INPUT');
      if (typeof fixed.sealChar !== 'string' || /^\p{Unified_Ideograph}$/u.exec(fixed.sealChar)?.[0] !== fixed.sealChar
        || typeof fixed.inkToken !== 'string' || !Object.hasOwn(INKS, fixed.inkToken)) fail('COMPANION_SEAL_RENDER_INVALID_INPUT');
      let found: unknown;
      try { found = lookup(fixed.sealChar); } catch { fail('COMPANION_SEAL_GLYPH_UNAVAILABLE'); }
      if (found === null || found === undefined) fail('COMPANION_SEAL_GLYPH_UNAVAILABLE');
      const glyph = closed(found, ['path', 'assetDigest'], 'COMPANION_SEAL_GLYPH_INVALID');
      const path = validateCompanionSealGlyphPath(glyph.path);
      if (typeof glyph.assetDigest !== 'string' || glyph.assetDigest.length !== 64 || !/^[0-9a-f]{64}$/.test(glyph.assetDigest)) fail('COMPANION_SEAL_GLYPH_INVALID');
      const glyphAssetDigest = glyph.assetDigest, pathSha256 = sha256(Buffer.from(path, 'utf8'));
      const svg = svgBytes(path, INKS[fixed.inkToken as CompanionPublicInkToken]);
      const png = await renderPNG(svg, wallMs, signal);
      cancelled(signal);
      const pngInfo = inspectCompanionSealPNG(png);
      return Object.freeze({ svg, png, svgSha256: sha256(svg), pngSha256: pngInfo.sha256,
        svgByteLength: svg.length, pngByteLength: pngInfo.byteLength, width: 128 as const, height: 128 as const,
        glyphAssetDigest, pathSha256, templateVersion: COMPANION_SEAL_TEMPLATE_VERSION,
        paletteVersion: COMPANION_SEAL_PALETTE_VERSION, rendererVersion: COMPANION_SEAL_RENDERER_VERSION });
    },
  });
}
