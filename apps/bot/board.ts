import type { Snapshot } from "@marktape/core";

let cache: { snapshot: Snapshot; expiresAt: number } | null = null;
const TTL_MS = 30_000;

export async function getBoard(): Promise<Snapshot> {
  if (cache && cache.expiresAt > Date.now()) return cache.snapshot;

  const webUrl = process.env.WEB_PUBLIC_URL;
  if (!webUrl) throw new Error("WEB_PUBLIC_URL is not set");

  const res = await fetch(`${webUrl}/api/board`);
  if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
  const snapshot = (await res.json()) as Snapshot;
  cache = { snapshot, expiresAt: Date.now() + TTL_MS };
  return snapshot;
}
