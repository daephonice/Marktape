import { Bot } from "grammy";
import { addWatch, removeWatch, listWatches, ensureSchema } from "@marktape/core";
import { getBoard } from "./board";
import { formatBoardLine, formatCard } from "./format";
import { startAlertLoop } from "./alerts";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const webUrl = process.env.WEB_PUBLIC_URL || "";
const bot = new Bot(token);

await ensureSchema();

bot.command("start", async (ctx) => {
  const payload = ctx.match?.trim().toUpperCase();
  if (payload) {
    try {
      const board = await getBoard();
      const t = board.tokens.find((x) => x.symbol === payload);
      if (t) return ctx.reply(formatCard(t, webUrl), { parse_mode: "Markdown" });
    } catch {
      // fall through to pitch
    }
  }
  await ctx.reply(
    [
      "Marktape: mark vs tape for PreStocks.",
      "The onchain price and the issuer mark disagree — we show the gap and let you swap in-page.",
      `Live board: ${webUrl}`,
    ].join("\n")
  );
});

bot.command("board", async (ctx) => {
  try {
    const board = await getBoard();
    const lines = board.tokens.map(formatBoardLine);
    await ctx.reply("```\n" + lines.join("\n") + "\n```", { parse_mode: "Markdown" });
  } catch {
    await ctx.reply("Board is unavailable right now. Try again shortly.");
  }
});

async function replyCard(ctx: any, symbolRaw: string) {
  const symbol = symbolRaw.toUpperCase();
  try {
    const board = await getBoard();
    const t = board.tokens.find((x) => x.symbol === symbol);
    if (!t) return ctx.reply(`Unknown symbol: ${symbol}`);
    await ctx.reply(formatCard(t, webUrl), { parse_mode: "Markdown" });
  } catch {
    await ctx.reply("Board is unavailable right now. Try again shortly.");
  }
}

bot.command("t", async (ctx) => {
  const symbol = ctx.match?.trim();
  if (!symbol) return ctx.reply("Usage: /t SPACEX");
  await replyCard(ctx, symbol);
});

// /spacex style shortcuts — matches any single lowercase word command
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text;
  const match = text.match(/^\/([a-zA-Z]+)$/);
  if (match) return replyCard(ctx, match[1]);
  return next();
});

bot.command("watch", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) ?? [];
  const symbol = parts[0];
  const threshold = parts[1] ? Number(parts[1]) : 0.1;
  if (!symbol) return ctx.reply("Usage: /watch SPACEX [threshold e.g. 0.1]");

  await addWatch(ctx.chat.id, symbol.toUpperCase(), threshold);
  await ctx.reply(`Watching ${symbol.toUpperCase()} — alert at ±${(threshold * 100).toFixed(0)}% premium.`);
});

bot.command("unwatch", async (ctx) => {
  const symbol = ctx.match?.trim();
  if (!symbol) return ctx.reply("Usage: /unwatch SPACEX");
  await removeWatch(ctx.chat.id, symbol.toUpperCase());
  await ctx.reply(`Unwatched ${symbol.toUpperCase()}.`);
});

bot.command("watches", async (ctx) => {
  const watches = await listWatches(ctx.chat.id);
  if (watches.length === 0) return ctx.reply("No watches yet. Try /watch SPACEX");
  const lines = watches.map((w) => `${w.symbol} — ±${(w.threshold * 100).toFixed(0)}%`);
  await ctx.reply(lines.join("\n"));
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

startAlertLoop(bot, webUrl);

bot.start();
console.log("Marktape bot running (long polling).");
