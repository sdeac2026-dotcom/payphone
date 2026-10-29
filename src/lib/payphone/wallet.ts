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
  encodeFunctionData,
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
  localStorage.removeItem(GUARDIAN_KEY);
}

function requireAccount(): LocalAccount {
  if (!unlockedAccount) throw new Error("Wallet is locked.");
  return unlockedAccount;
}

// --------------------------------------------------------------- backup ----

const BACKUP_FORMAT = "payphone-wallet-backup";

/** The file produced by "Download encrypted backup" — safe for cloud drives. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  address: string;
  created_at: number;
  keystore: Keystore;
  note: string;
}

/**
 * Export the ENCRYPTED keystore as a portable backup file. The secret stays
 * encrypted (AES-GCM-256 under the user's passphrase) — the file is inert
 * without that passphrase, so uploading it to Google Drive / iCloud / a USB
 * stick leaks nothing.
 */
export function walletExportBackup(): BackupFile {
  const ks = keystoreLoad();
  if (!ks) throw new Error("No wallet found on this device.");
  return {
    format: BACKUP_FORMAT,
    version: 1,
    address: ks.address,
    created_at: ks.createdAt,
    keystore: ks,
    note:
      "This file holds your wallet's secret ENCRYPTED with your PayPhone passphrase. " +
      "Without that passphrase it is useless to anyone. To restore: PayPhone Wallet > " +
      "Import > 'Restore from backup file'. Your 12-word recovery phrase remains the master key.",
  };
}

/**
 * Restore from a backup file. The passphrase is PROVEN against the file's
 * ciphertext BEFORE anything is installed — a wrong passphrase changes
 * nothing on the device.
 */
export async function walletRestoreFromBackup(file: unknown, passphrase: string): Promise<string> {
  const b = file as Partial<BackupFile>;
  const ks = b?.keystore;
  if (!b || b.format !== BACKUP_FORMAT || !ks || typeof ks.ct !== "string" || typeof ks.salt !== "string") {
    throw new Error("That file is not a PayPhone wallet backup.");
  }
  const key = await deriveKey(passphrase, fromHex(ks.salt), ks.iterations);
  try {
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(ks.iv) as BufferSource },
      key,
      fromHex(ks.ct) as BufferSource
    );
  } catch {
    throw new Error("Wrong passphrase for this backup file.");
  }
  keystoreSave(ks);
  return ks.address;
}

// ------------------------------------------------------------- guardian ----

const GUARDIAN_KEY = "payphone.wallet.guardian.v1";

/**
 * Guardian recovery — the three-key safety net for people who lose things:
 *
 *   Key 1: the 12-word phrase (paper — the master key)
 *   Key 2: the encrypted backup file (cloud — pairs with the passphrase)
 *   Key 3: the Guardian envelope (the network — pairs with phone + code
 *          + a separate recovery passphrase)
 *
 * The envelope is the wallet secret encrypted IN THIS BROWSER under the
 * recovery passphrase and uploaded to the engine. The engine stores
 * ciphertext, a salted phone hash, and a hashed recovery code — it can
 * never decrypt what it holds, so non-custodial promises stay intact.
 */
export interface GuardianEnvelope {
  v: 1;
  kind: "mnemonic" | "key";
  kdf: string;
  iterations: number;
  cipher: string;
  salt: string;
  iv: string;
  ct: string;
}

export interface GuardianStatus {
  recoveryId: string;
  address: string;
  enrolledAt: number;
}

