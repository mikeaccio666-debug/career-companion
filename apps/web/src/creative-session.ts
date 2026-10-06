export interface CreativeOperationToken { accountId: string; generation: number; }

// Discard late upload/reference results after leaving the panel or changing accounts.
export class CreativeOperationScope {
  private accountId: string;
  private generation = 0;
  private live = false;
  private pending = false;
  constructor(accountId: string) { this.accountId = accountId; }
  get busy() { return this.pending; }
  setAccount(accountId: string) {
    if (accountId !== this.accountId) { this.accountId = accountId; ++this.generation; this.pending = false; }
  }
  mount(accountId: string) { this.setAccount(accountId); this.live = true; this.pending = false; ++this.generation; }
  dispose() { this.live = false; this.pending = false; ++this.generation; }
  begin(): CreativeOperationToken | undefined {
    if (!this.live || this.pending) return;
    this.pending = true; return { accountId: this.accountId, generation: this.generation };
  }
  isCurrent(token: CreativeOperationToken) { return this.live && token.accountId === this.accountId && token.generation === this.generation; }
  finish(token: CreativeOperationToken) { if (this.isCurrent(token)) { this.pending = false; return true; } return false; }
}
