#!/usr/bin/env python3
"""Invoice-creation matrix test — "the merchant just types an asset".

Creates invoices for assets across ALL chains with NO chain/network fields
(auto-routing through the asset catalog), then verifies:
  - routing (chain/network) matches the catalog default
  - token_address resolves to the registry-verified contract
  - rate-locked quantity is positive and precision-correct (BTC 8dp, SOL 9dp…)
  - fee math (growth tier = 70bps) and revenue split stay intact
  - status polling observes the real chain (pending, zero delta)
  - negative paths: quote-only asset, wrong-chain asset, bad addresses, tamper

Usage: python3 scripts/invoice_matrix_test.py
"""
import hashlib, hmac, json, time, urllib.request

BASE = "http://127.0.0.1:8080"
socket_timeout = 45
import socket
socket.setdefaulttimeout(socket_timeout)

def req(method, path, body=None, headers=None):
    raw = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, raw, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=socket_timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def signed(method, path, body, sk, pk):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    digest = hashlib.sha256(raw).hexdigest()
    sig = hmac.new(sk.encode(), f"{ts}.{method}.{path}.{digest}".encode(), hashlib.sha256).hexdigest()
    return req(method, path, body, {
        "X-PayPhone-Key": pk,
        "X-PayPhone-Timestamp": ts,
        "X-PayPhone-Signature": sig,
    })

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name:52s} {detail[:90]}")

# ---- merchant keys -----------------------------------------------------------
st, r = req("POST", "/v1/keys", {"tier": "growth"})
pk, sk = r["data"]["public_key"], r["data"]["secret_key"]
check("keys issued (growth tier)", st == 201 and sk.startswith("sk_"))

# ---- the matrix: asset-only invoice creation (auto-routing) -------------------
# (asset, expected chain, expected network, wallet, decimals-dp of asset_amount)
BTC_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
SOL_ADDR = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"
TRX_ADDR = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi"
EVM_ADDR = "0x000000000000000000000000000000000000dEaD"  # burn addr — safe, real shape

MATRIX = [
    ("BTC",   "bitcoin", "mainnet", BTC_ADDR, 8),
    ("ETH",   "evm",     "base",    EVM_ADDR, 18),
    ("SOL",   "solana",  "mainnet", SOL_ADDR, 9),
    ("BNB",   "evm",     "bsc",     EVM_ADDR, 18),
    ("TRX",   "tron",    "mainnet", TRX_ADDR, 6),
    ("AVAX",  "evm",     "avalanche", EVM_ADDR, 18),
    ("POL",   "evm",     "polygon", EVM_ADDR, 18),
    ("USDT",  "evm",     "base",    EVM_ADDR, 6),
    ("DAI",   "evm",     "base",    EVM_ADDR, 18),
    ("LINK",  "evm",     "ethereum", EVM_ADDR, 18),
    ("UNI",   "evm",     "ethereum", EVM_ADDR, 18),
    ("AAVE",  "evm",     "ethereum", EVM_ADDR, 18),
    ("SHIB",  "evm",     "ethereum", EVM_ADDR, 18),
    ("WBTC",  "evm",     "ethereum", EVM_ADDR, 8),
    ("PYUSD", "evm",     "ethereum", EVM_ADDR, 6),
    ("PEPE",  "evm",     "bsc",     EVM_ADDR, 18),
    ("CAKE",  "evm",     "bsc",     EVM_ADDR, 18),
    ("ARB",   "evm",     "arbitrum", EVM_ADDR, 18),
    ("OP",    "evm",     "optimism", EVM_ADDR, 18),
    ("GMX",   "evm",     "arbitrum", EVM_ADDR, 18),
]

AMOUNT = 1999  # $19.99
for asset, want_chain, want_net, wallet, dp in MATRIX:
    st, r = signed("POST", "/v1/invoices", {
        "amount_usd_cents": AMOUNT, "asset": asset, "wallet": wallet,
    }, sk, pk)
    if st != 201:
        check(f"invoice {asset}", False, f"HTTP {st}: {r.get('error', {}).get('message', r)}")
        continue
    d = r["data"]
    inv = d["invoice"]
    ok = (
        inv["chain"] == want_chain and inv["network"] == want_net
        and inv["asset"] == asset and int(inv["qte"]) > 0
        and d["fee"]["fee_total_minor"] == 13          # floor(1999*0.007)
        and d["fee"]["split"]["protocol_minor"] == 7   # 7/3/3 revenue engine
        and inv["exp"] > inv["iat"]
        and d["payment_url"].startswith("http")
    )
    frac = d["asset_amount"].split(".")[-1]
    ok = ok and len(frac) == dp  # precision matches the chain's decimals
    check(f"invoice {asset:5s} → {want_chain}/{want_net}", ok,
          f"qty={d['asset_amount']} fee={d['fee']['fee_total_minor']}c split={d['fee']['split']['protocol_minor']}/{d['fee']['split']['referrer_minor']}/{d['fee']['split']['operations_minor']}")

