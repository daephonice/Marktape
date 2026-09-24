import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import prestocks
import multiplier as multiplier_mod
import jupiter
import board as board_mod
import balances
import chart
import prices
import send
import news

log = logging.getLogger("routes_api")

router = APIRouter(prefix="/api")


@router.get("/health")
async def health():
    snap = prestocks.get_cached_snapshot()
    return {"ok": True, "fetchedAt": snap.get("fetchedAt")}


@router.get("/board")
async def get_board():
    snap = prestocks.get_cached_snapshot()
    if not snap.get("tokens"):
        # Cold start (first request before the background loop has run once).
        snap = await board_mod.build_snapshot()
    return snap


@router.get("/prices")
async def api_prices():
    """Price + 24h change for every accepted asset, served from the shared
    in-memory cache (refreshed server-side every second)."""
    data = prices.get_prices()
    if not data:
        raise HTTPException(status_code=503, detail="Prices unavailable")
    return data


@router.get("/assets")
async def api_assets():
    """Display metadata (name, logo, kind) for every accepted asset."""
    return prices.get_assets()


@router.get("/balances/{address}")
async def api_balances(address: str):
    """Non-zero holdings (UI amounts) of a wallet across the accepted assets."""
    try:
        return await balances.get_balances(address)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid address")
    except Exception:
        log.warning("balances: lookup failed for %s", address, exc_info=True)
        raise HTTPException(status_code=502, detail="Balance lookup failed")


@router.get("/news")
def api_news():
    """One latest news item per PreStocks token, shared by every user (served
    from memory; refreshed hourly by news.py)."""
    return {"items": news.get_news()}


@router.get("/chart/{symbol}")
async def get_chart(symbol: str, range: str = "1D"):
    """Price history [[epoch_ms, price], ...] for the token-page chart."""
    sym = symbol.upper()
    rng = range.upper()
    if prices.get_asset(sym) is None:
        raise HTTPException(status_code=404, detail="Unknown symbol")
    if rng not in chart.RANGES:
        raise HTTPException(status_code=400, detail="Bad range")
    return {"symbol": sym, "range": rng, "points": await chart.get_points(sym, rng)}


@router.get("/token/{symbol}")
async def get_token(symbol: str):
    snap = prestocks.get_cached_snapshot()
    symbol_u = symbol.upper()
    row = next((t for t in snap.get("tokens", []) if t["symbol"].upper() == symbol_u), None)
    if not row:
        raise HTTPException(status_code=404, detail="Unknown symbol")
    return row


class SwapOrderRequest(BaseModel):
    inputMint: str
    outputMint: str
    uiAmount: float
    taker: str


@router.post("/swap/order")
async def swap_order(body: SwapOrderRequest):
    # Hard rule: never build an order for a blocklisted competitor mint.
    if prestocks.is_blocked_mint(body.inputMint) or prestocks.is_blocked_mint(body.outputMint):
        raise HTTPException(status_code=400, detail="Mint not supported")

    # Figure out decimals/multiplier for whichever side is the PreStock leg.
    if body.inputMint == prestocks.USDC_MINT:
        decimals, mult = prestocks.USDC_DECIMALS, 1.0
    else:
        m = await multiplier_mod.get_mint_multiplier(body.inputMint)
        decimals, mult = m["decimals"], m["multiplier"]

    amount_raw = multiplier_mod.to_raw_amount(body.uiAmount, decimals, mult)

    try:
        order = await jupiter.get_ultra_order(body.inputMint, body.outputMint, amount_raw, body.taker)
    except Exception:
        log.warning("swap_order: ultra order failed", exc_info=True)
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Could not build a route",
                "deepLink": jupiter.jup_deep_link(body.inputMint, body.outputMint),
            },
        )

    if "transaction" not in order:
        order["deepLink"] = jupiter.jup_deep_link(body.inputMint, body.outputMint)

    return order


class SwapExecuteRequest(BaseModel):
    signedTransaction: str
    requestId: str


@router.post("/swap/execute")
async def swap_execute(body: SwapExecuteRequest):
    try:
        result = await jupiter.execute_ultra_order(body.signedTransaction, body.requestId)
    except Exception:
        log.warning("swap_execute: ultra execute failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Execution failed")
    return result


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


class SendBuildRequest(BaseModel):
    fromAddress: str
    toAddress: str
    symbol: str
    amount: str
    sendMax: bool = False


@router.post("/send/build")
async def send_build(body: SendBuildRequest, request: Request):
    """Unsigned transfer (base64) for the connected wallet to sign."""
    try:
        send.check_rate(_ip(request), "build")
        return await send.build_transfer(
            body.fromAddress, body.toAddress, body.symbol, body.amount, body.sendMax
        )
    except send.SendError as e:
        raise HTTPException(status_code=e.status, detail=e.message)
    except Exception:
        log.warning("send_build failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Could not prepare the transfer, try again")


class SendSubmitRequest(BaseModel):
    signedTransaction: str | None = None
    signature: str | None = None
    lastValidBlockHeight: int = 0
    payer: str | None = None


@router.post("/send/submit")
async def send_submit(body: SendSubmitRequest, request: Request):
    """Relay the wallet-signed transfer through our RPC and wait for confirmation."""
    try:
        send.check_rate(_ip(request), "submit")
        return await send.submit(body.signedTransaction, body.signature, body.lastValidBlockHeight, body.payer)
    except send.SendError as e:
        raise HTTPException(status_code=e.status, detail=e.message)
    except Exception:
        log.warning("send_submit failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Could not send the transaction, try again")
