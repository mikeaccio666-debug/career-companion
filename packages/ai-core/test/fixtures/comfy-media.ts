// Synthetic container fixtures exercise identity checks, not codec decoding or generation quality.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
export function box(type: string, ...parts: Uint8Array[]): Buffer {
  const payload = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(payload.length + 8); head.write(type, 4, 'ascii'); return Buffer.concat([head, payload]);
}
export function mp4(options: { handler?: string; brand?: string; media?: boolean; dimensions?: boolean; sampleCount?: number; sampleSize?: number; fragmentTrack?: number; fragmentCount?: number; compactSamples?: boolean; trackId?: number } = {}): Buffer {
  const handler = Buffer.alloc(12); handler.write(options.handler ?? 'vide', 8, 'ascii');
  const sample = Buffer.alloc(78); sample.writeUInt16BE(options.dimensions === false ? 0 : 1, 24); sample.writeUInt16BE(1, 26);
  const descriptions = Buffer.alloc(8); descriptions.writeUInt32BE(1, 4);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(options.trackId ?? 1, 12);
  const sizes = Buffer.alloc(12); sizes.writeUInt32BE(options.sampleCount ?? (options.fragmentTrack === undefined ? 1 : 0), 8);
  if (options.compactSamples) sizes[7] = 8; else sizes.writeUInt32BE(options.sampleSize ?? 3, 4);
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(options.fragmentTrack ?? 1, 4);
  const trun = Buffer.alloc(8); trun.writeUInt32BE(options.fragmentCount ?? 1, 4);
  return Buffer.concat([box('ftyp', Buffer.from(options.brand ?? 'isom'), Buffer.alloc(4), Buffer.from('mp42')),
    box('moov', box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', handler), box('minf', box('stbl', box('stsd', descriptions, box('avc1', sample)), options.compactSamples ? box('stz2', sizes, Buffer.from([options.sampleSize ?? 3])) : box('stsz', sizes, ...(options.sampleSize === 0 ? [Buffer.alloc(4)] : []))))))),
    ...(options.fragmentTrack === undefined ? [] : [box('moof', box('traf', box('tfhd', tfhd), box('trun', trun)))]),
    box('mdat', options.media === false ? Buffer.alloc(0) : Buffer.from([1, 2, 3]))]);
}
export function ebml(id: number, payload: Uint8Array, unknown = false): Buffer {
  const hex = id.toString(16), identifier = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  if (payload.length >= 127) throw new Error('Keep these synthetic EBML elements small');
  return Buffer.concat([identifier, Buffer.from([unknown ? 255 : 128 | payload.length]), payload]);
}
export function webm(options: { audio?: boolean; docType?: string; blockTrack?: number; noFrame?: boolean; unknownSegment?: boolean; unknownCluster?: boolean; twoClusters?: boolean; group?: boolean } = {}): Buffer {
  const track = ebml(0xae, Buffer.concat([ebml(0xd7, Buffer.from([1])), ebml(0x83, Buffer.from([options.audio ? 2 : 1])),
    ebml(0x86, Buffer.from(options.audio ? 'A_OPUS' : 'V_VP9')), ebml(0xe0, Buffer.concat([ebml(0xb0, Buffer.from([1])), ebml(0xba, Buffer.from([1]))]))]));
  const block = Buffer.from([0x80 | (options.blockTrack ?? 1), 0, 0, 0x80, ...(options.noFrame ? [] : [1, 2])]);
  const cluster = () => ebml(0x1f43b675, options.group ? ebml(0xa0, ebml(0xa1, block)) : ebml(0xa3, block), options.unknownCluster);
  return Buffer.concat([ebml(0x1a45dfa3, ebml(0x4282, Buffer.from(options.docType ?? 'webm'))),
    ebml(0x18538067, Buffer.concat([ebml(0x1654ae6b, track), cluster(), ...(options.twoClusters ? [cluster()] : [])]), options.unknownSegment)]);
}
