-- Stable account incarnation used by failed-login field rollback. A profile
-- removed and recreated under the same (tool, name) receives a different UUID,
-- so compare-and-restore cannot mutate the replacement even when timestamps
-- and client-local directory values collide.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS incarnation_id UUID;

ALTER TABLE accounts
  ALTER COLUMN incarnation_id SET DEFAULT pg_catalog.gen_random_uuid();

UPDATE accounts
   SET incarnation_id = pg_catalog.gen_random_uuid()
 WHERE incarnation_id IS NULL;

ALTER TABLE accounts
  ALTER COLUMN incarnation_id SET NOT NULL;

-- Transactional activation also records the exact displaced account. If that
-- account is removed and recreated under the same name, rollback must clear
-- its own selection instead of activating the replacement incarnation.
ALTER TABLE current_login_operations
  ADD COLUMN IF NOT EXISTS previous_incarnation_id UUID;
