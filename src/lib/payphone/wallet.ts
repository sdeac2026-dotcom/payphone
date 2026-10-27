/**
 * PayPhone Wallet — a non-custodial, browser-resident EVM wallet.
 *
 * SECURITY MODEL (the promises this module makes, and keeps):
 *
 * 1. Keys are generated LOCALLY with the platform CSPRNG (viem/accounts —
 *    BIP-39 mnemonic, standard MetaMask-compatible path m/44'/60'/0'/0/0).
 * 2. The secret (mnemonic or raw private key) is encrypted with AES-GCM-256
 *    under a key derived from the user's passphrase (PBKDF2-SHA256, 310k
 *    iterations) and stored ONLY in this browser's localStorage.
 * 3. NOTHING in this module ever transmits key material — not to the
 *    PayPhone engine, not to any RPC. The engine literally has no field to
 *    receive one. Signing happens in memory, in this tab.
 * 4. Recovery truth: if the passphrase is lost, the keystore is unreadable;
 *    if the mnemonic is lost, the funds are unreachable. Nobody — not the
 *    operator, not us — can recover it. That is the point of non-custodial.
 *
 * REVENUE MODEL (why the wallet exists):
 * - Transfers to a PayPhone phone-number identity (the closed loop) settle
 *   with ZERO protocol fee — network gravity: every user wants the other
 *   side on PayPhone.
 * - Transfers to an external 0x… address carry a transparent protocol fee
 *   (WALLET_SEND_FEE_BPS), settled as its own on-chain transaction to the
 *   operator treasury published by GET /v1/fees/schedule. Two transfers,
 *   two hashes, fully visible before signing.
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type Chain,
  type LocalAccount,
} from "viem";
import { erc20Abi } from "viem";
import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  optimism,
  polygon,
  worldchain,
} from "viem/chains";
import { api } from "./api";

// ------------------------------------------------------------------ chains --

/** Wallet-enabled networks: engine names → viem chains + vetted public RPCs. */
export interface WalletChain {
  name: string;
  label: string;
  chain: Chain;
  rpc: string;
  native: string;
  explorer: string;
}

export const WALLET_CHAINS: WalletChain[] = [
  {
    name: "worldchain",
    label: "Worldchain",
    chain: worldchain,
    rpc: "https://worldchain-mainnet.g.alchemy.com/public",
    native: "ETH",
    explorer: "https://worldscan.org",
  },
  {
    name: "base",
    label: "Base",
    chain: base,
    rpc: "https://mainnet.base.org",
    native: "ETH",
    explorer: "https://basescan.org",
  },
  {
    name: "optimism",
    label: "OP Mainnet",
    chain: optimism,
    rpc: "https://mainnet.optimism.io",
    native: "ETH",
    explorer: "https://optimistic.etherscan.io",
  },
  {
    name: "polygon",
    label: "Polygon",
    chain: polygon,
    rpc: "https://polygon-bor-rpc.publicnode.com",
    native: "POL",
    explorer: "https://polygonscan.com",
  },
  {
    name: "arbitrum",
    label: "Arbitrum One",
    chain: arbitrum,
    rpc: "https://arb1.arbitrum.io/rpc",
    native: "ETH",
    explorer: "https://arbiscan.io",
  },
  {
    name: "bsc",
    label: "BNB Chain",
    chain: bsc,
    rpc: "https://bsc-rpc.publicnode.com",
    native: "BNB",
    explorer: "https://bscscan.com",
  },
  {
    name: "avalanche",
    label: "Avalanche",
    chain: avalanche,
    rpc: "https://avalanche-c-chain-rpc.publicnode.com",
    native: "AVAX",
    explorer: "https://snowtrace.io",
  },
];

export function walletChain(name: string): WalletChain | undefined {
  return WALLET_CHAINS.find((c) => c.name === name);
}

// ------------------------------------------------------------------ config --

/** Protocol fee on EXTERNAL sends, in basis points (50 = 0.5%). */
export const WALLET_SEND_FEE_BPS = 50n;
const PBKDF2_ITERATIONS = 310_000;
const KEYSTORE_KEY = "payphone.wallet.keystore.v1";
const ACTIVITY_KEY = "payphone.wallet.activity.v1";

// ---------------------------------------------------------------- keystore --

