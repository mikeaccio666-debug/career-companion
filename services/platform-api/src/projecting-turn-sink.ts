import type { Message, PublicToolProgress } from '@companion/platform-contracts';
import type { TurnPreparation, TurnSink, TurnSinkCallbacks } from './turn-sinks.ts';
import { projectPublicError, projectPublicMessage } from './student-projection.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Student presentation adapter, not a new runtime or authorization boundary.
 * Lifecycle calls remain synchronous and identical to the underlying sink.
 * A presentation failure must not turn a persisted complete response into failed. */
export class ProjectingTurnSink implements TurnSink {
  private messageId?: string;
  private readonly inner: TurnSink;
  constructor(inner: TurnSink) { this.inner = inner; }

  prepare(): TurnPreparation { this.messageId = undefined; return this.inner.prepare(); }
  open(callbacks: TurnSinkCallbacks): void { this.inner.open(callbacks); }
  settle(): void { this.inner.settle(); }
  close(): void { this.inner.close(); }

  emit(event: string, payload: unknown): void {
    try {
      const publicPayload = this.project(event, payload);
      if (publicPayload !== undefined) this.inner.emit(event, publicPayload);
    } catch {
      // Fail closed on an invalid presentation/closed transport. No raw fallback,
      // logging of source data, asynchronous work or domain persistence mutation.
    }
  }

  private project(event: string, payload: unknown): unknown {
    if (!record(payload)) return undefined;
    switch (event) {
      case 'start': {
        if (typeof payload.messageId !== 'string' || !payload.messageId) return undefined;
        this.messageId = payload.messageId;
        return { messageId: payload.messageId };
      }
      case 'delta': return typeof payload.text === 'string' ? { text: payload.text } : undefined;
      case 'done': return record(payload.message) ? { message: projectPublicMessage(payload.message as unknown as Message) } : undefined;
      case 'tool': {
        if (!this.messageId || typeof payload.name !== 'string' || !payload.name) return undefined;
        // The runtime emits input before invocation and an own result property
        // after invocation, including undefined/false/null results. Do not infer
        // success of a task or tool from the result's content.
        const status = Object.hasOwn(payload, 'result') ? 'completed' : record(payload.input) ? 'started' : undefined;
        if (status === undefined) return undefined;
        const progress: PublicToolProgress = { messageId: this.messageId, name: payload.name, status };
        return progress;
      }
      case 'error': return projectPublicError({
        code: typeof payload.code === 'string' ? payload.code : '',
        message: typeof payload.message === 'string' ? payload.message : '',
        ...(typeof payload.status === 'number' ? { status: payload.status } : {}),
      });
      // 03 §6.6: student streams expose neither approval arguments nor usage.
      // HTTP task reads may separately show their bounded, read-only summaries.
      case 'approval': case 'usage': return undefined;
      default: return undefined;
    }
  }
}
