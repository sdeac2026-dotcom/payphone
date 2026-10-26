#!/usr/bin/env python3
"""On-chain token verification for the PayPhone multi-chain registry.

Two-source rule for every entry that ships in registry.rs:
  1. CoinGecko platform map — canonical contract address per chain
     (single batched /coins/list?include_platform=true call).
  2. Live on-chain probe — eth_call symbol() + decimals() on the network's
     public RPC. The entry ships ONLY if the on-chain symbol matches the
     expected asset symbol and decimals() is sane (0..=18).

Hardcoded fallback candidates (verifier still confirms each on-chain) cover
the case where CoinGecko is unreachable. Wrong guesses are DROPPED, never
shipped: a mis-registered token means payers send funds the engine cannot
observe — fail-closed beats fail-open.

Output:
  - scripts/verified_tokens.json  (machine-readable)
  - stdout: Rust TokenSpec table ready to paste into chains/registry.rs
"""
import json, socket, sys, time, urllib.request

socket.setdefaulttimeout(12)

# Asset symbol → CoinGecko id (single source for pricing too).
CG_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binancecoin",
    "XRP": "ripple", "DOGE": "dogecoin", "TRX": "tron", "ADA": "cardano",
    "AVAX": "avalanche-2", "LINK": "chainlink", "DOT": "polkadot",
    "USDT": "tether", "USDC": "usd-coin", "DAI": "dai", "SHIB": "shiba-inu",
    "PEPE": "pepe", "UNI": "uniswap", "AAVE": "aave", "ARB": "arbitrum",
    "OP": "optimism", "POL": "polygon-ecosystem-token", "NEAR": "near",
    "APT": "aptos", "SUI": "sui", "TON": "toncoin", "XLM": "stellar",
    "HBAR": "hedera-hashgraph", "BCH": "bitcoin-cash", "LTC": "litecoin",
    "ATOM": "cosmos", "FIL": "filecoin", "INJ": "injective", "STX": "blockstack",
    "GRT": "the-graph", "LDO": "lido-dao", "CRV": "curve-dao-token",
    "MKR": "maker", "WBTC": "wrapped-bitcoin", "WETH": "wrapped-ether",
    "TUSD": "true-usd", "FRAX": "frax", "PYUSD": "paypal-usd", "CELO": "celo",
    "ICP": "internet-computer", "RENDER": "render-token", "XMR": "monero",
    "ETC": "ethereum-classic", "MATIC": "matic-network",
}

# CoinGecko platform key → our network name
PLATFORM_MAP = {
    "ethereum": "ethereum",
    "base": "base",
    "arbitrum-one": "arbitrum",
    "optimistic-ethereum": "optimism",
    "polygon-pos": "polygon",
    "binance-smart-chain": "bsc",
    "avalanche": "avalanche",
}

RPCS = {
    "ethereum":  "https://ethereum-rpc.publicnode.com",
    "base":      "https://mainnet.base.org",
    "arbitrum":  "https://arb1.arbitrum.io/rpc",
    "optimism":  "https://mainnet.optimism.io",
    "polygon":   "https://polygon-bor-rpc.publicnode.com",
    "bsc":       "https://bsc-rpc.publicnode.com",
    "avalanche": "https://avalanche-c-chain-rpc.publicnode.com",
}

