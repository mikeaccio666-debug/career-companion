import { describe, expect, it } from 'vitest';
import { encodeIntakePcm, decodeIntakeAudio } from '../assistant/features/intake/audio';
describe('private intake audio', () => {
  it('encodes exact sample duration and rejects changed headers or oversized chunks', () => {
    const bytes = encodeIntakePcm(new Float32Array([0, .5, -1]));
    expect(decodeIntakeAudio(bytes)?.samples).toBe(3);
    expect(new DataView(bytes.buffer).getInt16(48, true)).toBe(-32768);
    bytes[24] = 0;
    expect(decodeIntakeAudio(bytes)).toBeNull();
    expect(() => encodeIntakePcm(new Float32Array(480001))).toThrow('INTAKE_AUDIO_INVALID');
  });
});
