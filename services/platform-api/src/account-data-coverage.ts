import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import { ACCOUNT_DATA_SCHEMA } from './account-data-schema.ts';

export interface AccountSchemaColumn { table_name: string; column_name: string; data_type: string; }
export interface AccountSchemaForeignKey { child: string; parent: string; definition: string; }
export interface AccountSchemaInventory { columns: AccountSchemaColumn[]; fks: AccountSchemaForeignKey[]; }
export type AccountDataPolicy = 'owner_projection' | 'indirect_owner_projection' | 'credential_projection'
  | 'file_projection' | 'organization_review' | 'financial_review' | 'nonpersonal';

export const ACCOUNT_DATA_POLICY_REASONS: Readonly<Record<AccountDataPolicy, string>> = Object.freeze({
  owner_projection: 'Export only the authenticated owner’s decoded domain data and receipts; never raw ciphertext or another actor’s private fields.',
  indirect_owner_projection: 'Resolve ownership through the reviewed parent relation; absence of user_id does not exempt these records.',
  credential_projection: 'Export reviewed account/action metadata only; exclude passwords, session/proof/code hashes, delivery tokens and execution secrets, including encrypted copies.',
  file_projection: 'Export the owner’s confirmed private files and reviewed metadata; storage coordinates, cleanup leases and unpublished writes require separate handling.',
  organization_review: 'Shared organization or staff data needs an explicit projection policy; never copy licensed corpora, other users, or staff authority into a student archive.',
  financial_review: 'Retained financial records have no user_id but may remain linkable through payment references; resolve coverage and retention explicitly before release.',
  nonpersonal: 'Reviewed table contains shared schema/runtime/price configuration or aggregate counters, without account records; excluded from individual account exports.',
});

/** Reads catalog metadata only. No user rows, migrations, credentials or files. */
export async function readAccountSchemaInventory(client: Pick<Database, 'query'>): Promise<AccountSchemaInventory> {
  const columns = (await client.query(`SELECT table_name,column_name,data_type
    FROM information_schema.columns WHERE table_schema=current_schema()
    ORDER BY table_name,ordinal_position`)).rows;
  const fks = (await client.query(`SELECT c.relname AS child,p.relname AS parent,
    pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class p ON p.oid=k.confrelid
    WHERE k.contype='f' AND n.nspname=current_schema() ORDER BY c.relname,k.conname`)).rows;
  return { columns, fks };
}

export function accountTableFingerprint(inventory: AccountSchemaInventory, table: string): string {
  // Order is normalized, but duplicate/missing columns or foreign keys still change the hash.
  const columns = inventory.columns.filter(c => c.table_name === table).map(c => [c.column_name,c.data_type])
    .sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const foreignKeys = inventory.fks.filter(f => f.child === table).map(f => [f.parent,f.definition])
    .sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({columns,foreignKeys})).digest('hex');
}

/** Coverage inventory, NOT an export authorization or evidence of completed readers.
 * Every personal category stays blocked until actual projection/file readers and
 * archive verification exist. New tables/columns/FKs cannot silently inherit a policy.
 */
export function auditAccountDataCoverage(inventory: AccountSchemaInventory) {
  const actual = new Set(inventory.columns.map(c => c.table_name));
  const reviewed = new Map(ACCOUNT_DATA_SCHEMA.map(entry => [entry.table,entry]));
  const tables = [...new Set([...actual,...reviewed.keys()])].sort().map(table => {
    const entry = reviewed.get(table);
    const schemaStatus = !entry ? 'unreviewed' : !actual.has(table) ? 'missing'
      : accountTableFingerprint(inventory,table) !== entry.fingerprint ? 'changed' : 'reviewed';
    const policy = entry?.policy ?? null;
    const exportStatus = schemaStatus !== 'reviewed' ? 'blocked_schema_review'
      : policy === 'nonpersonal' ? 'excluded_nonpersonal' : 'blocked_projection_required';
    return Object.freeze({ table, schemaStatus, policy, exportStatus,
      reason: policy ? ACCOUNT_DATA_POLICY_REASONS[policy] : 'No reviewed account-data policy exists for this table.' });
  });
  const schemaReady = tables.every(table => table.schemaStatus === 'reviewed');
  return Object.freeze({ scope: 'account_export_coverage_inventory' as const,
    schemaStatus: schemaReady ? 'reviewed' as const : 'blocked' as const,
    exportStatus: 'not_implemented' as const, exportReady: false as const,
    tableCount: tables.length,
    excludedTables: tables.filter(table => table.exportStatus === 'excluded_nonpersonal').length,
    requiredProjections: tables.filter(table => table.exportStatus === 'blocked_projection_required').length,
    tables: Object.freeze(tables) });
}
