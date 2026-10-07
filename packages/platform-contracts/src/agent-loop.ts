import type { ChatInput, ModelCallEvent, ProviderChatMessage, ToolDefinition, ProviderRequestAdmission } from './index.ts';

export const EXPERT_KEYS = Object.freeze(['planner', 'guide', 'coach', 'interviewer', 'networker', 'applier'] as const);
export type ExpertKey = typeof EXPERT_KEYS[number];
export type AgentSpeakerKey = 'companion' | ExpertKey;
export type SpeakerKey = AgentSpeakerKey;
export type AgentRoomKind = 'main' | 'expert_room' | 'interview' | 'mentor_room';

export type ToolEffect = 'read' | 'draft' | 'act' | 'consult' | 'ask_user' | 'background' | 'none';
export interface AgentToolDefinition extends ToolDefinition {
  effect: ToolEffect;
  progressPhrase: string;
  endsTurn: boolean;
  timeoutMs?: number;
  maxResultChars?: number;
  phraseGroup?: string;
}
export interface ModelToolCall { callId: string; name: string; arguments: string; index?: number; }
export interface ModelToolResult { callId: string; result: unknown; }
/** Opaque, single-use, invocation-local provider context. Never persist, log, or send to a client. */
export type ModelStepContinuation = object;
export type ModelStepEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_started'; index: number; callId?: string; name?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };
export interface ModelStepResult {
  text: string;
  calls: ModelToolCall[];
  continuation?: ModelStepContinuation;
}
export interface ModelStepContext {
  requestAdmission?: ProviderRequestAdmission;
  tools: ToolDefinition[];
  /** Stable full catalogue plus a per-step permission mask. Compatible adapters send only this subset. */
  allowedToolNames?: string[];
  toolChoice: 'auto' | 'none';
  limits: { maxOutputTokens: number };
  callIndex: number;
  purpose?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  timeoutMs: number;
  firstTokenTimeoutMs?: number;
  signal?: AbortSignal;
  onModelCall?: (event: ModelCallEvent) => Promise<void> | void;
  continuation?: ModelStepContinuation;
  /** Runtime-only binding shared by calls of one loop; never a client identifier. */
  invocation: object;
  toolResults?: ModelToolResult[];
}
export interface AgentLoopLimits {
  maxRounds: number; maxToolCalls: number; maxOutputTokens: number; timeoutMs: number;
}
export type AgentEvent =
  | { type: 'round_started'; round: number }
  | { type: 'delta'; text: string }
  | { type: 'tool_started'; callId: string; phrase: string }
  | { type: 'tool_finished'; callId: string; ok: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number };
export interface AgentToolExecution {
  callId: string; idempotencyKey: string; turnId: string; effect: ToolEffect; signal?: AbortSignal;
}
/** All callbacks are server-owned. Tools and model binding never come from a student request. */
export interface AgentLoopContext {
  requestAdmission?: ProviderRequestAdmission;
  turnId: string;
  purpose: string;
  limits: AgentLoopLimits;
  signal?: AbortSignal;
  resolveTools(): Promise<AgentToolDefinition[]> | AgentToolDefinition[];
  /** Trusted prepared-skill limits, intersected with the original profile budget; never allowed to expand it. */
  resolveLimits?(): Promise<Partial<AgentLoopLimits> | undefined> | Partial<AgentLoopLimits> | undefined;
  /** Fixed definition order for the whole invocation. A resolved tool must match this catalogue. */
  toolDefinitions: AgentToolDefinition[];
  executeTool(name: string, input: Record<string, unknown>, execution: AgentToolExecution): Promise<unknown>;
  drainInterjections(): Promise<ProviderChatMessage[]> | ProviderChatMessage[];
  assertActive?(): Promise<void> | void;
  consultDepth?: number;
  onModelCall?: (event: ModelCallEvent) => Promise<void> | void;
  firstTokenTimeoutMs?: number;
  callTimeoutMs?: number;
  /** After the whole-turn deadline, one tools-disabled completion gets at most 5 seconds. */
  finalTimeoutMs?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /** Trusted hook for dynamic context (for example a newly loaded skill), never request data. */
  beforeStep?(input: ChatInput): Promise<ChatInput> | ChatInput;
}
