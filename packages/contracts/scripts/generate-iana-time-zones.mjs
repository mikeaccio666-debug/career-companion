import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const LOCK_PATH = fileURLToPath(new URL('./iana-time-zones-2026c.lock.json', import.meta.url));
const OUTPUT_PATH = fileURLToPath(new URL('../src/ianaTimeZones2026c.generated.ts', import.meta.url));
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
validateLock(lock);

const archiveArgumentIndex = process.argv.indexOf('--archive');
const archivePath = archiveArgumentIndex < 0 ? null : process.argv[archiveArgumentIndex + 1];
if (archiveArgumentIndex >= 0 && !archivePath) fail('--archive requires an explicit file path');
const checkOnly = process.argv.includes('--check');

const archive = archivePath
  ? await readFile(archivePath)
  : await downloadArchive(lock.sourceUrl);
if (archive.byteLength > MAX_ARCHIVE_BYTES) fail('source archive exceeds the pinned size ceiling');
assertSha256(archive, lock.sourceSha256, 'source archive');

const files = parseTar(gunzipSync(archive));
const version = findRequiredFile(files, 'version').toString('utf8').trim();
if (version !== lock.release) fail(`archive version ${version} does not match ${lock.release}`);

const zones = new Set();
const links = new Map();
for (const input of lock.inputs) {
  parseTzData(findRequiredFile(files, input).toString('utf8'), input, zones, links);
}
for (const alias of links.keys()) {
  if (zones.has(alias)) fail(`Link alias collides with Zone: ${alias}`);
}

const canonicalZones = [...zones].sort(asciiCompare);
const resolvedLinks = [...links.keys()]
  .sort(asciiCompare)
  .map((alias) => [alias, resolveCanonicalTarget(alias, zones, links)]);
if (canonicalZones.length !== lock.expectedCanonicalZoneCount) {
  fail(`Zone count ${canonicalZones.length} does not match ${lock.expectedCanonicalZoneCount}`);
}
if (resolvedLinks.length !== lock.expectedLinkCount) {
  fail(`Link count ${resolvedLinks.length} does not match ${lock.expectedLinkCount}`);
}

const registryBytes = registryDigestBytes(canonicalZones, resolvedLinks);
assertSha256(registryBytes, lock.expectedRegistrySha256, 'resolved registry');
const generated = renderGeneratedFile(lock, canonicalZones, resolvedLinks);

if (checkOnly) {
  const current = await readFile(OUTPUT_PATH, 'utf8');
  if (current !== generated) fail('generated registry is stale; run generate:iana-time-zones');
  process.stdout.write(`IANA ${lock.release} registry is reproducible and current\n`);
} else {
  await writeFile(OUTPUT_PATH, generated, 'utf8');
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

async function downloadArchive(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`download failed with HTTP ${response.status}`);
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_ARCHIVE_BYTES) {
    fail('source archive exceeds the pinned size ceiling');
  }
  return Buffer.from(await response.arrayBuffer());
}

function validateLock(value) {
  const exactKeys = [
    'release',
    'sourceUrl',
    'sourceSha256',
    'inputs',
    'expectedCanonicalZoneCount',
    'expectedLinkCount',
    'expectedRegistrySha256',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('lock must be an object');
  if (Object.keys(value).sort(asciiCompare).join('\n') !== exactKeys.sort(asciiCompare).join('\n')) {
    fail('lock has unknown or missing keys');
  }
  if (!/^20[0-9]{2}[a-z]$/.test(value.release)) fail('invalid release');
  if (value.sourceUrl !== `https://data.iana.org/time-zones/releases/tzdata${value.release}.tar.gz`) {
    fail('source URL is not the exact IANA release URL');
  }
  if (!/^[0-9a-f]{64}$/.test(value.sourceSha256)) fail('invalid source SHA-256');
  if (!/^[0-9a-f]{64}$/.test(value.expectedRegistrySha256)) fail('invalid registry SHA-256');
  if (!Array.isArray(value.inputs) || value.inputs.length === 0 ||
      value.inputs.some((entry) => typeof entry !== 'string' || !/^[a-z]+$/.test(entry)) ||
      new Set(value.inputs).size !== value.inputs.length) {
    fail('invalid inputs');
  }
  if (!Number.isSafeInteger(value.expectedCanonicalZoneCount) ||
      !Number.isSafeInteger(value.expectedLinkCount)) {
    fail('invalid expected counts');
  }
}

function parseTar(tar) {
  const files = new Map();
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    assertTarChecksum(header);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail(`invalid tar size for ${path}`);
    const size = Number.parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] || 0);
    const contentOffset = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentOffset + size;
    if (!Number.isSafeInteger(size) || contentEnd > tar.length) fail(`truncated tar entry ${path}`);
    if (type === '\0' || type === '0') {
      if (files.has(path)) fail(`duplicate tar entry ${path}`);
      files.set(path, Buffer.from(tar.subarray(contentOffset, contentEnd)));
    }
    offset = contentOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  return files;
}

