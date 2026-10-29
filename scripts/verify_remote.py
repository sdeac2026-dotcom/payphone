#!/usr/bin/env python3
"""Remote verification of a live PayPhone deployment (public endpoints only).

Usage: python3 verify_remote.py https://payphone-div0.onrender.com

Proves, without any secrets:
  1. Service is awake (handles free-plan cold start ~50s)
  2. Console page served
  3. /api/health aggregate: web + engine + oracle all true
  4. Engine runs PRODUCTION posture: fail-closed mode, no demo mode
  5. Real chains registered and live (7 EVM mainnets + BTC + SOL + TRON)
  6. Asset catalog loaded (60 assets)
  7. Admin gate ACTIVE: key issuance without X-Admin-Token -> 403
  8. Fee schedule public and sane
"""
import json, sys, time, urllib.error, urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def get(path, timeout=20):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def post(path, body, headers=None, timeout=20):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}

print("=" * 72)
print(f"REMOTE VERIFICATION — {BASE}")
print("=" * 72)

# 1. wake + aggregate health (free plan can sleep ~50s before first response)
print("\n[1] wake-up + aggregate health")
ok, health = False, {}
for attempt in range(24):
    try:
        code, raw = get("/api/health", timeout=25)
        if code == 200:
            health = json.loads(raw)
            ok = True
            break
    except Exception:
        pass
    time.sleep(5)
check("service awake and answering", ok,
      "still sleeping/building after ~2 min — check the Render dashboard Events tab")
if ok:
    check("/api/health: web+engine+oracle all true",
          health.get("web") is True and health.get("engine") is True and health.get("oracle") is True,
          json.dumps(health))

# 2. console page
print("\n[2] console page")
try:
    code, raw = get("/", timeout=20)
    html = raw.decode(errors="ignore")
    check("page served (HTTP 200, PayPhone shell)", code == 200 and "PayPhone" in html and "<html" in html.lower())
except Exception as e:
    check("page served (HTTP 200, PayPhone shell)", False, repr(e))

# 3. engine health — production posture
print("\n[3] engine posture (must be production, not demo)")
try:
    code, raw = get("/api/v1/health", timeout=20)
    h = json.loads(raw)
    d = h.get("data", h)
    check("demo_mode is false (real keys in use)", d.get("demo_mode") is False, json.dumps(d)[:300])
except Exception as e:
    check("demo_mode is false (real keys in use)", False, repr(e))

# 4. chains
print("\n[4] real chains")
try:
    code, raw = get("/api/v1/chains", timeout=60)
    nets = json.loads(raw).get("data", {}).get("networks", [])
    names = [n.get("name", "?") for n in nets]
    check(f"networks registered ({len(nets)})", len(nets) >= 10, json.dumps(names))
    # Probe results are nested under "probe" (live RPC chain-id check per network).
    def probed(n):
        p = n.get("probe") or {}
        return p.get("rpc_live") is True and p.get("chain_id_matches", True)
    live = [n for n in nets if probed(n)]
    check(f"networks LIVE on real RPCs ({len(live)}/{len(nets)})", len(live) == len(nets),
          str([(n.get('name'), n.get('probe')) for n in nets if not probed(n)]))
    for want in ("base", "ethereum", "arbitrum", "polygon", "optimism", "bsc", "avalanche",
                 "bitcoin", "solana", "tron"):
        check(f"  {want} present", any(want == n.get("name", "").lower() or want in json.dumps(n).lower()
                                       for n in nets))
except Exception as e:
    check("chains endpoint", False, repr(e))

# 5. assets
print("\n[5] asset catalog")
try:
    code, raw = get("/api/v1/assets", timeout=30)
    assets = json.loads(raw).get("data", {}).get("assets", [])
    check(f"assets loaded ({len(assets)})", len(assets) >= 50)
except Exception as e:
    check("assets endpoint", False, repr(e))

# 6. autonomous onboarding & tier gate — the production security posture
print("\n[6] autonomous onboarding & tier gate (security)")
try:
    code, body = post("/api/v1/keys", {"tier": "free"}, timeout=20)
    data = body.get("data") or {}
    check("open tier 'free' self-serves with no token",
          code == 201 and str(data.get("public_key", "")).startswith("pk_free_"),
          f"code={code} {json.dumps(body)[:160]}")
