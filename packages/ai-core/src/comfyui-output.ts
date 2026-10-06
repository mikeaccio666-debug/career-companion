import type { GeneratedArtifact } from '@companion/platform-contracts';
import { ProviderError } from './errors.ts';
import { mediaImageMime } from './media-input.ts';

const invalid = () => new ProviderError('COMFYUI_OUTPUT_INVALID', 'The generation server returned unsupported media or metadata that does not match the reviewed output kind.');
const MAX_ELEMENTS = 65_536;
const text = (bytes: Uint8Array, start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
type Box = { type: string; start: number; end: number };

/** Bounded container identity checks, not codec decoding, playback or visual-quality certification. */
function mp4Video(bytes: Uint8Array): boolean {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (++count > MAX_ELEMENTS || end - start < 8) throw invalid();
      let size = data.getUint32(start), header = 8;
      const type = text(bytes, start + 4, start + 8);
      if (size === 1) {
        if (end - start < 16) throw invalid();
        const large = data.getBigUint64(start + 8); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
        size = Number(large); header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start) throw invalid();
      result.push({ type, start: start + header, end: start + size }); start += size;
    }
    return result;
  }
  const top = boxes(0, bytes.length), ftyp = top.find(box => box.type === 'ftyp');
  if (!ftyp || ftyp.end - ftyp.start < 8 || (ftyp.end - ftyp.start) % 4 !== 0 ||
      !top.some(box => box.type === 'mdat' && box.end > box.start)) return false;
  const brands = [text(bytes, ftyp.start, ftyp.start + 4)];
  for (let index = ftyp.start + 8; index < ftyp.end; index += 4) brands.push(text(bytes, index, index + 4));
  if (!brands.some(brand => ['isom', 'mp41', 'mp42', 'avc1', 'av01', 'dash', 'M4V ', 'MSNV'].includes(brand) || /^iso[2-9]$/.test(brand))) return false;
  const videoTracks = new Set<number>(), trackIds = new Set<number>(); let video = false;
  function sampleSizes(item: Box): boolean {
    if (item.end - item.start < 12) throw invalid();
    const count = data.getUint32(item.start + 8);
    if (!count) return false; if (count > MAX_ELEMENTS) throw invalid();
    if (item.type === 'stsz') {
      if (data.getUint32(item.start + 4) > 0) return true;
      if (count > MAX_ELEMENTS || count * 4 > item.end - item.start - 12) throw invalid();
      for (let index = 0; index < count; index++) if (data.getUint32(item.start + 12 + index * 4) > 0) return true;
    } else {
      const fieldSize = bytes[item.start + 7]!;
      if (![4, 8, 16].includes(fieldSize) || count > MAX_ELEMENTS || Math.ceil(count * fieldSize / 8) > item.end - item.start - 12) throw invalid();
      for (let index = 0; index < count; index++) {
        const offset = item.start + 12 + Math.floor(index * fieldSize / 8);
        const size = fieldSize === 4 ? (bytes[offset]! >> (index % 2 === 0 ? 4 : 0)) & 15 : fieldSize === 8 ? bytes[offset]! : data.getUint16(offset);
        if (size > 0) return true;
      }
    }
    return false;
  }
  for (const movie of top.filter(box => box.type === 'moov')) for (const track of boxes(movie.start, movie.end).filter(box => box.type === 'trak')) {
    const trackChildren = boxes(track.start, track.end), tkhd = trackChildren.find(box => box.type === 'tkhd');
    if (!tkhd || tkhd.end - tkhd.start < 4 || ![0, 1].includes(bytes[tkhd.start]!)) continue;
    const idOffset = tkhd.start + (bytes[tkhd.start] === 1 ? 20 : 12);
    if (tkhd.end - idOffset < 4) throw invalid(); const trackId = data.getUint32(idOffset); if (!trackId || trackIds.has(trackId)) throw invalid(); trackIds.add(trackId);
    let description = false, samples = false;
    for (const media of trackChildren.filter(box => box.type === 'mdia')) {
      const children = boxes(media.start, media.end), handler = children.find(box => box.type === 'hdlr');
      if (!handler || handler.end - handler.start < 12 || text(bytes, handler.start + 8, handler.start + 12) !== 'vide') continue;
      for (const info of children.filter(box => box.type === 'minf')) for (const table of boxes(info.start, info.end).filter(box => box.type === 'stbl')) {
        const tables = boxes(table.start, table.end);
        for (const sizes of tables.filter(box => ['stsz', 'stz2'].includes(box.type))) samples ||= sampleSizes(sizes);
        for (const descriptions of tables.filter(box => box.type === 'stsd')) {
          if (descriptions.end - descriptions.start < 8) throw invalid();
          const entries = boxes(descriptions.start + 8, descriptions.end);
          if (entries.length !== data.getUint32(descriptions.start + 4)) throw invalid();
          description ||= entries.some(entry => ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp08', 'vp09', 'mp4v'].includes(entry.type) &&
            entry.end - entry.start >= 78 && data.getUint16(entry.start + 24) > 0 && data.getUint16(entry.start + 26) > 0);
        }
      }
    }
    if (description) { videoTracks.add(trackId); video ||= samples; }
  }
  // Fragmented MP4 keeps sample counts in moof/traf, matched to moov's video track ID.
  for (const fragment of top.filter(box => box.type === 'moof')) for (const track of boxes(fragment.start, fragment.end).filter(box => box.type === 'traf')) {
    const children = boxes(track.start, track.end), tfhd = children.find(box => box.type === 'tfhd');
    if (!tfhd || tfhd.end - tfhd.start < 8 || !videoTracks.has(data.getUint32(tfhd.start + 4))) continue;
    for (const run of children.filter(box => box.type === 'trun')) {
      if (run.end - run.start < 8) throw invalid(); const flags = data.getUint32(run.start) & 0xffffff, samples = data.getUint32(run.start + 4);
      const optional = (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0), perSample = [0x100, 0x200, 0x400, 0x800].filter(flag => flags & flag).length * 4;
      if (samples > MAX_ELEMENTS || optional + samples * perSample > run.end - run.start - 8) throw invalid();
      if (samples > 0) video = true;
    }
  }
  return video;
}

