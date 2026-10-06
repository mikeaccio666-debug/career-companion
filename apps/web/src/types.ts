import type * as Platform from '@companion/platform-contracts';
export type View = 'chat' | 'companion' | 'voice' | 'create' | 'browser' | 'cli' | 'workflow' | 'knowledge' | 'settings';
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
export interface PlatformState { status?: string; providers: Provider[]; error?: string }
export type VoiceSession = Platform.VoiceSessionResult & { sessionId: string };
