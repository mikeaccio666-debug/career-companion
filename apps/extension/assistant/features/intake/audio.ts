/** PCM16 mono 16 kHz, matching the API's closed WAV decoder. No audio persistence. */
export function encodeIntakePcm(samples: Float32Array): Uint8Array {
  if (!samples.length || samples.length > 480000 || samples.some(n => !Number.isFinite(n))) throw new Error('INTAKE_AUDIO_INVALID');
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const label = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((n, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, n)) * (n < 0 ? 32768 : 32767), true));
  return bytes;
}
export function decodeIntakeAudio(bytes: Uint8Array): { samples: number } | null {
  if (bytes.length < 46 || bytes.length > 960044 || bytes.length % 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (at: number, value: string) => [...value].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (!label(0, 'RIFF') || view.getUint32(4, true) !== bytes.length - 8 || !label(8, 'WAVEfmt ') || view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 ||
    view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || !label(36, 'data') || view.getUint32(40, true) !== bytes.length - 44) return null;
  return { samples: (bytes.length - 44) / 2 };
}
