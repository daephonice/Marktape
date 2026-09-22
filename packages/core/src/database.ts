import { Pool } from "pg";
import type { Watch, Snapshot } from "./types.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("railway") ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  return pool;
}

// --- Watches -----------------------------------------------------------

export async function addWatch(chatId: number, symbol: string, threshold = 0.1): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO watches (chat_id, symbol, threshold, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (chat_id, symbol) DO UPDATE SET threshold = EXCLUDED.threshold`,
    [chatId, symbol.toUpperCase(), threshold]
  );
}

export async function removeWatch(chatId: number, symbol: string): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM watches WHERE chat_id = $1 AND symbol = $2`, [
    chatId,
    symbol.toUpperCase(),
  ]);
}

export async function listWatches(chatId?: number): Promise<Watch[]> {
  const db = getPool();
  const res = chatId
    ? await db.query(`SELECT * FROM watches WHERE chat_id = $1 ORDER BY symbol`, [chatId])
    : await db.query(`SELECT * FROM watches ORDER BY chat_id, symbol`);
  return res.rows.map(rowToWatch);
}

export async function updateWatchAlert(
  chatId: number,
  symbol: string,
  premium: number
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE watches SET last_alert_at = NOW(), last_premium = $3
     WHERE chat_id = $1 AND symbol = $2`,
    [chatId, symbol.toUpperCase(), premium]
  );
}

function rowToWatch(r: any): Watch {
  return {
    chatId: Number(r.chat_id),
    symbol: r.symbol,
    threshold: Number(r.threshold),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    lastAlertAt: r.last_alert_at
      ? r.last_alert_at instanceof Date
        ? r.last_alert_at.toISOString()
        : r.last_alert_at
      : undefined,
    lastPremium: r.last_premium !== null ? Number(r.last_premium) : undefined,
  };
}

// --- Snapshots (last-good board cache + sparkline history) -------------

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO snapshots (fetched_at, data) VALUES ($1, $2)`,
    [snapshot.fetchedAt, JSON.stringify(snapshot.tokens)]
  );
  // keep table small: drop anything older than 72h
  await db.query(`DELETE FROM snapshots WHERE fetched_at < NOW() - INTERVAL '72 hours'`);
}

export async function getLastSnapshot(): Promise<Snapshot | null> {
  const db = getPool();
  const res = await db.query(
    `SELECT fetched_at, data FROM snapshots ORDER BY fetched_at DESC LIMIT 1`
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    fetchedAt: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at,
    tokens: row.data,
  };
}

export async function getSparkline(symbol: string, hours = 24): Promise<{ t: string; price: number }[]> {
  const db = getPool();
  const res = await db.query(
    `SELECT fetched_at, data FROM snapshots
     WHERE fetched_at > NOW() - ($1 || ' hours')::interval
     ORDER BY fetched_at ASC`,
    [hours]
  );
  const points: { t: string; price: number }[] = [];
  for (const row of res.rows) {
    const tokens = row.data as any[];
    const match = tokens.find((t) => t.symbol === symbol);
    if (match) {
      points.push({
        t: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at,
        price: match.tokenPrice,
      });
    }
  }
  return points;
}
