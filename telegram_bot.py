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
from aiogram.types import CallbackQuery, Message, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.client.default import DefaultBotProperties

from sqlalchemy import select

import news
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
MAX_WATCHES_PER_CHAT = 5


def _row_for(symbol: str) -> dict | None:
    snap = prestocks.get_cached_snapshot()
    symbol_u = symbol.upper().lstrip("/")
    return next((t for t in snap.get("tokens", []) if t["symbol"].upper() == symbol_u), None)


def _resolve_symbol(text: str) -> str | None:
    """Name or ticker -> canonical symbol among the 8 PreStocks + SOL, or None."""
    text_u = text.strip().upper().lstrip("/")
    if not text_u:
        return None
    if text_u == "SOL":
        return "SOL"
    row = _row_for(text_u)
    if row:
        return row["symbol"].upper()
    # fall back to matching by name
    snap = prestocks.get_cached_snapshot()
    for t in snap.get("tokens", []):
        if (t.get("name") or "").strip().upper() == text_u:
            return t["symbol"].upper()
    return None


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
    buttons = [InlineKeyboardButton(text=r["symbol"], callback_data=f"tok:{r['symbol']}") for r in rows]
    kb: list[list[InlineKeyboardButton]] = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
    kb.append([InlineKeyboardButton(text="SOL", callback_data="tok:SOL")])
    return InlineKeyboardMarkup(inline_keyboard=kb)


# chat_id -> message_id for the one active live board per chat. In-memory
# only (spec: no DB). A new /start (no payload) replaces the old target.
_live_boards: dict[int, int] = {}
_live_board_lock = asyncio.Lock()

# chat_id -> message_id currently showing a token menu (not the live board).
# The live board editor skips these chats until Back is pressed.
_token_menus: dict[int, int] = {}
_token_menus_lock = asyncio.Lock()


def _is_watching(chat_id: int, symbol: str) -> bool:
    db = SessionLocal()
    try:
        return db.execute(
            select(Watch.id).where(Watch.chat_id == chat_id, Watch.symbol == symbol.upper())
        ).first() is not None
    finally:
        db.close()


def _add_watch(chat_id: int, symbol: str) -> str:
    """Returns 'added' | 'exists' | 'cap'."""
    symbol_u = symbol.upper()
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Watch).where(Watch.chat_id == chat_id, Watch.symbol == symbol_u)
        ).scalar_one_or_none()
        if existing:
            return "exists"
        count = db.execute(select(Watch.id).where(Watch.chat_id == chat_id)).scalars().all()
        if len(count) >= MAX_WATCHES_PER_CHAT:
            return "cap"
        db.add(Watch(chat_id=chat_id, symbol=symbol_u, threshold=DEFAULT_THRESHOLD))
        db.commit()
        return "added"
    finally:
        db.close()


def _remove_watch(chat_id: int, symbol: str) -> bool:
    symbol_u = symbol.upper()
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Watch).where(Watch.chat_id == chat_id, Watch.symbol == symbol_u)
        ).scalar_one_or_none()
        if not existing:
            return False
        db.delete(existing)
        db.commit()
        return True
    finally:
        db.close()


def _token_menu_text(symbol: str, chat_id: int | None = None) -> str | None:
    symbol_u = symbol.upper()
    watching = _is_watching(chat_id, symbol_u) if chat_id is not None else False
    prefix = "Watching 👁️ " if watching else ""

    if symbol_u == "SOL":
        live = prices.get_prices()
        sol = (live or {}).get("prices", {}).get("SOL")
        asset = prices.get_asset("SOL")
        if not sol or not asset:
            return None
        price = f"${sol['price']:.2f}" if sol.get("price") is not None else "—"
        lines = [f"<b>{prefix}SOL</b> — {asset['name']}", f"Tape {price}"]
        if asset.get("description"):
            lines.append(f"\n{asset['description']}")
        return "\n".join(lines)

    row = _row_for(symbol_u)
    asset = prices.get_asset(symbol_u)
    if not row or not asset:
        return None
    pct = prestocks.format_premium(row["premium"])
    lines = [
        f"<b>{prefix}{row['symbol']}</b> — {row.get('name', '')}",
        f"Tape ${row['tokenPrice']:.2f} · Mark ${row['markPrice']:.2f} · {pct}",
    ]
    if asset.get("description"):
        lines.append(f"\n{asset['description']}")

    item = next((n for n in news.get_news() if n["symbol"].upper() == symbol_u), None)
    if item:
        lines.append(f"\n📰 {item['body']}")

    jup_link = f"{JUPITER_DEEP_BASE}/{prestocks.USDC_MINT}-{row['mint']}"
    lines.append(f"\nCHECK ON JUPITER\n{jup_link}")
    return "\n".join(lines)


def _token_menu_markup(chat_id: int, symbol: str) -> InlineKeyboardMarkup:
    symbol_u = symbol.upper()
    watch_label = "Watching" if _is_watching(chat_id, symbol_u) else "Watch 👁️"
    kb = [[
        InlineKeyboardButton(text=watch_label, callback_data=f"watch:{symbol_u}"),
        InlineKeyboardButton(text="Unwatch ❌", callback_data=f"unwatch:{symbol_u}"),
    ]]
    if symbol_u != "SOL":
        kb.append([InlineKeyboardButton(text="Open on Marktape", url=f"{WEB_PUBLIC_URL}/t/{symbol_u}")])
    kb.append([InlineKeyboardButton(text="◀ Back", callback_data="back:board")])
    return InlineKeyboardMarkup(inline_keyboard=kb)


