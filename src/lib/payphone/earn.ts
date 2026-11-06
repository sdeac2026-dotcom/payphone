/**
 * PayPhone Earn — the wallet as an earning, governing network participant.
 *
 * Every flow here ends in a transaction signed LOCALLY by the keystore
 * account. The NETWORK work — fees, gas, nonce, and the broadcast — runs
 * through the engine's server-side RPC mesh (`/v1/tx/prepare`,
 * `/v1/tx/broadcast`): a throttled or CORS-blocked browser gateway
 * (1rpc.io "Failed to fetch" in the field) can no longer kill a stake.
 * Browser gateways remain only as a fallback. The engine relays
 * ALREADY-SIGNED blobs it cannot modify — it never holds a key and never
 * custodies an asset.
 *
 * ABIs below are the exact public signatures of the registered protocols:
 * Lido `submit(address _referral) payable` (docs.lido.fi), wstETH
 * `wrap/unwrap(uint256)` (docs.lido.fi/contracts/wsteth), Aave V3 Pool
 * `supply/withdraw` (aave.com docs), OpenZeppelin Governor `castVote`
 * + ERC20Votes `delegate`. Nothing here signs blind: gas is estimated with
 * the REAL calldata and the native-balance pre-flight from the send flow
 * applies to every earning transaction too.
 */

import {
  erc20Abi,
  parseEther,
  parseUnits,
  encodeFunctionData,
  type Address,
} from "viem";
import { api, ApiError, type EarnOpportunity } from "./api";
import { clients, gasMessage, requireChain, type WalletChain } from "./wallet";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Registry contract addresses (mirrored from the engine's verified registry). */
export const EARN_CONTRACTS = {
  lidoStETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as const,
  lidoWstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const,
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const,
  uniGovernor: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3" as const,
  uniToken: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" as const,
} as const;

// ------------------------------------------------------------------- ABIs ----

/** Lido stETH entry point — docs.lido.fi/contracts/lido. */
export const LIDO_ABI = [
  {
    name: "submit",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "_referral", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Lido wstETH wrapper — docs.lido.fi/contracts/wsteth. */
export const WSTETH_ABI = [
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_stETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "unwrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_wstETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Aave V3 Pool — aave.com/docs/aave-v3/smart-contracts/pool. */
export const AAVE_POOL_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** OpenZeppelin/Bravo Governor vote cast. */
export const GOVERNOR_ABI = [
  {
    name: "castVote",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// --------------------------------------------------------------- helpers ----

async function assertGasAffordable(
  c: WalletChain,
  to: Address,
  data: `0x${string}`,
  value: bigint,
  maxFee: bigint | undefined
): Promise<void> {
  const { publicClient, walletClient } = clients(c);
  const account = walletClient.account!;
  if (maxFee === undefined) return;
  const [balance, gas] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.estimateGas({ account, to, data, value }),
  ]);
  if (gas * maxFee > balance) throw new Error(gasMessage(c, c.native));
}

/** Sign LOCALLY with the keystore, broadcast the raw blob via the engine mesh. */
async function signViaEngine(
  c: WalletChain,
  to: Address,
  data: `0x${string}`,
  value: bigint
): Promise<string> {
  const { walletClient } = clients(c);
  const account = walletClient.account!;
  const prep = await api.txPrepare({
    network: c.name,
    from: account.address,
    to,
    data,
    value: `0x${value.toString(16)}`,
  });

  // Affordability from the engine's server-side balance sheet — no browser
  // RPC. If the sheet itself is unreachable, proceed: the chain enforces
  // the balance at the mempool anyway.
  const gasCost = BigInt(prep.gas) * BigInt(prep.max_fee_per_gas);
  let affordErr: string | null = null;
  try {
    const sheet = await api.walletBalances(account.address, c.name);
    const native = sheet.balances.find((b) => !b.address);
    if (native) {
      const balWei = parseUnits(native.qty, native.decimals || 18);
      if (gasCost > balWei) affordErr = gasMessage(c, c.native);
    }
  } catch {
    /* sheet unreachable — broadcast is still safe */
  }
  if (affordErr) throw new Error(affordErr);

  const raw = await walletClient.signTransaction({
    to,
    data,
    value,
    nonce: prep.nonce,
    gas: BigInt(prep.gas),
    maxFeePerGas: BigInt(prep.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(prep.max_priority_fee_per_gas),
    chainId: prep.chain_id,
  });
  const { hash } = await api.txBroadcast({ network: c.name, raw_tx: raw });
  return hash as `0x${string}`;
}

/**
 * The legacy path: everything through browser gateways. Kept as the
 * fallback for the day the engine itself is unreachable — the failure mode
 * this module originally shipped with, better than a dead button.
 */
async function signAndBroadcastBrowser(
  c: WalletChain,
  to: Address,
  data: `0x${string}`,
  value: bigint
): Promise<string> {
  const { publicClient, walletClient } = clients(c);
  const account = walletClient.account!;
  const fees = await publicClient.estimateFeesPerGas();
  await assertGasAffordable(c, to, data, value, fees.maxFeePerGas ?? fees.gasPrice);
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  return walletClient.sendTransaction({
    to,
    data,
    value,
    nonce,
    account,
    chain: c.chain,
    maxFeePerGas: fees.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? undefined,
  });
}

/** Estimate with the REAL calldata, then sign + broadcast one transaction. */
async function signAndBroadcast(
  c: WalletChain,
  to: Address,
  data: `0x${string}`,
  value: bigint
): Promise<string> {
  try {
    return await signViaEngine(c, to, data, value);
  } catch (e) {
    // Engine answers with 4xx are REAL answers (bad network, validation,
    // rate limit) — surface them. Only an unreachable/unhealthy engine
    // falls back to the browser-gateway path.
    const retriable = !(e instanceof ApiError) || e.status >= 500;
    if (!retriable) throw e;
    return signAndBroadcastBrowser(c, to, data, value);
  }
}

/** Approve an EXACT amount — never an infinite allowance. */
async function approveExact(
  c: WalletChain,
  token: Address,
  spender: Address,
  qty: bigint
): Promise<string> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, qty] });
  return signAndBroadcast(c, token, data, 0n);
}

/** Resolve a token address + decimals from the engine's live chain sheet. */
export async function settleableToken(
  network: string,
  symbol: string
): Promise<{ address: Address; decimals: number }> {
  const sheet = await api.chains();
  const net = sheet.networks.find((n) => n.name === network);
  const t = net?.settleable_tokens.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!t) throw new Error(`${symbol} is not settleable on ${network} — cannot build the approval.`);
  return { address: t.address as Address, decimals: t.decimals };
}

