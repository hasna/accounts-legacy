-- Bind every completed login operation to the exact target account
-- incarnation it activated. A retry may return the cached result only while
-- both its payload and the current account still identify that incarnation.
-- Existing rows remain NULL and therefore fail closed: their original target
-- incarnation cannot be reconstructed safely after a remove/recreate race.
ALTER TABLE current_login_operations
  ADD COLUMN IF NOT EXISTS target_incarnation_id UUID;
