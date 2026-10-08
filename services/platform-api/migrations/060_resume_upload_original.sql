-- Existing owner paste/derived rows remain unchanged; upload is an actual
-- captured file source, not a client-assigned model or expert provenance.
ALTER TABLE platform_career_resume_versions DROP CONSTRAINT IF EXISTS platform_career_resume_versions_source_check;
ALTER TABLE platform_career_resume_versions ADD CONSTRAINT platform_career_resume_versions_source_check CHECK(source IN ('paste','derived','upload'));
ALTER TABLE platform_career_resume_versions DROP CONSTRAINT IF EXISTS platform_career_resume_versions_upload_id_check;
ALTER TABLE platform_career_resume_versions ADD CONSTRAINT platform_career_resume_versions_upload_id_check CHECK((source='upload')=(upload_id IS NOT NULL));
