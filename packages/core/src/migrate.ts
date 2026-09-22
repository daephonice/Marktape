import { getPool } from "./database.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS watches (
  id             SERIAL PRIMARY KEY,
  chat_id        BIGINT NOT NULL,
  symbol         TEXT NOT NULL,
  threshold      NUMERIC NOT NULL DEFAULT 0.10,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_alert_at  TIMESTAMPTZ,
  last_premium   NUMERIC,
  UNIQUE (chat_id, symbol)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          SERIAL PRIMARY KEY,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data        JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_fetched_at ON snapshots (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watches_chat_id ON watches (chat_id);
`;

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const db = getPool();
  await db.query(SCHEMA_SQL);
  migrated = true;
}
