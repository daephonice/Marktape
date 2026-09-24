"""Send: unsigned transfer builder + signed-transaction relay.

Non-custodial. The server builds a legacy transfer (fee payer = the connected
wallet), the browser wallet only signs, and the server broadcasts through
SOLANA_RPC_URL (Helius: staked connections + priority-fee estimate) and waits
for confirmation. No extra dependencies: base58 / PDA / message serialisation
are implemented here.

Accepted assets: SOL, USDT, USDC and every PreStocks token.
PreStocks mints are Token-2022 scaled-UI-amount mints, so UI amounts are
converted with the live on-chain multiplier (strict read — never defaulted).
"""
import os
import re
import time
import base64
import hashlib
import asyncio
import logging
from decimal import Decimal, Context, localcontext, ROUND_DOWN

import httpx

import prices
import prestocks
import balances

log = logging.getLogger("send")

SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

SYSTEM_PROGRAM = "11111111111111111111111111111111"
COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111"
TOKEN_PROGRAM = balances.TOKEN_PROGRAM_ID
TOKEN_2022_PROGRAM = prestocks.TOKEN_2022_PROGRAM_ID
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

LAMPORTS_PER_SOL = 1_000_000_000
BASE_FEE = 5_000
MIN_NEW_ACCOUNT = 890_880          # rent-exempt minimum of a 0-data account
MIN_PRICE, MAX_PRICE = 10_000, 100_000   # micro-lamports per CU
LIMIT_SOL, LIMIT_TOKEN, LIMIT_TOKEN_NEW_ATA = 30_000, 100_000, 200_000
MAX_TX_BYTES = 1232
CONFIRM_TIMEOUT = 75.0


class SendError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.data = code, message, data


# ---------------------------------------------------------------------------
# base58 / curve / PDA
# ---------------------------------------------------------------------------
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_IDX = {c: i for i, c in enumerate(_B58)}


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + _B58_IDX[c]  # KeyError on a bad char
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out


def _pk(s: str) -> bytes:
    try:
        b = b58decode(s)
    except (KeyError, ValueError):
        raise SendError("Invalid address")
    if len(b) != 32:
        raise SendError("Invalid address")
    return b


_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _on_curve(b: bytes) -> bool:
    """RFC 8032 point decompression: True if the 32 bytes are a valid ed25519 point."""
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    x2 = ((y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)) % _P
    if x2 == 0:
        return True
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _SQRT_M1 % _P
    return (x * x - x2) % _P == 0


def _find_pda(seeds: list[bytes], program: bytes) -> bytes:
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress").digest()
        if not _on_curve(h):
            return h
    raise SendError("Could not derive token account")


def _ata(owner: bytes, mint: bytes, token_program: bytes) -> bytes:
    return _find_pda([owner, token_program, mint], b58decode(ATA_PROGRAM))


# ---------------------------------------------------------------------------
# Legacy message serialisation
# ---------------------------------------------------------------------------
def _cu16(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class _Ix:
    def __init__(self, program: str, accounts: list[tuple[bytes, bool, bool]], data: bytes):
        self.program = b58decode(program)
        self.accounts = accounts  # (pubkey, is_signer, is_writable)
        self.data = data


def _compile(payer: bytes, ixs: list[_Ix], blockhash: bytes) -> bytes:
    order = [payer]
    flags = {payer: [True, True]}

    def touch(k: bytes, signer: bool, writable: bool):
        if k in flags:
            flags[k][0] |= signer
            flags[k][1] |= writable
        else:
            flags[k] = [signer, writable]
            order.append(k)

    for ix in ixs:
        for k, s, w in ix.accounts:
            touch(k, s, w)
        touch(ix.program, False, False)

    sw = [k for k in order if flags[k][0] and flags[k][1]]
    sr = [k for k in order if flags[k][0] and not flags[k][1]]
    nw = [k for k in order if not flags[k][0] and flags[k][1]]
    nr = [k for k in order if not flags[k][0] and not flags[k][1]]
    keys = sw + sr + nw + nr
    idx = {k: i for i, k in enumerate(keys)}

    msg = bytes([len(sw) + len(sr), len(sr), len(nr)]) + _cu16(len(keys)) + b"".join(keys)
    msg += blockhash + _cu16(len(ixs))
    for ix in ixs:
        msg += bytes([idx[ix.program]]) + _cu16(len(ix.accounts)) + bytes(idx[k] for k, _, _ in ix.accounts)
        msg += _cu16(len(ix.data)) + ix.data
    return msg


def _serialize_unsigned(message: bytes) -> bytes:
    return _cu16(1) + bytes(64) + message


def _ix_limit(units: int) -> _Ix:
    return _Ix(COMPUTE_BUDGET_PROGRAM, [], bytes([2]) + units.to_bytes(4, "little"))


def _ix_price(micro_lamports: int) -> _Ix:
    return _Ix(COMPUTE_BUDGET_PROGRAM, [], bytes([3]) + micro_lamports.to_bytes(8, "little"))


def _ix_sol_transfer(frm: bytes, to: bytes, lamports: int) -> _Ix:
    return _Ix(SYSTEM_PROGRAM, [(frm, True, True), (to, False, True)],
               (2).to_bytes(4, "little") + lamports.to_bytes(8, "little"))


def _ix_create_ata(payer: bytes, ata: bytes, owner: bytes, mint: bytes, token_program: bytes) -> _Ix:
    return _Ix(ATA_PROGRAM, [
        (payer, True, True), (ata, False, True), (owner, False, False), (mint, False, False),
        (b58decode(SYSTEM_PROGRAM), False, False), (token_program, False, False),
    ], b"\x01")  # CreateIdempotent


def _ix_transfer_checked(src: bytes, mint: bytes, dest: bytes, authority: bytes, raw: int,
                         decimals: int, token_program: str) -> _Ix:
    return _Ix(token_program, [
        (src, False, True), (mint, False, False), (dest, False, True), (authority, True, False),
    ], bytes([12]) + raw.to_bytes(8, "little") + bytes([decimals]))


# ---------------------------------------------------------------------------
# RPC
# ---------------------------------------------------------------------------
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=10)
    return _client


