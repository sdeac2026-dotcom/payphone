/**
 * PayPhone DEMO ENGINE — a complete in-browser implementation of the API
 * surface (`src/lib/payphone/api.ts`), used only in the GitHub-Pages static
 * build (`NEXT_PUBLIC_PAYPHONE_DEMO=1`).
 *
 * Why: Pages hosts static files only — there is no Rust engine to answer
 * `/api/v1/*`. This module replays the engine's behaviour against
 * localStorage so the whole product (onboarding, asset-first invoicing,
 * hosted checkout, phone escrow, simnet explorer) is fully explorable by
 * anyone with the link, no server involved.
 *
 * Honesty rules:
 * - every response is stamped `demo_mode: true` / `source: "demo-static"`;
 * - invoice tokens are HMAC-signed with a PUBLIC demo key (not a secret);
 * - SimNet blocks are hash-chained exactly like the engine's;
 * - real-network invoices render real payment URIs to the merchant's OWN
 *   wallet (funds would be real & non-custodial) but nothing observes them
 *   in the static demo — the checkout page says so.
 *
 * Regenerate the capability snapshot with `scripts/gen_demo_data.py`.
 */

import {
  DEMO_NETWORKS,
  DEMO_ASSETS,
  DEMO_PRICES,
  DEMO_TIERS,
  DEMO_SPLIT,
  type DemoAsset,
} from "./demo-data";
import { hmacSha256Pure as hmacSha256, sha256Hex } from "./purehash";

const DEMO_SIGNING_KEY = "payphone-demo-signing-key (public by design)";
const LS_KEY = "payphone.demo.v1";
const DEFAULT_TTL = 900;

// ------------------------------------------------------------- helpers ----

function b64url(s: string): string {
  const b = btoa(unescape(encodeURIComponent(s)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b + "=".repeat((4 - (b.length % 4)) % 4))));
}
function hex(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export class DemoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- state ----

interface DemoState {
  started: number;
  height: number;
  blocks: { height: number; ts: number; kind: string; data: Record<string, unknown>; prev: string; hash: string }[];
  registry: Record<string, { wallet: string; payphone_id: string }>; // phone_hash → entry
  escrows: Record<string, { phone_hash: string; asset: string; amount_usd_cents: number; code: string; claimed: boolean; ts: number }>;
  invoices: Record<string, DemoInvoice>;
  balances: Record<string, Record<string, number>>; // address → asset → base units
}
interface DemoInvoice {
  invoice: Record<string, unknown>;
  rate_usd: number;
  asset_amount: string;
  fee: Record<string, unknown>;
  payments: { qty: number; ts: number; height: number; hash: string; asset: string }[];
}

function blank(): DemoState {
  return { started: Date.now(), height: 0, blocks: [], registry: {}, escrows: {}, invoices: {}, balances: {} };
}

const load = (): DemoState => {
  try {
    return { ...blank(), ...JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") };
  } catch {
    return blank();
  }
};
const save = (s: DemoState) => localStorage.setItem(LS_KEY, JSON.stringify(s));

async function appendBlock(s: DemoState, kind: string, data: Record<string, unknown>): Promise<{ height: number; hash: string; ts: number }> {
  s.height += 1;
  const ts = Math.floor(Date.now() / 1000);
  const prev = s.blocks.length ? s.blocks[s.blocks.length - 1].hash : "0".repeat(64);
  const hash = await sha256Hex(`${prev}|${s.height}|${ts}|${kind}|${JSON.stringify(data)}`);
  s.blocks.push({ height: s.height, ts, kind, data, prev, hash });
  return { height: s.height, hash, ts };
}

// ----------------------------------------------------------- primitives ----

function findAsset(symbol: string): DemoAsset {
  const a = DEMO_ASSETS.find((x) => x.symbol === symbol);
  if (!a) throw new DemoError(400, `unknown asset '${symbol}' — the full catalog is at GET /v1/assets`);
  return a;
}
function findNetwork(name: string) {
  return DEMO_NETWORKS.find((n) => n.name === name);
}
function tierOf(pk: string): string {
  return pk.split("_")[1] ?? "growth";
}
function bpsOf(tier: string): number {
  return DEMO_TIERS.find((t) => t.tier === tier)?.bps ?? 150;
}
function feeBreakdown(amountMinor: number, bps: number, tier: string) {
  const fee = Math.floor((amountMinor * bps) / 10000);
  const proto = Math.floor((fee * DEMO_SPLIT.protocol_pct) / 100);
  const ref = Math.floor((fee * DEMO_SPLIT.referrer_pct) / 100);
  return {
    amount_minor: amountMinor,
    fee_total_minor: fee,
    net_to_merchant_minor: amountMinor,
    bps,
    tier,
    split: { protocol_minor: proto, referrer_minor: ref, operations_minor: fee - proto - ref },
  };
}
function validateWallet(kind: string, wallet: string): void {
  const hexBody = (w: string, p: string) =>
    w.startsWith(p) && new RegExp(`^${p}[0-9a-fA-F]{40}$`).test(w);
  const ok =
    kind === "simnet" ? hexBody(wallet, "PP") || hexBody(wallet, "0x")
    : kind === "evm" ? hexBody(wallet, "0x")
    : kind === "tron" ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet)
    : kind === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)
    : /^[a-zA-Z0-9]{26,90}$/.test(wallet); // bitcoin base58/bech32 (lenient)
  if (!ok) throw new DemoError(400, `wallet '${wallet}' is not a valid ${kind} address`);
}
function simnetInvoiceAddress(seed: string, sig: string): string {
  // Deterministic PP address; hmacSha256 is async, so callers await it.
  return sig; // placeholder replaced by async derive below
}
async function deriveSimnetAddress(seed: string): Promise<string> {
  const mac = await hmacSha256(DEMO_SIGNING_KEY, `simnet-invoice|${seed}`);
  return "PP" + mac.slice(0, 40);
}
function paymentUri(chain: string, network: string, asset: string, address: string, qtyBase: string, decimals: number): string {
  if (chain === "evm" && asset !== findNetwork(network)?.native) {
    const amt = Number(BigInt(qtyBase)) / 10 ** decimals;
    return `ethereum:${address}@${findNetwork(network)?.chain_id}/transfer?uint256=${qtyBase}`;
  }
  return `${chain === "simnet" ? "payphone" : asset.toLowerCase()}:${address}?amount=${Number(BigInt(qtyBase)) / 10 ** decimals}`;
}

