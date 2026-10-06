import type { HttpFailure } from './diagnosticsUploader';

/** 与服务端 requestId 同一个模式。 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * 一次失败的 HTTP 答复里可以上报的那两样（2026-10-04，体检 11-3）：状态码，与服务端回的 `x-request-id`——拿它在 Loki 里
 * 对得上那一次请求的服务端日志。只在 worker 里取；不像请求号的不带，答复体一个字都不读。
 */
export function httpFailureOf(response: Readonly<{ status: number; headers?: Readonly<{ get(name: string): string | null }> }>): HttpFailure {
  let requestId: string | null = null;
  try {
    requestId = response.headers?.get('x-request-id') ?? null;
  } catch {
    requestId = null;
  }
  return {
    ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {}),
    ...(requestId !== null && REQUEST_ID.test(requestId) ? { requestId } : {}),
  };
}

/** 资料目录传输层交回的失败（`status`、`requestId`，profileDirectoryTransport.ts）→ 可以上报的那两样；没有状态码就是 undefined。 */
export function directoryHttpFailure(answer: Readonly<{ status?: number; requestId?: string }> | null | undefined): HttpFailure | undefined {
  if (answer === null || answer === undefined || typeof answer.status !== 'number') return undefined;
  return {
    httpStatus: answer.status,
    ...(typeof answer.requestId === 'string' && REQUEST_ID.test(answer.requestId) ? { requestId: answer.requestId } : {}),
  };
}
