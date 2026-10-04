ALTER TABLE system_settings ADD COLUMN committee_creation_defaults jsonb NOT NULL DEFAULT
  '{"defaultRulePackageVersionId":null,"showMotionsOnDemand":true,"groupMotionTypes":true,"moveQueueUp":false,"timersInSeparateColumns":false,"generalSpeechMs":120000,"crisisAutoStartDelayMinutes":5}'::jsonb;

-- Existing committees retain their rule-based initial duration. New committees
-- copy the administrator's duration before their first meeting is started.
ALTER TABLE committees ADD COLUMN initial_general_speech_ms bigint
  CHECK (initial_general_speech_ms >= 1000 AND initial_general_speech_ms <= 9007199254740991);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=85 WHERE singleton=true;
