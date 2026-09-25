"""Wallet holdings: what the connected wallet holds out of the 11 assets the
site accepts — SOL, USDT, USDC and every PreStocks token.

Amounts are UI amounts. PreStocks mints are Token-2022 scaled-UI-amount mints,
so their raw balance is corrected with the on-chain multiplier. Valuation
happens in the browser against the shared price cache (/api/prices).

RPC calls go through SOLANA_RPC_URL server-side — the key never reaches the
browser. Three calls per lookup, cached per address for BALANCE_TTL seconds.
"""
import os
import re
import time
import asyncio
import logging

import httpx

import prices
import prestocks
import multiplier as multiplier_mod

log = logging.getLogger("balances")

SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
STABLE_MINTS = {
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}
LAMPORTS_PER_SOL = 1_000_000_000

BALANCE_TTL = 4.0   # seconds, per address
_ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")

_client: httpx.AsyncClient | None = None
_balance_cache: dict[str, tuple[float, dict]] = {}


def invalidate(address: str | None = None) -> None:
    if address:
        _balance_cache.pop(address, None)
    else:
        _balance_cache.clear()


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=8)
    return _client


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


async def _token_accounts(address: str, program_id: str) -> dict[str, tuple[int, int]]:
    """{mint: (raw_amount, decimals)} summed over every token account the
    wallet owns under one token program."""
    result = await _rpc(
        "getTokenAccountsByOwner",
        [address, {"programId": program_id}, {"encoding": "jsonParsed", "commitment": "confirmed"}],
    )
    totals: dict[str, tuple[int, int]] = {}
    for acc in result.get("value") or []:
        info = (((acc.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {}
        mint = info.get("mint")
        amount = info.get("tokenAmount") or {}
        raw = int(amount.get("amount") or 0)
        if mint and raw > 0:
            totals[mint] = (totals.get(mint, (0, 0))[0] + raw, int(amount.get("decimals") or 0))
    return totals


async def _stock_ui_amount(mint: str, raw: int, decimals: int) -> float:
    m = await multiplier_mod.get_mint_multiplier(mint)
    return multiplier_mod.to_ui_amount(raw, decimals, m["multiplier"])


async def get_balances(address: str) -> dict:
    """{"holdings": {SYMBOL: ui_amount}} — non-zero holdings only. Raises
    ValueError on a malformed address."""
    if not _ADDR_RE.match(address):
        raise ValueError("invalid address")
    hit = _balance_cache.get(address)
    if hit and time.monotonic() - hit[0] < BALANCE_TTL:
        return hit[1]

    sol, classic, token22 = await asyncio.gather(
        _sol_balance(address),
        _token_accounts(address, TOKEN_PROGRAM_ID),
        _token_accounts(address, prestocks.TOKEN_2022_PROGRAM_ID),
    )
    accounts = {**classic, **token22}

    holdings: dict[str, float] = {}
    if sol > 0:
        holdings["SOL"] = sol
    for symbol, mint in STABLE_MINTS.items():
        if mint in accounts:
            raw, decimals = accounts[mint]
            holdings[symbol] = raw / (10 ** decimals)

    held_stocks = [(mint, symbol) for mint, symbol in prices.stock_mints().items() if mint in accounts]
    amounts = await asyncio.gather(*(_stock_ui_amount(mint, *accounts[mint]) for mint, _ in held_stocks))
    for (_, symbol), amount in zip(held_stocks, amounts):
        if amount > 0:
            holdings[symbol] = amount

    try:
        import lend as lend_mod
        lend_mod.overlay_holdings(address, holdings)
    except Exception:
        log.warning("balances: lend overlay failed for %s", address, exc_info=True)

    data = {"holdings": holdings}
    if len(_balance_cache) > 500:
        _balance_cache.clear()
    _balance_cache[address] = (time.monotonic(), data)
    return data
