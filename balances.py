"""BSC native + BEP-20 balances. Public RPC, no key."""
from __future__ import annotations

import os
import re
import time
import logging

import httpx

import prices
import rwa

log = logging.getLogger("balances")
BSC_RPC_URL = os.getenv("BSC_RPC_URL", "https://bsc-dataseed.binance.org")
BALANCE_TTL = 6.0
_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
BALANCE_OF = "0x70a08231"
_client = None
_balance_cache = {}


def invalidate(address=None):
    if address:
        _balance_cache.pop(address.lower(), None)
    else:
        _balance_cache.clear()


def valid_address(address: str) -> bool:
    return bool(_ADDR_RE.match(address or ""))


def _http():
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=10)
    return _client


async def _rpc(method, params):
    resp = await _http().post(BSC_RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def _pad(addr: str) -> str:
    return addr.lower().replace("0x", "").rjust(64, "0")


async def get_balances(address: str) -> dict:
    if not valid_address(address):
        raise ValueError("Invalid address")
    key = address.lower()
    cached = _balance_cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]

    raw = await _rpc("eth_getBalance", [address, "latest"])
    holdings = {"BNB": int(raw, 16) / 1e18}
    assets = prices.get_assets().get("assets") or {}
    for sym, meta in assets.items():
        mint = meta.get("mint") or ""
        if not mint or mint.lower() == rwa.NATIVE.lower() or sym == "BNB":
            continue
        try:
            res = await _rpc("eth_call", [{"to": mint, "data": BALANCE_OF + _pad(address)}, "latest"])
            if res and res != "0x":
                amt = int(res, 16) / 1e18
                if amt > 0:
                    holdings[sym] = amt
        except Exception:
            log.info("balances: %s failed", sym, exc_info=True)
    try:
        import lend as lend_mod
        lend_mod.overlay_holdings(address, holdings)
    except Exception:
        log.warning("balances: lend overlay failed", exc_info=True)
    out = {"address": address, "holdings": holdings}
    for sym in ("BNB", "USDT", "USDC"):
        out[sym] = holdings.get(sym, 0.0)
    _balance_cache[key] = (time.time() + BALANCE_TTL, out)
    return out