interface Keystore {
  v: 1;
  kind: "mnemonic" | "key";
  address: string;
  createdAt: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-GCM-256";
  salt: string; // hex
  iv: string; // hex
  ct: string; // hex — encrypted secret
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function keystoreLoad(): Keystore | null {
  try {
    const raw = localStorage.getItem(KEYSTORE_KEY);
    return raw ? (JSON.parse(raw) as Keystore) : null;
  } catch {
    return null;
  }
}

function keystoreSave(k: Keystore): void {
  localStorage.setItem(KEYSTORE_KEY, JSON.stringify(k));
}

export function walletExists(): boolean {
  return keystoreLoad() !== null;
}

export function walletAddressStored(): string | null {
  return keystoreLoad()?.address ?? null;
}

async function encryptSecret(secret: string, passphrase: string): Promise<Omit<Keystore, "v" | "kind" | "address" | "createdAt">> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(secret));
  return {
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    cipher: "AES-GCM-256",
    salt: toHex(salt),
    iv: toHex(iv),
    ct: toHex(new Uint8Array(ct)),
  };
}

/**
 * Create a fresh wallet. Returns the mnemonic EXACTLY ONCE for the user to
 * write down — it is not stored in plaintext anywhere and cannot be shown
 * again later (only re-encrypted export from the unlocked keystore).
 */
export async function walletCreate(passphrase: string): Promise<{ address: string; mnemonic: string }> {
  const mnemonic = generateMnemonic(english, 128);
  const account = mnemonicToAccount(mnemonic);
  const enc = await encryptSecret(mnemonic, passphrase);
  keystoreSave({ v: 1, kind: "mnemonic", address: account.address, createdAt: Date.now(), ...enc });
  return { address: account.address, mnemonic };
}

/** Import an existing BIP-39 mnemonic (MetaMask/Rabby-compatible path). */
export async function walletImportMnemonic(mnemonic: string, passphrase: string): Promise<string> {
  const words = mnemonic.trim().split(/\s+/).join(" ");
  if (words.split(" ").length < 12) throw new Error("That doesn't look like a mnemonic phrase (need 12+ words).");
  const account = mnemonicToAccount(words);
  const enc = await encryptSecret(words, passphrase);
  keystoreSave({ v: 1, kind: "mnemonic", address: account.address, createdAt: Date.now(), ...enc });
  return account.address;
}

