import os

from fastapi import APIRouter, Request, HTTPException
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse

import prestocks

router = APIRouter()
templates = Jinja2Templates(directory="templates")


def _static_v(rel_path: str) -> str:
    try:
        return str(int(os.path.getmtime(os.path.join("static", rel_path))))
    except OSError:
        return "0"


templates.env.globals["static_v"] = _static_v
templates.env.globals["web_public_url"] = os.getenv("WEB_PUBLIC_URL", "")
templates.env.globals["telegram_public_url"] = os.getenv("TELEGRAM_PUBLIC_URL", "")
templates.env.globals["telegram_bot_username"] = os.getenv("TELEGRAM_BOT_USERNAME", "")
templates.env.globals["format_premium"] = prestocks.format_premium
templates.env.globals["premium_status"] = prestocks.premium_status


def _strip_facts(tokens: list, stats: dict | None = None) -> dict:
    priced = [t for t in tokens if t.get("premium") is not None]
    avg_premium = sum(t["premium"] for t in priced) / len(priced) if priced else None
    stats = stats or {}
    return {
        "count": len(tokens),
        "avg_premium": avg_premium,
        "volume_24h": stats.get("volume24h") or stats.get("volume_24h"),
        "liquidity": stats.get("liquidity"),
        "holders": stats.get("holders"),
    }


@router.get("/", response_class=HTMLResponse)
async def board_page(request: Request):
    snap = prestocks.get_cached_snapshot()
    stats = await prestocks.fetch_prestocks_stats()
    return templates.TemplateResponse(
        request, "board.html", {"snapshot": snap, "strip": _strip_facts(snap.get("tokens", []), stats)}
    )


@router.get("/t/{symbol}", response_class=HTMLResponse)
async def token_page(request: Request, symbol: str):
    snap = prestocks.get_cached_snapshot()
    symbol_u = symbol.upper()
    row = next((t for t in snap.get("tokens", []) if t["symbol"].upper() == symbol_u), None)
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown symbol: {symbol}")
    return templates.TemplateResponse(
        request, "token.html", {"token": row}
    )


@router.get("/share/{symbol}", response_class=HTMLResponse)
async def share_page(request: Request, symbol: str):
    snap = prestocks.get_cached_snapshot()
    symbol_u = symbol.upper()
    row = next((t for t in snap.get("tokens", []) if t["symbol"].upper() == symbol_u), None)
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown symbol: {symbol}")
    return templates.TemplateResponse(
        request, "share.html", {"token": row}
    )
