# Earning & Governance — the PayPhone Wallet at work

PayPhone's wallet started with three verbs: **receive, hold, send**. This is
the fourth: **put assets to work**. A configured wallet can earn the
validator reward rate through liquid staking, earn lending interest on DeFi
money markets, and hold — and exercise — on-chain voting power.

The non-custodial invariant is unchanged and load-bearing:

> Every earning flow ends in a transaction **your wallet signs locally** with
> the same keystore that signs sends. The engine contributes a curated,
> address-verified opportunity registry and live chain reads (positions,
> voting power). It holds no private keys, never broadcasts for you, and
> never custodies an asset at any point in any flow.

## The three unlocks, mapped to PayPhone

**1. Direct DeFi access (lending + staking yield).**
Wallet → **Earn & Governance** lists curated opportunities. Stake ETH with
Lido (`submit(referral)`, one payable transaction) and hold stETH — your
stake is delegated across Lido's node-operator set and the balance grows
with staking rewards. Wrap stETH into wstETH when you want a non-rebasing
balance. Supply USDC to Aave V3 (approve + `supply`) and earn the variable
lending rate, withdrawable any time. Approvals are always for the **exact**
amount — the flows never request an unlimited allowance.

**2. Web3 passport / dApp integration.**
The wallet IS the login of the decentralized web, and PayPhone treats it
that way: signing stays local, and a consent-first dApp connection surface
(per-dApp permission list, scoped sessions) is on the roadmap. What ships
today is the honest foundation: the keystore, the address, and the live
activity radar are everything a dApp session needs.

**3. NFT sovereignty.**
Self-custody already covers NFTs: any ERC-721/1155 sent to your address is
yours — no marketplace account can hold it hostage. A gallery view and
marketplace listing builders (sell, royalty-aware) are on the roadmap;
custody itself needs nothing from anyone.

## Being a validator, honestly

Two ways a wallet "earns as a validator," and they are not the same thing:

- **Delegate to a validator set (one click, this is what Earn does).** On
  proof-of-stake networks the validator reward rate is earned by stakers.
  Liquid staking protocols (Lido) pool stake across many validators, issue
  a receipt (stETH/wstETH), and pass the rewards through. Your wallet earns
  the validator reward rate minus the protocol fee, with no 32-ETH minimum
  and no always-on server.
- **Run your own validator node (self-hosted, outside PayPhone).** That
  means 32 ETH bonded and operator infrastructure. PayPhone deliberately
  does NOT run validator nodes for users — a validator's signing key on
  someone else's server is custodianship by another name. If you run your
  own node, PayPhone can WATCH it: positions reads report balances and
  voting power, but the vote key never leaves your infrastructure.

## Governance: being IN it, not just holding a token

Owning a governance token does nothing until voting power is **delegated**.
The Earn panel's governance section makes the two steps explicit:

1. `delegate(address)` on the token — to your own address (self-governance)
   or a delegate you trust. This moves voting power, never tokens.
2. `castVote(proposalId, support)` on the governor — 0 = against,
   1 = for, 2 = abstain — once a proposal is live.

The engine serves live voting power (`getVotes` at the last settled block
for OZ ERC20Votes tokens; `getCurrentVotes` for Compound-style tokens like
UNI) so you can see the power you hold before you use it.

## The registry: verified addresses or nothing

`GET /v1/earn/opportunities` is the single source of truth the wallet
renders. Its rules are enforced in code (`engine/src/earn.rs` →
`validate_registry`) and in tests:

- Every address in the **default** registry was verified against the
  protocol's own documentation at the time it was added (docs.lido.fi,
  developers.uniswap.org governance reference, aave.com addresses page).
- An entry that cannot be verified ships as `status: "roadmap"` with **no
  contract address** — guidance, never a guess. (This actually happened:
  the Aave receipt-token address was left out of positions reads because
  the V3 aUSDC address was not verified at writing time.)
- **No yield numbers.** Entries carry a `reward_source` (mechanically where
  the yield comes from) and `risks[]`. APYs change hourly and belong to the
  protocols; quoting a stale number in a payment engine would be worse than
  quoting none.

### Extending the registry (operators)

Set `PAYPHONE_EARN_REGISTRY_JSON` to a JSON array of opportunities — it
replaces the default set and passes the same validation (unknown network,
bad address shape, roadmap entry with an address → the override is rejected
and the default ships, with a loud log). To add a chain's native delegation,
a new LST, or another DAO's governor: verify the address from the protocol's
docs, add the entry, restart. Example shape:

```json
[{
  "id": "my-lst-polygon",
  "network": "polygon",
  "kind": "liquid_staking",
  "protocol": "Example",
  "label": "Stake POL → stPOL",
  "description": "…",
  "asset": "POL",
  "receipt_asset": "stPOL",
  "target_contract": "0x…verified…",
  "receipt_contract": "0x…verified…",
  "receipt_decimals": 18,
  "execution": "wallet_flow",
  "status": "active",
  "reward_source": "Polygon PoS staking rewards via the operator set",
  "risks": ["…"],
  "steps": ["…"]
}]
```

## Risks, stated plainly

- **Smart-contract risk** — every registered protocol is audited by its own
  team, and audits are not guarantees. Size positions accordingly.
- **Variable rates** — staking and lending rates move; nothing here locks
  or promises a number.
- **Gas** — every earning action is an ordinary transaction and costs the
  network's native coin; the wallet's gas pre-flight (same as sends) tells
  you before you sign.
- **Votes are final** — once cast on-chain, a governance vote cannot be
  edited. Delegation is visible and public.
- **Bridges** — L2 receipts (wstETH on Base) add bridge risk on top of
  protocol risk; the entries say so.

## API surface

See `docs/API.md` → "Earn & governance". The five endpoints:
`GET /v1/earn/opportunities`, `GET /v1/earn/positions`,
`GET /v1/governance/power`, `POST /v1/governance/vote-calldata`,
`POST /v1/governance/delegate-calldata`. Deployment verification
(`scripts/verify_remote.py`) checks [13]: registry shape, exact calldata
encodings against reference values, and a live voting-power read.
