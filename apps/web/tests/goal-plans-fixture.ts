import type { GoalPlan, GoalPlanInput, Job } from '@companion/platform-contracts';
export const conversationId = '71000000-0000-4000-8000-000000000001';
export const planId = '71000000-0000-4000-8000-000000000002';
export const jobId = '71000000-0000-4000-8000-000000000003';
export const messageId = '71000000-0000-4000-8000-000000000004';
export const artifactId = '71000000-0000-4000-8000-000000000005';
export const approvalId = '71000000-0000-4000-8000-000000000006';
export const instant = '2026-10-06T00:00:00.000Z';
export function input(): GoalPlanInput { return { title: 'Fictional goal', goal: 'Compare fictional alternatives using saved evidence.', steps: [{ kind: 'agent_turn', title: 'Fictional analysis', instruction: 'Compare the saved fictional evidence and state uncertainty.', provider: 'fictional-unconfigured' }] }; }
export function plan(overrides: Partial<GoalPlan> = {}): GoalPlan { const definition = input(); return { ...definition, id: planId, conversationId, revision: 1, status: 'draft', definitionHash: 'a'.repeat(64), steps: definition.steps.map((input, index) => ({ index, input, state: 'pending', ready: false, artifacts: [] })), createdAt: instant, updatedAt: instant, ...overrides }; }
export function job(): Job { return { id: jobId, kind: 'image', provider: 'fictional-images', prompt: 'Generate a fictional diagram.', artifacts: [], status: 'needs_approval', progress: 0, attempt: 0, createdAt: instant, updatedAt: instant }; }
export function taskPlan(): GoalPlan { const task = job(); return plan({ status: 'active', confirmedAt: instant, steps: [{ index: 0, input: { kind: 'task', title: 'Fictional task', task: { kind: task.kind, provider: task.provider, prompt: task.prompt } }, state: 'needs_approval', ready: false, job: task, generation: 1, approval: { id: approvalId, jobId, toolName: 'image', status: 'pending', createdAt: instant, generation: 1, args: { kind: task.kind, provider: task.provider, prompt: task.prompt } }, artifacts: [] }] }); }
export function activePlan(): GoalPlan { const value = plan({ status: 'active', confirmedAt: instant }); value.steps[0].ready = true; return value; }
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
