import os

from fastapi import APIRouter, Request, HTTPException
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse

import prices

router = APIRouter()
templates = Jinja2Templates(directory="templates")


def _static_v(rel_path: str) -> str:
    try:
        return str(int(os.path.getmtime(os.path.join("static", rel_path))))
    except OSError:
        return "0"


templates.env.globals["static_v"] = _static_v


@router.get("/", response_class=HTMLResponse)
async def home_page(request: Request):
    return templates.TemplateResponse(request, "home.html", {})


@router.get("/stocks")
async def stocks_page():
    return RedirectResponse(url="/", status_code=302)


@router.get("/swap", response_class=HTMLResponse)
async def swap_page(request: Request):
    return templates.TemplateResponse(request, "swap.html", {})


@router.get("/lend", response_class=HTMLResponse)
async def lend_page(request: Request):
    return templates.TemplateResponse(request, "lend.html", {"lend_symbol": None})


@router.get("/lend/{symbol}", response_class=HTMLResponse)
async def lend_vault_page(request: Request, symbol: str):
    asset = prices.get_asset(symbol)
    if asset is None:
        await prices.wait_ready()
        asset = prices.get_asset(symbol)
    if asset is None or asset.get("kind") != "stock":
        raise HTTPException(status_code=404, detail=f"Unknown symbol: {symbol}")
    return templates.TemplateResponse(request, "lend.html", {"lend_symbol": asset["symbol"]})


@router.get("/t/{symbol}", response_class=HTMLResponse)
async def token_page(request: Request, symbol: str):
    asset = prices.get_asset(symbol)
    if asset is None:
        await prices.wait_ready()  # cold start: first PreStocks refresh may not have landed
        asset = prices.get_asset(symbol)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Unknown symbol: {symbol}")
    return templates.TemplateResponse(request, "token.html", {"token": asset})
