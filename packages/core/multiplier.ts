import { Connection, PublicKey } from "@solana/web3.js";

type MultiplierResult = {
  multiplier: number;
  decimals: number;
};

const cache = new Map<string, { value: MultiplierResult; expiresAt: number }>();
const CACHE_MS = 10 * 60 * 1000; // 10 min

export async function getMintMultiplier(
  connection: Connection,
  mint: string
): Promise<MultiplierResult> {
  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = await fetchMultiplier(connection, mint);
  cache.set(mint, { value: result, expiresAt: Date.now() + CACHE_MS });
  return result;
}

async function fetchMultiplier(connection: Connection, mint: string): Promise<MultiplierResult> {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info.value?.data as any)?.parsed;
    const decimals: number = parsed?.info?.decimals ?? 6;
    const extensions: any[] = parsed?.info?.extensions ?? [];
    const scaledUi = extensions.find((e) => e.extension === "scaledUiAmountConfig");

    if (!scaledUi) return { multiplier: 1, decimals };

    const state = scaledUi.state ?? {};
    const now = Date.now() / 1000;
    const effectiveTs = Number(state.newMultiplierEffectiveTimestamp ?? 0);
    const multiplier =
      now >= effectiveTs ? Number(state.newMultiplier ?? 1) : Number(state.multiplier ?? 1);

    return { multiplier: multiplier || 1, decimals };
  } catch {
    return { multiplier: 1, decimals: 6 };
  }
}

export function toRawAmount(uiAmount: number, decimals: number, multiplier = 1): string {
  const raw = (uiAmount * 10 ** decimals) / multiplier;
  return Math.floor(raw).toString();
}

export function toUiAmount(rawAmount: number | string, decimals: number, multiplier = 1): number {
  const raw = typeof rawAmount === "string" ? Number(rawAmount) : rawAmount;
  return (raw / 10 ** decimals) * multiplier;
}