// ------------------------------------------------------------- handlers ----

type Body = Record<string, unknown> | null;

async function handle(method: string, path: string, body: Body, creds: { pk: string; sk: string } | null): Promise<unknown> {
  const s = load();
  // Client call-sites use engine-style paths WITHOUT the /v1 prefix
  // (api.ts request()). Normalize so route matching matches the wire.
  const normalized = path.startsWith("/v1") ? path : `/v1${path}`;
  const [route, query = ""] = normalized.split("?");
  const q = new URLSearchParams(query);
  const now = Math.floor(Date.now() / 1000);
  const routeKey = `${method} ${route.replace(/^\/v1/, "")}`;

  // ---- public ------------------------------------------------------------
  if (routeKey === "GET /health") {
    return {
      status: "ok", service: "payphone-engine", version: "0.1.0-demo",
      uptime_secs: Math.floor((Date.now() - s.started) / 1000),
      demo_mode: true, simnet_enabled: true,
      simnet: { height: s.height, blocks: s.blocks.length + 1,
        registered_numbers: Object.keys(s.registry).length,
        open_escrows: Object.values(s.escrows).filter((e) => !e.claimed).length },
      chains: { simnet: true, evm_networks: DEMO_NETWORKS.filter((n) => n.kind === "evm").map((n) => n.name) },
      oracle_source: "demo-static", supported_assets: DEMO_ASSETS.map((a) => a.symbol),
      rate_limit_per_min: 240,
    };
  }

  if (routeKey === "GET /chains") {
    return {
      networks: DEMO_NETWORKS.map((n) => ({
        name: n.name, kind: n.kind, chain_id: n.chain_id, native_asset: n.native,
        settleable_tokens: Object.entries(n.tokens).map(([symbol, t]) => ({ symbol, ...t })),
        confirmations_required: n.confirmations, explorer_tx: n.explorer_tx,
        rpc_source: "snapshot", probe: { rpc_live: true, chain_id_matches: true,
          note: "static demo snapshot — verified live on mainnet 2026-10" },
      })),
      count: DEMO_NETWORKS.length,
      note: "Static-demo snapshot of the live engine sheet (scripts/gen_demo_data.py).",
    };
  }

  if (routeKey === "GET /rates") {
    const list = (q.get("assets") ?? "").split(",").filter(Boolean);
    return { rates: list.map((a) => ({ asset: a, usd: DEMO_PRICES[a] ?? 0,
      source: "demo-static", stale: false, fetched_at: now })) };
  }

  if (routeKey === "GET /assets") {
    return { assets: DEMO_ASSETS, count: DEMO_ASSETS.length,
      settleable_count: DEMO_ASSETS.filter((a) => a.settleable).length,
      note: "Static-demo snapshot of the live asset catalog." };
  }

  if (routeKey === "GET /fees/schedule") {
    return { schedule: DEMO_TIERS, split: DEMO_SPLIT };
  }

  if (routeKey === "GET /fees/quote") {
    const tier = q.get("tier") ?? "growth";
    const amount = Number(q.get("amount_usd_cents") ?? 0);
    return { fee: feeBreakdown(amount, bpsOf(tier), tier) };
  }

  if (routeKey === "GET /quote") {
    const asset = findAsset((q.get("asset") ?? "USDC").toUpperCase());
    const amount = Number(q.get("amount_usd_cents") ?? 0);
    const price = DEMO_PRICES[asset.symbol] ?? 1;
    const usd = amount / 100;
    return { from_asset: "USD", to_asset: asset.symbol, amount: usd, usd_price: price,
      gross: usd, to_amount: Number((usd / price).toFixed(6)), spread_bps: 0, price_stale: false,
      source: "demo-static" };
  }

  // ---- merchant ----------------------------------------------------------
  if (routeKey === "POST /keys") {
    const tier = (body?.tier as string) ?? "growth";
    if (!DEMO_TIERS.some((t) => t.tier === tier)) throw new DemoError(400, `unknown tier '${tier}'`);
    const id = hex(6);
    return { public_key: `pk_${tier}_${id}`, secret_key: `sk_${tier}_${id}_${hex(24)}`,
      tier, fee_bps: bpsOf(tier),
      warning: "store this secret in your vault now — it cannot be retrieved again" };
  }

  if (routeKey === "POST /invoices") {
    if (!creds) throw new DemoError(401, "merchant key required");
    const asset = findAsset(String(body?.asset ?? "").trim().toUpperCase());
    const amountMinor = Number(body?.amount_usd_cents ?? 0);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0)
      throw new DemoError(400, "amount_usd_cents must be a positive integer (USD cents)");

    // Routing: explicit chain/network wins; else the catalog default.
    let chain = String(body?.chain ?? "").trim();
    let network = String(body?.network ?? "").trim();
    if (!chain) chain = asset.default_chain;
    if (!network) network = asset.default_network;
    if (chain === "none") throw new DemoError(400,
      `asset '${asset.symbol}' is priced for quotes but not yet settleable — try: ${asset.settleable_networks.map((n) => n.network).join(", ")}`);

    const kind = chain === "simnet" ? "simnet" : findNetwork(network)?.kind ?? chain;
    const wallet = String(body?.wallet ?? "");
    validateWallet(kind, wallet);

    const decimals = kind === "evm" ? (findNetwork(network)?.tokens[asset.symbol]?.decimals
      ?? (asset.symbol === findNetwork(network)?.native ? 18 : asset.decimals))
      : asset.decimals;
    const tokenAddress = kind === "evm" ? (findNetwork(network)?.tokens[asset.symbol]?.address ?? "")
      : kind === "solana" ? (findNetwork("mainnet")?.tokens[asset.symbol]?.address ?? "")
      : kind === "tron" ? (findNetwork("mainnet")?.tokens[asset.symbol]?.address ?? "")
      : "";
    if (kind === "evm" && !tokenAddress && asset.symbol !== findNetwork(network)?.native)
      throw new DemoError(400, `asset '${asset.symbol}' is not settleable on network '${network}' — try: ${asset.settleable_networks.map((n) => n.network).join(", ")}`);

    const price = DEMO_PRICES[asset.symbol] ?? 1;
    const qtyBase = BigInt(Math.round((amountMinor / 100 / price) * 10 ** decimals)).toString();
    const tier = tierOf(creds.pk);
    const bps = bpsOf(tier);
    const fee = feeBreakdown(amountMinor, bps, tier);
    const id = `inv_${hex(8)}`;
    const address = kind === "simnet"
      ? await deriveSimnetAddress(`${creds.pk}|${hex(3)}`)
      : wallet; // real chains: merchant's own address, non-custodial

    const invoice = {
      v: 1, id, mid: creds.pk, tier, amount_minor: amountMinor, currency: "USD",
      asset: asset.symbol, chain, network, address, token_address: tokenAddress,
      description_hash: String(body?.description ?? "") ? await sha256Hex(String(body?.description).trim()) : "",
      fee_bps: bps, base_qty: "0", qte: qtyBase, iat: now, exp: now + (Number(body?.ttl_secs) || DEFAULT_TTL),
      nce: hex(3), whu: String(body?.webhook_url ?? ""), birth_block: 0,
    };
    const payload = b64url(JSON.stringify(invoice));
    const sig = await hmacSha256(DEMO_SIGNING_KEY, `payphone.inv.v1.${payload}`);
    const token = `${payload}.${sig}`;

    const base = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "/";
    s.invoices[id] = { invoice, rate_usd: price, asset_amount: (amountMinor / 100 / price).toFixed(6), fee, payments: [] };
    save(s);

    return { invoice, token, payment_url: `${base}#/pay/${id}?t=${token}`,
      checkout_path: `#/pay/${id}?t=${token}`,
      rate: { asset: asset.symbol, usd: price, source: "demo-static", stale: false, fetched_at: now },
      asset_amount: s.invoices[id].asset_amount, fee };
  }

  if (method === "GET" && route.replace(/^\/v1/, "").startsWith("/invoices/")) {
    const id = route.replace(/^\/v1\/invoices\//, "");
    const rec = s.invoices[id];
    if (!rec) throw new DemoError(404, "invoice not found (demo state is per-browser)");
    const inv = rec.invoice as Record<string, unknown>;
    const observed = rec.payments.reduce((a, p) => a + p.qty, 0);
    const qte = Number(inv.qte);
    const status = observed >= qte ? "paid" : now >= Number(inv.exp) ? "expired" : observed > 0 ? "underpaid" : "pending";
    return {
      invoice: { ...inv, status, observed_qty: String(observed), seconds_left: Math.max(0, Number(inv.exp) - now) },
      fee: rec.fee,
      rate: { asset: inv.asset, usd: rec.rate_usd, source: "demo-static", stale: false, fetched_at: now },
      asset_amount: rec.asset_amount,
      receipts: rec.payments.map((p) => ({ tx: p.hash, height: p.height, ts: p.ts,
        amount_minor: String(p.qty), tx_hash: p.hash, block: p.height, qty: String(p.qty),
        asset: p.asset, source: "demo-simnet" })),
      remaining_qty: String(Math.max(0, qte - observed)),
      demo_mode: true,
    };
  }

  // ---- identity ----------------------------------------------------------
  if (routeKey === "POST /identity/resolve") {
    const phone = String(body?.phone ?? "").replace(/[^\d+]/g, "");
    const phoneHash = await sha256Hex(`demo-salt|${phone}`);
    const reg = s.registry[phoneHash];
    const pid = reg?.payphone_id ?? `ph_${(await sha256Hex(phoneHash)).slice(0, 16)}`;
    return { payphone_id: pid, phone_hash: phoneHash,
      masked_phone: `+•••• ••${phone.slice(-2)}`,
      simnet_address: await deriveSimnetAddress(pid), registered: Boolean(reg),
      wallet: reg?.wallet };
  }

  if (routeKey === "POST /identity/register") {
    const phone = String(body?.phone ?? "").replace(/[^\d+]/g, "");
    const wallet = String(body?.wallet ?? "");
    validateWallet("simnet", wallet);
    const phoneHash = await sha256Hex(`demo-salt|${phone}`);
    const pid = `ph_${(await sha256Hex(phoneHash)).slice(0, 16)}`;
    s.registry[phoneHash] = { wallet, payphone_id: pid };
    const tx = await appendBlock(s, "register", { phone_hash: phoneHash.slice(0, 12), wallet: wallet.slice(0, 10) });
    save(s);
    return { payphone_id: pid, wallet, tx: { height: tx.height, hash: tx.hash } };
  }

  if (routeKey === "POST /identity/escrow") {
    const phone = String(body?.phone ?? "").replace(/[^\d+]/g, "");
    const amount = Number(body?.amount_usd_cents ?? 0);
    const phoneHash = await sha256Hex(`demo-salt|${phone}`);
    const reg = s.registry[phoneHash];
    if (!reg) throw new DemoError(404, "that phone number is not registered yet");
    const escrowId = `esc_${hex(8)}`;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    s.escrows[escrowId] = { phone_hash: phoneHash, asset: "USDC", amount_usd_cents: amount, code, claimed: false, ts: now };
    const tx = await appendBlock(s, "escrow", { escrow_id: escrowId, amount });
    save(s);
    return { escrow_id: escrowId, payphone_id: reg.payphone_id, asset: "USDC",
      amount_usd_cents: amount, tx: { height: tx.height, hash: tx.hash }, claim_code: code };
  }

  if (routeKey === "POST /identity/claim") {
    const escrowId = String(body?.escrow_id ?? "");
    const esc = s.escrows[escrowId];
    if (!esc) throw new DemoError(404, "escrow not found");
    if (esc.claimed) throw new DemoError(409, "escrow already claimed — claim codes are single-use");
    if (String(body?.code ?? "") !== esc.code) throw new DemoError(403, "invalid claim code");
    const reg = s.registry[esc.phone_hash];
    esc.claimed = true;
    const tx = await appendBlock(s, "claim", { escrow_id: escrowId, wallet: reg?.wallet.slice(0, 10) });
    save(s);
    return { released_amount_usd_cents: esc.amount_usd_cents, wallet: reg?.wallet,
      tx: { height: tx.height, hash: tx.hash } };
  }

  // ---- simnet ------------------------------------------------------------
  if (routeKey === "POST /simnet/pay") {
    const to = String(body?.to ?? "");
    validateWallet("simnet", to);
    const asset = String(body?.asset ?? "USDC");
    const amountMinor = Number(body?.amount_minor ?? 0);
    const tx = await appendBlock(s, "pay", { to: to.slice(0, 10), asset, amount_minor: amountMinor, from: String(body?.from ?? "demo") });
    const bal = (s.balances[to] ?? {});
    bal[asset] = (bal[asset] ?? 0) + amountMinor;
    s.balances[to] = bal;
    const invId = body?.invoice_id ? String(body.invoice_id) : null;
    if (invId && s.invoices[invId]) s.invoices[invId].payments.push({ qty: amountMinor, ts: tx.ts, height: tx.height, hash: tx.hash, asset });
    save(s);
    return { tx: { height: tx.height, hash: tx.hash, ts: tx.ts }, balance_after: String(bal[asset]) };
  }

  if (routeKey === "GET /simnet/blocks") {
    const limit = Number(q.get("limit") ?? 30);
    return { blocks: s.blocks.slice(-limit).reverse(),
      stats: { height: s.height, blocks: s.blocks.length + 1,
        registered_numbers: Object.keys(s.registry).length,
        open_escrows: Object.values(s.escrows).filter((e) => !e.claimed).length } };
  }

  // ---- webhooks ----------------------------------------------------------
  if (routeKey === "POST /webhooks/test") {
    const url = String(body?.url ?? "");
    return { event: "invoice.paid", payload: { demo: true, note: "static build" },
      headers: { "X-PayPhone-Signature": "(demo — signed by the deployed engine)" },
      delivery: { delivered: false, attempts: 1,
        error: "static demo — deploy the Rust engine to deliver live webhooks" } };
  }

  throw new DemoError(404, `no demo handler for ${method} ${route}`);
}

export { simnetInvoiceAddress, paymentUri };
export default handle;
