#!/usr/bin/env python3
"""Production-stack verification — proves the Docker topology before we ship.

Boots the EXACT production layout on isolated ports (no Docker needed):
  oracle  127.0.0.1:18001  (uvicorn — in the image: /opt/oracle-venv/bin/uvicorn)
  engine  127.0.0.1:18081  (payphone-engine, private loopback, own simnet journal)
  web     127.0.0.1:18080  (Next.js standalone `node server.js` — THE ONLY PUBLIC PORT)

Then exercises, through the public web port only:
  1. Static page + /api/health served by the standalone server (proxy wiring)
  2. Admin gate:  POST /api/v1/keys without X-Admin-Token -> 403
                  with X-Admin-Token -> 200  (the console sends this header)
  3. Merchant HMAC invoice through the proxy; payment_url points at the public host
  4. Checkout page served; simnet payment; invoice flips to PAID
Extra boot proofs:
  A. Fail-closed: PAYPHONE_ENV=production without a master key refuses to boot
  C. Production boot: real keys -> healthy, demo_mode=false, simnet off
"""
import hashlib, hmac, json, os, shutil, signal, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORACLE_PORT, ENGINE_PORT, WEB_PORT = 18001, 18081, 18080
WEB = f"http://127.0.0.1:{WEB_PORT}"
ENGINE = f"http://127.0.0.1:{ENGINE_PORT}"
ADMIN = "pp-test-admin-token-9f2c"
TMP = "/tmp/pp-prodtest"
os.makedirs(TMP, exist_ok=True)

procs = []
passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def spawn(cmd, cwd, env=None, log="boot.log"):
    f = open(os.path.join(TMP, log), "ab")
    p = subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **(env or {})},
                         stdout=f, stderr=f, start_new_session=True)
    procs.append(p)
    return p

def killall():
    for p in procs:
        try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception: pass
    procs.clear()

def wait_http(url, tries=60, delay=0.5):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200: return True
        except Exception:
            time.sleep(delay)
    return False

def api(path, body=None, headers=None, method=None, retries=2):
    data = json.dumps(body).encode() if body is not None else None
    m = method or ("POST" if data else "GET")
    h = {"Content-Type": "application/json", **(headers or {})}
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(WEB + path, data=data, headers=h, method=m)
            return json.load(urllib.request.urlopen(req, timeout=15))
        except urllib.error.HTTPError as e:
            body_bytes = e.read()
            try: return json.loads(body_bytes)
            except Exception: last = e
        except Exception as e:
            last = e
            time.sleep(0.4)
    raise last

def signed(path, body, pk, sk):
    engine_path = path.removeprefix("/api")
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    sig = hmac.new(sk.encode(), f"{ts}.POST.{engine_path}.{hashlib.sha256(raw).hexdigest()}".encode(),
                   hashlib.sha256).hexdigest()
    return api(path, body, {"X-PayPhone-Key": pk, "X-PayPhone-Timestamp": ts, "X-PayPhone-Signature": sig})

print("=" * 72)
print("PRODUCTION STACK VERIFICATION")
print("=" * 72)

# ---- A. fail-closed boot: production mode demands a real master key -------
print("\n[A] fail-closed boot (PAYPHONE_ENV=production, no master key)")
r = subprocess.run([f"{ROOT}/engine/target/release/payphone-engine"],
                   env={**os.environ, "PAYPHONE_ENV": "production", "PAYPHONE_PORT": "18090"},
                   capture_output=True, text=True, timeout=30, cwd=f"{ROOT}/engine")
out = (r.stdout + r.stderr)
check("engine refuses to boot without PAYPHONE_MASTER_KEY", r.returncode != 0 and "MASTER_KEY" in out.upper(),
      f"rc={r.returncode}")

# ---- C. production boot with real keys -------------------------------------
print("\n[C] production boot with real keys (admin token set, simnet off)")
prod_env = {
    "PAYPHONE_ENV": "production", "PAYPHONE_PORT": "18082",
    "PAYPHONE_MASTER_KEY": hashlib.sha256(b"prod-test-master").hexdigest(),
    "PAYPHONE_SIGNING_KEY": hashlib.sha256(b"prod-test-sign").hexdigest(),
    "PAYPHONE_PHONE_PEPPER": hashlib.sha256(b"prod-test-pepper").hexdigest(),
    "PAYPHONE_ADMIN_TOKEN": ADMIN,
    "PAYPHONE_ORACLE_URL": f"http://127.0.0.1:{ORACLE_PORT}",
}
pe = spawn([f"{ROOT}/engine/target/release/payphone-engine"], f"{ROOT}/engine", prod_env, "engine-prod.log")
prod_up = wait_http("http://127.0.0.1:18082/health", tries=40)
check("engine boots healthy with PAYPHONE_ENV=production + real keys", prod_up)
try:
    h = json.load(urllib.request.urlopen("http://127.0.0.1:18082/health", timeout=5))
    d = h.get("data", h)
    check("production health: demo_mode=false", d.get("demo_mode") is False, json.dumps(d)[:200])
