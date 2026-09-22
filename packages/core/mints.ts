// Never render or swap these mints — competitor pre-IPO tokens (Tessera / xStocks / Backpack / Ondo).
// Voids the PreStocks bounty if integrated. See spec §7.
export const MINT_BLOCKLIST = new Set<string>([
  "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", // xStocks SPACEX
  "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", // Backpack SPCX
  "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ", // Tessera OpenAI
  "wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo", // Ondo
  "TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v", // Tessera SPX
]);

export function isBlockedMint(mint: string): boolean {
  return MINT_BLOCKLIST.has(mint);
}

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
