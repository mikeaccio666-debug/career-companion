/** The worker distributes this secret through private runtime channels only.
 * Never put it in iframe src/name or the frame -> parent ready message.
 */
export function acceptsLayoutConnection(event: MessageEvent, parent: Window,
  context: { readonly nonce: string; readonly origin: string } | null): boolean {
  const value = event.data;
  return context !== null && event.source === parent && event.origin === context.origin && event.ports.length === 1 &&
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
    value.type === 'argo-lab-connect' && value.nonce === context.nonce;
}
