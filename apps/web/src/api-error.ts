export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  constructor(message: string, status = 0, code?: string, retryAfterMs?: number) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; }
}