/** Device-local reminder that the wallet is enrolled (NOT a secret). */
export function guardianLocalStatus(): GuardianStatus | null {
  try {
    const raw = localStorage.getItem(GUARDIAN_KEY);
    return raw ? (JSON.parse(raw) as GuardianStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Generate the setup-time recovery code (XXXX-XXXX-XXXX, 48 bits of
 * CSPRNG). Shown exactly once; the user writes it down with their phone.
 */
export function guardianGenerateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Build the encrypted guardian envelope from the wallet's secret. */
export async function walletGuardianEnvelope(secret: string, recoveryPass: string): Promise<GuardianEnvelope> {
  const ks = keystoreLoad();
  if (!ks) throw new Error("No wallet found on this device.");
  const enc = await encryptSecret(secret, recoveryPass);
  return { v: 1, kind: ks.kind, ...enc };
}

/** Enroll: upload the zero-knowledge envelope and record a local reminder. */
export async function guardianEnroll(
  phone: string,
  recoveryCode: string,
  envelope: GuardianEnvelope
): Promise<GuardianStatus> {
  const address = walletAddressStored();
  if (!address) throw new Error("No wallet found on this device.");
  const res = await api.guardianRegister({
    phone,
    address,
    recovery_code: recoveryCode,
    envelope: JSON.stringify(envelope),
  });
  const status: GuardianStatus = { recoveryId: res.recovery_id, address, enrolledAt: Date.now() };
  localStorage.setItem(GUARDIAN_KEY, JSON.stringify(status));
  return status;
}

/** Claim the envelope (phone + recovery code). Passphrase stays client-side. */
export async function guardianClaim(phone: string, code: string): Promise<{ address: string; envelope: GuardianEnvelope }> {
  const res = await api.guardianClaim({ phone, recovery_code: code });
  let env: GuardianEnvelope;
  try {
    env = JSON.parse(res.envelope) as GuardianEnvelope;
  } catch {
    throw new Error("The recovery envelope on record is unreadable. Restore from your 12-word phrase, then re-enroll.");
  }
  return { address: res.address, envelope: env };
}

/** Decrypt a guardian envelope with the recovery passphrase (local only). */
export async function guardianDecrypt(env: GuardianEnvelope, recoveryPass: string): Promise<string> {
  const key = await deriveKey(recoveryPass, fromHex(env.salt), env.iterations);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(env.iv) as BufferSource },
      key,
      fromHex(env.ct) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Wrong recovery passphrase — the envelope would not open.");
  }
}

/**
 * Full Guardian restore: claim → decrypt → install as this device's
 * keystore under a NEW main passphrase. Works from a wiped browser.
 */
export async function guardianRestore(
  phone: string,
  code: string,
  recoveryPass: string,
  newPass: string
): Promise<string> {
  const { envelope } = await guardianClaim(phone, code);
  const secret = await guardianDecrypt(envelope, recoveryPass);
  return envelope.kind === "key" ? walletImportPrivateKey(secret, newPass) : walletImportMnemonic(secret, newPass);
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
  /** false = operator treasury not configured — the fee is WAIVED, visibly, never silently dropped. */
  treasuryConfigured: boolean;
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
  // Honest fee loop: the fee is collected ONLY when the operator treasury is
  // configured to receive it. Non-custodial means there is nowhere to hold a
  // fee "in escrow" — with no destination on-chain, the fee is waived, and the
  // UI says so, rather than pretending it was settled.
  const treasuryConfigured = treasury !== null;
  const feeQty = internal || !treasuryConfigured ? 0n : (amountQty * bps) / 10_000n;
  return { internal, bps, feeQty, treasury, treasuryConfigured };
}

// --------------------------------------------- gas preview & human errors --

export interface GasPreview {
  nativeSymbol: string;
  nativeBalance: string;
  feeQty: string; // human-readable native units
  affordable: boolean;
}

/**
 * Network-fee preview for the send card: what one transfer on this chain
 * costs in the native coin, and whether the wallet's native balance covers
 * it. Gas for an ERC-20 transfer barely varies with the amount (a native
 * transfer is a fixed 21 000), so estimating with a unit amount gives an
 * honest figure without re-estimating on every keystroke. Returns null when
 * the estimate is unavailable right now (RPC hiccup, empty token balance) —
 * the send-time pre-flight below remains the hard guard.
 */
export async function gasPreview(
  c: WalletChain,
  asset: string,
  tokens: { symbol: string; address?: string }[]
): Promise<GasPreview | null> {
  const account = requireAccount();
  const { publicClient } = clients(c);
  const isNative = asset.toLowerCase() === c.native.toLowerCase();
  const token = isNative ? undefined : tokens.find((t) => t.symbol.toLowerCase() === asset.toLowerCase() && t.address);
  if (!isNative && !token) return null;
  try {
    const unit = parseUnits("1", 18);
    const [gas, fees, balance] = await Promise.all([
      isNative
        ? publicClient.estimateGas({ account: account.address, to: account.address, value: unit })
        : publicClient.estimateGas({
            account: account.address,
            to: token!.address as `0x${string}`,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [account.address, unit] }),
          }),
      publicClient.estimateFeesPerGas(),
      publicClient.getBalance({ address: account.address }),
    ]);
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFee === undefined) return null;
    const feeQty = gas * maxFee;
    return {
      nativeSymbol: c.native,
      nativeBalance: formatUnits(balance, 18),
      feeQty: formatUnits(feeQty, 18),
      affordable: balance > feeQty,
    };
  } catch {
    return null;
  }
}

