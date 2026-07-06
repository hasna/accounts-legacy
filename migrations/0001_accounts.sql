-- accounts registry: one row per (tool, profile name).
-- Mirrors the local Profile shape (src/types.ts) but persisted in cloud Postgres
-- per Amendment A1 (PURE REMOTE): the accounts-serve API reads and writes here
-- directly. `dir` is a client-local config directory and is optional in cloud.
CREATE TABLE IF NOT EXISTS accounts (
  tool         TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT,
  display_name TEXT,
  identity     TEXT,
  card_last4   TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  dir          TEXT,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (tool, name)
);

CREATE INDEX IF NOT EXISTS accounts_tool_idx ON accounts (tool);
CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts (email);
