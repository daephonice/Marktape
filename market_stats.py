"""Homepage stat strip — the same four numbers PreStocks shows on /products.

  AUM     = sum(supply * tokenPrice)          board snapshot (always fresh)
  Volume  = sum of latest cumulative volume   prestocks.com/api/stats  -> volume[-1]
  Holders = sum of per-token holder counts    prestocks.com/api/metrics
  Txns    = sum of per-token tx counts        prestocks.com/api/metrics

Best-effort: every upstream failure keeps the last good value and never
blocks the board.
"""
import re
import time
import asyncio
import logging

import httpx

import prestocks

log = logging.getLogger("market_stats")

_state: dict = {"volume": None, "holders": None, "txns": None, "at": 0.0}

_HOLDER_KEYS = {
    "holders", "holdercount", "holderscount", "totalholders", "uniqueholders", "numholders",
}
_TXN_KEYS = {
    "txns", "txn", "txs", "txcount", "txncount", "transactions", "transactioncount",
    "transactionscount", "totaltxns", "totaltransactions", "numtransactions", "tradecount", "trades",
}
_TOTAL_CONTAINERS = ("totals", "total", "summary", "global", "overall")


def _api_base() -> str:
    base = prestocks.PRESTOCKS_API_URL.rstrip("/")
    return base[: -len("/prestocks")] if base.endswith("/prestocks") else base


def _norm(key) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _pick(node: dict, keys: set):
    for k, v in node.items():
        if _norm(k) in keys and _num(v) is not None:
            return float(v)
    return None


def _extract(data, keys: set):
    """Aggregate for `keys`: a top-level/total field if present, else the sum
    across per-token rows (list, or dict keyed by symbol)."""
    rows = data
    if isinstance(data, dict):
        containers = [data] + [data[k] for k in _TOTAL_CONTAINERS if isinstance(data.get(k), dict)]
        for node in containers:
            v = _pick(node, keys)
            if v is not None:
                return v
        rows = data.get("tokens") or data.get("data") or data.get("metrics") or list(data.values())
    if isinstance(rows, dict):
        rows = list(rows.values())
    if not isinstance(rows, list):
        return None
    vals = [_pick(r, keys) for r in rows if isinstance(r, dict)]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None


async def _fetch_volume(client: httpx.AsyncClient):
    try:
        resp = await client.get(f"{_api_base()}/stats")
        resp.raise_for_status()
        rows = resp.json().get("volume") or []
        latest = max((r for r in rows if isinstance(r, dict)), key=lambda r: r.get("date", ""), default=None)
        if not latest:
            return None
        # Series are cumulative per symbol, so the newest row summed across symbols is lifetime volume.
        total = sum(v for k, v in latest.items() if k != "date" and _num(v) is not None)
        return total or None
    except Exception:
        log.warning("market_stats: volume fetch failed", exc_info=True)
        return None


async def _fetch_metrics(client: httpx.AsyncClient):
    try:
        resp = await client.get(f"{_api_base()}/metrics")
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        log.warning("market_stats: metrics fetch failed", exc_info=True)
        return None, None
    holders = _extract(data, _HOLDER_KEYS)
    txns = _extract(data, _TXN_KEYS)
    if holders is None and txns is None:
        shape = list(data)[:20] if isinstance(data, dict) else type(data).__name__
        log.warning("market_stats: /metrics returned no holder/txn keys we recognise: %s", shape)
    return holders, txns


async def refresh() -> None:
    async with httpx.AsyncClient(timeout=8, headers={"Accept": "application/json"}) as client:
        volume, (holders, txns) = await asyncio.gather(_fetch_volume(client), _fetch_metrics(client))
    for key, val in (("volume", volume), ("holders", holders), ("txns", txns)):
        if val is not None:
            _state[key] = val
    _state["at"] = time.time()


def attempted() -> bool:
    """True once at least one refresh has run (successful or not)."""
    return _state["at"] > 0


def get_stats(tokens: list) -> dict:
    aum = sum(
        t["supply"] * t["tokenPrice"]
        for t in tokens
        if isinstance(t.get("supply"), (int, float)) and isinstance(t.get("tokenPrice"), (int, float))
    )
    return {
        "aum": aum or None,
        "volume": _state["volume"],
        "holders": _state["holders"],
        "txns": _state["txns"],
    }


def fmt_compact(v, prefix: str = "") -> str:
    """20810000 -> '$20.81M', 110510 -> '110.51K'."""
    if v is None:
        return "—"
    v = float(v)
    for div, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(v) >= div:
            return f"{prefix}{v / div:,.2f}{suffix}"
    return f"{prefix}{v:,.0f}"
