import os

from fastapi import APIRouter, Request, HTTPException
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse

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


@router.get("/stocks", response_class=HTMLResponse)
async def stocks_page(request: Request):
    return templates.TemplateResponse(request, "home.html", {"open_panel": "stocks"})


@router.get("/swap", response_class=HTMLResponse)
async def swap_page(request: Request):
    return templates.TemplateResponse(request, "home.html", {"open_panel": "swap"})


@router.get("/lend", response_class=HTMLResponse)
async def lend_page(request: Request):
    return templates.TemplateResponse(request, "home.html", {"open_panel": "lend"})


@router.get("/t/{symbol}", response_class=HTMLResponse)
async def token_page(request: Request, symbol: str):
    asset = prices.get_asset(symbol)
    if asset is None:
        await prices.wait_ready()  # cold start: first PreStocks refresh may not have landed
        asset = prices.get_asset(symbol)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Unknown symbol: {symbol}")
    return templates.TemplateResponse(request, "token.html", {"token": asset})