# ---- explicit chain pinning (multi-chain assets) -------------------------------
st, r = signed("POST", "/v1/invoices", {
    "amount_usd_cents": AMOUNT, "asset": "USDC", "chain": "solana", "wallet": SOL_ADDR,
}, sk, pk)
ok = st == 201 and r["data"]["invoice"]["chain"] == "solana" and \
     r["data"]["invoice"]["token_address"] == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
check("USDC pinned to solana → SPL mint", ok, str(st))

# TronGrid's free tier throttles per-minute; the matrix has just burst ~25
# chain calls. One cool-down retry keeps the test about OUR logic, not their
# rate limiter (production overrides TRON_API_BASE for volume).
for attempt in range(2):
    st, r = signed("POST", "/v1/invoices", {
        "amount_usd_cents": AMOUNT, "asset": "USDT", "chain": "tron", "wallet": TRX_ADDR,
    }, sk, pk)
    if st == 201:
        break
    if attempt == 0:
        print("      (TronGrid free-tier throttle — cooling down 20s)")
        time.sleep(20)
ok = st == 201 and r["data"]["invoice"]["chain"] == "tron" and \
     r["data"]["invoice"]["token_address"] == "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
check("USDT pinned to tron → TRC-20 contract", ok, str(st))

st, r = signed("POST", "/v1/invoices", {
    "amount_usd_cents": AMOUNT, "asset": "USDC", "chain": "evm", "network": "bsc", "wallet": EVM_ADDR,
}, sk, pk)
ok = st == 201 and r["data"]["invoice"]["network"] == "bsc" and \
     r["data"]["invoice"]["token_address"].lower() == "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"
check("USDC pinned to bsc → 18dp contract", ok, str(st))

# ---- status polling observes the real chain -----------------------------------
st, r = signed("POST", "/v1/invoices", {
    "amount_usd_cents": AMOUNT, "asset": "BTC", "wallet": BTC_ADDR,
}, sk, pk)
tok = r["data"]["token"]
inv_id = r["data"]["invoice"]["id"]
st, r = req("GET", f"/v1/invoices/{inv_id}?token={tok}")
ok = st == 200 and r["data"]["invoice"]["status"] in ("pending", "underpaid") and \
     int(r["data"]["invoice"]["observed_qty"]) >= 0
check("BTC invoice status polls live chain", ok, f"status={r.get('data',{}).get('invoice',{}).get('status')}" if st == 200 else str(st))

# ---- negative paths (fail-closed) ---------------------------------------------
st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "XRP", "wallet": EVM_ADDR}, sk, pk)
ok = st == 400 and "not yet settleable" in r["error"]["message"]
check("XRP (quote-only) rejected with guidance", ok, r.get("error", {}).get("message", "")[:70])

st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "SOL", "wallet": BTC_ADDR}, sk, pk)
ok = st == 400
check("BTC address rejected for solana invoice", ok, r.get("error", {}).get("message", "")[:70])

st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "BTC", "wallet": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"}, sk, pk)
ok = st == 400 and "not a valid bitcoin address" in r["error"]["message"]
check("typo'd BTC address rejected (checksum)", ok, r.get("error", {}).get("message", "")[:70])

st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "TRX", "wallet": "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSj"}, sk, pk)
ok = st == 400
check("typo'd TRON address rejected (checksum)", ok, r.get("error", {}).get("message", "")[:70])

st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "BTC", "chain": "evm", "wallet": EVM_ADDR}, sk, pk)
ok = st == 400
check("BTC on evm rejected (not an ERC-20)", ok, r.get("error", {}).get("message", "")[:70])

# tampered signature still 401
st, r = signed("POST", "/v1/invoices", {"amount_usd_cents": AMOUNT, "asset": "USDC", "wallet": EVM_ADDR}, sk, pk)
tampered = r["data"]["token"][:-6] + "XXXXXX"
st2, _ = req("GET", f"/v1/invoices/{r['data']['invoice']['id']}?token={tampered}")
check("tampered invoice token → 401", st2 == 401, f"HTTP {st2}")

# ---- summary -------------------------------------------------------------------
print("\n" + "=" * 78)
ok_n = sum(1 for _, o in results if o)
print(f"{ok_n}/{len(results)} checks passed")
raise SystemExit(0 if ok_n == len(results) else 1)
