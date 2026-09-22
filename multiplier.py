"""Token-2022 Scaled UI Amount multiplier, read from Solana RPC.

PreStocks mints rebase via a multiplier on the mint account
(scaledUiAmountConfig extension). Raw Jupiter unit amounts must be
corrected with this multiplier or OPENAI / SPACEX look wildly mispriced.
PreStocks API `tokenPrice` is already a UI price — never multiply that one.

Cached 10 min per mint (spec §5.2), in-process dict cache.
"""
import os
import time
import logging

import httpx

log = logging.getLogger("multiplier")

SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
CACHE_SECONDS = 10 * 60

_cache: dict[str, tuple[float, dict]] = {}  # mint -> (expires_at, {multiplier, decimals})


async def get_mint_multiplier(mint: str, client: httpx.AsyncClient | None = None) -> dict:
    """Returns {"multiplier": float, "decimals": int}. Defaults to
    multiplier=1, decimals=6 on any RPC failure or missing extension —
    never raises, never blocks the board."""
    cached = _cache.get(mint)
    if cached and cached[0] > time.time():
        return cached[1]

    result = await _fetch_multiplier(mint, client)
    _cache[mint] = (time.time() + CACHE_SECONDS, result)
    return result


async def _fetch_multiplier(mint: str, client: httpx.AsyncClient | None = None) -> dict:
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [mint, {"encoding": "jsonParsed"}],
        }
        resp = await client.post(SOLANA_RPC_URL, json=payload)
        resp.raise_for_status()
        data = resp.json()

        value = (data.get("result") or {}).get("value") or {}
        parsed = ((value.get("data") or {}).get("parsed")) or {}
        info = parsed.get("info") or {}
        decimals = int(info.get("decimals", 6))
        extensions = info.get("extensions") or []

        scaled_ui = next((e for e in extensions if e.get("extension") == "scaledUiAmountConfig"), None)
        if not scaled_ui:
            return {"multiplier": 1.0, "decimals": decimals}

        state = scaled_ui.get("state") or {}
        now = time.time()
        effective_ts = float(state.get("newMultiplierEffectiveTimestamp", 0) or 0)
        multiplier = (
            float(state.get("newMultiplier", 1) or 1)
            if now >= effective_ts
            else float(state.get("multiplier", 1) or 1)
        )
        return {"multiplier": multiplier or 1.0, "decimals": decimals}
    except Exception:
        log.warning("multiplier: RPC read failed for mint %s, defaulting to 1", mint, exc_info=True)
        return {"multiplier": 1.0, "decimals": 6}
    finally:
        if owns_client:
            await client.aclose()


def to_raw_amount(ui_amount: float, decimals: int, multiplier: float = 1.0) -> str:
    """UI amount -> raw integer string for Jupiter. For USDC multiplier=1."""
    raw = (ui_amount * (10 ** decimals)) / (multiplier or 1.0)
    return str(int(raw))


def to_ui_amount(raw_amount, decimals: int, multiplier: float = 1.0) -> float:
    raw = float(raw_amount)
    return (raw / (10 ** decimals)) * (multiplier or 1.0)
