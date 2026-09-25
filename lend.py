"""Mock isolated lend book for PreStocks.

Paper market: deposit a PreStock, borrow USDC or SOL, keep the name.
No Jupiter/Kamino vaults exist for these mints. Positions live in Postgres.
Oracle is PreStocks tokenPrice via the shared prices cache.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import select

import prestocks
import prices
from database import SessionLocal
from models import LendPosition, utcnow

log = logging.getLogger("lend")

DEBT_SYMBOLS = ("USDC", "SOL")
STALE_SECONDS = 300
BASE_APY = 0.02
KINK = 0.80
SLOPE_PRE = 0.04
SLOPE_POST = 0.44
LIQ_BONUS = 0.05

# USDC debt is PreLendd's book. SOL debt is tighter because SOL moves more.
PARAMS = {
    "USDC": {"ltv": 0.45, "lt": 0.55},
    "SOL": {"ltv": 0.40, "lt": 0.50},
}

_ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def valid_wallet(address: str) -> bool:
    return bool(address and _ADDR_RE.match(address))


def _seed_liq(col: str, debt: str) -> float:
    """Stable fake liquidity so every vault is borrowable in the demo."""
    h = int(hashlib.sha256(f"{col}:{debt}".encode()).hexdigest()[:8], 16)
    if debt == "USDC":
        return 80_000 + (h % 220_000)
    return 400 + (h % 1600)


def _stock_symbols() -> list[str]:
    assets = prices.get_assets().get("assets") or {}
    return sorted(sym for sym, meta in assets.items() if meta.get("kind") == "stock")


def _price(symbol: str) -> float | None:
    data = prices.get_prices()
    if not data:
        return None
    row = data["prices"].get(symbol.upper())
    if not row:
        return None
    p = row.get("price")
    return float(p) if isinstance(p, (int, float)) and p > 0 else None


def _oracle_age() -> float | None:
    data = prices.get_prices()
    if not data or not data.get("updatedAt"):
        snap = prestocks.get_cached_snapshot()
        ts = snap.get("fetchedAt")
        if not ts:
            return None
        try:
            fetched = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
        return (_now() - fetched).total_seconds()
    try:
        fetched = datetime.fromisoformat(data["updatedAt"].replace("Z", "+00:00"))
    except ValueError:
        return None
    return (_now() - fetched).total_seconds()


def _borrow_apy(util: float) -> float:
    util = max(0.0, min(util, 0.99))
    if util <= KINK:
        return BASE_APY + (util / KINK) * SLOPE_PRE
    return BASE_APY + SLOPE_PRE + ((util - KINK) / (1 - KINK)) * SLOPE_POST


def _health_label(ratio: float, lt: float, debt_usd: float) -> str:
    if debt_usd <= 0:
        return "Safe"
    if lt <= 0:
        return "Very Risky"
    frac = ratio / lt
    if frac < 0.60:
        return "Safe"
    if frac < 0.85:
        return "Risky"
    return "Very Risky"


def _vault_params(col: str, debt: str) -> dict:
    debt = debt.upper()
    col = col.upper()
    p = PARAMS[debt]
    seed = _seed_liq(col, debt)
    return {
        "id": f"{col}-{debt}",
        "collateralSymbol": col,
        "debtSymbol": debt,
        "ltv": p["ltv"],
        "liquidationThreshold": p["lt"],
        "liquidationBonus": LIQ_BONUS,
        "seedLiquidity": seed,
    }


def _totals(db, col: str, debt: str) -> tuple[float, float]:
    rows = db.execute(
        select(LendPosition).where(
            LendPosition.collateral_symbol == col,
            LendPosition.debt_symbol == debt,
            LendPosition.status == "open",
        )
    ).scalars().all()
    supplied = sum(r.col_amount or 0 for r in rows)
    borrowed = sum(r.debt_amount or 0 for r in rows)
    return supplied, borrowed


def _accrue(pos: LendPosition, apy: float, now: datetime) -> None:
    last = _aware(pos.last_accrued_at) or now
    dt_years = max(0.0, (now - last).total_seconds()) / (365.25 * 24 * 3600)
    if dt_years > 0 and pos.debt_amount > 0 and apy > 0:
        pos.debt_amount *= 1 + apy * dt_years
        pos.debt_index = (pos.debt_index or 1) * (1 + apy * dt_years)
    pos.last_accrued_at = now


def _snapshot_pos(pos: LendPosition, vault: dict, col_px: float, debt_px: float) -> dict:
    col = pos.col_amount or 0
    debt = pos.debt_amount or 0
    col_usd = col * col_px
    debt_usd = debt * debt_px
    ratio = (debt_usd / col_usd) if col_usd > 0 else (999 if debt_usd > 0 else 0)
    lt = vault["liquidationThreshold"]
    ltv = vault["ltv"]
    max_borrow_usd = max(0.0, col_usd * ltv - debt_usd)
    liq_price = (debt_usd / (col * lt)) if col > 0 and lt > 0 and debt_usd > 0 else None
    status = pos.status
    if debt_usd > 0 and ratio >= lt:
        status = "liquidatable"
    elif col <= 1e-12 and debt <= 1e-12:
        status = "closed"
    return {
        "id": pos.id,
        "wallet": pos.wallet,
        "collateralSymbol": pos.collateral_symbol,
        "debtSymbol": pos.debt_symbol,
        "colAmount": col,
        "debtAmount": debt,
        "colUsd": col_usd,
        "debtUsd": debt_usd,
        "ratio": ratio,
        "ltv": ltv,
        "liquidationThreshold": lt,
        "maxBorrowUsd": max_borrow_usd,
        "liquidationPrice": liq_price,
        "health": _health_label(ratio, lt, debt_usd),
        "status": status,
        "updatedAt": (_aware(pos.updated_at) or _now()).isoformat(),
    }


def list_vaults() -> list[dict]:
    data = prices.get_prices()
    px = (data or {}).get("prices") or {}
    assets = (prices.get_assets() or {}).get("assets") or {}
    db = SessionLocal()
    try:
        out = []
        for col in _stock_symbols():
            meta = assets.get(col) or {}
            col_px = float((px.get(col) or {}).get("price") or 0)
            for debt in DEBT_SYMBOLS:
                v = _vault_params(col, debt)
                supplied, borrowed = _totals(db, col, debt)
                debt_px = float((px.get(debt) or {}).get("price") or 0)
                liq = max(0.0, v["seedLiquidity"] - borrowed)
                util = borrowed / v["seedLiquidity"] if v["seedLiquidity"] else 0
                apy = _borrow_apy(util)
                supply_apy = apy * util * 0.85
                out.append({
                    **v,
                    "name": meta.get("name") or col,
                    "image": meta.get("image"),
                    "mint": meta.get("mint"),
                    "collateralPrice": col_px or None,
                    "debtPrice": debt_px or None,
                    "mark": (px.get(col) or {}).get("mark"),
                    "premium": (px.get(col) or {}).get("premium"),
                    "totalSupplied": supplied,
                    "totalBorrowed": borrowed,
                    "liquidity": liq,
                    "utilization": util,
                    "borrowApy": apy,
                    "supplyApy": supply_apy,
                })
        return out
    finally:
        db.close()


def get_vault(col: str, debt: str) -> dict | None:
    col, debt = col.upper(), debt.upper()
    if debt not in DEBT_SYMBOLS:
        return None
    if col not in _stock_symbols() and prices.get_asset(col) is None:
        return None
    for v in list_vaults():
        if v["collateralSymbol"] == col and v["debtSymbol"] == debt:
            return v
    # Cold start: still return config even if prices aren't in the list yet.
    if prices.get_asset(col) and prices.get_asset(col).get("kind") == "stock":
        v = _vault_params(col, debt)
        meta = prices.get_asset(col) or {}
        return {
            **v,
            "name": meta.get("name") or col,
            "image": meta.get("image"),
            "mint": meta.get("mint"),
            "collateralPrice": _price(col),
            "debtPrice": _price(debt),
            "mark": None,
            "premium": None,
            "totalSupplied": 0,
            "totalBorrowed": 0,
            "liquidity": v["seedLiquidity"],
            "utilization": 0,
            "borrowApy": BASE_APY,
            "supplyApy": 0,
        }
    return None


def overlay_holdings(wallet: str, holdings: dict[str, float]) -> None:
    """Subtract locked collateral, add outstanding debt. Mutates holdings."""
    if not wallet:
        return
    db = SessionLocal()
    try:
        rows = db.execute(
            select(LendPosition).where(
                LendPosition.wallet == wallet,
                LendPosition.status != "closed",
            )
        ).scalars().all()
        px = ((prices.get_prices() or {}).get("prices") or {})
        now = _now()
        for pos in rows:
            vault = _vault_params(pos.collateral_symbol, pos.debt_symbol)
            borrowed = _totals(db, pos.collateral_symbol, pos.debt_symbol)[1]
            seed = vault["seedLiquidity"]
            apy = _borrow_apy(borrowed / seed if seed else 0)
            _accrue(pos, apy, now)
            col = pos.col_amount or 0
            debt = pos.debt_amount or 0
            if col > 0:
                holdings[pos.collateral_symbol] = max(0.0, (holdings.get(pos.collateral_symbol) or 0) - col)
            if debt > 0:
                holdings[pos.debt_symbol] = (holdings.get(pos.debt_symbol) or 0) + debt
        db.commit()
    except Exception:
        db.rollback()
        log.warning("lend overlay failed for %s", wallet, exc_info=True)
    finally:
        db.close()


def list_positions(wallet: str) -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.execute(
            select(LendPosition).where(
                LendPosition.wallet == wallet,
                LendPosition.status != "closed",
            )
        ).scalars().all()
        out = []
        now = _now()
        for pos in rows:
            vault = _vault_params(pos.collateral_symbol, pos.debt_symbol)
            borrowed = _totals(db, pos.collateral_symbol, pos.debt_symbol)[1]
            apy = _borrow_apy(borrowed / vault["seedLiquidity"] if vault["seedLiquidity"] else 0)
            _accrue(pos, apy, now)
            col_px = _price(pos.collateral_symbol) or 0
            debt_px = _price(pos.debt_symbol) or 0
            snap = _snapshot_pos(pos, vault, col_px, debt_px)
            snap["borrowApy"] = apy
            out.append(snap)
        db.commit()
        return out
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def quote(col_sym: str, debt_sym: str, col_delta: float, debt_delta: float, wallet: str | None) -> dict:
    vault = get_vault(col_sym, debt_sym)
    if not vault:
        raise ValueError("Unknown vault")
    col_px = vault.get("collateralPrice") or _price(col_sym)
    debt_px = vault.get("debtPrice") or _price(debt_sym)
    if not col_px or not debt_px:
        raise ValueError("Price unavailable")
    col_amt = 0.0
    debt_amt = 0.0
    if wallet and valid_wallet(wallet):
        for p in list_positions(wallet):
            if p["collateralSymbol"] == col_sym.upper() and p["debtSymbol"] == debt_sym.upper():
                col_amt = p["colAmount"]
                debt_amt = p["debtAmount"]
                break
    col_amt = max(0.0, col_amt + col_delta)
    debt_amt = max(0.0, debt_amt + debt_delta)
    fake = LendPosition(
        wallet=wallet or "",
        collateral_symbol=col_sym.upper(),
        debt_symbol=debt_sym.upper(),
        col_amount=col_amt,
        debt_amount=debt_amt,
        status="open",
    )
    snap = _snapshot_pos(fake, vault, col_px, debt_px)
    snap.pop("id", None)
    snap.pop("wallet", None)
    ok = True
    reason = None
    if debt_delta > 0 and snap["ratio"] > vault["ltv"] + 1e-9:
        ok = False
        reason = "Exceeds max LTV"
    if col_delta < 0 and debt_amt > 0 and snap["ratio"] > vault["ltv"] + 1e-9:
        ok = False
        reason = "Withdraw would exceed max LTV"
    if debt_delta > 0 and debt_delta > (vault.get("liquidity") or 0) + 1e-9:
        ok = False
        reason = "Not enough liquidity"
    snap["ok"] = ok
    snap["reason"] = reason
    snap["borrowApy"] = vault.get("borrowApy")
    return snap


def _get_or_create(db, wallet: str, col: str, debt: str) -> LendPosition:
    pos = db.execute(
        select(LendPosition).where(
            LendPosition.wallet == wallet,
            LendPosition.collateral_symbol == col,
            LendPosition.debt_symbol == debt,
        )
    ).scalars().first()
    if pos:
        return pos
    pos = LendPosition(
        wallet=wallet,
        collateral_symbol=col,
        debt_symbol=debt,
        col_amount=0,
        debt_amount=0,
        debt_index=1,
        status="open",
    )
    db.add(pos)
    db.flush()
    return pos


def operate(wallet: str, col_sym: str, debt_sym: str, col_delta: float, debt_delta: float) -> dict:
    if not valid_wallet(wallet):
        raise ValueError("Invalid wallet")
    col_sym, debt_sym = col_sym.upper(), debt_sym.upper()
    if debt_sym not in DEBT_SYMBOLS:
        raise ValueError("Debt must be USDC or SOL")
    if prestocks.is_blocked_mint((prices.get_asset(col_sym) or {}).get("mint") or ""):
        raise ValueError("Mint not supported")
    asset = prices.get_asset(col_sym)
    if asset is None or asset.get("kind") != "stock":
        raise ValueError("Unknown collateral")
    if col_delta == 0 and debt_delta == 0:
        raise ValueError("Nothing to do")

    age = _oracle_age()
    if age is None:
        raise RuntimeError("Price unavailable")
    if age > STALE_SECONDS:
        raise RuntimeError("Price stale")

    vault = get_vault(col_sym, debt_sym)
    if not vault:
        raise ValueError("Unknown vault")
    col_px = vault.get("collateralPrice") or _price(col_sym)
    debt_px = vault.get("debtPrice") or _price(debt_sym)
    if not col_px or not debt_px:
        raise RuntimeError("Price unavailable")

    db = SessionLocal()
    try:
        pos = _get_or_create(db, wallet, col_sym, debt_sym)
        borrowed = _totals(db, col_sym, debt_sym)[1]
        apy = _borrow_apy(borrowed / vault["seedLiquidity"] if vault["seedLiquidity"] else 0)
        now = utcnow()
        _accrue(pos, apy, now)

        if pos.col_amount + col_delta < -1e-9:
            raise ValueError("Not enough collateral in vault")
        if pos.debt_amount + debt_delta < -1e-9:
            raise ValueError("Repay exceeds debt")
        if debt_delta > 0 and debt_delta > (vault.get("liquidity") or 0) + 1e-9:
            raise ValueError("Not enough liquidity")

        pos.col_amount = max(0.0, pos.col_amount + col_delta)
        pos.debt_amount = max(0.0, pos.debt_amount + debt_delta)

        snap = _snapshot_pos(pos, vault, col_px, debt_px)
        if debt_delta > 0 and snap["ratio"] > vault["ltv"] + 1e-9:
            raise ValueError("Exceeds max LTV")
        if col_delta < 0 and pos.debt_amount > 0 and snap["ratio"] > vault["ltv"] + 1e-9:
            raise ValueError("Withdraw would exceed max LTV")

        if pos.col_amount <= 1e-12 and pos.debt_amount <= 1e-12:
            pos.col_amount = 0
            pos.debt_amount = 0
            pos.status = "closed"
        else:
            pos.status = "liquidatable" if snap["status"] == "liquidatable" else "open"
        pos.updated_at = now
        db.commit()
        db.refresh(pos)
        snap = _snapshot_pos(pos, vault, col_px, debt_px)
        snap["borrowApy"] = apy
        receipt = f"demo_{pos.id}_{int(now.timestamp())}"
        try:
            import balances as balances_mod
            balances_mod.invalidate(wallet)
        except Exception:
            pass
        return {"ok": True, "demo": True, "position": snap, "receipt": {"id": receipt, "label": "Demo tx"}}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def liquidate(wallet: str, col_sym: str, debt_sym: str) -> dict:
    col_sym, debt_sym = col_sym.upper(), debt_sym.upper()
    vault = get_vault(col_sym, debt_sym)
    if not vault:
        raise ValueError("Unknown vault")
    col_px = vault.get("collateralPrice") or _price(col_sym)
    debt_px = vault.get("debtPrice") or _price(debt_sym)
    if not col_px or not debt_px:
        raise RuntimeError("Price unavailable")

    db = SessionLocal()
    try:
        pos = db.execute(
            select(LendPosition).where(
                LendPosition.wallet == wallet,
                LendPosition.collateral_symbol == col_sym,
                LendPosition.debt_symbol == debt_sym,
                LendPosition.status != "closed",
            )
        ).scalars().first()
        if not pos:
            raise ValueError("No position")
        borrowed = _totals(db, col_sym, debt_sym)[1]
        apy = _borrow_apy(borrowed / vault["seedLiquidity"] if vault["seedLiquidity"] else 0)
        now = utcnow()
        _accrue(pos, apy, now)
        snap = _snapshot_pos(pos, vault, col_px, debt_px)
        if snap["ratio"] < vault["liquidationThreshold"]:
            raise ValueError("Position is healthy")
        repay_usd = min(snap["debtUsd"] * 0.5, snap["debtUsd"])
        seize_usd = repay_usd * (1 + LIQ_BONUS)
        repay_amt = repay_usd / debt_px
        seize_amt = seize_usd / col_px
        pos.debt_amount = max(0.0, pos.debt_amount - repay_amt)
        pos.col_amount = max(0.0, pos.col_amount - seize_amt)
        if pos.col_amount <= 1e-12:
            pos.col_amount = 0
            pos.debt_amount = 0
            pos.status = "closed"
        else:
            pos.status = "open"
        pos.updated_at = now
        db.commit()
        db.refresh(pos)
        out = _snapshot_pos(pos, vault, col_px, debt_px)
        try:
            import balances as balances_mod
            balances_mod.invalidate(wallet)
        except Exception:
            pass
        return {
            "ok": True,
            "demo": True,
            "position": out,
            "seizedCol": seize_amt,
            "repaidDebt": repay_amt,
            "receipt": {"id": f"demo_liq_{pos.id}_{int(now.timestamp())}", "label": "Demo tx"},
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def list_liquidatable() -> list[dict]:
    return [p for w in _open_wallets() for p in list_positions(w) if p["status"] == "liquidatable"]


def _open_wallets() -> list[str]:
    db = SessionLocal()
    try:
        rows = db.execute(
            select(LendPosition.wallet).where(LendPosition.status != "closed").distinct()
        ).scalars().all()
        return list(rows)
    finally:
        db.close()