function assertTarChecksum(header) {
  const checksumText = tarText(header.subarray(148, 156)).trim().replace(/\0/g, '');
  if (!/^[0-7]+$/.test(checksumText)) fail('invalid tar checksum field');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== Number.parseInt(checksumText, 8)) fail('tar checksum mismatch');
}

function tarText(bytes) {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
}

function findRequiredFile(files, baseName) {
  const matches = [...files.entries()].filter(([path]) =>
    path === baseName || path.endsWith(`/${baseName}`),
  );
  if (matches.length !== 1) fail(`expected exactly one archive entry for ${baseName}`);
  return matches[0][1];
}

function parseTzData(text, input, zones, links) {
  for (const rawLine of text.split('\n')) {
    const content = rawLine.replace(/\s*#.*$/, '').trim();
    if (!content) continue;
    const fields = content.split(/\s+/);
    if (fields[0] === 'Zone') {
      addUnique(zones, fields[1], `Zone in ${input}`);
    } else if (fields[0] === 'Link') {
      const [target, alias] = fields.slice(1);
      assertTzName(target, `Link target in ${input}`);
      assertTzName(alias, `Link alias in ${input}`);
      if (links.has(alias)) fail(`duplicate Link alias ${alias}`);
      links.set(alias, target);
    }
  }
}

function addUnique(set, value, label) {
  assertTzName(value, label);
  if (set.has(value)) fail(`duplicate ${label}: ${value}`);
  set.add(value);
}

function assertTzName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._+\/-]+$/.test(value)) {
    fail(`invalid ${label}`);
  }
}

function resolveCanonicalTarget(alias, zones, links) {
  const visited = new Set();
  let current = alias;
  while (!zones.has(current)) {
    if (visited.has(current)) fail(`Link cycle at ${current}`);
    visited.add(current);
    const target = links.get(current);
    if (!target) fail(`Link ${alias} has missing target ${current}`);
    current = target;
  }
  return current;
}

function registryDigestBytes(zones, links) {
  return Buffer.from([
    ...zones.map((name) => `Zone\t${name}`),
    ...links.map(([alias, target]) => `Link\t${alias}\t${target}`),
  ].join('\n') + '\n', 'utf8');
}

function renderGeneratedFile(value, zones, links) {
  const linkData = links.map(([alias, target]) => `${alias}\t${target}`).join('\n');
  return `/**
 * GENERATED FILE — do not hand edit.
 * Source: ${value.sourceUrl}
 * Release: ${value.release}
 * Source archive SHA-256: ${value.sourceSha256}
 * Inputs: ${value.inputs.join(', ')} (the pinned TDATA/BACKWARD set; backzone excluded).
 * Registry digest input: ASCII-sorted Zone\\t<name> lines followed by ASCII-sorted
 *   Link\\t<alias>\\t<resolved-canonical-target> lines, UTF-8 with a final LF.
 */

export const IANA_TIME_ZONE_REGISTRY_VERSION = '${value.release}' as const;
export const IANA_TIME_ZONE_REGISTRY_SOURCE_URL =
  '${value.sourceUrl}' as const;
export const IANA_TIME_ZONE_REGISTRY_SOURCE_SHA256 =
  'sha256:${value.sourceSha256}' as const;
export const IANA_TIME_ZONE_REGISTRY_SHA256 = 'sha256:${value.expectedRegistrySha256}' as const;
export const IANA_TIME_ZONE_CANONICAL_ZONE_COUNT = ${zones.length} as const;
export const IANA_TIME_ZONE_LINK_COUNT = ${links.length} as const;

const CANONICAL_ZONE_DATA = \`${zones.join('\n')}\`;

const LINK_TARGET_DATA = \`${linkData}\`;

export const IANA_TIME_ZONE_CANONICAL_NAMES_2026C = Object.freeze(
  CANONICAL_ZONE_DATA.split('\\n'),
) as readonly string[];

export const IANA_TIME_ZONE_LINK_TARGET_ENTRIES_2026C = Object.freeze(
  LINK_TARGET_DATA.split('\\n').map((entry) => {
    const separator = entry.indexOf('\\t');
    return Object.freeze([entry.slice(0, separator), entry.slice(separator + 1)] as const);
  }),
) as readonly (readonly [string, string])[];
`;
}

function assertSha256(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) fail(`${label} SHA-256 ${actual} does not match ${expected}`);
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`IANA_TZDB_GENERATION_FAILED: ${message}`);
}
