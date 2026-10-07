/** Conservative container/header recognition, not a substitute for codec decoding. */
export function cliMediaMime(extension: string, bytes: Buffer): string | undefined {
  if (['.mp4', '.m4v', '.m4a'].includes(extension) && bytes.length >= 16 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size >= 16 && size <= bytes.length && size <= 4096 && size % 4 === 0) {
      const brands = [bytes.toString('latin1', 8, 12)];
      for (let offset = 16; offset < size; offset += 4) brands.push(bytes.toString('latin1', offset, offset + 4));
      if (brands.some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'dash', 'qt  '].includes(brand)))
        return extension === '.m4a' ? 'audio/mp4' : 'video/mp4';
    }
  }
  if (extension === '.wav' && bytes.length >= 44 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
      bytes.toString('latin1', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) === bytes.length - 8) {
    let offset = 12, format = false, data = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('latin1', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8, end = start + size;
      if (end + size % 2 > bytes.length) return undefined;
      if (kind === 'fmt ') { if (size < 16) return undefined; format = true; }
      if (kind === 'data') { if (!size) return undefined; data = true; }
      offset = end + size % 2;
    }
    if (offset === bytes.length && format && data) return 'audio/wav';
  }
  if (['.webm', '.weba'].includes(extension) && webmHeader(bytes))
    return extension === '.weba' ? 'audio/webm' : 'video/webm';
  return undefined;
}

function vint(bytes: Buffer, offset: number, id = false): { length: number; value: number } | undefined {
  const first = bytes[offset];
  if (!first) return;
  let length = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; if (++length > (id ? 4 : 8)) return; }
  if (offset + length > bytes.length) return;
  let value = id ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
  if (!Number.isSafeInteger(value)) return;
  return { length, value };
}
function webmHeader(bytes: Buffer): boolean {
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const size = vint(bytes, 4);
  if (!size || size.value > 4096 || 4 + size.length + size.value > bytes.length) return false;
  let offset = 4 + size.length;
  const end = offset + size.value;
  let type = false;
  while (offset < end) {
    const id = vint(bytes, offset, true); if (!id) return false; offset += id.length;
    const value = vint(bytes, offset); if (!value) return false; offset += value.length;
    if (offset + value.value > end) return false;
    if (id.value === 0x4282) {
      if (type || value.value !== 4 || bytes.toString('latin1', offset, offset + 4) !== 'webm') return false;
      type = true;
    }
    offset += value.value;
  }
  return type && offset === end;
}
