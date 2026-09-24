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
    info = await get_mint_info(mint, client)
    return {"multiplier": info["multiplier"], "decimals": info["decimals"]}


async def get_mint_info(mint: str, client: httpx.AsyncClient | None = None) -> dict:
    """Returns {"multiplier": float, "decimals": int, "transferFeeBps": int}.
    transferFeeBps is 0 unless the mint has a Token-2022 transferFeeConfig
    extension (used to show the "Transfer Fees" warning on the swap panel).
    Same 10-min cache as the multiplier; never raises."""
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

        multiplier = 1.0
        scaled_ui = next((e for e in extensions if e.get("extension") == "scaledUiAmountConfig"), None)
        if scaled_ui:
            state = scaled_ui.get("state") or {}
            now = time.time()
            effective_ts = float(state.get("newMultiplierEffectiveTimestamp", 0) or 0)
            multiplier = (
                float(state.get("newMultiplier", 1) or 1)
                if now >= effective_ts
                else float(state.get("multiplier", 1) or 1)
            ) or 1.0

        transfer_fee_bps = 0
        fee_cfg = next((e for e in extensions if e.get("extension") == "transferFeeConfig"), None)
        if fee_cfg:
            state = fee_cfg.get("state") or {}
            newer = state.get("newerTransferFee") or {}
            older = state.get("olderTransferFee") or {}
            now_epoch = time.time()
            epoch_est = now_epoch / 432000  # ~2 days/epoch, good enough for a UI warning
            active = newer if epoch_est >= float(newer.get("epoch", 0) or 0) else older
            transfer_fee_bps = int(active.get("transferFeeBasisPoints", 0) or 0)

        return {"multiplier": multiplier, "decimals": decimals, "transferFeeBps": transfer_fee_bps}
    except Exception:
        log.warning("multiplier: RPC read failed for mint %s, defaulting to 1", mint, exc_info=True)
        return {"multiplier": 1.0, "decimals": 6, "transferFeeBps": 0}
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
