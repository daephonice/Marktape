"""Price history for the token-page chart: [[epoch_ms, price], ...] per range.

  * PreStocks tokens  -> price_snapshots (written by board.py), bucket-averaged
  * SOL / USDC / USDT -> Binance public klines (USDT is the inverse of USDCUSDT)

Results are cached in memory for CACHE_SECONDS per (symbol, range).
"""
import time
import asyncio
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

# range -> (window, binance interval, binance limit)
RANGES = {
    "1H": (timedelta(hours=1), "1m", 60),
    "6H": (timedelta(hours=6), "5m", 72),
    "1D": (timedelta(days=1), "15m", 96),
    "1W": (timedelta(days=7), "1h", 168),
}
BINANCE_PAIR = {"SOL": "SOLUSDT", "USDC": "USDCUSDT", "USDT": "USDCUSDT"}

_cache: dict[tuple[str, str], tuple[float, list]] = {}
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=6)
    return _client


def _downsample(rows: list[tuple[int, float]]) -> list[list]:
    if len(rows) <= MAX_POINTS:
        return [[t, p] for t, p in rows]
    size = len(rows) / MAX_POINTS
    out = []
    for i in range(MAX_POINTS):
        chunk = rows[int(i * size): int((i + 1) * size)]
        if chunk:
            out.append([chunk[-1][0], sum(p for _, p in chunk) / len(chunk)])
    return out


def _stock_points(symbol: str, window: timedelta) -> list[list]:
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


async def _binance_points(symbol: str, interval: str, limit: int) -> list[list]:
    pair = BINANCE_PAIR[symbol]
    for base in prices.BINANCE_BASES:
        try:
            resp = await _http().get(
                f"{base}/api/v3/klines", params={"symbol": pair, "interval": interval, "limit": limit}
            )
            resp.raise_for_status()
            out = []
            for k in resp.json():
                close = float(k[4])
                if close > 0:
                    out.append([int(k[0]), 1 / close if symbol == "USDT" else close])
            return out
        except Exception:
            log.warning("chart: klines failed via %s", base, exc_info=True)
    return []


async def get_points(symbol: str, rng: str) -> list[list]:
    """`symbol` must be a known asset (upper-case) and `rng` a key of RANGES."""
    key = (symbol, rng)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]

    window, interval, limit = RANGES[rng]
    try:
        if symbol in BINANCE_PAIR:
            points = await _binance_points(symbol, interval, limit)
        else:
            points = await asyncio.to_thread(_stock_points, symbol, window)
    except Exception:
        log.warning("chart: %s %s failed", symbol, rng, exc_info=True)
        points = hit[1] if hit else []

    if len(_cache) > 200:
        _cache.clear()
    _cache[key] = (time.monotonic(), points)
    return points