/** Import an existing raw private key (0x…). */
export async function walletImportPrivateKey(pk: string, passphrase: string): Promise<string> {
  const key = pk.trim().toLowerCase().startsWith("0x") ? pk.trim() : `0x${pk.trim()}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const enc = await encryptSecret(key, passphrase);
  keystoreSave({ v: 1, kind: "key", address: account.address, createdAt: Date.now(), ...enc });
  return account.address;
}

// ------------------------------------------------------------------ unlock --

let unlockedAccount: LocalAccount | null = null;

export function walletIsUnlocked(): boolean {
  return unlockedAccount !== null;
}

export function walletAddress(): string | null {
  return unlockedAccount?.address ?? null;
}

/** Decrypt the keystore and hold the account in memory (never persisted). */
export async function walletUnlock(passphrase: string): Promise<string> {
  const ks = keystoreLoad();
  if (!ks) throw new Error("No wallet found on this device.");
  const key = await deriveKey(passphrase, fromHex(ks.salt), ks.iterations);
  let plain: string;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(ks.iv) as BufferSource },
      key,
      fromHex(ks.ct) as BufferSource
    );
    plain = new TextDecoder().decode(pt);
  } catch {
    throw new Error("Wrong passphrase.");
  }
  unlockedAccount =
    ks.kind === "mnemonic"
      ? mnemonicToAccount(plain.trim())
      : privateKeyToAccount(plain.trim() as `0x${string}`);
  return unlockedAccount.address;
}

export function walletLock(): void {
  unlockedAccount = null;
}

/** Reveal the secret (mnemonic or key). Requires the passphrase again. */
export async function walletRevealSecret(passphrase: string): Promise<string> {
  const ks = keystoreLoad();
  if (!ks) throw new Error("No wallet found on this device.");
  const key = await deriveKey(passphrase, fromHex(ks.salt), ks.iterations);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(ks.iv) as BufferSource },
      key,
      fromHex(ks.ct) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

export function walletDestroy(): void {
  unlockedAccount = null;
  localStorage.removeItem(KEYSTORE_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
}

function requireAccount(): LocalAccount {
  if (!unlockedAccount) throw new Error("Wallet is locked.");
  return unlockedAccount;
}

function clients(c: WalletChain) {
  const transport = http(c.rpc);
  const publicClient = createPublicClient({ chain: c.chain, transport });
  const walletClient = createWalletClient({ chain: c.chain, transport, account: requireAccount() });
  return { publicClient, walletClient };
}

// ---------------------------------------------------------------- balances --

export interface TokenBalance {
  symbol: string;
  decimals: number;
  balance: string; // human-readable
  address?: string; // undefined = native
}

export async function walletBalances(c: WalletChain): Promise<TokenBalance[]> {
  const account = requireAccount();
  const { publicClient } = clients(c);
  const out: TokenBalance[] = [];
  const native = await publicClient.getBalance({ address: account.address });
  out.push({ symbol: c.native, decimals: 18, balance: formatUnits(native, 18) });
  // Tokens come live from the engine's chain sheet (single source of truth).
  try {
    const sheet = await api.chains();
    const net = sheet.networks.find((n) => n.name === c.name);
    for (const t of net?.settleable_tokens ?? []) {
      try {
        const raw = (await publicClient.readContract({
          address: t.address as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        })) as bigint;
        out.push({ symbol: t.symbol, decimals: t.decimals, balance: formatUnits(raw, t.decimals), address: t.address });
      } catch {
        /* token read failed (RPC hiccup) — skip, never block the sheet */
      }
    }
  } catch {
    /* engine offline — native balance still shown */
  }
  return out;
}

// ------------------------------------------------------------------- fees --

export interface FeePreview {
  internal: boolean;
  bps: bigint;
  feeQty: bigint; // in base units of the asset
  treasury: string | null;
}

/**
 * Protocol fee for a send. Internal (phone-number) transfers are FREE —
 * that is the closed loop. External sends carry WALLET_SEND_FEE_BPS routed
 * to the operator treasury (from the engine's public fee schedule).
 */
export async function feePreview(amountQty: bigint, internal: boolean): Promise<FeePreview> {
  let treasury: string | null = null;
  try {
    treasury = (await api.feeSchedule()).treasury ?? null;
  } catch {
    /* engine offline — fee still computed, routed when it returns */
  }
  const bps = internal ? 0n : WALLET_SEND_FEE_BPS;
  const feeQty = internal ? 0n : (amountQty * bps) / 10_000n;
  return { internal, bps, feeQty, treasury };
}

// -------------------------------------------------------------- recipients --

export type Recipient =
  | { kind: "internal"; address: string; payphoneId: string; maskedPhone: string; registered: boolean }
  | { kind: "external"; address: string };

/**
 * Resolve any recipient: a phone number (+254…) → PayPhone identity
 * (fee-free loop), or a raw 0x… address (external, protocol fee).
 */
export async function resolveRecipient(input: string): Promise<Recipient> {
  const v = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return { kind: "external", address: v };
  if (v.startsWith("+") || /^[0-9][0-9 ()-]{5,}$/.test(v)) {
    const res = await api.identityLookup(v);
    const address = res.wallet ?? res.simnet_address;
    return {
      kind: "internal",
      address,
      payphoneId: res.payphone_id,
      maskedPhone: res.masked_phone,
      registered: res.registered,
    };
  }
  throw new Error("Recipient must be a phone number (+254…) or a 0x… address.");
}

// ------------------------------------------------------------------- send --

export interface SendRequest {
  network: string; // engine network name
  asset: string; // symbol — native symbol or a settleable token
  recipientInput: string; // phone or 0x…
  amount: string; // human-readable
}

export interface SendResult {
  resolved: Recipient;
  fee: FeePreview;
  txs: { hash: string; role: "payment" | "fee"; to: string; qty: string }[];
  explorerUrl?: string;
}

function requireChain(network: string): WalletChain {
  const c = walletChain(network);
  if (!c) throw new Error(`Wallet does not support the "${network}" network yet (EVM only — BTC/SOL/TRON pending).`);
  return c;
}

function requireToken(c: WalletChain, asset: string, tokens: { symbol: string; address: string; decimals: number }[]) {
  const t = tokens.find((x) => x.symbol.toLowerCase() === asset.toLowerCase());
  if (!t) throw new Error(`${asset} is not settleable on ${c.label}.`);
  return t;
}

/**
 * Send funds. One on-chain payment transaction, plus — for external
 * recipients — one protocol-fee transaction to the treasury. Every step is
 * signed locally and broadcast through public RPCs.
 */
export async function walletSend(req: SendRequest): Promise<SendResult> {
  const c = requireChain(req.network);
  const account = requireAccount();
  const resolved = await resolveRecipient(req.recipientInput);
  const { publicClient, walletClient } = clients(c);

  // Resolve asset decimals from the engine's live chain sheet.
  const sheet = await api.chains();
  const net = sheet.networks.find((n) => n.name === c.name);
  if (!net) throw new Error(`Engine does not list ${c.label}.`);
  const isNative = req.asset.toLowerCase() === c.native.toLowerCase();
  const token = isNative ? undefined : requireToken(c, req.asset, net.settleable_tokens);
  const decimals = isNative ? 18 : token!.decimals;

  let amountQty: bigint;
  try {
    amountQty = parseUnits(req.amount.trim(), decimals);
  } catch {
    throw new Error("Amount is not a valid number.");
  }
  if (amountQty <= 0n) throw new Error("Amount must be positive.");

  const fee = await feePreview(amountQty, resolved.kind === "internal");
  const txs: SendResult["txs"] = [];

  // Pre-flight: balance must cover amount + fee (+ gas headroom for native).
  if (isNative && fee.feeQty > 0n && amountQty + fee.feeQty * 3n > (await publicClient.getBalance({ address: account.address }))) {
    throw new Error("Balance too low for amount + protocol fee + gas.");
  }

  if (isNative) {
    await sendNative(publicClient, walletClient, account, c, resolved.address as `0x${string}`, amountQty);
    txs.push({ hash: "pending", role: "payment", to: resolved.address, qty: req.amount });
  } else {
    await sendToken(publicClient, walletClient, account, c, token!.address as `0x${string}`, resolved.address as `0x${string}`, amountQty);
    txs.push({ hash: "pending", role: "payment", to: resolved.address, qty: req.amount });
  }

  // The fee is its own visible transaction to the operator treasury.
  if (fee.feeQty > 0n && fee.treasury) {
    const feeHuman = formatUnits(fee.feeQty, decimals);
    if (isNative) {
      await sendNative(publicClient, walletClient, account, c, fee.treasury as `0x${string}`, fee.feeQty);
    } else {
      await sendToken(publicClient, walletClient, account, c, token!.address as `0x${string}`, fee.treasury as `0x${string}`, fee.feeQty);
    }
    txs.push({ hash: "pending", role: "fee", to: fee.treasury, qty: feeHuman });
  }

  const result: SendResult = { resolved, fee, txs, explorerUrl: c.explorer };
  logActivity({
    ts: Date.now(),
    network: c.name,
    label: c.label,
    asset: req.asset,
    amount: req.amount,
    to: resolved.address,
    internal: resolved.kind === "internal",
    feeQty: fee.feeQty > 0n ? formatUnits(fee.feeQty, decimals) : "0",
  });
  return result;
}

async function sendNative(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: LocalAccount,
  c: WalletChain,
  to: `0x${string}`,
  qty: bigint
): Promise<string> {
  const [nonce, gas, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.estimateGas({ account: account.address, to, value: qty }),
    publicClient.estimateFeesPerGas(),
  ]);
  return walletClient.sendTransaction({
    to,
    value: qty,
    gas,
    nonce,
    account,
    chain: c.chain,
    maxFeePerGas: fees.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? undefined,
  });
}

async function sendToken(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: LocalAccount,
  c: WalletChain,
  token: `0x${string}`,
  to: `0x${string}`,
  qty: bigint
): Promise<string> {
  const [nonce, gas, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.estimateGas({ account: account.address, to: token, data: "0x" }),
    publicClient.estimateFeesPerGas(),
  ]);
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, qty],
    gas,
    nonce,
    account,
    chain: c.chain,
    maxFeePerGas: fees.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? undefined,
  });
  return hash;
}

// ---------------------------------------------------------------- activity --

export interface WalletActivity {
  ts: number;
  network: string;
  label: string;
  asset: string;
  amount: string;
  to: string;
  internal: boolean;
  feeQty: string;
}

export function activityLog(): WalletActivity[] {
  try {
    return JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? "[]") as WalletActivity[];
  } catch {
    return [];
  }
}

function logActivity(entry: WalletActivity): void {
  try {
    const all = activityLog();
    all.unshift(entry);
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(all.slice(0, 50)));
  } catch {
    /* storage full/unavailable — non-fatal */
  }
}