/**
 * Why a send can't proceed, in language a non-crypto-native person can act
 * on. The #1 real-world case: the wallet holds a token (WLD, USDC…) but zero
 * of the chain's native coin — and without native coin there is no way to
 * pay the network fee. To its user that is not a viem stack trace, it is
 * "you need a tiny top-up of the network's own coin".
 */
export function gasMessage(c: WalletChain, asset: string): string {
  const isNative = asset.toLowerCase() === c.native.toLowerCase();
  return isNative
    ? `Not enough ${c.native} on ${c.label} — the amount plus the network fee is more than your balance. Lower the amount, or top up a little ${c.native} on ${c.label} and try again.`
    : `To send ${asset} on ${c.label} you also need a small amount of ${c.native} for the network fee (usually well under a cent). Your ${asset} is safe and untouched. Top up a little ${c.native} to your address — from your exchange, withdraw with the ${c.label} network selected — then send again.`;
}

/**
 * Map ANY send failure to calm, actionable language. Raw library and engine
 * text (viem traces, "cd engine && cargo run --release") never reaches a
 * user again; in local development the raw detail is appended in brackets
 * for debugging.
 */
export function explainSendError(e: unknown, c: WalletChain, asset: string): string {
  const raw = String((e as Error)?.message ?? e);
  const low = raw.toLowerCase();
  const dev = process.env.NODE_ENV === "development" ? ` [dev: ${raw}]` : "";
  if (
    low.includes("exceeds the balance of the account") ||
    low.includes("exceeds available funds") ||
    low.includes("insufficient funds for gas") ||
    low.includes("cost of executing this transaction")
  ) {
    return gasMessage(c, asset);
  }
  if (low.includes("transfer amount exceeds balance") || low.includes("insufficient token balance")) {
    return `Not enough ${asset} to send that amount — check your ${asset} balance above. Nothing left your wallet.`;
  }
  if (low.includes("engine unreachable") || low.includes("engine_offline")) {
    return "PayPhone's coordination network is waking up (the free tier can take up to a minute). Nothing was sent — try again in a moment.";
  }
  if (low.includes("user rejected") || low.includes("request denied") || low.includes("4001")) {
    return "You declined the transaction — nothing was sent and nothing changed.";
  }
  if (low.includes("nonce")) {
    return "The network saw a conflicting transaction from this wallet. Wait a few seconds and send again — nothing was duplicated.";
  }
  if (
    low.includes("fetch") || low.includes("network") || low.includes("timeout") ||
    low.includes("socket") || low.includes("rate limit") || low.includes("429")
  ) {
    return `Couldn't reach the ${c.label} network just now. Nothing was sent — try again in a moment.`;
  }
  return `The send didn't go through — nothing left your wallet.${dev}`;
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
    // Real-chain discipline: simnet placeholder addresses (PP…) cannot receive
    // on-chain funds. If the recipient has not linked a real 0x wallet, say so
    // plainly instead of letting the RPC reject a malformed address.
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(
        "That number is on PayPhone but has no real wallet linked yet. On-chain transfers need a 0x… payout address — ask them to register one (Dashboard → Identity), or pay them with a PayPhone invoice instead."
      );
    }
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
    throw new Error(gasMessage(c, req.asset));
  }

  // ONE nonce decision for the whole send. The payment and (optional) fee tx
  // are sequential transactions from the same account; deriving the fee tx
  // nonce from the same base avoids the RPC propagation race where a fresh
  // getTransactionCount could still return the pre-payment count and collide
  // the fee tx with the payment tx in the mempool.
  const baseNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

  if (isNative) {
    const hash = await sendNative(publicClient, walletClient, account, c, req.asset, resolved.address as `0x${string}`, amountQty, baseNonce);
    txs.push({ hash, role: "payment", to: resolved.address, qty: req.amount });
  } else {
    const hash = await sendToken(publicClient, walletClient, account, c, req.asset, token!.address as `0x${string}`, resolved.address as `0x${string}`, amountQty, baseNonce);
    txs.push({ hash, role: "payment", to: resolved.address, qty: req.amount });
  }

  // The fee is its own visible transaction to the operator treasury.
  if (fee.feeQty > 0n && fee.treasury) {
    const feeHuman = formatUnits(fee.feeQty, decimals);
    const feeHash = isNative
      ? await sendNative(publicClient, walletClient, account, c, req.asset, fee.treasury as `0x${string}`, fee.feeQty, baseNonce + 1)
      : await sendToken(publicClient, walletClient, account, c, req.asset, token!.address as `0x${string}`, fee.treasury as `0x${string}`, fee.feeQty, baseNonce + 1);
    txs.push({ hash: feeHash, role: "fee", to: fee.treasury, qty: feeHuman });
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

/**
 * Pre-flight the ONE failure users actually hit: a wallet can hold plenty of
 * a token yet zero of the chain's native coin — and without native coin the
 * network fee cannot be paid, so the broadcast dies with viem's "total cost
 * exceeds the balance" trace. Catch it BEFORE signing, in plain language,
 * with the fix. (The optional protocol-fee tx is smaller than the payment,
 * so covering the payment's fee implies covering it.)
 */
async function assertGasAffordable(
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  c: WalletChain,
  asset: string,
  gas: bigint,
  fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }
): Promise<void> {
  const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (maxFee === undefined) return;
  const balance = await publicClient.getBalance({ address });
  if (gas * maxFee > balance) throw new Error(gasMessage(c, asset));
}

