// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
const {postMessage}=vi.hoisted(()=>({postMessage:vi.fn()}));
vi.mock('wxt/browser',()=>({browser:{runtime:{connect:()=>({postMessage,onMessage:{addListener:vi.fn()},onDisconnect:{addListener:vi.fn()},disconnect:vi.fn()})}}}));
it('acknowledges an explicit cancel without showing failure guidance',async()=>{
 document.body.innerHTML='<h1></h1><p id="hint"></p><p id="status"></p><button id="stop"></button><button id="cancel"></button>';
 await import('../entrypoints/intake-recorder/main');
 document.getElementById('cancel')!.click();
 expect(postMessage).toHaveBeenLastCalledWith({kind:'ERROR',code:'CANCELLED'});
 expect(document.getElementById('status')!.textContent).toBe('Recording cancelled. You can close this page.');
});
