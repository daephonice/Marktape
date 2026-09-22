export function premium(tokenPrice: number, markPrice: number): number | null {
  if (!markPrice) return null;
  return tokenPrice / markPrice - 1;
}

export function formatPremium(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  const pct = p * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function premiumStatus(p: number | null | undefined): "cheap" | "rich" | "flat" {
  if (p === null || p === undefined || Number.isNaN(p)) return "flat";
  if (p > 0) return "rich";
  if (p < 0) return "cheap";
  return "flat";
}
