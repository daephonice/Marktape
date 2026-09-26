"""Homepage / board stat strip from the live snapshot. No paid APIs."""
import rwa

def get_stats():
    snap = rwa.get_cached_snapshot()
    tokens = [t for t in (snap.get("tokens") or []) if t.get("tokenPrice")]
    aum = sum((t.get("tokenPrice") or 0) for t in tokens)
    return {
        "aum": aum,
        "volume": None,
        "holders": None,
        "txns": len(tokens),
        "names": len({t.get("underlying") for t in tokens}),
        "at": snap.get("fetchedAt"),
    }


def fmt_compact(v, prefix: str = "") -> str:
    if v is None:
        return "—"
    units = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]
    for div, suffix in units:
        if abs(v) >= div:
            return f"{prefix}{v / div:.2f}{suffix}"
    return f"{prefix}{int(round(v)):,}"