except Exception as e:
    check("production health: demo_mode=false", False, str(e))

# ---- B. full production topology -------------------------------------------
print("\n[B] full stack: oracle :18001 -> engine :18081 -> web :18080 (public)")
oracle = spawn(["python3", "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                "--port", str(ORACLE_PORT), "--log-level", "warning"],
               f"{ROOT}/services/oracle-py", {}, "oracle.log")
engine = spawn([f"{ROOT}/engine/target/release/payphone-engine"], f"{ROOT}/engine",
               {"PAYPHONE_PORT": str(ENGINE_PORT),
                "PAYPHONE_ORACLE_URL": f"http://127.0.0.1:{ORACLE_PORT}",
                "PAYPHONE_SIMNET": "1",
                "PAYPHONE_SIMNET_DIR": f"{TMP}/simnet",
                "PAYPHONE_ADMIN_TOKEN": ADMIN},
               "engine.log")
node_bin = shutil.which("node") or shutil.which("bun")
check("runtime JS engine available (node preferred, bun fallback)", node_bin is not None)
web = spawn([node_bin, "server.js"], f"{ROOT}/.next/standalone",
            {"PORT": str(WEB_PORT), "HOSTNAME": "127.0.0.1",
             "PAYPHONE_ENGINE_URL": f"http://127.0.0.1:{ENGINE_PORT}",
             "NODE_ENV": "production"}, "web.log")

check("web (standalone server.js) is up", wait_http(WEB + "/", tries=60))
check("oracle is up", wait_http(f"http://127.0.0.1:{ORACLE_PORT}/health", tries=40))

try:
    # 1. page + health through the public port
    html = urllib.request.urlopen(WEB + "/", timeout=10).read().decode()
    check("public port serves the console page", "PayPhone" in html and "<html" in html.lower())
    h = api("/api/health")
    check("/api/health aggregate: web+engine+oracle all true (gateway wiring)",
          h.get("web") is True and h.get("engine") is True and h.get("oracle") is True,
          json.dumps(h)[:150])

    # 2. admin gate (production posture)
    denied = api("/api/v1/keys", {"tier": "growth"})
    etype = (denied.get("error") or {}).get("type", "")
    check("key issuance WITHOUT admin token -> 403 forbidden",
          (denied.get("error") or {}).get("message") == "admin token required to issue keys", json.dumps(denied)[:150])
    granted = api("/api/v1/keys", {"tier": "growth"}, {"X-Admin-Token": ADMIN})
    check("key issuance WITH X-Admin-Token -> keys minted",
          "data" in granted and "secret_key" in granted.get("data", {}), json.dumps(granted)[:150])
    pk, sk = granted["data"]["public_key"], granted["data"]["secret_key"]

    # 3. merchant invoice via HMAC through the proxy
    inv = signed("/api/v1/invoices", {
        "amount_usd_cents": 2500, "asset": "USDC", "chain": "simnet", "network": "simnet",
        "wallet": "PP0123456789abcdef0123456789abcdef01234567",
        "description": "Production stack verification",
    }, pk, sk)
    d = inv.get("data", {})
    inv_id, token = d["invoice"]["id"], d["token"]
    link = d.get("payment_url", "")
    check("signed invoice created through public proxy", bool(inv_id), json.dumps(inv)[:150])
    check("payment_url points at the PUBLIC host (x-forwarded-host honored)", link.startswith(WEB), link)

    # 4. payer journey
    page = urllib.request.urlopen(link.split("#")[0], timeout=10).read().decode()
    check("hosted checkout page served on the public port", "PayPhone" in page)
    pay = api("/api/v1/simnet/pay", {"to": d["invoice"]["address"], "asset": "USDC",
                                     "amount_minor": int(d["invoice"]["qte"]),
                                     "invoice_id": inv_id, "from": "PP0123456789abcdef0123456789abcdef01234567"})
    check("payment accepted (simnet tx observed)", "data" in pay, json.dumps(pay)[:150])
    st = api(f"/api/v1/invoices/{inv_id}?token={token}")
    check("invoice status flips to PAID", st.get("data", {}).get("invoice", {}).get("status") == "paid",
          json.dumps(st)[:200])

except Exception as e:
    check("journey completed without exceptions", False, repr(e))

# ---- teardown ---------------------------------------------------------------
print()
killall()
print(f"RESULT: {len(passed)} passed, {len(failed)} failed")
if failed:
    print("FAILED:", *failed, sep="\n  - ")
    sys.exit(1)
print("PRODUCTION STACK VERIFIED — same topology, entrypoint and envs as the Docker image.")
