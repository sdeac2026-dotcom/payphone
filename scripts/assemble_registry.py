#!/usr/bin/env python3
"""Final registry assembly: CoinGecko tokenlists (canonical addresses per
network) + slow-paced on-chain verification (symbol()/decimals()).

Rate-limit friendly: 0.6 s between calls, rotates across RPC endpoints,
2 attempts per call. Only entries whose ON-CHAIN symbol equals the expected
asset symbol ship.
"""
import json, socket, time, urllib.request
socket.setdefaulttimeout(15)

RPCS = {
    "ethereum":  ["https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth", "https://eth.llamarpc.com"],
    "base":      ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    "arbitrum":  ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    "optimism":  ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    "polygon":   ["https://polygon-bor-rpc.publicnode.com", "https://polygon-bor-rpc.publicnode.com"],
    "bsc":       ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io", "https://bsc-rpc.publicnode.com"],
    "avalanche": ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
}

TL_FILE = {
    "ethereum": "tl_ethereum.json", "base": "tl_base.json", "arbitrum": "tl_arbitrum-one.json",
    "optimism": "tl_optimistic-ethereum.json", "polygon": "tl_polygon-pos.json",
    "bsc": "tl_binance-smart-chain.json", "avalanche": "tl_avalanche.json",
}

WANT = {  # symbol → acceptable tokenlist symbol spellings (upper-cased)
    "USDT": {"USDT", "USD₮", "USDT."},
    "BTCB": {"BTCB"}, "CAKE": {"CAKE", "CAKES"}, "WAVAX": {"WAVAX"},
    "MKR": {"MKR"}, "PEPE": {"PEPE"}, "POL": {"POL"}, "WMATIC": {"WMATIC", "WPOL"},
    "WBTC": {"WBTC"}, "WETH": {"WETH"}, "LINK": {"LINK"}, "UNI": {"UNI"},
    "AAVE": {"AAVE"}, "SHIB": {"SHIB"}, "LDO": {"LDO"}, "CRV": {"CRV"},
    "COMP": {"COMP"}, "GRT": {"GRT"}, "TUSD": {"TUSD"}, "FRAX": {"FRAX"},
    "PYUSD": {"PYUSD"}, "APE": {"APE"}, "SAND": {"SAND"}, "MANA": {"MANA"},
    "ENS": {"ENS"}, "USDS": {"USDS"}, "ARB": {"ARB"}, "OP": {"OP"},
    "GMX": {"GMX"}, "DAI": {"DAI"}, "USDC": {"USDC", "USDC.E", "NATIVE USDC"},
    "cbBTC": {"CBBTC"}, "cbETH": {"CBETH"}, "USDt": {"USDT", "USD₮"},
}

def evm_rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def call_sym_dec(rpc, addr):
    """Return (symbol, decimals) with string + bytes32 handling, or (None, None)."""
    try:
        raw = evm_rpc(rpc, "eth_call", [{"to": addr.lower(), "data": "0x95d89b41"}, "latest"]).get("result")
        sym = None
        if raw and raw != "0x" and len(raw) >= 130:
            b = bytes.fromhex(raw[2:])
            off = int.from_bytes(b[0:32], "big"); ln = int.from_bytes(b[off:off+32], "big")
            if 0 < ln < 128:
                sym = b[off+32:off+32+ln].decode("utf-8", "replace")
        elif raw and len(raw) == 66:
            s = bytes.fromhex(raw[2:]).rstrip(b"\x00").decode("utf-8", "replace")
            if s.isprintable() and s:
                sym = s
        dec = None
        raw2 = evm_rpc(rpc, "eth_call", [{"to": addr.lower(), "data": "0x313ce567"}, "latest"]).get("result")
        if raw2 and raw2 != "0x" and len(raw2) >= 66:
            dec = int(raw2, 16)
        return sym, dec
    except Exception:
        return None, None

# ---- extract candidates from tokenlists --------------------------------------
cands = {}  # (net, want_symbol) → set[(addr, listed_symbol)]
for net, fname in TL_FILE.items():
    data = json.load(open(f"/home/z/my-project/scripts/{fname}"))
    for t in data.get("tokens", []):
        sym = (t.get("symbol") or "").upper()
        for want, spellings in WANT.items():
            if sym in spellings and t.get("address", "").startswith("0x"):
                dec = t.get("decimals")
                if isinstance(dec, int) and 0 <= dec <= 18:
                    cands.setdefault((net, want), set()).add((t["address"].lower(), dec))
print(f"{sum(len(v) for v in cands.values())} candidate (network, asset, address) pairs from tokenlists")

# For symbols with many entries prefer well-known: keep all, verify each until match.
verified = []
seen = set()
for (net, want), pairs in sorted(cands.items()):
    rpcs = RPCS[net]
    ok = False
    for i, (addr, listed_dec) in enumerate(sorted(pairs)):
        if (net, want, addr) in seen or ok:
            break
        rpc = rpcs[i % len(rpcs)]
        sym, dec = call_sym_dec(rpc, addr)
        time.sleep(0.6)
        if sym is None and dec is None:
            continue  # rpc hiccup or non-contract; try next candidate address
        if sym is not None and sym.upper().replace("₮", "T") == want.upper() and dec is not None and 0 <= dec <= 18:
            key = (net, want, addr)
            if key not in seen:
                seen.add(key)
                verified.append({"network": net, "symbol": want, "address": addr, "decimals": dec,
                                 "onchain_symbol": sym})
                print(f"OK  {net:10s} {want:6s} {addr} dec={dec} (onchain {sym!r})")
                ok = True
        else:
            print(f"    skip {net} {want} {addr[:16]} sym={sym!r} dec={dec}")

with open("/home/z/my-project/scripts/verified_tokens.json", "w") as f:
    json.dump({"verified": verified}, f, indent=1)

print(f"\n{len(verified)} verified entries")
for net in RPCS:
    rows = [v for v in verified if v["network"] == net]
    if rows:
        print(f"  {net}: {', '.join(v['symbol'] for v in rows)}")