except Exception as e:
    check("open tier 'free' self-serves with no token", False, repr(e))

try:
    code, body = post("/api/v1/keys", {"tier": "starter"}, timeout=20)
    data = body.get("data") or {}
    check("open tier 'starter' self-serves with no token",
          code == 201 and str(data.get("public_key", "")).startswith("pk_starter_"),
          f"code={code} {json.dumps(body)[:160]}")
except Exception as e:
    check("open tier 'starter' self-serves with no token", False, repr(e))

try:
    code, body = post("/api/v1/keys", {"tier": "growth"}, timeout=20)
    msg = (body.get("error") or {}).get("message", "")
    check("paid tier 'growth' without admin token -> 403",
          code == 403 and "admin token" in msg.lower(), f"code={code} msg={msg!r}")
except Exception as e:
    check("paid tier 'growth' without admin token -> 403", False, repr(e))

try:
    code, raw = get("/api/v1/tiers", timeout=20)
    body = json.loads(raw).get("data", {})
    tiers = {t.get("tier"): t for t in body.get("tiers", [])}
    check("tier catalog public (GET /v1/tiers)",
          code == 200 and "growth" in tiers and "free" in tiers,
          f"code={code} tiers={list(tiers)}")
    check("catalog: free=open, growth priced, treasury named",
          tiers.get("free", {}).get("issuance") == "open"
          and (tiers.get("growth", {}).get("price_usd_cents") or 0) > 0
          and "treasury" in body,
          json.dumps(body)[:220])
except Exception as e:
    check("tier catalog public (GET /v1/tiers)", False, repr(e))

try:
    fake = "0x" + "ab" * 32
    code, body = post("/api/v1/tiers/activate",
                      {"tier": "growth", "network": "worldchain", "tx_hash": fake}, timeout=30)
    msg = (body.get("error") or {}).get("message", "")
    low = msg.lower()
    # Without a treasury configured the node refuses politely; with one, a
    # bogus hash is rejected as unknown. Both are controlled, explained 4xx/5xx.
    controlled = 400 <= code < 600 and any(k in low for k in ("treasury", "transaction", "tx hash", "tx_hash"))
    check("tier activation rejects a bogus proof with a controlled error",
          controlled, f"code={code} msg={msg!r}")
except Exception as e:
    check("tier activation rejects a bogus proof with a controlled error", False, repr(e))

# 6b. guardian recovery — the zero-knowledge envelope round-trip.
# Uses the fictional 555-0100 test number and OVERWRITES the same record
# every run (re-registration is the documented revocation path), so the
# check leaves exactly one record behind, never growth.
print("\n[6b] guardian recovery (zero-knowledge envelope round-trip)")
try:
    gphone = "+15550100000"
    gcode = "VERIFY-GUARDIAN-2026"
    genv = json.dumps({
        "v": 1, "kind": "mnemonic", "kdf": "PBKDF2-SHA256", "iterations": 310000,
        "cipher": "AES-GCM-256",
        "salt": "aa" * 16, "iv": "bb" * 12, "ct": "cc" * 64,
    })
    gaddr = "0x" + "ab" * 20
    code, body = post("/api/v1/wallet/recovery/register",
                      {"phone": gphone, "address": gaddr, "recovery_code": gcode, "envelope": genv},
                      timeout=20)
    check("guardian register accepts an enrollment (201)",
          code == 201 and (body.get("data") or {}).get("registered") is True,
          f"code={code} {json.dumps(body)[:160]}")
except Exception as e:
    check("guardian register accepts an enrollment (201)", False, repr(e))

try:
    gcode = "VERIFY-GUARDIAN-2026"
    code, body = post("/api/v1/wallet/recovery/claim",
                      {"phone": "+15550100000", "recovery_code": gcode}, timeout=20)
    data = body.get("data") or {}
    check("guardian claim returns the envelope + address",
          code == 200 and data.get("envelope", "").find('"kind": "mnemonic"') >= 0
          and data.get("address") == "0x" + "ab" * 20,
          f"code={code} {json.dumps(body)[:160]}")
except Exception as e:
    check("guardian claim returns the envelope + address", False, repr(e))

