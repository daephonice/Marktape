import type { TokenRow } from "@marktape/core";
import { formatPremium } from "@marktape/core";

export function formatBoardLine(t: TokenRow): string {
  return `${t.symbol.padEnd(10)} ${formatPremium(t.premium).padStart(7)}   $${t.tokenPrice.toFixed(2)} vs $${t.markPrice.toFixed(2)}`;
}

export function formatCard(t: TokenRow, webUrl: string): string {
  const lines = [
    `*${t.symbol}* — ${t.name}`,
    ``,
    `Premium: ${formatPremium(t.premium)}`,
    `Token: $${t.tokenPrice.toFixed(2)}   Mark: $${t.markPrice.toFixed(2)}`,
    ``,
    `${webUrl}/t/${t.symbol}`,
    `Trade on Marktape: ${webUrl}/t/${t.symbol}#swap`,
  ];
  return lines.join("\n");
}
