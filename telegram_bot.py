"""Marktape Telegram bot — optional second door onto the same board data.
Runs as a background asyncio task inside the FastAPI process (started from
main.py's startup event, same pattern as Daephon Casino's telegram_bot).

Commands (spec §2.2):
  /start [SYMBOL]   3-line pitch + site link. With a payload, show that card.
  /board            Compact list of every symbol: SYMBOL  premium%  tape vs mark
  /t SYMBOL | /symbol   Full card + site link + Jupiter link
  /watch SYMBOL     Persist chat_id+symbol, default threshold ±10%
  /unwatch SYMBOL   Remove
  /watches          List this chat's watches

Alert loop (every 60s): for each watch, if abs(premium) crosses the
threshold (or crosses back), send one message. Dedupe: max one alert per
symbol per chat per 30 min unless premium flips sign.

Bot never touches wallets or signs anything — swap only happens on the site.
"""
import os
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import Message
from aiogram.client.default import DefaultBotProperties

from sqlalchemy import select

import prestocks
from database import SessionLocal
from models import Watch

log = logging.getLogger("telegram_bot")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
WEB_PUBLIC_URL = os.getenv("WEB_PUBLIC_URL", "").rstrip("/")
JUPITER_DEEP_BASE = "https://jup.ag/swap"

router = Router()

DEFAULT_THRESHOLD = 0.10
ALERT_DEDUPE_MINUTES = 30


def _row_for(symbol: str) -> dict | None:
    snap = prestocks.get_cached_snapshot()
    symbol_u = symbol.upper().lstrip("/")
    return next((t for t in snap.get("tokens", []) if t["symbol"].upper() == symbol_u), None)


def _card_text(row: dict) -> str:
    pct = prestocks.format_premium(row["premium"])
    return (
        f"<b>{row['symbol']}</b> — {row.get('name', '')}\n"
        f"{pct} vs mark\n"
        f"Tape ${row['tokenPrice']:.2f} · Mark ${row['markPrice']:.2f}\n"
        f"{WEB_PUBLIC_URL}/t/{row['symbol']}"
    )


def _board_line(row: dict) -> str:
    pct = prestocks.format_premium(row["premium"])
    return f"{row['symbol']:<10} {pct:>7}   ${row['tokenPrice']:.2f} vs ${row['markPrice']:.2f}"


@router.message(Command("start"))
async def on_start(message: Message, command: CommandObject):
    payload = (command.args or "").strip()
    if payload:
        row = _row_for(payload)
        if row:
            await message.answer(_card_text(row), disable_web_page_preview=True)
            return
    text = (
        "Marktape — mark vs tape for PreStocks.\n"
        "We show where the onchain price and the issuer mark disagree, and let you trade the gap.\n"
        f"Live board: {WEB_PUBLIC_URL}\n\n"
        "Not for US persons. Not investment advice."
    )
    await message.answer(text, disable_web_page_preview=True)


@router.message(Command("board"))
async def on_board(message: Message):
    snap = prestocks.get_cached_snapshot()
    tokens = snap.get("tokens", [])
    if not tokens:
        await message.answer("Board is warming up — try again in a moment.")
        return
    lines = [_board_line(t) for t in tokens]
    text = "<code>" + "\n".join(lines) + "</code>"
    await message.answer(text)


@router.message(Command("t"))
async def on_t(message: Message, command: CommandObject):
    symbol = (command.args or "").strip()
    if not symbol:
        await message.answer("Usage: /t SPACEX")
        return
    row = _row_for(symbol)
    if not row:
        await message.answer(f"Unknown symbol: {symbol}")
        return
    jup_link = f"{JUPITER_DEEP_BASE}/{prestocks.USDC_MINT}-{row['mint']}"
    text = _card_text(row) + f"\nTrade: {WEB_PUBLIC_URL}/t/{row['symbol']}#swap\nJupiter: {jup_link}"
    await message.answer(text, disable_web_page_preview=True)


@router.message(Command("watch"))
async def on_watch(message: Message, command: CommandObject):
    symbol = (command.args or "").strip()
    if not symbol:
        await message.answer("Usage: /watch SPACEX")
        return
    row = _row_for(symbol)
    if not row:
        await message.answer(f"Unknown symbol: {symbol}")
        return

    symbol_u = row["symbol"].upper()
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Watch).where(Watch.chat_id == message.chat.id, Watch.symbol == symbol_u)
        ).scalar_one_or_none()
        if existing:
            await message.answer(f"Already watching {symbol_u} (±{existing.threshold*100:.0f}%).")
            return
        db.add(Watch(chat_id=message.chat.id, symbol=symbol_u, threshold=DEFAULT_THRESHOLD))
        db.commit()
    finally:
        db.close()

    await message.answer(f"Watching {symbol_u}. Alert on ±{DEFAULT_THRESHOLD*100:.0f}% premium.")


