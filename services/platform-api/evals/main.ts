import { buildEvalPreflight } from './preflight.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** No runtime, environment loader, network client, database or live flag here. */
export function evalCommand(args: readonly string[]) {
  if (args.length && !(args.length === 1 && args[0] === '--dry-run')) {
    return { exitCode: 2, result: { status: 'rejected', code: 'EVAL_DRY_RUN_ONLY' } };
  }
  return { exitCode: 0, result: buildEvalPreflight() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outcome = evalCommand(process.argv.slice(2));
  process.stdout.write(JSON.stringify(outcome.result, null, 2) + '\n');
  process.exitCode = outcome.exitCode;
}
