import { parseUuid } from './common.ts';
import { closedRecord } from './profileSnapshotValidation.ts';
import { INTAKE_CLIENT_CODES, type IntakeClientCode } from './assistantIntake.ts';
export const INTAKE_RECORDER_PORT = 'assistant/intake-recorder-v1';
export type IntakeVoiceControl = { kind: 'assistant/voice-control-v1'; id: string; operation: 'START' | 'STOP' | 'CANCEL' };
export type IntakeVoiceEvent = { kind: 'assistant/voice-event-v1'; id: string } & (
  { event: 'STATE'; state: 'recording' | 'processing' } | { event: 'TRANSCRIPT'; text: string } |
  { event: 'END'; code: IntakeClientCode | null });
export type IntakeRecorderMessage = { kind: 'READY' } | { kind: 'CHUNK'; index: number; base64: string } |
  { kind: 'STOPPED' } | { kind: 'ERROR'; code: IntakeClientCode };
export type IntakeRecorderCommand = { kind: 'START'; maximumSeconds: number; chunkSeconds: number } |
  { kind: 'ACK'; index: number } | { kind: 'STOP' } | { kind: 'CANCEL' };
export function parseIntakeVoiceControl(v: unknown): IntakeVoiceControl | null {
  return closedRecord(v, ['kind', 'id', 'operation']) && v.kind === 'assistant/voice-control-v1' && !!parseUuid(v.id) &&
    ['START', 'STOP', 'CANCEL'].includes(v.operation as string) ? v as unknown as IntakeVoiceControl : null;
}
export function parseIntakeVoiceEvent(v: unknown): IntakeVoiceEvent | null {
  if (!v || typeof v !== 'object') return null; const r = v as Record<string, unknown>;
  if (r.kind !== 'assistant/voice-event-v1' || !parseUuid(r.id)) return null;
  const keys = ['kind', 'id', 'event'];
  if (r.event === 'STATE' && closedRecord(r, [...keys, 'state']) && ['recording', 'processing'].includes(r.state as string) ||
    r.event === 'TRANSCRIPT' && closedRecord(r, [...keys, 'text']) && typeof r.text === 'string' && r.text.length > 0 && [...r.text].length <= 16000 ||
    r.event === 'END' && closedRecord(r, [...keys, 'code']) && (r.code === null || INTAKE_CLIENT_CODES.includes(r.code as IntakeClientCode))) return r as unknown as IntakeVoiceEvent;
  return null;
}
export function parseIntakeRecorderMessage(v: unknown): IntakeRecorderMessage | null {
  if (!v || typeof v !== 'object') return null; const r = v as Record<string, unknown>;
  if ((r.kind === 'READY' || r.kind === 'STOPPED') && closedRecord(r, ['kind'])) return r as unknown as IntakeRecorderMessage;
  if (r.kind === 'ERROR' && closedRecord(r, ['kind', 'code']) && INTAKE_CLIENT_CODES.includes(r.code as IntakeClientCode)) return r as unknown as IntakeRecorderMessage;
  if (r.kind === 'CHUNK' && closedRecord(r, ['kind', 'index', 'base64']) && Number.isInteger(r.index) && (r.index as number) >= 0 &&
    (r.index as number) < 900 && typeof r.base64 === 'string' && r.base64.length <= 1280060 && /^[A-Za-z0-9+/]+={0,2}$/.test(r.base64)) return r as unknown as IntakeRecorderMessage;
  return null;
}
export function parseIntakeRecorderCommand(v: unknown): IntakeRecorderCommand | null {
  if (!v || typeof v !== 'object') return null; const r = v as Record<string, unknown>;
  if ((r.kind === 'STOP' || r.kind === 'CANCEL') && closedRecord(r, ['kind'])) return r as unknown as IntakeRecorderCommand;
  if (r.kind === 'ACK' && closedRecord(r, ['kind', 'index']) && Number.isInteger(r.index) && (r.index as number) >= 0) return r as unknown as IntakeRecorderCommand;
  if (r.kind === 'START' && closedRecord(r, ['kind', 'maximumSeconds', 'chunkSeconds']) && Number.isInteger(r.maximumSeconds) && (r.maximumSeconds as number) > 0 &&
    (r.maximumSeconds as number) <= 900 && Number.isInteger(r.chunkSeconds) && (r.chunkSeconds as number) > 0 && (r.chunkSeconds as number) <= 30) return r as unknown as IntakeRecorderCommand;
  return null;
}
