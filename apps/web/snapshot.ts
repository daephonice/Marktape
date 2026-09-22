import { buildSnapshot, getLastSnapshot, saveSnapshot, ensureSchema } from "@marktape/core";
import type { Snapshot } from "@marktape/core";

let memCache: { snapshot: Snapshot; expiresAt: number } | null = null;
const TTL_MS = 30_000;

export async function getSnapshot(): Promise<{ snapshot: Snapshot; stale: boolean }> {
  if (memCache && memCache.expiresAt > Date.now()) {
    return { snapshot: memCache.snapshot, stale: false };
  }

  try {
    await ensureSchema().catch(() => {
      // DB not reachable yet — board still works, watches/snapshot persistence will retry later
    });
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const snapshot = await buildSnapshot(rpcUrl);
    memCache = { snapshot, expiresAt: Date.now() + TTL_MS };
    saveSnapshot(snapshot).catch(() => {
      // DB not configured yet or transient error — board still works from mem cache
    });
    return { snapshot, stale: false };
  } catch (err) {
    const last = await getLastSnapshot().catch(() => null);
    if (last) return { snapshot: last, stale: true };
    throw err;
  }
}
