import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
/** Operator files contain credentials or licensed drafts; reject symlinks,
 * shared permissions, foreign ownership and oversized/non-regular inputs. */
export async function readOrgOperatorFile(path: string, maximumBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid?.() ||
        st.size < 1 || st.size > maximumBytes) throw Error('Invalid private operator file.');
    const bytes = Buffer.alloc(Number(st.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const part = await file.read(bytes, count, bytes.length - count, null);
      if (!part.bytesRead) break; count += part.bytesRead;
    }
    const after = await file.stat();
    if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw Error('Operator file changed.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { await file.close(); }
}
export function parseOrgOperatorArguments(args: readonly string[]) {
  const [action, ...flags] = args;
  if (!['license', 'import', 'publish', 'withdraw', 'entitlement', 'revoke-license'].includes(action)) throw Error('Unsupported content command.');
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i], value = flags[i + 1];
    if (!['--org', '--session-file', '--input-file', '--id'].includes(key) || values.has(key) ||
        !value || value.startsWith('--')) throw Error('Invalid command arguments.');
    values.set(key, value);
  }
  if (!values.has('--org') || !values.has('--session-file') || !values.has('--input-file') ||
      ['publish', 'withdraw', 'revoke-license'].includes(action) !== values.has('--id')) throw Error('Missing command arguments.');
  return Object.freeze({ action, org: values.get('--org')!, sessionFile: values.get('--session-file')!,
    inputFile: values.get('--input-file')!, id: values.get('--id') });
}
