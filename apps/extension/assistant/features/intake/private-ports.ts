import type { IntakeCommand, IntakeEvent, IntakeResult } from '@edaix/contracts';
export interface PrivateIntakePorts {
  execute(command: IntakeCommand, signal: AbortSignal, onEvent?: (event: IntakeEvent) => void): Promise<IntakeResult>;
  record?(signal: AbortSignal, onTranscript: (text: string) => void, onState: (state: 'recording' | 'processing') => void): Promise<{ ok: true } | { ok: false; code: import('@edaix/contracts').IntakeClientCode }>;
  stopRecording?(): void;
}
