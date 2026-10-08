import { createHash } from 'node:crypto';
import type { CompanionPublicInkToken } from '@companion/platform-contracts';
import type { DataBinding, DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import {
  COMPANION_SEAL_PALETTE_VERSION, COMPANION_SEAL_PNG_MAX_BYTES, COMPANION_SEAL_RENDERER_VERSION,
  COMPANION_SEAL_SVG_MAX_BYTES, COMPANION_SEAL_TEMPLATE_VERSION, inspectCompanionSealPNG,
  readCompanionSealWorkerSVG, type CompanionSealRendered,
} from './companion-seal-rendering.ts';

/** Server-owned coordinates, not a request body, a glyph approval or a birth grant. */
export interface CompanionBirthAssetCoordinates {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly birthReceiptId: string;
  readonly bornAt: string;
  readonly sealChar: string;
  readonly inkToken: CompanionPublicInkToken;
}

/** Must be sealed inside the immutable birth receipt. In particular, metadata
 * copied from the untrusted asset row is not an expected authenticated snapshot. */
export interface CompanionBirthAssetSnapshot extends CompanionBirthAssetCoordinates {
  readonly schemaVersion: 1;
  readonly rendererVersion: typeof COMPANION_SEAL_RENDERER_VERSION;
  readonly templateVersion: typeof COMPANION_SEAL_TEMPLATE_VERSION;
  readonly paletteVersion: typeof COMPANION_SEAL_PALETTE_VERSION;
  readonly glyphSourceDigest: string;
  readonly pathDigest: string;
  readonly svgDigest: string;
  readonly pngDigest: string;
  readonly svgCipherDigest: string;
  readonly pngCipherDigest: string;
  readonly svgSizeBytes: number;
  readonly pngSizeBytes: number;
  readonly width: 128;
  readonly height: 128;
}

export interface CompanionBirthAssetRow {
  readonly id: string;
  readonly user_id: string;
  readonly companion_id: string;
  readonly birth_receipt_id: string;
  readonly seal_char: string;
  readonly ink_token: CompanionPublicInkToken;
  readonly renderer_version: string;
  readonly glyph_source_digest: string;
  readonly svg_digest: string;
  readonly png_digest: string;
  readonly assets_schema_version: 1;
  readonly svg_size_bytes: number;
  readonly png_size_bytes: number;
  readonly svg_ciphertext: Buffer;
  readonly png_base64_ciphertext: Buffer;
  readonly created_at: Date;
}

export const companionBirthAssetsUnavailable = () => new ApiError(503, 'COMPANION_BIRTH_ASSETS_UNAVAILABLE',
  'The protected companion seal could not be confirmed.');
function fail(): never { throw companionBirthAssetsUnavailable(); }
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const COORDINATE_KEYS = ['id', 'ownerId', 'companionId', 'birthReceiptId', 'bornAt', 'sealChar', 'inkToken'] as const;
const SNAPSHOT_KEYS = [...COORDINATE_KEYS, 'schemaVersion', 'rendererVersion', 'templateVersion', 'paletteVersion',
  'glyphSourceDigest', 'pathDigest', 'svgDigest', 'pngDigest', 'svgCipherDigest', 'pngCipherDigest',
  'svgSizeBytes', 'pngSizeBytes', 'width', 'height'] as const;
const ROW_KEYS = ['id', 'user_id', 'companion_id', 'birth_receipt_id', 'seal_char', 'ink_token',
  'renderer_version', 'glyph_source_digest', 'svg_digest', 'png_digest', 'assets_schema_version',
  'svg_size_bytes', 'png_size_bytes', 'svg_ciphertext', 'png_base64_ciphertext', 'created_at'] as const;
const RENDERED_KEYS = ['svg', 'png', 'svgSha256', 'pngSha256', 'svgByteLength', 'pngByteLength', 'width', 'height',
  'glyphAssetDigest', 'pathSha256', 'templateVersion', 'paletteVersion', 'rendererVersion'] as const;
// The fixed renderer's light palette. This validates the declared ink against
// the actual exact-template SVG; no arbitrary CSS/color input is accepted.
const INKS: Readonly<Record<CompanionPublicInkToken, string>> = Object.freeze({
  yanzhi: '#95425F', zheshi: '#86503A', ganlan: '#53650F', jiangzi: '#8D4572',
  dai: '#4D635B', yanzi: '#70566E', hehui: '#695B53',
});

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(fields).some(field => !('value' in field) || !field.enumerable)) fail();
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
function exactString(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.exec(value)?.[0] === value;
}
function digest(value: unknown): string {
  if (!exactString(value, /^[0-9a-f]{64}$/)) fail(); return value;
}
function iso(value: unknown): string {
  if (!exactString(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}
function coordinates(fields: Record<string, unknown>): Readonly<CompanionBirthAssetCoordinates> {
  for (const key of ['id', 'ownerId', 'companionId', 'birthReceiptId']) {
    if (!exactString(fields[key], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) fail();
  }
  if (!exactString(fields.sealChar, /^\p{Unified_Ideograph}$/u)
    || typeof fields.inkToken !== 'string' || !Object.hasOwn(INKS, fields.inkToken)) fail();
  return Object.freeze({ id: fields.id as string, ownerId: fields.ownerId as string,
    companionId: fields.companionId as string, birthReceiptId: fields.birthReceiptId as string,
    bornAt: iso(fields.bornAt), sealChar: fields.sealChar, inkToken: fields.inkToken as CompanionPublicInkToken });
}
function byteSize(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail();
  return value as number;
}
/** Public to the origin codec solely for canonical closed-shape validation. It
 * does not authenticate a receipt or turn any coordinates into authority. */
export function parseCompanionBirthAssetSnapshot(value: unknown): Readonly<CompanionBirthAssetSnapshot> {
  try {
    const fixed = closed(value, SNAPSHOT_KEYS), at = coordinates(fixed);
    if (fixed.schemaVersion !== 1 || fixed.width !== 128 || fixed.height !== 128
      || fixed.rendererVersion !== COMPANION_SEAL_RENDERER_VERSION
      || fixed.templateVersion !== COMPANION_SEAL_TEMPLATE_VERSION
      || fixed.paletteVersion !== COMPANION_SEAL_PALETTE_VERSION) fail();
    return Object.freeze({ ...at, schemaVersion: 1 as const,
      rendererVersion: COMPANION_SEAL_RENDERER_VERSION, templateVersion: COMPANION_SEAL_TEMPLATE_VERSION,
      paletteVersion: COMPANION_SEAL_PALETTE_VERSION, glyphSourceDigest: digest(fixed.glyphSourceDigest),
      pathDigest: digest(fixed.pathDigest), svgDigest: digest(fixed.svgDigest), pngDigest: digest(fixed.pngDigest),
      svgCipherDigest: digest(fixed.svgCipherDigest), pngCipherDigest: digest(fixed.pngCipherDigest),
      svgSizeBytes: byteSize(fixed.svgSizeBytes, COMPANION_SEAL_SVG_MAX_BYTES),
      pngSizeBytes: byteSize(fixed.pngSizeBytes, COMPANION_SEAL_PNG_MAX_BYTES), width: 128 as const, height: 128 as const });
  } catch { fail(); }
}
function binding(at: CompanionBirthAssetCoordinates, column: 'svg_ciphertext' | 'png_base64_ciphertext'): DataBinding {
  return Object.freeze({ table: 'platform_companion_birth_assets', column, rowId: at.id, ownerId: at.ownerId, revision: 1 });
}
function buffer(value: unknown, max: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > max) fail();
  return Buffer.from(value);
}
function cipher(value: unknown, plainSize: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 29 + plainSize) fail(); return Buffer.from(value);
}
function validatedBytes(at: CompanionBirthAssetCoordinates, svg: Buffer, png: Buffer, expected: Readonly<{
  pathDigest: string; svgDigest: string; pngDigest: string; svgSizeBytes: number; pngSizeBytes: number;
}>): string {
  const text = readCompanionSealWorkerSVG(svg), pngInfo = inspectCompanionSealPNG(png);
  const opening = text.indexOf(' d="');
  const path = text.slice(opening + 4, -'"/></svg>'.length);
  if (opening < 0 || !text.includes(`<circle cx="50" cy="50" r="50" fill="${INKS[at.inkToken]}"/>`)
    || Buffer.from(text, 'utf8').length !== svg.length || sha(path) !== expected.pathDigest
    || sha(svg) !== expected.svgDigest || pngInfo.sha256 !== expected.pngDigest
    || svg.length !== expected.svgSizeBytes || png.length !== expected.pngSizeBytes) fail();
  return text;
}

/** The caller supplies only an actual server render and captured coordinates.
 * Copy both native buffers before any crypto port can execute. These bytes are
 * sealed with distinct column AAD and their original envelopes are snapshotted. */
export function sealCompanionBirthAssets(crypto: DataCrypto | undefined, value: CompanionBirthAssetCoordinates,
  rendered: Readonly<CompanionSealRendered>): Readonly<{
    row: Readonly<CompanionBirthAssetRow>; snapshot: Readonly<CompanionBirthAssetSnapshot>;
  }> {
  try {
    if (!crypto) fail();
    const at = coordinates(closed(value, COORDINATE_KEYS)), fixed = closed(rendered, RENDERED_KEYS);
    const svg = buffer(fixed.svg, COMPANION_SEAL_SVG_MAX_BYTES), png = buffer(fixed.png, COMPANION_SEAL_PNG_MAX_BYTES);
    if (fixed.width !== 128 || fixed.height !== 128 || fixed.rendererVersion !== COMPANION_SEAL_RENDERER_VERSION
      || fixed.templateVersion !== COMPANION_SEAL_TEMPLATE_VERSION || fixed.paletteVersion !== COMPANION_SEAL_PALETTE_VERSION) fail();
    const evidence = { glyphSourceDigest: digest(fixed.glyphAssetDigest), pathDigest: digest(fixed.pathSha256),
      svgDigest: digest(fixed.svgSha256), pngDigest: digest(fixed.pngSha256),
      svgSizeBytes: byteSize(fixed.svgByteLength, COMPANION_SEAL_SVG_MAX_BYTES),
      pngSizeBytes: byteSize(fixed.pngByteLength, COMPANION_SEAL_PNG_MAX_BYTES) };
    const svgText = validatedBytes(at, svg, png, evidence), pngBase64 = png.toString('base64');
    const svgCipher = cipher(crypto.sealUtf8(svgText, binding(at, 'svg_ciphertext')), svg.length);
    const pngCipher = cipher(crypto.sealUtf8(pngBase64, binding(at, 'png_base64_ciphertext')), pngBase64.length);
    const snapshot = parseCompanionBirthAssetSnapshot({ ...at, ...evidence, schemaVersion: 1,
      rendererVersion: COMPANION_SEAL_RENDERER_VERSION, templateVersion: COMPANION_SEAL_TEMPLATE_VERSION,
      paletteVersion: COMPANION_SEAL_PALETTE_VERSION, svgCipherDigest: sha(svgCipher), pngCipherDigest: sha(pngCipher),
      width: 128, height: 128 });
    const row: CompanionBirthAssetRow = Object.freeze({ id: at.id, user_id: at.ownerId, companion_id: at.companionId,
      birth_receipt_id: at.birthReceiptId, seal_char: at.sealChar, ink_token: at.inkToken,
      renderer_version: snapshot.rendererVersion, glyph_source_digest: snapshot.glyphSourceDigest,
      svg_digest: snapshot.svgDigest, png_digest: snapshot.pngDigest, assets_schema_version: 1,
      svg_size_bytes: snapshot.svgSizeBytes, png_size_bytes: snapshot.pngSizeBytes,
      svg_ciphertext: svgCipher, png_base64_ciphertext: pngCipher, created_at: new Date(at.bornAt) });
    return Object.freeze({ row, snapshot });
  } catch { fail(); }
}

/** Own-storage reads deliberately do not consult current font/provider/review
 * configuration. The immutable receipt must already be authenticated by the
 * caller. A missing, swapped or damaged asset is one bounded 503, never repair. */
export function openCompanionBirthAssets(crypto: DataCrypto | undefined, value: unknown,
  expected: CompanionBirthAssetSnapshot): Readonly<CompanionSealRendered> {
  try {
    if (!crypto) fail();
    const at = parseCompanionBirthAssetSnapshot(expected), row = closed(value, ROW_KEYS);
    if (!(row.created_at instanceof Date) || Object.getPrototypeOf(row.created_at) !== Date.prototype
      || Reflect.ownKeys(row.created_at).length || Date.prototype.getTime.call(row.created_at) !== Date.parse(at.bornAt)) fail();
    const pairs = { id: at.id, user_id: at.ownerId, companion_id: at.companionId, birth_receipt_id: at.birthReceiptId,
      seal_char: at.sealChar, ink_token: at.inkToken, renderer_version: at.rendererVersion,
      glyph_source_digest: at.glyphSourceDigest, svg_digest: at.svgDigest, png_digest: at.pngDigest,
      assets_schema_version: at.schemaVersion, svg_size_bytes: at.svgSizeBytes, png_size_bytes: at.pngSizeBytes };
    if (Object.entries(pairs).some(([key, entry]) => row[key] !== entry)) fail();
    const base64Size = 4 * Math.ceil(at.pngSizeBytes / 3);
    const svgCipher = cipher(row.svg_ciphertext, at.svgSizeBytes), pngCipher = cipher(row.png_base64_ciphertext, base64Size);
    if (sha(svgCipher) !== at.svgCipherDigest || sha(pngCipher) !== at.pngCipherDigest) fail();
    const text = crypto.openUtf8(svgCipher, binding(at, 'svg_ciphertext'));
    const base64 = crypto.openUtf8(pngCipher, binding(at, 'png_base64_ciphertext'));
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') !== at.svgSizeBytes
      || typeof base64 !== 'string' || base64.length !== base64Size
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail();
    const svg = Buffer.from(text, 'utf8'), png = Buffer.from(base64, 'base64');
    if (png.toString('base64') !== base64) fail();
    validatedBytes(at, svg, png, at);
    return Object.freeze({ svg, png, svgSha256: at.svgDigest, pngSha256: at.pngDigest,
      svgByteLength: at.svgSizeBytes, pngByteLength: at.pngSizeBytes, width: 128 as const, height: 128 as const,
      glyphAssetDigest: at.glyphSourceDigest, pathSha256: at.pathDigest, templateVersion: at.templateVersion,
      paletteVersion: at.paletteVersion, rendererVersion: at.rendererVersion });
  } catch { fail(); }
}
