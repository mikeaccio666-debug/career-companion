export { readOrgOperatorFile as readMentorOperatorFile } from './org-content-files.ts';
export function parseMentorOperatorArguments(args: readonly string[]) {
  const [action,...flags] = args;
  if (!['set','withdraw','list'].includes(action)) throw Error('Unsupported service command.');
  const values = new Map<string,string>();
  for (let i=0;i<flags.length;i+=2) {
    const key=flags[i], value=flags[i+1];
    if (!['--org','--session-file','--input-file'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw Error('Invalid arguments.');
    values.set(key,value);
  }
  if (!values.has('--org') || !values.has('--session-file') || (action !== 'list') !== values.has('--input-file')) throw Error('Missing arguments.');
  return Object.freeze({action,org:values.get('--org')!,sessionFile:values.get('--session-file')!,inputFile:values.get('--input-file')});
}
