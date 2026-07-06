-- current active profile per tool (cloud analogue of Store.current).
CREATE TABLE IF NOT EXISTS current_selections (
  tool       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
