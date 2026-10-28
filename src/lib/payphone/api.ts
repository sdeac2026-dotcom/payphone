/**
 * PayPhone browser API client.
 *
 * Implements the exact request-signing protocol the engine verifies
 * (`engine/src/keys.rs`) using WebCrypto — the same HMAC-SHA256 the
 * Rust engine and the SDKs use. All calls go through the same-origin
 * Next.js proxy at /api/v1/*, which forwards to the Rust engine.
 */

import type {
  EngineHealth,
  FeeBreakdown,
  FeeRecipient,
  FeeSchedule,
  Invoice,
  InvoiceWithStatus,
  KeyIssue,
  LocalInvoice,
  Rate,
  SimBlock,
} from "./types";
import demoHandle, { DemoError } from "./demo-engine";

/**
 * Static-demo build flag (`NEXT_PUBLIC_PAYPHONE_DEMO=1`, used only by the
 * GitHub-Pages export): every API call is answered by the in-browser demo
 * engine instead of the wire. Production builds never execute this branch.
 */
const DEMO = process.env.NEXT_PUBLIC_PAYPHONE_DEMO === "1";

const API = "";

export class ApiError extends Error {
  type: string;
  status: number;
  constructor(type: string, message: string, status: number) {
    super(message);
    this.type = type;
    this.status = status;
  }
}

async function unwrap<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = (body as { error?: { type?: string; message?: string } }).error;
    throw new ApiError(err?.type ?? "unknown", err?.message ?? `HTTP ${resp.status}`, resp.status);
  }
  return (body as { data: T }).data;
}

/** HMAC-SHA256 over the canonical signing string (WebCrypto, secure contexts). */
export async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build signed headers for an authenticated request. */
async function signRequest(
  method: string,
  path: string,
  body: string | null,
  creds: { pk: string; sk: string }
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(body ?? "");
  const canonical = `${ts}.${method.toUpperCase()}.${path}.${bodyHash}`;
  const signature = await hmacSha256(creds.sk, canonical);
  return {
    "X-PayPhone-Key": creds.pk,
    "X-PayPhone-Timestamp": ts,
    "X-PayPhone-Signature": signature,
  };
}

/**
 * In the sandbox preview, services other than the primary port are reached
 * through Caddy's `XTransformPort` query parameter. When the page itself was
 * loaded with that parameter, every same-origin API call must carry it too.
 */
