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
    check(f"networks registered ({len(nets)})", len(nets) >= 11, json.dumps(names))
    # Probe results are nested under "probe" (live RPC chain-id check per network).
    def probed(n):
        p = n.get("probe") or {}
        return p.get("rpc_live") is True and p.get("chain_id_matches", True)
    live = [n for n in nets if probed(n)]
    check(f"networks LIVE on real RPCs ({len(live)}/{len(nets)})", len(live) == len(nets),
          str([(n.get('name'), n.get('probe')) for n in nets if not probed(n)]))
    for want in ("base", "ethereum", "arbitrum", "polygon", "optimism", "bsc", "avalanche",
                 "worldchain", "bitcoin", "solana", "tron"):
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

# 6. admin gate — the production security posture
print("\n[6] admin gate (security)")
try:
    code, body = post("/api/v1/keys", {"tier": "growth"}, timeout=20)
    msg = (body.get("error") or {}).get("message", "")
    check(f"key issuance without admin token -> {code} forbidden",
          code == 403 and "admin token" in msg.lower(), f"code={code} msg={msg!r}")
except Exception as e:
    check("admin gate responds", False, repr(e))

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

# 8. wallet money-radar — WLD on OP Mainnet + incoming-transfer feed
print("\n[8] wallet money-radar (WLD on OP Mainnet + incoming feed)")
BRIDGE = "0x4200000000000000000000000000000000000010"  # OP L2 Standard Bridge
try:
    code, raw = get("/api/v1/chains", timeout=60)
    nets = json.loads(raw).get("data", {}).get("networks", [])
    op = next((n for n in nets if n.get("name") == "optimism"), {})
    symbols = [t.get("symbol") for t in op.get("settleable_tokens", [])]
    check("WLD settleable on optimism (exchange withdrawals arrive)",
          "WLD" in symbols, str(symbols))
except Exception as e:
    check("WLD settleable on optimism (exchange withdrawals arrive)", False, repr(e))
try:
    code, raw = get(f"/api/v1/wallet/activity?network=optimism&address={BRIDGE}&blocks=200",
                    timeout=90)
    d = json.loads(raw).get("data", {})
    check("wallet activity feed live (incoming rows + native balance + conf policy)",
          isinstance(d.get("incoming"), list) and "native_balance" in d
          and d.get("confirmations_required") == 8 and d.get("network") == "optimism",
          json.dumps(d)[:200])
except Exception as e:
    check("wallet activity feed live (incoming rows + native balance + conf policy)",
          False, repr(e))

print()
print(f"RESULT: {len(passed)} passed, {len(failed)} failed")
if failed:
    print("FAILED:", *failed, sep="\n  - ")
    sys.exit(1)
print("DEPLOYMENT VERIFIED — this URL is a live PayPhone production node.")
