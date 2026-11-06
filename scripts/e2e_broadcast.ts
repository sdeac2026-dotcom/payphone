/**
 * End-to-end test of the earn signing path WITHOUT a funded wallet:
 *   throwaway key -> engine /v1/tx/prepare -> viem signTransaction (local)
 *   -> engine /v1/tx/broadcast -> real node verdict.
 *
 * Expected for an unfunded throwaway key: the transaction REACHES real
 * ethereum nodes through the mesh and is rejected for funds ("insufficient
 * funds ...") — which proves the relay path works end-to-end. A gateway
 * rejection ("Failed to fetch", CORS, method-not-supported) would instead
 * prove the old browser failure mode lives inside the engine mesh too.
 */
import { privateKeyToAccount } from "viem/accounts";

// Run against a LOCAL engine (PAYPHONE_SIMNET=0): ENGINE=http://127.0.0.1:3777 bun scripts/e2e_broadcast.ts
// The engine serves /v1/* directly; the console's /api prefix is its own proxy.
const ENGINE = process.env.ENGINE ?? "http://127.0.0.1:3777";

async function jpost(path: string, body: unknown) {
  const r = await fetch(ENGINE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  return { status: r.status, body: parsed };
}

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // well-known anvil test key, unfunded on mainnet
);

// 1. prepare — engine reads chain id / nonce / gas / fees through its mesh
const prep = await jpost("/v1/tx/prepare", {
  network: "ethereum",
  from: account.address,
  to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  value: "0x1",
});
console.log("prepare:", prep.status, JSON.stringify(prep.body).slice(0, 400));
if (prep.status !== 200) process.exit(1);
const p = prep.body.data;

// 2. sign LOCALLY — no network involved
const raw = await account.signTransaction({
  to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  value: 1n,
  nonce: p.nonce,
  gas: BigInt(p.gas),
  maxFeePerGas: BigInt(p.max_fee_per_gas),
  maxPriorityFeePerGas: BigInt(p.max_priority_fee_per_gas),
  chainId: p.chain_id,
});
console.log("signed raw length:", raw.length);

// 3. broadcast through the mesh — expect the CHAIN's verdict
const bc = await jpost("/v1/tx/broadcast", { network: "ethereum", raw_tx: raw });
console.log("broadcast:", bc.status, JSON.stringify(bc.body).slice(0, 500));

const msg = String(bc.body?.error?.message ?? bc.body?.data?.hash ?? "");
const reachedNode = /insufficient funds|exceeds|balance|not enough|gas/i.test(msg) || bc.status === 200;
console.log(reachedNode
  ? "VERDICT: relay path REACHES real nodes (chain answered) ✔"
  : "VERDICT: relay path BLOCKED before a real node ✘");
