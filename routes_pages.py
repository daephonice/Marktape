import os

from fastapi import APIRouter, Request, HTTPException
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse

import prestocks
import market_stats

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
templates.env.globals["fmt_compact"] = market_stats.fmt_compact


@router.get("/", response_class=HTMLResponse)
async def board_page(request: Request):
    snap = prestocks.get_cached_snapshot()
    if not market_stats.attempted():
        await market_stats.refresh()
    return templates.TemplateResponse(
        request, "board.html", {"snapshot": snap, "stats": market_stats.get_stats(snap.get("tokens", []))}
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
