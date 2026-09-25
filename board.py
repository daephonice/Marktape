"""Assembles the board snapshot: PreStocks records -> multiplier-corrected
rows -> sorted by absolute premium desc. Runs a background refresh loop
(30-60s) started from main.py, same shape as the casino's price/game tasks.
Also persists rows into PriceSnapshot for the 24-72h sparkline (P3).
"""
import os
import asyncio
import logging

import httpx

import prestocks
import multiplier as multiplier_mod
import jupiter
from database import SessionLocal
from models import PriceSnapshot

log = logging.getLogger("board")

REFRESH_SECONDS = int(os.getenv("BOARD_REFRESH_SECONDS", "45"))

_task: asyncio.Task | None = None


async def build_snapshot() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            records = await prestocks.fetch_prestocks(client)
        except Exception:
            log.warning("board: PreStocks fetch failed, keeping last-good snapshot", exc_info=True)
            return prestocks.get_cached_snapshot()

        async def _row(r):
            mint = r["contract_address"]
            try:
                m = await multiplier_mod.get_mint_multiplier(mint, client)
                mult = m["multiplier"]
            except Exception:
                mult = 1.0
            return prestocks.normalize_row(r, multiplier=mult)

        rows = await asyncio.gather(*(_row(r) for r in records))

        # Best-effort executable price overlay — never blocks the board.
        try:
            mint_ids = [row["mint"] for row in rows]
            prices = await jupiter.get_prices(mint_ids, client)
            for row in rows:
                p = prices.get(row["mint"]) if isinstance(prices, dict) else None
                if p and isinstance(p, dict) and p.get("usdPrice"):
                    exec_price = float(p["usdPrice"])
                    row["execPrice"] = exec_price
                    if row["tokenPrice"]:
                        row["divergence"] = exec_price / row["tokenPrice"] - 1
        except Exception:
            log.info("board: jupiter price overlay skipped", exc_info=True)

        rows.sort(key=lambda t: abs(t["premium"] or 0), reverse=True)

    snapshot = prestocks.set_cached_snapshot(rows)
    _persist_snapshot_rows(rows)
    return snapshot


def _persist_snapshot_rows(rows: list[dict]) -> None:
    db = SessionLocal()
    try:
        for row in rows:
            db.add(PriceSnapshot(
                symbol=row["symbol"],
                token_price=row["tokenPrice"],
                mark_price=row["markPrice"],
                premium=row["premium"],
            ))
        db.commit()
    except Exception:
        log.warning("board: failed to persist snapshot rows", exc_info=True)
        db.rollback()
    finally:
        db.close()


async def _refresh_loop():
    while True:
        try:
            await build_snapshot()
        except Exception:
            log.exception("board: refresh loop iteration failed")
        await asyncio.sleep(REFRESH_SECONDS)


def start_board_refresh_task() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_refresh_loop())
