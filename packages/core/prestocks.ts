import type { PreStocksApiRecord } from "./types.js";
import { isBlockedMint } from "./mints.js";

const DEFAULT_URL = "https://prestocks.com/api/prestocks";

export async function fetchPreStocks(
  apiUrl: string = process.env.PRESTOCKS_API_URL || DEFAULT_URL
): Promise<PreStocksApiRecord[]> {
  const res = await fetch(apiUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`PreStocks API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("PreStocks API did not return an array");

  return data.filter((r): r is PreStocksApiRecord => {
    if (!r || typeof r !== "object") return false;
    if (typeof r.contract_address !== "string" || !r.contract_address) return false;
    if (typeof r.symbol !== "string" || !r.symbol) return false;
    if (typeof r.tokenPrice !== "number" || Number.isNaN(r.tokenPrice)) return false;
    if (typeof r.markPrice !== "number" || Number.isNaN(r.markPrice)) return false;
    if (isBlockedMint(r.contract_address)) return false;
    return true;
  });
}

// Optional stats endpoint — best-effort, may 404. Caller should not block the board on failure.
export async function fetchPreStocksStats(
  apiUrl?: string
): Promise<Record<string, { volume24h?: number; holders?: number }> | null> {
  const base = apiUrl || process.env.PRESTOCKS_API_URL || DEFAULT_URL;
  const statsUrl = base.replace(/\/prestocks\/?$/, "/stats");
  try {
    const res = await fetch(statsUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
