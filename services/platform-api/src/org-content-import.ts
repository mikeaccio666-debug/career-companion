import { careerRecordId, careerRecordObject } from '@companion/platform-contracts';
import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { loadLegalBundle } from './legal-documents.ts';
import { tokenHash } from './auth.ts';
import { createStorage } from './storage.ts';
import { OrgKnowledge } from './org-knowledge.ts';
import { parseOrgOperatorArguments, readOrgOperatorFile } from './org-content-files.ts';
// Explicit operator invocation only. No HTTP staff mutation, migration,
// entitlement seed, job recovery, queue or model request is constructed here.
let db: Database | undefined;
try {
  const args = parseOrgOperatorArguments(process.argv.slice(2)), org = careerRecordId(args.org);
  const credential = careerRecordObject(await readOrgOperatorFile(args.sessionFile, 4096), ['userId', 'token']);
  if (typeof credential.token !== 'string' || credential.token.length < 16 || credential.token.length > 1024 ||
      /[\s\u0000-\u001f\u007f]/.test(credential.token)) throw Error('Invalid session file.');
  const session = Object.freeze({ userId: careerRecordId(credential.userId), tokenHash: tokenHash(credential.token) });
  const input = await readOrgOperatorFile(args.inputFile, 16 * 1024 * 1024), config = readConfig();
  db = new Database(config.databaseUrl, { max: 1, connectionTimeoutMillis: config.databaseConnectTimeoutMs });
  const service = new OrgKnowledge(db, config, await loadLegalBundle(config.legalBundlePath), createStorage(config));
  let result: unknown;
  if (args.action === 'license') result = await service.registerLicense(session, org, input);
  else if (args.action === 'import') result = await service.importBundle(session, org, input);
  else if (args.action === 'publish') result = await service.publishBatch(session, org, args.id!, input);
  else if (args.action === 'withdraw') result = await service.withdrawSource(session, org, args.id!, input);
  else if (args.action === 'revoke-license') result = await service.revokeLicense(session, org, args.id!, input);
  else result = await service.setEntitlement(session, org, input);
  // Receipts include only IDs, counts and versions, never the submitted draft.
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('Content operation failed. Check the private input, current session, organization roles and approved authorization.\n');
  process.exitCode = 1;
} finally { await db?.close(); }
