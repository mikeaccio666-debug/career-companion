ALTER TABLE platform_request_limits DROP CONSTRAINT platform_request_limits_scope_check;
ALTER TABLE platform_request_limits DROP CONSTRAINT platform_request_limits_check;
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_scope_check
  CHECK(scope IN ('api','chat','speech','transcription','realtime','control','auth-login','auth-register','auth-email-request','auth-email-consume','public'));
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_check
  CHECK ((subject_type='user' AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND scope IN ('api','chat','speech','transcription','realtime','control'))
    OR (subject_type='ip' AND subject_key ~ '^[0-9a-f]{64}$'
      AND scope IN ('auth-login','auth-register','auth-email-request','auth-email-consume','public')));
