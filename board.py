"""StreetTape board: Yahoo mark + GeckoTerminal tape."""
from __future__ import annotations

import os
import asyncio
import logging

import httpx

import rwa
from database import SessionLocal
from models import PriceSnapshot

log = logging.getLogger("board")
REFRESH_SECONDS = int(os.getenv("BOARD_REFRESH_SECONDS", "45"))
GECKO = "https://api.geckoterminal.com/api/v2"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart"
HEADERS = {"User-Agent": "StreetTape/1.0", "Accept": "application/json"}
_task = None


async def _yahoo_marks(client: httpx.AsyncClient) -> dict:
    out = {}
    tickers = sorted({u["yahoo"] for u in rwa.UNIVERSE if u.get("yahoo")})
    for tkr in tickers:
        try:
            resp = await client.get(f"{YAHOO}/{tkr}", params={"interval": "1d", "range": "5d"})
            resp.raise_for_status()
            result = (resp.json().get("chart") or {}).get("result") or []
            if not result:
                continue
            meta = result[0].get("meta") or {}
            px = meta.get("regularMarketPrice") or meta.get("chartPreviousClose") or meta.get("previousClose")
            if px:
                out[tkr] = float(px)
        except Exception:
            log.warning("board: yahoo %s failed", tkr, exc_info=True)
        await asyncio.sleep(0.12)
    return out


async def _one_gecko(client, addr: str):
    resp = await client.get(f"{GECKO}/networks/bsc/tokens/{addr}")
    if resp.status_code == 429:
        await asyncio.sleep(2)
        resp = await client.get(f"{GECKO}/networks/bsc/tokens/{addr}")
    if resp.status_code != 200:
        return None
    attr = resp.json()["data"]["attributes"]
    px = attr.get("price_usd")
    return {"price": float(px) if px else None, "image": attr.get("image_url")}


async def _gecko_prices(client) -> dict:
    out = {}
    addrs = [w["address"] for w in rwa.wrappers() if w.get("address")]
    for i in range(0, len(addrs), 5):
        chunk = addrs[i:i + 5]
        try:
            resp = await client.get(f"{GECKO}/networks/bsc/tokens/multi/{','.join(chunk)}")
            if resp.status_code == 200:
                data = resp.json().get("data") or []
                if isinstance(data, dict):
                    data = [data]
                for item in data:
                    attr = item.get("attributes") or {}
                    addr = (attr.get("address") or "").lower()
                    px = attr.get("price_usd")
                    out[addr] = {"price": float(px) if px else None, "image": attr.get("image_url")}
                await asyncio.sleep(0.2)
                continue
        except Exception:
            log.info("board: gecko multi miss", exc_info=True)
        for a in chunk:
            try:
                row = await _one_gecko(client, a)
                if row:
                    out[a.lower()] = row
            except Exception:
                log.info("board: gecko %s skipped", a, exc_info=True)
            await asyncio.sleep(0.2)
    return out


def _group(tokens):
    by = {}
    for t in tokens:
        by.setdefault(t["underlying"], []).append(t)
    groups = []
    for und, rows in by.items():
        priced = [r for r in rows if r.get("tokenPrice")]
        cheapest = min(priced, key=lambda r: r["tokenPrice"]) if priced else None
        richest = max(priced, key=lambda r: r["tokenPrice"]) if priced else None
        groups.append({
            "underlying": und,
            "name": rows[0]["name"],
            "markPrice": rows[0].get("markPrice"),
            "wrappers": rows,
            "cheapest": cheapest["symbol"] if cheapest else None,
            "richest": richest["symbol"] if richest else None,
            "crossSpread": (
                (richest["tokenPrice"] / cheapest["tokenPrice"] - 1)
                if cheapest and richest and cheapest["tokenPrice"] else None
            ),
            "absPremium": max((abs(r["premium"] or 0) for r in rows), default=0),
        })
    groups.sort(key=lambda g: g["absPremium"], reverse=True)
    return groups


async def build_snapshot():
    async with httpx.AsyncClient(timeout=12, headers=HEADERS) as client:
        marks, tapes = await asyncio.gather(_yahoo_marks(client), _gecko_prices(client))
    tokens = []
    for w in rwa.wrappers():
        has_addr = bool(w.get("address"))
        tape = (tapes.get(w["address"].lower()) if has_addr else None) or {}
        token_price = tape.get("price")
        mark = marks.get(w["yahoo"]) if w.get("yahoo") else None
        prem = rwa.premium(token_price, mark) if token_price and mark else None
        tokens.append({
            "symbol": w["symbol"],
            "name": w["name"],
            "underlying": w["underlying"],
            "platform": w["platform"],
            "mint": w["address"],
            "address": w["address"],
            "image": tape.get("image"),
            "tokenPrice": token_price if has_addr else None,
            "markPrice": mark,
            "premium": prem if has_addr else None,
            "status": rwa.premium_status(prem) if has_addr else "flat",
            "description": (
                f"{w['name']} tokenized equity on BNB Chain via {w['platform']}. Economic exposure only."
                if has_addr else f"{w['name']} has no confirmed {w['platform']} wrapper yet."
            ),
            "url": f"https://pancakeswap.finance/swap?chain=bsc&outputCurrency={w['address']}" if has_addr else None,
            "multiplier": w.get("multiplier"),
        })
    tokens.sort(key=lambda t: abs(t["premium"] or 0), reverse=True)
    snap = rwa.set_cached_snapshot(tokens, _group(tokens))
    _persist(tokens)
    return snap


def _persist(rows):
    db = SessionLocal()
    try:
        for row in rows:
            if not row.get("tokenPrice"):
                continue
            db.add(PriceSnapshot(
                symbol=row["symbol"],
                token_price=row["tokenPrice"],
                mark_price=row.get("markPrice") or 0.0,
                premium=row.get("premium"),
                platform=row.get("platform"),
                underlying=row.get("underlying"),
            ))
        db.commit()
    except Exception:
        log.warning("board: persist failed", exc_info=True)
        db.rollback()
    finally:
        db.close()


async def _loop():
    while True:
        try:
            await build_snapshot()
        except Exception:
            log.exception("board: refresh failed")
        await asyncio.sleep(REFRESH_SECONDS)


def start_board_refresh_task():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())
