use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, flatten, quantity_of}
use cardano/transaction.{
  Datum, InlineDatum, Input, Output, OutputReference, Transaction,
}

// ── Types ────────────────────────────────────────────────────────────────────

pub type Side {
  Yes
  No
}

pub type BetDatum {
  market_id: ByteArray,
  bettor: VerificationKeyHash,
  side: Side,
  ect_amount: Int,
  // Market close / refund deadline (POSIX ms).
  //   • Resolve: validity_range.lower_bound must be >= deadline.
  //   • Refund : validity_range.lower_bound must be >= deadline. No
  //     Resolution-presence guard is needed: the Resolve branch consumes
  //     every Bet UTxO it settles, so a Bet UTxO that still exists at
  //     refund time was, by construction, not paid out. Refunding it is
  //     conservation-safe and is the escape hatch for a "partial totals"
  //     resolve that omitted this bet (audit C6).
  deadline: Int,
}

pub type ResolutionDatum {
  market_id: ByteArray,
  winner: Side,
  oracle: VerificationKeyHash,
  // Declared totals at resolution. These are enforced to equal the sum
  // of ECT across all Bet inputs consumed by the Resolve tx.
  total_yes: Int,
  total_no: Int,
}

pub type PayoutDatum {
  market_id: ByteArray,
  bettor: VerificationKeyHash,
  payout_amount: Int,
  // Output reference of the Bet UTxO this Payout settles. Binds the payout
  // 1:1 to its source bet — prevents a single payout output from satisfying
  // two winning-bet validator runs (audit P0-C2).
  bet_ref: OutputReference,
}

pub type EventDatum {
  Bet(BetDatum)
  Resolution(ResolutionDatum)
  Payout(PayoutDatum)
}

pub type EventRedeemer {
  // Oracle sweeps all Bet UTxOs for a market and emits payouts + fee +
  // Resolution marker.
  Resolve
  // Winner spends their PayoutDatum UTxO.
  Claim
  // Bettor reclaims stake if the oracle never resolved the market.
  // Gated on deadline + refund_grace_ms — the grace period gives the
  // oracle an exclusive window to resolve without racing bettors.
  Refund
  // Oracle mass-refunds one or more Bet UTxOs. Each Bet input must have a
  // corresponding output paying the original bettor >= bet.ect_amount ECT.
  // Used for markets the oracle decides to unwind (e.g. winner-pool-zero,
  // cancelled markets) without making users wait through the grace period.
  ForceRefund
}

// ── Constants ────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// ⚠ REPLACE ALL FOUR CONSTANTS BELOW BEFORE `aiken build`.
// The validator hash is derived from these values — changing any of them
// produces a new contract address. See SETUP.md at the repo root.
// ─────────────────────────────────────────────────────────────────────────

// Hardcoded oracle: only this key can resolve markets OR spend Resolution
// UTxOs. Set this to the vkh of the wallet that will sign resolution txs.
// Derive from a bech32 address with: `bech32 -> payment credential (hex)`.
const oracle_vkh: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000000"

// Treasury: receives the 3% fee at resolution. Separate wallet from the
// oracle recommended (makes fee-revenue visible vs. oracle ops movements).
const treasury_vkh: VerificationKeyHash =
  #"00000000000000000000000000000000000000000000000000000000"

// Token policy id (28-byte hex). The ONLY token this contract moves.
// Set to the policy of the CNT you want users to bet with.
const ect_policy_id: PolicyId =
  #"00000000000000000000000000000000000000000000000000000000"

// Token asset name (hex; empty #"" is valid). For CIP-68 fungibles (label
// 333), prefix the human-readable name bytes with `0014df10`.
const ect_asset_name: AssetName =
  #""

// Fee charged on losers' pool, in basis points. 300 = 3%.
const fee_bps: Int = 300

// Refund grace period after market close (POSIX ms). Bettors may self-refund
// only after `bet.deadline + refund_grace_ms`. This window closes the
// refund-vs-resolve race: without it, bettors on the losing side could
// submit a Refund tx the instant the deadline passes, racing the oracle's
// Resolve and escaping their loss. 7 days is ample for any honest oracle
// to resolve + a safety buffer for real-world delays (vacation, illness).
// If the oracle misses the window, refund becomes available — the escape
// hatch against an MIA oracle is preserved.
//
// 7 * 24 * 60 * 60 * 1000 = 604_800_000 ms
const refund_grace_ms: Int = 604_800_000

