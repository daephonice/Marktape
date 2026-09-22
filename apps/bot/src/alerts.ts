import type { Bot } from "grammy";
import { listWatches, updateWatchAlert } from "@marktape/core";
import { getBoard } from "./board";

const CHECK_MS = 60_000;
const DEDUPE_MS = 30 * 60_000;

export function startAlertLoop(bot: Bot, webUrl: string) {
  setInterval(async () => {
    try {
      await checkWatches(bot, webUrl);
    } catch (err) {
      console.error("Alert loop error:", err);
    }
  }, CHECK_MS);
}

async function checkWatches(bot: Bot, webUrl: string) {
  const [board, watches] = await Promise.all([getBoard(), listWatches()]);

  for (const watch of watches) {
    const token = board.tokens.find((t) => t.symbol === watch.symbol);
    if (!token || token.premium === null) continue;

    const crossed = Math.abs(token.premium) >= watch.threshold;
    if (!crossed) continue;

    const signChanged =
      watch.lastPremium !== undefined && Math.sign(watch.lastPremium) !== Math.sign(token.premium);

    const lastAlertMs = watch.lastAlertAt ? Date.now() - new Date(watch.lastAlertAt).getTime() : Infinity;
    const dedupeOk = lastAlertMs >= DEDUPE_MS || signChanged;
    if (!dedupeOk) continue;

    const pct = (token.premium * 100).toFixed(1);
    const msg = [
      `${token.symbol} crossed ±${(watch.threshold * 100).toFixed(0)}% premium.`,
      `Now: ${pct}% ($${token.tokenPrice.toFixed(2)} vs $${token.markPrice.toFixed(2)} mark)`,
      `${webUrl}/t/${token.symbol}`,
    ].join("\n");

    try {
      await bot.api.sendMessage(watch.chatId, msg);
      await updateWatchAlert(watch.chatId, watch.symbol, token.premium);
    } catch (err) {
      console.error(`Failed to alert chat ${watch.chatId}:`, err);
    }
  }
}
