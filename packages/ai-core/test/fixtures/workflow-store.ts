import assert from 'node:assert/strict';
import type { CreateJobInput, JobExecutionContext, WorkflowCheckpoint, WorkflowCheckpointEvent, ProviderAttachment, GeneratedArtifact } from '@companion/platform-contracts';
import { workflowDefinitionHash } from '../../src/workflow.ts';

/** Synthetic durable port. Authorization and SQL transitions are tested by the API package. */
export function workflowStore(input: CreateJobInput, base: JobExecutionContext) {
  let checkpoint: WorkflowCheckpoint = { definitionHash: workflowDefinitionHash(input), revision: 0, steps: [] };
  const events: WorkflowCheckpointEvent[] = [];
  const files = new Map<string, ProviderAttachment>();
  const published: GeneratedArtifact[] = [];
  let sequence = 0;
  const store = {
    events, files, published,
    snapshot: () => structuredClone(checkpoint),
    replace: (value: WorkflowCheckpoint) => { checkpoint = structuredClone(value); },
    onEvent: undefined as ((event: WorkflowCheckpointEvent) => Promise<void> | void) | undefined,
    afterSave: undefined as ((event: WorkflowCheckpointEvent, saved: WorkflowCheckpoint) => Promise<WorkflowCheckpoint> | WorkflowCheckpoint) | undefined,
    async save(event: WorkflowCheckpointEvent): Promise<WorkflowCheckpoint> {
      assert.equal(event.expectedRevision, checkpoint.revision);
      await store.onEvent?.(event);
      const current = checkpoint.steps[event.index];
      if (current) assert.equal(current.inputHash, event.inputHash);
      const step = { ...(current ?? {}), index: event.index, inputHash: event.inputHash, state: event.type } as WorkflowCheckpoint['steps'][number];
      if (event.type === 'started') { delete step.providerTaskId; delete step.errorCode; }
      if (event.type === 'provider_task') step.providerTaskId = event.providerTaskId;
      if (event.type === 'failed' || event.type === 'uncertain') step.errorCode = event.errorCode;
      if (event.type === 'completed') {
        step.text = event.result.text;
        step.artifacts = event.result.artifacts.map(file => {
          const id = `fixture-artifact-${++sequence}`;
          const saved = { ...file, bytes: new Uint8Array(file.bytes) };
          files.set(id, saved); published.push(saved);
          return { attachmentId: id, name: file.name, mime: file.mime, size: file.bytes.byteLength };
        });
      }
      checkpoint.steps[event.index] = step;
      checkpoint.revision++;
      events.push(structuredClone(event));
      const saved = store.snapshot();
      return store.afterSave ? store.afterSave(event, saved) : saved;
    },
    context(overrides: Partial<JobExecutionContext> = {}): JobExecutionContext {
      return { ...base, workflowCheckpoint: store.snapshot(), onWorkflowCheckpoint: event => store.save(event),
        readWorkflowArtifact: async id => {
          const authorized = checkpoint.steps.some(step => step.state === 'completed' && step.artifacts?.some(ref => ref.attachmentId === id));
          assert.ok(authorized);
          const file = files.get(id); if (!file) throw new Error('Synthetic missing blob');
          return { ...file, bytes: new Uint8Array(file.bytes) };
        }, ...overrides };
    },
  };
  return store;
}
