import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

import prestocks
import multiplier as multiplier_mod
import jupiter
import board as board_mod
import balances
import prices
from database import SessionLocal
from models import PriceSnapshot, NewsItem

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
def api_news(limit: int = 20):
    """Latest homepage news, newest first."""
    limit = max(1, min(limit, 50))
    db = SessionLocal()
    try:
        rows = db.execute(
            select(NewsItem).order_by(NewsItem.published_at.desc()).limit(limit)
        ).scalars().all()
        return {
            "items": [
                {
                    "id": r.id,
                    "symbol": r.symbol.upper(),
                    "body": r.body,
                    "publishedAt": r.published_at.isoformat(),
                }
                for r in rows
            ]
        }
    finally:
        db.close()


@router.get("/sparkline/{symbol}")
async def get_sparkline(symbol: str, limit: int = 48):
    """Last N price_snapshots rows for one symbol, oldest first — enough
    for a lightweight line chart on the board cards. Reads only; the rows
    are written by board.py's refresh loop, no new writes here."""
    symbol_u = symbol.upper()
    db = SessionLocal()
    try:
        rows = db.execute(
            select(PriceSnapshot.token_price, PriceSnapshot.fetched_at)
            .where(PriceSnapshot.symbol == symbol_u)
            .order_by(PriceSnapshot.fetched_at.desc())
            .limit(limit)
        ).all()
    finally:
        db.close()
    rows = list(reversed(rows))
    return {"symbol": symbol_u, "points": [r[0] for r in rows]}


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
