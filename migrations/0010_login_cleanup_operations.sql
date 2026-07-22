-- Persist conditional login-created profile cleanup results so response-loss
-- retries return the original result without treating an already-completed
-- delete as a concurrent replacement.
CREATE TABLE IF NOT EXISTS account_login_cleanup_operations (
  operation_id UUID PRIMARY KEY,
  tool TEXT NOT NULL,
  name TEXT NOT NULL,
  target_incarnation_id UUID NOT NULL,
  removed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
