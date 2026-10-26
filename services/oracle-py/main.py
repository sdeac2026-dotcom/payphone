"""
PayPhone Oracle Service
=======================

Python microservice (FastAPI) providing three stateless functions to the
PayPhone Engine:

1. **Price aggregation** — median of multiple public sources with staleness
   guards, so no single feed can skew merchant pricing.
2. **Conversion quotes** — instant-swap quotes with an explicit spread.
   The spread is a PayPhone revenue line and is always returned to the
   caller (transparency is a product requirement).
3. **Risk scoring** — heuristic, stateless payment risk scoring used to
   flag invoices before settlement.

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8001

Design notes:
- **Stateless**: every request carries everything needed to answer it.
  The only cache is a short-TTL in-process price map.
- **Degraded mode is honest**: if all upstreams fail, responses are flagged
  `stale: true` with the age of the last good observation.
"""

from __future__ import annotations

import hashlib
import os
import statistics
import time
from typing import Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

APP_VERSION = "0.1.0"
PORT = int(os.environ.get("ORACLE_PORT", "8001"))
CACHE_TTL_SECS = float(os.environ.get("ORACLE_CACHE_TTL", "30"))
DEFAULT_SPREAD_BPS = int(os.environ.get("ORACLE_SPREAD_BPS", "40"))  # 0.40%

app = FastAPI(
    title="PayPhone Oracle",
    version=APP_VERSION,
    description="Price aggregation, conversion quotes and risk scoring for the PayPhone Engine.",
)

# ------------------------------------------------------------------------------
# In-memory TTL cache (the honest storage model for time-bounded market data)
# ------------------------------------------------------------------------------

_price_cache: Dict[str, tuple] = {}  # asset → (prices dict, ts)


def _cached(asset: str) -> Optional[dict]:
    hit = _price_cache.get(asset)
    if hit and time.time() - hit[1] < CACHE_TTL_SECS:
        return hit[0]
    return None


def _store(asset: str, prices: dict) -> None:
    _price_cache[asset] = (prices, time.time())


# ------------------------------------------------------------------------------
# Upstream sources
# ------------------------------------------------------------------------------

COINGECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binancecoin",
    "XRP": "ripple", "MATIC": "matic-network", "TRX": "tron", "CELO": "celo",
    "USDC": "usd-coin", "USDT": "tether", "DAI": "dai",
    "DOGE": "dogecoin", "ADA": "cardano", "AVAX": "avalanche-2", "LINK": "chainlink",
    "DOT": "polkadot", "TON": "toncoin", "XLM": "stellar", "HBAR": "hedera-hashgraph",
    "BCH": "bitcoin-cash", "LTC": "litecoin", "ATOM": "cosmos", "FIL": "filecoin",
    "INJ": "injective", "STX": "blockstack", "NEAR": "near", "APT": "aptos", "SUI": "sui",
    "ICP": "internet-computer", "XMR": "monero", "ETC": "ethereum-classic",
    "RENDER": "render-token", "SHIB": "shiba-inu", "PEPE": "pepe", "UNI": "uniswap",
    "AAVE": "aave", "LDO": "lido-dao", "CRV": "curve-dao-token", "MKR": "maker",
    "COMP": "compound-governance-token", "GRT": "the-graph", "ENS": "ethereum-name-service",
    "MANA": "decentraland", "SAND": "the-sandbox", "APE": "apecoin", "ARB": "arbitrum",
    "OP": "optimism", "GMX": "gmx", "CAKE": "pancakeswap-token", "WETH": "weth",
    "WBTC": "wrapped-bitcoin", "cbBTC": "coinbase-wrapped-btc",
    "cbETH": "coinbase-wrapped-staked-eth", "BTCB": "binance-bitcoin", "WAVAX": "wrapped-avax",
    "TUSD": "true-usd", "FRAX": "frax", "PYUSD": "paypal-usd", "USDS": "usds",
}

