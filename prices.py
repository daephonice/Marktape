"""Shared price cache — the single source every browser reads from.

A background task refreshes the cache once per second:
  * PreStocks tokens  -> PreStocks API (tokenPrice)
  * SOL / USDT / USDC -> Binance public market data (24hr ticker)

Users only ever hit /api/prices, which is served from memory, so upstream
load is 1 request/second per source no matter how many users are online.

24h change:
  * Binance assets  -> from the 24hr ticker's openPrice
  * PreStocks       -> from price_snapshots (written by board.py), refreshed
                       once a minute
"""
import json
import time
import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select

import prestocks
from database import SessionLocal
from models import PriceSnapshot

log = logging.getLogger("prices")

REFRESH_SECONDS = 1.0
OPEN_REFRESH_SECONDS = 60.0
LOG_EVERY_SECONDS = 30.0

# data-api.binance.vision serves public market data and is not region-blocked
# like api.binance.com can be on some hosts, so it goes first.
BINANCE_BASES = ("https://data-api.binance.vision", "https://api.binance.com")
BINANCE_PAIRS = ("SOLUSDT", "USDCUSDT")

TOKEN_ASSETS = {
    "SOL": {
        "name": "Solana",
        "image": "/static/img/sol.svg",
        "mint": "So11111111111111111111111111111111111111112",
        "url": "https://solana.com",
        "description": (
            "Solana is a high-throughput blockchain. SOL is its native token, used to pay "
            "network fees and to stake with validators that secure the network."
        ),
    },
    "USDT": {
        "name": "Tether",
        "image": "/static/img/usdt.svg",
        "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        "url": "https://tether.to",
        "description": (
            "Tether (USDT) is a stablecoin designed to track the US dollar 1:1, "
            "issued by Tether Limited."
        ),
    },
    "USDC": {
        "name": "USD Coin",
        "image": "/static/img/usdc.svg",
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "url": "https://www.circle.com/usdc",
        "description": (
            "USD Coin (USDC) is a dollar-backed stablecoin issued by Circle, "
            "designed to be redeemable 1:1 for US dollars."
        ),
    },
}

_stocks: dict[str, dict] = {}       # SYMBOL -> {symbol, mint, name, image, description, url, supply, price}
_tokens: dict[str, dict] = {}       # SOL/USDT/USDC -> {price, open}
_stock_open: dict[str, float] = {}  # raw symbol -> price ~24h ago
_updated_at: datetime | None = None
_last_logged: dict[str, float] = {}
_task: asyncio.Task | None = None


def _warn(key: str, msg: str) -> None:
    now = time.monotonic()
    if now - _last_logged.get(key, 0.0) >= LOG_EVERY_SECONDS:
        _last_logged[key] = now
        log.warning(msg, exc_info=True)


def _touch() -> None:
    global _updated_at
    _updated_at = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Refreshers
# ---------------------------------------------------------------------------
async def _refresh_stocks(client: httpx.AsyncClient) -> None:
    try:
        records = await prestocks.fetch_prestocks(client)
    except Exception:
        _warn("prestocks", "prices: PreStocks fetch failed, serving last-good prices")
        return
    for r in records:
        price = float(r["tokenPrice"])
        if price <= 0:
            continue
        supply = r.get("supply")
        url = r.get("external_url")
        desc = r.get("description")
        _stocks[r["symbol"].upper()] = {
            "symbol": r["symbol"],
            "mint": r["contract_address"],
            "name": r.get("name") or r["symbol"],
            "image": r.get("image"),
            "description": desc if isinstance(desc, str) and desc.strip() else None,
            "url": url if isinstance(url, str) and url.startswith(("https://", "http://")) else None,
            "supply": float(supply) if isinstance(supply, (int, float)) else None,
            "price": price,
        }
    _touch()


async def _refresh_tokens(client: httpx.AsyncClient) -> None:
    params = {"symbols": json.dumps(list(BINANCE_PAIRS), separators=(",", ":"))}
    rows = None
    for base in BINANCE_BASES:
        try:
            resp = await client.get(f"{base}/api/v3/ticker/24hr", params=params)
            resp.raise_for_status()
            rows = {r["symbol"]: r for r in resp.json()}
            sol_last, sol_open = float(rows["SOLUSDT"]["lastPrice"]), float(rows["SOLUSDT"]["openPrice"])
            usdc_last, usdc_open = float(rows["USDCUSDT"]["lastPrice"]), float(rows["USDCUSDT"]["openPrice"])
            if min(sol_last, usdc_last, usdc_open) <= 0:
                raise ValueError("non-positive Binance price")
            break
        except Exception:
            rows = None
            _warn(f"binance:{base}", f"prices: Binance fetch failed via {base}")
    if rows is None:
        return

    # Binance quotes everything in USDT: SOLUSDT is SOL's USD price, USDCUSDT is
    # USDC's, and USDT's own price is the inverse of that pair.
    _tokens["SOL"] = {"price": sol_last, "open": sol_open if sol_open > 0 else None}
    _tokens["USDC"] = {"price": usdc_last, "open": usdc_open}
    _tokens["USDT"] = {"price": 1 / usdc_last, "open": 1 / usdc_open}
    _touch()


