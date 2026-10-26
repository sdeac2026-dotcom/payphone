/**
 * PayPhone API types — mirrored from the Rust engine (engine/src/*).
 * Keep in sync with `docs/API.md`.
 */

export interface FeeSplit {
  protocol_minor: number;
  referrer_minor: number;
  operations_minor: number;
}

export interface FeeBreakdown {
  amount_minor: number;
  fee_total_minor: number;
  net_to_merchant_minor: number;
  bps: number;
  tier: string;
  split: FeeSplit;
}

export interface Rate {
  asset: string;
  usd: number;
  source: string;
  stale: boolean;
  fetched_at: number;
}

export type InvoiceStatus = "pending" | "paid" | "underpaid" | "expired";

export interface Invoice {
  v: number;
  id: string;
  mid: string;
  tier: string;
  amount_minor: number;
  currency: string;
  asset: string;
  chain: string;
  network: string;
  address: string;
  token_address: string;
  description_hash: string;
  fee_bps: number;
  base_qty: number | string;
  qte: number | string;
  iat: number;
  exp: number;
  nce: string;
  whu: string;
}

export interface InvoiceWithStatus extends Invoice {
  status: InvoiceStatus;
  observed_qty: number | string;
  seconds_left: number;
}

export interface SimReceipt {
  tx: string;
  height: number;
  ts: number;
  amount_minor: string;
}

export interface EngineHealth {
  status: string;
  service: string;
  version: string;
  uptime_secs: number;
  demo_mode: boolean;
  simnet_enabled: boolean;
  simnet: { height: number; blocks: number; registered_numbers: number; open_escrows: number } | null;
  chains: { simnet: boolean; evm_networks: string[] };
  oracle_source: string;
  supported_assets: string[];
  rate_limit_per_min: number;
}

export interface SimBlock {
  height: number;
  ts: number;
  kind: "genesis" | "register" | "escrow" | "claim" | "pay";
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

export interface KeyIssue {
  public_key: string;
  secret_key: string;
  tier: string;
  fee_bps: number;
  warning: string;
}

export interface TierFee {
  tier: string;
  bps: number;
  included_volume_usd_cents: number | null;
  max_invoices_per_month: number;
  features: string[];
}

export interface FeeSchedule {
  schedule: TierFee[];
  split: { protocol_pct: number; referrer_pct: number; operations_pct: number };
}

/** Local record of an invoice created in this browser (dashboard history). */
export interface LocalInvoice {
  id: string;
  token: string;
  amount_usd: string;
  asset: string;
  chain: string;
  description: string;
  created_at: number;
  status: InvoiceStatus;
}
