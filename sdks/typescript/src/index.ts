/**
 * PayPhone TypeScript SDK — thin, dependency-free client for the PayPhone
 * Engine. Implements request signing, invoice creation, status polling,
 * phone identity, conversion quotes and webhook verification.
 *
 * Works in Node 18+ (native fetch + crypto.webcrypto) and edge runtimes.
 *
 * ```ts
 * import { PayPhone } from "@payphone/sdk";
 * const pp = new PayPhone({ baseUrl: "https://api.payphone.example",
 *                           publicKey: "pk_growth_…", secretKey: "sk_growth_…" });
 * const inv = await pp.invoices.create({ amount_usd_cents: 2500, asset: "USDC",
 *   chain: "simnet", network: "simnet", wallet: "PP…" });
 * console.log(inv.payment_url);
 * ```
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export interface PayPhoneOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  /** Fetch timeout in ms (default 15000). */
  timeoutMs?: number;
}

export interface CreateInvoiceInput {
  amount_usd_cents: number;
  asset?: string;
  chain?: string;
  network?: string;
  wallet: string;
  token_address?: string;
  description?: string;
  ttl_secs?: number;
  webhook_url?: string;
}

export interface Invoice {
  v: number; id: string; mid: string; tier: string;
  amount_minor: number; currency: string; asset: string;
  chain: string; network: string; address: string; token_address: string;
  description_hash: string; fee_bps: number;
  base_qty: string; qte: string; iat: number; exp: number; nce: string; whu: string;
}

export interface CreateInvoiceResult {
  invoice: Invoice;
  token: string;
  payment_url: string;
  rate: { asset: string; usd: number; source: string; stale: boolean };
  asset_amount: string;
  fee: FeeBreakdown;
}

export interface FeeBreakdown {
  amount_minor: number; fee_total_minor: number; net_to_merchant_minor: number;
  bps: number; tier: string;
  split: { protocol_minor: number; referrer_minor: number; operations_minor: number };
}

export interface InvoiceStatusResult {
  invoice: Invoice & { status: "pending" | "paid" | "underpaid" | "expired"; seconds_left: number };
  fee: FeeBreakdown;
  asset_amount: string;
  receipts: { tx: string; height: number; ts: number; amount_minor: string }[];
  remaining_qty: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  api_version: string;
  created_at: number;
  data: Record<string, unknown>;
}

export class PayPhoneError extends Error {
  type: string;
  status: number;
  constructor(type: string, message: string, status: number) {
    super(message);
    this.name = "PayPhoneError";
    this.type = type;
    this.status = status;
  }
}

export class PayPhone {
  private readonly baseUrl: string;
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly timeoutMs: number;

  constructor(opts: PayPhoneOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.publicKey = opts.publicKey;
    this.secretKey = opts.secretKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;

    this.invoices = {
      create: (input) => this.request("POST", "/v1/invoices", input),
      get: (id, token) => this.request("GET", `/v1/invoices/${id}?token=${encodeURIComponent(token)}`),
    };
    this.identity = {
      resolve: (phone) => this.request("POST", "/v1/identity/resolve", { phone }),
      register: (phone, wallet) => this.request("POST", "/v1/identity/register", { phone, wallet }),
      escrow: (phone, amount_usd_cents) =>
        this.request("POST", "/v1/identity/escrow", { phone, amount_usd_cents }),
      claim: (escrow_id, phone, code) =>
        this.request("POST", "/v1/identity/claim", { escrow_id, phone, code }),
    };
    this.rates = (assets) => this.request("GET", `/v1/rates?assets=${encodeURIComponent(assets)}`);
    this.quote = (amount_usd_cents, asset) =>
      this.request("GET", `/v1/quote?amount_usd_cents=${amount_usd_cents}&asset=${asset}`);
    this.fees = {
      schedule: () => this.request("GET", "/v1/fees/schedule"),
      quote: (amount_usd_cents, tier) =>
        this.request("GET", `/v1/fees/quote?amount_usd_cents=${amount_usd_cents}&tier=${tier}`),
    };
    this.webhooks = { test: (url) => this.request("POST", "/v1/webhooks/test", { url }) };
  }

  readonly invoices: {
    create(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
    get(id: string, token: string): Promise<InvoiceStatusResult>;
  };

  readonly identity: {
    resolve(phone: string): Promise<{ payphone_id: string; registered: boolean; wallet?: string }>;
    register(phone: string, wallet: string): Promise<{ payphone_id: string; tx: { height: number } }>;
    escrow(phone: string, amount_usd_cents: number): Promise<{ escrow_id: string; claim_code: string }>;
    claim(escrow_id: string, phone: string, code: string): Promise<{ released_amount_usd_cents: number; wallet: string }>;
  };

  readonly rates: (assets: string) => Promise<{ rates: { asset: string; usd: number; stale: boolean }[] }>;
  readonly quote: (amount_usd_cents: number, asset: string) => Promise<Record<string, unknown>>;
  readonly fees: {
    schedule(): Promise<{ schedule: unknown[]; split: Record<string, number> }>;
    quote(amount_usd_cents: number, tier: string): Promise<{ fee: FeeBreakdown }>;
  };
  readonly webhooks: { test(url: string): Promise<Record<string, unknown>> };

  /** Build the exact signed headers the engine verifies. */
  private async signedHeaders(method: string, path: string, body: string | null) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const bodyHash = createHash("sha256").update(body ?? "").digest("hex");
    const canonical = `${ts}.${method.toUpperCase()}.${path}.${bodyHash}`;
    const signature = createHmac("sha256", this.secretKey).update(canonical).digest("hex");
    return {
      "X-PayPhone-Key": this.publicKey,
      "X-PayPhone-Timestamp": ts,
      "X-PayPhone-Signature": signature,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const raw = body !== undefined ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    Object.assign(headers, await this.signedHeaders(method, path, raw));

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: raw ?? undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = (await resp.json()) as
      | { data: T }
      | { error: { type: string; message: string; code: number } };

    if (!resp.ok || "error" in payload) {
      const err = (payload as { error?: { type?: string; message?: string } }).error;
      throw new PayPhoneError(err?.type ?? "unknown", err?.message ?? `HTTP ${resp.status}`, resp.status);
    }
    return (payload as { data: T }).data;
  }

  /**
   * Verify a webhook delivery. Compare against the raw request body
   * (before any JSON parsing) and the three X-PayPhone headers.
   */
  static verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
    /** Reject events older than this (default 300 s). */
    toleranceSecs = 300
  ): { valid: boolean; event: WebhookEvent | null; reason?: string } {
    const timestamp = String(headers["x-payphone-timestamp"] ?? "");
    const signature = String(headers["x-payphone-signature"] ?? "");
    if (!timestamp || !signature) return { valid: false, event: null, reason: "missing headers" };

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > toleranceSecs) {
      return { valid: false, event: null, reason: "timestamp outside tolerance" };
    }

    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${body}`).digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
    const valid = a.length === b.length && timingSafeEqual(a, b);
    let event: WebhookEvent | null = null;
    try {
      event = JSON.parse(body) as WebhookEvent;
    } catch {
      /* body not JSON — signature result stands */
    }
    return { valid, event, reason: valid ? undefined : "signature mismatch" };
  }
}

export default PayPhone;
