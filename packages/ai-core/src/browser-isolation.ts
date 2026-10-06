/** Static reviewed renderer code: never interpolates a task prompt, selector or other user input. */
export const BROWSER_ISOLATION_SCRIPT = `(() => {
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport'])
    Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
  Object.defineProperty(Document.prototype, 'cookie', { get() { return ''; }, set() {}, configurable: false });
  const Button = HTMLButtonElement, Input = HTMLInputElement, attribute = Element.prototype.getAttribute;
  const path = Event.prototype.composedPath, prevent = Event.prototype.preventDefault, stop = Event.prototype.stopImmediatePropagation;
  const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get;
  let blocked = 0;
  Object.defineProperty(globalThis, '__companionBlockedSubmissions', { get() { return blocked; }, configurable: false });
  for (const key of ['submit', 'requestSubmit']) Object.defineProperty(HTMLFormElement.prototype, key, { value() { blocked++; }, writable: false, configurable: false });
  globalThis.addEventListener('submit', event => { blocked++; prevent.call(event); stop.call(event); }, true);
  globalThis.addEventListener('click', event => {
    const control = path.call(event).find(node => node instanceof Button || node instanceof Input);
    if (control && (control instanceof Button && attribute.call(control, 'type')?.toLowerCase() !== 'button' || control instanceof Input && ['submit', 'image'].includes(inputType.call(control)))) {
      blocked++; prevent.call(event); stop.call(event);
    }
  }, true);
  Object.defineProperty(globalThis, '__companionBrowserGuardReady', { value: true, writable: false, configurable: false });
})();`;