def _load_open_prices(symbols: list[str]) -> dict[str, float]:
    """Price ~24h ago per symbol. Prefers the newest snapshot within the 6h
    before the 24h mark; otherwise the oldest snapshot inside the last 24h
    (so a young or gappy history still gives a sensible change)."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    db = SessionLocal()
    try:
        out: dict[str, float] = {}
        for sym in symbols:
            row = db.execute(
                select(PriceSnapshot.token_price)
                .where(
                    PriceSnapshot.symbol == sym,
                    PriceSnapshot.fetched_at <= cutoff,
                    PriceSnapshot.fetched_at >= cutoff - timedelta(hours=6),
                )
                .order_by(PriceSnapshot.fetched_at.desc())
                .limit(1)
            ).first()
            if row is None:
                row = db.execute(
                    select(PriceSnapshot.token_price)
                    .where(PriceSnapshot.symbol == sym, PriceSnapshot.fetched_at > cutoff)
                    .order_by(PriceSnapshot.fetched_at.asc())
                    .limit(1)
                ).first()
            if row and row[0] and row[0] > 0:
                out[sym] = float(row[0])
        return out
    finally:
        db.close()


async def _refresh_stock_open() -> None:
    symbols = [s["symbol"] for s in _stocks.values()]
    if not symbols:
        return
    try:
        _stock_open.update(await asyncio.to_thread(_load_open_prices, symbols))
    except Exception:
        _warn("open", "prices: 24h reference load failed")


async def _loop() -> None:
    last_open = 0.0
    async with httpx.AsyncClient(timeout=5, headers={"Accept": "application/json"}) as client:
        while True:
            started = time.monotonic()
            await asyncio.gather(_refresh_stocks(client), _refresh_tokens(client), return_exceptions=True)
            if time.monotonic() - last_open >= OPEN_REFRESH_SECONDS:
                last_open = time.monotonic()
                await _refresh_stock_open()
            await asyncio.sleep(max(0.0, REFRESH_SECONDS - (time.monotonic() - started)))


def start_price_task() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


# ---------------------------------------------------------------------------
# Readers (memory only)
# ---------------------------------------------------------------------------
def _pct(price: float, open_price: float | None) -> float | None:
    if not open_price or open_price <= 0:
        return None
    return (price / open_price - 1) * 100


def get_prices() -> dict | None:
    """{"updatedAt", "prices": {SYMBOL: {price, change24h, mc?}}}; None until
    the first refresh lands."""
    if not _stocks and not _tokens:
        return None
    out: dict[str, dict] = {}
    for sym, t in _tokens.items():
        out[sym] = {"price": t["price"], "change24h": _pct(t["price"], t["open"])}
    for sym, s in _stocks.items():
        entry = {"price": s["price"], "change24h": _pct(s["price"], _stock_open.get(s["symbol"]))}
        if s["supply"]:
            entry["mc"] = s["supply"] * s["price"]
        out[sym] = entry
    return {"updatedAt": _updated_at.isoformat() if _updated_at else None, "prices": out}


def get_assets() -> dict:
    """Static display metadata (name, logo, kind) for every tradable asset."""
    assets = {sym: {"name": m["name"], "image": m["image"], "kind": "token"} for sym, m in TOKEN_ASSETS.items()}
    for sym, s in _stocks.items():
        assets[sym] = {"name": s["name"], "image": s["image"], "kind": "stock"}
    return {"assets": assets}


def stock_mints() -> dict[str, str]:
    """{mint: SYMBOL} for every PreStocks token currently in the universe."""
    return {s["mint"]: sym for sym, s in _stocks.items()}


def get_asset(symbol: str) -> dict | None:
    """Full detail for one of the 11 accepted assets (token page), or None."""
    sym = (symbol or "").upper()
    t = TOKEN_ASSETS.get(sym)
    if t:
        return {"symbol": sym, "kind": "token", **t}
    s = _stocks.get(sym)
    if s:
        return {
            "symbol": sym,
            "kind": "stock",
            "name": s["name"],
            "image": s["image"],
            "mint": s["mint"],
            "description": s["description"],
            "url": s["url"],
        }
    return None


async def wait_ready(timeout: float = 4.0) -> None:
    """Cold start only: wait for the first PreStocks refresh to land."""
    end = time.monotonic() + timeout
    while not _stocks and time.monotonic() < end:
        await asyncio.sleep(0.1)
