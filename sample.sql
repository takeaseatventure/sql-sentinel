-- Realistic messy dashboard query
SELECT DISTINCT *
FROM user_events, raw_logs
WHERE LOWER(event_name) LIKE '%signup%'
  AND user_id NOT IN (SELECT id FROM deleted_users)
ORDER BY created_at;