async def _rpc(method: str, params: list, timeout: float = 10):
    resp = await _http().post(
        SOLANA_RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=timeout
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        e = body["error"]
        raise RpcError(e.get("code"), str(e.get("message")), e.get("data"))
    return body["result"]


async def _sol_balance(addr: bytes) -> int:
    return (await _rpc("getBalance", [b58encode(addr), {"commitment": "confirmed"}]))["value"]


async def _blockhash() -> tuple[bytes, int]:
    v = (await _rpc("getLatestBlockhash", [{"commitment": "confirmed"}]))["value"]
    return b58decode(v["blockhash"]), int(v["lastValidBlockHeight"])


async def _priority_price(account_keys: list[str]) -> int:
    """Helius priority-fee estimate (micro-lamports/CU), clamped. Any other RPC
    just falls back to the floor."""
    try:
        r = await _rpc("getPriorityFeeEstimate",
                       [{"accountKeys": account_keys, "options": {"priorityLevel": "High"}}], timeout=3)
        fee = int(float(r.get("priorityFeeEstimate") or 0))
    except Exception:
        fee = 0
    return max(MIN_PRICE, min(fee, MAX_PRICE))


async def _mint_info(mint: str) -> dict:
    """Strict mint read: {decimals, multiplier, program}. Raises instead of
    defaulting — a wrong multiplier would send the wrong amount."""
    res = await _rpc("getAccountInfo", [mint, {"encoding": "jsonParsed", "commitment": "confirmed"}])
    val = res.get("value")
    info = (((val or {}).get("data") or {}).get("parsed") or {}).get("info")
    if not val or not info:
        raise SendError("Token not available right now", 502)
    mult = Decimal(1)
    for e in info.get("extensions") or []:
        name, st = e.get("extension"), e.get("state") or {}
        if name == "scaledUiAmountConfig":
            eff = float(st.get("newMultiplierEffectiveTimestamp", 0) or 0)
            m = st.get("newMultiplier", 1) if time.time() >= eff else st.get("multiplier", 1)
            mult = Decimal(str(m))
        elif name == "transferHook" and st.get("programId"):
            raise SendError("This token can't be sent from here")
        elif name == "nonTransferable":
            raise SendError("This token can't be transferred")
        elif name == "pausableConfig" and st.get("paused"):
            raise SendError("Transfers for this token are paused")
    if mult <= 0:
        raise SendError("Token not available right now", 502)
    return {"decimals": int(info["decimals"]), "multiplier": mult, "program": val.get("owner")}


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
_RENT_MSG = "Keep at least 0.00089 SOL in your wallet after sending"


def _explain(err, create_idx: int | None = None) -> str:
    if err in ("InsufficientFundsForFee", "AccountNotFound"):
        return "Not enough SOL for network fees"
    if err == "BlockhashNotFound":
        return "Transaction expired, please try again"
    if isinstance(err, dict):
        if "InsufficientFundsForRent" in err:
            return _RENT_MSG
        ie = err.get("InstructionError")
        if isinstance(ie, list) and len(ie) == 2:
            idx, kind = ie
            if create_idx is not None and idx == create_idx:
                return "Not enough SOL to open the recipient's token account (~0.0021 SOL)"
            if isinstance(kind, dict) and kind.get("Custom") == 1:
                return "Insufficient balance"
    return "This transfer would fail"


def _explain_rpc(e: RpcError) -> str:
    data = e.data if isinstance(e.data, dict) else {}
    if data.get("err") is not None:
        return _explain(data["err"])
    if "blockhash" in e.message.lower():
        return "Transaction expired, please try again"
    return "Network rejected the transaction"


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
_AMOUNT_RE = re.compile(r"^\d{1,12}(\.\d{1,18})?$")


def _parse_amount(s: str) -> Decimal:
    s = (s or "").strip()
    if not _AMOUNT_RE.match(s):
        raise SendError("Invalid amount")
    d = Decimal(s)
    if d <= 0:
        raise SendError("Invalid amount")
    return d


def _fmt(d: Decimal) -> str:
    s = format(d, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


async def _simulate(tx: bytes, create_idx: int | None):
    try:
        r = await _rpc("simulateTransaction", [
            base64.b64encode(tx).decode(),
            {"encoding": "base64", "sigVerify": False, "replaceRecentBlockhash": True, "commitment": "confirmed"},
        ])
    except Exception:
        return  # simulation is a pre-check only; the wallet/network still validate
    v = r.get("value") or {}
    if v.get("err") is not None:
        log.warning("send: simulation failed err=%s logs=%s", v["err"], (v.get("logs") or [])[-4:])
        raise SendError(_explain(v["err"], create_idx))


async def build_transfer(from_addr: str, to_addr: str, symbol: str, amount: str, send_max: bool) -> dict:
    frm, to = _pk(from_addr), _pk(to_addr)
    if frm == to:
        raise SendError("You can't send to your own address")
    amt = _parse_amount(amount)
    sym = (symbol or "").upper()

    if sym == "SOL":
        return await _build_sol(frm, to, amt)

    if sym in balances.STABLE_MINTS:
        mint = balances.STABLE_MINTS[sym]
        info = {"decimals": 6, "multiplier": Decimal(1), "program": TOKEN_PROGRAM}
    else:
        mint = next((m for m, s in prices.stock_mints().items() if s == sym), None)
        if not mint or prestocks.is_blocked_mint(mint):
            raise SendError("Unsupported token")
        info = await _mint_info(mint)
    if info["program"] not in (TOKEN_PROGRAM, TOKEN_2022_PROGRAM):
        raise SendError("Unsupported token")
    return await _build_token(frm, to, sym, mint, info, amt, send_max)


async def _build_sol(frm: bytes, to: bytes, amt: Decimal) -> dict:
    with localcontext(Context(prec=60)):
        lamports = int((amt * LAMPORTS_PER_SOL).to_integral_value(ROUND_DOWN))
    if lamports < 1:
        raise SendError("Amount too small")

    (sol_bal, dest_bal, (bh, last_valid), price) = await asyncio.gather(
        _sol_balance(frm), _sol_balance(to), _blockhash(), _priority_price([b58encode(frm), b58encode(to)])
    )
    fee = BASE_FEE + -(-LIMIT_SOL * price // 1_000_000)
    if lamports + fee > sol_bal:
        raise SendError("Not enough SOL for the amount and network fee")
    if dest_bal == 0 and lamports < MIN_NEW_ACCOUNT:
        raise SendError("A new address needs at least 0.00089 SOL")

    ixs = [_ix_limit(LIMIT_SOL), _ix_price(price), _ix_sol_transfer(frm, to, lamports)]
    tx = _serialize_unsigned(_compile(frm, ixs, bh))
    await _simulate(tx, None)
    return {
        "transaction": base64.b64encode(tx).decode(),
        "lastValidBlockHeight": last_valid,
        "symbol": "SOL",
        "amount": _fmt(Decimal(lamports) / LAMPORTS_PER_SOL),
    }


async def _build_token(frm: bytes, to: bytes, sym: str, mint: str, info: dict, amt: Decimal, send_max: bool) -> dict:
    decimals, mult, program = info["decimals"], info["multiplier"], info["program"]
    mint_b, prog_b = _pk(mint), _pk(program)
    dest_ata = _ata(to, mint_b, prog_b)

    src_res, dest_res, sol_bal, (bh, last_valid), price = await asyncio.gather(
        _rpc("getTokenAccountsByOwner",
             [b58encode(frm), {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}]),
        _rpc("getAccountInfo", [b58encode(dest_ata),
                                {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0}, "commitment": "confirmed"}]),
        _sol_balance(frm),
        _blockhash(),
        _priority_price([b58encode(frm), b58encode(to), mint]),
    )

    best = None  # (pubkey, raw_amount)
    for a in src_res.get("value") or []:
        ai = (((a.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {}
        if ai.get("state") == "frozen":
            continue
        raw_amt = int((ai.get("tokenAmount") or {}).get("amount") or 0)
        if best is None or raw_amt > best[1]:
            best = (a["pubkey"], raw_amt)
    if not best or best[1] <= 0:
        raise SendError("Insufficient balance")

    if send_max:
        raw = best[1]
    else:
        with localcontext(Context(prec=60)):
            raw = int((amt * (Decimal(10) ** decimals) / mult).to_integral_value(ROUND_DOWN))
        if raw < 1:
            raise SendError("Amount too small")
        if raw > best[1]:
            raise SendError("Insufficient balance")
    if raw >= 2**64:
        raise SendError("Invalid amount")

    create = dest_res.get("value") is None
    limit = LIMIT_TOKEN_NEW_ATA if create else LIMIT_TOKEN
    fee = BASE_FEE + -(-limit * price // 1_000_000)
    if sol_bal < fee:
        raise SendError("Not enough SOL for network fees")

    ixs = [_ix_limit(limit), _ix_price(price)]
    create_idx = None
    if create:
        create_idx = len(ixs)
        ixs.append(_ix_create_ata(frm, dest_ata, to, mint_b, prog_b))
    ixs.append(_ix_transfer_checked(b58decode(best[0]), mint_b, dest_ata, frm, raw, decimals, program))

    tx = _serialize_unsigned(_compile(frm, ixs, bh))
    await _simulate(tx, create_idx)
    with localcontext(Context(prec=60)):
        sent_ui = Decimal(raw) / (Decimal(10) ** decimals) * mult
        sent_ui = sent_ui.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_DOWN)
    return {
        "transaction": base64.b64encode(tx).decode(),
        "lastValidBlockHeight": last_valid,
        "symbol": sym,
        "amount": _fmt(sent_ui),
    }


# ---------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------
async def submit(signed_tx: str | None, signature: str | None, last_valid: int, payer: str | None) -> dict:
    """Broadcast a wallet-signed tx (or just track one the wallet already sent)
    and wait for `confirmed`. Rebroadcasts until it lands or the blockhash
    expires."""
    raw = None
    if signed_tx:
        try:
            raw = base64.b64decode(signed_tx, validate=True)
        except Exception:
            raise SendError("Invalid transaction")
        if len(raw) > MAX_TX_BYTES or len(raw) < 66 or raw[0] != 1 or raw[1:65] == bytes(64):
            raise SendError("Invalid transaction")
        sig = b58encode(raw[1:65])
        try:
            await _rpc("sendTransaction", [signed_tx, {
                "encoding": "base64", "skipPreflight": False, "preflightCommitment": "confirmed", "maxRetries": 0,
            }])
        except RpcError as e:
            log.warning("send: sendTransaction rejected: %s", e)
            raise SendError(_explain_rpc(e))
    elif signature:
        try:
            ok = len(b58decode(signature)) == 64
        except (KeyError, ValueError):
            ok = False
        if not ok:
            raise SendError("Invalid signature")
        sig = signature
    else:
        raise SendError("Nothing to submit")

    deadline = time.monotonic() + CONFIRM_TIMEOUT
    last_send = last_height = time.monotonic()
    expired = False
    while time.monotonic() < deadline:
        await asyncio.sleep(0.8)
        try:
            st = (await _rpc("getSignatureStatuses", [[sig], {"searchTransactionHistory": False}]))["value"][0]
        except Exception:
            st = None
        if st:
            if st.get("err"):
                raise SendError("Transaction failed on-chain")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                _forget(payer)
                return {"signature": sig, "status": "confirmed"}
        if expired:
            raise SendError("Transaction expired — nothing was sent. Please try again.")
        now = time.monotonic()
        if raw and now - last_send >= 2.0:
            last_send = now
            try:
                await _rpc("sendTransaction", [signed_tx, {"encoding": "base64", "skipPreflight": True, "maxRetries": 0}])
            except Exception:
                pass
        if last_valid and now - last_height >= 3.0:
            last_height = now
            try:
                h = await _rpc("getBlockHeight", [{"commitment": "confirmed"}])
                expired = h > last_valid  # one more status check next loop before giving up
            except Exception:
                pass
    _forget(payer)
    return {"signature": sig, "status": "pending"}


def _forget(address: str | None) -> None:
    if address:
        balances._balance_cache.pop(address, None)


# ---------------------------------------------------------------------------
# Tiny per-IP rate limit (protects the RPC key from being used as a relay)
# ---------------------------------------------------------------------------
_hits: dict[str, list[float]] = {}


def check_rate(ip: str, bucket: str, limit: int = 20, window: float = 60.0) -> None:
    now = time.monotonic()
    key = f"{bucket}:{ip}"
    recent = [t for t in _hits.get(key, []) if now - t < window]
    if len(recent) >= limit:
        raise SendError("Too many requests, slow down", 429)
    recent.append(now)
    _hits[key] = recent
    if len(_hits) > 5000:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] >= window]:
            _hits.pop(k, None)
