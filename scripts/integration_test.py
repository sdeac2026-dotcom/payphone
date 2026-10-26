#!/usr/bin/env python3
"""
PayPhone end-to-end integration test.

Drives the complete payment lifecycle against a running engine:
  1. Issue merchant keys (free tier)
  2. Sign a request (HMAC-SHA256, same protocol SDKs implement)
  3. Create a stateless invoice on SimNet
  4. Verify the invoice token round-trip (tamper detection)
  5. Simulate a wallet payment
  6. Poll status until `paid`, check fee breakdown + receipts
  7. Phone identity: register → resolve → escrow → claim
  8. Fee schedule transparency endpoint
"""

import hashlib
import hmac
import json
import os
import time
import urllib.request

ENGINE = os.environ.get("ENGINE_URL", "http://127.0.0.1:8080")
PASS, FAIL = "✓", "✗"
results = []


def req(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(ENGINE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def check(name, cond, detail=""):
    results.append((name, cond))
    print(f"{PASS if cond else FAIL} {name}{' — ' + detail if detail and not cond else ''}")
    return cond


# ── 1. health ────────────────────────────────────────────────────────────────
st, health = req("GET", "/v1/health")
check("engine health", st == 200 and health["data"]["status"] == "ok")

# ── 2. issue merchant keys ───────────────────────────────────────────────────
st, keys = req("POST", "/v1/keys", {"tier": "growth"})
check("issue keys", st in (200, 201) and keys["data"]["public_key"].startswith("pk_growth_"))
pk, sk = keys["data"]["public_key"], keys["data"]["secret_key"]

# ── 3. signed invoice creation ───────────────────────────────────────────────
def signed_headers(method, path, raw_body: bytes):
    ts = str(int(time.time()))
    body_hash = hashlib.sha256(raw_body).hexdigest()
    canonical = f"{ts}.{method}.{path}.{body_hash}"
    sig = hmac.new(sk.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {"X-PayPhone-Key": pk, "X-PayPhone-Timestamp": ts, "X-PayPhone-Signature": sig}


body = {
    "amount_usd_cents": 2500,
    "asset": "USDC",
    "chain": "simnet",
    "network": "simnet",
    "wallet": "PP" + "a" * 40,
    "description": "Order #1001 — Pro plan",
}
raw = json.dumps(body).encode()
st, inv = req("POST", "/v1/invoices", body, signed_headers("POST", "/v1/invoices", raw))
d = inv.get("data", {})
check("create invoice (signed)", st in (200, 201) and d["invoice"]["id"].startswith("inv_"),
      json.dumps(inv)[:300])
check("fee math (70bps on $25)", d.get("fee", {}).get("fee_total_minor") == 17, str(d.get("fee")))
check("asset amount quoted", float(d.get("asset_amount", "0")) > 0, d.get("asset_amount"))
token, inv_id = d["token"], d["invoice"]["id"]
check("payment url carries token", f"/#/pay/{inv_id}?t=" in d.get("payment_url", ""))

# ── 4. token tamper detection ────────────────────────────────────────────────
payload, sig = token.split(".")
flipped = ("A" if payload[len(payload)//2] != "A" else "B").join(
    [payload[:len(payload)//2], payload[len(payload)//2+1:]])
st, bad = req("GET", f"/v1/invoices/{inv_id}?token={flipped}.{sig}")
check("tampered token rejected", st == 401, f"status {st}")

# ── 5. poll pending ──────────────────────────────────────────────────────────
st, s0 = req("GET", f"/v1/invoices/{inv_id}?token={token}")
check("invoice pending", s0["data"]["invoice"]["status"] == "pending", json.dumps(s0)[:200])

# ── 6. simulate payment & poll paid ──────────────────────────────────────────
addr = d["invoice"]["address"]
locked_qty = int(d["invoice"]["qte"])  # pay the exact rate-locked quantity
st, pay = req("POST", "/v1/simnet/pay", {"to": addr, "asset": "USDC", "amount_minor": locked_qty,
                                         "invoice_id": inv_id, "from": "integration-test"})
check("simnet payment accepted", st in (200, 201) and pay["data"]["tx"]["height"] >= 1, json.dumps(pay)[:200])

st, s1 = req("GET", f"/v1/invoices/{inv_id}?token={token}")
check("invoice paid", s1["data"]["invoice"]["status"] == "paid", json.dumps(s1["data"]["invoice"])[:200])
check("receipt recorded on chain", len(s1["data"]["receipts"]) >= 1)

# ── 7. phone identity: register → resolve → escrow → claim ───────────────────
raw = json.dumps({"phone": "+1 555 010 4321", "wallet": "PP" + "b" * 40}).encode()
st, reg = req("POST", "/v1/identity/register", {"phone": "+1 555 010 4321", "wallet": "PP" + "b" * 40},
              signed_headers("POST", "/v1/identity/register", raw))
check("register phone→wallet", st in (200, 201) and reg["data"]["tx"]["height"] >= 1, json.dumps(reg)[:200])

raw = json.dumps({"phone": "+1 555 010 4321"}).encode()
st, res = req("POST", "/v1/identity/resolve", {"phone": "+1 555 010 4321"},
              signed_headers("POST", "/v1/identity/resolve", raw))
check("resolve phone", st == 200 and res["data"]["registered"] is True and
      res["data"]["wallet"] == "PP" + "b" * 40, json.dumps(res)[:200])
check("phone masked in response", "555 010 4321" not in json.dumps(res))

raw = json.dumps({"phone": "+1 555 010 9999", "amount_usd_cents": 1500}).encode()
st, esc = req("POST", "/v1/identity/escrow", {"phone": "+1 555 010 9999", "amount_usd_cents": 1500},
              signed_headers("POST", "/v1/identity/escrow", raw))
check("escrow for unregistered phone", st in (200, 201) and esc["data"]["escrow_id"].startswith("esc_"),
      json.dumps(esc)[:300])
escrow_id, code = esc["data"]["escrow_id"], esc["data"]["claim_code"]

# register a wallet for the recipient, then claim
raw = json.dumps({"phone": "+15550109999", "wallet": "PP" + "c" * 40}).encode()
req("POST", "/v1/identity/register", {"phone": "+15550109999", "wallet": "PP" + "c" * 40},
    signed_headers("POST", "/v1/identity/register", raw))
st, claim = req("POST", "/v1/identity/claim",
                {"escrow_id": escrow_id, "phone": "+15550109999", "code": code})
check("claim releases to wallet", st == 200 and claim["data"]["released_amount_usd_cents"] == 1500,
      json.dumps(claim)[:300])

# double-claim must fail
st, dclaim = req("POST", "/v1/identity/claim",
                 {"escrow_id": escrow_id, "phone": "+15550109999", "code": code})
check("double-claim rejected", st in (401, 404), f"status {st}")

# ── 8. fee schedule ──────────────────────────────────────────────────────────
st, sched = req("GET", "/v1/fees/schedule")
check("fee schedule transparency", st == 200 and len(sched["data"]["schedule"]) == 5)

# ── 9. explorer ──────────────────────────────────────────────────────────────
st, blocks = req("GET", "/v1/simnet/blocks?limit=10")
check("simnet explorer feed", st == 200 and len(blocks["data"]["blocks"]) >= 5)

passed = sum(1 for _, ok in results if ok)
print(f"\n{'=' * 60}\n{passed}/{len(results)} checks passed")
exit(0 if passed == len(results) else 1)
