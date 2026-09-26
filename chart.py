"""Price history: snapshots for wrappers, Binance klines for BNB/stables."""
from __future__ import annotations

import time
import logging
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select

import prices
from database import SessionLocal
from models import PriceSnapshot

log = logging.getLogger("chart")
CACHE_SECONDS = 30.0
MAX_POINTS = 120
RANGES = {
    "1H": (timedelta(hours=1), "1m", 60),
    "6H": (timedelta(hours=6), "5m", 72),
    "1D": (timedelta(days=1), "15m", 96),
    "1W": (timedelta(days=7), "1h", 168),
}
BINANCE_PAIR = {"BNB": "BNBUSDT", "USDC": "USDCUSDT", "USDT": "USDCUSDT"}
_cache = {}


def _downsample(rows):
    if len(rows) <= MAX_POINTS:
        return [[t, p] for t, p in rows]
    size = len(rows) / MAX_POINTS
    out = []
    for i in range(MAX_POINTS):
        chunk = rows[int(i * size): int((i + 1) * size)]
        if chunk:
            out.append([chunk[-1][0], sum(p for _, p in chunk) / len(chunk)])
    return out


def _stock_points(symbol, window):
    cutoff = datetime.now(timezone.utc) - window
    db = SessionLocal()
    try:
        rows = db.execute(
            select(PriceSnapshot.fetched_at, PriceSnapshot.token_price)
            .where(PriceSnapshot.symbol == symbol, PriceSnapshot.fetched_at >= cutoff)
            .order_by(PriceSnapshot.fetched_at.asc())
        ).all()
    finally:
        db.close()
    return _downsample([(int(r[0].timestamp() * 1000), float(r[1])) for r in rows if r[1]])


async def _binance_points(symbol, interval, limit):
    pair = BINANCE_PAIR[symbol]
    async with httpx.AsyncClient(timeout=8) as client:
        for base in prices.BINANCE_BASES:
            try:
                resp = await client.get(f"{base}/api/v3/klines", params={"symbol": pair, "interval": interval, "limit": limit})
                resp.raise_for_status()
                out = []
                for k in resp.json():
                    px = float(k[4])
                    if symbol == "USDT":
                        px = 1 / px if px else 0
                    out.append([int(k[0]), px])
                return out
            except Exception:
                log.warning("chart: binance %s failed", base, exc_info=True)
    return []


async def get_wrapper_points(wrapper_symbols: list, window) -> dict:
    """Return {symbol: [[ts,px], ...]} for each wrapper from price_snapshots."""
    if not wrapper_symbols:
        return {}
    cutoff = datetime.now(timezone.utc) - window
    db = SessionLocal()
    try:
        rows = db.execute(
            select(PriceSnapshot.symbol, PriceSnapshot.fetched_at, PriceSnapshot.token_price)
            .where(
                PriceSnapshot.symbol.in_(wrapper_symbols),
                PriceSnapshot.fetched_at >= cutoff,
            )
            .order_by(PriceSnapshot.symbol.asc(), PriceSnapshot.fetched_at.asc())
        ).all()
    finally:
        db.close()
    by_sym: dict = {}
    for sym, ts, px in rows:
        if px:
            by_sym.setdefault(sym, []).append((int(ts.timestamp() * 1000), float(px)))
    return {sym: _downsample(pts) for sym, pts in by_sym.items()}


async def get_multi_points(underlying: str, rng: str) -> dict:
    """For group pages: returns {mark:[[ts,px]], wrappers:{SYM:[[ts,px]]}}."""
    import rwa as _rwa
    window, _interval, _limit = RANGES[rng]
    # cash mark series
    mark_pts = _stock_points(underlying, window)
    # wrapper series
    w_syms = [w["symbol"] for w in _rwa.wrappers() if w["underlying"] == underlying and w.get("address")]
    wrapper_pts = await get_wrapper_points(w_syms, window)
    return {"mark": mark_pts, "wrappers": wrapper_pts}


async def get_points(symbol, rng):
    key = (symbol, rng)
    cached = _cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]
    window, interval, limit = RANGES[rng]
    pts = await _binance_points(symbol, interval, limit) if symbol in BINANCE_PAIR else _stock_points(symbol, window)
    _cache[key] = (time.time() + CACHE_SECONDS, pts)
    return pts
