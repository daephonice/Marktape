"""Total-balance backend: SOL + USDT + USDC holdings of the connected wallet,
plus the USD price feed the homepage multiplies them by.

Prices are fetched once per PRICE_TTL and shared by every browser polling
/api/prices, so 2-second client polling never multiplies upstream load.
RPC calls go through SOLANA_RPC_URL server-side — the key never reaches the
browser.
"""
import os
import re
import time
import asyncio
import logging

import httpx

import jupiter

log = logging.getLogger("balances")

SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

MINTS = {
    "SOL": "So11111111111111111111111111111111111111112",
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}
LAMPORTS_PER_SOL = 1_000_000_000

PRICE_TTL = 1.5     # seconds
BALANCE_TTL = 4.0   # seconds, per address
_ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")

_client: httpx.AsyncClient | None = None
_price_cache: dict = {"at": 0.0, "data": None}
_price_lock = asyncio.Lock()
_balance_cache: dict[str, tuple[float, dict]] = {}


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=8)
    return _client


async def get_prices() -> dict | None:
    """{"SOL": usd, "USDT": usd, "USDC": usd}. Falls back to the last good
    snapshot if Jupiter hiccups; None only if we have never had one."""
    if _price_cache["data"] and time.monotonic() - _price_cache["at"] < PRICE_TTL:
        return _price_cache["data"]
    async with _price_lock:
        if _price_cache["data"] and time.monotonic() - _price_cache["at"] < PRICE_TTL:
            return _price_cache["data"]
        raw = await jupiter.get_prices(list(MINTS.values()), _http())
        fresh = {}
        for symbol, mint in MINTS.items():
            entry = raw.get(mint) if isinstance(raw, dict) else None
            usd = entry.get("usdPrice") if isinstance(entry, dict) else None
            if isinstance(usd, (int, float)) and usd > 0:
                fresh[symbol] = float(usd)
        merged = {**(_price_cache["data"] or {}), **fresh}
        if len(merged) == len(MINTS):
            _price_cache.update(at=time.monotonic(), data=merged)
        return _price_cache["data"]


async def _rpc(method: str, params: list):
    resp = await _http().post(
        SOLANA_RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


async def _sol_balance(address: str) -> float:
    result = await _rpc("getBalance", [address, {"commitment": "confirmed"}])
    return result["value"] / LAMPORTS_PER_SOL


async def _token_balance(address: str, mint: str) -> float:
    result = await _rpc(
        "getTokenAccountsByOwner",
        [address, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}],
    )
    total = 0.0
    for acc in result.get("value") or []:
        info = (((acc.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {}
        total += float((info.get("tokenAmount") or {}).get("uiAmountString") or 0)
    return total


async def get_balances(address: str) -> dict:
    """{"SOL": ui_amount, "USDT": ui_amount, "USDC": ui_amount}. Raises
    ValueError on a malformed address."""
    if not _ADDR_RE.match(address):
        raise ValueError("invalid address")
    hit = _balance_cache.get(address)
    if hit and time.monotonic() - hit[0] < BALANCE_TTL:
        return hit[1]
    sol, usdt, usdc = await asyncio.gather(
        _sol_balance(address),
        _token_balance(address, MINTS["USDT"]),
        _token_balance(address, MINTS["USDC"]),
    )
    data = {"SOL": sol, "USDT": usdt, "USDC": usdc}
    if len(_balance_cache) > 500:
        _balance_cache.clear()
    _balance_cache[address] = (time.monotonic(), data)
    return data