async function sendNative(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: LocalAccount,
  c: WalletChain,
  asset: string,
  to: `0x${string}`,
  qty: bigint,
  nonce: number
): Promise<string> {
  const [gas, fees] = await Promise.all([
    publicClient.estimateGas({ account: account.address, to, value: qty }),
    publicClient.estimateFeesPerGas(),
  ]);
  await assertGasAffordable(publicClient, account.address, c, asset, gas, fees);
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
  asset: string,
  token: `0x${string}`,
  to: `0x${string}`,
  qty: bigint,
  nonce: number
): Promise<string> {
  // Estimate gas with the REAL transfer calldata — never a bare call to the
  // token contract, which either reverts or returns the ~21k plain-transfer
  // figure and would under-gas the actual ERC-20 transfer (~50k+), burning the
  // sender's gas for a failed tx.
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, qty] });
  const [gas, fees] = await Promise.all([
    publicClient.estimateGas({ account: account.address, to: token, data }),
    publicClient.estimateFeesPerGas(),
  ]);
  await assertGasAffordable(publicClient, account.address, c, asset, gas, fees);
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

// -------------------------------------------------------- incoming (radar) --

/** One on-chain incoming transfer, exactly as the engine's feed reports it. */
export interface IncomingTransfer {
  asset: string;
  qty: string;
  from: string;
  tx_hash: string;
  block: number;
  confirmations: number;
  required_confirmations: number;
  confirmed: boolean;
  status: string; // "confirmed" | "detected"
  explorer_url: string;
}

export interface WalletRadar {
  network: string;
  native_asset: string;
  native_balance: string;
  incoming: IncomingTransfer[];
  incoming_count: number;
}

/**
 * "Money radar" — everything that landed on `address` on chain `c` inside
 * the engine's trailing look-back window, read straight from the public
 * activity feed (which reads the chain through the RPC mesh). This is how a
 * deposit from an exchange (OKX → WLD on OP Mainnet, say) surfaces with a
 * tx hash, sender and explorer link within seconds of landing — instead of
 * the user staring at a balance wondering where their money went.
 */
export async function walletIncoming(c: WalletChain, address: string): Promise<WalletRadar> {
  const r = await api.walletActivity(c.name, address);
  return {
    network: r.network,
    native_asset: r.native_asset,
    native_balance: r.native_balance,
    incoming: r.incoming,
    incoming_count: r.incoming_count,
  };
}
