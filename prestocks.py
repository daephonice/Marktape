"""PreStocks API: fetch + normalize + premium math + in-memory snapshot cache.

Hard rule (spec §1.1): the official API at PRESTOCKS_API_URL is the entire
universe. Any mint in MINT_BLOCKLIST is a competitor pre-IPO token
(Tessera / xStocks / Backpack / Ondo) and must never be rendered or swapped,
even if it somehow appeared in an API response.
"""
import os
import logging
from datetime import datetime, timezone

import httpx

log = logging.getLogger("prestocks")

PRESTOCKS_API_URL = os.getenv("PRESTOCKS_API_URL", "https://prestocks.com/api/prestocks")
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DECIMALS = 6
TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

# Never render / never swap — see spec §6-7.
MINT_BLOCKLIST = {
    "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",  # xStocks SPACEX
    "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",  # Backpack SPCX
    "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ",  # Tessera OpenAI
    "wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo",  # Ondo
    "TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v",  # Tessera SPX
}


def is_blocked_mint(mint: str) -> bool:
    return mint in MINT_BLOCKLIST


def premium(token_price, mark_price):
    """premium = tokenPrice / markPrice - 1. None if markPrice is falsy."""
    if not mark_price:
        return None
    return token_price / mark_price - 1


def format_premium(p) -> str:
    if p is None:
        return "—"
    pct = p * 100
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct:.1f}%"


def premium_status(p) -> str:
    if p is None:
        return "flat"
    if p > 0:
        return "rich"
    if p < 0:
        return "cheap"
    return "flat"


async def fetch_prestocks(client: httpx.AsyncClient | None = None) -> list[dict]:
    """GET the PreStocks API. Response is a bare JSON array. Filters out
    records missing required fields and any blocklisted competitor mint.
    Raises on transport/HTTP failure — caller decides fallback behavior."""
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        resp = await client.get(PRESTOCKS_API_URL, headers={"Accept": "application/json"})
        resp.raise_for_status()
        data = resp.json()
    finally:
        if owns_client:
            await client.aclose()

    if not isinstance(data, list):
        raise ValueError("PreStocks API did not return a JSON array")

    out = []
    for r in data:
        if not isinstance(r, dict):
            continue
        mint = r.get("contract_address")
        symbol = r.get("symbol")
        token_price = r.get("tokenPrice")
        mark_price = r.get("markPrice")
        if not isinstance(mint, str) or not mint:
            continue
        if not isinstance(symbol, str) or not symbol:
            continue
        if not isinstance(token_price, (int, float)):
            continue
        if not isinstance(mark_price, (int, float)):
            continue
        if is_blocked_mint(mint):
            log.warning("prestocks: dropped blocklisted mint %s (%s)", mint, symbol)
            continue
        out.append(r)
    return out


async def fetch_prestocks_stats(client: httpx.AsyncClient | None = None) -> dict | None:
    """Optional /api/stats endpoint. Best-effort — returns None on any
    failure so callers never block the board on this."""
    base = PRESTOCKS_API_URL.rstrip("/")
    if base.endswith("/prestocks"):
        stats_url = base[: -len("/prestocks")] + "/stats"
    else:
        stats_url = base + "/stats"

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=8)
    try:
        resp = await client.get(stats_url, headers={"Accept": "application/json"})
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None
    finally:
        if owns_client:
            await client.aclose()


def normalize_row(record: dict, multiplier: float = 1.0) -> dict:
    """Map a raw PreStocks record -> TokenRow shape used by templates/API."""
    token_price = record.get("tokenPrice")
    mark_price = record.get("markPrice")
    return {
        "symbol": record.get("symbol"),
        "name": record.get("name"),
        "description": record.get("description"),
        "image": record.get("image"),
        "externalUrl": record.get("external_url"),
        "mint": record.get("contract_address"),
        "tokenPrice": token_price,
        "markPrice": mark_price,
        "premium": premium(token_price, mark_price),
        "impliedValuation": record.get("impliedValuation"),
        "markValuation": record.get("markValuation"),
        "supply": record.get("supply"),
        "multiplier": multiplier,
    }


# ---------------------------------------------------------------------------
# In-memory last-good snapshot cache (spec §3 data flow step 6).
# Simple module-level dict guarded by an asyncio lock in board.py's refresher.
# ---------------------------------------------------------------------------
_snapshot_cache: dict = {"fetchedAt": None, "tokens": []}


def get_cached_snapshot() -> dict:
    return _snapshot_cache


def set_cached_snapshot(tokens: list[dict]) -> dict:
    global _snapshot_cache
    _snapshot_cache = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "tokens": tokens,
    }
    return _snapshot_cache