# Fallback candidates when CoinGecko is unreachable: (network, symbol, address, expected_decimals)
HARDCODED = [
    ("ethereum", "WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18),
    ("ethereum", "WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8),
    ("ethereum", "LINK", "0x514910771AF9Ca656af840dff83E8264EcF986CA", 18),
    ("ethereum", "UNI",  "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18),
    ("ethereum", "AAVE", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", 18),
    ("ethereum", "SHIB", "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", 18),
    ("ethereum", "PEPE", "0x6982508145454Ce325dDbE9a6dC891681C8e4Cac", 18),
    ("ethereum", "LDO",  "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", 18),
    ("ethereum", "CRV",  "0xD533a949740bb3306d119CC777fa900bA034cd52", 18),
    ("ethereum", "MKR",  "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", 18),
    ("ethereum", "COMP", "0xc00e94Cb662C3520282E6f5717214004A7f26888", 18),
    ("ethereum", "GRT",  "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", 18),
    ("ethereum", "TUSD", "0x0000000000085d4780B73119b644AE5ecd22b376", 18),
    ("ethereum", "FRAX", "0x853d955aCEf822Db058eb8505911ED77F175b99e", 18),
    ("ethereum", "PYUSD","0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", 6),
    ("ethereum", "APE",  "0x4d224452801ACEd8B2F0aebE155379bb5D594381", 18),
    ("ethereum", "SAND", "0x3845badAde8e6dFF049820680d1F14bD3903a5d0", 18),
    ("ethereum", "MANA", "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942", 18),
    ("ethereum", "ENS",  "0xC18360217D8F7Ab5e7c516566761ea12Ce7F9D72", 18),
    ("ethereum", "USDS", "0xdC035D45d973E3EC169d2276DDab16f1e407384F", 18),
    ("ethereum", "POL",  "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", 18),
    ("base", "WETH",  "0x4200000000000000000000000000000000000006", 18),
    ("base", "cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8),
    ("base", "cbETH", "0x2Ae3F1ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18),
    ("base", "USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c950eA7fd8b1329D", 6),
    ("arbitrum", "ARB",  "0x912CE59144191C1204E64559FE8253a0e49E6548", 18),
    ("arbitrum", "WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18),
    ("arbitrum", "DAI",  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
    ("arbitrum", "LINK", "0xf97f4df75117a78c1A5a0dbb814Af92458539FB4", 18),
    ("arbitrum", "GMX",  "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", 18),
    ("optimism", "OP",   "0x4200000000000000000000000000000000000042", 18),
    ("optimism", "WETH", "0x4200000000000000000000000000000000000006", 18),
    ("optimism", "DAI",  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
    ("polygon", "WPOL", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18),
    ("polygon", "POL",  "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", 18),
    ("polygon", "USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6),
    ("polygon", "DAI",  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18),
    ("polygon", "LINK", "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", 18),
    ("polygon", "AAVE", "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", 18),
    ("bsc", "USDT", "0x55d39732964e63A4a16F35f00118D6c73dE57a67", 18),
    ("bsc", "USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18),
    ("bsc", "ETH",  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", 18),
    ("bsc", "BTCB", "0x7130d2A67B4DAe287D8b2E293C7EBc31fe5875f0", 18),
    ("bsc", "CAKE", "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", 18),
    ("avalanche", "USDC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6),
    ("avalanche", "USDT", "0x9702230A8Ea53601f5cd2dc00fDBc13d4dF4A8c7", 6),
    ("avalanche", "WAVAX", "0xB31f66AA3C1e785363F0875A1B74E27b85FD9c7", 18),
]

def http(url, data=None, headers=None, timeout=12):
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("User-Agent", "PayPhone-Verifier/0.1")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def evm_rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    return json.loads(http(url, body, {"Content-Type": "application/json"}))

def eth_call_string(rpc_url, address, selector):
    """eth_call a zero-arg function returning ABI `string`."""
    r = evm_rpc(rpc_url, "eth_call", [{"to": address.lower(), "data": selector}, "latest"])
    if "error" in r:
        return None
    raw = r.get("result")
    if not raw or raw == "0x" or len(raw) < 130:
        return None
    try:
        b = bytes.fromhex(raw[2:])
        offset = int.from_bytes(b[0:32], "big")
        length = int.from_bytes(b[offset:offset + 32], "big")
        return b[offset + 32:offset + 32 + length].decode("utf-8", "replace")
    except Exception:
        return None

def eth_call_uint(rpc_url, address, selector):
    r = evm_rpc(rpc_url, "eth_call", [{"to": address.lower(), "data": selector}, "latest"])
    raw = r.get("result")
    if not raw or raw == "0x" or len(raw) < 66:
        return None
    try:
        return int(raw, 16)
    except ValueError:
        return None

# ---- 1. CoinGecko platform addresses ----------------------------------------
cg_platform = {}   # (symbol_upper, network) → address
try:
    print("fetching CoinGecko /coins/list?include_platform=true ...", flush=True)
    raw = json.loads(http("https://api.coingecko.com/api/v3/coins/list?include_platform=true"))
    by_id = {c["id"]: c for c in raw}
    for sym, cid in CG_IDS.items():
        coin = by_id.get(cid)
        if not coin:
            continue
        for pk, addr in (coin.get("platforms") or {}).items():
            net = PLATFORM_MAP.get(pk)
            if net and addr and addr.startswith("0x") and len(addr) == 42:
                cg_platform[(sym, net)] = addr
    print(f"  → {len(cg_platform)} (asset, network) platform pairs from CoinGecko")
except Exception as e:
    print(f"  CoinGecko unreachable ({e!r}) — hardcoded candidates only")

# ---- 2. Merge with hardcoded candidates --------------------------------------
cands = {}  # (network, symbol) → set of addresses
for sym, cid in CG_IDS.items():
    for net in RPCS:
        addr = cg_platform.get((sym, net))
        if addr:
            cands.setdefault((net, sym), set()).add(addr.lower())
# CG 'wrapped-ether' maps WETH addresses; also alias ETH→WETH contract per network? No:
# native ETH invoices carry no contract. WETH stays its own asset.
for net, sym, addr, _ in HARDCODED:
    cands.setdefault((net, sym), set()).add(addr.lower())

# ---- 3. On-chain verification ------------------------------------------------
verified, dropped = [], []
calls = sum(len(v) for v in cands.values())
done = 0
for (net, sym), addrs in sorted(cands.items()):
    for addr in sorted(addrs):
        done += 1
        rpc = RPCS[net]
        try:
            onchain_sym = eth_call_string(rpc, addr, "0x95d89b41")   # symbol()
            dec = eth_call_uint(rpc, addr, "0x313ce567")             # decimals()
        except Exception as e:
            dropped.append((net, sym, addr, f"rpc error {e!r}"))
            time.sleep(0.2)
            continue
        if onchain_sym is None or dec is None or not (0 <= dec <= 18):
            dropped.append((net, sym, addr, f"not an ERC-20 (sym={onchain_sym!r}, dec={dec})"))
        elif onchain_sym.upper() != sym.upper():
            dropped.append((net, sym, addr, f"symbol mismatch: on-chain={onchain_sym}"))
        else:
            verified.append({"network": net, "symbol": onchain_sym, "address": addr, "decimals": dec})
        time.sleep(0.12)
        print(f"  [{done}/{calls}] {net:10s} {sym:6s} {addr[:14]}… sym={onchain_sym!s:8s} dec={dec}", flush=True)

# ---- 4. Emit ------------------------------------------------------------------
with open("/home/z/my-project/scripts/verified_tokens.json", "w") as f:
    json.dump({"verified": verified, "dropped": dropped}, f, indent=1)

print("\n=== VERIFIED (ship in registry.rs) ===")
for net in RPCS:
    rows = [v for v in verified if v["network"] == net]
    if not rows:
        continue
    print(f"\n// {net} — {len(rows)} verified tokens")
    for v in rows:
        print(f'            "{v["symbol"]}" => ("{v["address"]}", {v["decimals"]}),')

print("\n=== DROPPED ===")
for d in dropped:
    print(" ", d)
print(f"\n{len(verified)} verified, {len(dropped)} dropped")
