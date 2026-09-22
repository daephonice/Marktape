"""Jupiter Ultra swap stack + Price v3.

No custody: the server builds/relays the order, the browser wallet signs.
JUPITER_API_KEY stays server-side (never shipped to the browser). Ultra is
the only swap path — no deprecated quote-api v6, no Swap v1.
"""
import os
import logging

import httpx

log = logging.getLogger("jupiter")

JUPITER_API_KEY = os.getenv("JUPITER_API_KEY", "")

LITE_PRICE_URL = "https://lite-api.jup.ag/price/v3"
PRO_PRICE_URL = "https://api.jup.ag/price/v3"
ULTRA_ORDER_URL = "https://api.jup.ag/ultra/v1/order"
ULTRA_EXECUTE_URL = "https://api.jup.ag/ultra/v1/execute"


def _headers() -> dict:
    return {"x-api-key": JUPITER_API_KEY} if JUPITER_API_KEY else {}


async def get_prices(mint_ids: list[str], client: httpx.AsyncClient | None = None) -> dict:
    """Board prices via Price v3. Tries lite-api first, falls back to the
    keyed api.jup.ag path if lite is throttled. Returns {} on failure —
    caller should not block the board on this."""
    if not mint_ids:
        return {}
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=10)
    ids_param = ",".join(mint_ids)
    try:
        try:
            resp = await client.get(LITE_PRICE_URL, params={"ids": ids_param})
            resp.raise_for_status()
            return resp.json()
        except Exception:
            resp = await client.get(PRO_PRICE_URL, params={"ids": ids_param}, headers=_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception:
        log.warning("jupiter: price v3 fetch failed", exc_info=True)
        return {}
    finally:
        if owns_client:
            await client.aclose()


async def get_ultra_order(
    input_mint: str,
    output_mint: str,
    amount_raw: str,
    taker: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """GET /ultra/v1/order. Called server-side so JUPITER_API_KEY never
    reaches the browser. Returns the raw Ultra response (includes base64
    unsigned `transaction`, or is missing it if no route could be built)."""
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        resp = await client.get(
            ULTRA_ORDER_URL,
            params={
                "inputMint": input_mint,
                "outputMint": output_mint,
                "amount": amount_raw,
                "taker": taker,
            },
            headers=_headers(),
        )
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns_client:
            await client.aclose()


async def execute_ultra_order(
    signed_transaction: str,
    request_id: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """POST /ultra/v1/execute with the browser-signed transaction."""
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20)
    try:
        resp = await client.post(
            ULTRA_EXECUTE_URL,
            json={"signedTransaction": signed_transaction, "requestId": request_id},
            headers=_headers(),
        )
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns_client:
            await client.aclose()


def jup_deep_link(input_mint: str, output_mint: str) -> str:
    """Fallback deep link — used only if Ultra returns no route, wallet
    won't connect, or the user wants Jupiter's own UI."""
    return f"https://jup.ag/swap/{input_mint}-{output_mint}"
