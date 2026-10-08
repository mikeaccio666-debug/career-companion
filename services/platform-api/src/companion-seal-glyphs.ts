/** Startup-only loader for a pinned offline Noto outline table. It proves
 * glyph availability and inspected source metadata only; the existing identity
 * policy and real review gates still establish name/selection eligibility.
 * No font, network or rendering process is opened during this disk load.
 */
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { validateCompanionSealGlyphPath } from './companion-seal-rendering.ts';
import type { CompanionSealGlyphLookup, CompanionSealGlyph } from './companion-seal-rendering.ts';

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const FONT_SHA = '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9';
const LICENSE_SHA = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2';
const WHEEL_SHA = '7234ae9e28db64273fbbfa72caebd0a97e3bdba6b05064114741b9539ef339d0';
const COMMIT = '985fa52c81c1d6692ccdd82bc3656e8fb932fd89';
const FONT_URL = `https://raw.githubusercontent.com/notofonts/noto-cjk/${COMMIT}/google-fonts/NotoSerifSC%5Bwght%5D.ttf`;
const LICENSE_URL = `https://raw.githubusercontent.com/notofonts/noto-cjk/${COMMIT}/Serif/LICENSE`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function bad(): never { throw new Error('COMPANION_SEAL_GLYPH_ASSET_REJECTED'); }
type RecordValue = Record<string, unknown>;
function closed(value: unknown, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(entry => !('value' in entry) || !entry.enumerable)) bad();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function hash(value: unknown): string { if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) bad(); return value; }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) bad();
  return value;
}
function integer(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high || Object.is(value, -0)) bad();
  return value;
}
function character(value: unknown): string {
  if (typeof value !== 'string' || !/^[\u4e00-\u9fff]$/u.test(value)) bad();
  return value;
}
// Only invoked after the closed schema below has bounded depth/arrays/strings.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as RecordValue;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface CompanionSealGlyphBindings {
  readonly assetDigest: string;
  readonly fileSha256: string;
  readonly fontSha256: string;
  readonly builderSha256: string;
  readonly domainSha256: string;
}
export interface CompanionSealGlyphEvidence {
  readonly assetDigest: string;
  readonly fileSha256: string;
  readonly fontSha256: string;
  readonly builderSha256: string;
  readonly domainSha256: string;
  readonly byteLength: number;
  readonly glyphCount: number;
  readonly wght: 700;
  readonly coverageScope: 'representative_only' | 'supplied_domain_unreviewed';
  readonly productionActivation: false;
}
export interface CompanionSealLoadedGlyphs extends CompanionSealGlyphLookup { readonly evidence: Readonly<CompanionSealGlyphEvidence>; }

/** The pathname and independent expected hashes must come from trusted server
 * configuration, never a user/request. Load once before accepting requests.
 * A private owner-controlled directory is needed: O_NOFOLLOW protects the final
 * file, not arbitrary mutable ancestor-directory races. This port proves only
 * inspected bytes/glyph availability; reviewers still own all product authority.
 */
