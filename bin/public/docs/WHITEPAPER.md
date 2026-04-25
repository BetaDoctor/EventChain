# EventChain

A pari-mutuel prediction market on Cardano. Users bet a fungible token on binary (yes/no) markets. Winners split the losers' pool. The operator takes a 3% house fee on the losers' pool.

This document describes what the contract does and how it does it. It is *not* a deployment guide — see `README.md` at the repo root for that.

---

## How it works

Each market is a yes/no question with a deadline.

1. Bettors stake tokens on a side via a `Bet` UTxO at the contract address.
2. After the deadline, the oracle resolves the market by signing a resolution transaction that:
   - Consumes every `Bet` UTxO for that market.
   - Emits one `Payout` UTxO per winning bet with that bettor's pro-rata share.
   - Emits one fee UTxO to the treasury address (3% of losers' pool).
   - Emits one `Resolution` UTxO recording the outcome.
3. Winners spend their own `Payout` UTxO with a `Claim` redeemer (requires their signature).
4. If the oracle never resolves a market, bettors can spend their own `Bet` UTxO with a `Refund` redeemer after a 30-day grace period past the market deadline.

### Worked example

A market resolves YES. YES side had 500 total. NO side had 300 total.

- Losers' pool = 300.
- Fee = 9 (3% of 300) → treasury.
- Distributed to winners = 291, split pro-rata by stake.
- A bettor who staked 100 of the 500 YES receives `100 + (100/500) × 291 = 158.2`.
- Everyone on the winning side earns the same percentage return. Larger stakes earn larger absolute amounts.

If the winning side has zero stake, there is nothing to distribute. The oracle unwinds the market with a `ForceRefund`; no fee is charged.

---

## Trust model

The oracle is trusted to:

- Declare the correct winning side.
- Count bets honestly (declare `total_yes` / `total_no` matching the sum of consumed bet UTxOs).
- Build the correct payout transaction.

The validator enforces:

- Declared totals must equal the sum of consumed bet UTxOs on each side.
- Each winning bet must receive exactly `stake + (stake / winner_pool) × losers_pool × 0.97` tokens.
- The treasury output must equal exactly `losers_pool × 0.03` tokens to the hardcoded `treasury_vkh`.
- The `Resolve` redeemer requires a signature from the hardcoded `oracle_vkh`.
- The `Claim` redeemer requires a signature from the bettor recorded in the payout datum.
- The `Refund` redeemer requires the transaction's validity range to start after the market's refund deadline.

If the oracle misbehaves (e.g. declares the wrong winner), the on-chain record is public and permanent. Users have no programmatic recourse beyond the 30-day refund window — they must wait the grace period and reclaim their original stake.

---

## Scale ceiling

Tx-size limit caps resolution at roughly 150 bets per market (one resolution tx consumes every bet UTxO). Beyond that, the oracle would need to split resolution across multiple transactions with partial-state datums. Not implemented in v1.

---

## Out of scope (v1)

- Multi-sig oracle (single signer today).
- Secondary market — trading bet positions before resolution.
- User-created markets (admin-only today).
- Numeric / multi-outcome markets (binary-only today).
- Batched resolution for >150 bets.

---

## Code layout

- `bin/contracts/validators/event_chain.ak` — Aiken validator. All trust-critical logic.
- `bin/src/server/schema.ts` — datum / redeemer encoding.
- `bin/src/server/contract.ts` — script hash + contract address computation.
- `bin/src/server/mod.ts` — HTTP endpoints that build unsigned transactions for the frontend.
- `bin/public/` — frontend (landing page, trade UI, admin panel).

Read the Aiken validator first. Everything else is off-chain plumbing.
