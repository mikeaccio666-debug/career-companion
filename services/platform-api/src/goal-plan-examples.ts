import type { GoalPlanInput } from '@companion/platform-contracts';

/** Syntax teaching only. These fictional examples are never passed to execution or used as fallback plans. */
export const goalPlanExamples: Record<string, GoalPlanInput> = {
  analysis: {
    title: 'Fictional comparison', goal: 'Compare two hypothetical club activities',
    steps: [{ kind: 'agent_turn', title: 'Compare', provider: 'ollama', instruction: 'Compare the hypothetical choices; distinguish assumptions from evidence.' }],
  },
  browser: {
    title: 'Fictional page review', goal: 'Prepare a review of a fictional public page',
    steps: [{ kind: 'task', title: 'Read page', task: { kind: 'browser', provider: 'browser', prompt: 'Read this fictional page after user review.', options: { url: 'https://example.invalid', actions: [] } } }],
  },
  mcp: {
    title: 'Fictional reviewed tool', goal: 'Prepare a read-only tool call for individual approval',
    steps: [{ kind: 'task', title: 'Read reviewed tool', task: { kind: 'mcp', provider: 'mcp', prompt: 'Read the user-requested saved information.', options: { connectionId: '00000000-0000-4000-8000-000000000001', grantVersion: 1, toolName: 'fictional_read', schemaHash: 'a'.repeat(64), arguments: {} } } }],
  },
  workflow: {
    title: 'Fictional workflow', goal: 'Prepare one text workflow for individual approval',
    steps: [{ kind: 'task', title: 'Text workflow', task: { kind: 'workflow', provider: 'workflow', prompt: 'Compare fictional choices.', options: { steps: [{ kind: 'chat', provider: 'ollama', prompt: 'Compare the two hypothetical choices.' }] } } }],
  },
  creative: {
    title: 'Fictional club concept', goal: 'Plan a concept, poster and short video',
    steps: [
      { kind: 'agent_turn', title: 'Concept', provider: 'ollama', instruction: 'Describe a fictional club event concept.' },
      { kind: 'task', title: 'Poster', task: { kind: 'image', provider: 'openai', prompt: 'Create a poster from the approved concept.' }, bindings: { prompt: { fromStep: 0, source: 'analysis_text', mode: 'append' } } },
      { kind: 'task', title: 'Video', task: { kind: 'video', provider: 'ark', prompt: 'Animate the approved poster.' }, bindings: { referenceImages: [{ fromStep: 1 }] } },
    ],
  },
  narratedVideo: {
    title: 'Fictional narrated clip', goal: 'Prepare a short fictional clip and narration, then review their combination',
    steps: [
      { kind: 'task', title: 'Clip', task: { kind: 'video', provider: 'ark', prompt: 'Generate a fictional paper boat clip.' } },
      { kind: 'task', title: 'Narration', task: { kind: 'speech', provider: 'kokoro', prompt: 'A paper boat drifts on a quiet pond.' } },
      { kind: 'task', title: 'Combine reviewed files', task: { kind: 'cli', provider: 'cli', prompt: 'Inspect the supplied clip and narration files, combine them into a playable MP4 in the output directory and report what was verified.' }, bindings: { artifactFiles: [{ fromStep: 0 }, { fromStep: 1 }] } },
    ],
  },
};

export const goalPlanFormatGuidance = 'Required root fields are title, goal, steps. Every step needs its own title. Text analysis uses {kind:"agent_turn",title,instruction,provider}; it is not task kind "chat". A task step uses {kind:"task",title,task:{kind,provider,prompt,options?},bindings?}. Browser uses provider "browser" and options {url,actions?}. Workflow uses provider "workflow" and options {steps:[{kind,provider,prompt,options?}]}. MCP uses provider "mcp" and options {connectionId,grantVersion,toolName,schemaHash,arguments}; copy these exact saved fields from list_mcp_tools, never invent them. Omit optional fields instead of sending null. If INVALID_INPUT includes diagnostic, correct the named field yourself before trying again. Examples below teach syntax only: replace fictional content, IDs, hashes, providers and models using this user request and actually returned metadata. They are not permission, a fallback plan or proof that a provider is enabled. ' + JSON.stringify(goalPlanExamples);
