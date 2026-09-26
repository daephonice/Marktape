"""Tape quote + PancakeSwap deep link. No paid aggregator."""
import prices
import rwa

PANCAKE = "https://pancakeswap.finance/swap"


def pancake_link(input_addr: str, output_addr: str) -> str:
    inn = "BNB" if (input_addr or "").lower() in (rwa.NATIVE.lower(), rwa.WBNB.lower()) else input_addr
    out = "BNB" if (output_addr or "").lower() in (rwa.NATIVE.lower(), rwa.WBNB.lower()) else output_addr
    return f"{PANCAKE}?chain=bsc&inputCurrency={inn}&outputCurrency={out}"


def _price_of_mint(mint: str):
    mint_l = (mint or "").lower()
    data = prices.get_prices() or {}
    assets = prices.get_assets().get("assets") or {}
    for sym, meta in assets.items():
        if (meta.get("mint") or "").lower() == mint_l:
            px = (data.get("prices") or {}).get(sym)
            return px["price"] if px else None
    if mint_l in (rwa.NATIVE.lower(), rwa.WBNB.lower()):
        px = (data.get("prices") or {}).get("BNB")
        return px["price"] if px else None
    return None


def quote(input_mint: str, output_mint: str, ui_amount: float) -> dict:
    in_px = _price_of_mint(input_mint)
    out_px = _price_of_mint(output_mint)
    out_ui = (ui_amount * in_px / out_px) if in_px and out_px and ui_amount > 0 else None
    return {
        "transaction": None,
        "deepLink": pancake_link(input_mint, output_mint),
        "uiOutAmount": out_ui,
        "uiMinReceived": out_ui * 0.99 if out_ui else None,
        "rate": (out_ui / ui_amount) if out_ui and ui_amount else None,
        "priceImpactPct": None,
        "gasless": False,
        "routes": ["PancakeSwap"],
        "transferFeeBps": 0,
        "provider": "pancake",
        "executionMode": "SWAP",
    }
