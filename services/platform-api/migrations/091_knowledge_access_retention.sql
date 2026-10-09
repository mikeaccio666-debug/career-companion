-- Bound due-record scans without changing the stored retention deadline or account policy.
CREATE INDEX IF NOT EXISTS org_knowledge_access_expiry ON platform_knowledge_access_log(retention_until,id);