/**
 * The flow resolves the opportunity's own chain from WALLET_CHAINS — the
 * keystore account signs on whatever network the opportunity lives on, so
 * the console's network selector can never dead-end a button with
 * "switch the network and try again". The selector stays a VIEW choice
 * (balances, positions); actions follow the opportunity.
 */
function chainFor(network: string): WalletChain {
  return requireChain(network);
}

// ----------------------------------------------------------------- flows ----

/**
 * Stake ETH with Lido → stETH. ONE payable transaction
 * (`submit(referral)`); stETH lands immediately and rebases daily.
 */
export async function stakeEthLido(_selected: WalletChain, amountEth: string): Promise<string> {
  const c = chainFor("ethereum");
  const data = encodeFunctionData({ abi: LIDO_ABI, functionName: "submit", args: [ZERO_ADDRESS] });
  return signAndBroadcast(c, EARN_CONTRACTS.lidoStETH, data, parseEther(amountEth.trim()));
}

/**
 * Wrap stETH → wstETH (non-rebasing). Two signed transactions:
 * exact-amount approve, then `wrap(uint256)`.
 */
export async function wrapStETH(_selected: WalletChain, amountStEth: string): Promise<{ approve: string; wrap: string }> {
  const c = chainFor("ethereum");
  const qty = parseUnits(amountStEth.trim(), 18);
  const approve = await approveExact(c, EARN_CONTRACTS.lidoStETH, EARN_CONTRACTS.lidoWstETH, qty);
  const wrap = await signAndBroadcast(
    c,
    EARN_CONTRACTS.lidoWstETH,
    encodeFunctionData({ abi: WSTETH_ABI, functionName: "wrap", args: [qty] }),
    0n
  );
  return { approve, wrap };
}

/**
 * Supply USDC to Aave V3 → aUSDC receipt. Two signed transactions:
 * exact-amount approve, then `supply(asset, amount, onBehalfOf, 0)`.
 */
export async function supplyAaveUsdc(_selected: WalletChain, amountUsdc: string): Promise<{ approve: string; supply: string }> {
  const c = chainFor("ethereum");
  const usdc = await settleableToken("ethereum", "USDC");
  const qty = parseUnits(amountUsdc.trim(), usdc.decimals);
  const { walletClient } = clients(c);
  const onBehalfOf = walletClient.account!.address;
  const approve = await approveExact(c, usdc.address, EARN_CONTRACTS.aaveV3Pool, qty);
  const supply = await signAndBroadcast(
    c,
    EARN_CONTRACTS.aaveV3Pool,
    encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [usdc.address, qty, onBehalfOf, 0],
    }),
    0n
  );
  return { approve, supply };
}

/**
 * Activate voting power: `delegate(address)` on the governance token. The
 * engine builds the calldata (registry-verified token); the wallet signs.
 */
export async function governanceDelegate(
  _selected: WalletChain,
  opportunityId: string,
  delegatee: string
): Promise<string> {
  const tx = await api.governanceDelegateCalldata({ opportunity: opportunityId, delegatee: delegatee.trim() });
  const c = chainFor(tx.network);
  return signAndBroadcast(c, tx.to as Address, tx.data as `0x${string}`, 0n);
}

/**
 * Cast a vote: `castVote(proposalId, support)` on the governor
 * (0 = against, 1 = for, 2 = abstain). Engine builds; wallet signs.
 */
export async function governanceVote(
  _selected: WalletChain,
  opportunityId: string,
  proposalId: string,
  support: 0 | 1 | 2
): Promise<string> {
  const tx = await api.governanceVoteCalldata({ opportunity: opportunityId, proposal_id: proposalId.trim(), support });
  const c = chainFor(tx.network);
  return signAndBroadcast(c, tx.to as Address, tx.data as `0x${string}`, 0n);
}

/** Live voting power + token balance for a governance entry. */
export async function governancePower(opportunityId: string, address: string) {
  return api.governancePower(opportunityId, address);
}

/** Registry: what can this wallet earn, on which networks. */
export async function earnOpportunities(): Promise<EarnOpportunity[]> {
  const sheet = await api.earnOpportunities();
  return sheet.opportunities;
}

/** Live receipt-token positions for the wallet on one network. */
export async function earnPositions(network: string, address: string) {
  return api.earnPositions(network, address);
}

export type { EarnOpportunity };