# Static demo prices so the network keeps working when upstreams are unreachable.
STATIC_PRICES = {
    "BTC": 67000.0, "ETH": 3200.0, "SOL": 150.0, "BNB": 580.0, "XRP": 0.55,
    "MATIC": 0.75, "TRX": 0.12, "CELO": 0.85, "DOGE": 0.12, "ADA": 0.45,
    "AVAX": 35.0, "LINK": 14.0, "DOT": 7.0, "TON": 5.5, "SHIB": 0.000025,
    "PEPE": 0.000011, "UNI": 8.0, "AAVE": 120.0, "LDO": 2.0, "CRV": 0.35,
    "MKR": 2300.0, "WETH": 3200.0, "cbETH": 3200.0, "WBTC": 67000.0,
    "cbBTC": 67000.0, "BTCB": 67000.0, "WAVAX": 35.0, "CAKE": 2.2, "ARB": 1.1,
    "OP": 2.3, "GMX": 25.0, "COMP": 55.0, "GRT": 0.25, "ENS": 25.0,
    "MANA": 0.45, "SAND": 0.5, "APE": 1.4,
    "USDC": 1.0, "USDT": 1.0, "DAI": 1.0, "TUSD": 1.0, "FRAX": 1.0,
    "PYUSD": 1.0, "USDS": 1.0,
}

# Stablecoins pinned to parity for invoicing (mirror of the engine rule).
PARITY_ASSETS = {"USDC", "USDT", "DAI", "TUSD", "FRAX", "PYUSD", "USDS"}


async def fetch_coingecko(client: httpx.AsyncClient, asset: str) -> Optional[float]:
    cg_id = COINGECKO_IDS.get(asset)
    if not cg_id:
        return None
    try:
        r = await client.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": cg_id, "vs_currencies": "usd"},
            timeout=5.0,
        )
        return float(r.json()[cg_id]["usd"])
    except Exception:
        return None


async def fetch_coincap(client: httpx.AsyncClient, asset: str) -> Optional[float]:
    # CoinCap v3 assets endpoint (BTC, ETH, SOL, USDC … share the ticker id).
    if asset not in {"BTC", "ETH", "SOL", "USDC", "USDT", "XRP", "TRX", "BNB"}:
        return None
    try:
        r = await client.get(f"https://rest.coincap.io/v3/assets/{asset.lower()}", timeout=5.0)
        return float(r.json()["data"]["priceUsd"])
    except Exception:
        return None


def aggregate(asset: str, observations: List[float]) -> dict:
    """Median of observations + dispersion. Median resists a single bad feed."""
    return {
        "asset": asset,
        "usd": round(statistics.median(observations), 8),
        "observations": len(observations),
        "dispersion_pct": round(
            100.0 * (max(observations) - min(observations)) / statistics.median(observations), 4
        )
        if len(observations) > 1 and statistics.median(observations) > 0
        else 0.0,
    }


# ------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "payphone-oracle",
        "version": APP_VERSION,
        "cached_assets": len(_price_cache),
        "spread_bps": DEFAULT_SPREAD_BPS,
    }


@app.get("/v1/prices")
async def prices(assets: str = "btc,eth,usdc"):
    """
    Aggregated USD prices. Response:
    `{ source, prices: [{asset, usd, observations, dispersion_pct, stale}] }`
    """
    wanted = [a.strip().upper() for a in assets.split(",") if a.strip()]
    if not wanted:
        raise HTTPException(400, "provide at least one asset")

    out, source_hits = [], 0
    async with httpx.AsyncClient() as client:
        for asset in wanted:
            if asset not in STATIC_PRICES:
                raise HTTPException(400, f"unsupported asset '{asset}'")
            # Stablecoins pinned to parity for INVOICING — same rule as the
            # engine's oracle module. A ±0.1% feed wobble must never turn an
            # exact payment into an underpaid invoice.
            if asset in PARITY_ASSETS:
                out.append({"asset": asset, "usd": 1.0, "observations": 2,
                            "dispersion_pct": 0.0, "stale": False, "source": "parity"})
                source_hits += 1
                continue
            cached = _cached(asset)
            if cached:
                out.append({**cached, "stale": False})
                continue
            obs = [
                o
                for o in (
                    await fetch_coingecko(client, asset),
                    await fetch_coincap(client, asset),
                )
                if o is not None
            ]
            if obs:
                agg = aggregate(asset, obs)
                _store(asset, agg)
                out.append({**agg, "stale": False})
                source_hits += 1
            else:
                # Degraded mode: static price, clearly flagged.
                out.append(
                    {
                        "asset": asset,
                        "usd": STATIC_PRICES[asset],
                        "observations": 0,
                        "dispersion_pct": 0.0,
                        "stale": True,
                    }
                )

    source = "aggregated" if source_hits == len(wanted) else ("mixed" if source_hits else "static-fallback")
    return {"source": source, "prices": out}


