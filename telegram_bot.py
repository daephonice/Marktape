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
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.filters import Command, CommandObject
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.client.default import DefaultBotProperties

from sqlalchemy import select

import prestocks
import prices
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


def _live_rows() -> list[dict]:
    """One row per PreStock for the /start live board: symbol, tape price,
    24h% (falls back to premium if 24h change isn't available yet), sorted
    stable by market cap desc (falls back to the snapshot's existing
    premium-desc order when mc isn't available)."""
    snap = prestocks.get_cached_snapshot()
    tokens = snap.get("tokens", [])
    if not tokens:
        return []

    live = prices.get_prices()
    live_prices = (live or {}).get("prices", {})

    rows = []
    for t in tokens:
        sym = t["symbol"].upper()
        p = live_prices.get(sym)
        price = p["price"] if p and p.get("price") is not None else t.get("tokenPrice")
        change24h = p.get("change24h") if p else None
        mc = p.get("mc") if p else None
        rows.append({
            "symbol": t["symbol"],
            "price": price,
            "change24h": change24h,
            "premium": t.get("premium"),
            "mc": mc,
        })

    if any(r["mc"] is not None for r in rows):
        rows.sort(key=lambda r: r["mc"] if r["mc"] is not None else -1, reverse=True)
    # else: keep the snapshot's existing (premium-desc) order — already stable.
    return rows


def _live_line(row: dict) -> str:
    price = f"${row['price']:.2f}" if row["price"] is not None else "—"
    if row["change24h"] is not None:
        sign = "+" if row["change24h"] > 0 else ""
        pct = f"{sign}{row['change24h']:.1f}%"
    else:
        pct = prestocks.format_premium(row["premium"])
    return f"{row['symbol']:<10} {price:>10}   {pct:>7}"


def _sol_line() -> str | None:
    live = prices.get_prices()
    sol = (live or {}).get("prices", {}).get("SOL")
    if not sol or sol.get("price") is None:
        return None
    price = f"${sol['price']:.2f}"
    chg = sol.get("change24h")
    pct = f"{'+' if chg and chg > 0 else ''}{chg:.1f}%" if chg is not None else "—"
    return f"{'SOL':<10} {price:>10}   {pct:>7}"


def _live_board_text(rows: list[dict]) -> str:
    lines = [_live_line(r) for r in rows]
    sol_line = _sol_line()
    if sol_line:
        lines.append(sol_line)
    body = "\n".join(lines)
    return f"<b>Marktape — live board</b>\n<code>{body}</code>"


def _live_board_markup(rows: list[dict]) -> InlineKeyboardMarkup:
    """2 cols x 4 rows of PreStock symbols (same order as the price list),
    plus SOL full-width as the CTA row. Display-only: callback_data is a
    stub and no handler is registered for it."""
    buttons = [InlineKeyboardButton(text=r["symbol"], callback_data=f"noop:{r['symbol']}") for r in rows]
    kb: list[list[InlineKeyboardButton]] = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
    kb.append([InlineKeyboardButton(text="SOL", callback_data="noop:SOL")])
    return InlineKeyboardMarkup(inline_keyboard=kb)


# chat_id -> message_id for the one active live board per chat. In-memory
# only (spec: no DB). A new /start (no payload) replaces the old target.
_live_boards: dict[int, int] = {}
_live_board_lock = asyncio.Lock()


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
        "We show where the onchain price and the issuer mark disagree, and let you trade the gap.\n\n"
    )
    rows = _live_rows()
    if rows:
        text += _live_board_text(rows)
        markup = _live_board_markup(rows)
    else:
        text += "Board is warming up — try again in a moment."
        markup = None

    sent = await message.answer(text, reply_markup=markup, disable_web_page_preview=True)
    async with _live_board_lock:
        _live_boards[message.chat.id] = sent.message_id


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


# ---------------------------------------------------------------------------
# Live board loop — edits each chat's /start message every 5s.
# ---------------------------------------------------------------------------

LIVE_BOARD_INTERVAL = 5

_DEAD_MESSAGE_MARKERS = (
    "message to edit not found",
    "message to be edited not found",
    "message can't be found",
    "chat not found",
)


async def _run_live_board_pass(bot: Bot):
    rows = _live_rows()
    if not rows:
        return
    text = _live_board_text(rows)
    markup = _live_board_markup(rows)

    async with _live_board_lock:
        targets = list(_live_boards.items())

    dead: list[tuple[int, int]] = []  # (chat_id, message_id) pairs to drop
    for chat_id, message_id in targets:
        try:
            await bot.edit_message_text(text, chat_id=chat_id, message_id=message_id, reply_markup=markup)
        except TelegramBadRequest as e:
            msg = str(e).lower()
            if "message is not modified" in msg:
                continue
            if any(marker in msg for marker in _DEAD_MESSAGE_MARKERS):
                dead.append((chat_id, message_id))
            else:
                log.warning("telegram_bot: live board edit failed for chat %s: %s", chat_id, e)
        except TelegramForbiddenError:
            # Bot was blocked / chat gone.
            dead.append((chat_id, message_id))
        except Exception:
            log.warning("telegram_bot: live board edit failed for chat %s", chat_id, exc_info=True)

    if dead:
        async with _live_board_lock:
            for chat_id, message_id in dead:
                # Only drop if it's still pointing at the message we just
                # failed on — a fresh /start may have replaced it since.
                if _live_boards.get(chat_id) == message_id:
                    del _live_boards[chat_id]


async def _live_board_loop(bot: Bot):
    while True:
        try:
            await _run_live_board_pass(bot)
        except Exception:
            log.exception("telegram_bot: live board loop iteration failed")
        await asyncio.sleep(LIVE_BOARD_INTERVAL)


_bot: Bot | None = None
_dp: Dispatcher | None = None
_task: asyncio.Task | None = None
_alert_task: asyncio.Task | None = None
_live_board_task: asyncio.Task | None = None


async def _polling_loop():
    global _bot, _dp
    _bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
    _dp = Dispatcher()
    _dp.include_router(router)

    global _alert_task, _live_board_task
    if _alert_task is None or _alert_task.done():
        _alert_task = asyncio.create_task(_alert_loop(_bot))
    if _live_board_task is None or _live_board_task.done():
        _live_board_task = asyncio.create_task(_live_board_loop(_bot))

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
