import type { GoalPlanReviewRequest } from './goal-plan-workspace.ts';

interface ReviewPort {
  isCurrent(): boolean;
  open(planId: string): Promise<boolean>;
  pendingReviewId(): string | null;
  handled(serial: number): void;
}

/** Mount lifetime is separate from busy renders: an aborted StrictMode mount never consumes a review. */
export class GoalPlanReviewCoordinator {
  private port: ReviewPort;
  private mounted = false;
  private lifetime = 0;
  private ticket: { lifetime: number; serial: number } | null = null;
  constructor(port: ReviewPort) { this.port = port; }
  start() { this.stop(); this.mounted = true; }
  stop() { this.mounted = false; ++this.lifetime; this.ticket = null; }
  drive(request: GoalPlanReviewRequest | undefined, busy: boolean) {
    if (!this.mounted || !this.port.isCurrent() || !request || busy || this.ticket?.serial === request.serial) return;
    const ticket = { lifetime: this.lifetime, serial: request.serial }; this.ticket = ticket;
    void this.port.open(request.planId).then((opened) => {
      if (!this.mounted || !this.port.isCurrent() || ticket.lifetime !== this.lifetime || this.ticket !== ticket) return;
      // A failed/offline read stays an explicit retry in the panel. A late, aborted read consumes nothing.
      if (opened || this.port.pendingReviewId() === request.planId) this.port.handled(request.serial);
    });
  }
}