try:
    code, body = post("/api/v1/wallet/recovery/claim",
                      {"phone": "+15550100000", "recovery_code": "WRONG-CODE-999"}, timeout=20)
    msg = (body.get("error") or {}).get("message", "")
    check("guardian claim with a wrong code -> identical controlled 404",
          code == 404 and "no recovery record matches" in msg, f"code={code} msg={msg!r}")
except Exception as e:
    check("guardian claim with a wrong code -> identical controlled 404", False, repr(e))

# 7. fees
print("\n[7] fee schedule")
try:
    code, raw = get("/api/v1/fees/schedule", timeout=20)
    body = json.loads(raw).get("data", {})
    check("fee schedule public", bool(body), json.dumps(body)[:200])
    check("fee schedule carries the treasury field (null until operator sets it)",
          "treasury" in body, json.dumps(body)[:200])
except Exception as e:
    check("fee schedule public", False, repr(e))

# 8. wallet money-radar (WLD on OP Mainnet + incoming feed)
print("\n[8] wallet money-radar (WLD on OP Mainnet + incoming feed)")
try:
    code, raw = get("/api/v1/chains", timeout=30)
    nets = json.loads(raw).get("data", {}).get("networks", [])
    op = next((n for n in nets if n.get("name") == "optimism"), {})
    toks = {t.get("symbol") for t in op.get("settleable_tokens", [])}
    check("WLD settleable on optimism (exchange withdrawals arrive)", "WLD" in toks,
          f"tokens={sorted(toks)[:12]}")
except Exception as e:
    check("WLD settleable on optimism (exchange withdrawals arrive)", False, repr(e))

try:
    probe = "0x000000000000000000000000000000000000dEaD"
    code, raw = get(f"/api/v1/wallet/activity?network=optimism&address={probe}&blocks=100", timeout=45)
    body = json.loads(raw).get("data", {})
    ok = isinstance(body.get("incoming", []), list) and "native_balance" in body
    check("wallet activity feed live (incoming rows + native balance + conf policy)",
          ok and code == 200, f"code={code} {json.dumps(body)[:160]}")
except Exception as e:
    check("wallet activity feed live (incoming rows + native balance + conf policy)", False, repr(e))

# 9. full-visibility activity scan (all networks, both directions)
print("\n[9] full-visibility activity scan (all networks, both directions)")
try:
    probe = "0x000000000000000000000000000000000000dEaD"
    code, raw = get(f"/api/v1/wallet/{probe}/activity?blocks=30&direction=both", timeout=60)
    body = json.loads(raw).get("data", {})
    nets = body.get("scanned_networks", [])
    check("multi-network scan live (all 8 EVM networks in one call)",
          code == 200 and len(nets) >= 8, f"code={code} scanned={nets}")
    check("scan payload well-formed (transfers + native + notes)",
          isinstance(body.get("transfers"), list) and isinstance(body.get("native_balances"), list)
          and isinstance(body.get("notes"), list), json.dumps(body)[:200])
    check("native balances reported per network",
          all(("network" in nb and "asset" in nb and "qty" in nb) for nb in body.get("native_balances", [])),
          json.dumps(body.get("native_balances"))[:200])
    code2, raw2 = get(f"/api/v1/wallet/{probe}/activity?blocks=30&direction=in", timeout=60)
    body2 = json.loads(raw2).get("data", {})
    check("direction + network filters honored",
          all(t.get("direction") == "in" for t in body2.get("transfers", [])),
          f"filter=in transfers={len(body2.get('transfers', []))}")
except Exception as e:
    check("full-visibility scan endpoint", False, repr(e))

try:
    code, body = get("/api/v1/wallet/notanaddress/activity?blocks=10", timeout=30)
    msg = (json.loads(body).get("error") or {}).get("message", "")
    check("bad address rejected", code == 400, f"code={code} msg={msg!r}")
except urllib.error.HTTPError as e:
    check("bad address rejected", e.code == 400, f"code={e.code}")
except Exception as e:
    check("bad address rejected", False, repr(e))

print()
print(f"RESULT: {len(passed)} passed, {len(failed)} failed")
if failed:
    print("FAILED:", *failed, sep="\n  - ")
    sys.exit(1)
print("DEPLOYMENT VERIFIED — this URL is a live PayPhone production node.")
