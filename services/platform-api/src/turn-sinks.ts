import type { FastifyReply, FastifyRequest } from 'fastify';

export interface TurnPreparation { signal: AbortSignal; dispose(): void; }
export interface TurnSinkCallbacks { cancel(): void; heartbeat(): void; }
/** Synchronous output preserves the existing response's event and persistence order. */
export interface TurnSink {
  prepare(): TurnPreparation;
  open(callbacks: TurnSinkCallbacks): void;
  emit(event: string, payload: unknown): void;
  settle(): void;
  close(): void;
}

/** HTTP transport only: authentication, model execution and database writes stay outside. */
export class SseTurnSink implements TurnSink {
  private keepalive?: ReturnType<typeof setInterval>;
  constructor(private readonly request: FastifyRequest, private readonly reply: FastifyReply) {}

  prepare(): TurnPreparation {
    const controller = new AbortController();
    const abort = () => { if (!this.reply.raw.writableFinished) controller.abort(); };
    this.request.raw.once('aborted', abort); this.reply.raw.once('close', abort);
    if (this.request.raw.aborted || this.reply.raw.destroyed) abort();
    return { signal: controller.signal, dispose: () => { this.request.raw.removeListener('aborted', abort); this.reply.raw.removeListener('close', abort); } };
  }

  open(callbacks: TurnSinkCallbacks): void {
    this.reply.header('Cache-Control', 'private, no-store, no-transform');
    this.reply.hijack();
    for (const [name, value] of Object.entries(this.reply.getHeaders())) if (value !== undefined) this.reply.raw.setHeader(name, value);
    this.reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.reply.raw.on('close', callbacks.cancel);
    if (this.request.raw.aborted || this.reply.raw.destroyed) callbacks.cancel();
    this.keepalive = setInterval(() => {
      if (!this.reply.raw.destroyed) this.reply.raw.write(': keepalive\n\n');
      callbacks.heartbeat();
    }, 15_000);
    this.keepalive.unref();
  }

  emit(event: string, payload: unknown): void {
    if (!this.reply.raw.destroyed) this.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  settle(): void { clearInterval(this.keepalive); }
  close(): void { this.reply.raw.end(); }
}

/** In-process consumer for direct service tests; this is not a student or Discord adapter. */
export class CollectingTurnSink implements TurnSink {
  readonly events: { event: string; payload: unknown }[] = [];
  opened = false;
  settled = false;
  closed = false;
  private disconnected = false;
  private preparation?: AbortController;
  private callbacks?: TurnSinkCallbacks;
  private keepalive?: ReturnType<typeof setInterval>;

  prepare(): TurnPreparation {
    const controller = new AbortController(); this.preparation = controller;
    if (this.disconnected) controller.abort();
    return { signal: controller.signal, dispose: () => { if (this.preparation === controller) this.preparation = undefined; } };
  }
  open(callbacks: TurnSinkCallbacks): void {
    this.opened = true; this.callbacks = callbacks;
    if (this.disconnected) callbacks.cancel();
    this.keepalive = setInterval(() => callbacks.heartbeat(), 15_000); this.keepalive.unref();
  }
  emit(event: string, payload: unknown): void {
    if (!this.disconnected) this.events.push({ event, payload: JSON.parse(JSON.stringify(payload)) });
  }
  /** Simulates the legacy transport disconnect; PR1 deliberately still cancels that response. */
  disconnect(): void { this.disconnected = true; this.preparation?.abort(); this.callbacks?.cancel(); }
  settle(): void { this.settled = true; clearInterval(this.keepalive); }
  close(): void { this.closed = true; }
}
