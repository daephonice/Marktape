import { Connection } from "@solana/web3.js";
import { fetchPreStocks } from "./prestocks.js";
import { getMintMultiplier } from "./multiplier.js";
import { premium } from "./premium.js";
import type { Snapshot, TokenRow } from "./types.js";

export async function buildSnapshot(rpcUrl: string): Promise<Snapshot> {
  const records = await fetchPreStocks();
  const connection = new Connection(rpcUrl, "confirmed");

  const tokens: TokenRow[] = await Promise.all(
    records.map(async (r) => {
      let multiplier = 1;
      try {
        const m = await getMintMultiplier(connection, r.contract_address);
        multiplier = m.multiplier;
      } catch {
        // default multiplier 1 on RPC failure; do not block the board
      }

      return {
        symbol: r.symbol,
        name: r.name,
        description: r.description,
        image: r.image,
        externalUrl: r.external_url,
        mint: r.contract_address,
        tokenPrice: r.tokenPrice,
        markPrice: r.markPrice,
        premium: premium(r.tokenPrice, r.markPrice),
        impliedValuation: r.impliedValuation,
        markValuation: r.markValuation,
        supply: r.supply,
        multiplier,
      };
    })
  );

  tokens.sort((a, b) => Math.abs(b.premium ?? 0) - Math.abs(a.premium ?? 0));

  return { fetchedAt: new Date().toISOString(), tokens };
}