@router.message(Command("unwatch"))
async def on_unwatch(message: Message, command: CommandObject):
    symbol = (command.args or "").strip().upper()
    if not symbol:
        await message.answer("Usage: /unwatch SPACEX")
        return
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Watch).where(Watch.chat_id == message.chat.id, Watch.symbol == symbol)
        ).scalar_one_or_none()
        if not existing:
            await message.answer(f"Not watching {symbol}.")
            return
        db.delete(existing)
        db.commit()
    finally:
        db.close()
    await message.answer(f"Stopped watching {symbol}.")


@router.message(Command("watches"))
async def on_watches(message: Message):
    db = SessionLocal()
    try:
        rows = db.execute(select(Watch).where(Watch.chat_id == message.chat.id)).scalars().all()
    finally:
        db.close()
    if not rows:
        await message.answer("No watches yet. /watch SPACEX to start.")
        return
    lines = [f"{w.symbol}  ±{w.threshold*100:.0f}%" for w in rows]
    await message.answer("\n".join(lines))


@router.message()
async def on_symbol_shortcut(message: Message):
    """Bare /spacex style shortcut per spec §2.2."""
    text = (message.text or "").strip()
    if not text.startswith("/"):
        return
    symbol = text[1:].split("@")[0]
    row = _row_for(symbol)
    if not row:
        return
    jup_link = f"{JUPITER_DEEP_BASE}/{prestocks.USDC_MINT}-{row['mint']}"
    reply = _card_text(row) + f"\nTrade: {WEB_PUBLIC_URL}/t/{row['symbol']}#swap\nJupiter: {jup_link}"
    await message.answer(reply, disable_web_page_preview=True)


# ---------------------------------------------------------------------------
# Alert loop
# ---------------------------------------------------------------------------

async def _run_alert_pass(bot: Bot):
    snap = prestocks.get_cached_snapshot()
    tokens_by_symbol = {t["symbol"].upper(): t for t in snap.get("tokens", [])}
    if not tokens_by_symbol:
        return

    db = SessionLocal()
    try:
        watches = db.execute(select(Watch)).scalars().all()
        now = datetime.now(timezone.utc)
        for w in watches:
            row = tokens_by_symbol.get(w.symbol)
            if not row or row["premium"] is None:
                continue
            premium = row["premium"]
            crossed = abs(premium) >= w.threshold
            was_crossed = w.last_premium is not None and abs(w.last_premium) >= w.threshold
            sign_flip = (
                w.last_premium is not None
                and premium * w.last_premium < 0
                and abs(premium) >= w.threshold
            )

            should_alert = crossed and (not was_crossed or sign_flip)
            if should_alert and w.last_alert_at:
                elapsed = now - w.last_alert_at
                if elapsed < timedelta(minutes=ALERT_DEDUPE_MINUTES) and not sign_flip:
                    should_alert = False

            if should_alert:
                try:
                    await bot.send_message(w.chat_id, _card_text(row), disable_web_page_preview=True)
                    w.last_alert_at = now
                except Exception:
                    log.warning("telegram_bot: failed to alert chat %s", w.chat_id, exc_info=True)

            w.last_premium = premium
        db.commit()
    finally:
        db.close()


async def _alert_loop(bot: Bot):
    while True:
        try:
            await _run_alert_pass(bot)
        except Exception:
            log.exception("telegram_bot: alert loop iteration failed")
        await asyncio.sleep(60)


_bot: Bot | None = None
_dp: Dispatcher | None = None
_task: asyncio.Task | None = None
_alert_task: asyncio.Task | None = None


async def _polling_loop():
    global _bot, _dp
    _bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
    _dp = Dispatcher()
    _dp.include_router(router)

    global _alert_task
    if _alert_task is None or _alert_task.done():
        _alert_task = asyncio.create_task(_alert_loop(_bot))

    while True:
        try:
            for attempt in range(5):
                try:
                    await _bot.delete_webhook(drop_pending_updates=True)
                    break
                except Exception:
                    log.warning("telegram_bot: delete_webhook attempt %d failed, retrying", attempt + 1)
                    await asyncio.sleep(min(2 ** attempt, 30))
            await _dp.start_polling(_bot, handle_signals=False)
        except Exception:
            log.exception("telegram_bot: polling loop crashed, restarting in 10s")
        await asyncio.sleep(10)


def start_telegram_bot_task() -> None:
    """No-ops if TELEGRAM_BOT_TOKEN isn't set — safe to always call from
    main.py's startup event regardless of whether the bot is configured."""
    global _task
    if not BOT_TOKEN:
        log.warning("telegram_bot: TELEGRAM_BOT_TOKEN not set, bot disabled")
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(_polling_loop())
