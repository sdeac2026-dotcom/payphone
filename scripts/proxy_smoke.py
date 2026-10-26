#!/usr/bin/env python3
"""Browser-path smoke test: runs the full payment cycle through the web proxy
on :3000 — the exact path a real browser takes (UI -> /api/v1 -> engine)."""
import hashlib, hmac, json, sys, time, urllib.request

BASE = "http://127.0.0.1:3000"

def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

def signed(method, path, raw, sk, pk):
    ts = str(int(time.time()))
    sig = hmac.new(sk.encode(), f"{ts}.{method}.{path}.{hashlib.sha256(raw).hexdigest()}".encode(),
                   hashlib.sha256).hexdigest()
    return {"X-PayPhone-Key": pk, "X-PayPhone-Timestamp": ts, "X-PayPhone-Signature": sig}

ok = True
def step(name, cond, detail=""):
    global ok
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail and not cond else ""))
    ok = ok and cond

s, h = call("GET", "/api/health")
step("proxy health (web+engine+oracle)", s == 200 and h.get("engine") and h.get("oracle"))

s, r = call("POST", "/api/v1/keys", {"tier": "growth"})
d = r.get("data", {})
pk, sk = d.get("public_key", ""), d.get("secret_key", "")
step("issue merchant keys (pk_growth_* / sk_*)", s in (200, 201) and pk.startswith("pk_growth_") and sk.startswith("sk_"))

path = "/v1/invoices"
inv = {"amount_usd_cents": 1999, "asset": "USDC", "chain": "simnet", "network": "simnet",
       "wallet": "0xa11ce0000000000000000000000000000000dEaD", "description": "browser-path smoke test"}
raw = json.dumps(inv).encode()
s, r = call("POST", "/api" + path, inv, signed("POST", path, raw, sk, pk))
d = r.get("data", {})
inv_id, token = d.get("invoice", {}).get("id", ""), d.get("token", "")
fee = d.get("fee", {})
rate = d.get("rate", {})
step("create signed invoice (70bps fee, rate-locked quote)",
     s in (200, 201) and inv_id.startswith("inv_") and fee.get("fee_total_minor") == 13
     and float(d.get("asset_amount", "0")) > 0,
     json.dumps(r)[:200])
print(f"        invoice={inv_id}  $19.99 -> {d.get('asset_amount')} USDC  fee=${fee.get('fee_total_minor', 0)/100:.2f}"
      f" (protocol/referrer/ops split ${fee.get('split', {}).get('protocol_minor',0)/100:.2f}/${fee.get('split', {}).get('referrer_minor',0)/100:.2f}/${fee.get('split', {}).get('operations_minor',0)/100:.2f})")

if not token:
    print("        (token missing — skipping tamper/payment checks)")
    print("SOME CHECKS FAILED"); sys.exit(1)

payload, sig = token.split(".")
mid = len(payload) // 2
flipped = (payload[:mid] + ("A" if payload[mid] != "A" else "B") + payload[mid+1:] + "." + sig)
s, _ = call("GET", f"/api/v1/invoices/{inv_id}?token={flipped}")
step("tampered token rejected (401 anti-forgery)", s == 401, f"got {s}")

s, r = call("GET", f"/api/v1/invoices/{inv_id}?token={token}")
step("invoice status=pending before payment", s == 200 and r.get("data", {}).get("invoice", {}).get("status") == "pending")

addr = d["invoice"]["address"]
locked_qty = int(d["invoice"]["qte"])  # qte travels as a decimal string
s, r = call("POST", "/api/v1/simnet/pay", {"to": addr, "asset": "USDC", "amount_minor": locked_qty,
                                       "invoice_id": inv_id, "from": "browser-smoke"})
tx = r.get("data", {}).get("tx", {})
step("simnet payment accepted (block committed)", s in (200, 201) and tx.get("height", 0) >= 1, json.dumps(r)[:200])
print(f"        tx={tx.get('tx_hash','')[:26]}...  simnet height={tx.get('height')}")

s, r = call("GET", f"/api/v1/invoices/{inv_id}?token={token}")
d2 = r.get("data", {})
step("invoice status=paid + on-chain receipt", s == 200 and d2.get("invoice", {}).get("status") == "paid"
     and len(d2.get("receipts", [])) >= 1)

print()
if ok:
    print(f"ALL BROWSER-PATH CHECKS PASSED  (invoice {inv_id}, tx {tx.get('tx_hash','')[:18]}...)")
    sys.exit(0)
print("SOME CHECKS FAILED")
sys.exit(1)
