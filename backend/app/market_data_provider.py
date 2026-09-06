"""
Live market data provider: symbol search + quote lookup.

This is the "real-world ticker" seam. It's deliberately isolated the same
way market_feed.generate_tick() is -- one module, two functions, everything
downstream (the API routes, the frontend) only cares about the shape of the
result, not which vendor produced it. Swapping Finnhub for Polygon/Alpaca/
IEX means editing this file only.

Provider: Finnhub (finnhub.io). Free tier, no credit card, ~60 req/min.
Configure with the MARKET_DATA_API_KEY environment variable.

Graceful degradation, on purpose:
  - No API key configured -> fall back to substring search over the local
    simulated universe rather than failing outright. A watchlist app
    shouldn't go dark just because a search box's key is missing.
  - Provider call fails/times out/rate-limits -> same fallback, logged,
    not raised. Search staying *available but narrower* beats search
    being unavailable.
  - Quote lookup fails for a brand-new symbol -> the caller (main.py)
    surfaces a clear 404 ("no live quote for X"), since there we can't
    make up a market price -- that's a case worth being loud about,
    unlike search.

A short in-memory TTL cache sits in front of both calls so a user typing
a query doesn't fire a fresh outbound request per keystroke, and so
re-adding a recently-quoted symbol doesn't re-hit the vendor.
"""
import os
import time
import requests
from typing import Optional

from .market_feed import UNIVERSE

FINNHUB_BASE = "https://finnhub.io/api/v1"
API_KEY = os.environ.get("MARKET_DATA_API_KEY", "").strip()
REQUEST_TIMEOUT_SECONDS = 3.0
CACHE_TTL_SECONDS = 30

_search_cache: dict[str, tuple[float, list[dict]]] = {}
_quote_cache: dict[str, tuple[float, Optional[dict]]] = {}


def _local_universe_search(query: str, limit: int) -> list[dict]:
    q = query.strip().upper()
    if not q:
        return []
    matches = [
        {"symbol": s, "name": n, "source": "local"}
        for s, n, _ in UNIVERSE
        if q in s or q in n.upper()
    ]
    return matches[:limit]


def search_symbols(query: str, limit: int = 8) -> list[dict]:
    """
    Returns a list of {symbol, name, source} dicts. `source` is "live" if
    it came from the vendor this call, "local" if it fell back to the
    fixed simulated universe -- surfaced so the UI can be honest about
    which mode it's in rather than pretending everything is live.
    """
    query = query.strip()
    if len(query) < 1:
        return []

    cache_key = f"{query.upper()}:{limit}"
    cached = _search_cache.get(cache_key)
    if cached and (time.time() - cached[0]) < CACHE_TTL_SECONDS:
        return cached[1]

    if not API_KEY:
        results = _local_universe_search(query, limit)
        _search_cache[cache_key] = (time.time(), results)
        return results

    try:
        resp = requests.get(
            f"{FINNHUB_BASE}/search",
            params={"q": query, "token": API_KEY},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        data = resp.json()
        results = [
            {"symbol": item["symbol"], "name": item.get("description", item["symbol"]), "source": "live"}
            for item in data.get("result", [])
            if item.get("type") in ("Common Stock", "ETP", "ETF", "")  # skip warrants/bonds/etc noise
        ][:limit]
        # A key configured but returning nothing isn't necessarily wrong (e.g. no matches) --
        # only fall back to local if the call itself failed, not on a legitimately empty result.
    except (requests.RequestException, ValueError, KeyError) as e:
        print(f"[market_data_provider] search failed, falling back to local universe: {e}")
        results = _local_universe_search(query, limit)

    _search_cache[cache_key] = (time.time(), results)
    return results


def fetch_quote(symbol: str) -> Optional[dict]:
    """
    Returns {price, open, high, low, prev_close} for a real-world quote,
    or None if the symbol can't be quoted (unknown ticker, no API key,
    or the provider call failed). Callers treat None as "can't onboard
    this symbol right now" -- unlike search, this isn't a case to paper
    over with a fallback, since a fabricated starting price would be
    silently wrong data feeding directly into the detection engine.
    """
    symbol = symbol.strip().upper()
    cached = _quote_cache.get(symbol)
    if cached and (time.time() - cached[0]) < CACHE_TTL_SECONDS:
        return cached[1]

    if not API_KEY:
        return None

    try:
        resp = requests.get(
            f"{FINNHUB_BASE}/quote",
            params={"symbol": symbol, "token": API_KEY},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        data = resp.json()
        price = data.get("c")
        if not price:  # Finnhub returns all-zero fields for an invalid/unrecognized symbol
            result = None
        else:
            result = {
                "price": float(price),
                "open": float(data.get("o") or price),
                "high": float(data.get("h") or price),
                "low": float(data.get("l") or price),
                "prev_close": float(data.get("pc") or price),
            }
    except (requests.RequestException, ValueError, KeyError) as e:
        print(f"[market_data_provider] quote lookup failed for {symbol}: {e}")
        result = None

    _quote_cache[symbol] = (time.time(), result)
    return result


def is_configured() -> bool:
    return bool(API_KEY)
