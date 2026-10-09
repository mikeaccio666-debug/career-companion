import assert from 'node:assert/strict';

interface ExportInventory {
 includedTables:readonly string[];
 remainingTables:readonly string[];
 exclusions:readonly {table:string}[];
 filesIncluded:boolean;
 complete:boolean;
}
/** Independent integration expectation, not calculated from the production registry.
 * Migrations 089/090 added product events and two feedback tables: 147 + 3
 * decoded projections. Real owner records are checked by the domain tests.
 * File capture moves three existing tables out of the remaining partition.
 * A new migration still requires review of the catalog and actual exporter. */
export function assertPartialExportInventory(value:ExportInventory,files=false){
 assert.equal(value.complete,false);
 assert.equal(value.filesIncluded,files);
 assert.equal(value.includedTables.length,files?153:150);
 assert.equal(value.remainingTables.length,files?20:23);
 assert.equal(value.exclusions.length,7);
 const partition=[...value.includedTables,...value.remainingTables,...value.exclusions.map(row=>row.table)];
 assert.equal(partition.length,180);
 assert.equal(new Set(partition).size,180,'Export partitions must be disjoint and duplicate-free.');
 for(const table of ['platform_product_events','platform_product_feedback','platform_product_feedback_operations'])
  assert(value.includedTables.includes(table),table+' must have an implemented projection.');
 for(const table of ['platform_uploads','platform_artifacts','platform_companion_birth_assets']){
  assert.equal(value.includedTables.includes(table),files);
  assert.equal(value.remainingTables.includes(table),!files);
 }
}