function transportPath(path: string): string {
  if (typeof window === "undefined") return path;
  const m = window.location.search.match(/XTransformPort=(\d+)/);
  if (!m) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}XTransformPort=${m[1]}`;
}

/**
 * Call sites use engine paths ("/invoices", "/identity/resolve", …).
 * - The wire path is same-origin `/api/v1/…` (the Next.js gateway).
 * - The SIGNATURE canonical string always uses the ENGINE path (`/v1/…`),
 *   because that is what the engine verifies against.
 */
/**
 * Platform admin token (`PAYPHONE_ADMIN_TOKEN`).
 *
 * Production deployments gate `POST /v1/keys` behind an admin token so only
 * the platform operator can mint merchant credentials. The operator pastes
 * the token once in the dashboard; it is kept in localStorage and sent as
 * `X-Admin-Token` on key issuance. It never touches merchant signatures.
 */
const ADMIN_TOKEN_STORAGE = "payphone_admin_token";

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_STORAGE, token.trim());
  } catch {
    /* storage unavailable (private mode) — token is session-only then */
  }
}

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_STORAGE);
  } catch {
    return null;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  creds?: { pk: string; sk: string } | null,
  extraHeaders?: Record<string, string>
): Promise<T> {
  if (DEMO) {
    try {
      return (await demoHandle(method, path, (body as Record<string, unknown>) ?? null, creds ?? null)) as T;
    } catch (e) {
      if (e instanceof DemoError) throw new ApiError("demo_error", e.message, e.status);
      throw e;
    }
  }
  const enginePath = path.startsWith("/v1") ? path : `/v1${path}`;
  const wirePath = `/api${enginePath}`;
  const raw = body !== undefined ? JSON.stringify(body) : null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (creds) Object.assign(headers, await signRequest(method, enginePath, raw, creds));
  const resp = await fetch(transportPath(wirePath), {
    method,
    headers,
    body: raw ?? undefined,
    cache: "no-store",
  });
  return unwrap<T>(resp);
}

// ---------------------------------------------------------------- public ----

export const api = {
  engineHealth: () => request<EngineHealth>("GET", "/health").catch(() => null),

  /** Live multi-network capability sheet (real mainnets + demo simnet). */
  chains: () =>
    request<{
      networks: {
        name: string;
        kind: string;
        chain_id: number | null;
        native_asset: string;
        settleable_tokens: { symbol: string; address: string; decimals: number }[];
        confirmations_required: number;
        explorer_tx: string | null;
        rpc_source: string;
        probe: { rpc_live?: boolean; chain_id_matches?: boolean; note?: string };
      }[];
      count: number;
      note: string;
    }>("GET", "/chains"),

  rates: (assets: string) =>
    request<{ rates: Rate[] }>("GET", `/rates?assets=${encodeURIComponent(assets)}`),

  // Full invoice-able asset catalog with per-asset default routing
  // (asset-first invoicing: the merchant names the asset, the engine picks
  // the settlement venue — see GET /v1/assets).
  assets: () =>
    request<{
      assets: {
        symbol: string;
        name: string;
        decimals: number;
        default_chain: string;
        default_network: string;
        settleable: boolean;
        settleable_networks: { chain: string; network: string }[];
      }[];
      count: number;
      settleable_count: number;
      note: string;
    }>("GET", "/assets"),

  feeSchedule: () => request<FeeSchedule>("GET", "/fees/schedule"),

  feeQuote: (amount_usd_cents: number, tier: string) =>
    request<{ fee: FeeBreakdown }>("GET", `/fees/quote?amount_usd_cents=${amount_usd_cents}&tier=${tier}`),

  quote: (amount_usd_cents: number, asset: string) =>
    request<Record<string, unknown>>("GET", `/quote?amount_usd_cents=${amount_usd_cents}&asset=${asset}`),

  // ------------------------------------------------------------ merchant ----

  issueKey: (tier: string) => {
    const admin = getAdminToken();
    return request<KeyIssue>(
      "POST",
      "/keys",
      { tier },
      null,
      admin ? { "X-Admin-Token": admin } : undefined
    );
  },

  createInvoice: (
    input: {
      amount_usd_cents: number;
      asset: string;
      chain: string;
      network: string;
      wallet: string;
      description?: string;
      webhook_url?: string;
    },
    creds: { pk: string; sk: string }
  ) =>
    request<{ invoice: Invoice; token: string; payment_url: string; checkout_path: string; rate: Rate; asset_amount: string; fee: FeeBreakdown; fee_recipient: FeeRecipient | null }>(
      "POST",
      "/invoices",
      input,
      creds
    ),

  invoiceStatus: (id: string, token: string) =>
    request<{
      invoice: InvoiceWithStatus;
      fee: FeeBreakdown;
      fee_recipient: FeeRecipient | null;
      rate: Rate | null;
      asset_amount: string;
      receipts: {
        tx?: string; height?: number; ts?: number; amount_minor?: string;
        tx_hash?: string; block?: number; qty?: string; asset?: string;
        confirmations?: number; required_confirmations?: number;
        confirmed?: boolean; explorer_url?: string; source?: string;
      }[];
      remaining_qty: string;
      demo_mode: boolean;
    }>("GET", `/invoices/${id}?token=${encodeURIComponent(token)}`),

  // -------------------------------------------------------------- identity ---

  resolvePhone: (phone: string, creds: { pk: string; sk: string }) =>
    request<{
      payphone_id: string;
      phone_hash: string;
      masked_phone: string;
      simnet_address: string;
      registered: boolean;
      wallet?: string;
    }>("POST", "/identity/resolve", { phone }, creds),

  /**
   * PUBLIC phone → payment-address resolution (no merchant keys needed).
   * Powers the PayPhone Wallet's fee-free phone-number loop: any client can
   * resolve "pay +254…" to the recipient's address without an account.
   */
  identityLookup: (phone: string) =>
    request<{
      payphone_id: string;
      masked_phone: string;
      simnet_address: string;
      registered: boolean;
      wallet: string | null;
    }>("POST", "/identity/lookup", { phone }),

  registerPhone: (phone: string, wallet: string, creds: { pk: string; sk: string }) =>
    request<{ payphone_id: string; wallet: string; tx: { height: number; hash: string } }>(
      "POST",
      "/identity/register",
      { phone, wallet },
      creds
    ),

  createEscrow: (phone: string, amount_usd_cents: number, creds: { pk: string; sk: string }) =>
    request<{
      escrow_id: string;
      payphone_id: string;
      asset: string;
      amount_usd_cents: number;
      tx: { height: number; hash: string };
      claim_code: string;
    }>("POST", "/identity/escrow", { phone, amount_usd_cents }, creds),

  claimEscrow: (escrow_id: string, phone: string, code: string) =>
    request<{ released_amount_usd_cents: number; wallet: string; tx: { height: number; hash: string } }>(
      "POST",
      "/identity/claim",
      { escrow_id, phone, code }
    ),

  // --------------------------------------------------------------- wallet ----

  /**
   * PUBLIC incoming-transfer feed ("money radar"): everything that landed
   * on `address` on `network` inside the trailing block window — every
   * settleable token, real tx hashes, sender, confirmation state, explorer
   * links. No merchant keys required (same public posture as identity
   * lookup); the engine only reads public chain data.
   */
  walletActivity: (network: string, address: string, blocks = 1500) =>
    request<{
      network: string;
      chain_id: number;
      address: string;
      window_blocks: number;
      native_asset: string;
      native_balance: string;
      confirmations_required: number;
      incoming: {
        asset: string;
        qty: string;
        from: string;
        tx_hash: string;
        block: number;
        confirmations: number;
        required_confirmations: number;
        confirmed: boolean;
        status: string;
        explorer_url: string;
      }[];
      incoming_count: number;
      note: string;
    }>(
      "GET",
      `/wallet/activity?network=${encodeURIComponent(network)}&address=${encodeURIComponent(address)}&blocks=${blocks}`
    ),

  // --------------------------------------------------------------- simnet ----

  simnetPay: (input: { to: string; asset: string; amount_minor: number; invoice_id?: string; from?: string; token?: string }) =>
    request<{
      tx: { height: number; hash: string; ts: number };
      fee_tx: { height: number; hash: string; ts: number; to: string; asset: string; qty: string } | null;
      balance_after: string;
    }>(
      "POST",
      "/simnet/pay",
      input
    ),

  simnetBlocks: (limit = 30) =>
    request<{ blocks: SimBlock[]; stats: { height: number; blocks: number; registered_numbers: number; open_escrows: number } }>(
      "GET",
      `/simnet/blocks?limit=${limit}`
    ),

  webhookTest: (url: string, creds: { pk: string; sk: string }) =>
    request<{
      event: string;
      payload: Record<string, unknown>;
      headers: Record<string, string>;
      delivery: { delivered: boolean; attempts?: number; status?: number; error?: string };
    }>("POST", "/webhooks/test", { url }, creds),
};

// --------------------------------------------------------------- storage ----

const LS_MERCHANT = "payphone.merchant.v1";
const LS_INVOICES = "payphone.invoices.v1";

export interface MerchantSession {
  pk: string;
  sk: string;
  tier: string;
  wallet: string;
  webhook_url: string;
  created_at: number;
}

/**
 * Demo-mode merchant session lives in localStorage — in production the
 * secret key never touches the browser; keys live in your server env.
 * This is explicit demo tooling, documented as such.
 *
 * Mutations dispatch a `payphone:session` event so React components can
 * subscribe via useSyncExternalStore (the correct idiom for localStorage).
 */
export const SESSION_EVENT = "payphone:session";
export const INVOICES_EVENT = "payphone:invoices";

function notify(event: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(event));
}

export const session = {
  /** Raw snapshot for useSyncExternalStore (stable string identity). */
  raw(): string | null {
    try {
      return localStorage.getItem(LS_MERCHANT);
    } catch {
      return null;
    }
  },
  /** Subscribe to session changes (same-tab + cross-tab). */
  subscribe(cb: () => void): () => void {
    const handler = () => cb();
    window.addEventListener("storage", handler);
    window.addEventListener(SESSION_EVENT, handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(SESSION_EVENT, handler);
    };
  },
  load(): MerchantSession | null {
    try {
      const raw = localStorage.getItem(LS_MERCHANT);
      return raw ? (JSON.parse(raw) as MerchantSession) : null;
    } catch {
      return null;
    }
  },
  save(s: MerchantSession) {
    localStorage.setItem(LS_MERCHANT, JSON.stringify(s));
    notify(SESSION_EVENT);
  },
  clear() {
    localStorage.removeItem(LS_MERCHANT);
    notify(SESSION_EVENT);
  },
  patch(p: Partial<MerchantSession>) {
    const cur = session.load();
    if (cur) session.save({ ...cur, ...p });
  },
};

export const invoiceStore = {
  raw(): string | null {
    try {
      return localStorage.getItem(LS_INVOICES);
    } catch {
      return null;
    }
  },
  subscribe(cb: () => void): () => void {
    const handler = () => cb();
    window.addEventListener("storage", handler);
    window.addEventListener(INVOICES_EVENT, handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(INVOICES_EVENT, handler);
    };
  },
  all(): LocalInvoice[] {
    try {
      return JSON.parse(localStorage.getItem(LS_INVOICES) ?? "[]") as LocalInvoice[];
    } catch {
      return [];
    }
  },
  add(inv: LocalInvoice) {
    const all = [inv, ...invoiceStore.all()].slice(0, 100);
    localStorage.setItem(LS_INVOICES, JSON.stringify(all));
    notify(INVOICES_EVENT);
  },
  updateStatus(id: string, status: LocalInvoice["status"]) {
    const all = invoiceStore.all().map((i) => (i.id === id ? { ...i, status } : i));
    localStorage.setItem(LS_INVOICES, JSON.stringify(all));
    notify(INVOICES_EVENT);
  },
};

export function usd(minor: number): string {
  return `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortHash(h: string, n = 10): string {
  return h.length <= n * 2 ? h : `${h.slice(0, n)}…${h.slice(-4)}`;
}