export function loadCompanionSealGlyphLookup(file: string, supplied: CompanionSealGlyphBindings): CompanionSealLoadedGlyphs {
  let fd: number | undefined;
  try {
    const binding = closed(supplied, ['assetDigest', 'fileSha256', 'fontSha256', 'builderSha256', 'domainSha256']);
    for (const value of Object.values(binding)) hash(value);
    if (binding.fontSha256 !== FONT_SHA || typeof file !== 'string' || !file.length || file.length > 4096 || !isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) bad();
    const absolute = resolve(file), parent = dirname(absolute);
    if (realpathSync(parent) !== parent) bad();
    const directory = statSync(parent);
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) bad();
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.() || before.size < 1 || before.size > MAX_BUNDLE_BYTES) bad();
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, Math.min(128 * 1024, bytes.length - read), read);
      if (!count) bad();
      read += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || sha(bytes) !== binding.fileSha256) bad();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = closed(JSON.parse(decoded), ['assetDigest', 'payload']);
    if (hash(envelope.assetDigest) !== binding.assetDigest) bad();
    const payload = closed(envelope.payload, ['schemaVersion', 'assetKind', 'builder', 'font', 'license', 'domain', 'normalization', 'authority', 'entries']);
    if (payload.schemaVersion !== 1 || payload.assetKind !== 'companion-seal-glyphs') bad();
    const builder = closed(payload.builder, ['id', 'scriptSha256', 'fonttoolsVersion', 'wheelSha256', 'pythonVersion']);
    if (builder.id !== 'offline-noto-sc-glyph-candidate-v1' || hash(builder.scriptSha256) !== binding.builderSha256 || builder.fonttoolsVersion !== '4.66.1' || builder.wheelSha256 !== WHEEL_SHA || !/^3\.(?:1[1-9]|[2-9][0-9])\.\d{1,3}$/.test(text(builder.pythonVersion, 16))) bad();
    const font = closed(payload.font, ['family', 'sourceCommit', 'sourceURL', 'sha256', 'byteLength', 'binaryVersion', 'unitsPerEm', 'wght', 'axes', 'cmapTableSha256', 'bestCmapMappingSha256', 'originalGlyphCount', 'subsetGlyphCount']);
    if (font.family !== 'Noto Serif SC' || font.sourceCommit !== COMMIT || font.sourceURL !== FONT_URL || hash(font.sha256) !== FONT_SHA || font.byteLength !== 25125512 || font.binaryVersion !== 'Version 2.003-H1;hotconv 1.1.1;makeotfexe 2.6.0' || font.unitsPerEm !== 1000 || font.wght !== 700 || font.cmapTableSha256 !== 'a66826b8dabfa7d7a14b928f93eef65eb3127e26cb095f2e24c930d793efcf30') bad();
    hash(font.bestCmapMappingSha256);
    if (!Array.isArray(font.axes) || font.axes.length !== 1) bad();
    const axis = closed(font.axes[0], ['tag', 'minimum', 'default', 'maximum']);
    if (axis.tag !== 'wght' || axis.minimum !== '200' || axis.default !== '200' || axis.maximum !== '900') bad();
    const originalCount = integer(font.originalGlyphCount, 1, 65535), subsetCount = integer(font.subsetGlyphCount, 1, originalCount);
    const license = closed(payload.license, ['id', 'sourceURL', 'sha256', 'text', 'embeddedCopyrights']);
    if (license.id !== 'OFL-1.1' || license.sourceURL !== LICENSE_URL || license.sha256 !== LICENSE_SHA || typeof license.text !== 'string' || Buffer.byteLength(license.text, 'utf8') !== 4301 || sha(Buffer.from(license.text, 'utf8')) !== LICENSE_SHA) bad();
    if (!Array.isArray(license.embeddedCopyrights) || license.embeddedCopyrights.length !== 1 || license.embeddedCopyrights[0] !== '(c) 2017-2024 Adobe (http://www.adobe.com/).') bad();
    const domain = closed(payload.domain, ['coverageScope', 'sourceRecord', 'sha256', 'characters']);
    if (domain.coverageScope !== 'representative_only' && domain.coverageScope !== 'supplied_domain_unreviewed') bad();
    text(domain.sourceRecord, 2048);
    if (hash(domain.sha256) !== binding.domainSha256 || !Array.isArray(domain.characters) || domain.characters.length < 1 || domain.characters.length > 3500) bad();
    const normalization = closed(payload.normalization, ['grid', 'decimalPlaces', 'commands', 'algorithm']);
    if (normalization.grid !== 100 || normalization.decimalPlaces !== 6 || normalization.commands !== 'MLHVCQZ' || normalization.algorithm !== 'ink-center-control-envelope-uniform-flip-y-v1') bad();
    const authority = closed(payload.authority, ['tierOne3500Reviewed', 'identityReview', 'nameReview', 'clinicalReview', 'productionActivation']);
    if (Object.values(authority).some(v => v !== false)) bad();
    if (!Array.isArray(payload.entries) || payload.entries.length !== domain.characters.length || subsetCount < payload.entries.length) bad();
    const glyphMap = new Map<string, Readonly<CompanionSealGlyph>>();
    let previous = 0;
    for (let index = 0; index < payload.entries.length; index++) {
      const entry = closed(payload.entries[index], ['sealChar', 'path', 'pathSha256', 'glyphID']);
      const sealChar = character(entry.sealChar), scalar = sealChar.codePointAt(0)!;
      if (scalar <= previous || character(domain.characters[index]) !== sealChar) bad();
      previous = scalar;
      integer(entry.glyphID, 1, originalCount - 1);
      const path = validateCompanionSealGlyphPath(entry.path);
      if (hash(entry.pathSha256) !== sha(Buffer.from(path, 'ascii'))) bad();
      glyphMap.set(sealChar, Object.freeze({ path, assetDigest: binding.assetDigest as string }));
    }
    // Exact canonical-byte equality rejects duplicate keys, BOMs, noncanonical
    // numbers/Unicode escapes and hidden extra representations of the payload.
    const canonicalPayload = Buffer.from(canonical(payload), 'utf8');
    if (sha(canonicalPayload) !== binding.assetDigest || !Buffer.from(canonical(envelope), 'utf8').equals(bytes)) bad();
    const evidence = Object.freeze({ assetDigest: binding.assetDigest as string, fileSha256: binding.fileSha256 as string,
      fontSha256: FONT_SHA, builderSha256: binding.builderSha256 as string, domainSha256: binding.domainSha256 as string,
      byteLength: bytes.length, glyphCount: glyphMap.size, wght: 700 as const,
      coverageScope: domain.coverageScope as 'representative_only' | 'supplied_domain_unreviewed', productionActivation: false as const });
    return Object.freeze({ evidence, lookup(sealChar: string) {
      if (typeof sealChar !== 'string' || !/^[\u4e00-\u9fff]$/u.test(sealChar)) return null;
      return glyphMap.get(sealChar) ?? null;
    } });
  } catch { return bad(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface CompanionSealGlyphConfiguration {
  readonly file: string;
  readonly bindings: Readonly<CompanionSealGlyphBindings>;
}
/** All bindings come from deployment configuration, never a request. Missing
 * configuration leaves glyph rendering unavailable without disabling own reads. */
export function readCompanionSealGlyphConfiguration(env: NodeJS.ProcessEnv, workspace: string): Readonly<CompanionSealGlyphConfiguration> | undefined {
  const names = ['PLATFORM_COMPANION_SEAL_GLYPH_FILE', 'PLATFORM_COMPANION_SEAL_GLYPH_ASSET_SHA256',
    'PLATFORM_COMPANION_SEAL_GLYPH_FILE_SHA256', 'PLATFORM_COMPANION_SEAL_FONT_SHA256',
    'PLATFORM_COMPANION_SEAL_BUILDER_SHA256', 'PLATFORM_COMPANION_SEAL_DOMAIN_SHA256'] as const;
  const values = names.map(name => env[name]);
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => value === undefined)) throw new Error('Companion seal glyph configuration requires its file and all independent source bindings.');
  const [file, assetDigest, fileSha256, fontSha256, builderSha256, domainSha256] = values as string[];
  if (!file.length || file.length > 4096 || file.trim() !== file || /[\x00-\x1f\x7f]/.test(file)
    || [assetDigest, fileSha256, fontSha256, builderSha256, domainSha256].some(value => /^[0-9a-f]{64}$/.exec(value)?.[0] !== value)
    || fontSha256 !== FONT_SHA) throw new Error('Companion seal glyph configuration has invalid source bindings.');
  return Object.freeze({ file: resolve(workspace, file), bindings: Object.freeze({ assetDigest, fileSha256, fontSha256, builderSha256, domainSha256 }) });
}
