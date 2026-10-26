# PayPhone Contracts

On-chain counterparts of the engine's primitives. Source-only in v1 — deploy
with Foundry (`forge init && forge build`) or Hardhat when you take the
network live. Everything is intentionally small and auditable.

## Contracts

| Contract | Purpose |
|---|---|
| `PhoneRegistry.sol` | `phoneHash → wallet` identity mapping with EIP-712 signed registration (claim-by-SMS flows without custody). |
| `PaymentRouter.sol` | `payPhone()` — instant forward for registered numbers, contract-escrow + claim for unregistered ones. Emits `InvoicePaid` for the engine's chain watcher. |
| `FeeVault.sol` | Transparent protocol treasury (60% of fees). Anyone can audit income from events. |

## The phone hash

```text
phoneHash = keccak256(pepper ‖ E164)
```

- `E164` — strict ITU E.164 normalization (engine: `engine/src/phone.rs`)
- `pepper` — per-deployment secret (engine env `PAYPHONE_PHONE_PEPPER`),
  which makes offline rainbow-table attacks on common numbers pointless.

Raw phone numbers are never stored on-chain or in the engine — only hashes.

## Payment flow (registered number)

```text
payer → PaymentRouter.payPhone(phoneHash, invoiceRef)
      ├─ protocolBps → FeeVault            (60% of the fee share)
      └─ remainder    → registry wallet    (non-custodial, instant)
```

## Payment flow (unregistered number)

```text
payer → PaymentRouter.payPhone(phoneHash, 0x0)
      ├─ protocolBps → FeeVault
      └─ remainder    → contract escrow (claimId)
recipient → registers wallet in PhoneRegistry (proves phone ownership off-band)
          → PaymentRouter.claim(claimId) → funds released to the wallet
```

The engine performs the same lifecycle against SimNet in development —
see `engine/src/chains/simnet.rs` for the journal-based twin of this flow.

## Production notes

- Cap `protocolBps` (hard cap 1.5% already enforced in the router).
- Move the master key, signing key and pepper into a KMS; the contracts
  never need them — only the engine does.
- The engine observes `InvoicePaid` via `eth_getLogs`; run it against an
  indexed RPC (Alchemy/QuickNode) for production volumes.
- v2 ideas: ERC-20 escrow paths (USDC), OTP-commitment claims on-chain,
  L2 deployment (Base) for sub-cent fees.