@router.callback_query(lambda c: c.data and c.data.startswith("tok:"))
async def on_token_tap(callback: CallbackQuery):
    symbol = callback.data.split(":", 1)[1]
    chat_id = callback.message.chat.id
    text = _token_menu_text(symbol, chat_id)
    if not text:
        await callback.answer()
        return
    markup = _token_menu_markup(chat_id, symbol)
    try:
        await callback.message.edit_text(text, reply_markup=markup, disable_web_page_preview=True)
    except TelegramBadRequest as e:
        if "message is not modified" not in str(e).lower():
            raise
    async with _token_menus_lock:
        _token_menus[chat_id] = callback.message.message_id
    await callback.answer()


@router.callback_query(lambda c: c.data == "back:board")
async def on_back(callback: CallbackQuery):
    chat_id = callback.message.chat.id
    rows = _live_rows()
    if rows:
        text = (
            "Marktape — mark vs tape for PreStocks.\n"
            "We show where the onchain price and the issuer mark disagree, and let you trade the gap.\n\n"
        ) + _live_board_text(rows)
        markup = _live_board_markup(rows)
    else:
        text = "Board is warming up — try again in a moment."
        markup = None
    try:
        await callback.message.edit_text(text, reply_markup=markup, disable_web_page_preview=True)
    except TelegramBadRequest as e:
        if "message is not modified" not in str(e).lower():
            raise
    async with _token_menus_lock:
        _token_menus.pop(chat_id, None)
    async with _live_board_lock:
        _live_boards[chat_id] = callback.message.message_id
    await callback.answer()


async def _refresh_token_menu(callback: CallbackQuery, symbol: str) -> None:
    chat_id = callback.message.chat.id
    text = _token_menu_text(symbol, chat_id)
    if not text:
        return
    markup = _token_menu_markup(chat_id, symbol)
    try:
        await callback.message.edit_text(text, reply_markup=markup, disable_web_page_preview=True)
    except TelegramBadRequest as e:
        if "message is not modified" not in str(e).lower():
            raise


@router.callback_query(lambda c: c.data and c.data.startswith("watch:"))
async def on_watch_cb(callback: CallbackQuery):
    symbol = callback.data.split(":", 1)[1]
    chat_id = callback.message.chat.id
    result = _add_watch(chat_id, symbol)
    if result == "cap":
        await callback.answer(f"Watch limit reached ({MAX_WATCHES_PER_CHAT}). Unwatch one first.", show_alert=True)
        return
    await _refresh_token_menu(callback, symbol)
    await callback.answer("Watching" if result == "added" else "Already watching")


@router.callback_query(lambda c: c.data and c.data.startswith("unwatch:"))
async def on_unwatch_cb(callback: CallbackQuery):
    symbol = callback.data.split(":", 1)[1]
    chat_id = callback.message.chat.id
    removed = _remove_watch(chat_id, symbol)
    await _refresh_token_menu(callback, symbol)
    await callback.answer("Unwatched" if removed else "Not watching")


@router.message(Command("start"))
async def on_start(message: Message, command: CommandObject):
    payload = (command.args or "").strip()
    if payload:
        chat_id = message.chat.id
        text = _token_menu_text(payload, chat_id)
        if text:
            symbol_u = payload.upper().lstrip("/")
            sent = await message.answer(
                text, reply_markup=_token_menu_markup(chat_id, symbol_u), disable_web_page_preview=True
            )
            async with _token_menus_lock:
                _token_menus[chat_id] = sent.message_id
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


async def _send_token_menu(message: Message, symbol_u: str) -> None:
    chat_id = message.chat.id
    text = _token_menu_text(symbol_u, chat_id)
    if not text:
        return
    sent = await message.answer(
        text, reply_markup=_token_menu_markup(chat_id, symbol_u), disable_web_page_preview=True
    )
    async with _token_menus_lock:
        _token_menus[chat_id] = sent.message_id


@router.message(Command("watch"))
async def on_watch(message: Message, command: CommandObject):
    arg = (command.args or "").strip()
    if not arg:
        await message.answer("Usage: /watch SPACEX")
        return
    symbol_u = _resolve_symbol(arg)
    if not symbol_u:
        await message.answer(f"Unknown symbol: {arg}")
        return

    result = _add_watch(message.chat.id, symbol_u)
    if result == "cap":
        await message.answer(f"Watch limit reached ({MAX_WATCHES_PER_CHAT}). /unwatch one first.")
        return
    await _send_token_menu(message, symbol_u)


@router.message(Command("unwatch"))
async def on_unwatch(message: Message, command: CommandObject):
    arg = (command.args or "").strip()
    if not arg:
        await message.answer("Usage: /unwatch SPACEX")
        return
    symbol_u = _resolve_symbol(arg)
    if not symbol_u:
        await message.answer(f"Unknown symbol: {arg}")
        return

    _remove_watch(message.chat.id, symbol_u)
    await _send_token_menu(message, symbol_u)


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
    async with _token_menus_lock:
        on_token_menu = set(_token_menus.keys())
    targets = [(c, m) for c, m in targets if c not in on_token_menu]

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
