import type { PoolClient } from 'pg';
/** Freeze the exact pre-075 PostgreSQL JSON column order, names and timestamp
 * precision. Whole-row JSON would invalidate saved source receipts on ALTER TABLE.
 * Cache telemetry is separate evidence; it cannot grant execution authority. */
export async function readIntakeModelUsagePrefix(client: PoolClient, submissionId: string, generation: number): Promise<{ value: string }[]> {
  return (await client.query<{ value: string }>(`SELECT row_to_json(proof)::text AS value FROM (
    SELECT call_id,user_id,submission_id,operation_id,draft_id,question_id,submitted_revision,generation,
      auth_version,detector_revision,call_index,provider,model,purpose,status,usage_status,input_tokens,output_tokens,
      created_at,admitted_at,finished_at,source_kind,entry_id,task_id,companion_id,preview_revision,
      expected_identity_revision,name_execution_token,memory_id,memory_execution_token
    FROM platform_safety_model_usage WHERE source_kind='onboarding' AND submission_id=$1 AND generation=$2
    ORDER BY call_id FOR SHARE
  ) proof`, [submissionId, generation])).rows;
}
