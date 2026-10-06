import type * as Platform from '@companion/platform-contracts';
import type { ExecutionAvailability } from './service-readiness';
export type View = 'chat' | 'companion' | 'voice' | 'create' | 'browser' | 'cli' | 'workflow' | 'knowledge' | 'mcp' | 'plans' | 'settings';
export type ChatMode = Platform.ChatMode;
export type JobKind = Platform.JobKind;
export type User = Platform.User;
export type Provider = Platform.ProviderStatus & { description?: string };
export type Conversation = Platform.Conversation;
export type Upload = Platform.Attachment;
// Optimistic messages only need display fields until the server returns persisted metadata.
export type Message = Pick<Platform.Message, 'id' | 'role' | 'content'> & Partial<Omit<Platform.Message, 'id' | 'role' | 'content'>>;
export type Artifact = Platform.Artifact;
export type Job = Platform.Job;
export type Memory = Platform.Memory;
export type Approval = Platform.Approval;
export interface PlatformState { status?: 'connected' | 'unavailable'; execution?: ExecutionAvailability; checkedAt?: string; providers: Provider[]; error?: string }
export type VoiceSession = Platform.VoiceSessionResult & { sessionId: string };
