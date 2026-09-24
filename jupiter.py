"""Jupiter swap stack + Price v3.

No custody: the server builds/relays the order, the browser wallet signs.
JUPITER_API_KEY stays server-side (never shipped to the browser).

Two independent swap providers, tried in order, so a single provider outage
or a route gap for an exotic PreStocks Token-2022 mint doesn't take swaps
down entirely:
  1. Ultra   (/ultra/v1/order + /ultra/v1/execute)  - gasless, simplest
  2. Metis   (/swap/v1/quote + /swap/v1/swap)       - legacy routing engine,
     often has routes Ultra doesn't for newer/thin-liquidity Token-2022 mints

Each attempt is logged with the provider name + failure reason so a bad
route or a dead provider is visible in the logs, not just "swap failed".
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
METIS_QUOTE_URL = "https://api.jup.ag/swap/v1/quote"
METIS_SWAP_URL = "https://api.jup.ag/swap/v1/swap"

PROVIDERS = ("ultra", "metis")


def _headers() -> dict:
    return {"x-api-key": JUPITER_API_KEY} if JUPITER_API_KEY else {}


def _err_body(exc: Exception) -> str:
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            return resp.text[:300]
        except Exception:
            pass
    return str(exc)[:300]


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


async def _ultra_order(input_mint, output_mint, amount_raw, taker, client) -> dict:
    resp = await client.get(
        ULTRA_ORDER_URL,
        params={"inputMint": input_mint, "outputMint": output_mint, "amount": amount_raw, "taker": taker},
        headers=_headers(),
    )
    resp.raise_for_status()
    order = resp.json()
    if "transaction" not in order:
        raise ValueError(f"no route: {order.get('errorMessage') or order}")
    order["_provider"] = "ultra"
    return order


async def _metis_order(input_mint, output_mint, amount_raw, taker, client) -> dict:
    q = await client.get(
        METIS_QUOTE_URL,
        params={"inputMint": input_mint, "outputMint": output_mint, "amount": amount_raw, "slippageBps": 100},
        headers=_headers(),
    )
    q.raise_for_status()
    quote = q.json()
    if not quote.get("routePlan"):
        raise ValueError(f"no route: {quote.get('error') or quote}")
    s = await client.post(
        METIS_SWAP_URL,
        json={"quoteResponse": quote, "userPublicKey": taker, "wrapAndUnwrapSol": True},
        headers=_headers(),
    )
    s.raise_for_status()
    swap = s.json()
    if not swap.get("swapTransaction"):
        raise ValueError(f"swap build failed: {swap.get('error') or swap}")
    return {
        "_provider": "metis",
        "transaction": swap["swapTransaction"],
        "requestId": None,
        "outAmount": quote.get("outAmount"),
        "otherAmountThreshold": quote.get("otherAmountThreshold"),
        "priceImpactPct": quote.get("priceImpactPct"),
        "routePlan": quote.get("routePlan"),
        "gasless": False,
        "feeBps": 0,
    }


async def get_order(
    input_mint: str,
    output_mint: str,
    amount_raw: str,
    taker: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """Tries each provider in PROVIDERS order; returns the first working
    order. Raises the last error if every provider fails. Each failed
    attempt is logged with the provider name + reason."""
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=15)
    last_exc = None
    try:
        for name, fn in (("ultra", _ultra_order), ("metis", _metis_order)):
            try:
                return await fn(input_mint, output_mint, amount_raw, taker, client)
            except Exception as exc:
                last_exc = exc
                log.warning(
                    "jupiter: %s order failed (%s -> %s): %s",
                    name, input_mint, output_mint, _err_body(exc),
                )
        raise last_exc
    finally:
        if owns_client:
            await client.aclose()


async def execute_order(
    order: dict,
    signed_transaction: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """Relays the signed tx via whichever provider built the order. Ultra
    has its own /execute relay; Metis-built orders are broadcast directly
    over RPC since Metis has no execute endpoint of its own."""
    provider = order.get("_provider", "ultra")
    if provider == "metis":
        return await _submit_raw_transaction(signed_transaction, client)
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20)
    try:
        resp = await client.post(
            ULTRA_EXECUTE_URL,
            json={"signedTransaction": signed_transaction, "requestId": order.get("requestId")},
            headers=_headers(),
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.warning("jupiter: ultra execute failed: %s", _err_body(exc))
        raise
    finally:
        if owns_client:
            await client.aclose()


async def _submit_raw_transaction(signed_transaction: str, client: httpx.AsyncClient | None = None) -> dict:
    rpc_url = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=20)
    try:
        resp = await client.post(
            rpc_url,
            json={
                "jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
                "params": [signed_transaction, {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if "error" in data:
            raise ValueError(str(data["error"])[:300])
        return {"status": "Success", "signature": data.get("result")}
    except Exception as exc:
        log.warning("jupiter: metis raw broadcast failed: %s", _err_body(exc))
        raise
    finally:
        if owns_client:
            await client.aclose()


def jup_deep_link(input_mint: str, output_mint: str) -> str:
    """Fallback deep link — used only if every provider returns no route,
    wallet won't connect, or the user wants Jupiter's own UI."""
    return f"https://jup.ag/swap/{input_mint}-{output_mint}"
