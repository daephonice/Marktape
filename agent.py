"""Rule agent: watch premium vs mark, alert on Telegram when cash is shut.

No paid LLM. Threshold default 1.5%. Quiet period 60 minutes per watch.
"""
from __future__ import annotations

import os
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

import rwa
from database import SessionLocal
from models import Watch, utcnow

log = logging.getLogger("agent")
SCAN_SECONDS = int(os.getenv("AGENT_SCAN_SECONDS", "60"))
DEFAULT_THRESHOLD = float(os.getenv("AGENT_THRESHOLD", "0.015"))
COOLDOWN = timedelta(minutes=60)
_task = None


def scan_gaps(min_abs=None):
    min_abs = DEFAULT_THRESHOLD if min_abs is None else min_abs
    snap = rwa.get_cached_snapshot()
    session = snap.get("session") or rwa.session_now()
    hits = []
    for t in snap.get("tokens") or []:
        prem = t.get("premium")
        if prem is None or abs(prem) < min_abs:
            continue
        hits.append({
            "symbol": t["symbol"],
            "underlying": t.get("underlying"),
            "platform": t.get("platform"),
            "tokenPrice": t.get("tokenPrice"),
            "markPrice": t.get("markPrice"),
            "premium": prem,
            "status": t.get("status"),
            "session": session.get("label"),
            "cashOpen": session.get("cashOpen"),
            "deepLink": t.get("url"),
        })
    hits.sort(key=lambda h: abs(h["premium"]), reverse=True)
    return {"session": session, "threshold": min_abs, "hits": hits}


def _watches():
    db = SessionLocal()
    try:
        return db.execute(select(Watch)).scalars().all()
    finally:
        db.close()


def _mark_alerted(watch_id, premium):
    db = SessionLocal()
    try:
        w = db.get(Watch, watch_id)
        if not w:
            return
        w.last_alert_at = utcnow()
        w.last_alert_premium = premium
        db.commit()
    except Exception:
        db.rollback()
        log.warning("agent: mark alert failed", exc_info=True)
    finally:
        db.close()


async def fire_due_alerts():
    """Called by telegram_bot so we reuse the live bot instance."""
    import telegram_bot
    if not telegram_bot.BOT_TOKEN:
        return 0
    report = scan_gaps()
    by_sym = {h["symbol"].upper(): h for h in report["hits"]}
    sent = 0
    now = datetime.now(timezone.utc)
    for w in _watches():
        thresh = w.threshold if getattr(w, "threshold", None) not in (None, 0) else DEFAULT_THRESHOLD
        hit = by_sym.get((w.symbol or "").upper())
        if not hit or abs(hit["premium"]) < thresh:
            continue
        last = w.last_alert_at
        if last is not None:
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if now - last < COOLDOWN:
                continue
        text = (
            f"StreetTape alert · {report['session'].get('label')}\n"
            f"<b>{hit['symbol']}</b> {rwa.format_premium(hit['premium'])} vs mark\n"
            f"Tape ${hit['tokenPrice']:.2f} · Mark ${hit['markPrice']:.2f}\n"
            f"{hit.get('deepLink') or ''}"
        )
        try:
            await telegram_bot.send_alert(w.chat_id, text)
            _mark_alerted(w.id, hit["premium"])
            sent += 1
        except Exception:
            log.warning("agent: send failed chat=%s", w.chat_id, exc_info=True)
    return sent


async def _loop():
    await asyncio.sleep(15)
    while True:
        try:
            await fire_due_alerts()
        except Exception:
            log.exception("agent: scan failed")
        await asyncio.sleep(SCAN_SECONDS)


def start_agent_task():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())