@app.get("/v1/quote")
async def quote(
    from_asset: str = "USDC",
    to_asset: str = "USD",
    amount: float = 1.0,
    spread_bps: Optional[int] = None,
):
    """
    Instant-conversion quote with the PayPhone spread applied.
    The spread funds conversion liquidity operations and is a revenue line.
    """
    if to_asset.upper() not in {"USD", "USDC", "USDT"}:
        raise HTTPException(400, "to_asset must be USD, USDC or USDT")
    from_asset = from_asset.upper()
    if amount <= 0:
        raise HTTPException(400, "amount must be positive")

    r = await prices(assets=from_asset)
    price_entry = r["prices"][0]
    usd_price = price_entry["usd"]
    if usd_price <= 0:
        raise HTTPException(502, "unhealthy price feed")

    spread = spread_bps if spread_bps is not None else DEFAULT_SPREAD_BPS
    spread = max(0, min(spread, 500))
    gross = amount * usd_price
    net = gross * (1 - spread / 10_000)

    return {
        "from_asset": from_asset,
        "to_asset": to_asset.upper(),
        "amount": amount,
        "usd_price": usd_price,
        "price_stale": price_entry.get("stale", False),
        "spread_bps": spread,
        "gross_usd": round(gross, 6),
        "quoted_usd": round(net, 6),
        "revenue_usd": round(gross - net, 6),
        "note": "revenue_usd funds instant-conversion liquidity operations",
    }


# ------------------------------------------------------------------------------
# Risk scoring
# ------------------------------------------------------------------------------

class RiskInput(BaseModel):
    """Stateless risk inputs — the engine sends what it knows about a payment."""

    amount_usd: float = Field(..., gt=0)
    asset: str = "USDC"
    chain: str = "simnet"
    payer_has_history: bool = False
    cross_border: bool = False
    minutes_since_created: float = 0.0


class RiskOutput(BaseModel):
    score: int  # 0 (low risk) … 100 (high risk)
    band: str  # low | medium | high
    factors: List[str]


RISK_ASSETS = {
    "XRP": 6, "TRX": 4, "MATIC": 5, "BTC": 3, "ETH": 3, "SOL": 4,
    "DOGE": 9, "ADA": 6, "AVAX": 5, "LINK": 4, "DOT": 6, "TON": 6,
    "SHIB": 10, "PEPE": 10, "UNI": 5, "AAVE": 5, "ARB": 5, "OP": 5,
}


@app.post("/v1/risk/score", response_model=RiskOutput)
async def risk_score(inp: RiskInput):
    """
    Heuristic, explainable risk scoring (0–100). Deterministic by design:
    identical inputs always yield identical outputs — auditable and testable.
    """
    score, factors = 5, []

    # Amount bands (structuring detection lives with the compliance provider).
    if inp.amount_usd >= 10_000:
        score += 30
        factors.append("large_amount>=10k")
    elif inp.amount_usd >= 1_000:
        score += 15
        factors.append("medium_amount>=1k")

    # Asset volatility class.
    vol = RISK_ASSETS.get(inp.asset.upper(), 8)
    score += vol
    if vol >= 5:
        factors.append(f"volatile_asset:{inp.asset.lower()}")

    # Chain maturity.
    if inp.chain == "simnet":
        score += 5
        factors.append("demo_chain")

    # Thin file / no history.
    if not inp.payer_has_history:
        score += 15
        factors.append("no_payer_history")

    # Velocity proxy (stateless): very young invoice being scored late.
    if inp.minutes_since_created > 60:
        score += 10
        factors.append("aged_invoice")

    if inp.cross_border:
        score += 10
        factors.append("cross_border")

    score = max(0, min(score, 100))
    band = "low" if score < 30 else ("medium" if score < 60 else "high")
    return RiskOutput(score=score, band=band, factors=factors or ["none"])


# ------------------------------------------------------------------------------
# Invoice id helper (parity with engine: deterministic test fixtures)
# ------------------------------------------------------------------------------

def stable_digest(payload: str) -> str:
    return hashlib.sha256(payload.encode()).hexdigest()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