type Element = { id: number; start: number; end: number; unknown: boolean };
function webmVideo(bytes: Uint8Array): boolean {
  let count = 0;
  function vint(start: number, end: number, id = false): { value: number; length: number; unknown: boolean } {
    if (start >= end || bytes[start] === 0) throw invalid();
    let length = 1, marker = 0x80;
    while (!(bytes[start]! & marker)) { marker >>= 1; length++; }
    if (length > (id ? 4 : 8) || start + length > end) throw invalid();
    let value = BigInt(id ? bytes[start]! : bytes[start]! & (marker - 1));
    for (let index = 1; index < length; index++) value = value * 256n + BigInt(bytes[start + index]!);
    const unknown = !id && value === (1n << BigInt(7 * length)) - 1n;
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return { value: unknown ? 0 : Number(value), length, unknown };
  }
  function element(start: number, end: number): Element {
    if (++count > MAX_ELEMENTS) throw invalid();
    const id = vint(start, end, true), size = vint(start + id.length, end), payload = start + id.length + size.length;
    if (!size.unknown && size.value > end - payload) throw invalid();
    if (size.unknown && ![0x18538067, 0x1f43b675].includes(id.value)) throw invalid();
    return { id: id.value, start: payload, end: size.unknown ? end : payload + size.value, unknown: size.unknown };
  }
  function elements(start: number, end: number): Element[] {
    const result: Element[] = [];
    while (start < end) { const item = element(start, end); result.push(item); start = item.end; }
    return result;
  }
  function uint(item: Element): number {
    if (item.end - item.start < 1 || item.end - item.start > 8) throw invalid();
    let value = 0n; for (let index = item.start; index < item.end; index++) value = value * 256n + BigInt(bytes[index]!);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(); return Number(value);
  }
  const header = element(0, bytes.length);
  if (header.id !== 0x1a45dfa3 || !elements(header.start, header.end).some(item => item.id === 0x4282 && text(bytes, item.start, item.end) === 'webm')) return false;
  const root = elements(header.end, bytes.length), segments = root.filter(item => item.id === 0x18538067);
  if (segments.length !== 1) return false;
  const segment = segments[0]!, children: Element[] = [], clusters: Element[] = [];
  const levelOne = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
  for (let start = segment.start; start < segment.end;) {
    const item = element(start, segment.end);
    if (item.id === 0x1f43b675 && item.unknown) {
      let finish = item.start;
      while (finish < item.end) { const child = element(finish, item.end); if (levelOne.has(child.id)) break; finish = child.end; }
      item.end = finish;
    }
    children.push(item); if (item.id === 0x1f43b675) clusters.push(item); start = item.end;
  }
  const tracks = new Set<number>(), trackNumbers = new Set<number>();
  for (const container of children.filter(item => item.id === 0x1654ae6b)) for (const entry of elements(container.start, container.end).filter(item => item.id === 0xae)) {
    const fields = elements(entry.start, entry.end), type = fields.find(item => item.id === 0x83), number = fields.find(item => item.id === 0xd7), codec = fields.find(item => item.id === 0x86), video = fields.find(item => item.id === 0xe0);
    if (!number || uint(number) < 1 || trackNumbers.has(uint(number))) throw invalid(); trackNumbers.add(uint(number));
    if (!type || uint(type) !== 1 || !codec || !['V_VP8', 'V_VP9', 'V_AV1'].includes(text(bytes, codec.start, codec.end)) || !video) continue;
    const dimensions = elements(video.start, video.end), width = dimensions.find(item => item.id === 0xb0), height = dimensions.find(item => item.id === 0xba);
    if (width && height && uint(width) > 0 && uint(height) > 0) tracks.add(uint(number));
  }
  let videoData = false;
  function block(item: Element) {
    const track = vint(item.start, item.end);
    if (track.unknown || item.end - item.start <= track.length + 3) throw invalid();
    if (tracks.has(track.value)) videoData = true;
  }
  for (const cluster of clusters) for (const item of elements(cluster.start, cluster.end)) {
    if (item.id === 0xa3) block(item);
    else if (item.id === 0xa0) for (const group of elements(item.start, item.end)) if (group.id === 0xa1) block(group);
  }
  return tracks.size > 0 && videoData;
}

export function validatedComfyOutput(kind: 'image' | 'video', bytes: Uint8Array, declaredMime: string | null, index: number): GeneratedArtifact {
  const mime = declaredMime?.split(';', 1)[0]?.trim().toLowerCase();
  if (kind === 'image') {
    const actual = mediaImageMime(bytes); if (!actual || actual !== mime) throw invalid();
    return { name: `image-${index + 1}.${actual === 'image/jpeg' ? 'jpg' : actual === 'image/webp' ? 'webp' : 'png'}`, mime: actual, bytes };
  }
  let matches = false;
  try { matches = mime === 'video/mp4' ? mp4Video(bytes) : mime === 'video/webm' ? webmVideo(bytes) : false; } catch { throw invalid(); }
  if (!matches) throw invalid();
  return { name: `video-${index + 1}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`, mime: mime!, bytes };
}
