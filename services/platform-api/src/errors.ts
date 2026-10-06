export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly publicMessage: string) { super(publicMessage); }
}
export function notFound() { return new ApiError(404, 'NOT_FOUND', 'Item not found.'); }
export function invalid(message: string) { return new ApiError(400, 'INVALID_INPUT', message); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('A JSON object is required.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, max = 20_000, required = true): string {
  if (!required && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${label} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw notFound();
  return value;
}
export function attachments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw invalid('At most 10 attachments are allowed.');
  return value.map(identifier);
}
