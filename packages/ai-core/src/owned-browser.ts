import type { BrowserServer } from 'playwright';
import { ProviderError } from './errors.ts';

const GRACEFUL_CLOSE_MS = 1000;
function unconfirmed() { return new ProviderError('BROWSER_CLEANUP_UNCONFIRMED', 'The isolated browser process could not be confirmed closed.', 503); }

/** Own only the BrowserServer returned by this task's launchServer call. */
export function ownBrowserServer(server: Pick<BrowserServer, 'process' | 'close' | 'kill'>) {
  const process = server.process();
  let completion: Promise<void> | undefined, killed: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let escalate!: () => void;
  const escalation = new Promise<void>(resolve => {
    escalate = () => {
      killed ??= (async () => {
        try {
          // The public API kills this owned browser and awaits its physical exit.
          await server.kill();
          if (process.exitCode === null && process.signalCode === null) throw unconfirmed();
        } catch { throw unconfirmed(); }
      })();
      resolve(killed);
    };
  });
  return {
    close(force = false): Promise<void> {
      if (force) escalate();
      if (!completion) {
        if (force) completion = escalation;
        else {
          timer = setTimeout(escalate, GRACEFUL_CLOSE_MS);
          const graceful = (async () => {
            try {
              await server.close();
              if (process.exitCode === null && process.signalCode === null) throw unconfirmed();
            } catch { escalate(); await escalation; }
          })();
          completion = Promise.race([graceful, escalation]);
        }
        completion = completion.finally(() => { if (timer) clearTimeout(timer); });
      }
      return completion;
    },
  };
}