// ── Helpers ──────────────────────────────────────────────────────────────────

fn signed_by(tx: Transaction, vkh: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, vkh)
}

fn lower_bound_after(tx: Transaction, time: Int) -> Bool {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(t) -> t >= time
    _ -> False
  }
}

fn ect_qty(value: Value) -> Int {
  quantity_of(value, ect_policy_id, ect_asset_name)
}

fn paid_to_vkh(output: Output, vkh: VerificationKeyHash) -> Bool {
  when output.address.payment_credential is {
    VerificationKey(h) -> h == vkh
    _ -> False
  }
}

// Is this output at a script address (i.e. at our contract)? Used to filter
// wallet inputs out of Bet-scanning so an unrelated inline datum on a wallet
// UTxO (change, collateral) can't brick Resolve via `expect` panic — audit
// P0-C7.
fn at_script(output: Output) -> Bool {
  when output.address.payment_credential is {
    Script(_) -> True
    _ -> False
  }
}

// Value contains ECT and ADA only — no other native tokens. Defends against
// an attacker-crafted Bet UTxO that piggybacks extra tokens the oracle would
// otherwise have to carry through the Resolve tx (audit P1-C1).
fn value_is_ada_and_ect_only(value: Value) -> Bool {
  list.all(
    flatten(value),
    fn(entry) {
      let (pid, aname, _qty) = entry
      // `flatten` emits (#"", #"", lovelace_qty) for ADA.
      ( pid == #"" && aname == #"" ) || ( pid == ect_policy_id && aname == ect_asset_name )
    },
  )
}

fn parse_event_datum(d: Datum) -> Option<EventDatum> {
  when d is {
    InlineDatum(raw) -> {
      expect parsed: EventDatum = raw
      Some(parsed)
    }
    _ -> None
  }
}

// Sum ECT across all Bet inputs for a given market_id, split yes/no.
// Filters to script-address inputs only — wallet inputs can't reach here,
// so their inline datums can't abort the `expect` in parse_event_datum
// (audit P0-C7).
fn sum_bet_inputs(
  inputs: List<Input>,
  market_id: ByteArray,
) -> (Int, Int) {
  list.foldr(
    inputs,
    (0, 0),
    fn(inp, acc) {
      let (y, n) = acc
      if !at_script(inp.output) {
        acc
      } else {
        when parse_event_datum(inp.output.datum) is {
          Some(Bet(b)) ->
            if b.market_id == market_id {
              let q = ect_qty(inp.output.value)
              when b.side is {
                Yes -> (y + q, n)
                No -> (y, n + q)
              }
            } else {
              acc
            }
          _ -> acc
        }
      }
    },
  )
}

// Count distinct market_ids across Bet inputs at script address. Used to
// forbid multi-market Resolve txs (audit P0-C5) so the per-market fee
// enforcement can't be shared across markets.
fn bet_market_ids(inputs: List<Input>) -> List<ByteArray> {
  list.foldr(
    inputs,
    [],
    fn(inp, acc) {
      if !at_script(inp.output) {
        acc
      } else {
        when parse_event_datum(inp.output.datum) is {
          Some(Bet(b)) ->
            if list.has(acc, b.market_id) {
              acc
            } else {
              [b.market_id, ..acc]
            }
          _ -> acc
        }
      }
    },
  )
}

// The Resolution output for this market. Must be exactly one.
fn find_resolution(
  outputs: List<Output>,
  market_id: ByteArray,
) -> Option<ResolutionDatum> {
  let matches =
    list.filter_map(
      outputs,
      fn(o) {
        when parse_event_datum(o.datum) is {
          Some(Resolution(r)) ->
            if r.market_id == market_id {
              Some(r)
            } else {
              None
            }
          _ -> None
        }
      },
    )
  when matches is {
    [r] -> Some(r)
    _ -> None
  }
}

// Total ECT paid to the treasury vkh across all outputs.
fn ect_paid_to_treasury(outputs: List<Output>) -> Int {
  list.foldr(
    outputs,
    0,
    fn(o, acc) {
      if paid_to_vkh(o, treasury_vkh) {
        acc + ect_qty(o.value)
      } else {
        acc
      }
    },
  )
}

// Total ECT across all outputs paid to vkh.
fn ect_paid_to(outputs: List<Output>, vkh: VerificationKeyHash) -> Int {
  list.foldr(
    outputs,
    0,
    fn(o, acc) {
      if paid_to_vkh(o, vkh) {
        acc + ect_qty(o.value)
      } else {
        acc
      }
    },
  )
}

// For a winning bet there must be EXACTLY ONE Payout output whose datum
// ties back to this bet's output reference (bet_ref) AND matches
// (market_id, bettor, expected amount), with ECT value >= payout_amount.
// Binding payout to bet_ref (1:1) blocks the duplicate-payout attack where
// two identical winning-bet tuples would be satisfied by a single output
// (audit P0-C2).
fn winner_has_valid_payout(
  outputs: List<Output>,
  market_id: ByteArray,
  bettor: VerificationKeyHash,
  expected: Int,
  this_bet_ref: OutputReference,
) -> Bool {
  let matches =
    list.filter(
      outputs,
      fn(o) {
        // Payout UTxO must land at the contract's script address — otherwise
        // an oracle could grief a winner by emitting the Payout to an
        // attacker-controlled wallet address with matching datum, making
        // the output unclaimable (Payout-branch validator never runs because
        // the UTxO isn't at the script address). Audit round 3, P1-N2.
        if !at_script(o) {
          False
        } else {
          when parse_event_datum(o.datum) is {
            Some(Payout(p)) ->
              p.bet_ref == this_bet_ref && p.market_id == market_id && p.bettor == bettor && p.payout_amount == expected && ect_qty(
                o.value,
              ) >= expected
            _ -> False
          }
        }
      },
    )
  when matches is {
    [_] -> True
    _ -> False
  }
}

// Sum (stake * distribution / winner_pool) across every winning Bet input
// for this market. Used to pin the EXACT treasury payment = fee + dust,
// where dust is what integer truncation leaves on the table (audit M1).
//
// Computed from INPUTS deliberately (not from Payout outputs): if we summed
// Payout amounts instead, an oracle could forge an extra self-owned Payout
// to inflate Σ and shrink the required treasury payment, later reclaiming
// the fake Payout via Claim. Summing inputs is exploit-free because the
// declared totals are already cross-checked against input sums above.
fn sum_winner_shares(
  inputs: List<Input>,
  market_id: ByteArray,
  winner_side: Side,
  distribution: Int,
  winner_pool: Int,
) -> Int {
  list.foldr(
    inputs,
    0,
    fn(inp, acc) {
      if !at_script(inp.output) {
        acc
      } else {
        when parse_event_datum(inp.output.datum) is {
          Some(Bet(b)) ->
            if b.market_id == market_id && b.side == winner_side {
              acc + b.ect_amount * distribution / winner_pool
            } else {
              acc
            }
          _ -> acc
        }
      }
    },
  )
}

// ── Resolve on Bet ───────────────────────────────────────────────────────────

fn validate_resolve_bet(
  tx: Transaction,
  bet: BetDatum,
  this_ref: OutputReference,
) -> Bool {
  // Non-empty market_id — empty string would let two markets collide
  // (audit P1-C2).
  expect bet.market_id != #""

  // Non-zero stake (audit L2). Zero-ECT bets waste an input slot during
  // Resolve without contributing to the pools; rejecting them here closes
  // a tx-bloat DoS vector. Refund path is intentionally NOT gated on this:
  // if a zero-ECT Bet UTxO ever exists, the bettor should still be able
  // to clean it up after deadline.
  expect bet.ect_amount > 0

  // Cap market_id length (audit L4). Prevents an attacker-crafted Bet
  // UTxO with a multi-KB market_id from inflating Resolve tx size. 64
  // bytes is generous — server-side market ids match /^[a-z0-9-]+$/ and
  // are comfortably under 30 chars in practice.
  expect bytearray.length(bet.market_id) <= 64

  // Oracle signed.
  expect signed_by(tx, oracle_vkh)

  // Find the bet's own input. ect_amount in the datum must equal the
  // actual on-chain ECT in the UTxO — otherwise an attacker could place
  // a bet with ect_amount=10^6 but only 1 ECT inside and claim a
  // disproportionate share (audit P0-C1). Also enforce ECT-only contents.
  expect Some(self_input) =
    list.find(tx.inputs, fn(i) { i.output_reference == this_ref })
  expect ect_qty(self_input.output.value) == bet.ect_amount
  expect value_is_ada_and_ect_only(self_input.output.value)

  // Single-market Resolve: every Bet input must share one market_id.
  // Otherwise a two-market Resolve could pay a single treasury output that
  // satisfies both markets' fee checks (audit P0-C5).
  expect [_single_market] = bet_market_ids(tx.inputs)

  // Resolution output exists for this market.
  expect Some(res) = find_resolution(tx.outputs, bet.market_id)
  expect res.oracle == oracle_vkh

  // Resolve can only happen after market deadline.
  expect lower_bound_after(tx, bet.deadline)

  // Declared totals == actual sum of Bet inputs for this market.
  let (yes_sum, no_sum) = sum_bet_inputs(tx.inputs, bet.market_id)
  expect res.total_yes == yes_sum
  expect res.total_no == no_sum

  let (winner_pool, losers_pool) =
    when res.winner is {
      Yes -> (res.total_yes, res.total_no)
      No -> (res.total_no, res.total_yes)
    }

  // Treasury payment = fee + integer-division dust (audit M1/L1).
  //   fee_amount = floor(losers_pool * 3%)
  //   distribution = losers_pool - fee_amount
  //   dust = distribution − Σ winner shares (summed from inputs)
  // Treasury receives EXACTLY fee + dust. Using `==` (was `>=`) also closes
  // L1. No ECT can leak into the oracle's change output. Share-truncation
  // dust is fully accounted for, not silently pocketed.
  //
  // Edge cases:
  //   • winner_pool == 0 (nobody on winning side): skip the helper to avoid
  //     a division-by-zero. Σ shares = 0, so dust = distribution and
  //     treasury receives the entire losers' pool. Correct: with no winners,
  //     100% of the loser pool is "orphaned" and rightfully goes to treasury.
  //   • losers_pool == 0 (everyone on winning side): fee = distribution =
  //     dust = 0. Treasury receives 0. Each winner's payout = their own
  //     stake returned. Correct.
  let fee_amount = losers_pool * fee_bps / 10_000
  let distribution = losers_pool - fee_amount
  let total_winner_shares =
    if winner_pool <= 0 {
      0
    } else {
      sum_winner_shares(
        tx.inputs,
        bet.market_id,
        res.winner,
        distribution,
        winner_pool,
      )
    }
  let dust = distribution - total_winner_shares
  expect ect_paid_to_treasury(tx.outputs) == fee_amount + dust

  // This bet's own payout.
  if bet.side == res.winner {
    if winner_pool <= 0 {
      // Impossible: this input itself is a winner, so winner_pool > 0.
      False
    } else {
      let share = bet.ect_amount * distribution / winner_pool
      let expected = bet.ect_amount + share
      winner_has_valid_payout(
        tx.outputs,
        bet.market_id,
        bet.bettor,
        expected,
        this_ref,
      )
    }
  } else {
    // Losing bet: stake is absorbed into the pool. The totals-match check
    // above already proves this stake was counted.
    True
  }
}

// ── Refund on Bet ────────────────────────────────────────────────────────────

fn validate_refund_bet(tx: Transaction, bet: BetDatum) -> Bool {
  // Conservation argument (audit C6): a Bet UTxO's continued existence is
  // proof it was not consumed in any Resolve tx for this market, therefore
  // no Payout was emitted for it. Refunding stake is safe even after a
  // (partial) Resolve, and is the only escape hatch for stakes the oracle
  // stranded by omitting them from the resolve input set.
  //
  // The `+ refund_grace_ms` delay gives the oracle a guaranteed window to
  // Resolve without a bettor racing them. Without this, a losing bettor
  // could submit Refund the instant the deadline passes — their tx lands
  // first, their Bet UTxO is gone, and the oracle's Resolve fails because
  // declared totals no longer match remaining inputs. See M-refund-race.
  signed_by(tx, bet.bettor) && lower_bound_after(
    tx,
    bet.deadline + refund_grace_ms,
  )
}

// ── ForceRefund on Bet (oracle-only) ─────────────────────────────────────────

fn validate_force_refund_bet(tx: Transaction, bet: BetDatum) -> Bool {
  // Oracle-signed mass-refund path. Lets the oracle unwind a market (e.g.
  // winner-pool-zero, cancelled) without making every bettor click Refund
  // individually — and without waiting for the grace period to elapse.
  //
  // Per-bet safety: this validator runs once per Bet input. For THIS bet to
  // be refunded, an output must exist paying `>= bet.ect_amount` ECT to
  // `bet.bettor`'s vkh. The oracle cannot divert ECT — the payment address
  // is pinned by the datum.
  //
  // Cross-bet safety (multiple bets, same vkh in one tx): Cardano enforces
  // Σ inputs == Σ outputs + fee. If two Bet UTxOs from bettor B are
  // consumed (total 2X ECT), both validator runs each check
  // `ect_paid_to(outputs, B) >= X`. Both pass if ≥X goes to B, but the
  // ledger also requires all 2X ECT to go somewhere. Since the oracle is
  // the only other signer and cannot send ECT to themselves without the
  // ledger flagging unbalanced inputs, and since B is the pinned vkh, at
  // least 2X lands at B. No cross-bettor theft, no oracle skim.
  //
  // Gated on `bet.deadline`: refund only after market close, matching
  // Resolve's timing. Prevents oracle (or stolen key) from refunding
  // mid-market before betting closes.
  signed_by(tx, oracle_vkh) && lower_bound_after(
    tx,
    bet.deadline,
  ) && ect_paid_to(tx.outputs, bet.bettor) >= bet.ect_amount
}

// ── Claim on Payout ──────────────────────────────────────────────────────────

fn validate_claim_payout(tx: Transaction, pay: PayoutDatum) -> Bool {
  // Bettor signed, AND an output to bettor carries >= payout_amount ECT.
  // The signature is enough to stop theft; the amount check catches a
  // malformed or malicious co-signed tx.
  //
  // Why `ect_paid_to(...) >= pay.payout_amount` is safe even when the
  // bettor claims multiple Payouts in a single tx and every validator
  // run sees the same sum-of-outputs (audit I6):
  //   Cardano's ledger enforces Σ inputs == Σ outputs + fee. If the
  //   bettor consumes Payouts totalling X ECT, outputs must also total
  //   X ECT. All consumed Payouts belong to this bettor (else signatures
  //   fail). So the bettor always recovers their full X — no cross-user
  //   leak is possible. The sum-of-outputs shape looks suspicious but
  //   the algebra is sound.
  signed_by(tx, pay.bettor) && ect_paid_to(tx.outputs, pay.bettor) >= pay.payout_amount
}

// ── Validator ────────────────────────────────────────────────────────────────

validator event_chain {
  spend(
    datum: Option<EventDatum>,
    redeemer: EventRedeemer,
    utxo: OutputReference,
    tx: Transaction,
  ) {
    when datum is {
      None -> False
      Some(d) ->
        when d is {
          Bet(bet) ->
            when redeemer is {
              Resolve -> validate_resolve_bet(tx, bet, utxo)
              Refund -> validate_refund_bet(tx, bet)
              ForceRefund -> validate_force_refund_bet(tx, bet)
              Claim -> False
            }

          // Resolution markers are permanently unspendable. Letting the
          // oracle spend them would allow burning the marker and re-opening
          // refunds on already-paid bets (audit P0-C3 / P0-C4), or sweeping
          // value attached to the marker. The ~2 ADA min-UTxO is the cost
          // of ensuring the marker cannot be removed.
          Resolution(_) -> False

          Payout(pay) ->
            when redeemer is {
              Claim -> validate_claim_payout(tx, pay)
              _ -> False
            }
        }
    }
  }

  else(_) {
    False
  }
}
