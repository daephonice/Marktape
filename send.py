"""Build unsigned BNB / BEP-20 transfers. Wallet broadcasts via eth_sendTransaction."""
from __future__ import annotations

import re
import time
import logging
from decimal import Decimal

import prices

log = logging.getLogger("send")
CHAIN_ID = 56
_ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
TRANSFER_SEL = "0xa9059cbb"
_hits = {}


class SendError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def check_rate(ip: str, kind: str, limit: int = 20, window: float = 60.0):
    key = f"{ip}:{kind}"
    now = time.time()
    bucket = [t for t in _hits.get(key, []) if now - t < window]
    if len(bucket) >= limit:
        raise SendError("Too many requests", 429)
    bucket.append(now)
    _hits[key] = bucket


def _encode_transfer(to: str, amount_wei: int) -> str:
    return TRANSFER_SEL + to.lower().replace("0x", "").rjust(64, "0") + format(amount_wei, "x").rjust(64, "0")


async def build_transfer(from_address, to_address, symbol, amount, send_max=False):
    if not _ADDR_RE.match(from_address or "") or not _ADDR_RE.match(to_address or ""):
        raise SendError("Invalid address")
    asset = prices.get_asset(symbol)
    if not asset:
        raise SendError("Unknown symbol")
    try:
        qty = Decimal(str(amount))
    except Exception:
        raise SendError("Invalid amount")
    if qty <= 0:
        raise SendError("Amount must be positive")
    wei = int(qty * Decimal(10 ** 18))
    if symbol.upper() == "BNB":
        tx = {"from": from_address, "to": to_address, "value": hex(wei), "chainId": hex(CHAIN_ID), "data": "0x"}
    else:
        tx = {"from": from_address, "to": asset["mint"], "value": "0x0", "chainId": hex(CHAIN_ID),
              "data": _encode_transfer(to_address, wei)}
    return {"transaction": tx, "symbol": symbol.upper(), "amount": str(qty), "chainId": CHAIN_ID}


async def submit(signed_transaction=None, signature=None, lastValidBlockHeight=0, payer=None):
    if not signature:
        raise SendError("Missing tx hash", 400)
    return {"status": "pending", "signature": signature, "txHash": signature}
